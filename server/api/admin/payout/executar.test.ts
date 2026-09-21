/**
 * Teste da EXECUÇÃO DA FILA DE SAQUE — o único caminho do sistema em que o
 * dinheiro SAI da conta da plataforma.
 *
 * `saque.test.ts` prova o teto: quanto o produtor pode pedir. Este prova o que
 * acontece depois do pedido, e o defeito que ele persegue é um só: **transferir
 * duas vezes**. Cobrança errada se estorna; transferência errada vira ligação
 * pedindo o dinheiro de volta.
 *
 * Os casos que importam, e por que cada um existe:
 *
 *  1. **Duas execuções na mesma linha.** A reivindicação é um `UPDATE ... WHERE
 *     status = 'solicitada' RETURNING`; quem chega depois volta com zero linhas.
 *     Forçado com DUAS CONEXÕES do pool, não com dois `fetch`: dois `fetch` não
 *     chegam juntos no servidor de dev — o primeiro já gravou quando o segundo
 *     lê, e o caso fica VERDE com a trava arrancada (já aconteceu neste projeto,
 *     ver o cabeçalho de `utils/saque.ts`).
 *
 *  2. **A chave de idempotência sai no corpo.** Sem `externalReference` não
 *     existe como perguntar ao gateway "esta transferência já saiu?", e toda
 *     retentativa depois de um timeout vira um segundo pagamento.
 *
 *  3. **Transferência que já existe é ADOTADA, não recriada.**
 *
 *  4. **Consulta que falha não vira transferência nova.** Sem saber se existe,
 *     criar é a aposta que paga duas vezes.
 *
 *  5. **A referência é conferida na LINHA, não no filtro.** Um parâmetro que o
 *     gateway não conhece é ignorado em silêncio e a resposta volta com as
 *     transferências de todo mundo.
 *
 * Fixture própria (duas organizações, ids fixos), apagada no fim. Nenhum
 * centavo do evento semeado é tocado.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const BASE = process.env.BASE_TESTE ?? 'http://localhost:3100'

const ORG = '0000f021-0000-4000-8000-000000000001'
const ORG_VIZINHA = '0000f021-0000-4000-8000-000000000002'
const USUARIO = '0000f021-0000-4000-8000-000000000003'
const EVENTO = '0000f021-0000-4000-8000-000000000004'
const EMAIL = 'dono.payout@teste.invalido'

/** chave PIX de teste — e-mail, que `tipoDeChavePix` reconhece sem ambiguidade */
const CHAVE_PIX = 'zz.payout@teste.invalido'

let noAr = false
let cookie = ''

async function sql(texto: string, par: any[] = []) {
  const { q } = await import('../../../utils/db')
  return q<any>(texto, par)
}

const comSessao = (rota: string, init: RequestInit = {}) =>
  fetch(`${BASE}${rota}`, {
    ...init,
    headers: { 'content-type': 'application/json', cookie, origin: BASE, ...(init.headers ?? {}) },
  })

/** roda a fila pela rota de verdade */
async function executarFila(corpo: Record<string, unknown> = {}) {
  const r = await comSessao('/api/admin/payout/executar', {
    method: 'POST', body: JSON.stringify(corpo),
  })
  const json = await r.json().catch(() => ({}))
  return { status: r.status, corpo: json, mensagem: json.statusMessage ?? json.message ?? '' }
}

let sequencia = 0
/** cria um saque 'solicitada' e devolve o id */
async function criarPayout(opts: {
  orgId?: string; valorCents?: number; destino?: string; destinoTipo?: 'pix' | 'conta'
  eventoId?: string | null
} = {}): Promise<string> {
  const r = await sql(
    `INSERT INTO payouts (org_id, event_id, code, beneficiary_name, destination_kind, destination,
                          amount_cents, status)
     VALUES ($1,$6,$2,'ZZ Beneficiario Payout',$3,$4,$5,'solicitada')
     RETURNING id`,
    [opts.orgId ?? ORG, `ZZ-PAY-${Date.now().toString(36)}-${++sequencia}`,
     opts.destinoTipo ?? 'pix', opts.destino ?? CHAVE_PIX, opts.valorCents ?? 9_000,
     opts.eventoId ?? null])
  return r[0].id
}

/** quanto deste evento ainda conta como comprometido em saque */
async function comprometidoDoEvento(eventoId: string): Promise<number> {
  const { db } = await import('../../../utils/db')
  const { saldoParaSaque } = await import('../../../utils/saque')
  const c = await db().connect()
  try {
    return (await saldoParaSaque(c, eventoId)).comprometidoCents
  } finally {
    await c.query('ROLLBACK').catch(() => {})
    c.release()
  }
}

async function lerPayout(id: string) {
  const r = await sql(
    `SELECT status, attempts, asaas_transfer_id, gateway_status, idempotency_key, error,
            claimed_at, processed_at
       FROM payouts WHERE id = $1`, [id])
  return r[0]
}

async function limparFila() {
  await sql(`DELETE FROM payouts WHERE org_id IN ($1,$2)`, [ORG, ORG_VIZINHA])
}

/**
 * Gateway de mentira no lugar do `fetch` global — é assim que dá pra exercitar
 * o executor inteiro (inclusive a busca pela chave) sem mandar dinheiro pra
 * lugar nenhum. Devolve as chamadas pra o teste poder afirmar o que NÃO foi
 * chamado, que aqui é mais importante que o que foi.
 */
