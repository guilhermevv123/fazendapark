/**
 * Teste do CATÁLOGO DE SESSÕES — os dias vendáveis do parque e o teto de cada um.
 *
 * Quatro coisas aqui podem custar caro, e cada uma tem um caso:
 *
 *  1. **A data que o operador digitou.** O parque abre às 09:00 em
 *     America/Bahia. `new Date('2026-11-07')` nasce em UTC e `toISOString()`
 *     converte antes de cortar — 09:00 viraria 06:00 no banco e o portão
 *     abriria três horas antes no papel. O caso confere a hora LOCAL de volta.
 *
 *  2. **A vaga é contada em PESSOAS.** Uma mesa de 10 é uma linha de pedido e
 *     dez corpos na piscina. Contar unidades faz o parque lotar com o painel
 *     mostrando 10%.
 *
 *  3. **Dois compradores na última vaga.** Não dá pra provar isso com dois
 *     `fetch`: eles não chegam juntos no servidor de dev, o primeiro já gravou
 *     quando o segundo lê, e o teste fica VERDE com a trava arrancada. Aqui a
 *     ordem é forçada à mão em duas conexões do pool, rodando a mesma gravação
 *     que o checkout e o balcão rodam.
 *
 *  4. **Baixar o teto embaixo de quem já comprou.** O produtor não pode dizer
 *     "cabem 200" depois de vender 300 — o excedente não some, ele aparece na
 *     fila.
 *
 * Fixture própria, apagada no fim. O evento semeado não é tocado.
 * Sem servidor de dev no ar, PULA em vez de falhar.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const BASE = process.env.BASE_TESTE ?? 'http://localhost:3100'

const ORG = '0000e016-0000-4000-8000-000000000001'
const USUARIO = '0000e016-0000-4000-8000-000000000002'
const EVENTO = '0000e016-0000-4000-8000-000000000003'
const SETOR = '0000e016-0000-4000-8000-000000000004'
const LOTE = '0000e016-0000-4000-8000-000000000005'
const SETOR_MESA = '0000e016-0000-4000-8000-000000000006'
const LOTE_MESA = '0000e016-0000-4000-8000-000000000007'
const EMAIL = 'dono.sessoes@teste.invalido'

/**
 * Os dias da fixture nascem no beforeAll, com id próprio, e ficam em DEZEMBRO.
 *
 * Um caso que depende do dia criado por outro caso não é um caso: rodar
 * `-t "última vaga"` sozinho quebrava por falta de fixture, e foi assim que a
 * primeira rodada de mutação deu vermelho pelo motivo errado — vermelho que
 * não prova nada. Dezembro também mantém a fixture longe do novembro que os
 * casos de criação em lote geram.
 */
const DIA_MESA = '0000e016-0000-4000-8000-000000000008'
const DIA_LOTADO = '0000e016-0000-4000-8000-000000000009'
const DIA_CORRIDA = '0000e016-0000-4000-8000-00000000000a'
const DIA_VAZIO = '0000e016-0000-4000-8000-00000000000b'
const DIA_APAGAR = '0000e016-0000-4000-8000-00000000000c'

/** o passe de dois dias e o dia onde o ingresso emitido é conferido */
const DIA_PASSE_A = '0000e016-0000-4000-8000-00000000000d'
const DIA_PASSE_B = '0000e016-0000-4000-8000-00000000000e'
const DIA_TICKET = '0000e016-0000-4000-8000-00000000000f'
const SETOR_PASSE = '0000e016-0000-4000-8000-000000000010'
const LOTE_PASSE = '0000e016-0000-4000-8000-000000000011'
const SETOR_DIA = '0000e016-0000-4000-8000-000000000012'
const LOTE_DIA = '0000e016-0000-4000-8000-000000000013'

let noAr = false
let cookie = ''

async function sql(texto: string, par: any[] = []) {
  const { q } = await import('../../../../utils/db')
  return q<any>(texto, par)
}

