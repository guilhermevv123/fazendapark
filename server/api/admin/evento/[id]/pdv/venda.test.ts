/**
 * Teste do cancelamento de venda do balcão.
 *
 * Vender já tinha teste; desfazer não existia. O que este arquivo tranca é o
 * que acontece quando a venda é desfeita — que é onde dinheiro e ingresso
 * podem acabar em estados diferentes:
 *
 *  1. cancelar tem que mexer nas QUATRO pontas juntas (ingresso morto,
 *     estoque de volta, dinheiro fora da conferência, estorno pedido);
 *  2. a gaveta não pode perder o valor duas vezes — subtrair o cancelamento
 *     de um total que já não o contém faz o fechamento acusar uma falta do
 *     tamanho exato do cancelamento, com o dinheiro certinho na mão;
 *  3. ingresso que JÁ ENTROU no parque não cancela: a pessoa está lá dentro;
 *  4. a mesma venda não cancela duas vezes (estoque voltando em dobro é lote
 *     vendendo mais ingresso do que existe);
 *  5. caixa fechado não recebe cancelamento — mudaria uma conferência já
 *     assinada;
 *  6. venda pela internet não é desfeita pelo guichê;
 *  7. venda de outra produtora não é alcançada pelo id no corpo.
 *
 * A trava de "não cancela duas vezes" é testada com DUAS CONEXÕES rodando a
 * MESMA instrução da rota (importada de `utils/caixa.ts`). Pelo HTTP, em
 * sequência, o teste ficaria verde mesmo com o `AND status = 'pago'`
 * arrancado — o segundo pedido morreria na leitura de diagnóstico e ninguém
 * veria a diferença.
 *
 * Fixture própria com ids fixos, apagada no fim; o evento semeado não é
 * tocado. Sem servidor de dev no ar, PULA em vez de falhar.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PoolClient } from 'pg'
import {
  SQL_CANCELA_VENDA_PDV, SQL_TRAVA_INGRESSOS_DA_VENDA,
} from '../../../../../utils/caixa'
import { SQL_MARCA_ENTRADA } from '../../../../../utils/catraca'

const BASE = process.env.BASE_TESTE ?? 'http://localhost:3100'

const ORG = '0000d003-0000-4000-8000-000000000001'
const USUARIO = '0000d003-0000-4000-8000-000000000002'
const EVENTO = '0000d003-0000-4000-8000-000000000003'
const SETOR = '0000d003-0000-4000-8000-000000000004'
const LOTE = '0000d003-0000-4000-8000-000000000005'

/** a produtora vizinha: o pedido dela vem no CORPO e não pode ser alcançado */
const ORG_VIZINHA = '0000d004-0000-4000-8000-000000000001'
const EVENTO_VIZINHO = '0000d004-0000-4000-8000-000000000003'
const SETOR_VIZINHO = '0000d004-0000-4000-8000-000000000004'
const LOTE_VIZINHO = '0000d004-0000-4000-8000-000000000005'
const PONTO_VIZINHO = '0000d004-0000-4000-8000-000000000006'
const TURNO_VIZINHO = '0000d004-0000-4000-8000-000000000007'
const PEDIDO_VIZINHO = '0000d004-0000-4000-8000-000000000008'

/*
 * E-mail PRÓPRIO deste arquivo, e não um compartilhado.
 *
 * Ele era `dono.cancelamento@teste.invalido`, o mesmo de
 * `server/utils/cancelamento.test.ts`, com o mesmo hash de senha — só que em
 * OUTRA organização. O login recusa (409) quando o mesmo e-mail casa a mesma
 * senha em duas organizações, porque aí não dá pra saber qual painel abrir.
 * Quando as duas fixturas coexistiam no banco, este arquivo não recebia
 * cookie e os 11 casos caíam com 401 — vermelho INTERMITENTE, que aparecia
 * só quando a outra suíte tinha sido interrompida antes do `afterAll` ou a
 * ordem de execução sobrepunha as duas.
 *
 * A regra que isso deixa: fixtura é dona do que cria. E-mail de teste leva o
 * nome do arquivo, senão duas suítes disputam a mesma identidade.
 */
const EMAIL = 'dono.venda.pdv@teste.invalido'
const FACE = 3000 // R$ 30,00 redondo: a conta do balcão fica conferível de cabeça

let noAr = false
let cookie = ''

/**
 * Pula o caso quando o servidor de dev não está no ar — e pula de VERDADE.
 *
 * Isto era `if (!noAr) return void console.warn(...)`, e o vitest contava o
 * caso como ✓. Medido: com o servidor respondendo 500 (outro arquivo do
 * repositório com erro de sintaxe derruba o bundle inteiro do nitro), a suíte
 * imprimiu **296 passed** em 4s sem bater uma vez na rota — os mesmos dez
 * casos de dinheiro deste arquivo entre eles.
 *
 * Numa corrida de MUTAÇÃO isso é a pior resposta possível: dá a invariante
 * por provada exatamente quando ela foi arrancada. `ctx.skip()` sai contado
 * como pulado, que é o que se lê de longe. Mesma decisão de
 * `utils/auditoria.test.ts`.
 */
