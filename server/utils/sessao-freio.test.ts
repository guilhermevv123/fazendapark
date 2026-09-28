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
import {
  conferirFreio, esvaziarFreioPublico, FREIO, FREIO_PUBLICO_PADRAO, frearPortaPublica,
  ipDaRequisicao, JanelaDeFreio, marcarNoFreio, origemDaRequisicao, regraDoFreio,
  travadoPorTentativas,
} from './sessao'

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

  it('com CONFIAR_PROXY=1 (Traefik), cf-connecting-ip forjado NÃO conta', () => {
    process.env.CONFIAR_PROXY = '1'
    // B05: sem Cloudflare na frente, o cliente escreve um IP novo nesse
    // cabeçalho a cada tentativa e o freio por IP nunca enche
    expect(ipDaRequisicao(evento({ 'cf-connecting-ip': '1.2.3.4', 'x-forwarded-for': '5.6.7.8' })))
      .toBe('5.6.7.8')
    expect(ipDaRequisicao(evento({ 'cf-connecting-ip': '1.2.3.4' }))).toBe('10.0.0.5')
  })

  it('com CONFIAR_PROXY=cloudflare, vale o cf-connecting-ip', () => {
    process.env.CONFIAR_PROXY = 'cloudflare'
    expect(ipDaRequisicao(evento({ 'cf-connecting-ip': '1.2.3.4', 'x-forwarded-for': '5.6.7.8' })))
      .toBe('1.2.3.4')
  })

  it('com CONFIAR_PROXY=1 e sem Cloudflare, vale o ÚLTIMO do x-forwarded-for', () => {
    process.env.CONFIAR_PROXY = '1'
    // o da esquerda veio do cliente; o último foi o nosso proxy que pôs
    expect(ipDaRequisicao(evento({ 'x-forwarded-for': '9.9.9.9, 5.6.7.8' }))).toBe('5.6.7.8')
  })

  it('cabeçalho que não é IP cai no socket', () => {
    process.env.CONFIAR_PROXY = 'cloudflare'
    expect(ipDaRequisicao(evento({ 'cf-connecting-ip': 'lixo', 'x-forwarded-for': 'x' }))).toBe('10.0.0.5')
  })

  it('proxy na frente sem CONFIAR_PROXY é reconhecido — mas só vindo da rede interna', () => {
    delete process.env.CONFIAR_PROXY
    // o Traefik do EasyPanel conecta de dentro da rede do Docker
    expect(origemDaRequisicao(evento({ 'x-forwarded-for': '200.1.2.3' }, '10.0.1.7')))
      .toEqual({ ip: '10.0.1.7', proxySemConfianca: true })
    // de um socket da internet, x-forwarded-for é texto do cliente: não rebaixa o freio
    expect(origemDaRequisicao(evento({ 'x-forwarded-for': '200.1.2.3' }, '177.10.20.30')))
      .toEqual({ ip: '177.10.20.30', proxySemConfianca: false })
    expect(origemDaRequisicao(evento({}, '10.0.1.7')).proxySemConfianca).toBe(false)
  })
})

describe('B05 · atrás do proxy sem CONFIAR_PROXY o freio de login não vira trava da casa', () => {
  const IP_DO_PROXY = '10.0.1.7'
  const OUTRO = `zzqa.freio.outro.${randomUUID().slice(0, 8)}@teste.invalido`
  afterEach(async () => {
    await q(`DELETE FROM login_attempts WHERE email = $1`, [OUTRO])
  })

  it('8 erros de um desconhecido não trancam o dono (o IP é o do proxy, igual pra todos)', async () => {
    await falhas(FREIO.porEmailEIp, IP_DO_PROXY)
    // com o IP confiável, este é o balde do par — e tranca, como deve
    expect(await travadoPorTentativas(EMAIL, IP_DO_PROXY)).toMatch(/Muitas tentativas/)
    // com o IP do proxy, o par é todo mundo: não pode trancar
    expect(await travadoPorTentativas(EMAIL, IP_DO_PROXY, { ipConfiavel: false }),
      'oito erros de qualquer um trancaram o dono do painel').toBeNull()
  })

  it('30 erros espalhados em e-mails não trancam a equipe inteira', async () => {
    for (let i = 0; i < FREIO.porIp; i++) {
      await q(`INSERT INTO login_attempts (email, ip, ok) VALUES ($1,$2,false)`,
        [i % 2 ? EMAIL : OUTRO, IP_DO_PROXY])
    }
    const terceiro = `zzqa.freio.portaria.${randomUUID().slice(0, 8)}@teste.invalido`
    expect(await travadoPorTentativas(terceiro, IP_DO_PROXY)).toMatch(/deste endereço/)
    expect(await travadoPorTentativas(terceiro, IP_DO_PROXY, { ipConfiavel: false }),
      'a portaria ficou trancada por erros de outras pessoas').toBeNull()
  })

  it('o teto por e-mail (ataque distribuído) segue valendo sem IP confiável', async () => {
    await falhas(FREIO.porEmail, IP_DO_PROXY)
    expect(await travadoPorTentativas(EMAIL, IP_DO_PROXY, { ipConfiavel: false }))
      .toMatch(/Muitas tentativas/)
  })
})