const comSessao = (rota: string, init: RequestInit = {}) =>
  fetch(`${BASE}${rota}`, {
    ...init,
    headers: { 'content-type': 'application/json', cookie, origin: BASE, ...(init.headers ?? {}) },
  })

async function acao(corpo: any) {
  const r = await comSessao(`/api/admin/evento/${EVENTO}/sessoes`, {
    method: 'POST', body: JSON.stringify(corpo),
  })
  const c: any = await r.json().catch(() => ({}))
  return { status: r.status, corpo: c, mensagem: c.statusMessage ?? c.message ?? '' }
}

async function painel() {
  const r = await comSessao(`/api/admin/evento/${EVENTO}/sessoes`)
  return await r.json() as any
}

/** o dia da fixture, como o painel o enxerga */
async function dia(id: string) {
  const p = await painel()
  const achado = p.sessoes.find((s: any) => s.id === id)
  expect(achado, `a sessão ${id} sumiu da fixture`).toBeTruthy()
  return achado
}

/** Novembro de 2026: 5 domingos (1, 8, 15, 22, 29) e 4 sábados (7, 14, 21, 28). */
const NOVEMBRO = { de: '2026-11-01', ate: '2026-11-30', fimDeSemana: 9 }

/** cria um pedido vivo com um item — o caminho que a venda de verdade grava */
async function vender(loteId: string, quantidade: number, sessaoId: string | null = null) {
  const [ped] = await sql(
    `INSERT INTO orders (org_id, event_id, code, status, face_cents, fee_cents,
                         platform_cents, discount_cents, total_cents, paid_at)
     VALUES ($1,$2,'ZZS-' || substr(gen_random_uuid()::text,1,8),'pago',0,0,0,0,0,now())
     RETURNING id`, [ORG, EVENTO])
  await sql(
    `INSERT INTO order_items (order_id, lot_id, session_id, quantity,
                              unit_face_cents, unit_fee_cents, unit_total_cents)
     VALUES ($1,$2,$3,$4,0,0,0)`, [ped.id, loteId, sessaoId, quantidade])
  return ped.id
}

