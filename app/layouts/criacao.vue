<script setup lang="ts">
/**
 * Shell do módulo de criação de evento.
 *
 * É uma tela de tela cheia, sem o menu lateral do painel, porque criar evento
 * é uma tarefa com começo e fim — sair no meio tem que ser uma decisão, não um
 * clique de distração no menu. Por isso a logo do alto NÃO é link: o único
 * jeito de sair é o botão "Sair da criação", que avisa a tela (`sair`) e deixa
 * ela decidir o que fazer com o rascunho.
 *
 * O desenho é o do sistema do parque: faixa branca fosca no alto, trilha de
 * passos num cartão à esquerda (o passo ativo em azul-piscina com a barra de
 * 3px, os concluídos com o visto verde), barra de ação branca colada embaixo.
 */
const props = defineProps<{
  passos: string[]
  passo: number
  podeVoltar?: boolean
  rotuloAvancar?: string
  salvando?: boolean
}>()
const emit = defineEmits<{ voltar: []; avancar: []; sair: [] }>()
</script>

<template>
  <div class="min-h-dvh bg-canvas pb-24">
    <header class="sticky top-0 z-30 border-b border-ink-200/60 bg-white/90 backdrop-blur">
      <div class="mx-auto flex h-16 max-w-[1440px] items-center gap-4 px-4 sm:px-6">
        <LogoMarca class="h-9" />
        <span class="hidden text-sm font-semibold text-ink-500 sm:inline">Criação de evento</span>
        <button type="button" class="btn-secundario ml-auto" @click="emit('sair')">
          Sair da criação
        </button>
      </div>
    </header>

    <div class="mx-auto flex max-w-[1440px] gap-6 px-4 py-6 sm:px-6">
      <!-- trilha -->
      <aside class="hidden w-[340px] shrink-0 self-start lg:block">
        <div class="card overflow-hidden p-0">
          <p class="titulo border-b border-ink-100 px-5 py-4 text-[15px] font-semibold text-ink-900">
            Passos para criação
          </p>
          <ol class="grid gap-0.5 p-2">
            <li v-for="(p, i) in passos" :key="p"
                class="relative flex items-center gap-3 rounded-lg px-3 py-3"
                :class="i + 1 === passo ? 'bg-pool-50' : ''"
                :aria-current="i + 1 === passo ? 'step' : undefined">
              <span v-if="i + 1 === passo" aria-hidden="true"
                    class="absolute inset-y-2 left-0 w-[3px] rounded-r-full bg-pool-600" />
              <span :key="`${p}-${i + 1 < passo}-${i + 1 === passo}`"
                    class="grid size-8 shrink-0 animate-pop place-items-center rounded-full text-sm font-semibold ring-1 ring-inset"
                    :class="i + 1 === passo
                      ? 'bg-pool-700 text-white ring-pool-700'
                      : i + 1 < passo
                        ? 'bg-success-600 text-white ring-success-600'
                        : 'bg-white text-ink-400 ring-ink-300'">
                <template v-if="i + 1 < passo">✓</template>
                <template v-else>{{ i + 1 }}</template>
              </span>
              <span class="text-[15px]"
                    :class="i + 1 === passo
                      ? 'font-semibold text-pool-800'
                      : i + 1 < passo ? 'font-medium text-ink-700' : 'font-medium text-ink-400'">
                {{ p }}
              </span>
            </li>
          </ol>
        </div>
        <p class="mt-4 px-1 text-sm text-ink-500">
          Precisa de ajuda?
          <NuxtLink to="/admin/suporte" class="font-semibold text-pool-700 hover:text-pool-800">
            Saiba como configurar o evento
          </NuxtLink>
        </p>
      </aside>

      <!-- conteúdo -->
      <div class="min-w-0 flex-1 space-y-5">
        <!-- trilha compacta, no lugar da lateral em tela estreita: "Passo 2 de 5"
             + o nome + uma régua de cinco segmentos. A fila de pílulas que rolava
             de lado escondia justamente o passo seguinte. -->
        <div class="card lg:hidden">
          <div class="flex items-baseline justify-between gap-3">
            <p :key="passo" class="titulo animate-rise-in text-[17px] font-semibold text-pool-800">{{ passos[passo - 1] }}</p>
            <p class="shrink-0 text-[13px] font-semibold tabular-nums text-tinta-suave">Passo {{ passo }} de {{ passos.length }}</p>
          </div>
          <ol class="mt-3 flex gap-1.5" aria-label="Passos para criação">
            <!-- o segmento do passo atual ENCHE da esquerda ao chegar (`key` com o
                 passo recria a peça, e a animação roda de novo a cada troca) -->
            <li v-for="(p, i) in passos" :key="p" class="relative h-2 flex-1 overflow-hidden rounded-full bg-ink-200"
                :aria-current="i + 1 === passo ? 'step' : undefined">
              <span v-if="i + 1 < passo" class="absolute inset-0 rounded-full bg-success-600" aria-hidden="true" />
              <span v-else-if="i + 1 === passo" :key="passo" aria-hidden="true"
                    class="absolute inset-0 origin-left animate-enche rounded-full bg-gradient-to-r from-pool-600 to-grape-600" />
              <span class="sr-only">{{ i + 1 }}. {{ p }}</span>
            </li>
          </ol>
          <p v-if="passo < passos.length" class="mt-2.5 text-[13px] text-tinta-suave">
            Depois: <span class="font-semibold text-tinta">{{ passos[passo] }}</span>
          </p>
        </div>
        <slot />
      </div>
    </div>

    <!-- barra de ação: fixa, é o único jeito de avançar. Na cor da marca (era
         branca sobre fundo branco — no telefone não se via onde terminava a
         página e começava o botão); `safe-area` pra não ficar sob a barra do
         iPhone. -->
    <div class="fixed inset-x-0 bottom-0 z-20 bg-gradient-to-r from-pool-700 to-grape-700 pb-[env(safe-area-inset-bottom)] shadow-[0_-8px_24px_-12px_rgb(18_15_29/0.35)]">
      <div class="mx-auto flex max-w-[1440px] items-center justify-between gap-3 px-4 py-3.5 sm:gap-4 sm:px-6 sm:py-4">
        <button type="button" class="btn flex-1 bg-white/10 text-white ring-1 ring-inset ring-white/60 hover:bg-white/20 sm:max-w-[200px]"
                @click="props.podeVoltar ? emit('voltar') : emit('sair')">
          {{ props.podeVoltar ? 'Voltar' : 'Sair' }}
        </button>
        <button type="button" class="btn flex-[1.4] bg-white px-6 text-pool-800 shadow-md hover:bg-pool-50 sm:max-w-[260px] sm:flex-none"
                :disabled="props.salvando" @click="emit('avancar')">
          {{ props.salvando ? 'Salvando…' : (props.rotuloAvancar ?? 'Prosseguir') }}
        </button>
      </div>
    </div>
  </div>
</template>