function fingirGateway(
  responder: (metodo: string, url: string, corpo: any) => any,
) {
  const original = globalThis.fetch
  const chamadas: { metodo: string; url: string; corpo: any }[] = []
  globalThis.fetch = (async (url: any, init: any = {}) => {
    const metodo = String(init?.method ?? 'GET').toUpperCase()
    const corpo = init?.body ? JSON.parse(init.body) : null
    chamadas.push({ metodo, url: String(url), corpo })
    const saida = responder(metodo, String(url), corpo)
    if (saida instanceof Error) throw saida
    return new Response(JSON.stringify(saida ?? {}), {
      status: 200, headers: { 'content-type': 'application/json' },
    })
  }) as any
  return {
    chamadas,
    posts: () => chamadas.filter((c) => c.metodo === 'POST'),
    restaurar: () => { globalThis.fetch = original },
  }
}

const CFG_FALSA = { apiKey: '$aact_hmlg_zzteste', environment: 'sandbox' as const }

beforeAll(async () => {
  try {
    noAr = (await fetch(`${BASE}/api/auth/eu`, { signal: AbortSignal.timeout(2500) })).status < 500
  } catch { noAr = false }

  await sql(`INSERT INTO organizations (id, name, slug)
             VALUES ($1,'ZZ PAYOUT TESTE','zz-payout-teste')
             ON CONFLICT (id) DO NOTHING`, [ORG])
  await sql(`INSERT INTO organizations (id, name, slug)
             VALUES ($1,'ZZ PAYOUT VIZINHA','zz-payout-vizinha')
             ON CONFLICT (id) DO NOTHING`, [ORG_VIZINHA])

  // Nenhuma das duas tem chave do Asaas: pela rota, a execução anda pelo
  // gateway simulado (PAGAMENTO_SIMULADO=1), que é o mesmo arranjo do checkout.
  await sql(`UPDATE organizations SET asaas_api_key = NULL WHERE id IN ($1,$2)`,
    [ORG, ORG_VIZINHA])

  // Evento próprio: o teto de saque (`saldoParaSaque`) só enxerga saque com
  // `event_id`, e é nele que se mede se um saque dado como falho devolveu o
  // dinheiro pro produtor pedir de novo.
  await sql(
    `INSERT INTO events (id, org_id, name, slug, status, starts_at, ends_at)
     VALUES ($1,$2,'ZZ Evento Payout','zz-evento-payout','encerrado',
             now() - interval '40 days', now() - interval '39 days')
     ON CONFLICT (id) DO NOTHING`, [EVENTO, ORG])

  await sql(
    `INSERT INTO users (id, org_id, name, email, password_hash, role)
     SELECT $1, $2, 'Dono Payout Teste', $3, password_hash, 'master'
       FROM users WHERE email = 'dono@fazendapark.com.br'
     ON CONFLICT (id) DO NOTHING`, [USUARIO, ORG, EMAIL])

  if (noAr) {
    const r = await fetch(`${BASE}/api/auth/entrar`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, senha: 'diamond123' }),
    })
    cookie = (r.headers.getSetCookie?.() ?? [])
      .map((c) => c.split(';')[0]).find((c) => c.startsWith('dt_sessao=')) ?? ''
  }

  await limparFila()
}, 30_000)

afterAll(async () => {
  await sql(`DELETE FROM organizations WHERE id IN ($1,$2)`, [ORG, ORG_VIZINHA])
})

