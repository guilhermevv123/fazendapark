/**
 * Teste da cerca de organização.
 *
 * O porteiro de `autenticacao.test.ts` prova que rota nova nasce TRANCADA.
 * Este prova a segunda metade, que faltava e custou caro: rota nova nasce
 * **CERCADA** — um login válido de outro cliente não lê nem escreve num
 * recurso que não é dele.
 *
 * Antes da cerca, bastava ter o UUID do evento: dashboard, borderô,
 * financeiro e a lista de participantes (com nome, documento e e-mail de
 * cada comprador) respondiam 200 para qualquer login de qualquer produtor da
 * mesma instalação.
 *
 * O teste varre as rotas do repositório em vez de listar caso a caso. Rota
 * nova sob `/api/admin/evento/[id]/` entra na varredura sozinha: se ela
 * responder pro vizinho, este teste fica vermelho sem ninguém lembrar de
 * adicionar nada.
 *
 * Precisa do servidor de dev no ar. Sem ele, PULA em vez de falhar.
 */
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { comSessao, entrar } from '../../scripts/teste-sessao'

const BASE = process.env.BASE_TESTE ?? 'http://localhost:3100'
const SLUG = 'conquista-park-4-edicao'

/** ids fixos: o teste limpa exatamente o que criou, nunca "por nome" ou "por data" */
const ORG_VIZINHA = '00000000-0000-4000-8000-00000000fa01'
const USUARIO_VIZINHO = '00000000-0000-4000-8000-00000000fa02'
const EMAIL_VIZINHO = 'vizinho.teste@isolamento.invalido'
const SENHA_VIZINHO = 'diamond123'

let noAr = false
let eventoAlheio = ''
let cookieVizinho = ''
let cookieDono = ''

/** roda SQL pelo mesmo pool do servidor, sem depender do psql estar no PATH */
async function sql(texto: string, par: any[] = []) {
  const { q } = await import('../utils/db')
  return q<any>(texto, par)
}

beforeAll(async () => {
  try {
    noAr = (await fetch(`${BASE}/api/e/${SLUG}`, { signal: AbortSignal.timeout(2500) })).ok
  } catch { noAr = false }
  if (!noAr) return

  cookieDono = await entrar('master')
  const eventos = await comSessao(cookieDono)('/api/admin/eventos').then((r) => r.json())
  eventoAlheio = eventos.find((e: any) => e.slug === SLUG)?.id ?? ''

  // Vizinho com a MESMA senha do dono, copiando o hash já semeado: assim o
  // teste não precisa conhecer nem gerar hash de senha.
  await sql(
    `INSERT INTO organizations (id, name, slug)
     VALUES ($1,'ZZ ISOLAMENTO TESTE','zz-isolamento-teste')
     ON CONFLICT (id) DO NOTHING`, [ORG_VIZINHA])
  await sql(
    `INSERT INTO users (id, org_id, name, email, password_hash, role)
     SELECT $1, $2, 'Vizinho Teste', $3, password_hash, 'master'
       FROM users WHERE email = 'dono@fazendapark.com.br'
     ON CONFLICT (id) DO NOTHING`, [USUARIO_VIZINHO, ORG_VIZINHA, EMAIL_VIZINHO])

  const r = await fetch(`${BASE}/api/auth/entrar`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL_VIZINHO, senha: SENHA_VIZINHO }),
  })
  const bruto = r.headers.getSetCookie?.() ?? []
  cookieVizinho = bruto.map((c) => c.split(';')[0]).find((c) => c.startsWith('dt_sessao=')) ?? ''
}, 30_000)

afterAll(async () => {
  if (!noAr) return
  // ON DELETE CASCADE leva usuário e sessões junto; o escopo é o id que o
  // teste criou, nunca um DELETE por nome.
  await sql(`DELETE FROM organizations WHERE id = $1`, [ORG_VIZINHA])
})

/**
 * Rotas sob server/api/admin/evento/[id]/ — inclusive as de subpasta.
 *
 * A versão anterior parava no primeiro nível (`isFile()` pulava diretório em
 * silêncio), e por isso o módulo inteiro da bilheteria — sete rotas que
 * recebem id de turno e de ponto no CORPO, que é justamente a forma do furo
 * que este arquivo existe pra pegar — passou meses fora da varredura sem
 * nenhum teste ficar vermelho. Varredura que não desce é varredura que dá
 * uma garantia que ela não tem.
 */
function rotasDoEvento(
  dir = join(process.cwd(), 'server/api/admin/evento/[id]'), prefixo = '',
) {
  const achados: { nome: string; metodo: string }[] = []
  for (const arquivo of readdirSync(dir)) {
    const caminho = join(dir, arquivo)
    if (!statSync(caminho).isFile()) {
      achados.push(...rotasDoEvento(caminho, `${prefixo}${arquivo}/`))
      continue
    }
    if (!arquivo.endsWith('.ts') || arquivo.includes('.test.')) continue
    const m = arquivo.match(/^(.+?)\.(get|post|patch|delete|put)\.ts$/)
    if (!m) continue
    // `pdv/index.get.ts` responde em `/pdv`, não em `/pdv/index`
    const nome = m[1] === 'index' ? prefixo.replace(/\/$/, '') : `${prefixo}${m[1]}`
    achados.push({ nome, metodo: m[2].toUpperCase() })
  }
  return achados
}