beforeAll(async () => {
  try {
    noAr = (await fetch(`${BASE}/api/auth/eu`, { signal: AbortSignal.timeout(2500) })).status < 500
  } catch { noAr = false }
  if (!noAr) return

  await sql(`DELETE FROM organizations WHERE id = $1`, [ORG])
  await sql(`INSERT INTO organizations (id, name, slug) VALUES ($1,'ZZ SESSOES','zz-sessoes-016')`, [ORG])
  await sql(
    `INSERT INTO events (id, org_id, name, slug, status, starts_at, ends_at, timezone)
     VALUES ($1,$2,'ZZ EVENTO SESSOES','zz-evento-sessoes-016','ativo',
             '2026-11-01 09:00-03','2026-12-31 17:00-03','America/Bahia')`, [EVENTO, ORG])
  await sql(
    `INSERT INTO users (id, org_id, name, email, password_hash, role)
     SELECT $1, $2, 'Dono Sessoes Teste', $3, password_hash, 'master'
       FROM users WHERE email = 'dono@fazendapark.com.br'`, [USUARIO, ORG, EMAIL])

  await sql(`INSERT INTO sectors (id, event_id, name) VALUES ($1,$2,'Pista')`, [SETOR, EVENTO])
  await sql(
    `INSERT INTO lots (id, sector_id, name, price_cents, quantity, max_per_order)
     VALUES ($1,$2,'Entrada',5000,1000,50)`, [LOTE, SETOR])

  // Mesa de 10: uma unidade vendida, dez pessoas dentro do parque.
  await sql(
    `INSERT INTO sectors (id, event_id, name, kind, admits) VALUES ($1,$2,'Mesa','mesa',10)`,
    [SETOR_MESA, EVENTO])
  await sql(
    `INSERT INTO lots (id, sector_id, name, price_cents, quantity, max_per_order)
     VALUES ($1,$2,'Mesa para 10',50000,100,10)`, [LOTE_MESA, SETOR_MESA])

  await sql(
    `INSERT INTO event_sessions (id, event_id, starts_at, ends_at, title, capacity)
     SELECT x.id, $1, x.inicio::timestamptz, x.inicio::timestamptz + interval '8 hours',
            x.titulo, x.capacidade
       FROM (VALUES
         ($2::uuid, '2026-12-05 09:00-03', 'Sábado 05/12',  500),
         ($3::uuid, '2026-12-06 09:00-03', 'Domingo 06/12', NULL),
         ($4::uuid, '2026-12-12 09:00-03', 'Sábado 12/12',  NULL),
         ($5::uuid, '2026-12-13 09:00-03', 'Domingo 13/12', NULL),
         ($6::uuid, '2026-12-19 09:00-03', 'Sábado 19/12',  NULL)
       ) AS x(id, inicio, titulo, capacidade)`,
    [EVENTO, DIA_MESA, DIA_LOTADO, DIA_CORRIDA, DIA_VAZIO, DIA_APAGAR])

  // Em quais dias cada lote vende, e a venda da mesa — montados aqui, e não
  // dentro de um caso, pra nenhum caso depender de outro ter rodado antes.
  // Passe de 2 dias (4 pessoas por unidade) e um lote de UM dia só, cada um
  // com dias próprios — nenhum caso mexe nos dias dos outros.
  await sql(
    `INSERT INTO sectors (id, event_id, name, kind, admits)
     VALUES ($1,$2,'Passe 2 dias','passaporte',4)`, [SETOR_PASSE, EVENTO])
  await sql(
    `INSERT INTO lots (id, sector_id, name, price_cents, quantity, max_per_order)
     VALUES ($1,$2,'Passe família',80000,100,10)`, [LOTE_PASSE, SETOR_PASSE])
  await sql(`INSERT INTO sectors (id, event_id, name) VALUES ($1,$2,'Avulso do dia')`,
    [SETOR_DIA, EVENTO])
  await sql(
    `INSERT INTO lots (id, sector_id, name, price_cents, quantity, max_per_order)
     VALUES ($1,$2,'Entrada de um dia',5000,1000,50)`, [LOTE_DIA, SETOR_DIA])

  await sql(
    `INSERT INTO event_sessions (id, event_id, starts_at, ends_at, title, capacity)
     SELECT x.id, $1, x.inicio::timestamptz, x.inicio::timestamptz + interval '8 hours',
            x.titulo, 100
       FROM (VALUES
         ($2::uuid, '2026-12-26 09:00-03', 'Sábado 26/12'),
         ($3::uuid, '2026-12-27 09:00-03', 'Domingo 27/12'),
         ($4::uuid, '2026-12-28 09:00-03', 'Segunda 28/12')
       ) AS x(id, inicio, titulo)`,
    [EVENTO, DIA_PASSE_A, DIA_PASSE_B, DIA_TICKET])

  await sql(
    `INSERT INTO lot_sessions (lot_id, session_id)
     VALUES ($1,$3), ($2,$3), ($1,$4), ($1,$5), ($6,$7), ($6,$8), ($9,$10)`,
    [LOTE, LOTE_MESA, DIA_MESA, DIA_LOTADO, DIA_CORRIDA,
     LOTE_PASSE, DIA_PASSE_A, DIA_PASSE_B, LOTE_DIA, DIA_TICKET])
  await vender(LOTE_MESA, 1, DIA_MESA)

  const r = await fetch(`${BASE}/api/auth/entrar`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, senha: 'diamond123' }),
  })
  cookie = (r.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(';')[0]).find((c) => c.startsWith('dt_sessao=')) ?? ''
}, 30_000)

afterAll(async () => {
  if (!noAr) return
  // orders referencia events com RESTRICT: sai primeiro, senão o cascade da
  // organização esbarra nele e a fixture fica pra trás sujando a próxima rodada.
  await sql(`DELETE FROM orders WHERE event_id = $1`, [EVENTO])
  await sql(`DELETE FROM organizations WHERE id = $1`, [ORG])
})

