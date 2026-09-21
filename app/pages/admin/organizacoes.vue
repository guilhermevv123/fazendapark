<script setup lang="ts">
/**
 * Organizações — as contas de produtor que esta sessão enxerga.
 *
 * Hoje é sempre uma: a rota recorta pela organização da sessão, de propósito
 * (ver o comentário em server/api/admin/organizacoes.get.ts — ela já devolveu
 * a lista inteira do banco pra qualquer login). A tela é lista mesmo assim
 * porque o dia em que uma pessoa operar duas produtoras, é esta a porta.
 */
definePageMeta({ layout: 'admin' })

const { data, pending, error: falha, refresh } = await useFetch<any>('/api/admin/organizacoes')

const brl = (c: number) => (c / 100).toLocaleString('pt-BR',
  { style: 'currency', currency: 'BRL' })

useHead({ title: 'Organizações' })
</script>

<template>
  <div v-if="data">
    <div class="flex flex-wrap items-start justify-between gap-3 py-5">
      <div>
        <h1 class="titulo text-2xl font-semibold text-tinta">Organizações</h1>
        <p class="mt-1 text-tinta-suave">
          As contas de produtor no seu acesso.
        </p>
      </div>
      <NuxtLink to="/admin/configuracoes" class="btn-secundario">Configurações</NuxtLink>
    </div>

    <p v-if="!data.length" class="card mt-2 py-12 text-center text-tinta-suave">
      Nenhuma organização no seu acesso.
    </p>

    <div v-else class="grid gap-3 lg:grid-cols-2">
      <article v-for="o in data" :key="o.id" class="card">
        <div class="flex items-start justify-between gap-3">
          <div>
            <h2 class="titulo text-lg font-semibold text-tinta">{{ o.nome }}</h2>
            <p class="font-mono text-xs text-tinta-fraca">/{{ o.slug }}</p>
          </div>
          <span :class="o.temAsaas
                  ? (o.ambienteAsaas === 'production' ? 'selo-ok' : 'selo-alerta')
                  : 'selo-erro'">
            {{ o.temAsaas
               ? (o.ambienteAsaas === 'production' ? 'RECEBENDO' : 'EM TESTES')
               : 'SEM COBRANÇA' }}
          </span>
        </div>

        <dl class="mt-4 grid grid-cols-2 gap-y-2 text-sm text-tinta-suave">
          <dt>Documento</dt>
          <dd class="text-right text-tinta">{{ o.documento || '—' }}</dd>
          <dt>Eventos</dt>
          <dd class="text-right text-tinta">
            {{ o.eventos }}
            <span v-if="o.eventosAtivos" class="text-xs text-ok">
              ({{ o.eventosAtivos }} ativo{{ o.eventosAtivos > 1 ? 's' : '' }})
            </span>
          </dd>
          <dt>Pessoas com acesso</dt>
          <dd class="text-right text-tinta">{{ o.pessoas }}</dd>
          <dt>Faturado</dt>
          <dd class="text-right font-medium tabular-nums text-tinta">{{ brl(o.faturadoCents) }}</dd>
          <dt>Desde</dt>
          <dd class="text-right text-tinta">
            {{ new Date(o.criadoEm).toLocaleDateString('pt-BR') }}
          </dd>
        </dl>

        <p v-if="!o.temAsaas"
           class="mt-3 rounded-card border border-alerta bg-alerta-claro px-3 py-2 text-sm text-alerta">
          Sem chave do Asaas configurada — nenhuma cobrança sai daqui.
        </p>

        <div class="mt-4 flex gap-2">
          <NuxtLink to="/admin" class="btn-secundario flex-1 justify-center">Eventos</NuxtLink>
          <NuxtLink to="/admin/equipe" class="btn-secundario flex-1 justify-center">Equipe</NuxtLink>
          <NuxtLink to="/admin/financeiro" class="btn-secundario flex-1 justify-center">Financeiro</NuxtLink>
        </div>
      </article>
    </div>
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
