<script setup lang="ts">
/**
 * Vendas por lote — quanto cada lote girou e quanto pesou no bolo.
 *
 * Usa de propósito a MESMA rota do borderô, não uma consulta própria. Venda
 * por lote calculada duas vezes é venda por lote com dois valores: a hora em
 * que o relatório discorda do fechamento é a hora em que ninguém mais confia
 * em nenhum dos dois.
 *
 * O que esta tela acrescenta é a leitura: giro (quanto do estoque saiu) e
 * peso (quanto da receita veio dali) — as duas perguntas que decidem qual
 * lote abrir da próxima vez.
 */
definePageMeta({ layout: 'admin' })

const route = useRoute()
const id = route.params.id as string

const { data, pending, error: falha, refresh } = await useFetch<any>(
  `/api/admin/evento/${id}/bordero`)

const brl = (c: number) => (c / 100).toLocaleString('pt-BR',
  { style: 'currency', currency: 'BRL' })

/**
 * Percentual que não mente quando é pequeno.
 *
 * `Math.round` puro escrevia "0%" no giro de um lote com 14 vendidos num
 * estoque de 5000 — verdade matemática que o operador lê como "não vendeu
 * nada". Abaixo de 10% mostra uma casa; e o que é maior que zero nunca vira
 * zero na tela.
 */
function pct(parte: number, total: number): number {
  if (!total || !parte) return 0
  const v = (parte / total) * 100
  if (v >= 10) return Math.round(v)
  return Math.max(Math.round(v * 10) / 10, 0.1)
}
const fmtPct = (v: number) => `${v.toLocaleString('pt-BR')}%`

const linhas = computed(() => {
  const l = data.value?.lotes ?? []
  const totalFace = l.reduce((s: number, x: any) => s + x.faceCents, 0)
  return l.map((x: any) => {
    const saiu = x.vendidos + x.cortesias
    return {
      ...x, saiu,
      giroPct: pct(saiu, x.estoque),
      pesoPct: pct(x.faceCents, totalFace),
      sobra: Math.max(x.estoque - saiu, 0),
    }
  })
})

const totais = computed(() => {
  const l = linhas.value
  return {
    estoque: l.reduce((s: number, x: any) => s + x.estoque, 0),
    saiu: l.reduce((s: number, x: any) => s + x.saiu, 0),
    face: l.reduce((s: number, x: any) => s + x.faceCents, 0),
    taxa: l.reduce((s: number, x: any) => s + x.taxaCents, 0),
    cortesias: l.reduce((s: number, x: any) => s + x.cortesias, 0),
  }
})

/** o lote que puxou a receita, e o que não saiu do lugar */
const campeao = computed(() =>
  [...linhas.value].sort((a, b) => b.faceCents - a.faceCents)[0] ?? null)
const parado = computed(() => {
  const vivos = linhas.value.filter((x: any) => x.estoque > 0)
  return [...vivos].sort((a, b) => a.giroPct - b.giroPct)[0] ?? null
})

function exportar() {
  baixarCsv(
    `vendas-por-lote-${id.slice(0, 8)}`,
    ['Setor', 'Lote', 'Face unitária', 'Estoque', 'Vendidos', 'Cortesias',
     'Saiu', 'Sobra', 'Giro %', 'Face', 'Taxa', 'Peso na receita %'],
    linhas.value.map((x: any) => [
      x.setor, x.lote, brl(x.faceUnitCents), x.estoque, x.vendidos,
      x.cortesias, x.saiu, x.sobra, `${x.giroPct}%`,
      brl(x.faceCents), brl(x.taxaCents), `${x.pesoPct}%`,
    ]))
}

useHead({ title: 'Vendas por lote' })
</script>

