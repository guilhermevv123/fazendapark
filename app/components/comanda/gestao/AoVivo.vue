<script setup lang="ts">
/**
 * Visão geral (055): o painel do dia, atualizado a cada 30 s. Os números que importam
 * (vendido, recebido, a receber, ticket médio, quem saiu sem pagar), o movimento por hora,
 * os locais, os produtos que mais saem, as formas de pagamento e as contas abertas agora.
 *
 * Tablet só aparece aqui quando tem problema (sem internet ou com pedido guardado).
 */
import { chamar, mensagemDoErro } from '~/composables/comandaOffline'
import { dataHora, reais } from '~/composables/formato'
import ComandaGraficoColunas from '~/components/comanda/GraficoColunas.vue'

const vivo = ref<any>(null)
const vendas = ref<any>(null)
const dia = ref<any>(null)
const erro = ref('')
let laco: ReturnType<typeof setInterval> | undefined
async function carregar() {
  try {
    const [a, b, c] = await Promise.all([
      chamar<any>('/api/comandas/gestao/aovivo'),
      chamar<any>('/api/comandas/gestao/vendas'),
      chamar<any>('/api/comandas/gestao/resumo'),
    ])
    vivo.value = a; vendas.value = b; dia.value = c; erro.value = ''
  } catch (e) { erro.value = mensagemDoErro(e) }
}
onMounted(() => { carregar(); laco = setInterval(carregar, 30_000) })
onBeforeUnmount(() => clearInterval(laco))

const FORMA: Record<string, { nome: string; cor: string }> = {
  pix: { nome: 'Pix', cor: '#146f83' }, credito: { nome: 'Crédito', cor: '#1789a1' },
  debito: { nome: 'Débito', cor: '#7cc6d6' }, dinheiro: { nome: 'Dinheiro', cor: '#c8c5d5' },
}
const pct = (v: number, t: number) => (t ? Math.round((v / t) * 100) : 0)

