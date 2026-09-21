/**
 * GET /api/eventos-publicos — a vitrine da home.
 *
 * **A home e a página do evento respondem a mesma pergunta e têm que dar a
 * mesma resposta.** Não é estilo: as duas telas são a mesma promessa feita em
 * dois lugares, e quando discordam quem paga a diferença é o comprador que
 * clicou no preço da home. Por isso este arquivo não decide nada sozinho —
 * ele IMPORTA de `e/[slug].get.ts` a porta de venda, a situação do lote, o
 * giro do setor, a cota da meia e o "a partir de", e só ENFEIXA o resultado
 * numa palavra por evento (`situacaoDoEvento`).
 *
 * Cinco divergências já foram medidas entre as duas rotas. Todas tinham a
 * mesma causa de fundo — a home chamava as funções certas com a linha do banco
 * INCOMPLETA, e função que não recebe a coluna não tem como aplicar a trava:
 *
 * 1. **Evento que já terminou continuava anunciado com preço.** A home não
 *    selecionava `e.ends_at`, então `portaDeVenda()` pulava a trava de evento
 *    terminado. Medido: `zz-vit-terminou` (acabou faz 2 dias) saía na home com
 *    `aPartirDeCents: 5500` enquanto `GET /api/e/zz-vit-terminou` respondia
 *    `vendasAbertas: false`.
 *
 * 2. **O "a partir de" saía do lote errado quando a ordem empatava.** A home
 *    não selecionava `l.sort_order`, e sem ele `situacoesDoSetor` cai na
 *    posição do array — que num setor com `sort_order` todo em 0 é a ordem
 *    FÍSICA das linhas do Postgres. Medido: home R$ 99,00 (LOTE CARO) contra
 *    R$ 33,00 (LOTE BARATO) na página do evento. R$ 66,00 de diferença no
 *    mesmo evento, e mudando sozinho a cada UPDATE que reescreve uma linha.
 *
 * 3. **A home anunciava meia que a cota legal já não vende.** Ela não rodava
 *    `restamPorTipo` (nem selecionava `l.half_quota_bps`/`tt.kind`), então
 *    contava a meia pela prateleira. Medido: home "a partir de R$ 55,00" num
 *    lote cuja cota de 40% já tinha acabado — a página do evento marcava a
 *    meia `esgotado: true` e anunciava R$ 110,00. O dobro.
 *
 * 4. **"Esgotado" em evento que não vendeu um ingresso sequer.** Sem lote
 *    comprável a home dizia esgotado, ponto. Medido: `zz-vit-embreve`, cujo
 *    único lote abre daqui a 5 dias, saía `esgotado: true` enquanto a página
 *    mostrava o lote `em_breve`.
 *
 * 5. **"Esgotado" em lote que venceu o prazo com a prateleira cheia.** Medido:
 *    `zz-vit-lote-venceu`, 0 de 100 vendidos e `expires_at` de ontem — home
 *    `esgotado: true`, página `encerrado`.
 *
 * As duas regras de listagem que continuam sendo desta rota (e só dela):
 *
 * - **Evento privado não aparece.** `is_private` existe pra sustentar pré-venda
 *   fechada e evento corporativo: abre por link direto, some de listagem.
 *   Listar é vazar a pré-venda pra quem não foi convidado.
 * - **Só evento de porta aberta entra na vitrine.** Quem fechou não vira linha
 *   na home — a página dele continua abrindo por link e explicando o não em
 *   texto (`avisoDeVenda`). Some da home quem o RELÓGIO fechou e também quem o
 *   produtor tirou do ar pelo `status`; o que NÃO some é quem ainda vende,
 *   ainda que hoje não tenha nada comprável: aí a home nomeia o que houve
 *   ("em breve", "esgotado", "encerrado") em vez de sumir com o evento.
 *   Quem procurou pelo nome tem que achar a página.
 */
import { q } from '../utils/db'
import type { ModoTaxa } from '../utils/dinheiro'
import {
  LOTE_DA_VITRINE, menorTotalCents, restaDasVariacoes, restamPorTipo, situacoesDoSetor,
  vendasAbertas,
  type LotePrecificavel, type SituacaoDoLote,
} from './e/[slug].get'

/**
 * A notícia do evento inteiro, no vocabulário do LOTE.
 *
 * De propósito são as mesmas palavras que `situacao` de lote na página do
 * evento: duas telas que falam do mesmo fato com dois vocabulários é como uma
 * passa a dizer "esgotado" onde a outra diz "encerrado" sem ninguém notar que
 * são coisas diferentes. `fechado` não entra porque evento de porta fechada
 * não vira linha na home (ver o cabeçalho).
 */
export type SituacaoNaVitrine = 'disponivel' | 'ultimas' | 'em_breve' | 'esgotado' | 'encerrado'

/**
 * Qual notícia ganha quando os lotes do evento estão em situações diferentes.
 *
 * Lê-se de cima pra baixo: **o que dá pra comprar vem antes do que não dá**
 * (um setor esgotado não torna esgotado o evento que ainda vende pista), e
 * entre os que não dão pra comprar vale o que é notícia mais forte pro
 * comprador — "vai abrir" antes de "acabou", e "acabou o ingresso" antes de
 * "acabou o prazo", porque esgotar é o que ele veio conferir.
 */
const PRECEDENCIA: SituacaoNaVitrine[] = [
  'disponivel', 'ultimas', 'em_breve', 'esgotado', 'encerrado',
]