<template>
  <div v-if="data">
    <div class="flex flex-wrap items-start justify-between gap-3 py-5">
      <div>
        <h1 class="titulo text-2xl font-bold text-tinta">Vendas por lote</h1>
        <p class="mt-1 text-tinta-suave">
          Quanto cada lote girou e quanto pesou na receita. Mesmos números do borderô.
        </p>
      </div>
      <button type="button" class="btn-secundario" @click="exportar">
        <IconeMenu nome="exportar" :tamanho="18" /> Exportar
      </button>
    </div>

    <AbasSecao :evento-id="id" />

    <div class="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <div class="card">
        <p class="rotulo-kpi">Saiu do estoque</p>
        <p class="numero-kpi mt-1">{{ totais.saiu }}</p>
        <p class="mt-1 text-xs text-tinta-fraca">
          de {{ totais.estoque.toLocaleString('pt-BR') }} ·
          {{ fmtPct(pct(totais.saiu, totais.estoque)) }} do total
        </p>
      </div>
      <div class="card">
        <p class="rotulo-kpi">Face vendida</p>
        <p class="numero-kpi mt-1">{{ brl(totais.face) }}</p>
        <p class="mt-1 text-xs text-tinta-fraca">taxa arrecadada {{ brl(totais.taxa) }}</p>
      </div>
      <div class="card">
        <p class="rotulo-kpi">Lote que mais rendeu</p>
        <p class="titulo mt-1 text-lg font-bold text-tinta">{{ campeao?.setor ?? '—' }}</p>
        <p class="mt-1 text-xs text-tinta-fraca">
          <template v-if="campeao">{{ campeao.lote }} · {{ fmtPct(campeao.pesoPct) }} da receita</template>
        </p>
      </div>
      <div class="card">
        <p class="rotulo-kpi">Menor giro</p>
        <p class="titulo mt-1 text-lg font-bold text-tinta">{{ parado?.setor ?? '—' }}</p>
        <p class="mt-1 text-xs text-tinta-fraca">
          <template v-if="parado">{{ parado.lote }} · {{ fmtPct(parado.giroPct) }} vendido</template>
        </p>
      </div>
    </div>

    <p v-if="!linhas.length" class="card mt-4 py-12 text-center text-tinta-suave">
      Nenhum lote cadastrado ainda.
    </p>

    <div v-else class="card mt-4 overflow-x-auto p-0">
      <table class="w-full min-w-[900px] border-collapse text-sm">
        <thead>
          <tr class="border-b border-linha bg-fundo-cinza/60 text-left">
            <th class="titulo px-4 py-2 text-xs font-bold uppercase tracking-wide text-tinta-rotulo">Setor / lote</th>
            <th class="titulo px-3 py-2 text-right text-xs font-bold uppercase tracking-wide text-tinta-rotulo">Face unit.</th>
            <th class="titulo px-3 py-2 text-right text-xs font-bold uppercase tracking-wide text-tinta-rotulo">Vendidos</th>
            <th class="titulo px-3 py-2 text-right text-xs font-bold uppercase tracking-wide text-tinta-rotulo">Cortesias</th>
            <th class="titulo px-3 py-2 text-right text-xs font-bold uppercase tracking-wide text-tinta-rotulo">Sobra</th>
            <th class="titulo px-3 py-2 text-xs font-bold uppercase tracking-wide text-tinta-rotulo">Giro</th>
            <th class="titulo px-3 py-2 text-right text-xs font-bold uppercase tracking-wide text-tinta-rotulo">Face</th>
            <th class="titulo px-4 py-2 text-xs font-bold uppercase tracking-wide text-tinta-rotulo">Peso</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="l in linhas" :key="l.loteId" class="border-b border-linha last:border-0">
            <td class="px-4 py-3">
              <p class="font-medium text-tinta">{{ l.setor }}</p>
              <p class="text-xs text-tinta-fraca">{{ l.lote }}</p>
            </td>
            <td class="px-3 py-3 text-right tabular-nums text-tinta-suave">{{ brl(l.faceUnitCents) }}</td>
            <td class="px-3 py-3 text-right tabular-nums text-tinta">{{ l.vendidos }}</td>
            <td class="px-3 py-3 text-right tabular-nums"
                :class="l.cortesias ? 'text-tinta-suave' : 'text-tinta-fraca'">{{ l.cortesias }}</td>
            <td class="px-3 py-3 text-right tabular-nums text-tinta-suave">
              {{ l.sobra.toLocaleString('pt-BR') }}
            </td>
            <td class="px-3 py-3">
              <div class="flex items-center gap-2">
                <div class="h-1.5 w-20 rounded-full bg-fundo-cinza">
                  <div class="h-1.5 rounded-full"
                       :class="l.giroPct >= 90 ? 'bg-erro' : l.giroPct >= 60 ? 'bg-alerta' : 'bg-ok'"
                       :style="{ width: `${Math.max(Math.min(l.giroPct, 100), 1.5)}%` }" />
                </div>
                <span class="text-xs tabular-nums text-tinta-fraca">{{ fmtPct(l.giroPct) }}</span>
              </div>
            </td>
            <td class="px-3 py-3 text-right font-medium tabular-nums text-tinta">{{ brl(l.faceCents) }}</td>
            <td class="px-4 py-3">
              <div class="flex items-center gap-2">
                <div class="h-1.5 w-16 rounded-full bg-fundo-cinza">
                  <div class="h-1.5 rounded-full bg-acao" :style="{ width: `${Math.max(l.pesoPct, 1.5)}%` }" />
                </div>
                <span class="text-xs tabular-nums text-tinta-fraca">{{ fmtPct(l.pesoPct) }}</span>
              </div>
            </td>
          </tr>
        </tbody>
        <tfoot>
          <tr class="border-t-2 border-linha-forte bg-fundo-cinza/40 font-bold">
            <td class="titulo px-4 py-3 text-tinta">Total</td>
            <td />
            <td class="px-3 py-3 text-right tabular-nums text-tinta">
              {{ totais.saiu - totais.cortesias }}
            </td>
            <td class="px-3 py-3 text-right tabular-nums text-tinta">{{ totais.cortesias }}</td>
            <td class="px-3 py-3 text-right tabular-nums text-tinta-suave">
              {{ (totais.estoque - totais.saiu).toLocaleString('pt-BR') }}
            </td>
            <td />
            <td class="px-3 py-3 text-right tabular-nums text-tinta">{{ brl(totais.face) }}</td>
            <td />
          </tr>
        </tfoot>
      </table>
    </div>

    <p class="mt-3 text-xs text-tinta-fraca">
      Giro é quanto do estoque do lote já saiu, cortesia incluída — cortesia ocupa vaga
      igual a ingresso vendido. Peso é a fatia da face total que veio daquele lote.
    </p>
  </div>

  <p v-else-if="pending" class="card mt-6 text-tinta-suave">Carregando…</p>

  <div v-else class="card mt-6">
    <p class="rotulo-kpi text-erro">Não foi possível carregar</p>
    <p class="mt-1 text-sm text-tinta-suave">
      {{ (falha as any)?.data?.statusMessage || (falha as any)?.message || 'Erro desconhecido.' }}
    </p>
    <button type="button" class="btn-secundario mt-3" @click="refresh()">Tentar de novo</button>
  </div>
</template>
