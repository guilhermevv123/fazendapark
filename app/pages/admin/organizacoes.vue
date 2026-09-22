<script setup lang="ts">
/**
 * Organização — a conta de produtor desta sessão (no menu o nome é singular:
 * o parque é uma organização só, com vários eventos).
 *
 * Hoje é sempre uma: a rota recorta pela organização da sessão, de propósito
 * (ver o comentário em server/api/admin/organizacoes.get.ts — ela já devolveu
 * a lista inteira do banco pra qualquer login). A tela é TABELA mesmo assim
 * — busca, filtro e Ações inclusos — porque o dia em que uma pessoa operar
 * duas produtoras, é esta a porta; uma tabela de uma linha só continua certa,
 * uma lista de cartões-resumo de uma linha só não escala pra dez.
 */
definePageMeta({ layout: 'admin' })

const { data, pending, error: falha, refresh } = await useFetch<any[]>('/api/admin/organizacoes')

const brl = (c: number) => (c / 100).toLocaleString('pt-BR',
  { style: 'currency', currency: 'BRL' })

/**
 * A situação de cobrança, numa função só: decide a cor do selo E a chave do
 * filtro, pra elas nunca dizerem coisas diferentes uma da outra.
 */
function situacao(o: any): { chave: 'sem' | 'testes' | 'recebendo'; t: string; c: string } {
  if (!o.temAsaas) return { chave: 'sem', t: 'SEM COBRANÇA', c: 'selo-erro' }
  return o.ambienteAsaas === 'production'
    ? { chave: 'recebendo', t: 'RECEBENDO', c: 'selo-ok' }
    : { chave: 'testes', t: 'EM TESTES', c: 'selo-alerta' }
}

const busca = ref('')
const filtro = ref<'todos' | 'sem' | 'testes' | 'recebendo'>('todos')
const temFiltro = computed(() => !!busca.value.trim() || filtro.value !== 'todos')

const lista = computed(() => (data.value ?? []).filter((o: any) => {
  if (filtro.value !== 'todos' && situacao(o).chave !== filtro.value) return false
  const t = busca.value.trim().toLowerCase()
  return !t || `${o.nome} ${o.slug} ${o.documento ?? ''}`.toLowerCase().includes(t)
}))

useHead({ title: 'Organização' })
</script>

<template>
  <div v-if="data">
    <div class="flex flex-wrap items-start justify-between gap-3 py-5">
      <div>
        <h1 class="titulo text-2xl font-semibold text-tinta">Organização</h1>
        <p class="mt-1 text-tinta-suave">
          A conta do parque: eventos, clientes e dinheiro num lugar só.
        </p>
      </div>
      <NuxtLink to="/admin/configuracoes" class="btn-secundario">Configurações</NuxtLink>
    </div>

    <p v-if="!data.length" class="card mt-2 py-12 text-center text-tinta-suave">
      Nenhuma organização no seu acesso.
    </p>

    <template v-else>
      <div class="mb-4 flex flex-wrap items-center gap-2">
        <div class="relative">
          <span class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-tinta-fraca">
            <IconeMenu nome="busca" :tamanho="18" />
          </span>
          <input v-model="busca" class="campo w-72 pl-10" placeholder="Buscar por nome, slug ou documento…"
                 aria-label="Buscar organização">
        </div>
        <button v-for="f in (['todos', 'recebendo', 'testes', 'sem'] as const)" :key="f"
                type="button" :class="filtro === f ? 'chip-ativo' : 'chip'" @click="filtro = f">
          {{ f === 'todos' ? 'Todos'
             : f === 'recebendo' ? 'Recebendo'
             : f === 'testes' ? 'Em testes' : 'Sem cobrança' }}
        </button>
      </div>

      <p v-if="!lista.length" class="card py-12 text-center text-tinta-suave">
        Nenhuma organização com esses filtros.
      </p>

      <div v-else class="card p-0">
        <div class="overflow-x-auto">
          <table class="w-full min-w-[52rem] text-sm">
            <thead>
              <tr class="border-b border-linha text-left text-xs text-tinta-fraca">
                <th class="px-4 py-3 font-semibold">Organização</th>
                <th class="px-3 py-3 font-semibold">Documento</th>
                <th class="px-3 py-3 text-right font-semibold">Eventos</th>
                <th class="px-3 py-3 text-right font-semibold">Faturado</th>
                <th class="px-3 py-3 font-semibold">Situação</th>
                <th class="px-4 py-3 text-right font-semibold">Ações</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="o in lista" :key="o.id" class="border-b border-linha align-top last:border-0 hover:bg-fundo-cinza">
                <td class="px-4 py-3">
                  <p class="font-medium text-tinta">{{ o.nome }}</p>
                  <p class="font-mono text-xs text-tinta-fraca">/{{ o.slug }}</p>
                  <p v-if="!o.temAsaas" class="mt-1 text-xs font-medium text-alerta">
                    Sem chave do Asaas — nenhuma cobrança sai daqui.
                  </p>
                </td>
                <td class="px-3 py-3 text-tinta-suave">{{ o.documento || '—' }}</td>
                <td class="px-3 py-3 text-right tabular-nums">
                  <p class="text-tinta">{{ o.eventos }}</p>
                  <p v-if="o.eventosAtivos" class="text-xs text-ok">
                    {{ o.eventosAtivos }} ativo{{ o.eventosAtivos > 1 ? 's' : '' }}
                  </p>
                </td>
                <td class="px-3 py-3 text-right tabular-nums">
                  <p class="font-medium text-tinta">{{ brl(o.faturadoCents) }}</p>
                  <!-- o que o comprador pagou (linha de cima) e o que sobra pro
                       produtor depois de taxa e devolução (esta) são números
                       diferentes de propósito — ver o comentário da rota. -->
                  <p class="text-xs text-tinta-fraca">líquido {{ brl(o.liquidoCents) }}</p>
                </td>
                <td class="px-3 py-3">
                  <span :class="situacao(o).c">{{ situacao(o).t }}</span>
                </td>
                <td class="px-4 py-3 text-right">
                  <NuxtLink to="/admin/configuracoes"
                            class="inline-grid size-8 place-items-center rounded-lg text-tinta-fraca transition-colors hover:bg-fundo-cinza hover:text-tinta"
                            aria-label="Editar organização">
                    <IconeMenu nome="lapis" :tamanho="16" />
                  </NuxtLink>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>
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