/**
 * Enfeixa as situações dos lotes do evento numa palavra só.
 *
 * Evento sem lote nenhum na vitrine cai em `em_breve`: ninguém esgotou nada e
 * nenhum prazo venceu — o produtor só ainda não publicou o que vai vender.
 * Dizer "esgotado" aí é a mentira que faz o comprador desistir de um evento
 * que ainda nem abriu.
 */
export function situacaoDoEvento(situacoes: SituacaoDoLote[]): SituacaoNaVitrine {
  for (const s of PRECEDENCIA) if (situacoes.includes(s)) return s
  return 'em_breve'
}

export default defineEventHandler(async () => {
  const agora = new Date()

  // `ends_at` e `timezone` entram porque `portaDeVenda()` precisa deles pra
  // fechar a porta de evento que já terminou — a coluna que faltava aqui era
  // literalmente a trava (ver o item 1 do cabeçalho).
  const candidatos = await q<any>(
    `SELECT e.id, e.name AS nome, e.slug, e.starts_at, e.city, e.state,
            e.status, e.ends_at, e.timezone, e.sales_end_at, e.sales_end_minutes_after,
            e.auto_rotate_lots, e.fee_bps, e.fee_mode_online
       FROM events e
      WHERE e.status = 'ativo' AND e.is_private = false
      ORDER BY e.starts_at`)

  const abertos = candidatos.filter((e) => vendasAbertas(e, agora))
  if (!abertos.length) return { eventos: [] }

  const ids = abertos.map((e) => e.id)

  // `l.sort_order` é a ordem que o PRODUTOR deu ao lote, e é ela que diz qual
  // é o lote vigente. Sem selecionar a coluna, `situacoesDoSetor` cai na
  // posição do array — ordem física do Postgres (item 2). `l.half_quota_bps`
  // é o outro teto da meia (item 3).
  const lotes = await q<any>(
    `SELECT s.event_id, s.id AS setor_id, l.id, l.price_cents,
            l.quantity, l.sold, l.reserved, l.starts_at, l.expires_at,
            l.sort_order, l.half_quota_bps
       FROM sectors s
       JOIN lots l ON l.sector_id = s.id AND ${LOTE_DA_VITRINE}
      WHERE s.event_id = ANY($1::uuid[])
      ORDER BY s.sort_order, l.sort_order`, [ids])

  const tipos = await q<any>(
    `SELECT s.event_id, tt.id, tt.lot_id, tt.kind, tt.quantity, tt.sold, tt.discount_bps
       FROM ticket_types tt
       JOIN lots l ON l.id = tt.lot_id AND ${LOTE_DA_VITRINE}
       JOIN sectors s ON s.id = l.sector_id
      WHERE s.event_id = ANY($1::uuid[])`, [ids])

  // Quanto cada variação ainda vende DE VERDADE, com a cota legal da meia já
  // descontada — a MESMA conta da página do evento. Vem antes de tudo porque é
  // ela que alimenta as duas de baixo: sem `restam`, a meia com cota zerada
  // continuava contando como estoque e virava o "a partir de" da home.
  const restamDoTipo = restamPorTipo(lotes, tipos)
  for (const t of tipos) t.restam = restamDoTipo.get(t.id) ?? 0

  // Mesmo teto de variação da página do evento: lote com prateleira cheia e
  // todas as variações esgotadas não é lote vigente e não vira preço. Sem isto
  // a home dava o evento por esgotado enquanto a página do evento ainda
  // mostrava o lote como disponível.
  const restaPorLote = restaDasVariacoes(tipos)
  for (const l of lotes) l.restaNasVariacoes = restaPorLote.get(l.id) ?? null

  const eventos = abertos.map((e) => {
    // Mesmo agrupamento da página do evento: giro de lote é decisão do setor.
    const porSetor = new Map<string, any[]>()
    for (const l of lotes) {
      if (l.event_id !== e.id) continue
      if (!porSetor.has(l.setor_id)) porSetor.set(l.setor_id, [])
      porSetor.get(l.setor_id)!.push(l)
    }

    const precificaveis: LotePrecificavel[] = []
    const situacoes: SituacaoDoLote[] = []
    for (const doSetor of porSetor.values()) {
      // `vendasAbertas: true` é fato aqui, não otimismo: `abertos` já filtrou
      // pela porta lá em cima, com `ends_at` na mão.
      const doSetorSituacoes = situacoesDoSetor(doSetor, {
        vendasAbertas: true, giroAutomatico: e.auto_rotate_lots, agora,
      })
      doSetor.forEach((l, i) => {
        situacoes.push(doSetorSituacoes[i]!)
        precificaveis.push({
          id: l.id, price_cents: Number(l.price_cents), situacao: doSetorSituacoes[i]!,
        })
      })
    }

    const aPartirDeCents = menorTotalCents({
      lotes: precificaveis,
      tipos: tipos.filter((t) => t.event_id === e.id),
      feeBps: Number(e.fee_bps),
      modo: e.fee_mode_online as ModoTaxa,
    })

    const situacao = situacaoDoEvento(situacoes)

    return {
      nome: e.nome,
      slug: e.slug,
      inicio: e.starts_at,
      cidade: e.city,
      estado: e.state,
      aPartirDeCents,
      // A palavra é a resposta; o preço é o complemento dela. Sem lote
      // comprável não há preço pra anunciar — e aí a home diz O QUE houve em
      // vez de sumir com o evento: quem procurou pelo nome tem que achar a
      // página, ainda que só pra descobrir que acabou.
      situacao,
      // Mantido porque é o jeito curto de perguntar "acabou?" e já tem leitor.
      // É DERIVADO de `situacao` de propósito: dois campos com contas próprias
      // é como um diz esgotado e o outro não no mesmo evento.
      esgotado: situacao === 'esgotado',
    }
  })

  return { eventos }
})