describe('criar várias datas de uma vez', () => {
  it('cria todo sábado e domingo do mês, no horário LOCAL do parque', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    expect(cookie, 'login falhou — o teste ficaria verde à toa').toBeTruthy()

    const r = await acao({
      o: 'criar', de: NOVEMBRO.de, ate: NOVEMBRO.ate,
      dias: [6, 7], horarios: [{ inicio: '09:00', fim: '17:00' }],
      capacidade: 500, loteIds: [LOTE],
    })
    expect(r.status, `criação recusada — ${r.mensagem}`).toBe(200)
    expect(r.corpo.criadas, 'novembro de 2026 tem 4 sábados e 5 domingos').toBe(NOVEMBRO.fimDeSemana)

    // A hora precisa voltar 09:00 NO FUSO DO PARQUE. Gravada via UTC, ela
    // voltaria 06:00 aqui — e ninguém veria diferença no JSON, que sai em Z.
    const horas = await sql(
      `SELECT id,
              to_char(starts_at AT TIME ZONE 'America/Bahia', 'YYYY-MM-DD HH24:MI') AS local,
              to_char(ends_at   AT TIME ZONE 'America/Bahia', 'HH24:MI') AS fim
         FROM event_sessions
        WHERE event_id = $1 AND starts_at < '2026-12-01 00:00-03'
        ORDER BY starts_at`, [EVENTO])
    expect(horas.length).toBe(NOVEMBRO.fimDeSemana)
    expect(horas[0].local, 'a data virou outro dia/hora ao gravar').toBe('2026-11-01 09:00')
    expect(horas.every((h: any) => h.local.endsWith('09:00') && h.fim === '17:00'),
      'alguma sessão saiu de um horário diferente do pedido').toBe(true)

    // e os lotes escolhidos já valem nesses dias
    const primeiro = await dia(horas[0].id)
    expect(primeiro.lotes.map((l: any) => l.id)).toContain(LOTE)
    expect(primeiro.lotes.find((l: any) => l.id === LOTE).vinculo).toBe('lote')
  }, 30_000)

  it('rodar de novo o mesmo período não duplica dia nenhum', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')

    const r = await acao({
      o: 'criar', de: NOVEMBRO.de, ate: NOVEMBRO.ate,
      dias: [6, 7], horarios: [{ inicio: '09:00', fim: '17:00' }], capacidade: 500,
    })
    expect(r.status).toBe(200)
    expect(r.corpo.criadas, 'criou a mesma data de novo').toBe(0)
    expect(r.corpo.repetidas).toBe(NOVEMBRO.fimDeSemana)

    const [{ n }] = await sql(
      `SELECT count(*)::int AS n FROM event_sessions
        WHERE event_id = $1 AND starts_at < '2026-12-01 00:00-03'`, [EVENTO])
    expect(n, 'o calendário dobrou de tamanho').toBe(NOVEMBRO.fimDeSemana)
  }, 30_000)

  it('recusa período que não tem nenhum dia da semana pedido', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    const r = await acao({
      o: 'criar', de: '2026-11-02', ate: '2026-11-04',
      dias: [6, 7], horarios: [{ inicio: '09:00', fim: '17:00' }],
    })
    expect(r.status).toBe(422)
    expect(r.mensagem).toMatch(/nenhuma data/i)
  }, 20_000)
})

