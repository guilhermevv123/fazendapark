/**
 * clientes.test.ts — a base de clientes: quem vê, o que vê, o que sai.
 *
 * É a lista de TODO mundo que já comprou, com CPF, telefone e endereço. O que
 * este arquivo trava não é "a lista abre", é o que ela não pode fazer:
 *
 *   · mostrar cliente de outra organização (lista, ficha e exportação);
 *   · devolver o CPF inteiro numa lista, ou o hash da senha em qualquer lugar;
 *   · deixar a busca do operador virar padrão de LIKE (`%` e `_` são texto);
 *   · exportar sem deixar rastro na auditoria, ou exportar CPF na planilha;
 *   · abrir pra quem não é o dono: financeiro, operação e portaria levam 403
 *     (a área `clientes` é só do master de propósito — ver `PODE`).
 *
 * Os filtros são conferidos um a um contra a fixture escrita à mão: "aceita
 * novidades" é consentimento (LGPD), e quem vai mandar divulgação depende de
 * ele estar exato.
 *
 * Fixture própria (ids sorteados, e-mails deste arquivo), apagada no `afterAll`.
 * Sem servidor de dev no ar, PULA.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { anunciarPulo, BASE_DE_TESTE, seForaDoArPula, sondarServidor, type Sonda } from '../../../scripts/test-setup'
import { db, q, q1 } from '../../utils/db'
import { roleLegado, type Papel } from '../../utils/papeis'

const BASE = BASE_DE_TESTE
const ORG = randomUUID()
const OUTRA_ORG = randomUUID()
const EV = randomUUID()

const EMAILS: Record<Papel, string> = {
  master: 'clientes.api.master@teste.invalido',
  financeiro: 'clientes.api.financeiro@teste.invalido',
  operacao: 'clientes.api.operacao@teste.invalido',
  portaria: 'clientes.api.portaria@teste.invalido',
}
const cookies: Partial<Record<Papel, string>> = {}
let sonda: Sonda = { noAr: false, porque: 'o beforeAll não chegou a rodar' }

/** o CPF da Ana — o teste procura por ele no que a lista devolve */
const CPF_ANA = '52998224725'
const HASH_DA_ANA = '$2a$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234'

const ids: Record<string, string> = {}

async function entrarCom(email: string): Promise<string> {
  const r = await fetch(`${BASE}/api/auth/entrar`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, senha: 'diamond123' }),
  })
  return (r.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(';')[0]).find((c) => c.startsWith('dt_sessao=')) ?? ''
}

const abrir = (rota: string, papel: Papel | null = 'master') =>
  fetch(`${BASE}${rota}`, {
    headers: papel ? { cookie: cookies[papel] ?? '', origin: BASE } : {},
  })

async function json(rota: string, papel: Papel = 'master') {
  const r = await abrir(rota, papel)
  const corpo = await r.json().catch(() => ({}))
  if (r.status !== 200) throw new Error(`${rota} respondeu ${r.status}: ${corpo.statusMessage ?? ''}`)
  return corpo
}

/** os nomes que a lista devolveu, na ordem — é o que cada filtro tem que acertar */
const nomes = async (qs: string) =>
  ((await json(`/api/admin/clientes?${qs}&ordem=nome&porPagina=100`)).itens as any[]).map((c) => c.nome)

/**
 * Apaga linha de auditoria pela única porta que o gatilho da 019 aceita.
 * `audit_log` é append-only: um `DELETE` puro leva "não pode ser apagada".
 * `SET LOCAL` morre no COMMIT, então a liberação não vaza pra próxima query.
 */
async function expurgar(onde: string, par: any[] = []) {
  const c = await db().connect()
  try {
    await c.query('BEGIN')
    await c.query(`SET LOCAL auditoria.expurgo = 'liberado'`)
    await c.query(`DELETE FROM audit_log WHERE ${onde}`, par)
    await c.query('COMMIT')
  } finally {
    try { await c.query('ROLLBACK') } catch { /* já fechou */ }
    c.release()
  }
}

