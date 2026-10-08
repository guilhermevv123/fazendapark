<script lang="ts">
/** Uma linha da conta do "Resultado": o sinal é da CONTA, não da cor. */
export interface LinhaDoResultado {
  chave: string
  rotulo: string
  sinal: '' | '+' | '−' | '='
  cents: number
}

/**
 * A conta do borderô, linha a linha, fechando no líquido NA PRÓPRIA TELA (ADM-13).
 *
 * O líquido é `SQL_LIQUIDO` = Σ(total − plataforma − devolvido) dos pedidos vivos, e o banco
 * garante `total = face + taxa − desconto` (CHECK `total_fecha`). Então, com os campos que a rota
 * já devolve (todos pela mesma régua de pedido vivo):
 *
 *     face + taxa paga pelo comprador − descontos − plataforma − estornos parciais = líquido
 *
 * A tela antiga mostrava "Face − Descontos − Estornado" ao lado do líquido: o "Estornado" era TODA
 * devolução (inclusive a do pedido estornado por inteiro, cuja face já nem está na face vendida)
 * e a fatia da plataforma não aparecia — o documento que vai pro produtor tinha uma subtração que
 * não batia com o número ao lado. O estorno total agora é linha À PARTE, fora da conta.
 *
 * `diferencaCents` ≠ 0 quer dizer que a rota e a conta divergiram: a tela avisa em vez de esconder.
 */
export function linhasDoResultado(t: any): { linhas: LinhaDoResultado[]; estornoTotalCents: number; diferencaCents: number } {
  const n = (v: unknown) => Number(v ?? 0) || 0
  const linhas: LinhaDoResultado[] = [
    { chave: 'face', rotulo: 'Face vendida', sinal: '', cents: n(t.faceCents) },
    { chave: 'taxa', rotulo: 'Taxa de serviço paga pelo comprador', sinal: '+', cents: n(t.taxaCents) },
    { chave: 'desconto', rotulo: 'Descontos dados (cupons)', sinal: '−', cents: n(t.descontoCents) },
    { chave: 'plataforma', rotulo: 'Parte da plataforma', sinal: '−', cents: n(t.plataformaCents) },
    { chave: 'parcial', rotulo: 'Estornos parciais (devolvidos de pedidos que seguem valendo)', sinal: '−', cents: n(t.estornadoNoLiquidoCents) },
  ]
  const conta = linhas.reduce((s, l) => s + (l.sinal === '−' ? -l.cents : l.cents), 0)
  const liquido = n(t.liquidoCents)
  linhas.push({ chave: 'liquido', rotulo: 'Líquido da produção', sinal: '=', cents: liquido })
  return {
    linhas,
    estornoTotalCents: Math.max(0, n(t.estornadoCents) - n(t.estornadoNoLiquidoCents)),
    diferencaCents: liquido - conta,
  }
}

/**
 * Imprimir SÓ a folha (ADM-47). `window.print()` puro levava o menu lateral, o topo e as abas do
 * painel pro papel. O layout é de outra frente, então a folha se isola sozinha: na hora de
 * imprimir, cada irmão no caminho da folha até o `<body>` ganha `.fora-da-impressao` (some no
 * papel) e cada ancestral ganha `.caminho-da-impressao` (perde a margem da lateral); a função
 * devolvida desfaz tudo (chamada no `afterprint`).
 */
export function isolarParaImpressao(folha: Element | null): () => void {
  const marcados: [Element, string][] = []
  let no: Element | null = folha
  while (no && no.parentElement && no !== document.body) {
    const pai: Element = no.parentElement
    for (const irmao of Array.from(pai.children)) {
      if (irmao !== no) { irmao.classList.add('fora-da-impressao'); marcados.push([irmao, 'fora-da-impressao']) }
    }
    pai.classList.add('caminho-da-impressao')
    marcados.push([pai, 'caminho-da-impressao'])
    no = pai
  }
  return () => { for (const [e, c] of marcados) e.classList.remove(c) }
}
</script>

<script setup lang="ts">
/**
 * Financeiro › Borderô.
 *
 * É o documento que o produtor leva pro sócio e pro contador. A regra que rege
 * a tela inteira: **cortesia nunca entra na receita, mas sempre entra na
 * ocupação**. Um borderô que soma cortesia no faturamento fecha num número
 * bonito e errado; um que esquece de contá-la como lugar ocupado faz o produtor
 * achar que ainda tem 400 lugares que já foram dados.
 *
 * Por isso a coluna de cortesia existe separada em toda tabela daqui.
 */
