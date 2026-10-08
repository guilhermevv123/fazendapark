<script lang="ts">
/**
 * As contas desta tela que não dependem de estado — exportadas pra teste
 * (`app/composables/evento-relatorios.test.ts`): o teste roda estas linhas, não uma cópia.
 */
import { diaLocal, paraData } from '~/composables/formato'

/**
 * O dia seguinte de um `AAAA-MM-DD` — pelos conversores da casa (`paraData` nasce à meia-noite
 * LOCAL do dia de calendário; `setDate` anda um dia de calendário, não 24 h, e horário de verão
 * nenhum pula dia). O `toISOString` que morava aqui é o que a trava de formato.test.ts proíbe.
 */
function diaSeguinte(dia: string): string {
  const d = paraData(dia) as Date
  d.setDate(d.getDate() + 1)
  return diaLocal(d)
}

/** teto da série: 10 anos de dias. Data torta não vira laço sem fim na tela. */
const MAIS_DIAS = 3660

/**
 * A série por dia SEM BURACO (ADM-30): do primeiro ao último dia com venda, e o dia sem venda
 * entra com zero. Antes o dia vazio sumia do gráfico e duas semanas paradas ficavam coladas,
 * como se a venda nunca tivesse parado. O dia chega como `AAAA-MM-DD` (calendário do evento).
 */
export function serieDiaria<T extends { dia: string }>(dias: T[], vazio: (dia: string) => T): T[] {
  const validos = dias.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d.dia)))
  if (!validos.length) return []
  const porDia = new Map(validos.map((d) => [d.dia, d]))
  const ordem = [...porDia.keys()].sort()
  const fim = ordem[ordem.length - 1]
  const saida: T[] = []
  for (let d = ordem[0]; d <= fim && saida.length < MAIS_DIAS; d = diaSeguinte(d)) {
    saida.push(porDia.get(d) ?? vazio(d))
  }
  return saida
}

/** as 24 horas do dia, hora sem venda = 0 (o gráfico começava na primeira hora com venda) */
export function vinteQuatroHoras(horas: { hora: number; pedidos: number }[]) {
  const m = new Map(horas.map((h) => [Number(h.hora), Number(h.pedidos)]))
  return Array.from({ length: 24 }, (_, hora) => ({ hora, pedidos: m.get(hora) ?? 0 }))
}

/** os 7 dias da semana (0 = domingo), dia sem venda = 0 */
export function seteDias(dias: { dow: number; pedidos: number }[]) {
  const m = new Map(dias.map((d) => [Number(d.dow), Number(d.pedidos)]))
  return Array.from({ length: 7 }, (_, dow) => ({ dow, pedidos: m.get(dow) ?? 0 }))
}

/** largura mínima de cada barra do gráfico por dia, com o vão: passou disso, rola dentro do card */
export const PX_POR_DIA = 5
</script>

<script setup lang="ts">
/**
 * Relatórios — visão geral.
 *
 * O dashboard responde "como estamos agora". Esta tela responde "como
 * chegamos até aqui": curva de venda, funil, quem trouxe, e quando a venda
 * acontece de verdade em relação ao dia do evento.
 *
 * A antecedência é o número que muda decisão: se metade vende na última
 * semana, adiantar o anúncio não resolve — o que resolve é ter lote aberto
 * naquela semana.
 */
definePageMeta({ layout: 'admin' })

const route = useRoute()
const id = route.params.id as string

const { data, pending, error: falha, refresh } = await useFetch<any>(
  `/api/admin/evento/${id}/relatorios`)

// dinheiro e data saem de `app/composables/formato.ts` (`reais`, `dataCurta`), num lugar só:
// cada tela que refazia `(c / 100).toLocaleString(...)` na mão era mais uma chance de perder
// centavo ou de escorregar um dia.

/** número com a vírgula daqui ("1,5 ingresso por pedido", não "1.5") */
const num = (n: number) => Number(n ?? 0).toLocaleString('pt-BR', { maximumFractionDigits: 2 })

const vazioDoDia = (dia: string) => ({ dia, pedidos: 0, pedidosComEstorno: 0, cobradoCents: 0,
  faceCents: 0, estornadoNoLiquidoCents: 0, liquidoCents: 0 })
