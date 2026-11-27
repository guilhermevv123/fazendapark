<script setup lang="ts">
/**
 * Vendas (055): tudo o que saiu pelas comandas num período — números gerais e os recortes
 * por item, categoria, local, atendente, dia, hora, dia da semana e forma de pagamento.
 * "Baixar planilha" leva a tabela de itens (a mais pedida pra conferir estoque).
 */
import { chamar, mensagemDoErro } from '~/composables/comandaOffline'
import { diaLocal, diaLocalMais, primeiroDiaDoMes, reais } from '~/composables/formato'

const de = ref(diaLocal())
const ate = ref(diaLocal())
const d = ref<any>(null)
const erro = ref('')
const carregando = ref(false)
async function carregar() {
  carregando.value = true
  try { d.value = await chamar<any>('/api/comandas/gestao/vendas', { query: { de: de.value, ate: ate.value } }); erro.value = '' }
  catch (e) { erro.value = mensagemDoErro(e) }
  finally { carregando.value = false }
}
watch([de, ate], carregar, { immediate: true })

const ATALHOS = [
  { nome: 'Hoje', de: () => diaLocal(), ate: () => diaLocal() },
  { nome: 'Ontem', de: () => diaLocalMais(-1), ate: () => diaLocalMais(-1) },
  { nome: '7 dias', de: () => diaLocalMais(-6), ate: () => diaLocal() },
  { nome: '30 dias', de: () => diaLocalMais(-29), ate: () => diaLocal() },
  { nome: 'Este mês', de: () => primeiroDiaDoMes(), ate: () => diaLocal() },
]
const atalho = (a: typeof ATALHOS[number]) => { de.value = a.de(); ate.value = a.ate() }
const atalhoAtivo = (a: typeof ATALHOS[number]) => de.value === a.de() && ate.value === a.ate()