describe('execução da fila de saque', () => {
  /* ------------------------------------------------ 1. a trava de verdade */

  /**
   * O caso que justifica o arquivo. Ver o comentário do topo: dois `fetch` não
   * provam nada aqui, então a ordem é forçada na mão em duas conexões do pool,
   * rodando EXATAMENTE a linha que a rota roda (`reivindicarPayout`).
   */
  it('duas execuções na mesma linha: só uma leva o saque', async () => {
    const id = await criarPayout({ valorCents: 9_000 })
    const { db } = await import('../../../utils/db')
    const { reivindicarPayout } = await import('../../../utils/asaas')

    const c1 = await db().connect()
    const c2 = await db().connect()
    try {
      await c1.query('BEGIN')
      await c2.query('BEGIN')

      // A pega a linha e NÃO confirma ainda — é o intervalo em que a segunda
      // execução chegaria no mundo real.
      const levouA = await reivindicarPayout(c1, id, ORG)
      expect(levouA, 'a primeira execução não conseguiu reivindicar o saque').toBeTruthy()

      // B tenta a mesma linha e fica pendurado: a promessa não resolve enquanto
      // A não terminar. É isso que o teste precisa provar.
      let bTerminou = false
      let levouB: any = 'nao-rodou'
      const bEsperando = reivindicarPayout(c2, id, ORG)
        .then((r) => { bTerminou = true; levouB = r })
        // falha de asserção antes do COMMIT solta a trava e resolve esta
        // promessa sozinha; sem o catch isso vira rejeição solta e derruba o
        // processo do vitest em vez de mostrar a falha.
        .catch(() => { bTerminou = true; levouB = 'erro' })

      await new Promise((r) => setTimeout(r, 400))
      expect(bTerminou,
        'a segunda execução reivindicou sem esperar — a trava não está segurando').toBe(false)

      await c1.query('COMMIT')
      await bEsperando

      expect(levouB,
        'as DUAS execuções levaram o mesmo saque: o produtor receberia duas vezes').toBeNull()
      await c2.query('ROLLBACK')
    } finally {
      // ROLLBACK antes de devolver ao pool, SEMPRE: `release()` não desfaz
      // transação aberta, e o caso seguinte travaria até o timeout apontando
      // pro lugar errado.
      await c1.query('ROLLBACK').catch(() => {})
      await c2.query('ROLLBACK').catch(() => {})
      c1.release()
      c2.release()
    }

    const linha = await lerPayout(id)
    expect(linha.status).toBe('processando')
    expect(Number(linha.attempts),
      'a mesma linha foi reivindicada duas vezes — duas transferências sairiam dela').toBe(1)
    expect(linha.idempotency_key,
      'reivindicou sem fixar a chave de idempotência: a retentativa viraria pagamento novo')
      .toBe(`payout_${id}`)
  }, 30_000)

  it('a chave de idempotência é fixada uma vez e não muda na retentativa', async () => {
    const id = await criarPayout()
    const { db } = await import('../../../utils/db')
    const { reivindicarPayout, SQL_PAYOUT_DE_VOLTA_NA_FILA } = await import('../../../utils/asaas')
    const pool = db()

    await reivindicarPayout(pool, id, ORG)
    const primeira = (await lerPayout(id)).idempotency_key

    // devolve pra fila, como faz uma falha de gateway, e reivindica de novo
    await pool.query(SQL_PAYOUT_DE_VOLTA_NA_FILA, [id, 'erro de teste'])
    await reivindicarPayout(pool, id, ORG)
    const segunda = await lerPayout(id)

    expect(segunda.idempotency_key,
      'a chave mudou entre as tentativas — isso não é idempotência, é um pagamento novo por tentativa')
      .toBe(primeira)
    expect(Number(segunda.attempts), 'a segunda tentativa não foi contada').toBe(2)
  }, 20_000)

  /**
   * O `COALESCE` da reivindicação, exercitado de verdade.
   *
   * Sem uma chave ALHEIA gravada antes, o teste acima não mede nada: a chave
   * canônica é função pura do id, então trocar `COALESCE(idempotency_key, $3)`
   * por `$3` deixa o valor idêntico e a suíte verde (medido — a mutação
   * sobreviveu). O que o COALESCE protege é a chave que já foi ao gateway e
   * NÃO é a canônica: conserto na mão, migração, um webhook que a gravou.
   * Reescrever essa é perguntar ao gateway por uma transferência que ele
   * guardou com outro nome — ele responde "não existe" e a retentativa
   * transfere de novo.
   */
  it('a chave que já foi ao gateway não é reescrita pela reivindicação', async () => {
    const id = await criarPayout()
    const { db } = await import('../../../utils/db')
    const { reivindicarPayout } = await import('../../../utils/asaas')
    const pool = db()

    const chaveAntiga = `payout_legado_${id}`
    await pool.query(`UPDATE payouts SET idempotency_key = $2 WHERE id = $1`, [id, chaveAntiga])

    await reivindicarPayout(pool, id, ORG)

    expect((await lerPayout(id)).idempotency_key,
      'a reivindicação trocou a chave que já tinha ido ao gateway — perguntar pela nova devolve '
      + '"não existe" e a retentativa paga de novo').toBe(chaveAntiga)
  }, 20_000)

  it('o saque de outra organização não é reivindicado nem com o id na mão', async () => {
    const idVizinho = await criarPayout({ orgId: ORG_VIZINHA })
    const { db } = await import('../../../utils/db')
    const { reivindicarPayout } = await import('../../../utils/asaas')

    const levou = await reivindicarPayout(db(), idVizinho, ORG)
    expect(levou,
      'uma produtora reivindicou o saque da outra — o dinheiro sairia pra conta errada').toBeNull()
    expect((await lerPayout(idVizinho)).status).toBe('solicitada')
  }, 20_000)

  /* ------------------------------------ 2. a chave que vai pro gateway */

  it('o corpo mandado ao gateway carrega a chave de idempotência', async () => {
    const id = await criarPayout({ valorCents: 12_345 })
    const { db } = await import('../../../utils/db')
    const { executarPayoutReivindicado, reivindicarPayout, transferidorAsaas } =
      await import('../../../utils/asaas')

    const payout = await reivindicarPayout(db(), id, ORG)
    const g = fingirGateway((metodo, url) =>
      metodo === 'GET' && url.includes('/transfers')
        ? { data: [] }
        : { id: 'tr_zz_1', status: 'DONE' })
    try {
      await executarPayoutReivindicado(db(), payout, transferidorAsaas(CFG_FALSA))
    } finally { g.restaurar() }

    const post = g.posts()[0]
    expect(post, 'não chamou o gateway').toBeTruthy()
    expect(post.url, 'não bateu no endpoint de transferência').toContain('/transfers')
    expect(post.corpo.externalReference,
      'a transferência saiu SEM chave de idempotência: depois de um timeout ninguém consegue '
      + 'perguntar ao gateway se ela já existe, e a retentativa paga de novo')
      .toBe(`payout_${id}`)
    // e o valor vai em REAIS, que é o que o gateway fala
    expect(post.corpo.value, 'mandou centavo onde o gateway espera real').toBe(123.45)
    expect(post.corpo.pixAddressKeyType, 'mandou a chave sem dizer o tipo').toBe('EMAIL')

    const linha = await lerPayout(id)
    expect(linha.status).toBe('concluida')
    expect(linha.asaas_transfer_id).toBe('tr_zz_1')
    expect(linha.gateway_status).toBe('DONE')
  }, 20_000)

  it('transferência que já existe no gateway é adotada, não criada de novo', async () => {
    const id = await criarPayout()
    const { db } = await import('../../../utils/db')
    const { executarPayoutReivindicado, reivindicarPayout, transferidorAsaas } =
      await import('../../../utils/asaas')

    const payout = await reivindicarPayout(db(), id, ORG)
    // o gateway JÁ tem a transferência desta chave — é o que acontece quando a
    // primeira execução transferiu e morreu antes de gravar a resposta
    const g = fingirGateway((metodo) =>
      metodo === 'GET'
        ? { data: [{ id: 'tr_ja_existia', status: 'DONE', externalReference: `payout_${id}` }] }
        : { id: 'tr_DUPLICADA', status: 'DONE' })
    try {
      await executarPayoutReivindicado(db(), payout, transferidorAsaas(CFG_FALSA))
    } finally { g.restaurar() }

    expect(g.posts().length,
      'criou uma SEGUNDA transferência de um saque que o gateway já tinha — pagamento duplicado')
      .toBe(0)
    const linha = await lerPayout(id)
    expect(linha.asaas_transfer_id, 'adotou a transferência errada').toBe('tr_ja_existia')
    expect(linha.status).toBe('concluida')
  }, 20_000)

  /**
   * O gateway ignora em silêncio o parâmetro que não conhece: a consulta volta
   * com as transferências de TODO mundo. Daí saem DOIS jeitos de perder
   * dinheiro, e o segundo é o caro:
   *
   * 1. adotar a primeira da lista dá este saque por pago com a transferência
   *    de outro produtor — o dinheiro deste nunca sairia;
   * 2. **não achar a nossa e concluir "não existe"** — que é o que estava
   *    escrito aqui. Se o filtro foi ignorado, a lista é uma janela da conta
   *    inteira e a nossa transferência pode estar fora dela (a conta atende
   *    outros sistemas; a retentativa pode ser dias depois da transferência
   *    que se perdeu na resposta). Criar a partir daí é exatamente o pagamento
   *    duplo que a chave de idempotência existe pra impedir.
   *
   * A prova de que o filtro não foi aplicado está na própria resposta: com ele
   * aplicado, toda linha carrega a chave pedida. Linha com outra referência =
   * resposta inconclusiva, e a parede 3 diz que sem "não existe" CLARO não se
   * cria. Lista VAZIA continua sendo um "não existe" claro — é o caso dos
   * outros testes deste arquivo, e lá a transferência sai normalmente.
   */
  it('lista que veio sem o filtro aplicado não vira transferência nova', async () => {
    const id = await criarPayout()
    const { db } = await import('../../../utils/db')
    const { executarPayoutReivindicado, reivindicarPayout, transferidorAsaas } =
      await import('../../../utils/asaas')

    const payout = await reivindicarPayout(db(), id, ORG)
    const g = fingirGateway((metodo) =>
      metodo === 'GET'
        ? { data: [
            { id: 'tr_de_outro', status: 'DONE', externalReference: 'payout_de-outro-produtor' },
            { id: 'tr_de_outro_2', status: 'DONE', externalReference: null },
          ] }
        : { id: 'tr_minha', status: 'DONE' })
    try {
      await executarPayoutReivindicado(db(), payout, transferidorAsaas(CFG_FALSA))
    } finally { g.restaurar() }

    expect(g.posts().length,
      'o gateway devolveu a lista de todo mundo (prova de que ignorou o filtro) e mesmo assim '
      + 'transferiu: se a nossa transferência já tivesse saído e estivesse fora da janela, '
      + 'esta seria a segunda').toBe(0)

    const linha = await lerPayout(id)
    expect(linha.asaas_transfer_id,
      'adotou a transferência de outro produtor — este saque ficaria pago sem nada ter saído')
      .toBeNull()
    expect(linha.status, 'perdeu o saque em vez de devolver pra fila').toBe('solicitada')
    expect(String(linha.error), 'devolveu pra fila sem dizer ao operador o que houve')
      .toContain('filtro não foi aplicado')
  }, 20_000)

  it('lista VAZIA continua sendo um "não existe" claro e a transferência sai', async () => {
    const id = await criarPayout()
    const { db } = await import('../../../utils/db')
    const { executarPayoutReivindicado, reivindicarPayout, transferidorAsaas } =
      await import('../../../utils/asaas')

    const payout = await reivindicarPayout(db(), id, ORG)
    const g = fingirGateway((metodo) =>
      metodo === 'GET' ? { data: [] } : { id: 'tr_primeira', status: 'DONE' })
    try {
      await executarPayoutReivindicado(db(), payout, transferidorAsaas(CFG_FALSA))
    } finally { g.restaurar() }

    expect(g.posts().length,
      'travou o saque de quem nunca teve transferência nenhuma — a fila nunca andaria').toBe(1)
    expect((await lerPayout(id)).status).toBe('concluida')
  }, 20_000)

  /* ------------------------------------------- 3. o que dá errado no meio */

  it('consulta que falha NÃO vira transferência nova — volta pra fila com o erro', async () => {
    const id = await criarPayout()
    const { db } = await import('../../../utils/db')
    const { executarPayoutReivindicado, reivindicarPayout, transferidorAsaas } =
      await import('../../../utils/asaas')

    const payout = await reivindicarPayout(db(), id, ORG)
    const g = fingirGateway((metodo) => {
      if (metodo === 'GET') return { errors: [{ description: 'gateway fora do ar' }] }
      return { id: 'tr_no_escuro', status: 'DONE' }
    })
    try {
      await executarPayoutReivindicado(db(), payout, transferidorAsaas(CFG_FALSA))
    } finally { g.restaurar() }

    expect(g.posts().length,
      'transferiu sem saber se a transferência já existia — é assim que se paga duas vezes').toBe(0)

    const linha = await lerPayout(id)
    expect(linha.status, 'perdeu o saque em vez de devolver pra fila').toBe('solicitada')
    expect(String(linha.error), 'devolveu pra fila sem dizer o que houve').toContain('fora do ar')
    expect(Number(linha.attempts), 'não contou a tentativa').toBe(1)
  }, 20_000)

  it('gateway que recusa deixa o saque retentável, com o erro escrito', async () => {
    const id = await criarPayout()
    const { db } = await import('../../../utils/db')
    const { executarPayoutReivindicado, reivindicarPayout, transferidorAsaas } =
      await import('../../../utils/asaas')

    const payout = await reivindicarPayout(db(), id, ORG)
    const g = fingirGateway((metodo) => metodo === 'GET'
      ? { data: [] }
      : { errors: [{ description: 'Saldo insuficiente' }] })
    try {
      await executarPayoutReivindicado(db(), payout, transferidorAsaas(CFG_FALSA))
    } finally { g.restaurar() }

    const linha = await lerPayout(id)
    expect(linha.status, 'a recusa do gateway apagou o saque da fila').toBe('solicitada')
    expect(String(linha.error)).toContain('Saldo insuficiente')
    expect(linha.asaas_transfer_id, 'guardou id de transferência que não existe').toBeNull()
  }, 20_000)

  it('linha que já tem transferência no gateway NUNCA volta pra fila', async () => {
    const id = await criarPayout()
    const { db } = await import('../../../utils/db')
    const { SQL_PAYOUT_DE_VOLTA_NA_FILA, SQL_PAYOUT_EM_VOO, reivindicarPayout } =
      await import('../../../utils/asaas')
    const pool = db()

    await reivindicarPayout(pool, id, ORG)
    await pool.query(SQL_PAYOUT_EM_VOO, [id, 'tr_em_voo', 'BANK_PROCESSING'])

    const { rows } = await pool.query(SQL_PAYOUT_DE_VOLTA_NA_FILA, [id, 'tentando de novo'])
    expect(rows.length,
      'devolveu pra fila um saque que já tem transferência no gateway — sairia de novo').toBe(0)
    expect((await lerPayout(id)).status).toBe('processando')
  }, 20_000)

  it('depois do teto de tentativas o saque falha com o erro, e não some', async () => {
    const id = await criarPayout()
    const { db } = await import('../../../utils/db')
    const { MAX_TENTATIVAS, executarPayoutReivindicado, reivindicarPayout, transferidorAsaas } =
      await import('../../../utils/asaas')
    const pool = db()

    await pool.query(`UPDATE payouts SET attempts = $2 WHERE id = $1`, [id, MAX_TENTATIVAS - 1])
    const payout = await reivindicarPayout(pool, id, ORG)
    const g = fingirGateway((metodo) => metodo === 'GET'
      ? { data: [] }
      : { errors: [{ description: 'chave pix inexistente' }] })
    try {
      await executarPayoutReivindicado(pool, payout, transferidorAsaas(CFG_FALSA))
    } finally { g.restaurar() }

    const linha = await lerPayout(id)
    expect(linha.status, 'ficou retentando pra sempre uma transferência que nunca vai sair')
      .toBe('falhou')
    expect(String(linha.error)).toContain('chave pix inexistente')
    expect(String(linha.error), 'não disse que a transferência não foi feita')
      .toContain('não foi feita')
  }, 20_000)

  /**
   * O teto de tentativas não pode ser aplicado no escuro.
   *
   * `'falhou'` não é rótulo de tela: `saldoParaSaque` conta como comprometido
   * só `solicitada`, `processando` e `concluida`. Carimbar 'falhou' DEVOLVE o
   * valor pro disponível do produtor — e o saque que ele pede em seguida é
   * outra linha, com outro id e portanto **outra chave de idempotência**. O
   * gateway não tem como ligar uma na outra, e a segunda transferência sai
   * inteira.
   *
   * Aqui o gateway está mudo: não dá pra saber se a transferência da tentativa
   * que se perdeu saiu ou não. Desistir nesse estado é liberar dinheiro que
   * pode já estar na conta do produtor.
   */
  it('teto batido sem resposta do gateway NÃO libera o dinheiro pra ser sacado de novo',
    async () => {
      const id = await criarPayout({ valorCents: 9_000, eventoId: EVENTO })
      const { db } = await import('../../../utils/db')
      const { MAX_TENTATIVAS, executarPayoutReivindicado, reivindicarPayout, transferidorAsaas } =
        await import('../../../utils/asaas')
      const pool = db()

      expect(await comprometidoDoEvento(EVENTO),
        'a fixture não entrou no teto de saque — o teste não provaria nada').toBe(9_000)

      await pool.query(`UPDATE payouts SET attempts = $2 WHERE id = $1`, [id, MAX_TENTATIVAS - 1])
      const payout = await reivindicarPayout(pool, id, ORG)

      // Gateway MUDO: a conexão cai antes de qualquer resposta. É o caso em que
      // a transferência pode ter saído e só a resposta ter se perdido.
      const g = fingirGateway(() => new Error('socket hang up'))
      try {
        await executarPayoutReivindicado(pool, payout, transferidorAsaas(CFG_FALSA))
      } finally { g.restaurar() }

      const linha = await lerPayout(id)
      expect(linha.status,
        'deu o saque por falho sem o gateway ter dito que não transferiu: o valor volta pro '
        + 'disponível e o próximo pedido sai com OUTRA chave de idempotência — a transferência '
        + 'duplicada entra por aqui').not.toBe('falhou')
      expect(String(linha.error), 'desistiu sem deixar escrito o que o operador tem de conferir')
        .toContain('sem resposta do gateway')
      expect(await comprometidoDoEvento(EVENTO),
        'o dinheiro deixou de contar como comprometido — o produtor pede o mesmo saque de novo')
        .toBe(9_000)
      await limparFila()
    }, 30_000)

  it('recusa escrita do gateway no teto ainda encerra o saque, com o saldo devolvido',
    async () => {
      const id = await criarPayout({ valorCents: 7_000, eventoId: EVENTO })
      const { db } = await import('../../../utils/db')
      const { MAX_TENTATIVAS, executarPayoutReivindicado, reivindicarPayout, transferidorAsaas } =
        await import('../../../utils/asaas')
      const pool = db()

      await pool.query(`UPDATE payouts SET attempts = $2 WHERE id = $1`, [id, MAX_TENTATIVAS - 1])
      const payout = await reivindicarPayout(pool, id, ORG)

      // Aqui o gateway LEU o pedido e recusou com todas as letras: é certo que
      // nada saiu, então encerrar o saque devolve um dinheiro que continua na
      // plataforma.
      const g = fingirGateway((metodo) => metodo === 'GET'
        ? { data: [] }
        : { errors: [{ description: 'chave pix inexistente' }] })
      try {
        await executarPayoutReivindicado(pool, payout, transferidorAsaas(CFG_FALSA))
      } finally { g.restaurar() }

      const linha = await lerPayout(id)
      expect(linha.status,
        'ficou retentando pra sempre um destino que o gateway já disse que não existe')
        .toBe('falhou')
      expect(await comprometidoDoEvento(EVENTO),
        'prendeu o saldo de um saque que o gateway garantiu não ter transferido').toBe(0)
      await limparFila()
    }, 30_000)

  /**
   * A outra metade da decisão acima: quem encerra o saque é o DESFECHO, não o
   * contador de tentativas.
   *
   * Com `attempts < MAX_TENTATIVAS` no `WHERE` da fila, a linha que o
   * reconciliador devolveu (depois de PROVAR no gateway que nada saiu) ficava
   * 'solicitada' para sempre com o contador estourado: sem transferir, sem
   * falhar e sem aparecer em relatório nenhum — a fila invisível. O contador
   * segue valendo onde ele decide algo de verdade, que é o teto do teste
   * acima.
   */
  it('saque com o contador estourado volta pra fila em vez de congelar em silêncio', async () => {
    const id = await criarPayout()
    const { MAX_TENTATIVAS, SQL_FILA_DE_PAYOUTS } = await import('../../../utils/asaas')

    await sql(`UPDATE payouts SET attempts = $2 WHERE id = $1`, [id, MAX_TENTATIVAS + 2])

    const fila = await sql(SQL_FILA_DE_PAYOUTS, [ORG, null, 50])
    expect(fila.some((l: any) => l.id === id),
      'o saque sumiu da fila por causa do contador: fica solicitada para sempre, sem transferir, '
      + 'sem falhar e sem aparecer em lugar nenhum').toBe(true)
    await limparFila()
  }, 20_000)

  it('chave PIX irreconhecível morre na hora, com frase de guichê', async () => {
    const id = await criarPayout({ destino: '1234' })
    const { db } = await import('../../../utils/db')
    const { executarPayoutReivindicado, reivindicarPayout, transferidorAsaas } =
      await import('../../../utils/asaas')

    const payout = await reivindicarPayout(db(), id, ORG)
    const g = fingirGateway((metodo) => metodo === 'GET' ? { data: [] } : { id: 'tr_x', status: 'DONE' })
    try {
      await executarPayoutReivindicado(db(), payout, transferidorAsaas(CFG_FALSA))
    } finally { g.restaurar() }

    expect(g.posts().length, 'mandou pro gateway uma chave que ninguém conseguiu ler').toBe(0)
    const linha = await lerPayout(id)
    expect(linha.status, 'vai retentar pra sempre um cadastro que não melhora sozinho').toBe('falhou')
    expect(String(linha.error), 'recusou sem dizer ao operador o que arrumar').toMatch(/\+55/)
  }, 20_000)

  /* ------------------------------------- 4. execução interrompida no meio */

  it('execução interrompida sem transferência volta pra fila; com transferência, é adotada',
    async () => {
      const { db } = await import('../../../utils/db')
      const {
        MINUTOS_DE_CARENCIA, SQL_PAYOUTS_PRESOS, reconciliarPayoutPreso, reivindicarPayout,
        transferidorAsaas,
      } = await import('../../../utils/asaas')
      const pool = db()

      const idSemTransferencia = await criarPayout()
      const idComTransferencia = await criarPayout()
      await reivindicarPayout(pool, idSemTransferencia, ORG)
      await reivindicarPayout(pool, idComTransferencia, ORG)
      // envelhece a reivindicação pra passar da carência
      await pool.query(
        `UPDATE payouts SET claimed_at = now() - interval '1 hour' WHERE id IN ($1,$2)`,
        [idSemTransferencia, idComTransferencia])

      const presos = await sql(SQL_PAYOUTS_PRESOS, [ORG, MINUTOS_DE_CARENCIA, 10])
      expect(presos.length, 'não enxergou as execuções interrompidas').toBe(2)

      const g = fingirGateway((metodo, url) => {
        if (metodo !== 'GET') return new Error('reconciliação não pode CRIAR transferência')
        return url.includes(`payout_${idComTransferencia}`)
          ? { data: [{ id: 'tr_achada', status: 'DONE', externalReference: `payout_${idComTransferencia}` }] }
          : { data: [] }
      })
      try {
        for (const preso of presos) {
          await reconciliarPayoutPreso(pool, preso, transferidorAsaas(CFG_FALSA))
        }
      } finally { g.restaurar() }

      expect(g.posts().length, 'a reconciliação criou transferência nova').toBe(0)

      const semTr = await lerPayout(idSemTransferencia)
      expect(semTr.status,
        'deixou preso em processando um saque que o gateway nem conhece').toBe('solicitada')

      const comTr = await lerPayout(idComTransferencia)
      expect(comTr.status,
        'não adotou a transferência que já tinha saído — ela sairia de novo').toBe('concluida')
      expect(comTr.asaas_transfer_id).toBe('tr_achada')
    }, 30_000)

  /* ------------------------------------- 5. o desfecho de quem já saiu */

  /**
   * PIX no Asaas quase nunca volta `DONE` na primeira resposta — vem `PENDING`
   * ou `BANK_PROCESSING`. Sem conferir depois, o saque ficaria 'processando'
   * pra sempre: o dinheiro na conta do produtor e o painel dizendo "em
   * andamento" até alguém abrir o site do gateway pra ver.
   */
  it('transferência em processamento vira concluída quando o banco confirma', async () => {
    const id = await criarPayout({ valorCents: 8_000 })
    const { db } = await import('../../../utils/db')
    const { SQL_PAYOUTS_EM_VOO, SQL_PAYOUT_EM_VOO, conferirPayoutEmVoo, reivindicarPayout,
      transferidorAsaas } = await import('../../../utils/asaas')
    const pool = db()

    await reivindicarPayout(pool, id, ORG)
    await pool.query(SQL_PAYOUT_EM_VOO, [id, 'tr_voando', 'BANK_PROCESSING'])

    const emVoo = await sql(SQL_PAYOUTS_EM_VOO, [ORG, 10])
    expect(emVoo.some((l: any) => l.id === id),
      'não enxergou a transferência que saiu e ainda não teve desfecho').toBe(true)

    const g = fingirGateway((metodo, url) => {
      if (metodo !== 'GET') return new Error('conferência não pode criar transferência')
      return url.includes('/transfers/tr_voando') ? { id: 'tr_voando', status: 'DONE' } : { data: [] }
    })
    try {
      await conferirPayoutEmVoo(pool, emVoo.find((l: any) => l.id === id), transferidorAsaas(CFG_FALSA))
    } finally { g.restaurar() }

    const linha = await lerPayout(id)
    expect(linha.status,
      'o dinheiro caiu na conta do produtor e o painel continuou dizendo "em andamento"')
      .toBe('concluida')
    expect(linha.gateway_status).toBe('DONE')
    expect(linha.processed_at, 'concluiu sem carimbar quando').toBeTruthy()
  }, 20_000)

  it('transferência devolvida pelo banco vira falha, com o motivo do banco', async () => {
    const id = await criarPayout()
    const { db } = await import('../../../utils/db')
    const { SQL_PAYOUT_EM_VOO, conferirPayoutEmVoo, reivindicarPayout, transferidorAsaas } =
      await import('../../../utils/asaas')
    const pool = db()

    await reivindicarPayout(pool, id, ORG)
    await pool.query(SQL_PAYOUT_EM_VOO, [id, 'tr_devolvida', 'BANK_PROCESSING'])

    const g = fingirGateway(() =>
      ({ id: 'tr_devolvida', status: 'FAILED', failReason: 'Conta de destino encerrada' }))
    try {
      await conferirPayoutEmVoo(pool,
        { id, amount_cents: 9_000, destination_kind: 'pix', destination: CHAVE_PIX,
          asaas_transfer_id: 'tr_devolvida' },
        transferidorAsaas(CFG_FALSA))
    } finally { g.restaurar() }

    const linha = await lerPayout(id)
    expect(linha.status,
      'o banco devolveu o dinheiro e o saque continuou contando como comprometido').toBe('falhou')
    expect(String(linha.error), 'não guardou o motivo que o banco deu')
      .toContain('Conta de destino encerrada')
  }, 20_000)

  it('consulta que cai NÃO derruba a transferência que já saiu', async () => {
    const id = await criarPayout()
    const { db } = await import('../../../utils/db')
    const { SQL_PAYOUT_EM_VOO, conferirPayoutEmVoo, reivindicarPayout, transferidorAsaas } =
      await import('../../../utils/asaas')
    const pool = db()

    await reivindicarPayout(pool, id, ORG)
    await pool.query(SQL_PAYOUT_EM_VOO, [id, 'tr_no_ar', 'PENDING'])

    const g = fingirGateway(() => ({ errors: [{ description: 'gateway fora do ar' }] }))
    try {
      await conferirPayoutEmVoo(pool,
        { id, amount_cents: 9_000, destination_kind: 'pix', destination: CHAVE_PIX,
          asaas_transfer_id: 'tr_no_ar' },
        transferidorAsaas(CFG_FALSA))
    } finally { g.restaurar() }

    const linha = await lerPayout(id)
    expect(linha.status,
      'a consulta caiu e o saque foi dado como falho: o saldo voltaria pro produtor sacar de novo '
      + 'um dinheiro que já está na conta dele').toBe('processando')
    expect(linha.asaas_transfer_id).toBe('tr_no_ar')
  }, 20_000)

  /* ------------------------------------------------- 6. quem pode executar */

  /**
   * Esta é a única rota do sistema em que o dinheiro SAI, e ela está trancada
   * por ausência: ninguém classificou `/api/admin/payout` em `papeis.ts`, e
   * rota sem área só passa pro master.
   *
   * `papeis.test.ts` já prova a REGRA geral, com um caminho inventado. O que
   * faltava era prender a regra a ESTE caminho: no dia em que alguém puser
   * `['/api/admin/payout', 'dinheiro']` na tabela de áreas — movimento
   * plausível, já que saque é dinheiro —, quem é de `financeiro` passa a mandar
   * transferência, e sem este caso nenhum teste fica vermelho.
   */
  it('a execução da fila é só do master — nenhum outro papel abre esta rota', async () => {
    const { decidirAcesso, areaDaRota } = await import('../../../utils/papeis')
    const rota = '/api/admin/payout/executar'

    expect(areaDaRota(rota),
      'alguém classificou a rota que tira dinheiro da plataforma: confira de propósito quem passou '
      + 'a poder executá-la').toBe(null)
    expect(decidirAcesso('master', rota).liberado).toBe(true)
    for (const papel of ['financeiro', 'operacao', 'portaria'] as const) {
      const d = decidirAcesso(papel, rota)
      expect(d.liberado, `${papel} pode mandar transferência`).toBe(false)
      expect(d.motivo, `a recusa para ${papel} não diz o que fazer`).toMatch(/master/)
    }
  })

  it('sem sessão a fila não executa', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    const r = await fetch(`${BASE}/api/admin/payout/executar`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE },
      body: JSON.stringify({}),
    })
    expect(r.status, 'a rota que tira dinheiro da plataforma respondeu sem login').toBe(401)
  }, 20_000)

  /* --------------------------------------------- 7. a rota, ponta a ponta */

  it('pela rota: o saque sai uma vez e a segunda execução não acha mais nada', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    expect(cookie, 'login falhou — o teste ficaria verde à toa').toBeTruthy()
    await limparFila()

    const id = await criarPayout({ valorCents: 4_500 })

    const primeira = await executarFila()
    expect(primeira.status, `a execução não respondeu — ${primeira.mensagem}`).toBe(200)
    expect(primeira.corpo.processados, 'não executou o saque que estava na fila').toBe(1)
    expect(primeira.corpo.concluidos).toBe(1)
    expect(primeira.corpo.enviadoCents).toBe(4_500)

    const depois = await lerPayout(id)
    expect(depois.status).toBe('concluida')
    expect(String(depois.asaas_transfer_id),
      'transferência de verdade num teste — o simulado carimba sim_trf_').toContain('sim_trf_')
    expect(depois.processed_at, 'concluiu sem carimbar quando').toBeTruthy()

    const segunda = await executarFila()
    expect(segunda.corpo.processados,
      'a segunda execução pegou de novo um saque já concluído').toBe(0)
    expect(Number((await lerPayout(id)).attempts),
      'o saque foi reivindicado duas vezes').toBe(1)
  }, 30_000)

  it('pela rota: a execução de uma produtora não alcança o saque da outra', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    await limparFila()

    const meu = await criarPayout({ valorCents: 1_000 })
    const dela = await criarPayout({ orgId: ORG_VIZINHA, valorCents: 7_000 })

    const r = await executarFila()
    expect(r.corpo.processados, 'não executou o próprio saque').toBe(1)

    expect((await lerPayout(meu)).status).toBe('concluida')
    const vizinho = await lerPayout(dela)
    expect(vizinho.status,
      'executou o saque de outra produtora: o dinheiro dela sairia por uma sessão que não é dela')
      .toBe('solicitada')
    expect(Number(vizinho.attempts)).toBe(0)
  }, 30_000)

  it('pela rota: saque para conta bancária não é executado nem dado como falho', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    await limparFila()

    const id = await criarPayout({
      destinoTipo: 'conta', destino: 'Banco do Brasil ag 1234 c/c 56789-0', valorCents: 33_000,
    })

    const r = await executarFila()
    expect(r.corpo.processados, 'tentou quebrar no palpite um endereço de banco em texto livre').toBe(0)
    expect(r.corpo.aguardandoManual, 'o saque sumiu do relatório da execução').toBe(1)
    expect(r.corpo.aguardandoManualCents).toBe(33_000)
    expect(String(r.corpo.mensagem).replace(/\u00a0/g, ' '),
      'não disse ao operador que este saque depende dele').toContain('R$ 330,00')

    const linha = await lerPayout(id)
    expect(linha.status,
      'marcou como falho um saque que ainda vai ser transferido na mão — o saldo voltaria pro produtor pedir de novo')
      .toBe('solicitada')
    expect(Number(linha.attempts)).toBe(0)
  }, 30_000)

  it('pela rota: o saque some da fila depois de concluído e a auditoria diz quem mandou',
    async () => {
      if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
      await limparFila()

      const id = await criarPayout({ valorCents: 2_500 })
      await executarFila({ payoutId: id })

      const registros = await sql(
        `SELECT action, actor_email, after FROM audit_log
          WHERE entity = 'payout' AND entity_id = $1 ORDER BY id DESC LIMIT 1`, [id])
      expect(registros.length, 'transferiu dinheiro sem deixar registro de quem mandou').toBe(1)
      expect(registros[0].action).toBe('transferida')
      expect(registros[0].actor_email).toBe(EMAIL)
      expect(Number(registros[0].after.valorCents)).toBe(2_500)
    }, 30_000)
})