/** das 8h às 19h (ou o que tiver venda fora disso), com a hora de agora em destaque */
const horas = computed(() => {
  const l = vendas.value?.porHora ?? []
  const comVenda = l.map((h: any) => h.hora)
  const de = Math.min(8, ...comVenda)
  const ate = Math.max(19, ...comVenda)
  return Array.from({ length: ate - de + 1 }, (_, k) => {
    const h = de + k
    const x = l.find((y: any) => y.hora === h)
    return { rotulo: `${h}h`, valor: x?.vendidoCents ?? 0, extra: x ? `${x.pedidos} pedido(s)` : undefined }
  })
})
const horaAgora = computed(() => {
  const h = Number(new Date().toLocaleString('pt-BR', { timeZone: 'America/Bahia', hour: '2-digit', hour12: false }))
  return horas.value.findIndex((p) => p.rotulo === `${h}h`)
})
const pico = computed(() => [...(vendas.value?.porHora ?? [])].sort((a: any, b: any) => b.vendidoCents - a.vendidoCents)[0])
const tabletsComProblema = computed(() => (vivo.value?.aparelhos ?? []).filter((a: any) => a.pendentes || a.semSinalHaMin >= 2))
const ha = (iso: string) => {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60_000)
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`
}
</script>

<template>
  <div class="space-y-4">
    <p v-if="erro" class="faixa-erro">{{ erro }}</p>
    <p v-if="tabletsComProblema.length" class="faixa-erro">
      {{ tabletsComProblema.length }} tablet(s) sem internet ou com pedido guardado:
      {{ tabletsComProblema.map((a: any) => `${a.nome}${a.pendentes ? ` (${a.pendentes} pedido(s) esperando)` : ''}`).join(', ') }}.
    </p>

    <template v-if="vivo && vendas && dia">
      <!-- números -->
      <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div class="card p-5">
          <p class="rotulo-kpi">Vendido hoje</p>
          <p class="numero-kpi mt-1">{{ reais(vendas.vendidoCents) }}</p>
          <p class="mt-1 text-xs text-ink-600">{{ vendas.pedidos }} pedidos · {{ vendas.itens }} itens</p>
        </div>
        <div class="card p-5">
          <p class="rotulo-kpi">Recebido hoje</p>
          <p class="numero-kpi mt-1 text-ok">{{ reais(vendas.recebidoCents) }}</p>
          <div class="mt-2 h-1.5 rounded-full bg-ink-100"><div class="h-1.5 rounded-full bg-ok" :style="{ width: `${Math.min(100, pct(vendas.recebidoCents, vendas.vendidoCents))}%` }" /></div>
          <p class="mt-1 text-xs text-ink-600">{{ pct(vendas.recebidoCents, vendas.vendidoCents) }}% do vendido</p>
        </div>
        <div class="card p-5">
          <p class="rotulo-kpi">A receber agora</p>
          <p class="numero-kpi mt-1">{{ reais(vivo.totais.emAbertoCents) }}</p>
          <p class="mt-1 text-xs text-ink-600">{{ vivo.totais.abertas }} conta(s) aberta(s)</p>
        </div>
        <div class="card p-5">
          <p class="rotulo-kpi">Ticket médio por cliente</p>
          <p class="numero-kpi mt-1">{{ reais(vendas.ticketMedioCents) }}</p>
          <p class="mt-1 text-xs text-ink-600">{{ vendas.contas.comConsumo }} cliente(s) consumiram</p>
        </div>
      </div>

      <!-- fechamento -->
      <NuxtLink :to="{ query: { aba: 'dia' } }" class="card flex flex-wrap items-center justify-between gap-3 p-4 transition hover:ring-1 hover:ring-acao"
                :class="dia.fechamento.passou && dia.naoPagas.length ? 'border-l-4 border-l-danger-600' : ''">
        <div>
          <p class="font-semibold">{{ dia.fechamento.passou ? `Parque fechou às ${dia.fechamento.hora}` : `Parque aberto · fecha às ${dia.fechamento.hora}` }}</p>
          <p class="text-sm text-ink-600">
            <template v-if="dia.fechamento.passou">{{ dia.naoPagas.length ? `${dia.naoPagas.length} cliente(s) saíram sem pagar` : 'Ninguém saiu sem pagar' }}<template v-if="dia.pagasDepois.length"> · {{ dia.pagasDepois.length }} pagaram depois do fechamento</template></template>
            <template v-else>A partir das {{ dia.fechamento.hora }}, conta aberta vira "saiu sem pagar" no Resumo do dia.</template>
          </p>
        </div>
        <div class="text-right">
          <p class="titulo text-2xl font-bold" :class="dia.naoPagoCents ? 'text-erro' : 'text-ink-900'">{{ reais(dia.naoPagoCents) }}</p>
          <p class="text-xs text-ink-600">sem pagar · ver resumo do dia →</p>
        </div>
      </NuxtLink>

      <!-- movimento -->
      <div class="grid gap-4 xl:grid-cols-[2fr_1fr]">
        <div class="card p-5">
          <div class="flex flex-wrap items-baseline justify-between gap-2">
            <p class="titulo-bloco">Vendas por hora</p>
            <p v-if="pico" class="text-sm text-ink-600">Pico: <b>{{ pico.hora }}h às {{ pico.hora + 1 }}h</b> · {{ reais(pico.vendidoCents) }}</p>
          </div>
          <div class="mt-4"><ComandaGraficoColunas :pontos="horas" :destaque="horaAgora" /></div>
        </div>
        <div class="card p-5">
          <p class="titulo-bloco">Formas de pagamento</p>
          <template v-if="vendas.recebidoCents">
            <div class="mt-4 flex h-3 overflow-hidden rounded-full">
              <div v-for="(v, k) in vendas.porForma" :key="k" :style="{ width: `${pct(v as number, vendas.recebidoCents)}%`, background: FORMA[k as string]?.cor }" />
            </div>
            <ul class="mt-4 space-y-2.5 text-sm">
              <li v-for="(v, k) in vendas.porForma" :key="k" class="flex items-center gap-2">
                <span class="h-2.5 w-2.5 rounded-full" :style="{ background: FORMA[k as string]?.cor }" />
                <span class="flex-1">{{ FORMA[k as string]?.nome }}</span>
                <span class="w-10 text-right text-ink-600">{{ pct(v as number, vendas.recebidoCents) }}%</span>
                <b class="w-24 text-right tabular-nums">{{ reais(v as number) }}</b>
              </li>
            </ul>
          </template>
          <p v-else class="mt-4 text-sm text-ink-600">Nenhum pagamento hoje ainda.</p>
        </div>
      </div>

      <div class="grid gap-4 lg:grid-cols-2">
        <div class="card p-5">
          <p class="titulo-bloco">Vendas por local</p>
          <ul class="mt-4 space-y-3.5">
            <li v-for="p in vendas.porLocal" :key="p.nome">
              <div class="flex justify-between text-sm"><span class="font-semibold">{{ p.nome }}</span><span class="tabular-nums"><b>{{ reais(p.vendidoCents) }}</b> <span class="text-ink-600">· {{ pct(p.vendidoCents, vendas.vendidoCents) }}%</span></span></div>
              <div class="mt-1.5 h-2 rounded-full bg-ink-100"><div class="h-2 rounded-full bg-acao" :style="{ width: `${pct(p.vendidoCents, vendas.porLocal[0].vendidoCents)}%` }" /></div>
            </li>
          </ul>
          <p v-if="!vendas.porLocal.length" class="mt-4 text-sm text-ink-600">Nenhuma venda hoje ainda.</p>
        </div>
        <div class="card p-5">
          <p class="titulo-bloco">Produtos que mais saem</p>
          <table class="mt-3 w-full text-sm">
            <tbody class="divide-y divide-linha">
              <tr v-for="(i, n) in vendas.porItem.slice(0, 6)" :key="i.nome">
                <td class="w-6 py-2 text-ink-500">{{ n + 1 }}</td>
                <td class="font-semibold">{{ i.nome }}</td>
                <td class="text-right text-ink-600">{{ i.quantidade }} un.</td>
                <td class="w-24 text-right font-semibold tabular-nums">{{ reais(i.vendidoCents) }}</td>
              </tr>
            </tbody>
          </table>
          <p v-if="!vendas.porItem.length" class="mt-4 text-sm text-ink-600">Nenhuma venda hoje ainda.</p>
        </div>
      </div>

      <!-- contas abertas -->
      <div class="card overflow-hidden">
        <div class="flex items-center justify-between px-5 pt-5">
          <p class="titulo-bloco">Contas abertas agora</p>
          <NuxtLink :to="{ query: { aba: 'contas' } }" class="text-sm font-semibold text-acao">Ver todas →</NuxtLink>
        </div>
        <div class="overflow-x-auto">
          <table class="mt-3 w-full min-w-[620px] text-sm">
            <thead class="bg-fundo-cinza text-left text-xs uppercase tracking-wide text-ink-600">
              <tr><th class="px-5 py-2.5">Cliente</th><th>Pulseira</th><th>Aberta há</th><th>Último pedido</th><th class="px-5 text-right">Consumo</th></tr>
            </thead>
            <tbody class="divide-y divide-linha">
              <tr v-for="c in vivo.contas.slice(0, 10)" :key="c.id" class="hover:bg-ink-50">
                <td class="px-5 py-2.5"><NuxtLink :to="`/admin/comandas/conta/${c.id}`" class="font-semibold hover:text-acao">{{ c.nome }}</NuxtLink>
                  <span class="block text-xs text-ink-600">nº {{ c.numero }}</span></td>
                <td class="tabular-nums">{{ c.pulseira ?? '—' }}</td>
                <td>{{ ha(c.abertaEm) }}</td>
                <td class="text-ink-600">{{ c.ultimoPedidoEm ? dataHora(c.ultimoPedidoEm) : '—' }}</td>
                <td class="px-5 text-right font-semibold tabular-nums">{{ reais(c.totalCents ?? c.faltaCents) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-if="!vivo.contas.length" class="p-6 text-center text-ink-600">Nenhuma conta aberta.</p>
        <p v-else-if="vivo.contas.length > 10" class="px-5 py-3 text-sm text-ink-600">e mais {{ vivo.contas.length - 10 }} conta(s).</p>
      </div>
    </template>
    <div v-else-if="!erro" class="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <div v-for="n in 4" :key="n" class="card h-28 animate-pulse bg-ink-50" />
    </div>
  </div>
</template>
