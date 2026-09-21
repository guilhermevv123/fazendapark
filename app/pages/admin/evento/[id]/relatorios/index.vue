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

// dinheiro e data saem de `app/composables/formato.ts`, num lugar só: cada
// tela que refazia `(c / 100).toLocaleString(...)` e `new Date(x).toLocale…`
// na mão era mais uma chance de perder centavo ou de escorregar um dia.
const brl = reais

const picoDia = computed(() =>
  (data.value?.porDia ?? []).reduce((m: number, d: any) => Math.max(m, d.cobradoCents), 0))

const DIAS = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado']
const picoDow = computed(() =>
  (data.value?.porDiaSemana ?? []).reduce((m: number, d: any) => Math.max(m, d.pedidos), 0))

const picoHora = computed(() =>
  (data.value?.porHoraDoDia ?? []).reduce((m: number, h: any) => Math.max(m, h.pedidos), 0))

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

function exportar() {
  const l: string[][] = [['Relatório', data.value.evento.nome], []]
  l.push(['Indicador', 'Valor'])
  const r = data.value.resumo
  l.push(['Pedidos pagos', String(r.pedidos)], ['Ingressos', String(r.ingressos)],
         ['Ticket médio', brl(r.ticketMedioCents)], ['Por ingresso', brl(r.porIngressoCents)],
         ['Ingressos por pedido', String(r.ingressosPorPedido)],
         ['Face', brl(r.faceCents)], ['Taxa de serviço', brl(r.taxaCents)],
         ['Descontos', brl(r.descontoCents)], ['Cobrado', brl(r.cobradoCents)],
         ['Conversão', `${data.value.funil.conversaoPct}%`])
  l.push([], ['Dia', 'Pedidos', 'Cobrado', 'Face'])
  for (const d of data.value.porDia) {
    l.push([dataCurta(d.dia), String(d.pedidos),
            brl(d.cobradoCents), brl(d.faceCents)])
  }
  const csv = l.map((x) => x.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(';')).join('\r\n')
  const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = `relatorio-${id.slice(0, 8)}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

useHead({ title: 'Relatórios' })
</script>

<template>
  <div v-if="data">
    <div class="flex flex-wrap items-start justify-between gap-3 py-5">
      <div>
        <h1 class="titulo text-2xl font-bold text-tinta">Relatórios</h1>
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
        <p class="numero-kpi mt-1">{{ brl(data.resumo.ticketMedioCents) }}</p>
        <p class="mt-1 text-xs text-tinta-fraca">
          por pedido · {{ data.resumo.ingressosPorPedido }} ingressos cada
        </p>
      </div>
      <div class="card">
        <p class="rotulo-kpi">Por ingresso</p>
        <p class="numero-kpi mt-1">{{ brl(data.resumo.porIngressoCents) }}</p>
        <p class="mt-1 text-xs text-tinta-fraca">{{ data.resumo.ingressos }} ingressos</p>
      </div>
      <div class="card">
        <p class="rotulo-kpi">Conversão</p>
        <p class="numero-kpi mt-1">{{ data.funil.conversaoPct }}%</p>
        <p class="mt-1 text-xs text-tinta-fraca">
          {{ data.funil.pagos }} pagos de {{ data.funil.criados }} pedidos
        </p>
      </div>
      <div class="card">
        <p class="rotulo-kpi">Total cobrado</p>
        <p class="numero-kpi mt-1">{{ brl(data.resumo.cobradoCents) }}</p>
        <p class="mt-1 text-xs text-tinta-fraca">
          face {{ brl(data.resumo.faceCents) }} + taxa {{ brl(data.resumo.taxaCents) }}
        </p>
      </div>
    </div>

    <div v-if="data.porDia.length" class="card mt-4">
      <div class="flex items-baseline justify-between">
        <p class="rotulo-kpi">Vendas por dia</p>
        <p class="text-xs text-tinta-fraca">maior dia: {{ brl(picoDia) }}</p>
      </div>
      <div class="mt-3 flex items-end gap-1.5" style="height: 130px">
        <div v-for="d in data.porDia" :key="d.dia"
             class="group relative flex-1 min-w-[6px]"
             :title="`${dataCurta(d.dia)} — ${d.pedidos} pedidos, ${brl(d.cobradoCents)}`">
          <div class="rounded-t bg-acao transition-opacity group-hover:opacity-75"
               :style="{ height: `${picoDia ? Math.max((d.cobradoCents / picoDia) * 118, 2) : 2}px` }" />
        </div>
      </div>
      <div class="mt-1 flex justify-between text-xs text-tinta-fraca">
        <span>{{ dataCurta(data.porDia[0].dia) }}</span>
        <span>{{ data.porDia.length }} dias com venda</span>
        <span>{{ dataCurta(data.porDia[data.porDia.length - 1].dia) }}</span>
      </div>
    </div>

    <div class="mt-4 grid gap-3 lg:grid-cols-2">
      <div class="card">
        <p class="rotulo-kpi">Funil de pedidos</p>
        <table class="mt-3 w-full text-sm">
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
        <p class="mt-3 text-xs text-tinta-fraca">
          {{ data.funil.abandonoPct }}% dos pedidos não chegaram ao pagamento.
          Rascunho não entra nesta conta — só pedido que chegou a existir de verdade.
        </p>
      </div>

      <div class="card">
        <p class="rotulo-kpi">Quando a venda acontece</p>
        <p class="mt-0.5 text-xs text-tinta-fraca">em relação ao dia do evento</p>
        <table class="mt-3 w-full text-sm">
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

    <div class="mt-4 grid gap-3 lg:grid-cols-2">
      <div v-if="data.porDiaSemana.length" class="card">
        <p class="rotulo-kpi">Por dia da semana</p>
        <div class="mt-3 flex items-end gap-2" style="height: 96px">
          <div v-for="d in data.porDiaSemana" :key="d.dow" class="flex-1 text-center">
            <div class="mx-auto w-full rounded-t bg-acao"
                 :style="{ height: `${picoDow ? Math.max((d.pedidos / picoDow) * 74, 2) : 2}px` }"
                 :title="`${DIAS[d.dow]} — ${d.pedidos} pedidos`" />
          </div>
        </div>
        <div class="mt-1 flex gap-2 text-center text-xs text-tinta-fraca">
          <span v-for="d in data.porDiaSemana" :key="d.dow" class="flex-1">
            {{ DIAS[d.dow].slice(0, 3) }}
          </span>
        </div>
      </div>

      <div v-if="data.porHoraDoDia.length" class="card">
        <p class="rotulo-kpi">Por hora do dia</p>
        <div class="mt-3 flex items-end gap-1" style="height: 96px">
          <div v-for="h in data.porHoraDoDia" :key="h.hora" class="flex-1"
               :title="`${String(h.hora).padStart(2, '0')}h — ${h.pedidos} pedidos`">
            <div class="rounded-t bg-acao"
                 :style="{ height: `${picoHora ? Math.max((h.pedidos / picoHora) * 74, 2) : 2}px` }" />
          </div>
        </div>
        <div class="mt-1 flex justify-between text-xs text-tinta-fraca">
          <span>{{ String(data.porHoraDoDia[0].hora).padStart(2, '0') }}h</span>
          <span>pico {{ picoHora }} pedidos</span>
          <span>{{ String(data.porHoraDoDia[data.porHoraDoDia.length - 1].hora).padStart(2, '0') }}h</span>
        </div>
      </div>
    </div>

    <div v-if="data.porPromoter.length || data.porCupom.length" class="mt-4 grid gap-3 lg:grid-cols-2">
      <div v-if="data.porPromoter.length" class="card p-0">
        <p class="titulo border-b border-linha px-4 py-3 text-sm font-bold text-tinta-rotulo">
          O que cada promoter trouxe
        </p>
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
              <td class="px-3 py-2.5 text-right tabular-nums text-tinta">{{ brl(p.faceCents) }}</td>
              <td class="px-4 py-2.5 text-right tabular-nums text-acao">
                {{ brl(p.comissaoCents) }}
                <span class="block text-xs text-tinta-fraca">comissão</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-if="data.porCupom.length" class="card p-0">
        <p class="titulo border-b border-linha px-4 py-3 text-sm font-bold text-tinta-rotulo">
          Cupons usados
        </p>
        <table class="w-full text-sm">
          <tbody>
            <tr v-for="c in data.porCupom" :key="c.id" class="border-b border-linha last:border-0">
              <td class="px-4 py-2.5 font-mono text-acao">{{ c.codigo }}</td>
              <td class="px-3 py-2.5 text-right tabular-nums text-tinta-suave">{{ c.usos }} usos</td>
              <td class="px-3 py-2.5 text-right tabular-nums text-tinta">{{ brl(c.faceCents) }}</td>
              <td class="px-4 py-2.5 text-right tabular-nums text-erro">
                −{{ brl(c.descontoCents) }}
                <span class="block text-xs text-tinta-fraca">desconto</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div v-if="data.topCompradores.length" class="card mt-4 p-0">
      <p class="titulo border-b border-linha px-4 py-3 text-sm font-bold text-tinta-rotulo">
        Quem mais comprou
      </p>
      <table class="w-full text-sm">
        <tbody>
          <tr v-for="(c, i) in data.topCompradores" :key="c.id"
              class="border-b border-linha last:border-0">
            <td class="w-8 px-4 py-2.5 text-xs tabular-nums text-tinta-fraca">{{ i + 1 }}</td>
            <td class="py-2.5">
              <p class="text-tinta">{{ c.nome }}</p>
              <p class="text-xs text-tinta-fraca">{{ c.email }}</p>
            </td>
            <td class="px-3 py-2.5 text-right tabular-nums text-tinta-suave">
              {{ c.pedidos }} ped. · {{ c.ingressos }} ing.
            </td>
            <td class="px-4 py-2.5 text-right font-medium tabular-nums text-tinta">
              {{ brl(c.gastoCents) }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="data.porParcela.length" class="card mt-4">
      <p class="rotulo-kpi">Parcelamento no crédito</p>
      <div class="mt-3 flex flex-wrap gap-4">
        <div v-for="p in data.porParcela" :key="p.parcelas">
          <p class="titulo text-lg font-bold text-tinta">{{ p.parcelas }}×</p>
          <p class="text-xs text-tinta-fraca">{{ p.pedidos }} pedidos · {{ brl(p.cobradoCents) }}</p>
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
