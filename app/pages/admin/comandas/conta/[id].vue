<script setup lang="ts">
/** A ficha completa de uma conta (055), dentro do painel: tudo o que a conta teve, e as ações do gerente. */
import ComandaConta from '~/components/comanda/Conta.vue'
import ComandaPagamento from '~/components/comanda/Pagamento.vue'
import { chamar } from '~/composables/comandaOffline'

definePageMeta({ layout: 'admin' })
useHead({ title: 'Conta — Comandas' })
const route = useRoute()
const id = computed(() => String(route.params.id))
const itens = ref<any[]>([])
const aPagar = ref<any[] | null>(null)
const contaRef = ref<InstanceType<typeof ComandaConta> | null>(null)
onMounted(async () => { try { itens.value = (await chamar<any>('/api/comandas/estado')).itens } catch { /* só a troca de item fica sem lista */ } })
function fechar(conta: any) { aPagar.value = [{ id: conta.id, numero: conta.numero, nome: conta.nome, faltaCents: conta.faltaCents }] }
</script>

<template>
  <div class="space-y-4">
    <NuxtLink to="/admin/comandas?aba=contas" class="text-sm font-semibold text-acao">← Contas</NuxtLink>
    <ClientOnly>
      <ComandaPagamento v-if="aPagar" :contas="aPagar" @pago="aPagar = null; contaRef?.carregar()" @voltar="aPagar = null" />
      <ComandaConta v-else :id="id" ref="contaRef" :itens-do-cardapio="itens" @fechar="fechar" />
    </ClientOnly>
  </div>
</template>
