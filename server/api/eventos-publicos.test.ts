/**
 * Teste da vitrine da HOME — e do contrato que ela tem com a página do evento.
 *
 * POR QUE ELE EXISTE: a home e a página do evento respondem a mesma pergunta
 * ("dá pra comprar, e por quanto?") por dois caminhos. Cada uma, sozinha,
 * parecia certa. Cinco divergências foram MEDIDAS entre as duas, e as cinco
 * tinham a mesma causa: a home chamava as funções certas com a linha do banco
 * incompleta, e função que não recebe a coluna não tem como aplicar a trava.
 *
 *   1. `zz-terminou` (acabou faz 2 dias) — home anunciando R$ 55,00,
 *      `GET /api/e/…` respondendo `vendasAbertas: false`. Faltava `e.ends_at`.
 *   2. empate de `sort_order` — home R$ 99,00, página R$ 33,00 no MESMO
 *      evento. Faltava `l.sort_order`; sem ele quem escolhia o "1º lote" era a
 *      ordem física das linhas do Postgres, que muda sozinha a cada UPDATE.
 *   3. cota legal da meia — home "a partir de R$ 55,00" numa meia que a página
 *      já marcava `esgotado` (cota de 40% estourada). Página: R$ 110,00. O
 *      dobro. Faltava rodar `restamPorTipo`.
 *   4. lote que ainda vai abrir — home dizia `esgotado`, página dizia
 *      `em_breve`.
 *   5. lote que venceu o prazo com 0 de 100 vendidos — home dizia `esgotado`,
 *      página dizia `encerrado`.
 *
 * COMO ELE TRAVA ISSO: o caso central não confere a home contra um número
 * escrito à mão — ele confere a home contra **a página do evento**, estado por
 * estado. Número à mão envelhece junto com o defeito; a outra rota, não. Os
 * casos seguintes pregam também o valor esperado, pra pegar o dia em que as
 * duas errarem juntas.
 *
 * É teste de HTTP e vai ao banco de propósito: o que precisa ficar travado é a
 * resposta que sai na rede, não uma cópia da regra em memória.
 *
 * Fixture com ids desta corrida (`uuidDaCorrida`), apagada no `afterAll`.
 * NUNCA toca no evento semeado. Sem servidor de dev no ar, o caso é PULADO —
 * `ctx.skip()`, nunca `return`, que o vitest conta como aprovado.
 */
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { reais } from '../../app/composables/formato'
import {
  anunciarPulo, BASE_DE_TESTE, MARCA_DA_CORRIDA, seForaDoArPula, sondarServidor,
  uuidDaCorrida, type Sonda,
} from '../../scripts/test-setup'

const BASE = BASE_DE_TESTE

/** ids desta corrida: duas trilhas rodando a suíte no mesmo banco não brigam. */
const id = (n: number) => uuidDaCorrida('eventos-publicos.test', n)

const ORG = id(0)
const EV_A_VENDA = id(1)
const EV_TERMINOU = id(2)
const EV_PRAZO = id(3)
const EV_EM_BREVE = id(4)
const EV_ESGOTADO = id(5)
const EV_LOTE_VENCEU = id(6)
const EV_RASCUNHO = id(7)
const EV_PRIVADO = id(8)
const EV_EMPATE = id(9)
const EV_COTA_MEIA = id(10)
const EV_ULTIMAS = id(11)
const EV_SEM_LOTE = id(12)
const EV_SEM_CIDADE = id(13)

/** o setor de cada evento, derivado do id dele — um por evento, sem tabela à parte */
const SETOR_DE: Record<string, string> = {}
const L_EMPATE_CARO = id(200)
const L_EMPATE_MEIO = id(201)
const L_EMPATE_BARATO = id(202)
const L_COTA = id(203)

const slug = (nome: string) => `zz-casa-${nome}-${MARCA_DA_CORRIDA}`

const S_A_VENDA = slug('avenda')
const S_TERMINOU = slug('terminou')
const S_PRAZO = slug('prazo')
const S_EM_BREVE = slug('embreve')
const S_ESGOTADO = slug('esgotado')
const S_LOTE_VENCEU = slug('loteventeu')
const S_RASCUNHO = slug('rascunho')
const S_PRIVADO = slug('privado')
const S_EMPATE = slug('empate')
const S_COTA_MEIA = slug('cotameia')
const S_ULTIMAS = slug('ultimas')
const S_SEM_LOTE = slug('semlote')
const S_SEM_CIDADE = slug('semcidade')