describe('capacidade do dia', () => {
  it('conta PESSOAS, não unidades vendidas', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')

    // a fixture vendeu UMA mesa de 10 neste dia = dez pessoas no parque
    const depois = await dia(DIA_MESA)
    expect(depois.ocupadas,
      'uma mesa de 10 entrou como 1 — o parque lota com o painel mostrando 10%').toBe(10)
    expect(depois.vagas).toBe(490)
  }, 30_000)

  it('não deixa baixar o teto abaixo do que já foi vendido', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    expect((await dia(DIA_MESA)).ocupadas, 'a mesa do caso anterior não está de pé').toBe(10)

    const r = await acao({ o: 'editar', sessaoId: DIA_MESA, capacidade: 9 })
    expect(r.status, `deixou prometer 9 lugares para 10 pessoas já vendidas — ${r.mensagem}`).toBe(409)
    expect(r.mensagem, 'recusou sem dizer quantos já estão vendidos').toContain('10')

    const ok = await acao({ o: 'editar', sessaoId: DIA_MESA, capacidade: 10 })
    expect(ok.status, `recusou o teto igual ao vendido — ${ok.mensagem}`).toBe(200)
    expect((await dia(DIA_MESA)).capacidade).toBe(10)

    await acao({ o: 'editar', sessaoId: DIA_MESA, capacidade: 500 })
  }, 30_000)

  it('apagar o nome do dia apaga mesmo — não volta o antigo em silêncio', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')

    // O formulário manda o campo vazio como null. Se a rota tratar isso como
    // "não mexi" (o COALESCE de sempre), a tela avisa "salvo", recarrega e o
    // nome antigo está lá — sem erro, sem log, só a mentira na tela.
    await acao({ o: 'editar', sessaoId: DIA_VAZIO, titulo: 'Feriadão de teste' })
    expect((await dia(DIA_VAZIO)).titulo).toBe('Feriadão de teste')

    const r = await acao({ o: 'editar', sessaoId: DIA_VAZIO, titulo: null })
    expect(r.status, `recusou apagar o nome — ${r.mensagem}`).toBe(200)
    expect((await dia(DIA_VAZIO)).titulo,
      'o nome apagado voltou sozinho: a tela diz que salvou e o banco ignora').toBe(null)

    // e sem a chave é "não mexi": o teto muda e o nome fica como está
    await acao({ o: 'editar', sessaoId: DIA_VAZIO, titulo: 'Fica' })
    await acao({ o: 'editar', sessaoId: DIA_VAZIO, capacidade: 40 })
    const fim = await dia(DIA_VAZIO)
    expect(fim.titulo, 'editar só a capacidade apagou o nome junto').toBe('Fica')
    expect(fim.capacidade).toBe(40)
  }, 30_000)

  it('o dia lotado recusa a venda seguinte com uma frase de guichê', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    await acao({ o: 'editar', sessaoId: DIA_LOTADO, capacidade: 12 })

    await vender(LOTE, 10, DIA_LOTADO)
    const erro = await vender(LOTE, 3, DIA_LOTADO).catch((e) => e)
    expect(erro, 'vendeu 13 pessoas num dia de 12 lugares').toBeInstanceOf(Error)
    expect(String((erro as Error).message)).toMatch(/não comporta mais 3 pessoa/)
    expect(String((erro as Error).message), 'a recusa não diz quantos lugares restam')
      .toMatch(/restam 2 de 12/)

    // o que cabe continua passando
    await vender(LOTE, 2, DIA_LOTADO)
    expect((await dia(DIA_LOTADO)).ocupadas).toBe(12)
  }, 30_000)

  it('recusa um dia que este ingresso não vende', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    // o lote da mesa só foi ligado ao DIA_MESA
    const erro = await vender(LOTE_MESA, 1, DIA_VAZIO).catch((e) => e)
    expect(erro, 'vendeu um ingresso para um dia em que ele não vale').toBeInstanceOf(Error)
    expect(String((erro as Error).message)).toMatch(/não é vendido no dia escolhido/)
  }, 20_000)
})

/**
 * O caso que justifica o arquivo.
 *
 * Dois compradores na última vaga, em duas conexões, com a ordem forçada à
 * mão. Com o `FOR UPDATE` arrancado do gatilho, o segundo NÃO fica pendurado e
 * este caso fica vermelho na primeira asserção; com a contagem arrancada, ele
 * grava e fica vermelho na última.
 */
