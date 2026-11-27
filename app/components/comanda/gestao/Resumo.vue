<script setup lang="ts">
/**
 * Resumo do dia (055). Antes do horário de fechamento (Configurações → Equipe e regras), mostra
 * quem ainda está com conta aberta; depois dele, quem SAIU SEM PAGAR. Tudo calculado na hora:
 * quem paga às 18:30 sai da lista sozinho e aparece em "Pagaram depois do fechamento".
 * Atualiza a cada 30 s quando o dia é hoje.
 *
 * "Liberar as pulseiras" marca as contas abertas como não pagas (vão pra cobrança) e solta as
 * pulseiras pro dia seguinte — se o cliente pagar depois, a conta vira "paga depois".
 */
import { chamar, mensagemDoErro } from '~/composables/comandaOffline'
import { dataHora, diaLocal, diaLocalMais, reais } from '~/composables/formato'
import ComandaGraficoColunas from '~/components/comanda/GraficoColunas.vue'

const dia = ref(diaLocal())
const d = ref<any>(null)
const erro = ref('')
async function carregar() {
  try { d.value = await chamar<any>('/api/comandas/gestao/resumo', { query: { dia: dia.value } }); erro.value = '' } catch (e) { erro.value = mensagemDoErro(e) }
}
watch(dia, carregar, { immediate: true })
let laco: ReturnType<typeof setInterval> | undefined
onMounted(() => { laco = setInterval(() => { if (dia.value === diaLocal()) carregar() }, 30_000) })
onBeforeUnmount(() => clearInterval(laco))

const FORMA: Record<string, string> = { pix: 'Pix', debito: 'Débito', credito: 'Crédito', dinheiro: 'Dinheiro' }
const hora = (iso: string | null) => iso ? new Date(iso).toLocaleTimeString('pt-BR', { timeZone: 'America/Bahia', hour: '2-digit', minute: '2-digit' }) : '—'
const horas = computed(() => (d.value?.porHora ?? []).map((h: any) => ({ rotulo: `${h.hora}h`, valor: h.vendidoCents })))
const imprimir = () => window.print()

/* liberar as pulseiras de quem saiu sem pagar */
const liberando = ref(false)
const feito = ref('')
async function liberar(ignorarTablets = false) {
  const abertas = (d.value?.naoPagas ?? []).filter((n: any) => n.situacao === 'aberta')
  // as abertas sem nada a pagar o servidor só fecha (não viram "não paga") e solta a pulseira
  const semValor: string[] = d.value?.abertasSemValor ?? []
  liberando.value = true
  try {
    await chamar('/api/comandas/gestao/encerrar-dia', { method: 'POST', body: {
      contas: [...abertas.map((n: any) => n.id), ...semValor].map((id) => ({ id, decisao: 'nao_paga' })), ignorarTablets } })
    feito.value = `${abertas.length} conta(s) marcada(s) como não paga(s). Pulseiras liberadas.`
    await carregar()
  } catch (e) { erro.value = mensagemDoErro(e) }
  finally { liberando.value = false }
}
const abertasSemPagar = computed(() => (d.value?.naoPagas ?? []).filter((n: any) => n.situacao === 'aberta').length)
</script>