// Taxa de 10% repassada ao comprador em todas as fixtures: o total é a face
// mais 10%, e é ele que as duas telas têm que anunciar.
const TOTAL_A_VENDA = 5500      // face 5000
const TOTAL_EMPATE = 3300       // face 3000 — o MENOR dos três lotes empatados
const TOTAL_EMPATE_CARO = 9900  // o que a home anunciava quando lia a ordem física
const TOTAL_COTA_INTEIRA = 11000 // face 10000 — a única linha que ainda vende
const TOTAL_COTA_MEIA = 5500     // o que a home anunciava ignorando a cota legal
const TOTAL_ULTIMAS = 4400      // face 4000

/**
 * O que a HOME tem que dizer de cada evento.
 *
 * `null` em `situacao` = o evento não pode virar linha na home. A página dele
 * continua respondendo (privado abre por link; porta fechada explica o não em
 * texto) — menos o rascunho, que não existe pro comprador.
 */
const ESTADOS: Array<{
  slug: string
  porque: string
  situacao: string | null
  aPartirDeCents: number | null
  httpDaPagina: number
}> = [
  { slug: S_A_VENDA, porque: 'evento à venda', situacao: 'disponivel', aPartirDeCents: TOTAL_A_VENDA, httpDaPagina: 200 },
  { slug: S_SEM_CIDADE, porque: 'evento sem cidade cadastrada', situacao: 'disponivel', aPartirDeCents: TOTAL_A_VENDA, httpDaPagina: 200 },
  { slug: S_ULTIMAS, porque: 'últimas unidades', situacao: 'ultimas', aPartirDeCents: TOTAL_ULTIMAS, httpDaPagina: 200 },
  { slug: S_EM_BREVE, porque: 'lote ainda vai abrir', situacao: 'em_breve', aPartirDeCents: null, httpDaPagina: 200 },
  { slug: S_ESGOTADO, porque: 'lote sem estoque', situacao: 'esgotado', aPartirDeCents: null, httpDaPagina: 200 },
  { slug: S_LOTE_VENCEU, porque: 'lote venceu o prazo com a prateleira cheia', situacao: 'encerrado', aPartirDeCents: null, httpDaPagina: 200 },
  { slug: S_SEM_LOTE, porque: 'evento sem lote publicado', situacao: 'em_breve', aPartirDeCents: null, httpDaPagina: 200 },
  { slug: S_EMPATE, porque: 'setor com sort_order empatado', situacao: 'disponivel', aPartirDeCents: TOTAL_EMPATE, httpDaPagina: 200 },
  { slug: S_COTA_MEIA, porque: 'meia com a cota legal estourada', situacao: 'ultimas', aPartirDeCents: TOTAL_COTA_INTEIRA, httpDaPagina: 200 },
  { slug: S_TERMINOU, porque: 'evento terminou (ends_at)', situacao: null, aPartirDeCents: null, httpDaPagina: 200 },
  { slug: S_PRAZO, porque: 'prazo de venda encerrado', situacao: null, aPartirDeCents: null, httpDaPagina: 200 },
  { slug: S_PRIVADO, porque: 'pré-venda fechada', situacao: null, aPartirDeCents: null, httpDaPagina: 200 },
  { slug: S_RASCUNHO, porque: 'rascunho não existe pro comprador', situacao: null, aPartirDeCents: null, httpDaPagina: 404 },
]

/**
 * A precedência esperada, escrita AQUI de propósito.
 *
 * Importar `situacaoDoEvento` da rota deixaria o caso tautológico: os dois
 * lados usariam a mesma função e concordariam até quando ela estivesse
 * errada. Esta é a oráculo independente — ela lê as situações dos LOTES que a
 * página do evento publicou e diz qual palavra a home devia ter escolhido.
 */
function situacaoPelaPagina(corpo: any): string {
  const situacoes: string[] = (corpo.setores ?? [])
    .flatMap((s: any) => s.lotes.map((l: any) => l.situacao))
  for (const s of ['disponivel', 'ultimas', 'em_breve', 'esgotado', 'encerrado']) {
    if (situacoes.includes(s)) return s
  }
  return 'em_breve'
}

let sonda: Sonda = { noAr: false, porque: 'sonda não rodou' }

async function sql(texto: string, par: any[] = []) {
  const { q } = await import('../utils/db')
  return q<any>(texto, par)
}

const home = () => fetch(`${BASE}/api/eventos-publicos`).then((r) => r.json())
const pagina = (s: string) => fetch(`${BASE}/api/e/${s}`)
const naHome = (lista: any, s: string) => lista.eventos.find((e: any) => e.slug === s)