const PORQUE_PULOU = 'servidor de dev fora do ar ou respondendo 500 (porta 3100)'
function seForaDoArPula(ctx: { skip: (motivo?: string) => void }) {
  if (!noAr) ctx.skip(PORQUE_PULOU)
}

async function sql(texto: string, par: any[] = []) {
  const { q } = await import('../../../../../utils/db')
  return q<any>(texto, par)
}

async function conexao() {
  const { db } = await import('../../../../../utils/db')
  return db().connect()
}

const comSessao = (rota: string, init: RequestInit = {}) =>
  fetch(`${BASE}${rota}`, {
    ...init,
    headers: { 'content-type': 'application/json', cookie, origin: BASE, ...(init.headers ?? {}) },
  })

const pdv = (sufixo = '', init: RequestInit = {}) =>
  comSessao(`/api/admin/evento/${EVENTO}/pdv${sufixo}`, init)

async function json(r: Response) {
  return { status: r.status, corpo: await r.json().catch(() => ({} as any)) }
}

/** ponto novo a cada teste: o índice de caixa aberto é POR ponto */
async function novoPonto(nome: string, formas = ['dinheiro', 'debito', 'pix']) {
  const r = await json(await pdv('', { method: 'POST', body: JSON.stringify({ nome, formas }) }))
  if (r.status !== 200) throw new Error(`ponto não criado: ${JSON.stringify(r.corpo)}`)
  return r.corpo.id as string
}

async function abrirCaixa(pontoId: string, fundoCents = 0) {
  const r = await json(await pdv('/turno', {
    method: 'POST', body: JSON.stringify({ pontoId, fundoCents }),
  }))
  if (r.status !== 200) throw new Error(`caixa não abriu: ${JSON.stringify(r.corpo)}`)
  return r.corpo.turnoId as string
}

async function vender(corpo: any) {
  const r = await json(await pdv('/venda', { method: 'POST', body: JSON.stringify(corpo) }))
  if (r.status !== 200) throw new Error(`venda não saiu: ${JSON.stringify(r.corpo)}`)
  return r.corpo
}

const cancelar = async (pedidoId: string, motivo = 'cliente desistiu no balcão') =>
  json(await pdv('/cancelamento', { method: 'POST', body: JSON.stringify({ pedidoId, motivo }) }))

const conferir = async (turno: string) => (await json(await pdv(`/turno?turno=${turno}`))).corpo

const vendidos = async (lote = LOTE) =>
  Number((await sql(`SELECT sold FROM lots WHERE id = $1`, [lote]))[0].sold)

/**
 * Espera até que ALGUÉM esteja parado esperando o lock desta conexão.
 *
 * É o que transforma "as duas coisas aconteceram perto" numa corrida de
 * verdade. Sem esta espera, o cancelamento podia terminar inteiro antes de a
 * porta marcar a entrada: o teste ficaria verde pelo caminho fácil (o
 * `NOT EXISTS` vendo o ingresso já `usado`) sem nunca exercitar a trava — que
 * é exatamente o defeito que este arquivo diz estar trancando.
 *
 * `pg_blocking_pids` amarra a espera a ESTA conexão. Contar bloqueio por
 * texto de consulta pegaria o de outro arquivo de teste rodando em paralelo e
 * soltaria o teste cedo demais.
 */
async function esperarBloqueadoPor(c: PoolClient, msLimite = 8000) {
  const { rows } = await c.query('SELECT pg_backend_pid() AS pid')
  const pid = rows[0].pid
  const t0 = Date.now()
  while (Date.now() - t0 < msLimite) {
    const [{ n }] = await sql(
      `SELECT count(*)::int AS n
         FROM pg_stat_activity
        WHERE datname = current_database()
          AND wait_event_type = 'Lock'
          AND $1 = ANY(pg_blocking_pids(pid))`, [pid])
    if (Number(n) > 0) return true
    await new Promise((r) => setTimeout(r, 40))
  }
  return false
}

/**
 * Uma corrida deste arquivo por vez, no BANCO — não no processo.
 *
 * O `DELETE FROM organizations` logo abaixo cai em cascata até `sessions`
 * (organizations → users → sessions) e até `pos_terminals`/`pos_shifts`. Com
 * duas corridas ao mesmo tempo — coisa comum aqui, vários agentes rodando a
 * suíte no mesmo repositório — a segunda apaga o usuário da primeira NO MEIO
 * das asserções: medido, uma corrida em dez morria com "Test timed out in
 * 40000ms" e todos os casos seguintes em 401 "Faça login para continuar",
 * sem nada a ver com o cancelamento.
 *
 * `pg_advisory_lock` é de SESSÃO: some sozinho quando a conexão fecha, então
 * corrida morta não deixa trava presa. Fica no `try`, com prazo e mensagem, em
 * vez de bloquear pra sempre.
 */