let n = 0
async function pedido(cliente: string, c: {
  status?: string; total: number; estornado?: number; canal?: string; pagoHa?: number | null
}) {
  const k = ++n
  await q(
    `INSERT INTO orders (org_id, event_id, customer_id, code, status, channel, face_cents, fee_cents,
                         platform_cents, discount_cents, total_cents, refunded_cents, asaas_payment_id,
                         paid_at, payment_method)
     VALUES ($1,$2,$3,$4,$5,$6,$7,0,0,0,$7,$8,$9,
             CASE WHEN $10::int IS NULL THEN NULL ELSE now() - make_interval(days => $10::int) END,'pix')`,
    [ORG, EV, cliente, `ZZCLI-${k}-${Date.now()}`, c.status ?? 'pago', c.canal ?? 'online', c.total,
     c.estornado ?? 0, c.canal === 'bilheteria' ? null : `pay_zzcli_${k}_${Date.now()}`,
     c.pagoHa === undefined ? 1 : c.pagoHa])
}

async function novoCliente(org: string, chave: string, c: {
  nome: string; email?: string; doc?: string; fone?: string | null; insta?: string | null
  cidade?: string | null; uf?: string | null; anos?: number | null
  cadastrado?: boolean; novidades?: boolean; senha?: string | null
}) {
  ids[chave] = (await q1<any>(
    `INSERT INTO customers (org_id, name, email, document, phone, instagram, city, state, birth_date,
                            registered_at, marketing_opt_in, marketing_opt_in_at, password_hash,
                            zip_code, street, address_number, neighborhood)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,
             CASE WHEN $9::int IS NULL THEN NULL
                  ELSE (current_date - make_interval(years => $9::int, days => 10))::date END,
             CASE WHEN $10 THEN now() ELSE NULL END, $11, CASE WHEN $11 THEN now() ELSE NULL END, $12,
             CASE WHEN $7::text IS NULL THEN NULL ELSE '45000000' END,
             CASE WHEN $7::text IS NULL THEN NULL ELSE 'Rua das Flores' END,
             CASE WHEN $7::text IS NULL THEN NULL ELSE '120' END,
             CASE WHEN $7::text IS NULL THEN NULL ELSE 'Centro' END)
     RETURNING id`,
    [org, c.nome, c.email ?? `${chave}.${ORG.slice(0, 6)}@teste.invalido`,
     c.doc ?? String(Math.floor(Math.random() * 1e11)).padStart(11, '2'),
     c.fone ?? null, c.insta ?? null, c.cidade ?? null, c.uf ?? null, c.anos ?? null,
     c.cadastrado ?? false, c.novidades ?? false, c.senha ?? null]))!.id
}

