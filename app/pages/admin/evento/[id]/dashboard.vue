<script setup lang="ts">
definePageMeta({ layout: 'admin' })

const route = useRoute()
const id = route.params.id as string

const periodo = ref<'tudo' | 'hoje' | '7d'>('tudo')
const aba = ref<'geral' | 'publico'>('geral')

/**
 * A régua de período sai de `diaLocal`, não de `toISOString().slice(0, 10)`.
 *
 * O `toISOString` converte pra UTC antes de cortar: às 21h da Bahia ele já
 * devolve amanhã. O botão "Hoje" pedia `de=amanhã&ate=amanhã` e o dashboard
 * mostrava a noite de venda vazia — na noite do evento, que é quando esta
 * tela é aberta. Nada quebrava, nada aparecia no console: o número só ficava
 * errado.
 */
const janela = computed(() => {
  if (periodo.value === 'hoje') return { de: diaLocal(), ate: diaLocal() }
  if (periodo.value === '7d') return { de: diaLocalMais(-6), ate: diaLocal() }
  return {}
})

const { data, pending } = await useFetch<any>(
  () => `/api/admin/evento/${id}/dashboard`,
  { query: janela, watch: [janela] })

const num = (n: number) => n.toLocaleString('pt-BR')

// ---------------------------------------------------- gráfico de linha (SVG)
const L = { w: 820, h: 240, e: 64, d: 8, t: 12, b: 34 }
const linha = computed(() => {
  const pts = data.value?.ritmo ?? []
  if (!pts.length) return null
  // acumulado, que é como a curva de venda é lida: "quanto já entrou até aqui"
  let acc = 0
  const serie = pts.map((p: any) => ({ dia: p.dia, v: (acc += p.cobradoCents) }))
  const max = Math.max(...serie.map((s) => s.v), 1)
  const x = (i: number) => L.e + (i * (L.w - L.e - L.d)) / Math.max(serie.length - 1, 1)
  const y = (v: number) => L.t + (1 - v / max) * (L.h - L.t - L.b)
  return {
    serie, max,
    d: serie.map((s, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(s.v).toFixed(1)}`).join(' '),
    area: `M${x(0)},${y(0)} ` +
      serie.map((s, i) => `L${x(i).toFixed(1)},${y(s.v).toFixed(1)}`).join(' ') +
      ` L${x(serie.length - 1)},${y(0)} Z`,
    grade: [0, 0.25, 0.5, 0.75, 1].map((f) => ({ y: y(max * f), rotulo: reais(Math.round(max * f)) })),
    rotulosX: serie.map((s, i) => ({ x: x(i), texto: diaMes(s.dia) })),
    fim: { x: x(serie.length - 1), y: y(serie[serie.length - 1].v) },
  }
})

// ------------------------------------------------------------- rosca (SVG)
const rosca = computed(() => {
  const f = data.value?.funil
  if (!f) return null
  const total = f.finalizados + f.abandonados + f.abertos
  if (!total) return null
  const fatias = [
    { rotulo: 'Finalizados', n: f.finalizados, cor: '#0050C3' },
    { rotulo: 'Abandonados', n: f.abandonados, cor: '#7FC4F5' },
    { rotulo: 'Em aberto', n: f.abertos, cor: '#D8DDE5' },
  ].filter((x) => x.n > 0)
  const R = 70, r = 46, cx = 90, cy = 90
  let ang = -Math.PI / 2
  return {
    total,
    fatias: fatias.map((s) => {
      const a = (s.n / total) * Math.PI * 2
      const [a0, a1] = [ang, ang + a]
      ang = a1
      const grande = a > Math.PI ? 1 : 0
      const pt = (raio: number, t: number) => `${(cx + raio * Math.cos(t)).toFixed(2)},${(cy + raio * Math.sin(t)).toFixed(2)}`
      return {
        ...s,
        pct: Math.round((s.n / total) * 100),
        // fatia de rosca: arco externo, corta pra dentro, arco interno de volta
        d: `M${pt(R, a0)} A${R},${R} 0 ${grande} 1 ${pt(R, a1)} L${pt(r, a1)} A${r},${r} 0 ${grande} 0 ${pt(r, a0)} Z`,
      }
    }),
  }
})

const somaLotes = computed(() =>
  (data.value?.porSetor ?? []).reduce((s: number, l: any) => s + l.cobradoCents, 0))

const maxForma = computed(() =>
  Math.max(...(data.value?.porForma ?? []).map((f: any) => f.cobradoCents), 1))
const nomeForma: Record<string, string> = {
  pix: 'PIX', credito: 'Crédito', debito: 'Débito', dinheiro: 'Dinheiro', cortesia: 'Cortesia',
}
const nomeCanal: Record<string, string> = { online: 'Online', bilheteria: 'Bilheteria (PDV)', cortesia: 'Cortesia' }

// ---- aba Público -----------------------------------------------------------
// Busca só quando alguém abre a aba: o dashboard é a tela mais aberta do
// sistema e carregar a conta de público em toda visita cobraria seis
// consultas de quem só queria ver o faturamento do dia.
const publico = ref<any>(null)
const carregandoPublico = ref(false)
watch(aba, async (v) => {
  if (v !== 'publico' || publico.value || carregandoPublico.value) return
  carregandoPublico.value = true
  try { publico.value = await $fetch(`/api/admin/evento/${id}/publico`) }
  finally { carregandoPublico.value = false }
})

/** barra proporcional que não mente: 14 em 5000 não pode virar 0%. */
function pct(parte: number, total: number): number {
  if (!total || !parte) return 0
  const v = (parte / total) * 100
  return v >= 10 ? Math.round(v) : Math.max(Math.round(v * 10) / 10, 0.1)
}
const fmtPct = (v: number) => `${v.toLocaleString('pt-BR')}%`

/** 24 posições sempre, pra madrugada vazia aparecer como vazia */
const horas = computed(() => {
  const mapa = new Map<number, number>(
    (publico.value?.horaDaCompra ?? []).map((h: any) => [h.hora, h.pedidos]))
  const pico = Math.max(1, ...mapa.values())
  return Array.from({ length: 24 }, (_, h) => ({
    hora: h, pedidos: mapa.get(h) ?? 0, altura: ((mapa.get(h) ?? 0) / pico) * 100,
  }))
})
const maxDistribuicao = computed(() =>
  Math.max(1, ...(publico.value?.distribuicao ?? []).map((d: any) => d.pessoas)))

useHead({ title: 'Dashboard do evento' })
</script>

<template>
  <div>
    <div class="py-5">
      <h1 class="titulo text-2xl font-bold text-tinta">Dashboard do evento</h1>
      <p class="mt-1 text-tinta-suave">Acompanhe vendas, público e performance</p>
    </div>

    <!-- filtros -->
    <div class="mb-5 flex flex-wrap items-center gap-2">
      <button type="button" :class="aba === 'geral' ? 'chip-ativo' : 'chip'" @click="aba = 'geral'">
        <IconeMenu nome="financeiro" :tamanho="18" /> Visão geral
      </button>
      <button type="button" :class="aba === 'publico' ? 'chip-ativo' : 'chip'" @click="aba = 'publico'">
        <IconeMenu nome="pessoas" :tamanho="18" /> Público
      </button>

      <!--
        As réguas de período somem na aba Público. Elas não filtram aquela
        aba, e chip que fica aceso sem fazer nada é a pior espécie de
        controle: o produtor acha que está vendo "os últimos 7 dias".
      -->
      <div v-if="aba === 'geral'" class="ml-auto flex flex-wrap items-center gap-2">
        <button type="button" :class="periodo === 'hoje' ? 'chip-ativo' : 'chip'" @click="periodo = 'hoje'">Hoje</button>
        <button type="button" :class="periodo === '7d' ? 'chip-ativo' : 'chip'" @click="periodo = '7d'">Últimos 7 dias</button>
        <button type="button" :class="periodo === 'tudo' ? 'chip-ativo' : 'chip'" @click="periodo = 'tudo'">
          <IconeMenu nome="calendario" :tamanho="18" /> Todo o período
        </button>
      </div>
    </div>

    <div v-if="pending && !data" class="card text-tinta-suave">Carregando…</div>

    <template v-else-if="data && aba === 'geral'">
      <!-- ===================================================== KPIs topo -->
      <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <article class="card flex items-start justify-between">
          <div>
            <p class="rotulo-kpi">Total de vendas</p>
            <p class="numero-kpi mt-2">{{ reais(data.totais.cobradoCents) }}</p>
            <p class="mt-1 text-sm text-acao">{{ reais(data.totais.hojeCents) }} hoje</p>
          </div>
          <span class="flex h-10 w-10 items-center justify-center rounded-full bg-acao-fraco text-acao">
            <IconeMenu nome="carteira" />
          </span>
        </article>

        <article class="card flex items-start justify-between">
          <div>
            <p class="rotulo-kpi">Ingressos emitidos</p>
            <p class="numero-kpi mt-2">{{ num(data.totais.ingressos) }}</p>
            <p class="mt-1 text-sm text-tinta-suave">
              {{ num(data.totais.pagos) }} pagos / {{ num(data.totais.cortesias) }} cortesias
            </p>
          </div>
          <span class="flex h-10 w-10 items-center justify-center rounded-full bg-acao-fraco text-acao">
            <IconeMenu nome="bilhetes" />
          </span>
        </article>

        <article class="card flex items-start justify-between">
          <div>
            <p class="rotulo-kpi">Ticket médio por ingresso</p>
            <p class="numero-kpi mt-2">{{ reais(data.totais.ticketMedioCents) }}</p>
            <p class="mt-1 text-sm text-tinta-suave">Vendas por ingressos pagos</p>
          </div>
          <span class="flex h-10 w-10 items-center justify-center rounded-full bg-acao-fraco text-acao">
            <IconeMenu nome="ingresso" />
          </span>
        </article>

        <article class="card flex items-start justify-between">
          <div>
            <p class="rotulo-kpi">Pedidos concluídos</p>
            <p class="numero-kpi mt-2">{{ num(data.totais.pedidos) }}</p>
            <p class="mt-1 text-sm text-tinta-suave">
              {{ data.totais.ingressosPorPedido }} ingressos por pedido
            </p>
          </div>
          <span class="flex h-10 w-10 items-center justify-center rounded-full bg-acao-fraco text-acao">
            <IconeMenu nome="pedido" />
          </span>
        </article>
      </div>

      <!-- ============================================ ritmo + funil ------ -->
      <div class="mt-4 grid gap-4 xl:grid-cols-[1fr_360px]">
        <section class="card">
          <header class="mb-1 flex flex-wrap items-baseline justify-between gap-2">
            <h2 class="rotulo-kpi">Ritmo de vendas</h2>
            <p class="text-xs text-tinta-fraca">acumulado · {{ data.regua }}</p>
          </header>
          <p class="numero-kpi">
            {{ reais(data.totais.cobradoCents) }}
            <span class="text-sm font-normal text-tinta-suave">no período</span>
          </p>

          <div v-if="linha" class="mt-3 overflow-x-auto">
            <svg :viewBox="`0 0 ${L.w} ${L.h}`" class="h-[240px] w-full min-w-[520px]"
                 role="img" aria-label="Curva acumulada de faturamento por dia">
              <defs>
                <linearGradient id="sob" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stop-color="#1C70E9" stop-opacity=".18" />
                  <stop offset="100%" stop-color="#1C70E9" stop-opacity="0" />
                </linearGradient>
              </defs>
              <g v-for="(g, i) in linha.grade" :key="i">
                <line :x1="L.e" :x2="L.w - L.d" :y1="g.y" :y2="g.y"
                      stroke="#EAE9ED" stroke-dasharray="3 4" />
                <text :x="L.e - 8" :y="g.y + 4" text-anchor="end" font-size="10" fill="#8A97A8">
                  {{ g.rotulo }}
                </text>
              </g>
              <path :d="linha.area" fill="url(#sob)" />
              <path :d="linha.d" fill="none" stroke="#1C70E9" stroke-width="2"
                    stroke-linejoin="round" stroke-linecap="round" />
              <circle :cx="linha.fim.x" :cy="linha.fim.y" r="4" fill="#1C70E9" />
              <text v-for="(r, i) in linha.rotulosX" :key="`x${i}`"
                    :x="r.x" :y="L.h - 10" text-anchor="middle" font-size="10" fill="#8A97A8">
                {{ r.texto }}
              </text>
            </svg>
          </div>
          <p v-else class="mt-6 py-10 text-center text-sm text-tinta-fraca">
            Nenhuma venda paga neste período.
          </p>
        </section>

        <section class="card">
          <h2 class="rotulo-kpi">Finalizados × abandonados</h2>
          <p class="mt-1 text-xs text-tinta-fraca">por data de criação do pedido</p>

          <div v-if="rosca" class="mt-3 flex flex-col items-center">
            <svg viewBox="0 0 180 180" class="h-[180px] w-[180px]"
                 role="img" aria-label="Proporção de pedidos finalizados e abandonados">
              <path v-for="(s, i) in rosca.fatias" :key="i" :d="s.d" :fill="s.cor" />
              <text x="90" y="86" text-anchor="middle" font-size="22" font-weight="700" fill="#171719">
                {{ rosca.fatias[0]?.pct ?? 0 }}%
              </text>
              <text x="90" y="104" text-anchor="middle" font-size="10" fill="#8A97A8">finalizados</text>
            </svg>

            <ul class="mt-4 w-full space-y-2 text-sm">
              <li v-for="(s, i) in rosca.fatias" :key="i"
                  class="flex items-center gap-2 border-t border-linha pt-2 first:border-0 first:pt-0">
                <span class="h-2.5 w-2.5 shrink-0 rounded-full" :style="{ background: s.cor }" />
                <span class="flex-1 text-tinta-corpo">{{ s.rotulo }}</span>
                <span class="tabular-nums text-tinta">{{ num(s.n) }}</span>
                <span class="w-10 text-right tabular-nums text-tinta-suave">{{ s.pct }}%</span>
              </li>
            </ul>
          </div>
          <p v-else class="py-14 text-center text-sm text-tinta-fraca">Sem pedidos no período.</p>
        </section>
      </div>

      <!-- ====================================== forma + canal + setores -- -->
      <div class="mt-4 grid gap-4 xl:grid-cols-2">
        <section class="card">
          <h2 class="rotulo-kpi">Por forma de pagamento</h2>
          <ul v-if="data.porForma.length" class="mt-4 space-y-3">
            <li v-for="f in data.porForma" :key="f.forma" class="flex items-center gap-3">
              <span class="w-20 shrink-0 text-sm text-tinta-corpo">{{ nomeForma[f.forma] ?? f.forma }}</span>
              <span class="h-2 flex-1 rounded-full bg-fundo-cinza">
                <span class="block h-2 rounded-full bg-acao"
                      :style="{ width: `${Math.max((f.cobradoCents / maxForma) * 100, 2)}%` }" />
              </span>
              <span class="w-28 shrink-0 text-right text-sm font-medium tabular-nums text-tinta">
                {{ reais(f.cobradoCents) }}
              </span>
            </li>
          </ul>
          <p v-else class="py-8 text-center text-sm text-tinta-fraca">Sem vendas no período.</p>
        </section>

        <section class="card">
          <h2 class="rotulo-kpi">Por canal</h2>
          <ul v-if="data.porCanal.length" class="mt-4 space-y-3">
            <li v-for="c in data.porCanal" :key="c.canal" class="flex items-center gap-3">
              <span class="w-32 shrink-0 text-sm text-tinta-corpo">{{ nomeCanal[c.canal] ?? c.canal }}</span>
              <span class="h-2 flex-1 rounded-full bg-fundo-cinza">
                <span class="block h-2 rounded-full bg-menu"
                      :style="{ width: `${Math.max((c.cobradoCents / maxForma) * 100, 2)}%` }" />
              </span>
              <span class="w-28 shrink-0 text-right text-sm font-medium tabular-nums text-tinta">
                {{ reais(c.cobradoCents) }}
              </span>
            </li>
          </ul>
          <p v-else class="py-8 text-center text-sm text-tinta-fraca">Sem vendas no período.</p>
        </section>
      </div>

      <!-- ================================================ venda por lote -->
      <section class="card mt-4 overflow-hidden p-0">
        <header class="border-b border-linha p-4">
          <h2 class="rotulo-kpi">Vendas por lote</h2>
          <p class="mt-1 text-xs text-tinta-fraca">
            "Vendidos" é o total histórico do lote; a coluna do período segue a régua do dashboard.
          </p>
        </header>
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead class="bg-fundo-cinza text-left text-xs uppercase text-tinta-suave">
              <tr>
                <th class="px-4 py-2 font-bold">Setor</th>
                <th class="px-4 py-2 font-bold">Lote</th>
                <th class="px-4 py-2 text-right font-bold">No período</th>
                <th class="px-4 py-2 text-right font-bold">Vendidos</th>
                <th class="px-4 py-2 text-right font-bold">Estoque</th>
                <th class="px-4 py-2 text-right font-bold">Arrecadado</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(s, i) in data.porSetor" :key="i" class="border-t border-linha">
                <td class="px-4 py-2.5 text-tinta-corpo">{{ s.setor }}</td>
                <td class="px-4 py-2.5 text-tinta-suave">{{ s.lote }}</td>
                <td class="px-4 py-2.5 text-right tabular-nums">{{ num(s.vendidosPeriodo) }}</td>
                <td class="px-4 py-2.5 text-right tabular-nums">{{ num(s.vendidos) }}</td>
                <td class="px-4 py-2.5 text-right tabular-nums text-tinta-suave">
                  {{ num(s.quantidade - s.vendidos - s.reservados) }} / {{ num(s.quantidade) }}
                </td>
                <td class="px-4 py-2.5 text-right font-medium tabular-nums">{{ reais(s.cobradoCents) }}</td>
              </tr>
            </tbody>
            <!--
              Fecha a conta na própria tela. A soma dos lotes é BRUTA: o cupom
              é desconto do pedido, não da linha do lote, então ela nunca bate
              com o KPI do topo sozinha. Em vez de deixar o produtor descobrir
              a diferença na mão (ou construir uma tela só pra explicar),
              a subtração aparece aqui.
            -->
            <tfoot class="border-t-2 border-linha-forte">
              <tr class="text-tinta-suave">
                <td class="px-4 py-2" colspan="5">Subtotal dos lotes</td>
                <td class="px-4 py-2 text-right tabular-nums">{{ reais(somaLotes) }}</td>
              </tr>
              <tr v-if="data.totais.descontoCents" class="text-tinta-suave">
                <td class="px-4 py-2" colspan="5">Descontos (cupons)</td>
                <td class="px-4 py-2 text-right tabular-nums">− {{ reais(data.totais.descontoCents) }}</td>
              </tr>
              <tr class="border-t border-linha font-bold text-tinta">
                <td class="px-4 py-2.5" colspan="5">Total de vendas</td>
                <td class="px-4 py-2.5 text-right tabular-nums">{{ reais(data.totais.cobradoCents) }}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </section>
    </template>

    <!-- ========================================================== público -->
    <template v-else-if="aba === 'publico'">
      <div v-if="!publico" class="card text-tinta-suave">
        {{ carregandoPublico ? 'Carregando o público…' : 'Sem dados de público.' }}
      </div>

      <template v-else>
        <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <article class="card">
            <p class="rotulo-kpi">Pessoas que compraram</p>
            <p class="numero-kpi mt-2">{{ num(publico.pessoas.compradores) }}</p>
            <p class="mt-1 text-sm text-tinta-suave">
              {{ publico.pessoas.ingressosPorPessoa }} ingressos por pessoa
            </p>
          </article>

          <article class="card">
            <p class="rotulo-kpi">Primeira compra na casa</p>
            <p class="numero-kpi mt-2">{{ num(publico.pessoas.novos) }}</p>
            <p class="mt-1 text-sm text-tinta-suave">
              {{ num(publico.pessoas.recorrentes) }}
              {{ publico.pessoas.recorrentes === 1 ? 'já tinha comprado' : 'já tinham comprado' }}
              em outro evento seu
            </p>
          </article>

          <article class="card">
            <p class="rotulo-kpi">De onde vem</p>
            <p class="numero-kpi mt-2">{{ publico.porUf[0]?.uf ?? '—' }}</p>
            <p class="mt-1 text-sm text-tinta-suave">
              {{ publico.porUf[0] ? fmtPct(pct(publico.porUf[0].pessoas, publico.pessoas.compradores)) : '—' }}
              do público · pelo DDD
            </p>
          </article>

          <!-- não é estatística, é trabalho pra portaria -->
          <article class="card">
            <p class="rotulo-kpi">Ingressos sem titular</p>
            <p class="numero-kpi mt-2" :class="publico.titulares.semNome ? 'text-alerta' : ''">
              {{ num(publico.titulares.semNome) }}
            </p>
            <p class="mt-1 text-sm text-tinta-suave">
              de {{ num(publico.titulares.comNome + publico.titulares.semNome) }} — entram por conferência na mão
            </p>
          </article>
        </div>

        <div class="mt-4 grid gap-4 lg:grid-cols-2">
          <!-- quantos ingressos por pessoa -->
          <section class="card">
            <h2 class="rotulo-kpi">Quantos ingressos cada um leva</h2>
            <p class="mt-1 text-xs text-tinta-fraca">
              Quem compra 1 chega sozinho; quem compra 6 chega de carro cheio e junto.
            </p>
            <ul class="mt-4 space-y-3">
              <li v-for="d in publico.distribuicao" :key="d.rotulo">
                <div class="flex items-baseline justify-between text-sm">
                  <span class="text-tinta-corpo">{{ d.rotulo }}</span>
                  <span class="tabular-nums text-tinta-suave">
                    {{ num(d.pessoas) }} {{ d.pessoas === 1 ? 'pessoa' : 'pessoas' }}
                    · {{ num(d.ingressos) }} ingressos
                  </span>
                </div>
                <div class="mt-1.5 h-2 overflow-hidden rounded-sm bg-fundo-cinza">
                  <div class="h-full rounded-sm bg-acao"
                       :style="{ width: `${Math.max(pct(d.pessoas, maxDistribuicao), 1.5)}%` }" />
                </div>
              </li>
            </ul>
          </section>

          <!-- origem por DDD -->
          <section class="card">
            <h2 class="rotulo-kpi">Origem pelo DDD do telefone</h2>
            <p class="mt-1 text-xs text-tinta-fraca">
              É o DDD do número cadastrado, não o endereço: quem mudou de cidade levou o número junto.
              Serve pra decidir onde anunciar.
            </p>
            <ul class="mt-4 space-y-3">
              <li v-for="o in publico.porDdd" :key="o.ddd">
                <div class="flex items-baseline justify-between text-sm">
                  <span class="text-tinta-corpo">
                    ({{ o.ddd }}) {{ o.uf }}
                    <span v-if="o.regiao" class="text-tinta-fraca">· {{ o.regiao }}</span>
                  </span>
                  <span class="tabular-nums text-tinta-suave">
                    {{ num(o.pessoas) }} · {{ fmtPct(pct(o.pessoas, publico.pessoas.compradores)) }}
                  </span>
                </div>
                <div class="mt-1.5 h-2 overflow-hidden rounded-sm bg-fundo-cinza">
                  <div class="h-full rounded-sm bg-acao"
                       :style="{ width: `${Math.max(pct(o.pessoas, publico.pessoas.compradores), 1.5)}%` }" />
                </div>
              </li>
            </ul>
            <p v-if="publico.pessoas.semTelefone" class="mt-4 text-xs text-tinta-fraca">
              {{ num(publico.pessoas.semTelefone) }}
              {{ publico.pessoas.semTelefone === 1 ? 'pessoa ficou' : 'pessoas ficaram' }}
              de fora desta conta por não ter telefone no cadastro.
            </p>
          </section>
        </div>

        <!-- a que horas compram -->
        <section class="card mt-4">
          <h2 class="rotulo-kpi">A que horas compram</h2>
          <p class="mt-1 text-xs text-tinta-fraca">
            Hora de Bahia, por pedido pago. É a janela em que o anúncio encontra a pessoa decidindo.
          </p>
          <!--
            Cada coluna precisa de `h-full`: altura em % só resolve contra pai
            com altura definida, e sem isso as 24 barras viram um traço de 3px
            grudado no chão — o gráfico existe, aparece, e não informa nada.
          -->
          <div class="mt-5 flex h-32 items-end gap-1">
            <div v-for="h in horas" :key="h.hora" class="flex h-full flex-1 items-end"
                 :title="`${h.hora}h — ${h.pedidos} ${h.pedidos === 1 ? 'pedido' : 'pedidos'}`">
              <div class="w-full rounded-t-sm"
                   :class="h.pedidos ? 'bg-acao' : 'bg-fundo-cinza'"
                   :style="{ height: h.pedidos ? `${Math.max(h.altura, 6)}%` : '3px' }" />
            </div>
          </div>
          <div class="mt-2 flex justify-between text-[11px] tabular-nums text-tinta-fraca">
            <span>00h</span><span>06h</span><span>12h</span><span>18h</span><span>23h</span>
          </div>
        </section>

        <!-- quem mais comprou -->
        <section class="card mt-4 overflow-hidden p-0">
          <header class="border-b border-linha p-4">
            <h2 class="rotulo-kpi">Quem mais comprou</h2>
          </header>
          <div class="overflow-x-auto">
            <table class="w-full text-sm">
              <thead class="bg-fundo-cinza text-left text-xs uppercase text-tinta-suave">
                <tr>
                  <th class="px-4 py-2 font-bold">Pessoa</th>
                  <th class="px-4 py-2 text-right font-bold">Ingressos</th>
                  <th class="px-4 py-2 text-right font-bold">Pedidos</th>
                  <th class="px-4 py-2 text-right font-bold">Gasto</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(c, i) in publico.topCompradores" :key="i" class="border-t border-linha">
                  <td class="px-4 py-2.5">
                    <p class="text-tinta-corpo">{{ c.nome }}</p>
                    <p class="text-xs text-tinta-fraca">{{ c.email }}</p>
                  </td>
                  <td class="px-4 py-2.5 text-right tabular-nums">{{ num(c.ingressos) }}</td>
                  <td class="px-4 py-2.5 text-right tabular-nums text-tinta-suave">{{ num(c.pedidos) }}</td>
                  <td class="px-4 py-2.5 text-right font-medium tabular-nums">{{ reais(c.gastoCents) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <!--
          O que a casa NÃO perguntou. Fica escrito em vez de virar gráfico
          vazio: faixa etária e gênero só existem se o checkout perguntar, e
          inventar esse número é pior que não ter — alguém compra mídia nele.
        -->
        <p class="mt-4 text-xs text-tinta-fraca">
          Não dá pra mostrar {{ publico.naoColetado.join(', ') }}: o checkout não pergunta.
          No dia em que perguntar, entra aqui.
        </p>
      </template>
    </template>
  </div>
</template>