describe('cerca de organização', () => {
  it('o vizinho tem sessão válida (senão o teste não prova nada)', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    expect(cookieVizinho, 'login do vizinho falhou — o teste ficaria verde à toa').toBeTruthy()
    const eu = await comSessao(cookieVizinho)('/api/auth/eu').then((r) => r.json())
    expect(eu.usuario.orgId).toBe(ORG_VIZINHA)
  }, 20_000)

  it('nenhuma rota do evento responde para outra organização', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    expect(eventoAlheio, 'não achei o evento do seed').toBeTruthy()

    const rotas = rotasDoEvento()

    /*
     * Piso não serve: `toBeGreaterThan(5)` contra 42 rotas reais dá verde com
     * a varredura tendo conferido SETE POR CENTO delas. Se a recursão à mão
     * acima parar de descer — uma pasta nova, uma convenção de nome mudada, um
     * `continue` a mais — ela devolve lista curta, o caso passa, e a cerca de
     * organização fica sem quem a exercite justamente nas rotas novas.
     *
     * A conferência é uma contagem INDEPENDENTE (o `readdirSync` recursivo do
     * Node, que não compartilha código com a recursão de cima) e IGUALDADE.
     * Mesma receita de `server/api/autenticacao.test.ts`. Rota nova entra nos
     * dois lados sozinha; rota que só um dos dois enxerga fica vermelha com o
     * nome dela na mensagem.
     */
    const porNode = (readdirSync(
      join(process.cwd(), 'server/api/admin/evento/[id]'),
      { recursive: true, encoding: 'utf8' },
    ) as string[])
      .filter((f) => /\.(get|post|patch|delete|put)\.ts$/.test(f) && !f.includes('.test.'))
    const soNaRecursao = rotas.length - porNode.length
    expect(rotas.length, `a varredura achou ${rotas.length} rota(s) e o Node achou `
      + `${porNode.length}: ${soNaRecursao > 0 ? 'a recursão inventou' : 'a recursão perdeu'} `
      + 'arquivo — o caminho ou a convenção de nome mudou').toBe(porNode.length)

    const vazaram: string[] = []
    for (const { nome, metodo } of rotas) {
      const r = await comSessao(cookieVizinho)(
        `/api/admin/evento/${eventoAlheio}/${nome}`,
        { method: metodo, body: metodo === 'GET' ? undefined : '{}' })
      // 404 é o esperado: para quem não é dono, o recurso não existe. 400 e
      // 422 também servem — significam que parou na validação do corpo
      // ANTES de tocar em dado alheio. O que não pode é 200.
      if (r.status === 200) vazaram.push(`${metodo} ${nome} → 200`)
    }
    expect(vazaram, `estas rotas responderam pro vizinho: ${vazaram.join(', ')}`).toEqual([])
  }, 60_000)

  it('o dono continua enxergando o próprio evento', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    // ← sem esta asserção, a cerca poderia estar bloqueando TODO MUNDO e os
    //   testes acima ficariam verdes com o sistema inteiro quebrado.
    const r = await comSessao(cookieDono)(`/api/admin/evento/${eventoAlheio}/dashboard`)
    expect(r.status).toBe(200)
    const d = await r.json()
    expect(d.totais.cobradoCents).toBeGreaterThan(0)
  }, 20_000)

  it('as listas mostram só a organização da sessão', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')

    const eventos = await comSessao(cookieVizinho)('/api/admin/eventos').then((r) => r.json())
    expect(eventos, 'o vizinho não tem evento nenhum').toEqual([])

    const orgs = await comSessao(cookieVizinho)('/api/admin/organizacoes').then((r) => r.json())
    expect(orgs.length).toBe(1)
    expect(orgs[0].id).toBe(ORG_VIZINHA)

    const equipe = await comSessao(cookieVizinho)('/api/admin/equipe').then((r) => r.json())
    expect(equipe.pessoas.every((p: any) => p.email === EMAIL_VIZINHO)).toBe(true)
  }, 20_000)

  it('não dá pra criar evento dentro da organização de outro', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')

    const donoOrg = await comSessao(cookieDono)('/api/admin/organizacoes').then((r) => r.json())
    const r = await comSessao(cookieVizinho)('/api/admin/evento', {
      method: 'POST',
      body: JSON.stringify({
        orgId: donoOrg[0].id,
        nome: 'ZZ EVENTO INVASOR TESTE',
        inicio: '2030-01-01T20:00:00.000Z',
        fim: '2030-01-02T04:00:00.000Z',
        local: { cidade: 'Ubatã', estado: 'BA' },
      }),
    })
    expect(r.status).not.toBe(200)

    // read-back: o retorno pode mentir, a tabela não.
    const [{ n }] = await sql(
      `SELECT count(*)::int AS n FROM events WHERE name = 'ZZ EVENTO INVASOR TESTE'`)
    expect(n, 'o evento invasor chegou a ser gravado').toBe(0)
  }, 20_000)

  it('pedido de outra organização também não abre', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')

    const vendas = await comSessao(cookieDono)(
      `/api/admin/evento/${eventoAlheio}/vendas`).then((r) => r.json())
    const pedido = vendas.pedidos?.[0]
    if (!pedido) return void console.warn('  (pulado: nenhum pedido no seed)')

    const r = await comSessao(cookieVizinho)(`/api/admin/pedido/${pedido.id}`)
    expect(r.status).toBe(404)
  }, 20_000)
})
