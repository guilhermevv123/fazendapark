<script setup lang="ts">
/**
 * Histórico de leituras — o log da porta, incluindo o que foi barrado.
 *
 * A lista de recusas é o produto principal desta tela. Ingresso que entrou
 * já aparece em Participantes; o que NÃO entrou só existe aqui, e é dele que
 * sai a resposta pra "por que não me deixaram entrar" no dia seguinte.
 */
definePageMeta({ layout: 'admin' })

const route = useRoute()
const id = route.params.id as string

const resultado = ref('')
const gate = ref('')
const busca = ref('')
const pagina = ref(1)

const buscaDebounce = ref('')
let timer: any
watch(busca, (v) => {
  clearTimeout(timer)
  timer = setTimeout(() => { buscaDebounce.value = v; pagina.value = 1 }, 300)
})
watch([resultado, gate], () => { pagina.value = 1 })

const { data, pending, error: falha, refresh } = await useFetch<any>(
  () => `/api/admin/evento/${id}/checkins`,
  { query: { resultado, gate, busca: buscaDebounce, pagina } })

const SELO: Record<string, string> = {
  ok: 'selo-ok', ja_usado: 'selo-alerta', fora_da_sessao: 'selo-alerta',
  invalido: 'selo-erro', cancelado: 'selo-erro', evento_errado: 'selo-erro',
}

const pico = computed(() => {
  const h = data.value?.porHora ?? []
  return h.reduce((m: number, x: any) => Math.max(m, x.n), 0)
})