const serieDias = computed(() => serieDiaria(data.value?.porDia ?? [], vazioDoDia))
const diasComVenda = computed(() => (data.value?.porDia ?? []).length)
const picoDia = computed(() =>
  serieDias.value.reduce((m: number, d: any) => Math.max(m, d.cobradoCents), 0))

/**
 * O gráfico por dia abre no FIM (a venda de agora), e o começo fica a um arrasto. Vigia o próprio
 * elemento: com o `await useFetch` no setup, a série já chega pronta ANTES de o card existir.
 */
const rolagemDias = ref<HTMLElement | null>(null)
watch([rolagemDias, serieDias], () => nextTick(() => {
  const el = rolagemDias.value
  if (el) el.scrollLeft = el.scrollWidth
}))

const DIAS = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado']
const semana = computed(() => seteDias(data.value?.porDiaSemana ?? []))
const picoDow = computed(() => semana.value.reduce((m: number, d: any) => Math.max(m, d.pedidos), 0))

const horas = computed(() => vinteQuatroHoras(data.value?.porHoraDoDia ?? []))
const picoHora = computed(() => horas.value.reduce((m: number, h: any) => Math.max(m, h.pedidos), 0))

/**
 * Antecedência em faixas, não dia a dia: "21 dias antes" sozinho não decide
 * nada, "56% vendeu no último mês" decide. As faixas são as janelas em que se
 * toma decisão de mídia.
 */
const FAIXAS = [
  { ate: 3, rotulo: 'Últimos 3 dias' },
  { ate: 7, rotulo: '4 a 7 dias antes' },
  { ate: 15, rotulo: '8 a 15 dias antes' },
  { ate: 30, rotulo: '16 a 30 dias antes' },
  { ate: 60, rotulo: '31 a 60 dias antes' },
  { ate: Infinity, rotulo: 'Mais de 60 dias antes' },
]
const antecedencia = computed(() => {
  const linhas = data.value?.antecedencia ?? []
  const total = linhas.reduce((s: number, a: any) => s + a.pedidos, 0)
  let anterior = -1
  return FAIXAS.map((f) => {
    const n = linhas.filter((a: any) => a.dias > anterior && a.dias <= f.ate)
      .reduce((s: number, a: any) => s + a.pedidos, 0)
    anterior = f.ate
    return { ...f, pedidos: n, pct: total > 0 ? Math.round((n / total) * 100) : 0 }
  }).filter((f) => f.pedidos > 0)
})

const ROTULO_STATUS: Record<string, string> = {
  pago: 'Pago', aguardando_pagamento: 'Aguardando pagamento', em_analise: 'Em análise',
  expirado: 'Expirou sem pagar', cancelado: 'Cancelado', falhou: 'Pagamento falhou',
  estornado: 'Estornado', estornado_parcial: 'Estornado em parte',
  chargeback: 'Chargeback', disputa: 'Em disputa',
}

/**
 * O CSV sai pelo `baixarCsv` da casa (ADM-35): o nome do evento é texto livre, e a cópia local
 * deste arquivo não protegia contra fórmula (`=HYPERLINK(…)` virava link no Excel de quem abre).
 */
function exportar() {
  const r = data.value.resumo
  const f = data.value.funil
  const linhas: (string | number)[][] = [
    ['Evento', data.value.evento.nome],
    ['Pedidos pagos', r.pedidos], ['Ingressos', r.ingressos],
    ['Ticket médio', reais(r.ticketMedioCents)], ['Por ingresso', reais(r.porIngressoCents)],
    ['Ingressos por pedido', num(r.ingressosPorPedido)],
    ['Face', reais(r.faceCents)], ['Taxa de serviço', reais(r.taxaCents)],
    ['Descontos', reais(r.descontoCents)], ['Cobrado', reais(r.cobradoCents)],
    ['Conversão do site', `${f.conversaoPct}%`],
    ['Pedidos do site', `${f.finalizados ?? f.pagos} pagos de ${f.criados}`],
    [],
    ['Dia', 'Pedidos', 'Cobrado', 'Face'],
    ...serieDias.value.map((d: any) => [dataCurta(d.dia), d.pedidos, reais(d.cobradoCents), reais(d.faceCents)]),
  ]
  baixarCsv(`relatorio-${id.slice(0, 8)}`, ['Indicador', 'Valor'], linhas)
}

useHead({ title: 'Relatórios' })
</script>