describe('CONCORRÊNCIA — dois compradores na última vaga', () => {
  it('o segundo espera o primeiro gravar, e aí não cabe mais', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')

    await acao({ o: 'editar', sessaoId: DIA_CORRIDA, capacidade: 1 })

    const { db } = await import('../../../../utils/db')
    const c1 = await db().connect()
    const c2 = await db().connect()

    const pedidos = await sql(
      `INSERT INTO orders (org_id, event_id, code, status, face_cents, fee_cents,
                           platform_cents, discount_cents, total_cents, paid_at)
       SELECT $1,$2,'ZZS-C' || i,'pago',0,0,0,0,0,now() FROM generate_series(1,2) i
       RETURNING id`, [ORG, EVENTO])

    const INSERE = `
      INSERT INTO order_items (order_id, lot_id, session_id, quantity,
                               unit_face_cents, unit_fee_cents, unit_total_cents)
      VALUES ($1,$2,$3,1,0,0,0)`

    try {
      await c1.query('BEGIN')
      await c2.query('BEGIN')

      // A pega a última vaga e SEGURA (sem COMMIT)
      await c1.query(INSERE, [pedidos[0].id, LOTE, DIA_CORRIDA])

      // B tenta a mesma vaga: tem que ficar pendurado na trava da sessão.
      let bPassou = false
      let bErro: any = null
      const bEsperando = c2.query(INSERE, [pedidos[1].id, LOTE, DIA_CORRIDA])
        .then(() => { bPassou = true })
        .catch((e) => { bErro = e })

      await new Promise((r) => setTimeout(r, 400))
      expect(bPassou,
        'o segundo comprador gravou sem esperar — a trava da sessão não está segurando').toBe(false)
      expect(bErro, 'o segundo morreu antes do primeiro terminar').toBe(null)

      await c1.query('COMMIT')
      await bEsperando

      expect(bPassou,
        'os dois compradores levaram a última vaga: o parque vendeu duas entradas para um lugar').toBe(false)
      expect(String(bErro?.message ?? ''),
        'o segundo foi recusado por um motivo que não é a lotação').toMatch(/não comporta mais/)
      await c2.query('ROLLBACK')
    } finally {
      // ROLLBACK antes de devolver ao pool, SEMPRE: `release()` não desfaz
      // transação aberta, e uma falha de asserção no meio deixaria o FOR UPDATE
      // preso na conexão devolvida — o caso seguinte travaria até o timeout e
      // apontaria pro lugar errado.
      await c1.query('ROLLBACK').catch(() => {})
      await c2.query('ROLLBACK').catch(() => {})
      c1.release()
      c2.release()
    }

    const depois = await dia(DIA_CORRIDA)
    expect(depois.ocupadas, 'entrou mais gente do que cabe no dia').toBeLessThanOrEqual(1)
  }, 40_000)
})

