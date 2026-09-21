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
              <span class="grid size-8 shrink-0 place-items-center rounded-full text-sm font-semibold ring-1 ring-inset"
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
        <!-- trilha compacta, no lugar da lateral em tela estreita -->
        <ol class="flex gap-2 overflow-x-auto lg:hidden">
          <li v-for="(p, i) in passos" :key="p"
              class="flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold ring-1 ring-inset"
              :class="i + 1 === passo
                ? 'bg-pool-50 text-pool-800 ring-pool-200'
                : 'bg-white text-ink-500 ring-ink-200'"
              :aria-current="i + 1 === passo ? 'step' : undefined">
            <span>{{ i + 1 }}</span><span>{{ p }}</span>
          </li>
        </ol>
        <slot />
      </div>
    </div>

    <!-- barra de ação: fixa, é o único jeito de avançar -->
    <div class="fixed inset-x-0 bottom-0 z-20 border-t border-ink-200/70 bg-white/95 backdrop-blur">
      <div class="mx-auto flex max-w-[1440px] items-center justify-between gap-4 px-4 py-4 sm:px-6">
        <button type="button" class="btn-secundario min-w-[120px] sm:min-w-[160px]"
                @click="props.podeVoltar ? emit('voltar') : emit('sair')">
          {{ props.podeVoltar ? 'Voltar' : 'Sair' }}
        </button>
        <button type="button" class="btn-primario min-w-[140px] px-6 sm:min-w-[200px]"
                :disabled="props.salvando" @click="emit('avancar')">
          {{ props.salvando ? 'Salvando…' : (props.rotuloAvancar ?? 'Prosseguir') }}
        </button>
      </div>
    </div>
  </div>
</template>