beforeAll(async () => {
  sonda = await sondarServidor('/api/auth/eu')
  anunciarPulo('server/api/admin/clientes.test.ts', sonda)
  if (!sonda.noAr) return

  // Restos de uma rodada que caiu no meio: os usuários daqui têm e-mail fixo, e
  // o MESMO e-mail em duas organizações faz o login recusar (com razão) — o
  // sintoma seria 401 em tudo, longe da causa.
  const restos = `SELECT id FROM organizations WHERE slug LIKE 'zz-cliapi-%' OR slug LIKE 'zz-clifora-%'`
  await expurgar(`org_id IN (${restos})`)
  await q(`DELETE FROM orders WHERE org_id IN (${restos})`)
  await q(`DELETE FROM organizations WHERE id IN (${restos})`)

  await q(`INSERT INTO organizations (id, name, slug) VALUES ($1,'ZZ Clientes Api',$2), ($3,'ZZ Clientes Fora',$4)`,
    [ORG, `zz-cliapi-${ORG.slice(0, 8)}`, OUTRA_ORG, `zz-clifora-${OUTRA_ORG.slice(0, 8)}`])
  await q(`INSERT INTO events (id, org_id, name, slug, starts_at, ends_at, fee_bps, status)
           VALUES ($1,$2,'ZZ Evento Clientes',$3, now() + interval '5 days', now() + interval '6 days', 1000, 'ativo')`,
    [EV, ORG, `zz-cliapi-ev-${EV.slice(0, 8)}`])

  for (const papel of Object.keys(EMAILS) as Papel[]) {
    await q(
      `INSERT INTO users (org_id, name, email, password_hash, papel, role)
       SELECT $1, $2, $3, password_hash, $4, $5 FROM users WHERE email = 'dono@fazendapark.com.br'`,
      [ORG, `Teste ${papel}`, EMAILS[papel], papel, roleLegado(papel)])
    cookies[papel] = await entrarCom(EMAILS[papel])
  }

  await novoCliente(ORG, 'ana', {
    nome: 'Ana Silva', email: 'ana.silva.cli@teste.invalido', doc: CPF_ANA, fone: '73998260963',
    insta: 'ana.silva', cidade: 'Salvador', uf: 'BA', anos: 30, cadastrado: true, novidades: true, senha: HASH_DA_ANA,
  })
  await novoCliente(ORG, 'bruno', {
    nome: 'Bruno Costa', doc: '11144477735', fone: '11987654321', cidade: 'Feira de Santana', uf: 'BA',
    anos: 20, cadastrado: true,
  })
  await novoCliente(ORG, 'carla', { nome: 'Carla Dias', doc: '39053344705' })
  await novoCliente(ORG, 'davi', { nome: 'Davi Souza' })
  await novoCliente(ORG, 'cem', { nome: 'Zé 100% Real' })
  await novoCliente(ORG, 'mil', { nome: 'Zé 1000 Real' })
  await novoCliente(OUTRA_ORG, 'fora', {
    nome: 'Fora Total', cidade: 'Recife', uf: 'PE', anos: 40, cadastrado: true, novidades: true,
  })

  // Ana: 2 pedidos (33.000). Bruno: 1 com estorno parcial (11.000 − 3.000 = 8.000).
  // Carla: 1 de balcão (5.000). Davi só tentou (expirou).
  await pedido(ids.ana, { total: 11_000, pagoHa: 5 })
  await pedido(ids.ana, { total: 22_000, pagoHa: 1 })
  await pedido(ids.bruno, { status: 'estornado_parcial', total: 11_000, estornado: 3_000, pagoHa: 2 })
  await pedido(ids.carla, { canal: 'bilheteria', total: 5_000, pagoHa: 3 })
  await pedido(ids.davi, { status: 'expirado', total: 11_000, pagoHa: null })
}, 90_000)

afterAll(async () => {
  if (sonda.noAr) {
    await expurgar(`org_id = ANY($1::uuid[])`, [[ORG, OUTRA_ORG]])
    await q(`DELETE FROM orders WHERE org_id = ANY($1::uuid[])`, [[ORG, OUTRA_ORG]])
    await q(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [[ORG, OUTRA_ORG]])
  }
  await db().end()
})

describe('a lista', () => {
  it('traz só a base desta organização, com o que cada um comprou', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const d = await json('/api/admin/clientes?ordem=nome&porPagina=100')
    expect(d.itens.map((c: any) => c.nome)).toEqual([
      'Ana Silva', 'Bruno Costa', 'Carla Dias', 'Davi Souza', 'Zé 100% Real', 'Zé 1000 Real',
    ])
    expect(d.itens.map((c: any) => c.nome)).not.toContain('Fora Total')
    expect(d.resumo).toEqual({
      total: 6, compraram: 3, comCadastro: 2, aceitamNovidades: 1, comInstagram: 1,
    })
    const por = Object.fromEntries(d.itens.map((c: any) => [c.nome, [c.pedidos, c.gastoCents]]))
    // o estorno parcial ENTRA, pelo que a pessoa pagou de fato (11.000 − 3.000)
    expect(por['Ana Silva']).toEqual([2, 33_000])
    expect(por['Bruno Costa']).toEqual([1, 8_000])
    expect(por['Carla Dias']).toEqual([1, 5_000])
    expect(por['Davi Souza']).toEqual([0, 0])
  })

  it('o CPF sai mascarado e o hash da senha não sai nunca', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await abrir('/api/admin/clientes?porPagina=100')
    const texto = await r.text()
    expect(texto).not.toContain(CPF_ANA)
    expect(texto).not.toContain('11144477735')
    expect(texto).not.toContain('$2a$')
    expect(texto).not.toMatch(/password|senha/i)
    const ana = JSON.parse(texto).itens.find((c: any) => c.nome === 'Ana Silva')
    expect(ana.cpf).toBe('***.982.247-**')
  })

  it('a cidade do filtro só mostra cidade desta organização', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const d = await json('/api/admin/clientes')
    expect(d.cidades.map((c: any) => `${c.cidade}/${c.estado}`).sort())
      .toEqual(['Feira de Santana/BA', 'Salvador/BA'])
  })

  it('ordena e pagina; página além do fim ainda diz o total do recorte', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    expect((await json('/api/admin/clientes?ordem=gasto&porPagina=1')).itens[0].nome).toBe('Ana Silva')
    const p2 = await json('/api/admin/clientes?ordem=nome&porPagina=2&pagina=2')
    expect(p2.itens.map((c: any) => c.nome)).toEqual(['Carla Dias', 'Davi Souza'])
    expect(p2.paginacao).toEqual({ pagina: 2, porPagina: 2, total: 6 })
    const alem = await json('/api/admin/clientes?porPagina=2&pagina=99')
    expect(alem.itens).toEqual([])
    expect(alem.paginacao.total).toBe(6)
  })
})