beforeAll(async () => {
  sonda = await sondarServidor('/api/eventos-publicos')
  anunciarPulo('eventos-publicos.test.ts', sonda)
  if (!sonda.noAr) return

  await sql(
    `INSERT INTO organizations (id, name, slug) VALUES ($1,'ZZ CASA TESTE',$2)
     ON CONFLICT (id) DO NOTHING`, [ORG, `zz-casa-org-${MARCA_DA_CORRIDA}`])

  /**
   * Um evento; as janelas vêm em texto de intervalo pra ficarem legíveis.
   *
   * `cidade` é opcional e aceita `null` porque `events.city` é NULÁVEL e a
   * home junta cidade e data com " · " — sem uma fixture SEM cidade, o
   * separador solto ("· 21/09/2026") volta sem nada ficar vermelho.
   */
  const evento = (
    idEvento: string, nome: string, s: string,
    o: {
      status?: string; privado?: boolean; inicio?: string; fim?: string
      minutosDepois?: number | null; cidade?: string | null
    },
  ) => sql(
    `INSERT INTO events (id, org_id, name, slug, status, is_private,
                         starts_at, ends_at, sales_end_minutes_after,
                         fee_bps, fee_mode_online, auto_rotate_lots, city, state)
     VALUES ($1,$2,$3,$4,$5,$6,
             now() + $7::interval, now() + $8::interval, $9,
             1000,'repassar',true,$10,
             CASE WHEN $10::text IS NULL THEN NULL ELSE 'BA' END)
     ON CONFLICT (id) DO NOTHING`,
    [idEvento, ORG, nome, s, o.status ?? 'ativo', o.privado ?? false,
     o.inicio ?? '30 days', o.fim ?? '31 days', o.minutosDepois ?? null,
     o.cidade === undefined ? 'Ubatã' : o.cidade])

  await evento(EV_A_VENDA, 'ZZ CASA A VENDA', S_A_VENDA, {})
  // Mesmo estado do de cima, sem cidade: é a fixture do separador da tela.
  await evento(EV_SEM_CIDADE, 'ZZ CASA SEM CIDADE', S_SEM_CIDADE, { cidade: null })
  await evento(EV_ULTIMAS, 'ZZ CASA ULTIMAS', S_ULTIMAS, {})
  await evento(EV_EM_BREVE, 'ZZ CASA EM BREVE', S_EM_BREVE, {})
  await evento(EV_ESGOTADO, 'ZZ CASA ESGOTADO', S_ESGOTADO, {})
  await evento(EV_LOTE_VENCEU, 'ZZ CASA LOTE VENCEU', S_LOTE_VENCEU, {})
  await evento(EV_SEM_LOTE, 'ZZ CASA SEM LOTE', S_SEM_LOTE, {})
  await evento(EV_EMPATE, 'ZZ CASA EMPATE', S_EMPATE, {})
  await evento(EV_COTA_MEIA, 'ZZ CASA COTA MEIA', S_COTA_MEIA, {})
  await evento(EV_RASCUNHO, 'ZZ CASA RASCUNHO', S_RASCUNHO, { status: 'rascunho' })
  await evento(EV_PRIVADO, 'ZZ CASA PRIVADO', S_PRIVADO, { privado: true })
  // Acabou ontem e ninguém voltou no painel pra encerrar — o caso mais comum
  // de todos, e o que a home não enxergava por não selecionar `ends_at`.
  await evento(EV_TERMINOU, 'ZZ CASA TERMINOU', S_TERMINOU,
    { inicio: '-2 days', fim: '-1 day' })
  // Começou faz 2 horas e a venda fechava 1 minuto depois do início: o evento
  // ainda está acontecendo, mas a porta de venda já fechou.
  await evento(EV_PRAZO, 'ZZ CASA PRAZO', S_PRAZO,
    { inicio: '-2 hours', fim: '2 hours', minutosDepois: 1 })

  /** Cria o setor do evento e guarda o id — um setor por evento basta aqui. */
  const setor = async (idEvento: string, n: number) => {
    const idSetor = id(100 + n)
    await sql(
      `INSERT INTO sectors (id, event_id, name, sort_order) VALUES ($1,$2,'ZZ PISTA',1)
       ON CONFLICT (id) DO NOTHING`, [idSetor, idEvento])
    SETOR_DE[idEvento] = idSetor
    return idSetor
  }

  const lote = (
    idLote: string | null, idSetor: string, nome: string, preco: number,
    o: { quantidade?: number; vendidos?: number; ordem?: number; abre?: string; vence?: string } = {},
  ) => sql(
    `INSERT INTO lots (id, sector_id, name, price_cents, quantity, sold, sort_order,
                       starts_at, expires_at)
     VALUES (COALESCE($1::uuid, gen_random_uuid()),$2,$3,$4,$5,$6,$7,
             CASE WHEN $8::text IS NULL THEN NULL ELSE now() + $8::text::interval END,
             CASE WHEN $9::text IS NULL THEN NULL ELSE now() + $9::text::interval END)
     ON CONFLICT (id) DO NOTHING`,
    [idLote, idSetor, nome, preco, o.quantidade ?? 100, o.vendidos ?? 0, o.ordem ?? 1,
     o.abre ?? null, o.vence ?? null])

  // EV_TERMINOU e EV_PRAZO ganham lote CHEIO de propósito: o defeito medido não
  // era o evento morto aparecer vazio, era ele aparecer com PREÇO. Sem estoque
  // comprável a fixture esconderia metade da mentira.
  const comSetor = [EV_A_VENDA, EV_ULTIMAS, EV_EM_BREVE, EV_ESGOTADO, EV_LOTE_VENCEU,
    EV_RASCUNHO, EV_PRIVADO, EV_EMPATE, EV_COTA_MEIA, EV_TERMINOU, EV_PRAZO,
    EV_SEM_CIDADE]
  for (const [n, ev] of comSetor.entries()) await setor(ev, n)
  const S = (ev: string) => SETOR_DE[ev]!

  await lote(null, S(EV_A_VENDA), '1o lote', 5000)
  await lote(null, S(EV_SEM_CIDADE), '1o lote', 5000)
  // 5 livres: abaixo do LIMIAR_ULTIMAS (10), então a página diz 'ultimas' e a
  // home tem que dizer a mesma palavra.
  await lote(null, S(EV_ULTIMAS), '1o lote', 4000, { quantidade: 5 })
  await lote(null, S(EV_EM_BREVE), '1o lote', 5000, { abre: '5 days' })
  await lote(null, S(EV_ESGOTADO), '1o lote', 5000, { quantidade: 40, vendidos: 40 })
  // 0 de 100 vendidos: nada esgotou, o PRAZO é que venceu.
  await lote(null, S(EV_LOTE_VENCEU), '1o lote', 7000, { vence: '-1 day' })
  await lote(null, S(EV_RASCUNHO), '1o lote', 5000)
  await lote(null, S(EV_PRIVADO), '1o lote', 5000)
  await lote(null, S(EV_TERMINOU), '1o lote', 5000)
  await lote(null, S(EV_PRAZO), '1o lote', 5000)

  // EMPATE: os três em `sort_order = 0`, inseridos do MAIS CARO pro MAIS
  // BARATO — um INSERT por vez, na ordem. Sem `sort_order` na consulta quem
  // decide o "1º lote" é a ordem FÍSICA das linhas, e nela o primeiro é o
  // caro: é esse o R$ 99,00 que a home anunciava contra os R$ 33,00 da página.
  await lote(L_EMPATE_CARO, S(EV_EMPATE), 'ZZ LOTE CARO', 9000, { ordem: 0 })
  await lote(L_EMPATE_MEIO, S(EV_EMPATE), 'ZZ LOTE MEIO', 6000, { ordem: 0 })
  await lote(L_EMPATE_BARATO, S(EV_EMPATE), 'ZZ LOTE BARATO', 3000, { ordem: 0 })

  // COTA DA MEIA: lote de 10 lugares, cota legal de 40% = 4 meias. Quatro já
  // foram vendidas, então a meia acabou POR COTA com a prateleira sobrando
  // (10 − 4 = 6). Quem conta pela prateleira vê 6 meias à venda e anuncia
  // R$ 55,00; quem respeita a cota anuncia a inteira, R$ 110,00.
  await lote(L_COTA, S(EV_COTA_MEIA), '1o lote', 10000, { quantidade: 10, vendidos: 4 })
  // `half_quota_bps` fica no DEFAULT do schema (4000 = 40%): a fixture tem que
  // exercer a cota que o produtor recebe sem configurar nada.
  await sql(
    `INSERT INTO ticket_types (id, lot_id, name, quantity, sold, discount_bps, requires_document)
     VALUES ($1,$2,'Inteira',10,0,0,false), ($3,$2,'Meia-entrada',10,4,5000,true)
     ON CONFLICT (id) DO NOTHING`, [id(300), L_COTA, id(301)])
}, 60_000)