const FORMA: Record<string, string> = { pix: 'Pix', debito: 'Débito', credito: 'Crédito', dinheiro: 'Dinheiro' }
const SEMANA = ['', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado', 'Domingo']
const pct = (v: number, t: number) => t ? `${Math.round((v / t) * 100)}%` : '—'
const maior = (l: any[]) => Math.max(1, ...l.map((x) => x.vendidoCents))
const diaBR = (s: string) => s.split('-').reverse().slice(0, 2).join('/')

// tabela de itens: busca, categoria e ordenação
const buscaItem = ref('')
const catItem = ref('')
const ordem = ref<'vendidoCents' | 'quantidade' | 'nome'>('vendidoCents')
const itens = computed(() => {
  const b = buscaItem.value.trim().toLowerCase()
  const l = (d.value?.porItem ?? []).filter((i: any) => (!b || i.nome.toLowerCase().includes(b)) && (!catItem.value || i.categoria === catItem.value))
  return [...l].sort((a: any, z: any) => ordem.value === 'nome' ? a.nome.localeCompare(z.nome) : z[ordem.value] - a[ordem.value])
})

function baixar() {
  const linhas = [['Item', 'Categoria', 'Quantidade', 'Total (R$)', 'Preço médio (R$)', 'Contas'],
    ...itens.value.map((i: any) => [i.nome, i.categoria, i.quantidade, (i.vendidoCents / 100).toFixed(2).replace('.', ','),
      (i.precoMedioCents / 100).toFixed(2).replace('.', ','), i.contas])]
  const csv = '﻿' + linhas.map((l) => l.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(';')).join('\n')
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  a.download = `vendas-comandas-${de.value}_${ate.value}.csv`
  a.click()
  URL.revokeObjectURL(a.href)
}
</script>

<template>
  <div class="space-y-4">
    <!-- período -->
    <div class="card flex flex-wrap items-end gap-3 p-4">
      <div class="flex flex-wrap gap-1.5">
        <button v-for="a in ATALHOS" :key="a.nome" type="button" class="chip min-h-[40px]" :class="atalhoAtivo(a) ? 'chip-ativo' : ''" @click="atalho(a)">{{ a.nome }}</button>
      </div>
      <label class="flex items-center gap-2"><span class="rotulo m-0">De</span><input v-model="de" type="date" class="campo w-auto"></label>
      <label class="flex items-center gap-2"><span class="rotulo m-0">Até</span><input v-model="ate" type="date" class="campo w-auto"></label>
      <span v-if="carregando" class="text-sm text-ink-600">Carregando…</span>
    </div>
    <p v-if="erro" class="faixa-erro">{{ erro }}</p>

    <template v-if="d">
      <!-- números -->
      <div class="grid grid-cols-2 gap-3 md:grid-cols-4">
        <div class="card p-4"><p class="rotulo-kpi">Vendido</p><p class="numero-kpi mt-1">{{ reais(d.vendidoCents) }}</p>
          <p class="mt-1 text-xs text-ink-600">{{ d.dias > 1 ? `média ${reais(d.mediaPorDiaCents)}/dia` : `${d.pedidos} pedidos` }}</p></div>
        <div class="card p-4"><p class="rotulo-kpi">Recebido</p><p class="numero-kpi mt-1 text-ok">{{ reais(d.recebidoCents) }}</p>
          <p class="mt-1 text-xs text-ink-600">{{ pct(d.recebidoCents, d.vendidoCents) }} do vendido</p></div>
        <div class="card p-4"><p class="rotulo-kpi">Ticket médio por cliente</p><p class="numero-kpi mt-1">{{ reais(d.ticketMedioCents) }}</p>
          <p class="mt-1 text-xs text-ink-600">{{ d.contas.comConsumo }} contas com consumo</p></div>
        <div class="card p-4"><p class="rotulo-kpi">Itens vendidos</p><p class="numero-kpi mt-1">{{ d.itens }}</p>
          <p class="mt-1 text-xs text-ink-600">{{ d.pedidos }} pedidos · {{ reais(d.mediaPorPedidoCents) }} por pedido</p></div>
        <div class="card p-4"><p class="rotulo-kpi">Contas abertas no período</p><p class="numero-kpi mt-1">{{ d.contas.total }}</p>
          <p class="mt-1 text-xs text-ink-600">{{ d.contas.paga ?? 0 }} pagas · {{ d.contas.aberta ?? 0 }} abertas · {{ (d.contas.nao_paga ?? 0) + (d.contas.cobrada ?? 0) }} sem pagar</p></div>
        <div class="card p-4"><p class="rotulo-kpi">Cancelado</p><p class="numero-kpi mt-1" :class="d.canceladoCents ? 'text-erro' : ''">{{ reais(d.canceladoCents) }}</p>
          <p class="mt-1 text-xs text-ink-600">{{ d.itensCancelados }} item(ns)</p></div>
        <div class="card p-4"><p class="rotulo-kpi">Descontos</p><p class="numero-kpi mt-1">{{ reais(d.descontoCents) }}</p></div>
        <div class="card p-4"><p class="rotulo-kpi">Feitos sem internet</p><p class="numero-kpi mt-1">{{ d.pedidosSemInternet }}</p>
          <p class="mt-1 text-xs text-ink-600">pedidos guardados no tablet</p></div>
      </div>

      <p v-if="!d.pedidos" class="card p-8 text-center text-ink-600">Nenhuma venda neste período.</p>
      <template v-else>
        <div class="grid gap-4 lg:grid-cols-2">
          <!-- por local -->
          <div class="card p-5">
            <p class="titulo-bloco">Por local de venda</p>
            <ul class="mt-3 space-y-3">
              <li v-for="p in d.porLocal" :key="p.nome">
                <div class="flex justify-between text-sm"><b>{{ p.nome }}</b><span class="tabular-nums"><b>{{ reais(p.vendidoCents) }}</b> · {{ pct(p.vendidoCents, d.vendidoCents) }}</span></div>
                <div class="mt-1 h-2 rounded-full bg-ink-100"><div class="h-2 rounded-full bg-acao" :style="{ width: `${(p.vendidoCents / maior(d.porLocal)) * 100}%` }" /></div>
                <p class="mt-0.5 text-xs text-ink-600">{{ p.pedidos }} pedidos · {{ p.quantidade }} itens · mais pedido: {{ p.destaque }}</p>
              </li>
            </ul>
          </div>
          <!-- por categoria -->
          <div class="card p-5">
            <p class="titulo-bloco">Por categoria</p>
            <ul class="mt-3 space-y-3">
              <li v-for="k in d.porCategoria" :key="k.nome">
                <div class="flex justify-between text-sm"><b>{{ k.nome }}</b><span class="tabular-nums"><b>{{ reais(k.vendidoCents) }}</b> · {{ pct(k.vendidoCents, d.vendidoCents) }}</span></div>
                <div class="mt-1 h-2 rounded-full bg-ink-100"><div class="h-2 rounded-full bg-acao" :style="{ width: `${(k.vendidoCents / maior(d.porCategoria)) * 100}%` }" /></div>
                <p class="mt-0.5 text-xs text-ink-600">{{ k.quantidade }} itens</p>
              </li>
            </ul>
          </div>
        </div>

        <!-- itens -->
        <div class="card p-5">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <p class="titulo-bloco">Todos os itens vendidos ({{ d.porItem.length }})</p>
            <button type="button" class="btn-secundario" @click="baixar">Baixar planilha</button>
          </div>
          <div class="mt-3 flex flex-wrap gap-2">
            <input v-model="buscaItem" class="campo max-w-xs" placeholder="Buscar item">
            <select v-model="catItem" class="campo w-auto"><option value="">Todas as categorias</option><option v-for="k in d.porCategoria" :key="k.nome" :value="k.nome">{{ k.nome }}</option></select>
            <select v-model="ordem" class="campo w-auto"><option value="vendidoCents">Maior faturamento</option><option value="quantidade">Mais vendidos</option><option value="nome">Nome (A–Z)</option></select>
          </div>
          <div class="mt-3 overflow-x-auto">
            <table class="w-full text-sm">
              <thead class="text-left text-xs uppercase text-ink-600">
                <tr><th class="py-2">Item</th><th>Categoria</th><th class="text-right">Qtd.</th><th class="text-right">Total</th><th class="text-right">% do total</th><th class="text-right">Preço médio</th><th class="text-right">Clientes</th></tr>
              </thead>
              <tbody class="divide-y divide-linha">
                <tr v-for="i in itens" :key="i.nome + i.categoria">
                  <td class="py-2 font-semibold">{{ i.nome }}</td><td class="text-ink-700">{{ i.categoria }}</td>
                  <td class="text-right tabular-nums">{{ i.quantidade }}</td><td class="text-right font-semibold tabular-nums">{{ reais(i.vendidoCents) }}</td>
                  <td class="text-right tabular-nums text-ink-700">{{ pct(i.vendidoCents, d.vendidoCents) }}</td>
                  <td class="text-right tabular-nums text-ink-700">{{ reais(i.precoMedioCents) }}</td><td class="text-right tabular-nums text-ink-700">{{ i.contas }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div class="grid gap-4 lg:grid-cols-2">
          <!-- por atendente -->
          <div class="card p-5">
            <p class="titulo-bloco">Por atendente</p>
            <table class="mt-2 w-full text-sm">
              <thead class="text-left text-xs uppercase text-ink-600"><tr><th class="py-2">Quem</th><th class="text-right">Pedidos</th><th class="text-right">Itens</th><th class="text-right">Vendido</th><th class="text-right">Cancel.</th></tr></thead>
              <tbody class="divide-y divide-linha">
                <tr v-for="a in d.porAtendente" :key="a.nome"><td class="py-2 font-semibold">{{ a.nome }}</td><td class="text-right">{{ a.pedidos }}</td><td class="text-right">{{ a.quantidade }}</td>
                  <td class="text-right font-semibold tabular-nums">{{ reais(a.vendidoCents) }}</td><td class="text-right" :class="a.cancelados ? 'text-erro' : ''">{{ a.cancelados }}</td></tr>
              </tbody>
            </table>
          </div>
          <!-- formas -->
          <div class="card p-5">
            <p class="titulo-bloco">Recebido por forma de pagamento</p>
            <ul class="mt-3 space-y-3">
              <li v-for="(v, k) in d.porForma" :key="k">
                <div class="flex justify-between text-sm"><b>{{ FORMA[k as string] }}</b><span class="tabular-nums"><b>{{ reais(v as number) }}</b> · {{ pct(v as number, d.recebidoCents) }}</span></div>
                <div class="mt-1 h-2 rounded-full bg-ink-100"><div class="h-2 rounded-full bg-ok" :style="{ width: `${d.recebidoCents ? ((v as number) / d.recebidoCents) * 100 : 0}%` }" /></div>
              </li>
            </ul>
          </div>
        </div>

        <div class="grid gap-4 lg:grid-cols-2">
          <!-- por hora -->
          <div class="card p-5">
            <p class="titulo-bloco">Horário de maior movimento</p>
            <div class="mt-3 flex h-40 items-end gap-1">
              <div v-for="h in d.porHora" :key="h.hora" class="flex flex-1 flex-col items-center gap-1" :title="`${h.hora}h: ${reais(h.vendidoCents)} · ${h.pedidos} pedidos`">
                <div class="w-full rounded-t bg-acao" :style="{ height: `${Math.max(4, (h.vendidoCents / maior(d.porHora)) * 128)}px` }" />
                <span class="text-[10px] text-ink-600">{{ h.hora }}h</span>
              </div>
            </div>
          </div>
          <!-- por dia / semana -->
          <div class="card p-5">
            <template v-if="d.dias > 1">
              <p class="titulo-bloco">Por dia</p>
              <div class="mt-3 flex h-40 items-end gap-1 overflow-x-auto">
                <div v-for="x in d.porDia" :key="x.dia" class="flex min-w-[22px] flex-1 flex-col items-center gap-1" :title="`${diaBR(x.dia)}: ${reais(x.vendidoCents)} · ${x.pedidos} pedidos`">
                  <div class="w-full rounded-t bg-acao" :style="{ height: `${Math.max(4, (x.vendidoCents / maior(d.porDia)) * 128)}px` }" />
                  <span class="text-[10px] text-ink-600">{{ diaBR(x.dia) }}</span>
                </div>
              </div>
              <p class="titulo-bloco mt-5">Por dia da semana</p>
              <ul class="mt-2 divide-y divide-linha text-sm">
                <li v-for="s in d.porDiaDaSemana" :key="s.dia" class="flex justify-between py-1.5"><span>{{ SEMANA[s.dia] }}</span><b class="tabular-nums">{{ reais(s.vendidoCents) }}</b></li>
              </ul>
            </template>
            <template v-else>
              <p class="titulo-bloco">Pedidos por hora</p>
              <ul class="mt-2 divide-y divide-linha text-sm">
                <li v-for="h in d.porHora" :key="h.hora" class="flex justify-between py-1.5"><span>{{ h.hora }}h às {{ h.hora + 1 }}h</span><span><b class="tabular-nums">{{ reais(h.vendidoCents) }}</b> · {{ h.pedidos }} pedidos</span></li>
              </ul>
            </template>
          </div>
        </div>
      </template>
    </template>
  </div>
</template>
