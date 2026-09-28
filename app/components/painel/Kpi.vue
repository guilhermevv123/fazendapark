<script setup lang="ts">
/**
 * `<PainelKpi>` — um indicador do painel: rótulo, número GRANDE, um tom só, e o que ele significa.
 *
 * Pedido do dono olhando no celular (22/09): "muito vazio, pouca cor, coisas muito pequenas". Cada
 * indicador tem UM tom da marca (a cor diz o que o número é — pool é o dinheiro que entrou, grape o
 * que é do produtor, sun a quantidade, citrus o público), número em 30–34 px com `tabular-nums`, e
 * o `destaque` pinta o cartão inteiro de cor sólida (o "hero" de cada tela).
 *
 * A variação contra o período anterior é um selo (`selo-ok` sobe, `selo-erro` desce,
 * `selo-neutro` igual); `inverter` troca o sentido pra quem é melhor quando cai (devolução).
 * Sem base de comparação (`null`), o selo não aparece — nunca uma porcentagem inventada.
 */
type Tom = 'pool' | 'grape' | 'sun' | 'citrus' | 'ok' | 'erro' | 'neutro'

const props = withDefaults(defineProps<{
  rotulo: string
  valor: string
  tom?: Tom
  icone?: string
  destaque?: boolean
  variacao?: number | null
  inverter?: boolean
  contra?: string
}>(), { tom: 'pool', icone: undefined, destaque: false, variacao: null, inverter: false, contra: 'o período anterior' })

// Literais inteiros, nunca montados por concatenação: o Tailwind só gera a classe que aparece
// escrita no fonte. Os tons são das escalas da marca (tailwind.config.js).
const ICONE: Record<Tom, string> = {
  pool: 'bg-pool-100 text-pool-700',
  grape: 'bg-grape-100 text-grape-700',
  sun: 'bg-sun-100 text-sun-700',
  citrus: 'bg-citrus-100 text-citrus-700',
  ok: 'bg-success-100 text-success-700',
  erro: 'bg-danger-100 text-danger-700',
  neutro: 'bg-ink-100 text-ink-700',
}
const HERO: Record<Tom, string> = {
  pool: 'bg-gradient-to-br from-pool-700 to-pool-900',
  grape: 'bg-gradient-to-br from-grape-600 to-grape-800',
  sun: 'bg-gradient-to-br from-sun-500 to-sun-700',
  citrus: 'bg-gradient-to-br from-citrus-600 to-citrus-800',
  ok: 'bg-gradient-to-br from-success-600 to-success-800',
  erro: 'bg-gradient-to-br from-danger-600 to-danger-800',
  neutro: 'bg-gradient-to-br from-ink-700 to-ink-900',
}
const NUMERO: Record<Tom, string> = {
  pool: 'text-pool-800', grape: 'text-grape-800', sun: 'text-ink-900', citrus: 'text-ink-900',
  ok: 'text-success-800', erro: 'text-danger-700', neutro: 'text-ink-900',
}

const selo = computed(() => {
  const v = props.variacao
  if (v === null || v === undefined) return null
  const bom = props.inverter ? v < 0 : v > 0
  const ruim = props.inverter ? v > 0 : v < 0
  return {
    classe: bom ? 'selo-ok' : ruim ? 'selo-erro' : 'selo-neutro',
    texto: `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toLocaleString('pt-BR')}%`,
  }
})
</script>

<template>
  <div class="relative flex min-w-0 flex-col overflow-hidden rounded-2xl p-5 shadow-card"
       :class="destaque ? [HERO[tom], 'text-white'] : 'bg-white ring-1 ring-ink-200/70'">
    <div class="flex items-start justify-between gap-3">
      <p class="titulo text-[13.5px] font-semibold leading-snug"
         :class="destaque ? 'text-white/85' : 'text-ink-700'">{{ rotulo }}</p>
      <span v-if="icone" class="grid size-10 shrink-0 place-items-center rounded-xl"
            :class="destaque ? 'bg-white/15 text-white' : ICONE[tom]">
        <IconeMenu :nome="icone" :tamanho="20" />
      </span>
    </div>
    <p class="titulo mt-2 break-words text-[30px] font-semibold leading-none tabular-nums sm:text-[32px]"
       :class="destaque ? 'text-white' : NUMERO[tom]" data-parte="kpi-valor">
      {{ valor }}
    </p>
    <div v-if="selo" class="mt-2.5 flex flex-wrap items-center gap-1.5 text-xs"
         :class="destaque ? 'text-white/80' : 'text-ink-600'">
      <span :class="selo.classe" data-parte="kpi-variacao">{{ selo.texto }}</span>
      <span>contra {{ contra }}</span>
    </div>
    <div class="mt-2 text-[13px] leading-snug" :class="destaque ? 'text-white/85' : 'text-ink-700'">
      <slot />
    </div>
  </div>
</template>