afterAll(async () => {
  if (!sonda.noAr) return
  // Só o que esta corrida criou. O evento semeado não é tocado.
  await sql(`DELETE FROM events WHERE org_id = $1`, [ORG])
  await sql(`DELETE FROM organizations WHERE id = $1`, [ORG])
})

describe('a home e a página do evento não podem discordar', () => {
  it('diz a MESMA coisa sobre cada estado — inclusive rascunho e privado', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const lista = await home()
    let conferidos = 0

    for (const estado of ESTADOS) {
      const onde = `${estado.slug} (${estado.porque})`
      const r = await pagina(estado.slug)
      expect(r.status, `${onde}: página do evento respondeu ${r.status}`).toBe(estado.httpDaPagina)
      const corpo = await r.json()
      const linha = naHome(lista, estado.slug)
      conferidos++

      if (estado.situacao === null) {
        // Não pode virar linha na home. Quando a página responde, ela tem que
        // concordar com o motivo: ou o evento não existe pro comprador (404),
        // ou a porta está fechada, ou é privado — e privado é o único que
        // segue vendendo por link direto.
        expect(linha, `${onde}: não podia aparecer na home`).toBeUndefined()
        if (r.status === 200) {
          const ehPrivado = estado.slug === S_PRIVADO
          expect(corpo.evento.vendasAbertas,
            `${onde}: a página discorda do sumiço na home`).toBe(ehPrivado)
        }
        continue
      }

      expect(linha, `${onde}: sumiu da home`).toBeTruthy()
      // ← o coração do caso: a palavra da home tem que sair das situações dos
      //   LOTES que a própria página do evento publicou
      expect(situacaoPelaPagina(corpo),
        `${onde}: home diz "${linha.situacao}" e a página mostra outra coisa`)
        .toBe(linha.situacao)
      // ← duas implementações da mesma regra é como as telas passam a discordar
      expect(linha.aPartirDeCents,
        `${onde}: preço da home diferente do preço da página`)
        .toBe(corpo.evento.aPartirDeCents)
      // `esgotado` é derivado, nunca uma segunda conta
      expect(linha.esgotado, `${onde}: esgotado não bate com situacao`)
        .toBe(linha.situacao === 'esgotado')
    }

    // Sem isto um laço que varre lista vazia fica VERDE com a trava arrancada.
    expect(conferidos, 'a fixture não foi conferida inteira').toBe(ESTADOS.length)
  }, 60_000)

  it('cada estado sai na home com o nome e o preço certos', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const lista = await home()

    for (const estado of ESTADOS.filter((e) => e.situacao !== null)) {
      const linha = naHome(lista, estado.slug)
      expect(linha, `${estado.slug} sumiu da home`).toBeTruthy()
      expect(linha.situacao, `${estado.slug} (${estado.porque})`).toBe(estado.situacao)
      expect(linha.aPartirDeCents, `${estado.slug} (${estado.porque})`)
        .toBe(estado.aPartirDeCents)
    }
  }, 60_000)

  it('evento que já terminou não vira linha na home', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    // MEDIDO antes do conserto: a home listava o evento com
    // `aPartirDeCents: 5500` enquanto `GET /api/e/<slug>` respondia
    // `vendasAbertas: false`. A causa era uma coluna: sem `e.ends_at` no
    // SELECT, `portaDeVenda()` não tinha como fechar a porta.
    const corpo = await pagina(S_TERMINOU).then((r) => r.json())
    expect(corpo.evento.vendasAbertas).toBe(false)
    expect(corpo.evento.avisoDeVenda, 'a página tem que explicar o não').toBeTruthy()
    // O lote está CHEIO: se a trava sair, a home volta a anunciar preço, não a
    // aparecer vazia. É a diferença entre o defeito e uma sombra dele.
    const lotes = corpo.setores.flatMap((s: any) => s.lotes)
    expect(lotes.length, 'a fixture do evento terminado ficou sem lote').toBe(1)
    expect(lotes[0].situacao, 'lote de evento fechado é "fechado"').toBe('fechado')

    const lista = await home()
    expect(naHome(lista, S_TERMINOU),
      'evento terminado voltou pra vitrine da home').toBeUndefined()
    // e o mesmo vale pro prazo de venda vencido, que é a outra porta fechada
    expect(naHome(lista, S_PRAZO)).toBeUndefined()
  }, 30_000)

  it('o "a partir de" sai do lote vigente, não da ordem física da tabela', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    // MEDIDO: home R$ 99,00 contra R$ 33,00 na página, no mesmo evento. Sem
    // `l.sort_order` na consulta, `situacoesDoSetor` cai na posição do array —
    // que num setor todo em `sort_order = 0` é a ordem em que o Postgres
    // guardou as linhas. Aí o lote mais caro virava o "1º lote" e os outros
    // dois, "em breve", sem ninguém ter dito isso.
    const corpo = await pagina(S_EMPATE).then((r) => r.json())
    const lotes = corpo.setores.flatMap((s: any) => s.lotes)
    expect(lotes.length, 'a fixture do empate ficou sem lote').toBe(3)
    // empate não é "depois": sem ordem declarada cada lote responde por si
    expect(lotes.map((l: any) => l.situacao)).toEqual(['disponivel', 'disponivel', 'disponivel'])

    const linha = naHome(await home(), S_EMPATE)
    expect(linha.aPartirDeCents).toBe(TOTAL_EMPATE)
    expect(linha.aPartirDeCents).toBe(corpo.evento.aPartirDeCents)
    expect(linha.aPartirDeCents,
      'a home voltou a anunciar o lote da primeira linha física').not.toBe(TOTAL_EMPATE_CARO)
  }, 30_000)

  it('a home não anuncia meia que a cota legal já não vende', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    // MEDIDO: home "a partir de R$ 55,00" (a meia) contra R$ 110,00 na página,
    // num lote cuja cota de 40% (Decreto 8.537/2015) já tinha acabado. A home
    // contava a meia pela prateleira porque não rodava `restamPorTipo`.
    const corpo = await pagina(S_COTA_MEIA).then((r) => r.json())
    const variacoes = corpo.setores.flatMap((s: any) => s.lotes.flatMap((l: any) => l.variacoes))
    const meia = variacoes.find((v: any) => v.ehMeia)
    expect(meia, 'a fixture da cota ficou sem meia').toBeTruthy()
    expect(meia.esgotado, 'a página tinha que recusar a meia pela cota').toBe(true)

    const linha = naHome(await home(), S_COTA_MEIA)
    expect(linha.aPartirDeCents).toBe(TOTAL_COTA_INTEIRA)
    expect(linha.aPartirDeCents).toBe(corpo.evento.aPartirDeCents)
    expect(linha.aPartirDeCents,
      'a home voltou a anunciar a meia que a cota já não vende').not.toBe(TOTAL_COTA_MEIA)
  }, 30_000)

  it('lote que venceu o prazo é "encerrado", não "esgotado"', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    // MEDIDO: 0 de 100 vendidos e a home dizendo `esgotado: true`. Esgotar e
    // vencer o prazo são notícias diferentes, e a página já dava a certa.
    const corpo = await pagina(S_LOTE_VENCEU).then((r) => r.json())
    const lotes = corpo.setores.flatMap((s: any) => s.lotes)
    expect(lotes.map((l: any) => l.situacao)).toEqual(['encerrado'])

    const linha = naHome(await home(), S_LOTE_VENCEU)
    expect(linha.situacao).toBe('encerrado')
    expect(linha.esgotado, 'ninguém comprou um ingresso sequer deste evento').toBe(false)

    // e o vizinho que REALMENTE esgotou continua dizendo esgotado
    const esgotado = naHome(await home(), S_ESGOTADO)
    expect(esgotado.situacao).toBe('esgotado')
    expect(esgotado.esgotado).toBe(true)
  }, 30_000)

  it('lote que ainda vai abrir é "em breve", não "esgotado"', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const corpo = await pagina(S_EM_BREVE).then((r) => r.json())
    expect(corpo.evento.vendasAbertas, 'o evento ainda vende, o LOTE é que não abriu').toBe(true)
    expect(corpo.setores.flatMap((s: any) => s.lotes).map((l: any) => l.situacao))
      .toEqual(['em_breve'])

    const linha = naHome(await home(), S_EM_BREVE)
    expect(linha.situacao).toBe('em_breve')
    expect(linha.esgotado).toBe(false)
    expect(linha.aPartirDeCents, 'não há preço comprável pra anunciar').toBeNull()
  }, 30_000)

  it('rascunho e privado não aparecem na home — e o rascunho não confirma existência', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const lista = await home()

    // ← listar é vazar a pré-venda fechada pra quem não foi convidado
    expect(naHome(lista, S_PRIVADO)).toBeUndefined()
    // ...e 404 aqui mataria o único jeito de entrar numa pré-venda fechada
    expect((await pagina(S_PRIVADO)).status).toBe(200)

    expect(naHome(lista, S_RASCUNHO)).toBeUndefined()
    // Resposta diferente do slug inexistente confirmaria que o evento existe e
    // está sendo preparado — é o vazamento que sobra depois de sumir da lista.
    const oRascunho = await pagina(S_RASCUNHO)
    const oInexistente = await pagina(`${S_RASCUNHO}-nao-existe`)
    expect(oRascunho.status).toBe(oInexistente.status)
    expect((await oRascunho.json()).statusMessage)
      .toBe((await oInexistente.json()).statusMessage)
  }, 30_000)
})

