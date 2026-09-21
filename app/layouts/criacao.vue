<script setup lang="ts">
/**
 * Shell do módulo de criação de evento.
 *
 * É uma tela de tela cheia, sem o menu lateral do painel, porque criar evento
 * é uma tarefa com começo e fim — sair no meio tem que ser uma decisão, não um
 * clique de distração no menu.
 *
 * Medidas lidas do painel de origem em 20/09/2026 (getComputedStyle, não
 * estimativa): faixa do topo 49px de altura, fundo #1C70E9, Lato 15; trilha de
 * passos com 453px, cartão branco com raio 8 só em cima, cada passo com 74px
 * de altura e 16 de recheio; passo ativo com `border-left: 5px solid #2C7BE5`
 * e fundo #F9FBFD; barra de ação FIXA embaixo, 80px, mesmo azul, recheio
 * 20px/60px; botões #002D8C com raio 6 e borda branca de 2px.
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
  <div class="min-h-screen bg-fundo pb-24">
    <p class="flex items-center gap-2 bg-acao px-5 py-3 text-white">
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"
           class="shrink-0" aria-hidden="true">
        <circle cx="12" cy="12" r="9" /><path d="M12 8h.01M11 12h1v4h1" stroke-linecap="round" />
      </svg>
      <span>
        Você está no novo módulo de criação de evento. Para sair da criação e
        <button type="button" class="underline underline-offset-2" @click="emit('sair')">
          retornar ao seu painel, clique aqui.
        </button>
      </span>
    </p>

    <div class="mx-auto flex max-w-[1920px] gap-5 p-5">
      <!-- trilha -->
      <aside class="hidden w-[453px] shrink-0 self-start lg:block">
        <p class="titulo rounded-t-card border-b border-linha bg-white p-4 font-bold text-tinta-corpo">
          Passos para criação
        </p>
        <ol class="overflow-hidden rounded-b-card bg-white">
          <li v-for="(p, i) in passos" :key="p"
              class="flex items-center gap-4 border-b border-linha p-4 last:border-0"
              :class="i + 1 === passo
                ? 'border-l-[5px] border-l-acao-passo bg-fundo'
                : 'border-l-[5px] border-l-transparent'">
            <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-2 text-sm font-bold"
                  :class="i + 1 === passo
                    ? 'border-acao-passo text-acao-passo'
                    : i + 1 < passo
                      ? 'border-ok bg-ok text-white'
                      : 'border-tinta-passo text-tinta-passo'">
              <template v-if="i + 1 < passo">✓</template>
              <template v-else>{{ i + 1 }}</template>
            </span>
            <span class="text-base font-bold"
                  :class="i + 1 === passo ? 'text-acao-passo' : 'text-tinta-passo'">
              {{ p }}
            </span>
          </li>
        </ol>
        <p class="mt-4 text-sm text-tinta-suave">
          Precisa de ajuda?
          <NuxtLink to="/admin/suporte" class="text-acao-passo underline">
            Saiba como configurar o evento
          </NuxtLink>
        </p>
      </aside>

      <!-- conteúdo -->
      <div class="min-w-0 flex-1 space-y-5">
        <!-- trilha compacta, no lugar da lateral em tela estreita -->
        <ol class="flex gap-2 overflow-x-auto lg:hidden">
          <li v-for="(p, i) in passos" :key="p"
              class="flex shrink-0 items-center gap-2 rounded-card border px-3 py-2 text-sm font-bold"
              :class="i + 1 === passo
                ? 'border-acao-passo bg-white text-acao-passo'
                : 'border-linha bg-white text-tinta-passo'">
            <span>{{ i + 1 }}</span><span>{{ p }}</span>
          </li>
        </ol>
        <slot />
      </div>
    </div>

    <!-- barra de ação: fixa, é o único jeito de avançar -->
    <div class="fixed inset-x-0 bottom-0 z-20 flex items-center justify-between gap-4 bg-acao px-5 py-5 lg:px-[60px]">
      <button type="button" class="btn-criacao" @click="props.podeVoltar ? emit('voltar') : emit('sair')">
        {{ props.podeVoltar ? 'Voltar' : 'Sair' }}
      </button>
      <button type="button" class="btn-criacao font-bold" :disabled="props.salvando"
              @click="emit('avancar')">
        {{ props.salvando ? 'Salvando…' : (props.rotuloAvancar ?? 'Prosseguir') }}
      </button>
    </div>
  </div>
</template>

<style scoped>
/* Botão da barra: fundo #002D8C, raio 6, borda branca de 2px — medidos.
   Largura grande e fixa é escolha do original; aqui ele cresce até 441px
   (a medida lida) e encolhe em tela estreita em vez de estourar. */
.btn-criacao {
  width: min(441px, 45%);
  height: 40px;
  border-radius: 6px;
  border: 2px solid #fff;
  background: theme('colors.menu.DEFAULT');
  color: #fff;
  font-family: theme('fontFamily.titulo');
  font-size: 16px;
  padding: 6px 12px;
}
.btn-criacao:disabled { opacity: .6; cursor: not-allowed; }
.btn-criacao:hover:not(:disabled) { background: theme('colors.menu.hover'); }
</style>
