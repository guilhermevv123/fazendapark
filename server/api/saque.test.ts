/**
 * Teste do TETO DO SAQUE — quanto o produtor consegue tirar de verdade.
 *
 * `utils/liquido.test.ts` prova a conta. Este prova que a rota que move
 * dinheiro usa ela, e que o teto segura sob concorrência. É o único caminho
 * do sistema em que um número errado vira dinheiro saindo da conta, e até
 * agora não tinha teste nenhum.
 *
 * Os dois casos que importam e que o seed nunca produziu:
 *
 *  1. **Venda de balcão com taxa absorvida.** O comprador paga a face
 *     redonda e a taxa sai do produtor. A conta antiga (`face − estornado`)
 *     liberava pra saque a taxa que a plataforma já tinha retido.
 *  2. **Dois pedidos de saque ao mesmo tempo.** Cada um enxergando o saldo
 *     inteiro como seu. O teto tem que valer para a soma, não para cada um
 *     separadamente.
 *
 * Fixture própria, evento já vencido (pra passar da retenção), apagada no
 * fim. Nenhum centavo do evento de verdade é tocado.
 *
 * Precisa do servidor de dev no ar. Sem ele, PULA em vez de falhar.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const BASE = process.env.BASE_TESTE ?? 'http://localhost:3100'

const ORG = '0000e001-0000-4000-8000-000000000001'
const USUARIO = '0000e001-0000-4000-8000-000000000002'
const EVENTO = '0000e001-0000-4000-8000-000000000003'
const EMAIL = 'dono.saque@teste.invalido'

let noAr = false
let cookie = ''

async function sql(texto: string, par: any[] = []) {
  const { q } = await import('../utils/db')
  return q<any>(texto, par)
}

const comSessao = (rota: string, init: RequestInit = {}) =>
  fetch(`${BASE}${rota}`, {
    ...init,
    headers: { 'content-type': 'application/json', cookie, origin: BASE, ...(init.headers ?? {}) },
  })

/** pede um saque e devolve status + mensagem */
async function sacar(valorCents: number) {
  const r = await comSessao(`/api/admin/evento/${EVENTO}/financeiro`, {
    method: 'POST',
    body: JSON.stringify({
      beneficiario: 'ZZ Beneficiario Teste',
      destinoTipo: 'pix',
      destino: 'zz.saque@teste.invalido',
      valorCents,
    }),
  })
  const corpo = await r.json().catch(() => ({}))
  return { status: r.status, mensagem: corpo.statusMessage ?? corpo.message ?? '' }
}

/** quanto o painel diz que existe */
async function liquidoDoPainel(): Promise<number> {
  const r = await comSessao(`/api/admin/evento/${EVENTO}/bordero`)
  return (await r.json()).totais.liquidoCents
}

async function payoutsGravados() {
  const r = await sql(
    `SELECT COALESCE(SUM(amount_cents), 0)::bigint AS soma, count(*)::int AS n
       FROM payouts WHERE event_id = $1
        AND status IN ('solicitada','processando','concluida')`, [EVENTO])
  return { soma: Number(r[0].soma), n: r[0].n }
}

