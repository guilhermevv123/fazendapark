<script setup lang="ts">
/**
 * `<PainelGraficoBarras>` — barras em SVG próprio (sem biblioteca: não dá pra instalar pacote).
 *
 * O que ele resolve (auditoria REL-03/FIN-08 e propostas 4 e 11):
 *   · série CONTÍNUA (quem monta é `serieContinua`, em `painelGrafico.ts`): dia sem venda é barra
 *     zero no lugar certo, não some do eixo;
 *   · nunca vaza do cartão: `viewBox` fixo com `preserveAspectRatio="none"` estica as barras na
 *     largura que houver; o texto (eixo, rótulos, balão) é HTML por cima, pra não esticar junto;
 *   · três linhas de grade com o valor compacto, rótulo do eixo espaçado (menos no celular);
 *   · o valor aparece no TOQUE e no hover (o `title` de antes não existe no celular);
 *   · linha tracejada opcional com o período anterior, pra comparar sem ler número.
 *
 * Cores das barras vêm em hex (SVG não gera classe): `pool-600` #1789a1 é a barra, `grape-400`
 * #9877c5 a linha do período anterior, `ink-200` #e2e0ea a grade.
 */
import { escalaDoEixo, indicesComRotulo, reaisCompacto, rotuloDoPonto, detalheDoPonto, type Passo } from '~/composables/painelGrafico'

const props = withDefaults(defineProps<{
  pontos: { chave: string; valor: number; anterior?: number | null; extra?: string }[]
  passo: Passo
  formatar: (v: number) => string
  formatarEixo?: (v: number) => string
  rotuloAcessivel: string
  cor?: string
  corAnterior?: string
  altura?: number
  nomeAnterior?: string
}>(), {
  formatarEixo: undefined,
  cor: '#1789a1', // pool-600
  corAnterior: '#9877c5', // grape-400
  altura: 200,
  nomeAnterior: 'período anterior',
})

const LARGURA = 1000
const eixo = computed(() => props.formatarEixo ?? reaisCompacto)

const maior = computed(() => Math.max(0, ...props.pontos.map((p) => Math.max(p.valor, p.anterior ?? 0))))
const escala = computed(() => escalaDoEixo(maior.value))
const n = computed(() => props.pontos.length)
const fatia = computed(() => (n.value ? LARGURA / n.value : LARGURA))
/**
 * Barra ocupa 72% da fatia (o resto é o respiro entre elas), nunca menos de 1 unidade e nunca mais
 * de 9% da largura: com UM dia no período ("Hoje") a barra única ocupava o cartão inteiro e virava
 * um bloco sem forma de barra (matriz da auditoria, "Vendas por dia — um dia só").
 */
const larguraBarra = computed(() => Math.min(90, Math.max(1, fatia.value * (n.value > 60 ? 0.86 : 0.72))))
const alturaDe = (v: number) => (escala.value.topo ? (Math.max(0, v) / escala.value.topo) * props.altura : 0)

const temAnterior = computed(() => props.pontos.some((p) => p.anterior !== undefined && p.anterior !== null))
const linhaAnterior = computed(() => props.pontos
  .map((p, i) => `${(i + 0.5) * fatia.value},${props.altura - alturaDe(p.anterior ?? 0)}`)
  .join(' '))

const noCelular = computed(() => indicesComRotulo(n.value, 5))
const noComputador = computed(() => indicesComRotulo(n.value, 10))

/** o ponto sob o dedo/mouse — o balão mostra o valor exato */
const ativo = ref<number | null>(null)
const balao = computed(() => {
  if (ativo.value === null) return null
  const p = props.pontos[ativo.value]
  if (!p) return null
  const x = ((ativo.value + 0.5) / n.value) * 100
  return {
    x: Math.min(Math.max(x, 12), 88),
    titulo: detalheDoPonto(p.chave, props.passo),
    valor: props.formatar(p.valor),
    anterior: p.anterior !== undefined && p.anterior !== null ? props.formatar(p.anterior) : null,
    extra: p.extra ?? null,
  }
})
</script>