<template>
  <div v-if="data">
    <div class="flex flex-wrap items-start justify-between gap-3 py-5">
      <div>
        <h1 class="titulo text-2xl font-semibold text-tinta">Relatórios</h1>
        <p class="mt-1 text-tinta-suave">
          Como a venda chegou até aqui — curva, funil e origem.
        </p>
      </div>
      <button type="button" class="btn-secundario" @click="exportar">
        <IconeMenu nome="exportar" :tamanho="18" /> Exportar
      </button>
    </div>

    <AbasSecao :evento-id="id" />

    <div class="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <div class="card">
        <p class="rotulo-kpi">Ticket médio</p>
        <p class="numero-kpi mt-1">{{ reais(data.resumo.ticketMedioCents) }}</p>
        <p class="mt-1 text-xs text-tinta-fraca">
          por pedido · {{ num(data.resumo.ingressosPorPedido) }} ingressos cada
        </p>
      </div>
      <div class="card">
        <p class="rotulo-kpi">Por ingresso</p>
        <p class="numero-kpi mt-1">{{ reais(data.resumo.porIngressoCents) }}</p>
        <p class="mt-1 text-xs text-tinta-fraca">{{ data.resumo.ingressos }} ingressos</p>
      </div>
      <div class="card" data-parte="conversao">
        <p class="rotulo-kpi">Conversão do site</p>
        <p class="numero-kpi mt-1">{{ data.funil.conversaoPct }}%</p>
        <p class="mt-1 text-xs text-tinta-fraca">
          {{ data.funil.finalizados ?? data.funil.pagos }} pagos de {{ data.funil.criados }} pedidos online
        </p>
      </div>
      <div class="card">
        <p class="rotulo-kpi">Total cobrado</p>
        <p class="numero-kpi mt-1">{{ reais(data.resumo.cobradoCents) }}</p>
        <p class="mt-1 text-xs text-tinta-fraca">
          face {{ reais(data.resumo.faceCents) }} + taxa {{ reais(data.resumo.taxaCents) }}
        </p>
      </div>
    </div>

    <div v-if="serieDias.length" class="card mt-4" data-parte="por-dia">
      <div class="flex items-baseline justify-between">
        <p class="rotulo-kpi">Vendas por dia</p>
        <p class="text-xs text-tinta-fraca">maior dia: {{ reais(picoDia) }}</p>
      </div>
      <!-- Um dia, uma barra — o dia sem venda também, com zero (ADM-30). Com muitos dias o gráfico
           rola DENTRO do card (e abre no fim): antes, 200 dias de 6px + vão davam ~2.400px de
           página. -->
      <div ref="rolagemDias" class="mt-3 overflow-x-auto" data-parte="rolagem-dias">
        <div class="flex items-end gap-px" style="height: 130px"
             :style="{ minWidth: `${serieDias.length * PX_POR_DIA}px` }">
          <div v-for="d in serieDias" :key="d.dia"
               class="group relative min-w-[4px] flex-1" data-parte="barra-dia"
               :title="`${dataCurta(d.dia)} — ${d.pedidos} pedidos, ${reais(d.cobradoCents)}`">
            <div class="rounded-t transition-opacity group-hover:opacity-75"
                 :class="d.pedidos ? 'bg-acao' : 'bg-linha'"
                 :style="{ height: `${picoDia && d.cobradoCents ? Math.max((d.cobradoCents / picoDia) * 118, 2) : 2}px` }" />
          </div>
        </div>
      </div>
      <div class="mt-1 flex justify-between gap-2 text-xs text-tinta-fraca">
        <span>{{ dataCurta(serieDias[0].dia) }}</span>
        <span data-parte="dias-resumo">
          {{ serieDias.length }} {{ serieDias.length === 1 ? 'dia' : 'dias' }} · {{ diasComVenda }} com venda
        </span>
        <span>{{ dataCurta(serieDias[serieDias.length - 1].dia) }}</span>
      </div>
    </div>

    <div class="mt-4 grid gap-3 lg:grid-cols-2">
      <div class="card">
        <p class="rotulo-kpi">Funil do checkout online</p>
        <div class="mt-3 overflow-x-auto">
          <table class="w-full text-sm">
          <tbody>
            <tr v-for="s in data.funil.porStatus" :key="s.status"
                class="border-b border-linha last:border-0">
              <td class="py-2 text-tinta">{{ ROTULO_STATUS[s.status] ?? s.status }}</td>
              <td class="py-2 text-right tabular-nums text-tinta">{{ s.n }}</td>
              <td class="w-24 py-2 pl-3">
                <div class="h-1.5 rounded-full bg-fundo-cinza">
                  <div class="h-1.5 rounded-full"
                       :class="s.status === 'pago' ? 'bg-ok' : s.status === 'aguardando_pagamento' ? 'bg-alerta' : 'bg-linha-forte'"
                       :style="{ width: `${data.funil.criados ? (s.n / data.funil.criados) * 100 : 0}%` }" />
                </div>
              </td>
              <td class="w-12 py-2 text-right text-xs tabular-nums text-tinta-fraca">
                {{ data.funil.criados ? Math.round((s.n / data.funil.criados) * 100) : 0 }}%
              </td>
            </tr>
          </tbody>
        </table>
        </div>
        <p class="mt-3 text-xs text-tinta-fraca">
          {{ data.funil.abandonoPct }}% dos pedidos do site não chegaram ao pagamento.
          Balcão e cortesia não entram: não têm carrinho, nascem pagos. Rascunho também não —
          só pedido que chegou a existir de verdade.
        </p>
      </div>

      <div class="card">
        <p class="rotulo-kpi">Quando a venda acontece</p>
        <p class="mt-0.5 text-xs text-tinta-fraca">em relação ao dia do evento</p>
        <div class="mt-3 overflow-x-auto">
          <table class="w-full text-sm">
          <tbody>
            <tr v-for="f in antecedencia" :key="f.rotulo" class="border-b border-linha last:border-0">
              <td class="py-2 text-tinta">{{ f.rotulo }}</td>
              <td class="py-2 text-right tabular-nums text-tinta-suave">{{ f.pedidos }}</td>
              <td class="w-28 py-2 pl-3">
                <div class="h-1.5 rounded-full bg-fundo-cinza">
                  <div class="h-1.5 rounded-full bg-acao" :style="{ width: `${f.pct}%` }" />
                </div>
              </td>
              <td class="w-12 py-2 text-right text-xs tabular-nums text-tinta-fraca">{{ f.pct }}%</td>
            </tr>
          </tbody>
        </table>
        </div>
      </div>
    </div>

    <div class="mt-4 grid gap-3 lg:grid-cols-2">
      <div v-if="data.porDiaSemana.length" class="card" data-parte="por-semana">
        <p class="rotulo-kpi">Por dia da semana</p>
        <div class="mt-3 flex items-end gap-2" style="height: 96px">
          <div v-for="d in semana" :key="d.dow" class="flex-1 text-center">
            <div class="mx-auto w-full rounded-t bg-acao"
                 :style="{ height: `${picoDow ? Math.max((d.pedidos / picoDow) * 74, 2) : 2}px` }"
                 :title="`${DIAS[d.dow]} — ${d.pedidos} pedidos`" />
          </div>
        </div>
        <div class="mt-1 flex gap-2 text-center text-xs text-tinta-fraca">
          <span v-for="d in semana" :key="d.dow" class="flex-1">
            {{ DIAS[d.dow].slice(0, 3) }}
          </span>
        </div>
      </div>

      <div v-if="data.porHoraDoDia.length" class="card" data-parte="por-hora">
        <p class="rotulo-kpi">Por hora do dia</p>
        <!-- as 24 horas sempre (ADM-30): começar na primeira hora com venda escondia a madrugada
             parada e mudava a escala de um evento pro outro -->
        <div class="mt-3 flex items-end gap-0.5" style="height: 96px">
          <div v-for="h in horas" :key="h.hora" class="flex-1" data-parte="barra-hora"
               :title="`${String(h.hora).padStart(2, '0')}h — ${h.pedidos} pedidos`">
            <div class="rounded-t" :class="h.pedidos ? 'bg-acao' : 'bg-linha'"
                 :style="{ height: `${picoHora && h.pedidos ? Math.max((h.pedidos / picoHora) * 74, 2) : 2}px` }" />
          </div>
        </div>
        <div class="mt-1 flex justify-between text-xs text-tinta-fraca">
          <span>00h</span><span>06h</span><span>12h</span><span>18h</span><span>23h</span>
        </div>
        <p class="mt-1 text-xs text-tinta-fraca">pico: {{ picoHora }} pedidos numa hora · no fuso do evento</p>
      </div>
    </div>

    <div v-if="data.porPromoter.length || data.porCupom.length" class="mt-4 grid gap-3 lg:grid-cols-2">
      <div v-if="data.porPromoter.length" class="card p-0">
        <p class="titulo border-b border-linha px-4 py-3 text-sm font-semibold text-tinta-rotulo">
          O que cada promoter trouxe
        </p>
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
          <tbody>
            <tr v-for="p in data.porPromoter" :key="p.id" class="border-b border-linha last:border-0">
              <td class="px-4 py-2.5">
                <p class="text-tinta">{{ p.nome }}</p>
                <p class="font-mono text-xs text-tinta-fraca">{{ p.codigo }}</p>
              </td>
              <td class="px-3 py-2.5 text-right tabular-nums text-tinta-suave">
                {{ p.ingressos }} ing.
              </td>
              <td class="px-3 py-2.5 text-right tabular-nums text-tinta">{{ reais(p.faceCents) }}</td>
              <td class="px-4 py-2.5 text-right tabular-nums text-acao">
                {{ reais(p.comissaoCents) }}
                <span class="block text-xs text-tinta-fraca">comissão</span>
              </td>
            </tr>
          </tbody>
        </table>
        </div>
      </div>

      <div v-if="data.porCupom.length" class="card p-0">
        <p class="titulo border-b border-linha px-4 py-3 text-sm font-semibold text-tinta-rotulo">
          Cupons usados
        </p>
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
          <tbody>
            <tr v-for="c in data.porCupom" :key="c.id" class="border-b border-linha last:border-0">
              <td class="px-4 py-2.5 font-mono text-acao">{{ c.codigo }}</td>
              <td class="px-3 py-2.5 text-right tabular-nums text-tinta-suave">{{ c.usos }} usos</td>
              <td class="px-3 py-2.5 text-right tabular-nums text-tinta">{{ reais(c.faceCents) }}</td>
              <td class="px-4 py-2.5 text-right tabular-nums text-erro">
                −{{ reais(c.descontoCents) }}
                <span class="block text-xs text-tinta-fraca">desconto</span>
              </td>
            </tr>
          </tbody>
        </table>
        </div>
      </div>
    </div>

    <div v-if="data.topCompradores.length" class="card mt-4 p-0">
      <p class="titulo border-b border-linha px-4 py-3 text-sm font-semibold text-tinta-rotulo">
        Quem mais comprou
      </p>
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
        <tbody>
          <tr v-for="(c, i) in data.topCompradores" :key="c.id"
              class="border-b border-linha last:border-0">
            <td class="w-8 px-4 py-2.5 text-xs tabular-nums text-tinta-fraca">{{ i + 1 }}</td>
            <td class="py-2.5">
              <p class="text-tinta">{{ c.nome }}</p>
              <p class="text-xs text-tinta-fraca [overflow-wrap:anywhere]">{{ c.email }}</p>
            </td>
            <td class="px-3 py-2.5 text-right tabular-nums text-tinta-suave">
              {{ c.pedidos }} ped. · {{ c.ingressos }} ing.
            </td>
            <td class="px-4 py-2.5 text-right font-medium tabular-nums text-tinta">
              {{ reais(c.gastoCents) }}
            </td>
          </tr>
        </tbody>
      </table>
      </div>
    </div>

    <div v-if="data.porParcela.length" class="card mt-4">
      <p class="rotulo-kpi">Parcelamento no crédito</p>
      <div class="mt-3 flex flex-wrap gap-4">
        <div v-for="p in data.porParcela" :key="p.parcelas">
          <p class="titulo text-lg font-semibold text-tinta">{{ p.parcelas }}×</p>
          <p class="text-xs text-tinta-fraca">{{ p.pedidos }} pedidos · {{ reais(p.cobradoCents) }}</p>
        </div>
      </div>
    </div>
  </div>

  <p v-else-if="pending" class="card mt-6 text-tinta-suave">Carregando…</p>

  <div v-else class="card mt-6">
    <p class="rotulo-kpi text-erro">Não foi possível carregar o relatório</p>
    <p class="mt-1 text-sm text-tinta-suave">
      {{ (falha as any)?.data?.statusMessage || (falha as any)?.message || 'Erro desconhecido.' }}
    </p>
    <button type="button" class="btn-secundario mt-3" @click="refresh()">Tentar de novo</button>
  </div>
</template>