function exportar() {
  const cab = ['Quando', 'Código lido', 'Resultado', 'Motivo', 'Portão', 'Operador',
               'Titular', 'Setor', 'Lote']
  const linhas = (data.value?.leituras ?? []).map((l: any) => [
    new Date(l.quando).toLocaleString('pt-BR'), l.codigo, l.resultado, l.motivo,
    l.gate ?? '', l.operador ?? '', l.titular ?? '', l.setor ?? '', l.lote ?? '',
  ])
  const csv = [cab, ...linhas]
    .map((l) => l.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(';'))
    .join('\r\n')
  const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = `leituras-${id.slice(0, 8)}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

useHead({ title: 'Histórico de leituras' })
</script>

<template>
  <div v-if="data">
    <div class="flex flex-wrap items-start justify-between gap-3 py-5">
      <div>
        <h1 class="titulo text-2xl font-bold text-tinta">Histórico de leituras</h1>
        <p class="mt-1 text-tinta-suave">
          Tudo que passou na porta — inclusive o que foi barrado, e por quê.
        </p>
      </div>
      <div class="flex gap-2">
        <NuxtLink :to="`/admin/evento/${id}/validacao`" class="btn-secundario">Leitor</NuxtLink>
        <button type="button" class="btn-secundario" @click="exportar">
          <IconeMenu nome="exportar" :tamanho="18" /> Exportar página
        </button>
      </div>
    </div>

    <AbasSecao :evento-id="id" />

    <div class="grid gap-3 sm:grid-cols-4">
      <div class="card">
        <p class="rotulo-kpi">Leituras</p>
        <p class="numero-kpi mt-1">{{ data.resumo.leituras }}</p>
      </div>
      <div class="card">
        <p class="rotulo-kpi">Aceitas</p>
        <p class="numero-kpi mt-1 text-ok">{{ data.resumo.aceitas }}</p>
      </div>
      <div class="card">
        <p class="rotulo-kpi">Recusadas</p>
        <p class="numero-kpi mt-1" :class="data.resumo.recusadas ? 'text-erro' : ''">
          {{ data.resumo.recusadas }}
        </p>
      </div>
      <div class="card">
        <p class="rotulo-kpi">Comparecimento</p>
        <p class="numero-kpi mt-1">{{ data.resumo.comparecimentoPct }}%</p>
        <p class="mt-1 text-xs text-tinta-fraca">
          {{ data.resumo.entraram }} de {{ data.resumo.aptos }}
        </p>
      </div>
    </div>

    <div v-if="data.porHora.length" class="card mt-4">
      <p class="rotulo-kpi">Entradas por hora</p>
      <div class="mt-3 flex items-end gap-1" style="height: 90px">
        <div v-for="h in data.porHora" :key="h.hora" class="flex-1"
             :title="`${new Date(h.hora).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit' })}h — ${h.n} entradas`">
          <div class="rounded-t bg-acao"
               :style="{ height: `${pico ? Math.max((h.n / pico) * 78, 2) : 2}px` }" />
        </div>
      </div>
      <div class="mt-1 flex justify-between text-xs text-tinta-fraca">
        <span>{{ new Date(data.porHora[0].hora).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit' }) }}h</span>
        <span>pico {{ pico }}/h</span>
        <span>{{ new Date(data.porHora[data.porHora.length - 1].hora).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit' }) }}h</span>
      </div>
    </div>

    <div class="card mt-4 flex flex-wrap items-end gap-3">
      <div class="min-w-[220px] flex-1">
        <label for="q" class="rotulo">Buscar</label>
        <input id="q" v-model="busca" class="campo" placeholder="código lido ou nome do titular">
      </div>
      <div>
        <label for="r" class="rotulo">Resultado</label>
        <select id="r" v-model="resultado" class="campo">
          <option value="">Todos</option>
          <option value="ok">Entrou</option>
          <option value="ja_usado">Já tinha entrado</option>
          <option value="invalido">Código inválido</option>
          <option value="cancelado">Ingresso cancelado</option>
          <option value="fora_da_sessao">Fora do horário</option>
          <option value="evento_errado">De outro evento</option>
        </select>
      </div>
      <div v-if="data.portoes.length > 1">
        <label for="g" class="rotulo">Portão</label>
        <select id="g" v-model="gate" class="campo">
          <option value="">Todos</option>
          <option v-for="g in data.portoes" :key="g.gate" :value="g.gate === '—' ? '' : g.gate">
            {{ g.gate }} ({{ g.leituras }})
          </option>
        </select>
      </div>
      <p class="pb-2 text-sm text-tinta-suave">página {{ data.pagina }} de {{ data.paginas }}</p>
    </div>

    <p v-if="!data.leituras.length" class="card mt-4 py-12 text-center text-tinta-suave">
      Nenhuma leitura com esses filtros.
    </p>

    <div v-else class="card mt-4 overflow-x-auto p-0">
      <table class="w-full min-w-[840px] border-collapse text-sm">
        <thead>
          <tr class="border-b border-linha bg-fundo-cinza/60 text-left">
            <th class="titulo px-4 py-2 text-xs font-bold uppercase tracking-wide text-tinta-rotulo">Quando</th>
            <th class="titulo px-3 py-2 text-xs font-bold uppercase tracking-wide text-tinta-rotulo">Código lido</th>
            <th class="titulo px-3 py-2 text-xs font-bold uppercase tracking-wide text-tinta-rotulo">Titular</th>
            <th class="titulo px-3 py-2 text-xs font-bold uppercase tracking-wide text-tinta-rotulo">Portão / operador</th>
            <th class="titulo px-3 py-2 text-xs font-bold uppercase tracking-wide text-tinta-rotulo">Resultado</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="l in data.leituras" :key="l.id" class="border-b border-linha last:border-0">
            <td class="px-4 py-2.5 text-xs tabular-nums text-tinta-suave">
              {{ new Date(l.quando).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'medium' }) }}
            </td>
            <td class="px-3 py-2.5 font-mono text-xs text-acao">{{ l.codigo }}</td>
            <td class="px-3 py-2.5">
              <p class="text-tinta">{{ l.titular || '—' }}</p>
              <p v-if="l.setor" class="text-xs text-tinta-fraca">{{ l.setor }} · {{ l.lote }}</p>
            </td>
            <td class="px-3 py-2.5 text-tinta-suave">
              {{ l.gate || '—' }}
              <span v-if="l.operador" class="block text-xs text-tinta-fraca">{{ l.operador }}</span>
            </td>
            <td class="px-3 py-2.5">
              <span :class="SELO[l.resultado] ?? 'selo-neutro'">{{ l.motivo }}</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="data.paginas > 1" class="mt-4 flex items-center justify-center gap-2">
      <button type="button" class="btn-secundario py-1.5 text-sm" :disabled="data.pagina <= 1"
              @click="pagina = data.pagina - 1">Anterior</button>
      <span class="text-sm text-tinta-suave">{{ data.pagina }} / {{ data.paginas }}</span>
      <button type="button" class="btn-secundario py-1.5 text-sm" :disabled="data.pagina >= data.paginas"
              @click="pagina = data.pagina + 1">Próxima</button>
    </div>
  </div>

  <p v-else-if="pending" class="card mt-6 text-tinta-suave">Carregando…</p>

  <div v-else class="card mt-6">
    <p class="rotulo-kpi text-erro">Não foi possível carregar o histórico</p>
    <p class="mt-1 text-sm text-tinta-suave">
      {{ (falha as any)?.data?.statusMessage || (falha as any)?.message || 'Erro desconhecido.' }}
    </p>
    <button type="button" class="btn-secundario mt-3" @click="refresh()">Tentar de novo</button>
  </div>
</template>