describe('freio das portas públicas (B03, B04, B15)', () => {
  const MIN = 60_000

  it('a janela conta, recusa no limite e solta quando o tempo passa', () => {
    const j = new JanelaDeFreio()
    const t0 = 1_000_000
    for (let i = 0; i < 5; i++) {
      expect(j.cabe('k', 5, 10 * MIN, 1, t0 + i).ok).toBe(true)
      j.marcar('k', 1, t0 + i)
    }
    const recusa = j.cabe('k', 5, 10 * MIN, 1, t0 + 10)
    expect(recusa.ok, 'o sexto passou num balde de cinco').toBe(false)
    expect((recusa as any).esperarSeg).toBe(600)
    // 10 min depois da PRIMEIRA marca, cabe de novo
    expect(j.cabe('k', 5, 10 * MIN, 1, t0 + 10 * MIN + 1).ok).toBe(true)
    // chave de outro IP não divide o balde
    expect(j.cabe('outra', 5, 10 * MIN, 1, t0 + 10).ok).toBe(true)
  })

  it('peso: o balde de ingressos conta ingresso, não pedido', () => {
    const j = new JanelaDeFreio()
    j.marcar('ing', 20, 0)
    j.marcar('ing', 20, 1)
    expect(j.cabe('ing', 60, 20 * MIN, 20, 2).ok).toBe(true)
    j.marcar('ing', 20, 2)
    expect(j.cabe('ing', 60, 20 * MIN, 1, 3).ok, 'passou de 60 ingressos reservados').toBe(false)
  })

  it('a regra vem do ambiente, com padrão seguro e "0" que desliga', () => {
    expect(regraDoFreio('checkout', {})).toEqual(FREIO_PUBLICO_PADRAO.checkout)
    expect(regraDoFreio('checkout', { FREIO_CHECKOUT: '5/60' })).toEqual({ limite: 5, janelaSeg: 60 })
    expect(regraDoFreio('checkout', { FREIO_CHECKOUT: '0' })).toBeNull()
    expect(regraDoFreio('cupom_errado', { FREIO_CUPOM_ERRADO: 'lixo' }))
      .toEqual(FREIO_PUBLICO_PADRAO.cupom_errado)
    // o padrão freia um script no primeiro minuto
    expect(FREIO_PUBLICO_PADRAO.checkout.limite).toBeLessThanOrEqual(30)
    expect(FREIO_PUBLICO_PADRAO.cupom_errado.limite).toBeLessThanOrEqual(15)
  })

  describe('na requisição', () => {
    const cabecalhos: Record<string, string> = {}
    const evento = (headers: Record<string, string>, remoto: string) => ({
      node: {
        req: { headers, socket: { remoteAddress: remoto } },
        res: { setHeader: (k: string, v: string) => { cabecalhos[k] = v } },
      },
    }) as any
    const antes = process.env.CONFIAR_PROXY
    afterEach(() => {
      esvaziarFreioPublico()
      if (antes === undefined) delete process.env.CONFIAR_PROXY
      else process.env.CONFIAR_PROXY = antes
    })

    const estoura = (f: () => void) => {
      try { f(); return null } catch (e: any) { return e }
    }

    it('o 21º checkout do mesmo IP leva 429 com Retry-After; outro IP segue', () => {
      process.env.CONFIAR_PROXY = '1'
      const doScript = evento({ 'x-forwarded-for': '203.0.113.50' }, '10.0.1.7')
      for (let i = 0; i < FREIO_PUBLICO_PADRAO.checkout.limite; i++) {
        expect(estoura(() => frearPortaPublica(doScript, 'checkout'))).toBeNull()
      }
      const e = estoura(() => frearPortaPublica(doScript, 'checkout'))
      expect(e?.statusCode, 'o script seguiu comprando').toBe(429)
      expect(e?.data?.tipo).toBe('freio')
      expect(Number(cabecalhos['Retry-After'])).toBeGreaterThan(0)
      expect(estoura(() => frearPortaPublica(evento({ 'x-forwarded-for': '198.51.100.9' }, '10.0.1.7'),
        'checkout'))).toBeNull()
    })

    it('a própria máquina não é freada (suíte, E2E, HEALTHCHECK)', () => {
      for (let i = 0; i < 100; i++) frearPortaPublica(evento({}, '127.0.0.1'), 'checkout')
      expect(estoura(() => frearPortaPublica(evento({}, '::1'), 'checkout'))).toBeNull()
    })

    it('proxy sem CONFIAR_PROXY: não freia o IP do proxy (seria tirar o site do ar)', () => {
      delete process.env.CONFIAR_PROXY
      const viaProxy = evento({ 'x-forwarded-for': '203.0.113.60' }, '10.0.1.7')
      for (let i = 0; i < 100; i++) {
        expect(estoura(() => frearPortaPublica(viaProxy, 'checkout')),
          'o site inteiro levaria 429 depois de 20 compras').toBeNull()
      }
    })

    it('conferir não gasta; marcar gasta — o balde do código de cupom errado', () => {
      process.env.CONFIAR_PROXY = '1'
      const quem = evento({ 'x-forwarded-for': '203.0.113.70' }, '10.0.1.7')
      for (let i = 0; i < 50; i++) conferirFreio(quem, 'cupom_errado')
      for (let i = 0; i < FREIO_PUBLICO_PADRAO.cupom_errado.limite; i++) marcarNoFreio(quem, 'cupom_errado')
      expect(estoura(() => conferirFreio(quem, 'cupom_errado'))?.statusCode).toBe(429)
    })
  })
})
