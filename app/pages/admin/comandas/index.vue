<script setup lang="ts">
/**
 * Gestão das comandas (055) — dentro do painel, só pro dono enquanto as comandas estão sendo
 * testadas (`/admin/comandas` não está classificada em `papeis.ts`: master apenas).
 *
 * Sete seções, cada uma com uma pergunta só: como está agora (Visão geral), como fechou o dia
 * e quem saiu sem pagar (Resumo do dia), receber e fechar o caixa (Caixa), de quem é cada conta
 * (Contas), quanto vendeu (Relatórios), o que se vende (Produtos) e as regras (Configurações). Seção e sub-aba moram
 * na URL (`?aba=&ver=`), então o F5 volta no mesmo lugar.
 */
import { chamar } from '~/composables/comandaOffline'
import ComandaSituacao from '~/components/comanda/Situacao.vue'
import ComandaCaixa from '~/components/comanda/Caixa.vue'
import ComandaAoVivo from '~/components/comanda/gestao/AoVivo.vue'
import ComandaVendas from '~/components/comanda/gestao/Vendas.vue'
import ComandaPedidos from '~/components/comanda/gestao/Pedidos.vue'
import ComandaResumo from '~/components/comanda/gestao/Resumo.vue'
import ComandaContas from '~/components/comanda/gestao/Contas.vue'
import ComandaPendencias from '~/components/comanda/gestao/Pendencias.vue'
import ComandaProdutos from '~/components/comanda/gestao/Produtos.vue'
import ComandaLocais from '~/components/comanda/gestao/Locais.vue'
import ComandaPulseiras from '~/components/comanda/gestao/Pulseiras.vue'
import ComandaEquipe from '~/components/comanda/gestao/Equipe.vue'
import ComandaLinks from '~/components/comanda/gestao/Links.vue'

definePageMeta({ layout: 'admin' })
useHead({ title: 'Comandas — Gestão' })

type Secao = { id: string; nome: string; resumo: string; partes?: { id: string; nome: string }[] }
const SECOES: Secao[] = [
  { id: 'geral', nome: 'Visão geral', resumo: 'Como está o dia agora: vendas, recebimentos e contas abertas.' },
  { id: 'dia', nome: 'Resumo do dia', resumo: 'O fechamento do dia: quanto vendeu, quanto entrou e quem saiu sem pagar.' },
  { id: 'caixa', nome: 'Caixa', resumo: 'Receber dos clientes e fechar o seu caixa no fim do expediente.' },
  { id: 'contas', nome: 'Contas', resumo: 'Todas as contas dos clientes e os pedidos que chegaram depois da conta fechada.',
    partes: [{ id: 'todas', nome: 'Todas as contas' }, { id: 'pendencias', nome: 'Pedidos atrasados' }] },
  { id: 'relatorios', nome: 'Relatórios', resumo: 'Quanto vendeu, o quê, onde e quando, em qualquer período.',
    partes: [{ id: 'vendas', nome: 'Vendas' }, { id: 'pedidos', nome: 'Todos os pedidos' }] },
  { id: 'produtos', nome: 'Produtos', resumo: 'O que vocês vendem. Tudo aqui aparece no Novo pedido dos tablets.' },
  { id: 'config', nome: 'Configurações', resumo: 'Locais de venda, pulseiras, equipe, regras e horário de fechamento.',
    partes: [{ id: 'locais', nome: 'Locais de venda' }, { id: 'links', nome: 'Links dos atendentes' }, { id: 'pulseiras', nome: 'Pulseiras' }, { id: 'equipe', nome: 'Equipe e regras' }] },
]
const route = useRoute()
const secao = computed(() => SECOES.find((s) => s.id === route.query.aba) ?? SECOES[0]!)
const parte = computed(() => secao.value.partes?.find((p) => p.id === route.query.ver)?.id ?? secao.value.partes?.[0]?.id ?? '')

// números do topo e a marca de pedidos atrasados no menu
const hoje = ref<any>(null)
let laco: ReturnType<typeof setInterval> | undefined
async function carregar() { try { hoje.value = await chamar<any>('/api/comandas/gestao/aovivo') } catch { /* espera a próxima */ } }
onMounted(() => { carregar(); laco = setInterval(carregar, 15_000) })
onBeforeUnmount(() => clearInterval(laco))
const marca = (id: string) => id === 'contas' ? hoje.value?.pendencias || 0 : 0
</script>

<template>
  <div class="space-y-5">
    <div class="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 class="titulo text-2xl font-bold">Gestão das comandas</h1>
        <p class="text-sm text-ink-600">{{ secao.resumo }}</p>
      </div>
    </div>

    <!-- seções -->
    <nav class="-mb-px flex gap-6 overflow-x-auto border-b border-linha sem-barra" aria-label="Seções da gestão">
      <NuxtLink v-for="s in SECOES" :key="s.id" :to="{ query: { aba: s.id } }"
                class="flex items-center gap-1.5 whitespace-nowrap border-b-2 pb-3 pt-1 text-[15px] font-semibold transition"
                :class="secao.id === s.id ? 'border-acao text-acao' : 'border-transparent text-ink-600 hover:text-ink-900'">
        {{ s.nome }}
        <ClientOnly><span v-if="marca(s.id)" class="rounded-full bg-danger-600 px-1.5 text-xs text-white">{{ marca(s.id) }}</span></ClientOnly>
      </NuxtLink>
    </nav>

    <ClientOnly>
      <NuxtLink v-if="hoje?.pendencias && secao.id !== 'contas'" :to="{ query: { aba: 'contas', ver: 'pendencias' } }" class="faixa-erro block font-semibold">
        {{ hoje.pendencias }} pedido(s) chegaram depois da conta fechada. Toque para decidir →
      </NuxtLink>
    </ClientOnly>

    <!-- sub-abas da seção -->
    <div v-if="secao.partes" class="inline-flex flex-wrap rounded-card border border-linha bg-white p-1">
      <NuxtLink v-for="p in secao.partes" :key="p.id" :to="{ query: { aba: secao.id, ver: p.id } }"
                class="rounded-card px-4 py-2 text-sm font-semibold transition"
                :class="parte === p.id ? 'bg-acao text-white' : 'text-ink-700 hover:bg-ink-50'">{{ p.nome }}</NuxtLink>
    </div>

    <ClientOnly>
      <ComandaAoVivo v-if="secao.id === 'geral'" />
      <ComandaResumo v-else-if="secao.id === 'dia'" />
      <ComandaSituacao v-else-if="secao.id === 'caixa'" discreta><ComandaCaixa embutido /></ComandaSituacao>
      <template v-else-if="secao.id === 'contas'">
        <ComandaContas v-if="parte === 'todas'" />
        <ComandaPendencias v-else />
      </template>
      <template v-else-if="secao.id === 'relatorios'">
        <ComandaVendas v-if="parte === 'vendas'" />
        <ComandaPedidos v-else />
      </template>
      <ComandaProdutos v-else-if="secao.id === 'produtos'" />
      <template v-else-if="secao.id === 'config'">
        <ComandaLocais v-if="parte === 'locais'" />
        <ComandaLinks v-else-if="parte === 'links'" />
        <ComandaPulseiras v-else-if="parte === 'pulseiras'" />
        <ComandaEquipe v-else />
      </template>
    </ClientOnly>
  </div>
</template>
