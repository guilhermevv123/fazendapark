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
definePageMeta({ layout: 'admin' })

const route = useRoute()
const id = route.params.id as string

const { data, refresh, pending, error: falha } = await useFetch<any>(
  `/api/admin/evento/${id}/bordero`)

const reais = (c: number) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })

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
const imprimir = () => window.print()

function exportar() {
  const cab = ['Setor', 'Lote', 'Valor unitário', 'Estoque', 'Vendidos', 'Cortesias',
               'Face', 'Taxa']
  const linhas = (data.value?.lotes ?? []).map((l: any) => [
    l.setor, l.lote, (l.faceUnitCents / 100).toFixed(2).replace('.', ','),
    l.estoque, l.vendidos, l.cortesias,
    (l.faceCents / 100).toFixed(2).replace('.', ','),
    (l.taxaCents / 100).toFixed(2).replace('.', ','),
  ])
  const csv = [cab, ...linhas]
    .map((l) => l.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(';'))
    .join('\r\n')
  const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = `bordero-${data.value.evento.slug}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

useHead({ title: 'Borderô' })
</script>

<template>
  <div v-if="data">
    <div class="flex flex-wrap items-start justify-between gap-3 py-5">
      <div>
        <h1 class="titulo text-2xl font-semibold text-tinta">Borderô</h1>
        <p class="mt-1 text-tinta-suave">
          Fechamento de {{ data.evento.nome }} — o que saiu, por onde, e quanto sobra.
        </p>
      </div>
      <div class="flex gap-2">
        <button type="button" class="btn-secundario" @click="exportar">
          <IconeMenu nome="exportar" :tamanho="18" /> Exportar
        </button>
        <button type="button" class="btn-secundario" @click="imprimir">Imprimir</button>
      </div>
    </div>

    <AbasSecao :evento-id="id" />

    <!-- ====================================================== o resultado -->
    <section class="card mt-5">
      <h2 class="rotulo-kpi">Resultado</h2>
      <dl class="mt-3 grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <dt class="text-xs text-tinta-fraca">Face vendida</dt>
          <dd class="numero-kpi">{{ reais(data.totais.faceCents) }}</dd>
        </div>
        <div>
          <dt class="text-xs text-tinta-fraca">Descontos dados</dt>
          <dd class="numero-kpi" :class="data.totais.descontoCents && 'text-alerta'">
            −{{ reais(data.totais.descontoCents) }}
          </dd>
        </div>
        <div>
          <dt class="text-xs text-tinta-fraca">Estornado</dt>
          <dd class="numero-kpi" :class="data.totais.estornadoCents && 'text-erro'">
            −{{ reais(data.totais.estornadoCents) }}
          </dd>
        </div>
        <div>
          <dt class="text-xs text-tinta-fraca">Líquido da produção</dt>
          <dd class="numero-kpi text-ok">{{ reais(data.totais.liquidoCents) }}</dd>
        </div>
      </dl>

      <hr class="my-4 border-linha">

      <dl class="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
        <div class="flex justify-between">
          <dt class="text-tinta-suave">Taxa de serviço arrecadada</dt>
          <dd class="tabular-nums text-tinta">{{ reais(data.totais.taxaCents) }}</dd>
        </div>
        <div class="flex justify-between">
          <dt class="text-tinta-suave">Já transferido</dt>
          <dd class="tabular-nums text-tinta">{{ reais(data.totais.transferidoCents) }}</dd>
        </div>
        <div class="flex justify-between">
          <dt class="text-tinta-suave">A receber</dt>
          <dd class="tabular-nums font-semibold text-tinta">{{ reais(data.totais.aReceberCents) }}</dd>
        </div>
        <div class="flex justify-between">
          <dt class="text-tinta-suave">Liberação</dt>
          <dd class="text-tinta" :class="data.evento.liberado ? 'text-ok' : 'text-alerta'">
            {{ data.evento.liberado ? 'liberado' : new Date(data.evento.liberaEm).toLocaleDateString('pt-BR') }}
          </dd>
        </div>
      </dl>
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
        </div>
        <div>
          <dt class="text-xs text-tinta-fraca">Comparecimento</dt>
          <dd class="numero-kpi">{{ data.totais.comparecimentoPct }}%</dd>
          <dd class="text-xs text-tinta-fraca">sobre os ingressos válidos</dd>
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
      <table class="mt-3 w-full min-w-[820px] border-collapse text-sm">
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
            <td class="px-3 py-2.5 text-right tabular-nums text-tinta-suave">{{ l.estoque }}</td>
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
