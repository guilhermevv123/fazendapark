<script setup lang="ts">
/**
 * O cupom de consumação do Volte Mais visto pelo CAIXA DO BAR (042). Uma resposta grande e colorida
 * (VÁLIDO verde / JÁ USADO vermelho), o nome e o CPF pra conferir com o documento, a hora da
 * entrada de hoje, e o botão que dá a baixa. A decisão é do servidor (`POST /api/admin/consumacao`):
 * esta tela só mostra o que ele respondeu.
 *
 * Sem a entrada do dia na portaria, o servidor recusa com `sem_entrada`; a atendente confere o
 * documento e libera com um segundo toque (fica marcado na baixa). Nada de caixa nativa de
 * confirmação: o segundo passo é um botão na própria tela.
 */
import type { CupomNoCaixa } from '~/composables/cupomImagem'


const props = defineProps<{ cupom: CupomNoCaixa }>()
const emit = defineEmits<{ atualizado: [CupomNoCaixa] }>()

const dando = ref(false)
const erro = ref('')
const pedeDocumento = ref(false)
const acabouDeDar = ref(false)
watch(() => props.cupom.token, () => { erro.value = ''; pedeDocumento.value = false; acabouDeDar.value = false })

const verde = computed(() => props.cupom.estado === 'valido' || props.cupom.estado === 'ativo')
const amarelo = computed(() => props.cupom.estado === 'antes_do_dia')
const diaBR = (iso: string) => iso.split('-').reverse().join('/')
/** "Ana Souza <ana@…>" → "Ana Souza": a tela do bar mostra quem deu a baixa, não o e-mail */
const soNome = (quem: string | null) => String(quem ?? '').replace(/\s*<[^>]*>\s*$/, '') || 'caixa'

async function darBaixa(semEntrada = false) {
  if (dando.value) return
  dando.value = true
  erro.value = ''
  try {
    const r = await $fetch<{ cupom: CupomNoCaixa }>('/api/admin/consumacao', {
      method: 'POST', body: { token: props.cupom.token, semEntrada },
    })
    pedeDocumento.value = false
    acabouDeDar.value = true
    emit('atualizado', r.cupom)
  } catch (e: any) {
    const tipo = e?.data?.data?.tipo
    if (e?.data?.data?.cupom) emit('atualizado', e.data.data.cupom)
    if (tipo === 'sem_entrada') pedeDocumento.value = true
    erro.value = e?.data?.statusMessage || e?.statusMessage || 'Não consegui dar baixa agora. Confira a internet.'
  } finally {
    dando.value = false
  }
}
</script>

<template>
  <section class="overflow-hidden rounded-card bg-white shadow-card ring-1 ring-linha" data-parte="caixa-do-cupom" :data-estado="cupom.estado">
    <div class="px-5 py-5 text-center text-white"
         :class="acabouDeDar ? 'bg-success-700' : verde ? 'bg-success-600' : amarelo ? 'bg-warning-600' : 'bg-danger-600'">
      <p class="text-xs font-bold uppercase tracking-[0.14em] opacity-90">Cupom {{ cupom.programa }} · {{ cupom.consumacaoPct }}% no bar</p>
      <p class="titulo mt-1 text-4xl font-extrabold" data-parte="estado-do-cupom">
        {{ acabouDeDar ? 'BAIXA DADA ✓' : cupom.recado }}
      </p>
      <p v-if="acabouDeDar" class="mt-1 text-base font-semibold">Aplique {{ cupom.consumacaoPct }}% na conta do cliente.</p>
      <p v-else-if="cupom.estado === 'usado' && cupom.usos.length" class="mt-1 text-sm">
        Usado às {{ cupom.usos[cupom.usos.length - 1]!.em }}<template v-if="cupom.usos[cupom.usos.length - 1]!.por"> por {{ soNome(cupom.usos[cupom.usos.length - 1]!.por) }}</template>
      </p>
      <p v-else-if="cupom.estado === 'ativo'" class="mt-1 text-sm">Ativado às {{ cupom.usos[0]?.em }} — vale o dia todo: aplique {{ cupom.consumacaoPct }}%.</p>
      <p v-else-if="cupom.estado === 'antes_do_dia' || cupom.estado === 'passou_o_dia'" class="mt-1 text-sm">Vale só em {{ diaBR(cupom.dia) }}.</p>
    </div>

    <dl class="grid gap-2 px-5 py-4 text-sm">
      <div class="flex justify-between gap-3"><dt class="text-tinta-fraca">Titular</dt>
        <dd class="text-right text-base font-semibold text-tinta" data-parte="titular-do-cupom">{{ cupom.titular ?? '—' }}</dd></div>
      <div v-if="cupom.cpf" class="flex justify-between gap-3"><dt class="text-tinta-fraca">CPF (confira no documento)</dt>
        <dd class="whitespace-nowrap text-right font-mono text-tinta">{{ cupom.cpf }}</dd></div>
      <div class="flex justify-between gap-3"><dt class="text-tinta-fraca">Entrada hoje</dt>
        <dd class="text-right font-medium" :class="cupom.entradaHoje ? 'text-success-700' : 'text-warning-700'" data-parte="entrada-do-cupom">
          {{ cupom.entradaHoje ? `às ${cupom.entradaHoje}` : 'não registrada' }}
        </dd></div>
      <div class="flex justify-between gap-3"><dt class="text-tinta-fraca">Código</dt>
        <dd class="text-right font-mono font-semibold tracking-widest text-tinta">{{ cupom.codigo }}</dd></div>
      <div class="flex justify-between gap-3"><dt class="text-tinta-fraca">Pedido</dt>
        <dd class="text-right tabular-nums text-tinta-corpo">{{ cupom.pedido }}</dd></div>
      <div v-if="!cupom.diaTodo" class="flex justify-between gap-3"><dt class="text-tinta-fraca">Usos</dt>
        <dd class="text-right text-tinta-corpo">{{ cupom.usos.length }} de {{ cupom.usosMax }}</dd></div>
    </dl>

    <div class="grid gap-2 px-5 pb-5">
      <p v-if="erro" class="faixa-erro" role="alert" data-parte="erro-do-caixa">{{ erro }}</p>
      <button v-if="cupom.estado === 'valido' && !pedeDocumento" type="button" class="btn-primario w-full py-4 text-lg"
              :disabled="dando" data-parte="dar-baixa" @click="darBaixa(false)">
        {{ dando ? 'Dando baixa…' : `Dar baixa · ${cupom.consumacaoPct}% no bar` }}
      </button>
      <button v-if="cupom.estado === 'valido' && pedeDocumento" type="button" class="btn-primario w-full py-4 text-base"
              :disabled="dando" data-parte="liberar-com-documento" @click="darBaixa(true)">
        {{ dando ? 'Dando baixa…' : 'Conferi o documento com foto — liberar' }}
      </button>
    </div>
  </section>
</template>
