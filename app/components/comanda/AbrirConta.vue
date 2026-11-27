<script setup lang="ts">
/**
 * Abrir conta numa pulseira livre (055). O dado do responsável tem que ser CONFIRMADO — é
 * ele que garante a cobrança de quem sair sem pagar:
 *
 * - **Pelo ingresso** (o normal): lê o QR ou digita o código. O responsável é quem COMPROU
 *   (o contato que pagou). Acompanhante vira "Fulano, grupo de João" e a cobrança vai pro João.
 * - **Sem ingresso**: nome + WhatsApp, e o cliente diz o código de 4 números que chegou no
 *   WhatsApp dele. Sem o código, só com o PIN do gerente (fica marcado "não confirmado").
 *
 * Precisa de internet.
 */
import { chamar, mensagemDoErro } from '~/composables/comandaOffline'
import { reais } from '~/composables/formato'
import LeitorCamera from '~/components/LeitorCamera.vue'

const props = defineProps<{ uid: string; pontoId?: string | null; limitePadraoCents: number; gerente: boolean; nomeInicial?: string }>()
const emit = defineEmits<{ aberta: [conta: any]; voltar: [] }>()

const modo = ref<'ingresso' | 'manual'>('ingresso')
const erro = ref('')
const enviando = ref(false)

// pelo ingresso
const codigoIngresso = ref('')
const qr = ref('')
const camera = ref(false)
const ingresso = ref<any>(null)
const nome = ref(props.nomeInicial ?? '')
const menor = ref(false)

async function consultar(porQr?: string) {
  erro.value = ''
  ingresso.value = null
  qr.value = porQr ?? ''
  try {
    ingresso.value = await chamar<any>('/api/comandas/ingresso', { method: 'POST', body: porQr ? { qr: porQr } : { codigo: codigoIngresso.value } })
    nome.value = props.nomeInicial || ingresso.value.nomeSugerido
    camera.value = false
  } catch (e) { erro.value = mensagemDoErro(e, 'Ingresso não encontrado.') }
}

// sem ingresso
const telefone = ref('')
const documento = ref('')
const codigo = ref('')
const codigoEnviado = ref(false)
const codigoDeTeste = ref('')
const pin = ref('')
const semCodigo = ref(false)

async function mandarCodigo() {
  erro.value = ''
  try {
    const r = await chamar<any>('/api/comandas/codigo', { method: 'POST', body: { telefone: telefone.value } })
    codigoEnviado.value = true
    codigoDeTeste.value = r.simulado ? r.codigo : ''
  } catch (e) { erro.value = mensagemDoErro(e) }
}

async function abrir() {
  erro.value = ''
  enviando.value = true
  try {
    const base = { uid: props.uid, pontoId: props.pontoId, menor: menor.value, nome: nome.value }
    const corpo = modo.value === 'ingresso'
      ? { ...base, modo: 'ingresso', qr: qr.value || undefined, codigoIngresso: qr.value ? undefined : codigoIngresso.value }
      : { ...base, modo: 'manual', telefone: telefone.value, documento: documento.value, codigo: semCodigo.value ? undefined : codigo.value, pin: semCodigo.value ? pin.value : undefined }
    const r = await chamar<any>('/api/comandas/abrir', { method: 'POST', body: corpo })
    emit('aberta', r.conta)
  } catch (e) { erro.value = mensagemDoErro(e) } finally { enviando.value = false }
}
</script>