/* ===================================================================== tela ==
 * Os casos de cima provam que a ROTA responde certo. Nenhum deles olha a
 * TELA — e neste projeto a classe de bug que mais passou não lança exceção,
 * não suja o console e não deixa teste vermelho: ela só aparece olhando.
 *
 * Duas dessas passaram por esta página e as duas foram achadas MEDINDO, não
 * lendo: `rounded-bilhete` / `bg-papel` / `hover:bg-papel-fundo` / `.serial`
 * não existiam em lugar nenhum (o Tailwind não gera a regra e não avisa: a
 * linha renderizava com raio 0 e fundo transparente), e o separador aparecia
 * solto — "· 21/09/2026" — no evento sem cidade cadastrada. As duas foram
 * consertadas com uma medição no navegador, à mão, UMA vez. Medição à mão não
 * segura nada: no dia seguinte a classe volta e a página continua verde.
 *
 * Estes casos leem o HTML que o servidor RENDERIZA em `/` e o conferem contra
 * a resposta de `/api/eventos-publicos`. É a mesma pergunta dos casos de cima,
 * um andar acima: a tela tem que dizer o que a rota respondeu.
 */
describe('a tela da home diz o que a rota respondeu', () => {
  /**
   * As palavras que a tela usa, escritas AQUI.
   *
   * É o oráculo independente da vez: importar o mapa de `index.vue` faria o
   * caso concordar com a tela até quando a tela estivesse errada (e `.vue` nem
   * carrega no ambiente `node` desta suíte). Se alguém trocar "ESGOTADO" por
   * "SOLD OUT" na página, é aqui que fica vermelho.
   */
  const PALAVRA: Record<string, string> = {
    disponivel: 'À VENDA',
    ultimas: 'ÚLTIMAS UNIDADES',
    em_breve: 'EM BREVE',
    esgotado: 'ESGOTADO',
    encerrado: 'ENCERRADO',
  }

  /** As classes `selo-*` que `app/assets/base.css` REALMENTE define. */
  function selosQueExistem(): Set<string> {
    const css = readFileSync(new URL('../../app/assets/base.css', import.meta.url), 'utf8')
    return new Set([...css.matchAll(/\.(selo-[a-z]+)\s*\{/g)].map((m) => m[1]!))
  }

  /** O HTML renderizado da home, fatiado em um bloco por evento. */
  async function telaDaHome(): Promise<Map<string, string>> {
    const html = await fetch(`${BASE}/`).then((r) => r.text())
    const porSlug = new Map<string, string>()
    // `<li>` sai sem atributo nenhum do SSR (o `:key` não vira HTML), então o
    // corte é exato e um bloco nunca engole o evento seguinte.
    for (const bloco of html.split('<li>')) {
      const m = /href="\/e\/([^"]+)"/.exec(bloco)
      if (m) porSlug.set(m[1]!, bloco)
    }
    return porSlug
  }

  it('cada linha mostra a palavra e o preço que a rota respondeu', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const lista = await home()
    const tela = await telaDaHome()
    const existem = selosQueExistem()
    let conferidos = 0

    for (const estado of ESTADOS.filter((e) => e.situacao !== null)) {
      const linha = naHome(lista, estado.slug)
      expect(linha, `${estado.slug}: sumiu da resposta da rota`).toBeTruthy()
      const bloco = tela.get(estado.slug)
      expect(bloco, `${estado.slug} (${estado.porque}): a rota listou e a TELA não desenhou`)
        .toBeTruthy()
      conferidos++

      const selo = /<span class="(selo-[a-z-]+)">([^<]*)<\/span>/.exec(bloco!)
      expect(selo, `${estado.slug}: a linha saiu SEM selo nenhum`).toBeTruthy()
      const [, classe, texto] = selo!

      // ← classe que não existe não vira regra: o Tailwind não gera nada, o
      //   navegador não reclama, e o selo renderiza sem cor. O único jeito de
      //   travar isso sem abrir o navegador é conferir contra o CSS de verdade.
      expect(existem, `${estado.slug}: "${classe}" não existe em base.css — renderiza sem cor`)
        .toContain(classe!)
      expect(texto, `${estado.slug} (${estado.porque}): a tela diz outra coisa`)
        .toBe(PALAVRA[linha.situacao])

      const preco = /<strong class="[^"]*">([^<]*)<\/strong>/.exec(bloco!)?.[1] ?? null
      if (linha.aPartirDeCents == null) {
        // ← anunciar valor de lote que não vende é a isca que o comprador só
        //   descobre na página seguinte
        expect(preco, `${estado.slug}: sem lote comprável e a tela anunciou preço`).toBeNull()
        expect(bloco).not.toContain('R$')
      } else {
        expect(preco, `${estado.slug}: preço da tela diferente do preço da rota`)
          .toBe(reais(linha.aPartirDeCents))
      }

      // `toLocaleString('pt-BR', {style:'currency'})` separa o R$ com espaço
      // FINO (U+00A0): duas strings idênticas na tela deixam de ser iguais na
      // comparação. `reais()` usa espaço normal — esta linha é o que impede a
      // formatação de voltar pra dentro da página.
      expect(bloco, `${estado.slug}: voltou o espaço fino no R$`).not.toContain(' ')
    }

    // Sem isto um laço que varre lista vazia fica VERDE com a trava arrancada.
    expect(conferidos, 'a fixture da tela não foi conferida inteira')
      .toBe(ESTADOS.filter((e) => e.situacao !== null).length)
  }, 60_000)

  it('o separador só existe quando há os dois lados', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const tela = await telaDaHome()

    // MEDIDO antes do conserto: evento sem cidade renderizava
    // "ZZ CASA SEM CIDADE · 21/09/2026", com o ponto pendurado na frente da
    // data. Não lança, não some do console, não deixa teste vermelho.
    const semCidade = tela.get(S_SEM_CIDADE)
    expect(semCidade, 'a fixture sem cidade sumiu da tela').toBeTruthy()
    const apoio = /<span class="block text-sm text-tinta-suave">([^<]*)<\/span>/
      .exec(semCidade!)?.[1]?.trim()
    expect(apoio, 'a linha de apoio sumiu').toBeTruthy()
    expect(apoio, 'separador solto voltou na frente da data').not.toMatch(/^[·•]/)
    expect(apoio, 'sem cidade, sobra só a data').toMatch(/^\d{2}\/\d{2}\/\d{4}$/)

    // e o vizinho COM cidade continua com o separador no meio
    const comCidade = tela.get(S_A_VENDA)
    const apoioCom = /<span class="block text-sm text-tinta-suave">([^<]*)<\/span>/
      .exec(comCidade!)?.[1]?.trim()
    expect(apoioCom, 'com cidade, os dois lados e o ponto no meio')
      .toMatch(/^Ubatã · \d{2}\/\d{2}\/\d{4}$/)
  }, 30_000)

  it('o que não entra na lista também não vira linha na tela', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const tela = await telaDaHome()

    for (const estado of ESTADOS.filter((e) => e.situacao === null)) {
      expect(tela.get(estado.slug), `${estado.slug} (${estado.porque}): apareceu na TELA`)
        .toBeUndefined()
    }
  }, 30_000)

  it('bilheteria quebrada não pode aparecer como bilheteria vazia', () => {
    // MEDIDO com `/api/eventos-publicos` respondendo HTTP 500: a home
    // renderizava "BILHETERIA / EVENTOS / Nenhum evento à venda no momento." e
    // mais nada. A frase é uma AFIRMAÇÃO sobre o catálogo, e afirmá-la sem ter
    // conseguido perguntar manda embora quem procurou o evento pelo nome.
    // Depois do conserto, a mesma medição: faixa-erro com texto, cor medida
    // rgb(193,41,46) sobre rgb(252,234,234), e a frase de vazio ausente.
    //
    // ⚠️ Este caso lê a FONTE da página, não o navegador, e ele é honesto
    // sobre o que prova: um teste de HTTP não consegue derrubar a rota que o
    // SSR chama internamente, e um teste de componente precisaria de um
    // arquivo em `app/` que não é desta trilha. Ele fica vermelho se o ramo de
    // erro for apagado — que é a regressão que aconteceria — mas não substitui
    // medir a tela com a rota caída.
    const fonte = readFileSync(new URL('../../app/pages/index.vue', import.meta.url), 'utf8')

    expect(fonte, 'a página parou de pegar `error` do useFetch')
      .toMatch(/useFetch[^\n]*\n?/)
    expect(fonte, '`error` saiu da desestruturação do useFetch — a tela volta a mentir')
      .toMatch(/const\s*\{[^}]*\berror\b[^}]*\}\s*=\s*await\s+useFetch/)
    expect(fonte, 'sumiu a faixa que diz que foi a bilheteria que não respondeu')
      .toContain('faixa-erro')
    // A trava de verdade: a frase de vazio só pode sair quando NÃO houve erro.
    expect(fonte, 'a frase "Nenhum evento" voltou a sair também quando a rota cai')
      .toMatch(/v-if="!pending && !error && !data\?\.eventos\?\.length"/)
  })
})