describe('mexer no catálogo sem derrubar quem já comprou', () => {
  it('não desliga do dia um lote que já vendeu para ele', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')

    // a mesa da fixture foi vendida PARA este dia; tirar o lote do dia
    // deixaria aquele comprador com um ingresso de data nenhuma
    const r = await acao({ o: 'lotes', sessaoId: DIA_MESA, loteIds: [LOTE] })
    expect(r.status, `desligou um dia com ingresso vendido — ${r.mensagem}`).toBe(409)
    expect(r.mensagem, 'recusou sem dizer quantos ingressos ficariam sem data')
      .toMatch(/1 ingresso/)

    const ainda = await dia(DIA_MESA)
    expect(ainda.lotes.map((l: any) => l.id), 'desligou mesmo recusando').toContain(LOTE_MESA)
  }, 20_000)

  it('não apaga um dia que já tem gente', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    const alvo = await dia(DIA_MESA)

    const r = await acao({ o: 'apagar', sessaoId: DIA_MESA })
    expect(r.status, `apagou um dia com ${alvo.ocupadas} pessoas dentro — ${r.mensagem}`).toBe(409)

    const [{ n }] = await sql(`SELECT count(*)::int AS n FROM event_sessions WHERE id = $1`, [DIA_MESA])
    expect(n, 'recusou na resposta e apagou assim mesmo').toBe(1)
  }, 20_000)

  it('apaga um dia vazio', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    const vazio = await dia(DIA_APAGAR)
    expect(vazio.ocupadas, 'o dia reservado pra este caso não está vazio').toBe(0)

    const r = await acao({ o: 'apagar', sessaoId: DIA_APAGAR })
    expect(r.status, `não apagou um dia sem ninguém — ${r.mensagem}`).toBe(200)

    const [{ n }] = await sql(
      `SELECT count(*)::int AS n FROM event_sessions WHERE id = $1`, [DIA_APAGAR])
    expect(n, 'respondeu ok e o dia continua no calendário').toBe(0)
  }, 20_000)

  it('o passaporte de vários dias ocupa vaga em TODOS eles', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')

    const antesA = (await dia(DIA_PASSE_A)).ocupadas
    const antesB = (await dia(DIA_PASSE_B)).ocupadas

    // passaporte não escolhe dia: vai sem session_id, igual ao checkout
    await vender(LOTE_PASSE, 1)

    expect((await dia(DIA_PASSE_A)).ocupadas,
      'o passe de 4 pessoas não entrou na conta do primeiro dia').toBe(antesA + 4)
    expect((await dia(DIA_PASSE_B)).ocupadas,
      'o passe ocupou um dia só: quem compra passe de 2 dias está no parque nos 2').toBe(antesB + 4)
  }, 30_000)

  it('a tela não diz que o passaporte fica sem data e não ocupa vaga', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    const p = await painel()

    const passe = p.lotes.find((l: any) => l.id === LOTE_PASSE)
    expect(passe.dias, 'o passe deixou de valer em 2 dias').toBe(2)
    // O aviso amarelo da tela diz, com todas as letras, que o lote "sai sem
    // data e não desconta vaga de nenhuma sessão". Para o passaporte isso é o
    // CONTRÁRIO do que o gatilho acabou de fazer no caso acima — o operador
    // planejaria a lotação da piscina pelo número errado.
    expect(passe.escolheDia,
      'a tela põe o passaporte no aviso de "sai sem data e não ocupa vaga", e ele ocupa os dois dias')
      .toBe(false)
    expect(passe.cobreTodosOsDias, 'o passaporte sumiu do aviso que diz a verdade sobre ele').toBe(true)

    // e o ingresso avulso de vários dias continua no aviso, que para ele é verdade
    const avulso = p.lotes.find((l: any) => l.id === LOTE)
    expect(avulso.dias, 'o lote avulso da fixture deixou de valer em vários dias')
      .toBeGreaterThan(1)
    expect(avulso.escolheDia,
      'o aviso sumiu para quem realmente sai sem data: o ingresso avulso de vários dias').toBe(true)
  }, 20_000)

  it('não deixa ligar lote de outro evento no meu dia', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    const [alheio] = await sql(
      `SELECT l.id FROM lots l JOIN sectors s ON s.id = l.sector_id
        WHERE s.event_id <> $1 LIMIT 1`, [EVENTO])
    if (!alheio) return void console.warn('  (pulado: não há lote de outro evento no banco)')

    const r = await acao({ o: 'lotes', sessaoId: DIA_CORRIDA, loteIds: [alheio.id] })
    expect(r.status, 'ligou um lote de outro produtor no meu calendário').toBe(422)
  }, 20_000)
})