const TRAVA_DESTE_ARQUIVO = 902_3006
let travaDono: PoolClient | null = null

beforeAll(async () => {
  try {
    noAr = (await fetch(`${BASE}/api/auth/eu`, { signal: AbortSignal.timeout(2500) })).status < 500
  } catch { noAr = false }
  if (!noAr) return

  travaDono = await conexao()
  const prazo = Date.now() + 25_000
  while (!(await travaDono.query(
    'SELECT pg_try_advisory_lock($1) AS ok', [TRAVA_DESTE_ARQUIVO])).rows[0].ok) {
    if (Date.now() > prazo) {
      throw new Error('outra corrida deste arquivo ainda está de pé — rode de novo em instantes')
    }
    await new Promise((r) => setTimeout(r, 100))
  }

  // Limpa ANTES, não só depois. Quando uma corrida morre no meio (foi o que
  // aconteceu com o slug repetido), o `afterAll` não chega a rodar e sobra
  // meia fixture: a organização de pé e o evento faltando. A corrida seguinte
  // passa pelos `ON CONFLICT (id)` sem erro nenhum e quebra lá na frente com
  // "Evento não encontrado" — mensagem que não tem nada a ver com o defeito.
  // Começar do zero custa um DELETE e tira essa classe de falsa falha do meio
  // do caminho.
  await sql(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [[ORG, ORG_VIZINHA]])

  // mesmo motivo do slug do evento logo abaixo: nome de arquivo dentro do slug
  for (const [org, slug] of [[ORG, 'zz-pdv-venda-org'], [ORG_VIZINHA, 'zz-pdv-venda-org-vizinha']]) {
    await sql(`INSERT INTO organizations (id, name, slug) VALUES ($1,$2,$2)
               ON CONFLICT (id) DO NOTHING`, [org, slug])
  }
  // O slug de `events` é único no banco INTEIRO, não por produtora. Um nome
  // genérico ("zz-evento-cancelamento") vira colisão com a fixture de outro
  // arquivo de teste e derruba os dois com `duplicate key`, sem nenhuma
  // relação com o que está sendo testado. Por isso o slug daqui carrega o
  // nome da rota: `pdv/venda` é deste arquivo e de mais ninguém.
  for (const [ev, org, slug] of [
    [EVENTO, ORG, 'zz-pdv-venda-cancelamento'],
    [EVENTO_VIZINHO, ORG_VIZINHA, 'zz-pdv-venda-cancelamento-vizinho'],
  ]) {
    await sql(
      `INSERT INTO events (id, org_id, name, slug, starts_at, ends_at, status, fee_bps, fee_mode_pos)
       VALUES ($1,$2,$3,$3, now() + interval '10 days', now() + interval '11 days',
               'ativo', 1000, 'absorver')
       ON CONFLICT (id) DO UPDATE SET status = 'ativo', fee_mode_pos = 'absorver'`, [ev, org, slug])
  }

  for (const [setor, ev] of [[SETOR, EVENTO], [SETOR_VIZINHO, EVENTO_VIZINHO]]) {
    await sql(`INSERT INTO sectors (id, event_id, name) VALUES ($1,$2,'ZZ SETOR CANCEL')
               ON CONFLICT (id) DO NOTHING`, [setor, ev])
  }
  for (const [lote, setor] of [[LOTE, SETOR], [LOTE_VIZINHO, SETOR_VIZINHO]]) {
    await sql(
      `INSERT INTO lots (id, sector_id, name, price_cents, quantity, channels, visible)
       VALUES ($1,$2,'ZZ LOTE CANCEL',$3,500,'{online,bilheteria}',true)
       ON CONFLICT (id) DO UPDATE SET quantity = 500, sold = 0, reserved = 0,
         channels = '{online,bilheteria}', price_cents = EXCLUDED.price_cents`,
      [lote, setor, FACE])
  }

  await sql(
    `INSERT INTO users (id, org_id, name, email, password_hash, role)
     SELECT $1, $2, 'Dono Cancelamento Teste', $3, password_hash, 'master'
       FROM users WHERE email = 'dono@fazendapark.com.br'
     ON CONFLICT (id) DO NOTHING`, [USUARIO, ORG, EMAIL])

  // venda paga da vizinha, com caixa aberto: é o pedido que o id no corpo
  // tentaria alcançar
  await sql(
    `INSERT INTO pos_terminals (id, org_id, event_id, name)
     VALUES ($1,$2,$3,'ZZ GUICHE VIZINHO CANCEL') ON CONFLICT (id) DO NOTHING`,
    [PONTO_VIZINHO, ORG_VIZINHA, EVENTO_VIZINHO])
  await sql(
    `INSERT INTO pos_shifts (id, org_id, event_id, terminal_id, operator_id, opening_float_cents)
     SELECT $1,$2,$3,$4, u.id, 0 FROM users u WHERE u.email = 'dono@fazendapark.com.br'
     ON CONFLICT (id) DO NOTHING`,
    [TURNO_VIZINHO, ORG_VIZINHA, EVENTO_VIZINHO, PONTO_VIZINHO])
  await sql(
    `INSERT INTO orders (id, org_id, event_id, code, status, channel, face_cents,
                         platform_cents, total_cents, payment_method, pos_terminal_id,
                         pos_shift_id, paid_at)
     VALUES ($1,$2,$3,'ZZCANCELVIZ','pago','bilheteria',$4,0,$4,'dinheiro',$5,$6, now())
     ON CONFLICT (id) DO UPDATE SET status = 'pago', refunded_cents = 0`,
    [PEDIDO_VIZINHO, ORG_VIZINHA, EVENTO_VIZINHO, FACE, PONTO_VIZINHO, TURNO_VIZINHO])

  const r = await fetch(`${BASE}/api/auth/entrar`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, senha: 'diamond123' }),
  })
  cookie = (r.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(';')[0]).find((c) => c.startsWith('dt_sessao=')) ?? ''
}, 40_000)

