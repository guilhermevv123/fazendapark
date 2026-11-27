<script setup lang="ts">
/**
 * Pendências (055): pedidos feitos SEM internet que só chegaram depois de a conta ser paga.
 * Nada some sozinho — o gerente decide: cobrar (a conta vira "não paga" pelo que falta) ou
 * cancelar (o parque assume).
 */
import { chamar, mensagemDoErro } from '~/composables/comandaOffline'
import { dataHora, reais } from '~/composables/formato'

const lista = ref<any[]>([])
const erro = ref('')
const motivo = reactive<Record<string, string>>({})
async function carregar() {
  try { lista.value = (await chamar<any>('/api/comandas/gestao/pendencias')).pendencias; erro.value = '' } catch (e) { erro.value = mensagemDoErro(e) }
}
onMounted(carregar)
async function decidir(id: string, decisao: 'cobrar' | 'cancelar') {
  try {
    await chamar('/api/comandas/gestao/pendencias', { method: 'POST', body: { id, decisao, motivo: motivo[id] } })
    await carregar()
  } catch (e) { erro.value = mensagemDoErro(e) }
}
</script>

<template>
  <div class="space-y-4">
    <p class="faixa-aviso">Aqui aparecem pedidos feitos num tablet sem internet que só chegaram ao sistema depois de a conta do cliente ter sido paga.</p>
    <p v-if="erro" class="faixa-erro">{{ erro }}</p>
    <p v-if="!lista.length" class="card p-8 text-center text-ink-600">Nenhuma pendência. ✓</p>
    <div v-for="p in lista" :key="p.id" class="card space-y-3 p-5">
      <div class="flex flex-wrap justify-between gap-2">
        <div>
          <p class="titulo text-lg font-bold">{{ p.itens }} — {{ reais(p.valorCents) }}</p>
          <p class="text-sm">Conta nº {{ p.numero }} · <b>{{ p.nome }}</b> · responsável {{ p.responsavelNome }} {{ p.responsavelTelefone }}</p>
          <p class="text-xs text-ink-600">Feito {{ dataHora(p.feitoEm) }} por {{ p.atendente ?? '—' }} · chegou {{ dataHora(p.recebidoEm) }}<span v-if="p.mesa"> · {{ p.mesa }}</span></p>
        </div>
        <NuxtLink :to="`/admin/comandas/conta/${p.comandaId}`" class="btn-secundario h-fit">Ver conta</NuxtLink>
      </div>
      <input v-model="motivo[p.id]" class="campo" placeholder="Motivo da decisão (obrigatório)">
      <div class="flex flex-wrap gap-2">
        <button type="button" class="btn-primario" :disabled="!motivo[p.id]" @click="decidir(p.id, 'cobrar')">Manter e cobrar o cliente</button>
        <button type="button" class="btn-secundario" :disabled="!motivo[p.id]" @click="decidir(p.id, 'cancelar')">Cancelar (o parque assume)</button>
      </div>
    </div>
  </div>
</template>