describe('a busca e os filtros', () => {
  it('busca por nome, e-mail, CPF, celular e Instagram — CPF e celular do jeito que se digita', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    expect(await nomes('q=silva')).toEqual(['Ana Silva'])
    expect(await nomes('q=ana.silva.cli@')).toEqual(['Ana Silva'])
    expect(await nomes('q=982247')).toEqual(['Ana Silva'])
    expect(await nomes('q=529.982.247-25')).toEqual(['Ana Silva'])
    expect(await nomes('q=' + encodeURIComponent('(73) 99826-0963'))).toEqual(['Ana Silva'])
    expect(await nomes('q=' + encodeURIComponent('@ana.silva'))).toEqual(['Ana Silva'])
  })

  it('% e _ são texto, não curinga: "100%" acha só quem tem "100%" no nome', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    expect(await nomes('q=' + encodeURIComponent('100%'))).toEqual(['Zé 100% Real'])
    // com o curinga solto, "_" casaria com todo mundo
    expect(await nomes('q=' + encodeURIComponent('___'))).toEqual([])
  })

  it('estado, cidade, faixa de idade, novidades e cadastro completo', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    expect(await nomes('uf=BA')).toEqual(['Ana Silva', 'Bruno Costa'])
    expect(await nomes('uf=BA&cidade=Salvador')).toEqual(['Ana Silva'])
    expect(await nomes('uf=PE')).toEqual([]) // Recife é da OUTRA organização
    expect(await nomes('faixa=18a24')).toEqual(['Bruno Costa'])
    expect(await nomes('faixa=25a34')).toEqual(['Ana Silva'])
    expect(await nomes('novidades=1')).toEqual(['Ana Silva'])
    expect(await nomes('cadastro=1')).toEqual(['Ana Silva', 'Bruno Costa'])
  })

  it('já compraram × só tentaram (o contato mais quente pra remarketing)', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    expect(await nomes('situacao=compraram')).toEqual(['Ana Silva', 'Bruno Costa', 'Carla Dias'])
    expect(await nomes('situacao=so_tentaram')).toEqual(['Davi Souza', 'Zé 100% Real', 'Zé 1000 Real'])
    expect(await nomes('situacao=compraram&uf=BA')).toEqual(['Ana Silva', 'Bruno Costa'])
  })

  it('filtro inválido é 400 com recado, não lista vazia nem 500', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    for (const qs of ['uf=B', 'faixa=abc', 'situacao=talvez']) {
      const r = await abrir(`/api/admin/clientes?${qs}`)
      expect(r.status, qs).toBe(400)
    }
  })
})