afterAll(async () => {
  if (!noAr) return
  try {
    await sql(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [[ORG, ORG_VIZINHA]])
  } finally {
    // solta a trava mesmo se a limpeza falhar, senão a próxima corrida espera
    // os 25 segundos inteiros por causa de um erro que já passou
    if (travaDono) {
      try {
        await travaDono.query('SELECT pg_advisory_unlock($1)', [TRAVA_DESTE_ARQUIVO])
      } catch { /* conexão já morreu: a trava morreu junto */ }
      travaDono.release()
      travaDono = null
    }
  }
})

describe('cancelamento de venda no balcão', () => {
  it('a sessão do teste existe (senão nada abaixo prova nada)', async (ctx) => {
    seForaDoArPula(ctx)
    expect(cookie, 'login falhou — o teste ficaria verde à toa').toBeTruthy()
  }, 20_000)

  it('cancelar mata o ingresso, devolve o estoque e tira o dinheiro da gaveta', async (ctx) => {
    seForaDoArPula(ctx)
    const turno = await abrirCaixa(await novoPonto('ZZ CANCELA OK'), 10_000)
    const antes = await vendidos()

    // recebe 100 e devolve 10 de troco: a gaveta fica com 90 a mais
    const venda = await vender({
      turnoId: turno, itens: [{ lotId: LOTE, quantidade: 3 }],
      forma: 'dinheiro', recebidoCents: 10_000,
    })
    expect(venda.totalCents).toBe(3 * FACE)

    const durante = await conferir(turno)
    expect(durante.contagem.esperadoCents).toBe(10_000 + 3 * FACE)

    const r = await cancelar(venda.pedidoId, 'operador digitou 3 em vez de 2')
    expect(r.status, JSON.stringify(r.corpo)).toBe(200)
    expect(r.corpo.ingressosCancelados).toBe(3)
    expect(r.corpo.saiuDaGaveta, 'venda em dinheiro precisa sair da gaveta').toBe(true)
    expect(r.corpo.aviso, 'o operador não foi avisado de devolver o dinheiro')
      .toMatch(/Devolva/i)

    // 1. o ingresso morreu — senão a pessoa entra com uma venda desfeita
    const ingressos = await sql(
      `SELECT status FROM tickets WHERE order_id = $1`, [venda.pedidoId])
    expect(ingressos).toHaveLength(3)
    expect(ingressos.every((t: any) => t.status === 'cancelado'),
      'sobrou ingresso válido numa venda cancelada').toBe(true)

    // 2. o estoque voltou pra prateleira
    expect(await vendidos(), 'o estoque não voltou: o lote esgota sem ter vendido')
      .toBe(antes)

    // 3. o pedido guarda quanto voltou
    const [pedido] = await sql(
      `SELECT status, refunded_cents, canceled_at FROM orders WHERE id = $1`, [venda.pedidoId])
    expect(pedido.status).toBe('cancelado')
    expect(Number(pedido.refunded_cents)).toBe(3 * FACE)
    expect(pedido.canceled_at).toBeTruthy()

    // 4. o rastro: quem cancelou e por quê
    const [rastro] = await sql(
      `SELECT by_user, reason, from_drawer, tickets_canceled, amount_cents, gateway_refund
         FROM pos_sale_cancellations WHERE order_id = $1`, [venda.pedidoId])
    expect(rastro.by_user).toBe(USUARIO)
    expect(rastro.reason).toBe('operador digitou 3 em vez de 2')
    expect(rastro.from_drawer).toBe(true)
    expect(rastro.tickets_canceled).toBe(3)
    expect(Number(rastro.amount_cents)).toBe(3 * FACE)
    expect(rastro.gateway_refund, 'venda em espécie não tem o que estornar no gateway')
      .toBe('nao_aplica')

    // 5. a conferência: o dinheiro saiu, UMA vez só
    const depois = await conferir(turno)
    expect(depois.contagem.dinheiroCents, 'a venda cancelada continua contando como venda')
      .toBe(0)
    expect(depois.contagem.devolvidoDinheiroCents,
      'o cancelamento não apareceu na conferência — o valor só sumiu').toBe(3 * FACE)
    expect(depois.contagem.cancelamentos).toHaveLength(1)
    expect(depois.contagem.cancelamentos[0].motivo).toBe('operador digitou 3 em vez de 2')
    expect(depois.contagem.esperadoCents,
      'o cancelamento foi descontado duas vezes: o fechamento vai acusar falta com a gaveta certa')
      .toBe(10_000)

    // 6. e o fechamento bate com o que está fisicamente na gaveta: entraram
    // 100, saíram 10 de troco e voltaram 90 no cancelamento → sobrou o fundo
    const f = await json(await pdv('/turno', {
      method: 'PATCH', body: JSON.stringify({ turnoId: turno, contadoCents: 10_000 }),
    }))
    expect(f.status, JSON.stringify(f.corpo)).toBe(200)
    expect(f.corpo.situacao, 'a sobra/falta do fechamento está mentindo').toBe('bate')
    expect(f.corpo.diferencaCents).toBe(0)
  }, 40_000)

  it('ingresso que já entrou no parque não deixa cancelar a venda', async (ctx) => {
    seForaDoArPula(ctx)
    const turno = await abrirCaixa(await novoPonto('ZZ CANCELA ENTROU'), 0)
    const antes = await vendidos()

    const venda = await vender({
      turnoId: turno, itens: [{ lotId: LOTE, quantidade: 2 }], forma: 'dinheiro',
    })

    // entra pela MESMA instrução que a catraca roda
    const c = await conexao()
    try {
      const entrou = await c.query(SQL_MARCA_ENTRADA, [venda.ingressos[0].id, USUARIO])
      expect(entrou.rowCount, 'o ingresso não entrou — o teste abaixo não provaria nada').toBe(1)
    } finally { c.release() }

    const r = await cancelar(venda.pedidoId, 'cliente pediu o dinheiro de volta')
    expect(r.status, 'cancelou uma venda de quem já está dentro do parque').toBe(409)
    expect(String(r.corpo.message ?? r.corpo.statusMessage)).toMatch(/entraram no parque/i)

    // nada pode ter mexido: nem o pedido, nem os ingressos, nem o estoque
    const [pedido] = await sql(
      `SELECT status, refunded_cents FROM orders WHERE id = $1`, [venda.pedidoId])
    expect(pedido.status, 'o pedido de quem entrou foi cancelado assim mesmo').toBe('pago')
    expect(Number(pedido.refunded_cents)).toBe(0)

    const ingressos = await sql(
      `SELECT status FROM tickets WHERE order_id = $1 ORDER BY status`, [venda.pedidoId])
    expect(ingressos.map((t: any) => t.status)).toEqual(['usado', 'valido'])
    expect(await vendidos(), 'o estoque voltou numa venda que não foi cancelada')
      .toBe(antes + 2)
  }, 40_000)

  it('porta entrando NO MEIO do cancelamento: a venda não é desfeita', async (ctx) => {
    seForaDoArPula(ctx)
    const turno = await abrirCaixa(await novoPonto('ZZ CANCELA CORRIDA'), 0)
    const antes = await vendidos()
    const venda = await vender({
      turnoId: turno, itens: [{ lotId: LOTE, quantidade: 2 }], forma: 'dinheiro',
    })

    // O caso do teste de cima ("já entrou") é o fácil: a entrada terminou
    // ANTES do cancelamento começar, e o `NOT EXISTS` sozinho resolve. Este é
    // o difícil — a catraca está com as linhas dos ingressos na mão e ainda
    // NÃO marcou a entrada, que é o instante em que as duas decisões se
    // cruzam. Quem separa os dois é o `SQL_TRAVA_INGRESSOS_DA_VENDA` da rota:
    // sem ele, o `NOT EXISTS` lê "todos válidos" (leitura simples não espera
    // lock), o pedido vira 'cancelado', a porta grava 'usado' por baixo, e o
    // cancelamento termina com 200 deixando a pessoa DENTRO do parque com a
    // venda desfeita e o dinheiro de volta.
    const porta = await conexao()
    let resposta: any
    try {
      await porta.query('BEGIN')
      await porta.query(SQL_TRAVA_INGRESSOS_DA_VENDA, [venda.pedidoId])

      // o guichê cancela AGORA, com a porta no meio do caminho
      const cancelamento = cancelar(venda.pedidoId, 'cliente desistiu no balcão')

      // só segue quando o cancelamento estiver REALMENTE parado esperando
      // esta conexão — senão a corrida não foi exercida e o verde não vale
      expect(await esperarBloqueadoPor(porta),
        'o cancelamento não esperou a porta: a corrida não aconteceu e este teste não prova nada')
        .toBe(true)

      const entrou = await porta.query(SQL_MARCA_ENTRADA, [venda.ingressos[0].id, USUARIO])
      expect(entrou.rowCount, 'o ingresso não entrou — o teste abaixo não provaria nada').toBe(1)
      await porta.query('COMMIT')

      resposta = await cancelamento
    } finally {
      // ROLLBACK sempre: falha de asserção no meio deixaria o FOR UPDATE
      // preso na conexão devolvida e o próximo caso travaria até o timeout
      try { await porta.query('ROLLBACK') } catch { /* já fechada */ }
      porta.release()
    }

    expect(resposta.status,
      'a venda foi desfeita com a pessoa entrando no parque no mesmo instante')
      .toBe(409)
    expect(String(resposta.corpo.message ?? resposta.corpo.statusMessage))
      .toMatch(/entraram no parque/i)

    const [pedido] = await sql(
      `SELECT status, refunded_cents FROM orders WHERE id = $1`, [venda.pedidoId])
    expect(pedido.status, 'o pedido de quem entrou foi cancelado assim mesmo').toBe('pago')
    expect(Number(pedido.refunded_cents), 'devolveu dinheiro de quem está lá dentro').toBe(0)

    // o ingresso do acompanhante não pode ter morrido junto: ele não entrou
    // ainda, mas a venda continua de pé
    const ingressos = await sql(
      `SELECT status FROM tickets WHERE order_id = $1 ORDER BY status`, [venda.pedidoId])
    expect(ingressos.map((t: any) => t.status),
      'o cancelamento matou o ingresso do acompanhante de uma venda que não foi desfeita')
      .toEqual(['usado', 'valido'])

    expect(await vendidos(), 'o estoque voltou numa venda que não foi cancelada')
      .toBe(antes + 2)

    const [{ n }] = await sql(
      `SELECT count(*)::int AS n FROM pos_sale_cancellations WHERE order_id = $1`,
      [venda.pedidoId])
    expect(Number(n), 'nasceu rastro de cancelamento para uma venda que não foi cancelada').toBe(0)
  }, 40_000)

  it('duas conexões cancelando a mesma venda: só uma cancela', async (ctx) => {
    seForaDoArPula(ctx)
    const turno = await abrirCaixa(await novoPonto('ZZ CANCELA DUPLO'), 0)
    const venda = await vender({
      turnoId: turno, itens: [{ lotId: LOTE, quantidade: 1 }], forma: 'dinheiro',
    })

    // Duas conexões de verdade, uma depois da outra, rodando a MESMA
    // instrução da rota. Arrancar `AND o.status = 'pago'` faz esta soma virar 2
    // — e cada passagem devolveria o estoque outra vez.
    const c1 = await conexao()
    const c2 = await conexao()
    try {
      const r1 = await c1.query(SQL_CANCELA_VENDA_PDV, [venda.pedidoId])
      const r2 = await c2.query(SQL_CANCELA_VENDA_PDV, [venda.pedidoId])
      expect(r1.rowCount! + r2.rowCount!,
        'a mesma venda foi cancelada duas vezes — estoque e estorno saem em dobro')
        .toBe(1)
    } finally { c1.release(); c2.release() }
  }, 40_000)

  it('pela rota, o segundo cancelamento é recusado e não duplica nada', async (ctx) => {
    seForaDoArPula(ctx)
    const turno = await abrirCaixa(await novoPonto('ZZ CANCELA 2X'), 0)
    const antes = await vendidos()
    const venda = await vender({
      turnoId: turno, itens: [{ lotId: LOTE, quantidade: 2 }], forma: 'dinheiro',
    })

    const um = await cancelar(venda.pedidoId, 'cliente desistiu')
    expect(um.status, JSON.stringify(um.corpo)).toBe(200)
    const dois = await cancelar(venda.pedidoId, 'cliente desistiu de novo')
    expect(dois.status, 'cancelou a mesma venda duas vezes').toBe(409)
    expect(String(dois.corpo.message ?? dois.corpo.statusMessage)).toMatch(/já foi cancelada/i)

    const [{ n }] = await sql(
      `SELECT count(*)::int AS n FROM pos_sale_cancellations WHERE order_id = $1`,
      [venda.pedidoId])
    expect(n, 'dois rastros para o mesmo cancelamento').toBe(1)

    const [pedido] = await sql(`SELECT refunded_cents FROM orders WHERE id = $1`, [venda.pedidoId])
    expect(Number(pedido.refunded_cents), 'o valor devolvido dobrou').toBe(2 * FACE)
    expect(await vendidos(), 'o estoque voltou duas vezes: o lote passa a ter ingresso a mais')
      .toBe(antes)
  }, 40_000)

  it('caixa fechado não recebe cancelamento', async (ctx) => {
    seForaDoArPula(ctx)
    const turno = await abrirCaixa(await novoPonto('ZZ CANCELA FECHADO'), 0)
    const venda = await vender({
      turnoId: turno, itens: [{ lotId: LOTE, quantidade: 1 }], forma: 'dinheiro',
    })

    const f = await json(await pdv('/turno', {
      method: 'PATCH', body: JSON.stringify({ turnoId: turno, contadoCents: FACE }),
    }))
    expect(f.status, JSON.stringify(f.corpo)).toBe(200)
    const esperadoCongelado = f.corpo.contagem.esperadoCents

    const r = await cancelar(venda.pedidoId, 'achei o erro depois de fechar')
    expect(r.status, 'cancelou venda de um caixa já conferido').toBe(409)
    expect(String(r.corpo.message ?? r.corpo.statusMessage)).toMatch(/já foi fechado/i)

    const [pedido] = await sql(`SELECT status FROM orders WHERE id = $1`, [venda.pedidoId])
    expect(pedido.status, 'a venda de um turno fechado foi desfeita').toBe('pago')

    const [t] = await sql(
      `SELECT closing_expected_cents FROM pos_shifts WHERE id = $1`, [turno])
    expect(Number(t.closing_expected_cents),
      'o fechamento já assinado mudou depois do cancelamento').toBe(esperadoCongelado)
  }, 40_000)

  it('venda cobrada pela plataforma pede o estorno, e não mexe na gaveta', async (ctx) => {
    seForaDoArPula(ctx)
    const turno = await abrirCaixa(await novoPonto('ZZ CANCELA PIX'), 5_000)
    const venda = await vender({
      turnoId: turno, itens: [{ lotId: LOTE, quantidade: 2 }], forma: 'pix',
    })

    // o guichê que cobra pelo QR da plataforma deixa o rastro da cobrança no
    // pedido — é o `asaas_payment_id` que diz de que bolso o dinheiro saiu
    await sql(`UPDATE orders SET asaas_payment_id = $2 WHERE id = $1`,
      [venda.pedidoId, `sim_${venda.pedidoId}`])

    const r = await cancelar(venda.pedidoId, 'cobrou no pix errado')
    expect(r.status, JSON.stringify(r.corpo)).toBe(200)
    expect(r.corpo.estorno, 'o estorno não foi pedido a quem recebeu o dinheiro').toBe('simulado')
    expect(r.corpo.saiuDaGaveta, 'cancelamento de pix tirou nota da gaveta').toBe(false)
    expect(r.corpo.aviso).toMatch(/Estorno/i)

    const [rastro] = await sql(
      `SELECT gateway_refund, from_drawer FROM pos_sale_cancellations WHERE order_id = $1`,
      [venda.pedidoId])
    expect(rastro.gateway_refund).toBe('simulado')
    expect(rastro.from_drawer).toBe(false)

    // a gaveta continua com o fundo: esse dinheiro nunca esteve nela
    const c = (await conferir(turno)).contagem
    expect(c.devolvidoEletronicoCents).toBe(2 * FACE)
    expect(c.devolvidoDinheiroCents).toBe(0)
    expect(c.esperadoCents,
      'o cancelamento de uma venda em pix mexeu no dinheiro físico do turno').toBe(5_000)
  }, 40_000)

  it('estorno que não sai não desfaz o cancelamento — fica gravado com nome', async (ctx) => {
    seForaDoArPula(ctx)
    const turno = await abrirCaixa(await novoPonto('ZZ ESTORNO FALHA'), 0)
    const venda = await vender({
      turnoId: turno, itens: [{ lotId: LOTE, quantidade: 1 }], forma: 'debito',
    })
    // cobrança de verdade numa loja sem Asaas configurado: o pedido de
    // estorno não tem como sair
    await sql(`UPDATE orders SET asaas_payment_id = 'pay_zz_sem_chave' WHERE id = $1`,
      [venda.pedidoId])

    const r = await cancelar(venda.pedidoId, 'passou na maquininha errada')
    expect(r.status, 'a falha do gateway derrubou o cancelamento inteiro').toBe(200)
    expect(r.corpo.estorno).toBe('falhou')
    expect(String(r.corpo.estornoErro)).toMatch(/Asaas/i)
    expect(r.corpo.aviso, 'ninguém foi avisado de que o dinheiro não voltou')
      .toMatch(/financeiro/i)

    // o ingresso morre de todo jeito: dinheiro a devolver é problema de
    // financeiro, gente entrando com ingresso estornado é problema de portão
    const ingressos = await sql(`SELECT status FROM tickets WHERE order_id = $1`, [venda.pedidoId])
    expect(ingressos.every((t: any) => t.status === 'cancelado')).toBe(true)

    const [rastro] = await sql(
      `SELECT gateway_refund, gateway_error FROM pos_sale_cancellations WHERE order_id = $1`,
      [venda.pedidoId])
    expect(rastro.gateway_refund).toBe('falhou')
    expect(rastro.gateway_error, 'a falha do estorno não deixou rastro nenhum').toBeTruthy()
  }, 40_000)

  it('venda pela internet não é desfeita pelo guichê', async (ctx) => {
    seForaDoArPula(ctx)
    const [online] = await sql(
      `INSERT INTO orders (org_id, event_id, code, status, channel, face_cents,
                           platform_cents, total_cents, payment_method, paid_at)
       VALUES ($1,$2,$3,'pago','online',$4,0,$4,'pix', now())
       RETURNING id`,
      [ORG, EVENTO, `ZZWEB${Date.now().toString(36).toUpperCase()}`, FACE])

    const r = await cancelar(online.id, 'cliente ligou pedindo estorno')
    expect(r.status, 'o guichê desfez uma venda da internet').toBe(422)
    expect(String(r.corpo.message ?? r.corpo.statusMessage)).toMatch(/guichê/i)

    const [pedido] = await sql(`SELECT status FROM orders WHERE id = $1`, [online.id])
    expect(pedido.status).toBe('pago')
  }, 30_000)

  it('venda de outra produtora não é alcançada pelo id no corpo', async (ctx) => {
    seForaDoArPula(ctx)

    // o middleware cerca o `:id` da URL; o pedido vem no CORPO — é esta a
    // forma exata do furo que um dia abriu o check-in entre produtoras
    const r = await cancelar(PEDIDO_VIZINHO, 'tentativa de alcançar a vizinha')
    expect(r.status, 'cancelou a venda de outra produtora').toBe(404)

    const [pedido] = await sql(
      `SELECT status, refunded_cents FROM orders WHERE id = $1`, [PEDIDO_VIZINHO])
    expect(pedido.status, 'a venda da vizinha foi mexida').toBe('pago')
    expect(Number(pedido.refunded_cents)).toBe(0)
  }, 30_000)

  /*
   * Devolução PARCIAL não é venda cancelada.
   *
   * Esta frase só ficou alcançável quando a lista de vendas do turno passou a
   * mostrar pedido VIVO: antes, o `WHERE status = 'pago'` escondia o parcial
   * da tela, e com ele o botão de cancelar. Descoberto o botão, a recusa
   * respondia "Esta venda já foi cancelada" — porque o teste era
   * `status.startsWith('estornado')`, que casa `estornado` e
   * `estornado_parcial` de uma vez. O operador ia embora achando que o
   * cliente recebeu tudo de volta, com o dinheiro na gaveta.
   *
   * O que este caso tranca não é a recusa (essa continua certa: o guichê não
   * desfaz venda com devolução no meio) — é a HONESTIDADE dela.
   */
  it('devolução parcial não é "já cancelada": a recusa diz quanto voltou', async (ctx) => {
    seForaDoArPula(ctx)

    const ponto = await novoPonto('Guichê da devolução parcial')
    const turno = await abrirCaixa(ponto)
    const venda = await vender({
      turnoId: turno, forma: 'dinheiro', itens: [{ lotId: LOTE, quantidade: 1 }],
    })

    // o gateway devolveu PARTE: é o que o webhook grava num reembolso parcial
    const DEVOLVIDO = 500
    await sql(
      `UPDATE orders SET status = 'estornado_parcial', refunded_cents = $2 WHERE id = $1`,
      [venda.pedidoId, DEVOLVIDO])

    const r = await cancelar(venda.pedidoId, 'cliente voltou no guichê')
    expect(r.status).toBe(409)

    // U+00A0: `toLocaleString` separa o R$ com espaço fino, e comparar sem
    // normalizar falha com as duas strings idênticas na tela
    const frase = String(r.corpo.message ?? r.corpo.statusMessage).replace(/ /g, ' ')

    expect(frase, 'a recusa continua dizendo que a venda foi cancelada')
      .not.toMatch(/já foi cancelada/i)
    // os DOIS valores: o que voltou pro cliente e o que ficou com a produtora
    expect(frase).toContain('R$ 5,00')
    expect(frase).toContain(`R$ ${((FACE - DEVOLVIDO) / 100).toFixed(2).replace('.', ',')}`)

    // e a recusa é recusa de verdade: nada mexeu no pedido
    const [depois] = await sql(
      `SELECT status, refunded_cents FROM orders WHERE id = $1`, [venda.pedidoId])
    expect(depois.status).toBe('estornado_parcial')
    expect(Number(depois.refunded_cents)).toBe(DEVOLVIDO)
  }, 30_000)

  /*
   * O estorno TOTAL continua sendo "já cancelada" — senão o conserto de cima
   * vira o defeito espelhado, com o guichê deixando de reconhecer a venda que
   * de fato foi desfeita.
   */
  it('estorno TOTAL continua sendo "já cancelada"', async (ctx) => {
    seForaDoArPula(ctx)

    const ponto = await novoPonto('Guichê da devolução total')
    const turno = await abrirCaixa(ponto)
    const venda = await vender({
      turnoId: turno, forma: 'dinheiro', itens: [{ lotId: LOTE, quantidade: 1 }],
    })
    await sql(
      `UPDATE orders SET status = 'estornado', refunded_cents = $2 WHERE id = $1`,
      [venda.pedidoId, FACE])

    const r = await cancelar(venda.pedidoId, 'segunda tentativa')
    expect(r.status).toBe(409)
    expect(String(r.corpo.message ?? r.corpo.statusMessage)).toMatch(/já foi cancelada/i)
  }, 30_000)
})