<template>
  <div class="relative select-none" @pointerleave="ativo = null">
    <div class="flex gap-2">
      <!-- eixo Y: os valores das três linhas de grade, em texto de verdade (não esticado) -->
      <div class="relative w-14 shrink-0 text-right text-[11px] font-medium tabular-nums text-ink-600"
           :style="{ height: `${altura}px` }" aria-hidden="true">
        <span v-for="l in escala.linhas" :key="l" class="absolute right-0 -translate-y-1/2 whitespace-nowrap"
              :style="{ top: `${100 - (l / escala.topo) * 100}%` }">{{ eixo(l) }}</span>
        <span class="absolute bottom-0 right-0 translate-y-1/2">0</span>
      </div>

      <div class="relative min-w-0 flex-1">
        <svg :viewBox="`0 0 ${LARGURA} ${altura}`" preserveAspectRatio="none" class="block w-full overflow-visible"
             :style="{ height: `${altura}px` }" role="img" :aria-label="rotuloAcessivel">
          <!-- grade -->
          <line v-for="l in escala.linhas" :key="l" x1="0" :x2="LARGURA"
                :y1="altura - (l / escala.topo) * altura"
                :y2="altura - (l / escala.topo) * altura"
                stroke="#e2e0ea" stroke-width="1" vector-effect="non-scaling-stroke" />
          <line x1="0" :x2="LARGURA" :y1="altura" :y2="altura" stroke="#c8c5d5" stroke-width="1"
                vector-effect="non-scaling-stroke" />
          <!-- barras -->
          <rect v-for="(p, i) in pontos" :key="p.chave"
                :x="i * fatia + (fatia - larguraBarra) / 2" :width="larguraBarra"
                :y="altura - Math.max(alturaDe(p.valor), p.valor > 0 ? 2 : 0)"
                :height="Math.max(alturaDe(p.valor), p.valor > 0 ? 2 : 0)"
                :fill="cor" :opacity="ativo === null || ativo === i ? 1 : 0.45" data-parte="barra" />
          <!-- período anterior, tracejado -->
          <polyline v-if="temAnterior" :points="linhaAnterior" fill="none" :stroke="corAnterior" stroke-width="2"
                    stroke-dasharray="6 5" vector-effect="non-scaling-stroke" stroke-linejoin="round" />
          <!-- alvos de toque: a fatia inteira, não só a barra (barra zero também tem valor) -->
          <rect v-for="(p, i) in pontos" :key="`alvo-${p.chave}`" :x="i * fatia" :width="fatia" y="0" :height="altura"
                fill="transparent" class="cursor-pointer" @pointerenter="ativo = i" @click="ativo = i" />
        </svg>

        <!-- o balão do valor, em HTML por cima do SVG -->
        <div v-if="balao" role="status" data-parte="balao"
             class="pointer-events-none absolute -top-2 z-10 w-max max-w-[16rem] -translate-x-1/2 -translate-y-full rounded-xl bg-ink-900 px-3 py-2 text-xs text-white shadow-pop"
             :style="{ left: `${balao.x}%` }">
          <p class="font-semibold capitalize">{{ balao.titulo }}</p>
          <p class="mt-0.5 text-sm font-semibold tabular-nums">{{ balao.valor }}</p>
          <p v-if="balao.extra" class="text-white/80">{{ balao.extra }}</p>
          <p v-if="balao.anterior" class="text-white/80">{{ nomeAnterior }}: {{ balao.anterior }}</p>
        </div>

        <!-- eixo X -->
        <div class="relative mt-1.5 h-5 text-[11px] font-medium tabular-nums text-ink-600" aria-hidden="true">
          <template v-for="(p, i) in pontos" :key="`r-${p.chave}`">
            <span v-if="noComputador.has(i)" data-parte="rotulo-eixo"
                  class="absolute -translate-x-1/2 whitespace-nowrap"
                  :class="noCelular.has(i) ? '' : 'hidden sm:inline'"
                  :style="{ left: `${((i + 0.5) / n) * 100}%` }">{{ rotuloDoPonto(p.chave, passo, i === 0) }}</span>
          </template>
        </div>
      </div>
    </div>
    <p v-if="temAnterior" class="mt-2 flex items-center gap-2 text-xs text-ink-700">
      <svg width="22" height="6" aria-hidden="true"><line x1="0" y1="3" x2="22" y2="3" :stroke="corAnterior" stroke-width="2" stroke-dasharray="5 4" /></svg>
      {{ nomeAnterior }}
    </p>
  </div>
</template>