beforeAll(async () => {
  try {
    noAr = (await fetch(`${BASE}/api/auth/eu`, { signal: AbortSignal.timeout(2500) })).status < 500
  } catch { noAr = false }
  if (!noAr) return

  await sql(`INSERT INTO organizations (id, name, slug)
             VALUES ($1,'ZZ SAQUE TESTE','zz-saque-teste')
             ON CONFLICT (id) DO NOTHING`, [ORG])

  // Evento que já terminou há tempo suficiente pra vencer a retenção — senão
  // a rota recusa por prazo e o teste nunca chega a provar o teto.
  await sql(
    `INSERT INTO events (id, org_id, name, slug, starts_at, ends_at, fee_bps, status)
     VALUES ($1,$2,'ZZ EVENTO SAQUE','zz-evento-saque',
             now() - interval '60 days', now() - interval '59 days', 1000, 'ativo')
     ON CONFLICT (id) DO UPDATE SET ends_at = EXCLUDED.ends_at`, [EVENTO, ORG])

  await sql(
    `INSERT INTO users (id, org_id, name, email, password_hash, role)
     SELECT $1, $2, 'Dono Saque Teste', $3, password_hash, 'master'
       FROM users WHERE email = 'dono@fazendapark.com.br'
     ON CONFLICT (id) DO NOTHING`, [USUARIO, ORG, EMAIL])

  const r = await fetch(`${BASE}/api/auth/entrar`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, senha: 'diamond123' }),
  })
  cookie = (r.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(';')[0]).find((c) => c.startsWith('dt_sessao=')) ?? ''

  await sql(`DELETE FROM payouts WHERE event_id = $1`, [EVENTO])
  await sql(`DELETE FROM orders WHERE event_id = $1`, [EVENTO])

  // Venda de balcão de R$ 100 COM cobrança no gateway, taxa de 10%
  // ABSORVIDA: o comprador pagou R$ 100 redondos e a plataforma retém R$ 10.
  // Sobram R$ 90 pro produtor, e esses R$ 90 estão na plataforma.
  await sql(
    `INSERT INTO orders (org_id, event_id, code, status, channel,
                         face_cents, fee_cents, platform_cents, discount_cents,
                         total_cents, refunded_cents, asaas_payment_id, paid_at)
     VALUES ($1,$2,'ZZ-SAQUE-1','pago','bilheteria',
             10000, 0, 1000, 0, 10000, 0, 'pay_zz_saque_1', now())`, [ORG, EVENTO])

  // Venda de R$ 50 em DINHEIRO no guichê — nenhuma cobrança no gateway. É do
  // produtor (entra no líquido) e já está com ele: não existe conta da
  // plataforma de onde tirar pra mandar de novo.
  await sql(
    `INSERT INTO orders (org_id, event_id, code, status, channel, payment_method,
                         face_cents, fee_cents, platform_cents, discount_cents,
                         total_cents, refunded_cents, asaas_payment_id, paid_at)
     VALUES ($1,$2,'ZZ-SAQUE-2','pago','bilheteria','dinheiro',
             5000, 0, 0, 0, 5000, 0, NULL, now())`, [ORG, EVENTO])
}, 30_000)

afterAll(async () => {
  if (!noAr) return
  await sql(`DELETE FROM organizations WHERE id = $1`, [ORG])
})

