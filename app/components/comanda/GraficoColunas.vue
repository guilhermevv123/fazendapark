<script setup lang="ts">
/**
 * Gráfico de colunas das comandas (055) — SVG próprio, sem biblioteca (o projeto não instala
 * pacote). Grade com 3 valores, rótulo embaixo, valor exato ao passar o mouse ou tocar.
 * A coluna "destacada" (a hora de agora, por exemplo) sai na cor forte.
 */
import { reais } from '~/composables/formato'

const props = withDefaults(defineProps<{
  pontos: { rotulo: string; valor: number; extra?: string }[]
  destaque?: number
  altura?: number
  formatar?: (v: number) => string
}>(), { destaque: -1, altura: 180, formatar: reais })

const maior = computed(() => Math.max(1, ...props.pontos.map((p) => p.valor)))
/** topo arredondado pra grade ficar redonda (R$ 100, R$ 250, R$ 1.000…) */
const topo = computed(() => {
  const m = maior.value
  const ordem = 10 ** Math.floor(Math.log10(m))
  return [1, 2, 2.5, 5, 10].map((k) => k * ordem).find((v) => v >= m) ?? m
})
const grade = computed(() => [topo.value, topo.value / 2, 0])
const sobre = ref(-1)
const compacto = (v: number) => v >= 100_000 ? `R$ ${Math.round(v / 100_000)} mil` : `R$ ${Math.round(v / 100)}`
</script>

<template>
  <div class="relative select-none">
    <div class="flex">
      <!-- eixo -->
      <div class="flex w-14 shrink-0 flex-col justify-between pr-2 text-right text-[11px] text-ink-500" :style="{ height: `${altura}px` }">
        <span v-for="g in grade" :key="g">{{ compacto(g) }}</span>
      </div>
      <div class="relative flex-1">
        <!-- grade -->
        <div class="pointer-events-none absolute inset-x-0 top-0 flex flex-col justify-between" :style="{ height: `${altura}px` }">
          <div v-for="g in grade" :key="g" class="border-t border-dashed border-ink-200" />
        </div>
        <!-- colunas -->
        <div class="relative flex items-end gap-[3px]" :style="{ height: `${altura}px` }">
          <div v-for="(p, i) in pontos" :key="i" class="group relative flex h-full flex-1 cursor-default items-end"
               @mouseenter="sobre = i" @mouseleave="sobre = -1" @touchstart.passive="sobre = i">
            <div class="w-full rounded-t-[3px] transition-colors"
                 :class="i === destaque ? 'bg-acao-escuro' : sobre === i ? 'bg-acao-forte' : 'bg-acao/80'"
                 :style="{ height: p.valor ? `${Math.max(2, (p.valor / topo) * altura)}px` : '0px' }" />
            <div v-if="sobre === i" class="absolute bottom-full left-1/2 z-10 mb-1 -translate-x-1/2 whitespace-nowrap rounded-card bg-ink-900 px-2.5 py-1.5 text-xs text-white shadow-lg"
                 :style="{ bottom: `${Math.max(2, (p.valor / topo) * altura) + 4}px` }">
              <b>{{ p.rotulo }}</b> · {{ formatar(p.valor) }}<span v-if="p.extra" class="text-ink-300"> · {{ p.extra }}</span>
            </div>
          </div>
        </div>
        <!-- rótulos -->
        <div class="mt-1.5 flex gap-[3px] text-center text-[11px] text-ink-500">
          <span v-for="(p, i) in pontos" :key="i" class="flex-1 truncate" :class="pontos.length > 14 && i % 2 ? 'invisible' : ''">{{ p.rotulo }}</span>
        </div>
      </div>
    </div>
  </div>
</template>