describe('a ficha', () => {
  it('mostra o CPF inteiro, o endereço e os pedidos — e diz que há senha sem mostrar o hash', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await abrir(`/api/admin/clientes/${ids.ana}`)
    const texto = await r.text()
    expect(r.status).toBe(200)
    expect(texto).not.toContain('$2a$')
    expect(texto).not.toContain(HASH_DA_ANA)
    const f = JSON.parse(texto)
    expect(f).toMatchObject({
      nome: 'Ana Silva', cpf: CPF_ANA, telefone: '73998260963', instagram: 'ana.silva',
      idade: 30, faixa: '25a34', aceitaNovidades: true, temSenha: true,
      endereco: { cidade: 'Salvador', estado: 'BA', cep: '45000000', rua: 'Rua das Flores' },
    })
    expect(f.pedidos.map((o: any) => o.totalCents).sort((a: number, b: number) => a - b)).toEqual([11_000, 22_000])
  })

  it('a ficha mostra também o pedido que não virou dinheiro (o que essa pessoa fez aqui)', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const f = await json(`/api/admin/clientes/${ids.davi}`)
    expect(f.pedidos.map((o: any) => o.situacao)).toEqual(['expirado'])
    expect(f.temSenha).toBe(false)
  })

  it('cliente de OUTRA organização, id que não existe e id torto: 404, sem distinguir', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    for (const id of [ids.fora, randomUUID(), 'nao-e-uuid']) {
      expect((await abrir(`/api/admin/clientes/${id}`)).status, id).toBe(404)
    }
  })
})

describe('a exportação', () => {
  it('leva o mesmo recorte da lista, sem CPF e sem endereço de rua', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await abrir('/api/admin/clientes/exportar?novidades=1')
    const texto = await r.text()
    expect(r.status).toBe(200)
    expect(texto).not.toContain(CPF_ANA)
    expect(texto).not.toContain('Rua das Flores')
    expect(texto).not.toMatch(/cpf|document|password/i)
    const d = JSON.parse(texto)
    expect(d.total).toBe(1)
    expect(Object.keys(d.linhas[0]).sort()).toEqual([
      'aceitaNovidades', 'cidade', 'clienteDesde', 'email', 'estado', 'gastoCents', 'idade',
      'instagram', 'nome', 'pedidos', 'telefone', 'ultimaCompraEm',
    ])
    expect(d.linhas[0]).toMatchObject({ nome: 'Ana Silva', aceitaNovidades: true, gastoCents: 33_000 })
  })

  it('sem filtro leva a base da organização inteira — e só dela', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const d = await json('/api/admin/clientes/exportar')
    expect(d.total).toBe(6)
    expect(d.linhas.map((l: any) => l.nome)).not.toContain('Fora Total')
  })

  it('deixa rastro na Auditoria: quem, quantas linhas e com que filtro', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    await expurgar(`org_id = $1`, [ORG])
    await json('/api/admin/clientes/exportar?novidades=1&uf=BA')
    const l = await q1<any>(
      `SELECT entity, action, actor_email, after FROM audit_log WHERE org_id = $1`, [ORG])
    expect(l).toMatchObject({ entity: 'clientes', action: 'exportado', actor_email: EMAILS.master })
    expect(l.after).toEqual({ linhas: 1, filtro: { uf: 'BA', novidades: '1' } })
  })

  it('exportação recusada (filtro inválido) não deixa linha de auditoria', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    await expurgar(`org_id = $1`, [ORG])
    expect((await abrir('/api/admin/clientes/exportar?uf=B')).status).toBe(400)
    expect((await q1<any>(`SELECT count(*)::int AS n FROM audit_log WHERE org_id = $1`, [ORG]))!.n).toBe(0)
  })
})

describe('quem abre', () => {
  const ROTAS = () => [
    '/api/admin/clientes', '/api/admin/clientes/exportar', `/api/admin/clientes/${ids.ana}`,
  ]

  it('só o master: financeiro, operação e portaria levam 403 em TODAS as portas', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    for (const rota of ROTAS()) {
      expect((await abrir(rota, 'master')).status, `master ${rota}`).toBe(200)
      for (const papel of ['financeiro', 'operacao', 'portaria'] as Papel[]) {
        expect((await abrir(rota, papel)).status, `${papel} ${rota}`).toBe(403)
      }
    }
  })

  it('sem sessão nenhuma, nada abre', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    for (const rota of ROTAS()) {
      expect([401, 403], rota).toContain((await abrir(rota, null)).status)
    }
  })
})