<template>
  <div data-parte="abrir-conta" class="space-y-4">
    <div class="card p-5">
      <p class="text-sm font-semibold text-ink-600">Pulseira {{ uid }}</p>
      <p class="titulo text-2xl font-bold">Abrir conta</p>
      <p class="mt-1 text-sm text-ink-600">Limite padrão: {{ limitePadraoCents ? reais(limitePadraoCents) : 'sem limite' }}</p>
      <div class="mt-4 flex gap-2">
        <button type="button" class="chip min-h-[48px] flex-1" :class="modo === 'ingresso' ? 'chip-ativo' : ''" @click="modo = 'ingresso'">Tem ingresso</button>
        <button type="button" class="chip min-h-[48px] flex-1" :class="modo === 'manual' ? 'chip-ativo' : ''" @click="modo = 'manual'">Sem ingresso</button>
      </div>
    </div>

    <div v-if="modo === 'ingresso'" class="card space-y-3 p-5">
      <div class="flex gap-2">
        <input v-model="codigoIngresso" class="campo flex-1" placeholder="Código do ingresso" autocapitalize="characters" @keydown.enter.prevent="consultar()">
        <button type="button" class="btn-secundario" :disabled="!codigoIngresso" @click="consultar()">Buscar</button>
        <button type="button" class="btn-secundario" @click="camera = !camera">{{ camera ? 'Fechar câmera' : 'Ler QR' }}</button>
      </div>
      <LeitorCamera v-if="camera" @ler="consultar" />
      <div v-if="ingresso" class="space-y-3 rounded-card bg-fundo-cinza p-4">
        <p class="text-sm">Ingresso <b>{{ ingresso.ingresso.codigo }}</b> · {{ ingresso.ingresso.evento }} · pessoa {{ ingresso.ingresso.posicao }} de {{ ingresso.ingresso.noPedido }}</p>
        <p class="text-sm">Quem comprou (responsável e quem paga): <b>{{ ingresso.responsavel.nome }}</b> · {{ ingresso.responsavel.telefone ?? 'sem telefone' }}</p>
        <p v-if="ingresso.jaTemConta" class="faixa-aviso">Este ingresso já tem conta aberta (nº {{ ingresso.jaTemConta.numero }}). Confira se não é a mesma pessoa.</p>
        <p v-if="ingresso.divida" class="faixa-erro">Atenção: este comprador tem conta antiga NÃO PAGA de {{ reais(ingresso.divida.totalCents) }}. Chame o gerente.</p>
        <label class="block">
          <span class="rotulo">Nome de quem vai usar a pulseira</span>
          <input v-model="nome" class="campo text-lg">
        </label>
      </div>
    </div>

    <div v-else class="card space-y-3 p-5">
      <label class="block"><span class="rotulo">Nome completo</span><input v-model="nome" class="campo text-lg" autocomplete="off"></label>
      <div class="grid gap-3 sm:grid-cols-2">
        <label class="block"><span class="rotulo">WhatsApp com DDD</span><input v-model="telefone" class="campo" inputmode="tel" placeholder="77 99999-0000"></label>
        <label class="block"><span class="rotulo">CPF (opcional)</span><input v-model="documento" class="campo" inputmode="numeric"></label>
      </div>
      <template v-if="!semCodigo">
        <button type="button" class="btn-secundario w-full" :disabled="!telefone || !nome" @click="mandarCodigo">{{ codigoEnviado ? 'Mandar o código de novo' : 'Mandar código no WhatsApp do cliente' }}</button>
        <p v-if="codigoDeTeste" class="faixa-aviso">Modo de teste (sem WhatsApp ligado): o código é <b>{{ codigoDeTeste }}</b>.</p>
        <label v-if="codigoEnviado" class="block"><span class="rotulo">Código que o cliente recebeu</span><input v-model="codigo" class="campo text-center text-2xl tracking-[0.4em]" inputmode="numeric" maxlength="4"></label>
      </template>
      <label class="flex items-center gap-2 text-sm"><input v-model="semCodigo" type="checkbox" class="h-5 w-5"> Cliente sem WhatsApp agora (precisa do gerente)</label>
      <label v-if="semCodigo && !gerente" class="block"><span class="rotulo">PIN do gerente</span><input v-model="pin" type="password" class="campo" inputmode="numeric" autocomplete="off"></label>
    </div>

    <label class="card flex items-center gap-3 p-4"><input v-model="menor" type="checkbox" class="h-6 w-6"> <span><b>Menor de 18 anos</b> — o tablet não deixa lançar bebida alcoólica</span></label>

    <p v-if="erro" class="faixa-erro">{{ erro }}</p>
    <div class="flex gap-3">
      <button type="button" class="btn-secundario min-h-[56px] flex-1" @click="emit('voltar')">Voltar</button>
      <button type="button" data-acao="abrir" class="btn-primario min-h-[56px] flex-[2] text-lg"
              :disabled="enviando || !nome || (modo === 'ingresso' ? !ingresso : (semCodigo ? (!gerente && !pin) : codigo.length !== 4))"
              @click="abrir">{{ enviando ? 'Abrindo…' : 'Abrir conta nesta pulseira' }}</button>
    </div>
  </div>
</template>
