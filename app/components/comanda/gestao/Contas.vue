<script setup lang="ts">
/** Contas (055): todas as contas, com busca por nome, telefone, número da conta ou da pulseira. */
import { chamar, mensagemDoErro } from '~/composables/comandaOffline'
import { baixarCsv } from '~/composables/baixarCsv'
import { dataHora, reais } from '~/composables/formato'

const busca = ref('')
const situacao = ref('')
const dia = ref('')
const contas = ref<any[]>([])
const erro = ref('')
let espera: ReturnType<typeof setTimeout> | undefined
async function carregar() {
  try {
    contas.value = (await chamar<any>('/api/comandas/gestao/contas', { query: { q: busca.value, situacao: situacao.value, dia: dia.value } })).contas
    erro.value = ''
  } catch (e) { erro.value = mensagemDoErro(e) }
}
watch([situacao, dia], carregar, { immediate: true })
watch(busca, () => { clearTimeout(espera); espera = setTimeout(carregar, 300) })
function exportar() {
  baixarCsv('comandas-contas', ['Nº', 'Nome', 'Responsável', 'WhatsApp', 'Aberta', 'Fechada', 'Situação', 'Consumo', 'Pago', 'Falta'],
    contas.value.map((c) => [c.numero, c.nome, c.responsavelNome, c.responsavelTelefone ?? '', dataHora(c.abertaEm), c.fechadaEm ? dataHora(c.fechadaEm) : '',
      SIT[c.situacao]?.[0] ?? c.situacao, (c.totalCents / 100).toFixed(2).replace('.', ','), (c.pagoCents / 100).toFixed(2).replace('.', ','), (c.faltaCents / 100).toFixed(2).replace('.', ',')]))
}
const SIT: Record<string, [string, string]> = {
  aberta: ['Aberta', 'selo-ok'], paga: ['Paga', 'selo-neutro'], paga_depois: ['Paga depois', 'selo-neutro'],
  nao_paga: ['Não paga', 'selo-erro'], cobrada: ['Cobrada', 'selo-alerta'], perdoada: ['Perdoada', 'selo-neutro'], juntada: ['Juntada', 'selo-neutro'],
}
</script>

<template>
  <div class="space-y-4">
    <div class="card flex flex-wrap gap-3 p-4">
      <input v-model="busca" class="campo min-w-[220px] flex-1" placeholder="Nome, telefone, nº da conta ou pulseira">
      <select v-model="situacao" class="campo w-auto">
        <option value="">Todas</option>
        <option value="aberta">Abertas</option>
        <option value="devendo">Devendo (não paga / cobrada)</option>
        <option value="paga">Pagas</option>
        <option value="paga_depois">Pagas depois</option>
        <option value="perdoada">Perdoadas</option>
        <option value="juntada">Juntadas</option>
      </select>
      <input v-model="dia" type="date" class="campo w-auto" title="Dia em que a conta foi aberta">
      <button type="button" class="btn-secundario" :disabled="!contas.length" @click="exportar">Baixar planilha</button>
    </div>
    <p v-if="erro" class="faixa-erro">{{ erro }}</p>
    <div class="card overflow-x-auto p-5">
      <table class="w-full min-w-[700px] text-sm">
        <thead class="text-left text-ink-600"><tr><th class="py-2">Nº</th><th>Nome</th><th>Responsável</th><th>Aberta</th><th>Situação</th><th class="text-right">Consumo</th><th class="text-right">Falta</th></tr></thead>
        <tbody class="divide-y divide-linha">
          <tr v-for="c in contas" :key="c.id" class="hover:bg-fundo-cinza">
            <td class="py-2"><NuxtLink :to="`/admin/comandas/conta/${c.id}`" class="font-semibold text-acao">{{ c.numero }}</NuxtLink></td>
            <td><NuxtLink :to="`/admin/comandas/conta/${c.id}`" class="font-semibold">{{ c.nome }}</NuxtLink></td>
            <td>{{ c.responsavelNome }}<br><span class="text-xs text-ink-600">{{ c.responsavelTelefone ?? '—' }}</span></td>
            <td>{{ dataHora(c.abertaEm) }}</td>
            <td><span :class="SIT[c.situacao]?.[1] ?? 'selo-neutro'">{{ SIT[c.situacao]?.[0] ?? c.situacao }}</span></td>
            <td class="text-right tabular-nums">{{ reais(c.totalCents) }}</td>
            <td class="text-right font-semibold tabular-nums" :class="c.faltaCents > 0 ? 'text-erro' : ''">{{ reais(c.faltaCents) }}</td>
          </tr>
        </tbody>
      </table>
      <p v-if="!contas.length" class="py-4 text-center text-ink-600">Nenhuma conta.</p>
    </div>
  </div>
</template>