describe('teto do saque', () => {
  it('o painel mostra o líquido depois da taxa absorvida', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    expect(cookie, 'login falhou — o teste ficaria verde à toa').toBeTruthy()

    // R$ 90 da venda com taxa absorvida + R$ 50 do dinheiro no guichê.
    // O borderô conta o que é DO PRODUTOR, não o que dá pra transferir.
    expect(await liquidoDoPainel(),
      'o painel prometeu a face cheia numa venda cuja taxa o produtor absorveu').toBe(14_000)
  }, 20_000)

  it('o dinheiro do guichê não vira saldo transferível', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    await sql(`DELETE FROM payouts WHERE event_id = $1`, [EVENTO])

    // O borderô abre R$ 140. Mas R$ 50 entraram em espécie na mão do
    // produtor: mandar isso de novo é a plataforma pagando do próprio bolso.
    const r = await sacar(14_000)
    expect(r.status, `transferiu o dinheiro que já estava no caixa do guichê — ${r.mensagem}`).toBe(409)

    // e a recusa precisa DIZER onde está o dinheiro que ele está vendo na
    // tela ao lado — senão vira chamado de "o sistema perdeu minha venda".
    // `toLocaleString` separa o R$ com espaço FINO (U+00A0), não com espaço
    // normal: comparar sem normalizar falha com as duas strings idênticas na
    // tela.
    const msg = r.mensagem.replace(/ /g, ' ')
    expect(msg, 'recusou sem explicar onde foi parar o dinheiro do balcão')
      .toContain('R$ 50,00')
    expect(msg, 'não disse quanto ele PODE transferir').toContain('R$ 90,00')

    const { n } = await payoutsGravados()
    expect(n, 'recusou na resposta e gravou o saque assim mesmo').toBe(0)
  }, 20_000)

  it('não deixa sacar a taxa que a plataforma reteve', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')

    // R$ 95: menos que a face de R$ 100, mais que o líquido de R$ 90. É
    // exatamente a faixa que a conta antiga liberava.
    const r = await sacar(9_500)
    expect(r.status, `deixou sacar R$ 95,00 de um saldo de R$ 90,00 — ${r.mensagem}`).toBe(409)

    const { n } = await payoutsGravados()
    expect(n, 'a rota recusou na resposta mas gravou o saque assim mesmo').toBe(0)
  }, 20_000)

  it('deixa sacar exatamente o que existe', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    await sql(`DELETE FROM payouts WHERE event_id = $1`, [EVENTO])

    const r = await sacar(9_000)
    expect(r.status, `recusou o saldo inteiro — ${r.mensagem}`).toBe(200)

    const { soma } = await payoutsGravados()
    expect(soma).toBe(9_000)
  }, 20_000)

  it('o segundo saque não gasta o saldo de novo', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    // o saque do caso anterior segue de pé: o saldo já foi

    const r = await sacar(100)
    expect(r.status, `sacou R$ 1,00 de um saldo já zerado — ${r.mensagem}`).toBe(409)

    const { soma } = await payoutsGravados()
    expect(soma, 'a soma dos saques passou do que o evento arrecadou').toBeLessThanOrEqual(9_000)
  }, 20_000)

  /**
   * Concorrência de verdade — e por que não dá pra testar com dois `fetch`.
   *
   * A primeira versão deste caso disparava dois pedidos com `Promise.all` e
   * ficava VERDE mesmo com o `FOR UPDATE` arrancado da rota: os dois fetch
   * não chegam juntos no servidor de dev, então o primeiro já tinha gravado
   * quando o segundo leu o saldo. Teste que fica verde sem a trava dá uma
   * garantia que ele não tem.
   *
   * Aqui a ordem é forçada na mão, em duas conexões do pool, rodando
   * exatamente as linhas que a rota roda (`utils/saque.ts`).
   */
  it('a trava segura o segundo pedido até o primeiro gravar', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    await sql(`DELETE FROM payouts WHERE event_id = $1`, [EVENTO])

    const { db } = await import('../utils/db')
    const { SQL_TRAVA_EVENTO, saldoParaSaque } = await import('../utils/saque')
    const c1 = await db().connect()
    const c2 = await db().connect()

    try {
      await c1.query('BEGIN')
      await c2.query('BEGIN')

      // A pega a trava e vê os R$ 90 livres
      await c1.query(SQL_TRAVA_EVENTO, [EVENTO])
      const saldoA = await saldoParaSaque(c1, EVENTO)
      expect(saldoA.disponivelCents).toBe(9_000)

      // B tenta pegar a mesma trava e FICA PENDURADO — a promessa não
      // resolve enquanto A não terminar. É isso que o teste precisa provar.
      let bPassou = false
      const bEsperando = c2.query(SQL_TRAVA_EVENTO, [EVENTO])
        .then(() => { bPassou = true })
        // se o caso falhar antes do COMMIT, o `finally` solta a trava e esta
        // promessa resolve sozinha. Sem o catch isso viraria uma rejeição
        // solta que derruba o processo do vitest em vez de mostrar a falha.
        .catch(() => {})

      // dá tempo de sobra pro Postgres liberar B, se ele fosse liberar
      await new Promise((r) => setTimeout(r, 400))
      expect(bPassou,
        'o segundo pedido leu o evento sem esperar — a trava não está segurando').toBe(false)

      // A gasta o saldo inteiro e confirma
      await c1.query(
        `INSERT INTO payouts (org_id, event_id, code, beneficiary_name,
                              destination_kind, destination, amount_cents, status)
         VALUES ($1,$2,'ZZ-TRF-A','ZZ A','pix','a@teste.invalido',9000,'solicitada')`,
        [ORG, EVENTO])
      await c1.query('COMMIT')

      // agora B anda — e tem que enxergar o saque de A
      await bEsperando
      const saldoB = await saldoParaSaque(c2, EVENTO)
      expect(saldoB.disponivelCents,
        'o segundo pedido não enxergou o saque do primeiro e sacaria de novo').toBe(0)
      await c2.query('ROLLBACK')
    } finally {
      // ROLLBACK antes de devolver ao pool, SEMPRE. `release()` não desfaz
      // transação aberta: uma falha de asserção no meio deixava o `FOR UPDATE`
      // preso na conexão devolvida, e o caso SEGUINTE — que chama a rota de
      // verdade — travava até estourar o timeout. Uma falha vira duas, e a
      // segunda aponta pro lugar errado.
      await c1.query('ROLLBACK').catch(() => {})
      await c2.query('ROLLBACK').catch(() => {})
      c1.release()
      c2.release()
    }

    const { soma } = await payoutsGravados()
    expect(soma, 'saiu mais do que o evento arrecadou').toBeLessThanOrEqual(9_000)
  }, 30_000)

  it('o saque de um evento não enxerga o dinheiro do outro', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    await sql(`DELETE FROM payouts WHERE event_id = $1`, [EVENTO])

    // o evento do seed tem milhares de reais; este tem R$ 90
    const r = await sacar(50_000)
    expect(r.status, `sacou R$ 500,00 de um evento que arrecadou R$ 90,00 — ${r.mensagem}`).toBe(409)
  }, 20_000)
})