/**
 * O ingresso emitido conta no dia — mesmo com o carimbo dele vazio.
 *
 * Quem grava `tickets.session_id` é `utils/emissao.ts`, e ele copia o dia do
 * SETOR. No modelo novo (lote ligado ao dia por `lot_sessions`) o setor não
 * tem dia, então TODO ingresso nasce com o carimbo vazio — medido no
 * `/api/checkout` de verdade: item com o dia certo, ingresso com NULL.
 *
 * Contando só pela coluna do ingresso, duas coisas quebram em silêncio: o
 * cartão mostra "2 pessoas confirmadas / 0 ingressos emitidos" para a mesma
 * venda, e a trava de "não apague um dia que já tem ingresso" fica morta
 * justamente no modelo que ela existe pra proteger.
 */
describe('ingresso emitido conta no dia mesmo sem carimbo próprio', () => {
  /**
   * Vende no DIA_TICKET e emite o ingresso do jeito que `emissao.ts` emite
   * hoje: carimbo vazio, porque o dia vem do SETOR e o setor deste modelo não
   * tem dia. Idempotente e chamada pelos dois casos — caso que depende de
   * outro ter rodado antes não é caso, e `-t` sozinho provaria o nada.
   */
  async function venderEEmitir(): Promise<string> {
    const [ja] = await sql(
      `SELECT o.id FROM orders o JOIN order_items oi ON oi.order_id = o.id
        WHERE oi.lot_id = $1 ORDER BY o.created_at LIMIT 1`, [LOTE_DIA])
    if (ja) return ja.id

    const pedido = await vender(LOTE_DIA, 2)
    const [item] = await sql(
      `SELECT id, session_id FROM order_items WHERE order_id = $1`, [pedido])
    expect(item.session_id, 'o gatilho não carimbou o dia no item').toBe(DIA_TICKET)

    await sql(
      `INSERT INTO tickets (org_id, event_id, session_id, order_id, order_item_id,
                            sector_id, lot_id, code, qr_secret, status)
       SELECT $1, $2, NULL, $3, $4, l.sector_id, l.id,
              'ZZS' || substr(gen_random_uuid()::text, 1, 10),
              encode(gen_random_bytes(8), 'hex'), 'valido'
         FROM lots l WHERE l.id = $5`,
      [ORG, EVENTO, pedido, item.id, LOTE_DIA])
    return pedido
  }

  it('o ingresso sem carimbo entra pelo dia do item', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')

    const antes = await dia(DIA_TICKET)
    expect(antes.ingressosEmitidos, 'o dia deste caso já vem com ingresso de alguém').toBe(0)

    await venderEEmitir()

    const depois = await dia(DIA_TICKET)
    expect(depois.ingressosEmitidos,
      'o cartão diz "0 ingressos emitidos" para um dia que já tem gente com ingresso na mão')
      .toBe(1)
  }, 30_000)

  it('dia com ingresso válido não é apagável nem com o pedido cancelado', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    const pedidoDoIngresso = await venderEEmitir()

    // Cancelar zera a OCUPAÇÃO — mas o ingresso continua válido na mão de
    // alguém. Sem contar o ingresso, a tela ofereceria o botão de apagar, e
    // `tickets.session_id` é ON DELETE SET NULL: o ingresso ficaria sem data
    // e ninguém veria erro nenhum.
    await sql(`UPDATE orders SET status = 'cancelado', canceled_at = now() WHERE id = $1`,
      [pedidoDoIngresso])

    const d = await dia(DIA_TICKET)
    expect(d.ocupadas, 'o pedido cancelado continua ocupando vaga').toBe(0)
    expect(d.ingressosEmitidos, 'o ingresso válido sumiu da conta ao cancelar o pedido').toBe(1)
    expect(d.podeApagar,
      'a tela ofereceria apagar um dia com ingresso válido emitido').toBe(false)

    const r = await acao({ o: 'apagar', sessaoId: DIA_TICKET })
    expect(r.status,
      `apagou o dia com ingresso emitido — o ingresso ficaria sem data — ${r.mensagem}`).toBe(409)

    const [{ n }] = await sql(
      `SELECT count(*)::int AS n FROM event_sessions WHERE id = $1`, [DIA_TICKET])
    expect(n, 'recusou na resposta e apagou assim mesmo').toBe(1)
  }, 20_000)
})
