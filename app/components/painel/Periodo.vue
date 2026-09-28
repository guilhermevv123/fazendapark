<script setup lang="ts">
/**
 * `<PainelPeriodo>` — os atalhos de período e as datas à mão, no MESMO vocabulário em toda tela de
 * dinheiro (proposta 10 da auditoria): Hoje, 7 dias, 30 dias, Este mês, Mês passado, Este ano, Tudo.
 *
 * A tela dona guarda o período na URL (`?periodo=30d` ou `?de=&ate=`) e passa pra cá; este
 * componente só pede a troca (`escolher` / `datas`). Data errada (De depois de Até, 31/02) NÃO sai
 * daqui: o aviso aparece dentro do próprio cartão de filtro e o resto da tela continua com o último
 * recorte válido — antes, o 400 da rota derrubava a tela inteira num cartão de erro com um "Tentar
 * de novo" que repetia o mesmo erro (auditoria REL-10).
 */
import { PERIODOS, problemaNoPeriodo, rotuloDoPeriodo } from '~/composables/painelPeriodo'

const props = defineProps<{
  /** a chave ativa (`30d`…), ou `null` quando as datas foram digitadas à mão */
  periodo: string | null
  /** as datas que o servidor resolveu pro recorte atual (pra dizer "01/09 a 27/09") */
  de: string | null
  ate: string | null
  carregando?: boolean
}>()
const emit = defineEmits<{ escolher: [chave: string]; datas: [p: { de: string | null; ate: string | null }] }>()

const abertoAMao = ref(props.periodo === null)
const deAMao = ref(props.periodo === null ? (props.de ?? '') : '')
const ateAMao = ref(props.periodo === null ? (props.ate ?? '') : '')
watch(() => [props.periodo, props.de, props.ate], () => {
  if (props.periodo === null) { deAMao.value = props.de ?? ''; ateAMao.value = props.ate ?? '' }
})

const erro = computed(() => problemaNoPeriodo(deAMao.value || null, ateAMao.value || null))

function aplicar() {
  if (erro.value || (!deAMao.value && !ateAMao.value)) return
  emit('datas', { de: deAMao.value || null, ate: ateAMao.value || null })
}
</script>

<template>
  <div class="grid gap-3">
    <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
      <div class="-mx-1 flex min-w-0 max-w-full gap-2 overflow-x-auto px-1 pb-0.5 sem-barra" role="group" aria-label="Período">
        <button v-for="p in PERIODOS" :key="p.chave" type="button"
                class="shrink-0 min-h-[40px] sm:min-h-0"
                :class="periodo === p.chave ? 'chip-ativo' : 'chip'"
                :aria-pressed="periodo === p.chave"
                @click="abertoAMao = false; emit('escolher', p.chave)">
          {{ p.rotulo }}
        </button>
        <button type="button" class="shrink-0 min-h-[40px] sm:min-h-0"
                :class="periodo === null ? 'chip-ativo' : 'chip'" :aria-expanded="abertoAMao"
                @click="abertoAMao = !abertoAMao">
          <IconeMenu nome="calendario" :tamanho="14" /> Datas
        </button>
      </div>
      <p class="text-[13px] font-medium text-ink-700" data-parte="periodo-resolvido">
        <span v-if="carregando" class="inline-flex items-center gap-1.5 text-pool-700">
          <span class="size-2 animate-pulse rounded-full bg-pool-600" /> atualizando…
        </span>
        <template v-else>{{ rotuloDoPeriodo(de, ate) }}</template>
      </p>
    </div>

    <form v-if="abertoAMao" class="flex flex-wrap items-end gap-3" @submit.prevent="aplicar">
      <label class="block">
        <span class="rotulo">De</span>
        <input v-model="deAMao" type="date" class="campo w-44" :aria-invalid="!!erro">
      </label>
      <label class="block">
        <span class="rotulo">Até</span>
        <input v-model="ateAMao" type="date" class="campo w-44" :aria-invalid="!!erro">
      </label>
      <button type="submit" class="btn-primario" :disabled="!!erro || (!deAMao && !ateAMao)">Aplicar</button>
      <p v-if="erro" class="faixa-erro basis-full" role="alert" data-parte="erro-periodo">{{ erro }}</p>
    </form>
  </div>
</template>