import { estoqueSemLimite, quantidadeNaTela } from '~~/server/utils/estoque-sem-limite'
definePageMeta({ layout: 'admin' })

const route = useRoute()
const id = route.params.id as string

const { data, refresh, pending, error: falha } = await useFetch<any>(
  `/api/admin/evento/${id}/bordero`)

// `reais` é o de `composables/formato.ts` (espaço normal, conta inteira) — a cópia local com
// `toLocaleString` escrevia o dinheiro com espaço fino (ADM-48).

const resultado = computed(() => data.value ? linhasDoResultado(data.value.totais) : null)

const ROTULO_CANAL: Record<string, string> = {
  online: 'Site', bilheteria: 'Bilheteria', pdv_produtor: 'PDV da produção',
  pdv_ticketeira: 'PDV da plataforma', cortesia: 'Cortesia',
}
const ROTULO_FORMA: Record<string, string> = {
  pix: 'Pix', credito: 'Cartão de crédito', debito: 'Cartão de débito',
  dinheiro: 'Dinheiro', cortesia: 'Cortesia',
}

/** Some com a coluna de cortesia quando o evento não deu nenhuma. */
const temCortesia = computed(() =>
  (data.value?.lotes ?? []).some((l: any) => l.cortesias > 0))

// `window` não existe no escopo do template do Vue — chamar `window.print()`
// direto no @click renderiza sem erro e não faz nada ao clicar.
const folha = ref<HTMLElement | null>(null)
function imprimir() {
  const desfazer = isolarParaImpressao(folha.value)
  const aoTerminar = () => { desfazer(); window.removeEventListener('afterprint', aoTerminar) }
  window.addEventListener('afterprint', aoTerminar)
  window.print()
}

/**
 * CSV pelo `baixarCsv` da casa (ADM-35): nome de setor/lote é texto digitado, e a cópia à mão
 * daqui não neutralizava fórmula (`=HYPERLINK(...)` virava link no Excel de quem confere). Leva
 * também a conta do Resultado, que é o que o contador pede junto da tabela.
 */
function exportar() {
  if (!data.value) return
  const linhas: (string | number)[][] = (data.value.lotes ?? []).map((l: any) => [
    l.setor, l.lote, reais(l.faceUnitCents), estoqueSemLimite(l.estoque) ? 'Sem limite' : l.estoque, l.vendidos, l.cortesias,
    reais(l.faceCents), reais(l.taxaCents),
  ])
  if (resultado.value) {
    // o sinal vai no VALOR ("-R$ 50,00"), não no rótulo: rótulo começando com "=" ou "+" seria
    // lido como fórmula e ganharia o apóstrofo do `celulaCsv`
    linhas.push([], ['Resultado'])
    for (const r of resultado.value.linhas) {
      linhas.push([r.rotulo, '', r.sinal === '−' ? `-${reais(r.cents)}` : reais(r.cents)])
    }
    if (resultado.value.estornoTotalCents) {
      linhas.push(['Devolvido em pedidos estornados por inteiro (fora da conta)', '', reais(resultado.value.estornoTotalCents)])
    }
  }
  baixarCsv(`bordero-${data.value.evento.slug}`,
    ['Setor', 'Lote', 'Valor unitário', 'Estoque', 'Vendidos', 'Cortesias', 'Face', 'Taxa'], linhas)
}

useHead({ title: 'Borderô' })
</script>

