<script setup lang="ts">
/**
 * Equipe e regras (055): quem usa a comanda e com que nível, o PIN do gerente, e as regras
 * (limite padrão, prazo para desfazer, quem fecha conta). O login das pessoas é o MESMO do
 * painel (Configurações → Equipe); aqui só se dá o nível na comanda.
 */
import { chamar, mensagemDoErro } from '~/composables/comandaOffline'
import CampoMoeda from '~/components/CampoMoeda.vue'

const pessoas = ref<any[]>([])
const config = ref<any>(null)
const erro = ref('')
const aviso = ref('')
const pin = ref('')
async function carregar() {
  try {
    pessoas.value = (await chamar<any>('/api/comandas/equipe')).pessoas
    config.value = { ...(await chamar<any>('/api/comandas/estado')).config }
    erro.value = ''
  } catch (e) { erro.value = mensagemDoErro(e) }
}
onMounted(carregar)

async function nivel(p: any, n: string) {
  try {
    await chamar('/api/comandas/equipe', { method: 'POST', body: { userId: p.id, nivel: n || null } })
    await carregar()
  } catch (e) { erro.value = mensagemDoErro(e) }
}
async function salvarPin() {
  try {
    await chamar('/api/comandas/equipe', { method: 'POST', body: { pin: pin.value } })
    pin.value = ''
    aviso.value = 'PIN salvo.'
    await carregar()
  } catch (e) { erro.value = mensagemDoErro(e) }
}
async function salvarConfig() {
  try {
    config.value = (await chamar<any>('/api/comandas/config', { method: 'POST', body: config.value })).config
    aviso.value = 'Regras salvas.'
  } catch (e) { erro.value = mensagemDoErro(e) }
}
const NIVEL: Record<string, string> = { atendente: 'Atendente — lança pedido, vê conta, desfaz o próprio pedido', caixa: 'Caixa — fecha conta, corrige, troca pulseira', gerente: 'Gerente — tudo, inclusive desconto, perdão e cobrança' }
</script>

<template>
  <div class="space-y-4">
    <p v-if="aviso" class="faixa-aviso">{{ aviso }}</p>
    <p v-if="erro" class="faixa-erro">{{ erro }}</p>

    <div v-if="config" class="card space-y-4 p-5">
      <p class="titulo-bloco">Regras</p>
      <label class="flex items-center gap-3 rounded-card p-3" :class="config.ativo ? 'bg-success-50' : 'bg-warning-50'">
        <input v-model="config.ativo" type="checkbox" class="h-6 w-6">
        <span><b>Comandas ligadas para a equipe</b><br><span class="text-sm text-ink-700">Desligado: só o dono entra. Ligado: quem tem nível abaixo entra.</span></span>
      </label>
      <div class="grid gap-3 sm:grid-cols-2">
        <label class="block"><span class="rotulo">Limite padrão por conta (R$ 0 = sem limite)</span><CampoMoeda v-model="config.limitePadraoCents" /></label>
        <label class="block"><span class="rotulo">Avisar quando a conta passar de</span><CampoMoeda v-model="config.avisoContaAltaCents" /></label>
        <label class="block"><span class="rotulo">Horário em que o parque fecha</span><input v-model="config.horaFechamento" type="time" class="campo">
          <span class="mt-1 block text-xs text-ink-600">A partir deste horário, o Resumo do dia conta quem saiu sem pagar.</span></label>
        <label class="block"><span class="rotulo">Minutos para o atendente desfazer o próprio pedido</span><input v-model.number="config.minutosParaDesfazer" type="number" min="0" max="60" class="campo"></label>
      </div>
      <label class="flex items-center gap-2"><input v-model="config.atendenteFechaConta" type="checkbox" class="h-5 w-5"> Atendente também pode fechar conta</label>
      <label class="flex items-center gap-2"><input v-model="config.exigeCodigoWhatsapp" type="checkbox" class="h-5 w-5"> Conta sem ingresso exige código no WhatsApp</label>
      <button type="button" class="btn-primario" @click="salvarConfig">Salvar regras</button>
    </div>

    <div class="card space-y-3 p-5">
      <p class="titulo-bloco">Meu PIN de gerente</p>
      <p class="text-sm text-ink-700">É o que você digita no tablet do atendente para liberar limite, desconto ou correção.</p>
      <div class="flex gap-2"><input v-model="pin" type="password" inputmode="numeric" maxlength="6" class="campo w-40" placeholder="4 a 6 números"><button type="button" class="btn-secundario" :disabled="pin.length < 4" @click="salvarPin">Salvar PIN</button></div>
    </div>

    <div class="card p-5">
      <p class="titulo-bloco">Quem usa as comandas</p>
      <p class="text-sm text-ink-700">Para um atendente novo: crie o login em Configurações → Equipe (papel Portaria) e dê o nível aqui.</p>
      <ul class="mt-3 divide-y divide-linha">
        <li v-for="p in pessoas" :key="p.id" class="flex flex-wrap items-center justify-between gap-2 py-3" :class="p.ativo ? '' : 'opacity-50'">
          <span><b>{{ p.nome }}</b> <span class="text-sm text-ink-600">{{ p.email }}</span>
            <span v-if="p.temPin" class="selo-neutro ml-1">tem PIN</span></span>
          <span v-if="p.master" class="selo-ok">Dono — gerente</span>
          <select v-else :value="p.nivel ?? ''" class="campo w-auto" @change="nivel(p, ($event.target as HTMLSelectElement).value)">
            <option value="">Sem acesso</option>
            <option v-for="(t, k) in NIVEL" :key="k" :value="k">{{ t }}</option>
          </select>
        </li>
      </ul>
    </div>
  </div>
</template>
