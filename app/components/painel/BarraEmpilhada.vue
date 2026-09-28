<script setup lang="ts">
/**
 * `<PainelBarraEmpilhada>` — uma barra dividida em partes que SOMAM o todo, com a legenda embaixo.
 *
 * Serve pra "para onde foi o líquido" (Financeiro) e "Site × Bilheteria" (Visão geral). As partes
 * vêm prontas de quem chama, com a mesma conta da tela ao lado: este componente não calcula
 * dinheiro, só desenha a proporção. Parte negativa (saldo devedor) não cabe numa barra de
 * proporção — quem chama mostra à parte, em vermelho.
 *
 * Cor em hex porque a largura é dinâmica (estilo inline): cada tela diz de qual tom da marca é.
 */
const props = defineProps<{
  partes: { rotulo: string; valor: number; cor: string; texto: string; dica?: string }[]
  rotuloAcessivel: string
}>()
const soma = computed(() => props.partes.reduce((s, p) => s + Math.max(0, p.valor), 0))
const pct = (v: number) => (soma.value > 0 ? (Math.max(0, v) / soma.value) * 100 : 0)
</script>

<template>
  <div>
    <div class="flex h-4 w-full overflow-hidden rounded-full bg-ink-100" role="img" :aria-label="rotuloAcessivel">
      <div v-for="p in partes" v-show="p.valor > 0" :key="p.rotulo" class="h-full first:rounded-l-full last:rounded-r-full"
           :style="{ width: `${pct(p.valor)}%`, backgroundColor: p.cor }" />
    </div>
    <ul class="mt-3 grid gap-x-6 gap-y-2 sm:grid-cols-2">
      <li v-for="p in partes" :key="p.rotulo" class="flex items-start justify-between gap-3 text-sm" data-parte="parte">
        <span class="flex min-w-0 items-start gap-2">
          <span class="mt-1.5 size-2.5 shrink-0 rounded-full" :style="{ backgroundColor: p.cor }" />
          <span class="min-w-0">
            <span class="font-semibold text-ink-900">{{ p.rotulo }}</span>
            <span v-if="p.dica" class="block text-xs text-ink-700">{{ p.dica }}</span>
          </span>
        </span>
        <span class="shrink-0 text-right font-semibold tabular-nums text-ink-900">
          {{ p.texto }}
          <span class="block text-xs font-medium text-ink-600">{{ Math.round(pct(p.valor)) }}%</span>
        </span>
      </li>
    </ul>
  </div>
</template>