<template>
  <div v-if="data" ref="folha" class="folha-bordero">
    <div class="flex flex-wrap items-start justify-between gap-3 py-5">
      <div>
        <h1 class="titulo text-2xl font-semibold text-tinta">Borderô</h1>
        <p class="mt-1 text-tinta-suave">
          Fechamento de {{ data.evento.nome }} — o que saiu, por onde, e quanto sobra.
        </p>
      </div>
      <div class="flex gap-2 print:hidden">
        <button type="button" class="btn-secundario" @click="exportar">
          <IconeMenu nome="exportar" :tamanho="18" /> Exportar
        </button>
        <button type="button" class="btn-secundario" @click="imprimir">Imprimir</button>
      </div>
    </div>

    <div class="print:hidden">
      <AbasSecao :evento-id="id" />
    </div>

    <!-- ====================================================== o resultado -->
    <section class="card mt-5">
      <h2 class="rotulo-kpi">Resultado</h2>
      <!-- A conta fecha AQUI: cada linha com o sinal da conta, o líquido embaixo (ADM-13). -->
      <dl v-if="resultado" class="mt-3 max-w-2xl text-sm" data-parte="resultado">
        <div v-for="r in resultado.linhas" :key="r.chave" :data-linha="r.chave"
             class="flex items-baseline justify-between gap-4 py-1.5"
             :class="r.sinal === '=' ? 'mt-1 border-t border-linha pt-2.5' : ''">
          <dt class="flex" :class="r.sinal === '=' ? 'font-semibold text-tinta' : 'text-tinta-suave'">
            <span class="w-4 shrink-0 tabular-nums text-tinta-fraca">{{ r.sinal }}</span><span>{{ r.rotulo }}</span>
          </dt>
          <!-- o valor não quebra ("R$" numa linha e "393,65" na outra, medido em 390 px) -->
          <dd class="shrink-0 whitespace-nowrap tabular-nums" :class="r.sinal === '=' ? 'numero-kpi text-ok' : 'text-tinta'">
            {{ reais(r.cents) }}
          </dd>
        </div>
      </dl>
      <p v-if="resultado?.estornoTotalCents" class="mt-2 max-w-2xl text-sm text-tinta-suave"
         data-parte="estorno-total">
        Devolvido em pedidos estornados <strong class="text-tinta">por inteiro</strong>:
        {{ reais(resultado.estornoTotalCents) }} — fora desta conta: a venda deles já não entra na face
        vendida. No total, {{ reais(data.totais.estornadoCents) }} voltaram ao comprador.
      </p>
      <p v-if="resultado?.diferencaCents" class="faixa-erro mt-3" data-parte="conta-nao-fecha">
        A conta acima não fecha com o líquido: diferença de {{ reais(resultado.diferencaCents) }}.
        Avise o suporte antes de usar este borderô.
      </p>

      <hr class="my-4 border-linha">

      <dl class="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
        <div class="flex justify-between">
          <dt class="text-tinta-suave">Taxa de serviço arrecadada</dt>
          <dd class="tabular-nums text-tinta">{{ reais(data.totais.taxaCents) }}</dd>
        </div>
        <div class="flex justify-between">
          <dt class="text-tinta-suave">Já transferido</dt>
          <dd class="tabular-nums text-tinta">
            {{ reais(data.totais.transferidoCents) }}
            <span v-if="data.totais.emCursoCents" class="block text-right text-xs text-alerta">
              +{{ reais(data.totais.emCursoCents) }} em curso
            </span>
          </dd>
        </div>
        <!-- O MESMO saldo do financeiro do evento e do da organização
             (`saldoParaSaque`): na plataforma − transferido − em curso. -->
        <div class="flex justify-between">
          <dt class="text-tinta-suave">A receber da plataforma</dt>
          <dd class="tabular-nums font-semibold text-tinta">{{ reais(data.totais.aReceberCents) }}</dd>
        </div>
        <div class="flex justify-between">
          <dt class="text-tinta-suave">Liberação</dt>
          <dd class="text-tinta" :class="data.evento.liberado ? 'text-ok' : 'text-alerta'">
            {{ data.evento.liberado ? 'liberado' : dataCurta(data.evento.liberaEm) }}
          </dd>
        </div>
      </dl>

      <!-- O recebido direto não é "a receber": já está com o produtor. Sem
           esta linha o líquido lá em cima fica maior que a soma de
           transferido + a receber, e a diferença parece dinheiro sumido. -->
      <p v-if="data.totais.recebidoDiretoCents" class="mt-3 text-sm text-tinta-suave"
         data-parte="recebido-direto">
        <strong class="text-tinta">{{ reais(data.totais.recebidoDiretoCents) }}</strong>
        recebidos direto (dinheiro no balcão, pix na sua chave ou Pix no Mercado Pago) já estão com você e não
        entram no saldo a receber da plataforma.
      </p>
    </section>

    <!-- ========================================================= público -->
    <section class="card mt-4">
      <h2 class="rotulo-kpi">Público</h2>
      <dl class="mt-3 grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-5">
        <div>
          <dt class="text-xs text-tinta-fraca">Ingressos emitidos</dt>
          <dd class="numero-kpi">{{ data.totais.ingressosEmitidos }}</dd>
        </div>
        <div>
          <dt class="text-xs text-tinta-fraca">Cortesias</dt>
          <dd class="numero-kpi" :class="data.totais.cortesias && 'text-alerta'">
            {{ data.totais.cortesias }}
          </dd>
        </div>
        <div>
          <dt class="text-xs text-tinta-fraca">Entraram</dt>
          <dd class="numero-kpi">{{ data.totais.ingressosUsados }}</dd>
          <dd v-if="data.totais.pessoasQueEntraram !== data.totais.ingressosUsados"
              class="text-xs text-tinta-fraca">
            {{ data.totais.pessoasQueEntraram }} pessoas
          </dd>
        </div>
        <div>
          <dt class="text-xs text-tinta-fraca">Comparecimento</dt>
          <dd class="numero-kpi">
            {{ Number(data.totais.comparecimentoPct).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) }}%
          </dd>
          <dd class="text-xs text-tinta-fraca">de {{ data.totais.aptos }} ingressos aptos</dd>
        </div>
        <div>
          <dt class="text-xs text-tinta-fraca">Cancelados</dt>
          <dd class="numero-kpi">{{ data.totais.ingressosCancelados }}</dd>
        </div>
      </dl>
      <p class="mt-3 text-sm text-tinta-suave">
        {{ data.totais.pedidosPagos }} pedido(s) pago(s) ·
        {{ data.totais.pedidosPendentes }} aguardando pagamento ·
        {{ data.totais.pedidosPerdidos }} cancelado(s) ou expirado(s)
      </p>
    </section>

    <!-- ========================================================= por lote -->
    <section class="card mt-4 overflow-x-auto p-0">
      <h2 class="rotulo-kpi px-4 pt-4">Por setor e lote</h2>
      <table class="tabela-cartoes mt-3 w-full min-w-[820px] border-collapse text-sm">
        <thead>
          <tr class="border-y border-linha bg-fundo-cinza/60 text-left">
            <th class="titulo px-4 py-2 text-xs font-semibold uppercase tracking-wide text-tinta-rotulo">Setor</th>
            <th class="titulo px-3 py-2 text-xs font-semibold uppercase tracking-wide text-tinta-rotulo">Lote</th>
            <th class="titulo px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-tinta-rotulo">Face unit.</th>
            <th class="titulo px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-tinta-rotulo">Estoque</th>
            <th class="titulo px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-tinta-rotulo">Vendidos</th>
            <th v-if="temCortesia" class="titulo px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-tinta-rotulo">Cortesias</th>
            <th class="titulo px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-tinta-rotulo">Face</th>
            <th class="titulo px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-tinta-rotulo">Taxa</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="l in data.lotes" :key="l.loteId" class="border-b border-linha last:border-0">
            <td class="px-4 py-2.5 text-tinta-suave">{{ l.setor }}</td>
            <td class="px-3 py-2.5 font-medium text-tinta">{{ l.lote }}</td>
            <td class="px-3 py-2.5 text-right tabular-nums text-tinta-suave">{{ reais(l.faceUnitCents) }}</td>
            <td class="px-3 py-2.5 text-right tabular-nums text-tinta-suave">{{ quantidadeNaTela(l.estoque) }}</td>
            <td class="px-3 py-2.5 text-right tabular-nums text-tinta">{{ l.vendidos }}</td>
            <td v-if="temCortesia" class="px-3 py-2.5 text-right tabular-nums"
                :class="l.cortesias ? 'text-alerta' : 'text-tinta-fraca'">
              {{ l.cortesias }}
            </td>
            <td class="px-3 py-2.5 text-right tabular-nums text-tinta">{{ reais(l.faceCents) }}</td>
            <td class="px-3 py-2.5 text-right tabular-nums text-tinta-suave">{{ reais(l.taxaCents) }}</td>
          </tr>
        </tbody>
        <tfoot>
          <tr class="border-t-2 border-linha-forte bg-fundo-cinza/60">
            <td class="px-4 py-3 font-semibold text-tinta" colspan="4">Total</td>
            <td class="px-3 py-3 text-right font-semibold tabular-nums text-tinta">
              {{ data.lotes.reduce((s: number, l: any) => s + l.vendidos, 0) }}
            </td>
            <td v-if="temCortesia" class="px-3 py-3 text-right font-semibold tabular-nums text-alerta">
              {{ data.lotes.reduce((s: number, l: any) => s + l.cortesias, 0) }}
            </td>
            <td class="px-3 py-3 text-right font-semibold tabular-nums text-tinta">
              {{ reais(data.totais.faceCents) }}
            </td>
            <td class="px-3 py-3 text-right font-semibold tabular-nums text-tinta-suave">
              {{ reais(data.totais.taxaCents) }}
            </td>
          </tr>
        </tfoot>
      </table>
    </section>

    <div class="mt-4 grid gap-4 lg:grid-cols-2">
      <!-- ======================================================= canais -->
      <section class="card overflow-x-auto p-0">
        <h2 class="rotulo-kpi px-4 pt-4">Por canal de venda</h2>
        <table class="mt-3 w-full border-collapse text-sm">
          <thead>
            <tr class="border-y border-linha bg-fundo-cinza/60 text-left">
              <th class="titulo px-4 py-2 text-xs font-semibold uppercase tracking-wide text-tinta-rotulo">Canal</th>
              <th class="titulo px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-tinta-rotulo">Pedidos</th>
              <th class="titulo px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-tinta-rotulo">Ingressos</th>
              <th class="titulo px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-tinta-rotulo">Face</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="c in data.canais" :key="c.canal" class="border-b border-linha last:border-0">
              <td class="px-4 py-2.5 text-tinta">{{ ROTULO_CANAL[c.canal] ?? c.canal }}</td>
              <td class="px-3 py-2.5 text-right tabular-nums text-tinta-suave">{{ c.pedidos }}</td>
              <td class="px-3 py-2.5 text-right tabular-nums text-tinta-suave">{{ c.ingressos }}</td>
              <td class="px-3 py-2.5 text-right tabular-nums text-tinta">{{ reais(c.faceCents) }}</td>
            </tr>
            <tr v-if="!data.canais.length">
              <td colspan="4" class="px-4 py-6 text-center text-tinta-fraca">Nenhuma venda paga ainda.</td>
            </tr>
          </tbody>
        </table>
      </section>

      <!-- ======================================================= formas -->
      <section class="card overflow-x-auto p-0">
        <h2 class="rotulo-kpi px-4 pt-4">Por forma de pagamento</h2>
        <table class="mt-3 w-full border-collapse text-sm">
          <thead>
            <tr class="border-y border-linha bg-fundo-cinza/60 text-left">
              <th class="titulo px-4 py-2 text-xs font-semibold uppercase tracking-wide text-tinta-rotulo">Forma</th>
              <th class="titulo px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-tinta-rotulo">Pedidos</th>
              <th class="titulo px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-tinta-rotulo">Total cobrado</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="f in data.formas" :key="f.forma" class="border-b border-linha last:border-0">
              <td class="px-4 py-2.5 text-tinta">{{ ROTULO_FORMA[f.forma] ?? f.forma }}</td>
              <td class="px-3 py-2.5 text-right tabular-nums text-tinta-suave">{{ f.pedidos }}</td>
              <td class="px-3 py-2.5 text-right tabular-nums text-tinta">{{ reais(f.totalCents) }}</td>
            </tr>
            <tr v-if="!data.formas.length">
              <td colspan="3" class="px-4 py-6 text-center text-tinta-fraca">Nenhuma venda paga ainda.</td>
            </tr>
          </tbody>
        </table>
      </section>
    </div>
  </div>

  <p v-else-if="pending" class="card mt-6 text-tinta-suave">Carregando…</p>

  <div v-else class="card mt-6">
    <p class="rotulo-kpi text-erro">Não foi possível carregar o borderô</p>
    <p class="mt-1 text-sm text-tinta-suave">
      {{ (falha as any)?.data?.statusMessage || (falha as any)?.message || 'Erro desconhecido.' }}
    </p>
    <button type="button" class="btn-secundario mt-3" @click="refresh()">Tentar de novo</button>
  </div>
</template>

<style>
/* A folha do borderô no papel, sem o painel em volta (ADM-47) — ver `isolarParaImpressao`. */
@media print {
  .fora-da-impressao { display: none !important; }
  .caminho-da-impressao { margin: 0 !important; padding: 0 !important; max-width: none !important;
                          box-shadow: none !important; background: #fff !important; }
  .folha-bordero .card { box-shadow: none; break-inside: avoid; }
}
</style>
