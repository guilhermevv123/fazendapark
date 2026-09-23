/**
 * O freio de força bruta e o IP que ele conta.
 *
 * ## Os dois defeitos que isto trava (achados de QA, 22/09)
 *
 * 1. **Trancar o dono de fora era de graça.** O balde era só o e-mail: oito
 *    senhas erradas em 15 minutos, de QUALQUER lugar, e o e-mail inteiro
 *    passava a receber 429 — inclusive com a senha certa, do computador do
 *    próprio dono. Agora o balde principal é e-mail + IP; o e-mail sozinho só
 *    tranca com um teto bem mais alto (ataque distribuído).
 * 2. **O IP era o que o cliente dissesse.** `cf-connecting-ip` era lido sempre,
 *    e um script trocava o valor a cada tentativa: nenhum balde de IP enchia.
 *    Agora cabeçalho só vale com `CONFIAR_PROXY=1`.
 *
 * Fala direto com o banco de TESTE (`.env.test`); não precisa de servidor.
 * E-mail sorteado por corrida, apagado no fim.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { db, q } from './db'
import { FREIO, ipDaRequisicao, travadoPorTentativas } from './sessao'

const EMAIL = `zzqa.freio.${randomUUID().slice(0, 8)}@teste.invalido`
const IP_DO_ATACANTE = '203.0.113.7'
const IP_DO_DONO = '198.51.100.20'

async function falhas(n: number, ip: string | null, email = EMAIL) {
  for (let i = 0; i < n; i++) {
    await q(`INSERT INTO login_attempts (email, ip, ok) VALUES ($1,$2,false)`, [email, ip])
  }
}

afterEach(async () => {
  await q(`DELETE FROM login_attempts WHERE email = $1`, [EMAIL])
})
afterAll(async () => {
  await q(`DELETE FROM login_attempts WHERE email = $1`, [EMAIL])
  await db().end()
})

describe('freio por e-mail + IP', () => {
  it('oito erros de UM endereço trancam esse endereço, não o dono em outro', async () => {
    await falhas(FREIO.porEmailEIp, IP_DO_ATACANTE)

    expect(await travadoPorTentativas(EMAIL, IP_DO_ATACANTE),
      'quem errou oito vezes seguiu tentando').toMatch(/Muitas tentativas/)
    // ← com o balde antigo (só e-mail) este é o caso vermelho: o dono,
    //   noutro aparelho e com a senha certa, levava 429.
    expect(await travadoPorTentativas(EMAIL, IP_DO_DONO),
      'o atacante trancou o dono de fora do próprio painel').toBeNull()
  })

  it('sete erros ainda deixam tentar', async () => {
    await falhas(FREIO.porEmailEIp - 1, IP_DO_ATACANTE)
    expect(await travadoPorTentativas(EMAIL, IP_DO_ATACANTE)).toBeNull()
  })

  it('ataque distribuído: muitos IPs no mesmo e-mail batem no teto global', async () => {
    // 50 falhas espalhadas em 10 endereços, 5 em cada — nenhum par chega a 8
    for (let i = 0; i < FREIO.porEmail / 5; i++) await falhas(5, `203.0.113.${100 + i}`)

    const msg = await travadoPorTentativas(EMAIL, IP_DO_DONO)
    expect(msg, 'o teto por e-mail sumiu: botnet testa senha à vontade').toMatch(/Muitas tentativas/)
  })

  it('o teto global é bem mais alto que o do par', () => {
    expect(FREIO.porEmail).toBeGreaterThanOrEqual(FREIO.porEmailEIp * 5)
  })

  it('sem IP conhecido o balde é o dos "sem IP", não o e-mail inteiro', async () => {
    await falhas(FREIO.porEmailEIp, null)
    expect(await travadoPorTentativas(EMAIL, null)).toMatch(/Muitas tentativas/)
    expect(await travadoPorTentativas(EMAIL, IP_DO_DONO)).toBeNull()
  })
})

describe('ipDaRequisicao só confia em cabeçalho com proxy declarado', () => {
  const evento = (headers: Record<string, string>, remoto = '10.0.0.5') =>
    ({ node: { req: { headers, socket: { remoteAddress: remoto } } } }) as any

  const antes = process.env.CONFIAR_PROXY
  afterEach(() => {
    if (antes === undefined) delete process.env.CONFIAR_PROXY
    else process.env.CONFIAR_PROXY = antes
  })

  it('sem CONFIAR_PROXY, cf-connecting-ip e x-forwarded-for são ignorados', () => {
    delete process.env.CONFIAR_PROXY
    const ip = ipDaRequisicao(evento({ 'cf-connecting-ip': '1.2.3.4', 'x-forwarded-for': '5.6.7.8' }))
    // ← com a leitura antiga, '1.2.3.4': o cliente escolhia o IP que o freio contava
    expect(ip).toBe('10.0.0.5')
  })

  it('com CONFIAR_PROXY=1, vale o cf-connecting-ip', () => {
    process.env.CONFIAR_PROXY = '1'
    expect(ipDaRequisicao(evento({ 'cf-connecting-ip': '1.2.3.4' }))).toBe('1.2.3.4')
  })

  it('com CONFIAR_PROXY=1 e sem Cloudflare, vale o ÚLTIMO do x-forwarded-for', () => {
    process.env.CONFIAR_PROXY = '1'
    // o da esquerda veio do cliente; o último foi o nosso proxy que pôs
    expect(ipDaRequisicao(evento({ 'x-forwarded-for': '9.9.9.9, 5.6.7.8' }))).toBe('5.6.7.8')
  })

  it('cabeçalho que não é IP cai no socket', () => {
    process.env.CONFIAR_PROXY = '1'
    expect(ipDaRequisicao(evento({ 'cf-connecting-ip': 'lixo', 'x-forwarded-for': 'x' }))).toBe('10.0.0.5')
  })
})