<template>
  <div class="space-y-4">
    <!-- dia -->
    <div class="flex flex-wrap items-center gap-2">
      <button type="button" class="chip" :class="dia === diaLocal() ? 'chip-ativo' : ''" @click="dia = diaLocal()">Hoje</button>
      <button type="button" class="chip" :class="dia === diaLocalMais(-1) ? 'chip-ativo' : ''" @click="dia = diaLocalMais(-1)">Ontem</button>
      <input v-model="dia" type="date" class="campo w-auto">
      <button type="button" class="btn-secundario ml-auto" @click="imprimir">Imprimir</button>
    </div>
    <p v-if="erro" class="faixa-erro">{{ erro }}</p>
    <p v-if="feito" class="faixa-aviso">{{ feito }}</p>

    <template v-if="d">
      <!-- situação do fechamento -->
      <div class="card flex flex-wrap items-center gap-3 p-4">
        <span class="h-3 w-3 rounded-full" :class="d.fechamento.passou ? 'bg-ink-400' : 'animate-pulse bg-success-600'" />
        <p class="flex-1 font-semibold">
          {{ d.fechamento.passou ? `Fechamento às ${d.fechamento.hora}` : `Parque aberto — o fechamento é às ${d.fechamento.hora}` }}
          <span class="block text-sm font-normal text-ink-600">
            {{ d.fechamento.passou
              ? 'Contas com saldo depois desse horário contam como "saiu sem pagar". Quem pagar depois sai da lista sozinho.'
              : 'Até lá, conta aberta é cliente ainda no parque. O horário muda em Configurações → Equipe e regras.' }}
          </span>
        </p>
      </div>

      <!-- números -->
      <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div class="card p-5"><p class="rotulo-kpi">Vendido</p><p class="numero-kpi mt-1">{{ reais(d.vendidoCents) }}</p><p class="mt-1 text-xs text-ink-600">{{ d.pedidos }} pedidos · {{ d.contas.total }} contas</p><p v-if="d.descontoContaCents" class="mt-0.5 text-xs text-ink-600">− {{ reais(d.descontoContaCents) }} de desconto na conta</p></div>
        <div class="card p-5"><p class="rotulo-kpi">Recebido</p><p class="numero-kpi mt-1 text-ok">{{ reais(d.recebidoCents) }}</p></div>
        <div class="card p-5" :class="d.naoPagas.length ? 'border-l-4 border-l-danger-600' : ''">
          <p class="rotulo-kpi">Saíram sem pagar</p><p class="numero-kpi mt-1" :class="d.naoPagoCents ? 'text-erro' : ''">{{ reais(d.naoPagoCents) }}</p>
          <p class="mt-1 text-xs text-ink-600">{{ d.naoPagas.length }} cliente(s)</p></div>
        <div class="card p-5"><p class="rotulo-kpi">Pagaram após o fechamento</p><p class="numero-kpi mt-1">{{ reais(d.pagoDepoisCents) }}</p>
          <p class="mt-1 text-xs text-ink-600">{{ d.pagasDepois.length }} cliente(s)</p></div>
      </div>

      <!-- ainda no parque (antes do fechamento) -->
      <div v-if="!d.fechamento.passou && d.aindaNoParque.length" class="card overflow-hidden">
        <p class="titulo-bloco px-5 pt-5">Com conta aberta agora ({{ d.aindaNoParque.length }})</p>
        <p class="px-5 text-sm text-ink-600">Se ainda estiverem abertas às {{ d.fechamento.hora }}, entram em "saíram sem pagar".</p>
        <ul class="mt-2 divide-y divide-linha">
          <li v-for="n in d.aindaNoParque" :key="n.id" class="flex justify-between px-5 py-2.5 text-sm">
            <NuxtLink :to="`/admin/comandas/conta/${n.id}`" class="font-semibold hover:text-acao">{{ n.nome }} <span class="font-normal text-ink-600">· nº {{ n.numero }} · pulseira {{ n.pulseira ?? '—' }}</span></NuxtLink>
            <b class="tabular-nums">{{ reais(n.faltaCents) }}</b>
          </li>
        </ul>
      </div>

      <!-- saíram sem pagar -->
      <div class="card overflow-hidden">
        <div class="flex flex-wrap items-center justify-between gap-2 px-5 pt-5">
          <p class="titulo-bloco">Saíram sem pagar</p>
          <button v-if="abertasSemPagar || d.abertasSemValor?.length" type="button" class="btn-secundario" :disabled="liberando" @click="liberar(false)">
            Marcar como não pagas e liberar {{ abertasSemPagar + (d.abertasSemValor?.length ?? 0) }} pulseira(s)
          </button>
        </div>
        <p v-if="!d.naoPagas.length" class="px-5 pb-5 pt-1 text-sm text-ink-600">{{ d.fechamento.passou ? 'Ninguém. Todas as contas do dia foram pagas.' : 'Só conta depois do fechamento.' }}</p>
        <div v-else class="overflow-x-auto">
          <table class="mt-3 w-full min-w-[720px] text-sm">
            <thead class="bg-fundo-cinza text-left text-xs uppercase tracking-wide text-ink-600">
              <tr><th class="px-5 py-2.5">Cliente</th><th>Responsável</th><th>Pulseira</th><th>Último pedido</th><th>Situação</th><th class="text-right">Deve</th><th class="px-5" /></tr>
            </thead>
            <tbody class="divide-y divide-linha">
              <tr v-for="n in d.naoPagas" :key="n.id">
                <td class="px-5 py-2.5 font-semibold">{{ n.nome }}<span class="block text-xs font-normal text-ink-600">nº {{ n.numero }}</span></td>
                <td>{{ n.responsavelNome }}<span class="block text-xs text-ink-600">{{ n.responsavelTelefone ?? 'sem telefone' }}</span></td>
                <td class="tabular-nums">{{ n.pulseira ?? '—' }}</td>
                <td>{{ hora(n.ultimoPedidoEm) }}</td>
                <td><span :class="n.situacao === 'cobrada' ? 'selo-alerta' : 'selo-erro'">{{ { aberta: 'não fechou', nao_paga: 'não paga', cobrada: 'cobrada' }[n.situacao as string] }}</span></td>
                <td class="text-right font-bold tabular-nums text-erro">{{ reais(n.faltaCents) }}</td>
                <td class="px-5 text-right"><NuxtLink :to="`/admin/comandas/conta/${n.id}`" class="btn-secundario px-3 py-1.5 text-xs">Ver e cobrar</NuxtLink></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- pagaram depois -->
      <div v-if="d.pagasDepois.length" class="card overflow-hidden">
        <p class="titulo-bloco px-5 pt-5">Pagaram depois do fechamento</p>
        <ul class="mt-2 divide-y divide-linha">
          <li v-for="n in d.pagasDepois" :key="n.id" class="flex flex-wrap justify-between gap-2 px-5 py-2.5 text-sm">
            <NuxtLink :to="`/admin/comandas/conta/${n.id}`" class="font-semibold hover:text-acao">{{ n.nome }} <span class="font-normal text-ink-600">· nº {{ n.numero }}</span></NuxtLink>
            <span>pagou às <b>{{ hora(n.fechadaEm) }}</b><span v-if="new Date(n.fechadaEm).toDateString() !== new Date(d.fechamento.em).toDateString()"> de {{ dataHora(n.fechadaEm) }}</span> · <b class="text-ok">{{ reais(n.totalCents) }}</b></span>
          </li>
        </ul>
      </div>

      <div class="grid gap-4 xl:grid-cols-[2fr_1fr]">
        <div class="card p-5">
          <p class="titulo-bloco">Vendas por hora</p>
          <div v-if="horas.length" class="mt-4"><ComandaGraficoColunas :pontos="horas" /></div>
          <p v-else class="mt-2 text-sm text-ink-600">Sem vendas.</p>
        </div>
        <div class="card p-5">
          <p class="titulo-bloco">Recebido por forma</p>
          <ul class="mt-3 divide-y divide-linha text-sm">
            <li v-for="(v, k) in d.porForma" :key="k" class="flex justify-between py-2"><span>{{ FORMA[k as string] }}</span><b class="tabular-nums">{{ reais(v as number) }}</b></li>
            <li class="flex justify-between py-2 font-bold"><span>Total</span><span class="tabular-nums">{{ reais(d.recebidoCents) }}</span></li>
          </ul>
        </div>
      </div>

      <div class="grid gap-4 lg:grid-cols-2">
        <div class="card p-5">
          <p class="titulo-bloco">Por local</p>
          <ul class="mt-2 divide-y divide-linha text-sm">
            <li v-for="p in d.porPonto" :key="p.nome" class="flex justify-between py-2"><span>{{ p.nome }}</span><b class="tabular-nums">{{ reais(p.vendidoCents) }}</b></li>
          </ul>
        </div>
        <div class="card p-5">
          <p class="titulo-bloco">Mais vendidos</p>
          <ul class="mt-2 divide-y divide-linha text-sm">
            <li v-for="i in d.maisVendidos" :key="i.nome" class="flex justify-between py-2"><span>{{ i.quantidade }}× {{ i.nome }}</span><b class="tabular-nums">{{ reais(i.vendidoCents) }}</b></li>
          </ul>
        </div>
      </div>

      <div class="card overflow-x-auto p-5">
        <p class="titulo-bloco">Quem recebeu (prestação de contas)</p>
        <table class="mt-2 w-full min-w-[560px] text-sm">
          <thead class="text-left text-xs uppercase tracking-wide text-ink-600"><tr><th class="py-2">Pessoa</th><th class="text-right">Dinheiro</th><th class="text-right">Pix</th><th class="text-right">Débito</th><th class="text-right">Crédito</th><th class="text-right">Total</th></tr></thead>
          <tbody class="divide-y divide-linha">
            <tr v-for="p in d.prestacaoDeContas" :key="p.nome"><td class="py-2 font-semibold">{{ p.nome }}</td><td class="text-right tabular-nums">{{ reais(p.dinheiro) }}</td><td class="text-right tabular-nums">{{ reais(p.pix) }}</td><td class="text-right tabular-nums">{{ reais(p.debito) }}</td><td class="text-right tabular-nums">{{ reais(p.credito) }}</td><td class="text-right font-bold tabular-nums">{{ reais(p.totalCents) }}</td></tr>
          </tbody>
        </table>
        <p v-if="!d.prestacaoDeContas.length" class="mt-2 text-sm text-ink-600">Ninguém recebeu neste dia.</p>
      </div>

      <div class="card p-5">
        <p class="titulo-bloco">Correções do dia</p>
        <p v-if="!d.correcoes.length" class="mt-1 text-sm text-ink-600">Nenhuma.</p>
        <ul class="mt-2 divide-y divide-linha text-sm">
          <li v-for="(c, n) in d.correcoes" :key="n" class="py-2"><span class="text-ink-600">{{ hora(c.quando) }} · {{ c.quem }}</span>
            <NuxtLink v-if="c.comandaId" :to="`/admin/comandas/conta/${c.comandaId}`" class="font-semibold text-acao"> · nº {{ c.numero }} {{ c.nome }}</NuxtLink><br>{{ c.descricao }}</li>
        </ul>
      </div>
    </template>
  </div>
</template>
