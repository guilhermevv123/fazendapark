<script setup lang="ts">
/**
 * Dias de uso do tipo de ingresso (047) — em que dia do evento este tipo passa na catraca.
 *
 * Dono, 07/10: "o ingresso que o cara tem de sexta, ele tenta passar domingo"; "isso já vai ser
 * previamente ativado, eu só vou colocar os dias". Por isso a chave nasce LIGADA e a tela só pede
 * os dias. Nenhum dia marcado = passa em qualquer dia do evento (o mesmo que desligado) — a frase
 * de baixo diz isso com todas as letras, pra ninguém achar que "ligado sem dia" barra todo mundo.
 *
 * `autoPeloNome`: no tipo NOVO, o dia que o nome cita ("ENTRADA INDIVIDUAL SEXTA") já vem marcado
 * enquanto a pessoa não mexer nos dias. No tipo que já existe nada é marcado sozinho — aparece o
 * botão da sugestão, e só vale depois do Salvar (o que a tela mostra é o que está gravado).
 */
import { computed, ref, watch } from 'vue'
import { fraseDosDiasDeUso, sugerirDiasDeUsoPeloNome, type DiaDoEvento } from '~~/server/utils/dias-de-uso'

const props = defineProps<{
  /**
   * `undefined` = nunca mexido (o nome ainda pode sugerir) · `null` = chave desligada ·
   * `[]` = ligada sem dia marcado · lista = os dias. Pro servidor, `null` e `[]` são iguais:
   * qualquer dia do evento.
   */
  modelValue: string[] | null | undefined
  /** os dias do evento (`diasDoEvento`) */
  dias: DiaDoEvento[]
  /** o nome do tipo — de onde sai a sugestão */
  nome?: string
  autoPeloNome?: boolean
}>()
const emit = defineEmits<{ 'update:modelValue': [string[] | null] }>()

const marcados = computed(() => props.modelValue ?? [])
/**
 * A chave: nasce LIGADA (ordem do dono). Só nasce desligada quando a pessoa desligou neste
 * assistente (`null` com `autoPeloNome`); no tipo já gravado, `null` é "nunca marcou" e mostra ligada.
 */
const ligado = ref(!(props.autoPeloNome && props.modelValue === null))
/** a sugestão que ESTE bloco pôs — enquanto o valor for ela, trocar o nome troca a sugestão */
let ultimaSugestao: string | null = null

const sugestao = computed(() => sugerirDiasDeUsoPeloNome(props.nome, props.dias))
const sugestaoDiferente = computed(() =>
  sugestao.value.length > 0 && sugestao.value.join() !== [...marcados.value].sort().join())

watch([() => props.nome, () => props.dias.map((d) => d.dia).join()], () => {
  if (!props.autoPeloNome || !ligado.value) return
  const atual = props.modelValue
  // só o tipo nunca mexido, ou o que ainda está com a sugestão que este bloco pôs
  if (atual !== undefined && (ultimaSugestao === null || (atual ?? []).join() !== ultimaSugestao)) return
  ultimaSugestao = sugestao.value.join()
  emit('update:modelValue', [...sugestao.value])
}, { immediate: true })

function alternarDia(dia: string) {
  ultimaSugestao = null
  const s = new Set(marcados.value)
  if (s.has(dia)) s.delete(dia)
  else s.add(dia)
  emit('update:modelValue', [...s].sort())
}
function alternarChave() {
  ultimaSugestao = null
  ligado.value = !ligado.value
  emit('update:modelValue', ligado.value ? [] : null)
}
function usarSugestao() {
  ultimaSugestao = null
  emit('update:modelValue', [...sugestao.value])
}
</script>

<template>
  <div class="rounded-card border border-linha bg-fundo-card px-4 py-3" data-parte="dias-de-uso">
    <div class="flex items-start gap-3">
      <button type="button" role="switch" :aria-checked="ligado" aria-label="Só passa nos dias marcados"
              class="relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors"
              :class="ligado ? 'bg-acao' : 'bg-linha-forte'" data-parte="chave-dias-de-uso"
              @click="alternarChave">
        <span class="absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all"
              :class="ligado ? 'left-[22px]' : 'left-0.5'" />
      </button>
      <div class="min-w-0">
        <p class="text-[15px] font-medium text-tinta">Dias de uso na catraca</p>
        <p class="text-sm text-tinta-suave">
          O ingresso deste tipo só passa nos dias marcados. Vale pro tipo com o mesmo nome em todos os lotes.
        </p>
      </div>
    </div>

    <template v-if="ligado">
      <p v-if="!dias.length" class="mt-3 text-sm text-alerta">
        O evento ainda não tem data de início e fim — preencha nas configurações para marcar os dias.
      </p>
      <div v-else class="mt-3 flex flex-wrap gap-2">
        <button v-for="d in dias" :key="d.dia" type="button"
                class="min-h-10 rounded-[6px] border px-3 text-sm font-medium capitalize transition-colors"
                :class="marcados.includes(d.dia)
                  ? 'border-acao bg-acao text-white'
                  : 'border-linha bg-white text-tinta hover:border-acao'"
                :aria-pressed="marcados.includes(d.dia)" :data-dia="d.dia"
                @click="alternarDia(d.dia)">
          {{ d.rotulo }}
        </button>
      </div>
      <p class="mt-2 text-sm" :class="marcados.length ? 'text-tinta' : 'text-tinta-suave'" data-parte="frase-dias-de-uso">
        <template v-if="marcados.length">Passa só: <strong>{{ fraseDosDiasDeUso(marcados) }}</strong>.</template>
        <template v-else>Nenhum dia marcado: passa em qualquer dia do evento.</template>
      </p>
      <button v-if="sugestaoDiferente" type="button" class="mt-2 text-sm font-medium text-acao hover:underline"
              data-parte="sugestao-dias-de-uso" @click="usarSugestao">
        Marcar pelo nome do tipo: {{ fraseDosDiasDeUso(sugestao) }}
      </button>
    </template>
    <p v-else class="mt-2 text-sm text-tinta-suave">Desligado: passa em qualquer dia do evento.</p>
  </div>
</template>
