<script lang="ts">
/*
 * As contas que a TELA faz — puras, exportadas pro teste (`app/composables/evento-dashboard.test.ts`).
 * Os números vêm prontos da rota (`dashboard.get.ts`, as réguas de `utils/liquido.ts`); aqui só se
 * decide como desenhar. Foi aqui que moravam a rosca que mentia (ADM-16/17), a barra na escala
 * errada (ADM-18), o risquinho de R$ 0 (ADM-34) e o eixo que saía do SVG (ADM-20).
 */

/** "R$ 12 mil", "R$ 1,2 mi", "R$ 850" — o eixo do gráfico, onde "R$ 12.345,67" não cabe (ADM-20) */
export function reaisCompacto(cents: number): string {
  const v = Math.round(Number(cents) || 0) / 100
  const abs = Math.abs(v)
  const curto = (n: number) =>
    n.toLocaleString('pt-BR', { maximumFractionDigits: Math.abs(n) < 10 ? 1 : 0 })
  if (abs >= 1_000_000) return `R$ ${curto(v / 1_000_000)} mi`
  if (abs >= 1_000) return `R$ ${curto(v / 1_000)} mil`
  return `R$ ${Math.round(v).toLocaleString('pt-BR')}`
}

/** "20/09" de um dia de calendário `AAAA-MM-DD` — sem `Date`, logo sem fuso nenhum */
export function diaMesDoDia(dia: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dia ?? ''))
  return m ? `${m[3]}/${m[2]}` : '—'
}

/** onde pôr os rótulos do eixo X: no máximo `maximo`, o primeiro e o último sempre (ADM-20) */
export function indicesDosRotulos(n: number, maximo = 8): number[] {
  if (n <= 0) return []
  if (n <= maximo) return Array.from({ length: n }, (_, i) => i)
  const passo = (n - 1) / (maximo - 1)
  return [...new Set(Array.from({ length: maximo }, (_, i) => Math.round(i * passo)))]
}

/**
 * Largura de barra que não mente: cada lista contra o SEU máximo (a de canal usava o máximo das
 * formas e estourava a trilha, ADM-18), zero é trilha vazia (o mínimo de 2% desenhava R$ 0,00
 * como se existisse, ADM-34) e nada passa de 100%. Valor pequeno mas não zero ainda aparece.
 */
export function larguraDaBarra(valor: number, maximo: number): number {
  if (!(valor > 0) || !(maximo > 0)) return 0
  return Math.min(100, Math.max((valor / maximo) * 100, 1.5))
}

/** o desenho do gráfico de dias */
export const G = { w: 820, h: 260, e: 84, d: 84, t: 14, b: 30 }

/**
 * VENDAS POR DIA (ADM-20): uma barra por dia do período — a rota manda a série contínua, dia sem
 * venda é barra zero —, a linha do acumulado por cima, eixo compacto dos dois lados (esquerda:
 * vendido no dia; direita: acumulado) e no máximo 8 rótulos no X. Um dia só é uma barra.
 */
export function graficoDeDias(serie: { dia: string; cobradoCents: number; ingressos: number }[]) {
  const n = serie?.length ?? 0
  if (!n || !serie.some((s) => s.cobradoCents > 0)) return null
  const largura = G.w - G.e - G.d
  const altura = G.h - G.t - G.b
  const maxDia = Math.max(...serie.map((s) => s.cobradoCents), 1)
  let soma = 0
  const acumulado = serie.map((s) => (soma += s.cobradoCents))
  const maxAcc = Math.max(soma, 1)
  const passo = largura / n
  const barra = Math.max(Math.min(passo * 0.72, 44), 1)
  const x = (i: number) => G.e + passo * i + passo / 2
  const yDia = (v: number) => G.t + (1 - v / maxDia) * altura
  const yAcc = (v: number) => G.t + (1 - v / maxAcc) * altura
  const base = G.t + altura
  return {
    barras: serie.map((s, i) => ({
      dia: s.dia, cobradoCents: s.cobradoCents, ingressos: s.ingressos, acumuladoCents: acumulado[i],
      x: x(i) - barra / 2, w: barra, y: yDia(s.cobradoCents), h: base - yDia(s.cobradoCents),
    })),
    linha: acumulado.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${yAcc(v).toFixed(1)}`).join(' '),
    fim: { x: x(n - 1), y: yAcc(soma) },
    // as duas escalas partem do mesmo chão, então as frações caem nas mesmas linhas
    grade: [0, 0.25, 0.5, 0.75, 1].map((f) => ({
      y: yDia(maxDia * f), esquerda: reaisCompacto(Math.round(maxDia * f)),
      direita: reaisCompacto(Math.round(maxAcc * f)),
    })),
    rotulosX: indicesDosRotulos(n).map((i) => ({ x: x(i), texto: diaMesDoDia(serie[i].dia) })),
    base,
    total: soma,
  }
}

/** as cores do funil — hex dos tokens da casa (tailwind.config.js), porque aqui é `background` inline */
export const CORES_DO_FUNIL: Record<string, string> = {
  finalizados: '#146f83', abandonados: '#8fd4ea', abertos: '#c8c5d5',
  devolvidos: '#b91c1c', contestados: '#b45309', outros: '#716c87',
}

/**
 * O FUNIL DO CHECKOUT DO SITE, numa barra empilhada — no lugar da rosca.
 *
 * A rosca escrevia no centro a porcentagem da PRIMEIRA fatia que sobrava do filtro, com o rótulo
 * "finalizados": sem nenhum finalizado, 100% de abandonados virava "100% finalizados" (ADM-16). E
 * uma fatia de 100% é um arco que começa e termina no mesmo ponto — o SVG não desenhava nada, no
 * caso mais comum do parque (ADM-17). Barra empilhada não tem trigonometria: 100% é a barra cheia.
 *
 * O denominador é `criados` (as partes somam ele por construção, ver a rota).
 */
export function funilDoSite(f: any) {
  const total = Number(f?.criados ?? 0)
  if (!total) return null
  const partes = [
    { chave: 'finalizados', rotulo: 'Finalizados (viraram pagamento)', n: Number(f.finalizados ?? 0) },
    { chave: 'abandonados', rotulo: 'Abandonados (expirou, cancelou ou falhou)', n: Number(f.abandonados ?? 0) },
    { chave: 'abertos', rotulo: 'Em aberto (aguardando pagamento)', n: Number(f.abertos ?? 0) },
    { chave: 'devolvidos', rotulo: 'Devolvidos por inteiro', n: Number(f.devolvidos ?? 0) },
    { chave: 'contestados', rotulo: 'Em contestação', n: Number(f.contestados ?? 0) },
    { chave: 'outros', rotulo: 'Outros', n: Number(f.outros ?? 0) },
  ].map((p) => ({ ...p, cor: CORES_DO_FUNIL[p.chave], pct: (p.n / total) * 100 }))
  return {
    total,
    pctFinalizados: Math.round((Number(f.finalizados ?? 0) / total) * 100),
    partes: partes.filter((p) => p.n > 0),
  }
}

/** ▲ 12% / ▼ 3,5% / = — a variação contra o período anterior, com a cor do sentido */
export function textoDaVariacao(v: number | null | undefined): { texto: string; classe: string } | null {
  if (v === null || v === undefined || !Number.isFinite(v)) return null
  if (v === 0) return { texto: '= igual', classe: 'text-tinta-suave' }
  const s = Math.abs(v).toLocaleString('pt-BR')
  return v > 0 ? { texto: `▲ ${s}%`, classe: 'text-ok' } : { texto: `▼ ${s}%`, classe: 'text-erro' }
}

/** a cor de cada portão no gráfico da portaria — um tom da marca por portão, "Outros" em cinza */
export const CORES_DOS_PORTOES = ['#146f83', '#583c8d', '#fdb92a', '#9cb826', '#a09cb2']

/** a cor de cada canal na barra empilhada */
export const COR_DO_CANAL: Record<string, string> = {
  online: '#146f83', bilheteria: '#fdb92a', pdv_produtor: '#cf7506', pdv_ticketeira: '#a45408',
  cortesia: '#9cb826',
}
</script>

<script setup lang="ts">
/**
 * O painel do evento — o que o dono abre primeiro (redesenho de 27/09, seção 4.4 da auditoria).
 *
 * Cinco números no topo (vendas, líquido, ingressos, público na portaria, ticket médio), com a
 * variação contra o período anterior; vendas por dia contínuas; hoje por hora contra ontem; canal,
 * forma e tipo de ingresso (com a cota de meia); os próximos dias com a ocupação; a portaria de
 * hoje; o funil do site; a comparação lado a lado; e a tabela por lote.
 *
 * Todo número vem da rota, com as réguas compartilhadas (`PEDIDO_VIVO`, `SQL_LIQUIDO`,
 * `retratoDoPublico`, `sessao_ocupacao`) — a tela não soma dinheiro por conta própria.
 *
 * O período mora na URL (ADM-31): `?periodo=hoje|ontem|7d` ou `?de=&ate=`, e a aba em `?aba=`.
 * Em "Hoje" a página se atualiza sozinha a cada minuto e diz a hora da última leitura.
 */
import { ehPapel, podeAbrirPagina } from '~~/server/utils/papeis'

definePageMeta({ layout: 'admin' })

const route = useRoute()
const router = useRouter()
const id = route.params.id as string

/**
 * Os atalhos do painel (Sessões, Histórico, Abrir o leitor, os barrados) só pra quem abre a tela
 * do outro lado: o Financeiro vê o painel e levava 403 em todos eles — botão que não funciona.
 * Mesma régua do menu (`podeAbrirPagina`); papel desconhecido mostra e o servidor decide.
 */
const { data: eu } = await useFetch<any>('/api/auth/eu', { key: 'auth-eu' })
function podeAbrir(resto: string): boolean {
  const p = eu.value?.usuario?.papel
  return !ehPapel(p) || podeAbrirPagina(p, `/admin/evento/${id}${resto}`)
}

type Periodo = 'tudo' | 'hoje' | 'ontem' | '7d' | 'personalizado'
const naUrl = (chave: string) => {
  const v = route.query[chave]
  return String((Array.isArray(v) ? v[0] : v) ?? '')
}
const DIA = /^\d{4}-\d{2}-\d{2}$/
const de = ref(DIA.test(naUrl('de')) ? naUrl('de') : '')
const ate = ref(DIA.test(naUrl('ate')) ? naUrl('ate') : '')
const periodo = ref<Periodo>(
  (['hoje', 'ontem', '7d'] as const).includes(naUrl('periodo') as any)
    ? naUrl('periodo') as Periodo
    : de.value || ate.value ? 'personalizado' : 'tudo')
const aba = ref<'geral' | 'publico'>(naUrl('aba') === 'publico' ? 'publico' : 'geral')

function escolher(p: Periodo) {
  periodo.value = p
  if (p !== 'personalizado') { de.value = ''; ate.value = '' }
}
/** mexeu numa data: o período vira "personalizado"; apagou as duas, volta a ser tudo */
watch([de, ate], ([d, a]) => {
  if (d || a) periodo.value = 'personalizado'
  else if (periodo.value === 'personalizado') periodo.value = 'tudo'
})

/**
 * A tela manda o NOME do período (`periodo=hoje`), não a data: quem decide que dia é "hoje" é o
 * servidor, no fuso do evento (ver `dashboard.get.ts`). Datas escolhidas vão como dia de
 * calendário (`AAAA-MM-DD`).
 */
const consulta = computed<Record<string, string>>(() => {
  if (periodo.value === 'personalizado') {
    const c: Record<string, string> = {}
    if (de.value) c.de = de.value
    if (ate.value) c.ate = ate.value
    return c
  }
  return periodo.value === 'tudo' ? {} : { periodo: periodo.value }
})

watch([consulta, aba], () => {
  router.replace({ query: { ...consulta.value, ...(aba.value === 'publico' ? { aba: 'publico' } : {}) } })
})

const { data, pending, error: falha, refresh } = await useFetch<any>(
  () => `/api/admin/evento/${id}/dashboard`,
  { query: consulta, watch: [consulta] })

/**
 * O porquê da falha, com as palavras do servidor. Sem isto a tela ficava EM BRANCO pra quem não
 * pode ver dinheiro (403) ou quando a rota caía (500).
 */
const motivoDaFalha = computed(() => {
  const f = falha.value as any
  if (!f) return ''
  return f?.data?.statusMessage || f?.statusMessage || f?.message || 'Não foi possível carregar o painel.'
})

/* ------------------------------------------------ "Hoje" se atualiza sozinho */
let relogio: ReturnType<typeof setInterval> | undefined
function ligarRelogio() {
  clearInterval(relogio)
  relogio = undefined
  if (periodo.value !== 'hoje' || typeof window === 'undefined') return
  // aba escondida não gasta rede nem banco: atualiza quando voltar a ser olhada
  relogio = setInterval(() => { if (!document.hidden) refresh() }, 60_000)
}
onMounted(ligarRelogio)
watch(periodo, ligarRelogio)
onBeforeUnmount(() => clearInterval(relogio))

/**
 * "14:32" da última leitura, no relógio do evento — pronto da rota (`periodo.atualizadoAs`, feito
 * no banco com o fuso do evento). Formatar data na tela é o que a trava de formato.test.ts proíbe.
 */
const atualizadoAs = computed(() => String(data.value?.periodo?.atualizadoAs ?? ''))

const num = (n: number) => Number(n ?? 0).toLocaleString('pt-BR')
const t = computed(() => data.value?.totais ?? {})

/* ------------------------------------------------------------- comparação */
const comparacao = computed(() => data.value?.comparacao ?? null)
const contraQue = computed(() => {
  const p = data.value?.periodo
  const c = comparacao.value
  if (!p || !c) return ''
  const mesmaHora = c.ateAMesmaHora ? ' até esta hora' : ''
  if (p.nome === 'hoje') return `vs ontem${mesmaHora}`
  if (p.nome === 'ontem') return 'vs anteontem'
  if (p.nome === '7d') return `vs os 7 dias anteriores${mesmaHora}`
  const n = Number(c.duracaoEmDias ?? 0)
  return `vs ${n === 1 ? 'o dia anterior' : `os ${n} dias anteriores`}${mesmaHora}`
})
const variacao = (chave: string) => textoDaVariacao(comparacao.value?.variacao?.[chave])

/** as linhas da tabela "Comparação": as duas janelas pela mesma função da rota, e a variação dela */
const linhasDaComparacao = computed(() => {
  const c = comparacao.value
  if (!c) return []
  const linha = (rotulo: string, chave: string, campo: string, dinheiro: boolean) => ({
    rotulo, dinheiro, atual: c.atual[campo], anterior: c.anterior[campo],
    variacao: c.anterior[campo] ? textoDaVariacao(c.variacao?.[chave]) : null,
  })
  return [
    linha('Total de vendas', 'cobrado', 'cobradoCents', true),
    linha('Líquido do produtor', 'liquido', 'liquidoCents', true),
    linha('Ingressos vendidos', 'ingressos', 'ingressosVendidos', false),
    linha('Ticket médio por pedido', 'ticketPorPedido', 'ticketMedioPorPedidoCents', true),
    linha('Entradas na portaria (pessoas)', 'entradas', 'entradasNaPortaria', false),
  ]
})
/** a conversão do site: porcentagem, então a diferença é em pontos percentuais */
const conversaoPp = computed(() => {
  const v = comparacao.value?.variacao?.conversaoPp
  if (v === null || v === undefined) return null
  return { texto: `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toLocaleString('pt-BR')} p.p.`,
           classe: v > 0 ? 'text-ok' : v < 0 ? 'text-erro' : 'text-tinta-suave' }
})

/** a devolução em duas partes que NÃO se subtraem do total (ADM-11) */
const devolvidoPorInteiro = computed(() =>
  Math.max(0, (t.value.estornadoCents ?? 0) - (t.value.estornadoNoLiquidoCents ?? 0)))

/* ------------------------------------------------------------ gráficos */
/** a série do gráfico: a contínua da rota (`serie`); resposta antiga, só os dias com venda */
const serieDoGrafico = computed<any[]>(() => data.value?.serie ?? data.value?.ritmo ?? [])
const dias = computed(() => graficoDeDias(serieDoGrafico.value))
/**
 * No celular o gráfico rola dentro do cartão: ele abre no FIM, nos dias mais recentes — é o que
 * se acompanha. Vigia o elemento (e não só os dados): os dados chegam antes de ele existir.
 */
const rolagemDias = ref<HTMLElement | null>(null)
watch([rolagemDias, dias], () => nextTick(() => {
  const el = rolagemDias.value
  if (el) el.scrollLeft = el.scrollWidth
}))
const funil = computed(() => funilDoSite(data.value?.funil))

const horas = computed(() => {
  const hs: any[] = data.value?.porHoraHoje ?? []
  const pico = Math.max(1, ...hs.map((h) => Math.max(h.hojeCents, h.ontemCents)))
  return hs.map((h) => ({
    ...h,
    alturaHoje: h.hojeCents > 0 ? Math.max((h.hojeCents / pico) * 100, 4) : 0,
    alturaOntem: h.ontemCents > 0 ? Math.max((h.ontemCents / pico) * 100, 4) : 0,
  }))
})
const vendidoHoje = computed(() => horas.value.reduce((s, h) => s + h.hojeCents, 0))
const vendidoOntem = computed(() => horas.value.reduce((s, h) => s + h.ontemCents, 0))

const nomeForma: Record<string, string> = {
  pix: 'PIX', credito: 'Crédito', debito: 'Débito', dinheiro: 'Dinheiro', cortesia: 'Cortesia',
}
const nomeCanal: Record<string, string> = {
  online: 'Site', bilheteria: 'Bilheteria (balcão)', pdv_produtor: 'PDV do produtor',
  pdv_ticketeira: 'PDV da ticketeira', cortesia: 'Cortesia',
}
const maxForma = computed(() => Math.max(0, ...(data.value?.porForma ?? []).map((f: any) => f.cobradoCents)))
const maxCanal = computed(() => Math.max(0, ...(data.value?.porCanal ?? []).map((c: any) => c.cobradoCents)))
const somaCanais = computed(() => (data.value?.porCanal ?? []).reduce((s: number, c: any) => s + c.cobradoCents, 0))
const pedidosCanais = computed(() => (data.value?.porCanal ?? []).reduce((s: number, c: any) => s + c.n, 0))

/* ------------------------------------------------------ tipo de ingresso */
const NOME_ESPECIE: Record<string, string> = { inteira: 'Inteira', meia: 'Meia-entrada', gratuito: 'Gratuidade' }
const COR_ESPECIE: Record<string, string> = { inteira: 'bg-pool-700', meia: 'bg-grape-600', gratuito: 'bg-citrus-500' }
const porTipo = computed(() => {
  const linhas = [...(data.value?.porTipo ?? []).map((x: any) => ({
    chave: x.especie, rotulo: NOME_ESPECIE[x.especie] ?? x.especie, ingressos: x.ingressos,
    classe: COR_ESPECIE[x.especie] ?? 'bg-ink-400',
  })), {
    chave: 'cortesia', rotulo: 'Cortesia da casa', ingressos: t.value.cortesiasEmitidas ?? 0, classe: 'bg-sun-400',
  }]
  const total = linhas.reduce((s, l) => s + l.ingressos, 0)
  return { total, linhas: linhas.map((l) => ({ ...l, pct: total ? (l.ingressos / total) * 100 : 0 })) }
})
/** perto da cota: 7/8 dela (35% de um lote com a cota legal de 40%); passou: acima da cota */
const cotas = computed(() => (data.value?.cotaDeMeia ?? []).map((c: any) => ({
  ...c,
  estado: c.meias > c.cota ? 'estourou' : c.cota > 0 && c.meias >= c.cota * 0.875 ? 'perto' : 'ok',
  largura: larguraDaBarra(c.meias, c.quantidade),
  marca: c.quantidade ? Math.min((c.cota / c.quantidade) * 100, 100) : 0,
})))

/* ------------------------------------------------------------ portaria */
const portaria = computed(() => data.value?.portaria ?? null)
const quartos = computed(() => {
  const qs: any[] = portaria.value?.quartos ?? []
  const pico = Math.max(1, ...qs.map((q) => q.pessoas))
  return qs.map((q) => ({
    ...q,
    fatias: (portaria.value?.portoes ?? []).map((nome: string, i: number) => ({
      nome, cor: CORES_DOS_PORTOES[Math.min(i, CORES_DOS_PORTOES.length - 1)],
      altura: ((q.porPortao?.[nome] ?? 0) / pico) * 100, pessoas: q.porPortao?.[nome] ?? 0,
    })).filter((f: any) => f.pessoas > 0),
  }))
})
const MOTIVO_DA_RECUSA: Record<string, string> = {
  ja_usado: 'Já tinha entrado', invalido: 'Código inválido', cancelado: 'Ingresso cancelado',
  fora_da_sessao: 'Fora do horário', evento_errado: 'De outro evento',
}
const barrados = computed(() => (portaria.value?.barradosHoje ?? []).reduce((s: number, b: any) => s + b.n, 0))

const somaLotes = computed(() =>
  (data.value?.porSetor ?? []).reduce((s: number, l: any) => s + l.cobradoCents, 0))

/* ---- aba Público -------------------------------------------------------------------------------
 * Busca só quando alguém abre a aba: o dashboard é a tela mais aberta do sistema e carregar a
 * conta de público em toda visita cobraria seis consultas de quem só queria ver o faturamento. */
const publico = ref<any>(null)
const carregandoPublico = ref(false)
/** a falha da aba Público — sem ela um 403/500 aparecia como "Sem dados de público" */
const falhaPublico = ref('')
async function carregarPublico() {
  if (publico.value || carregandoPublico.value) return
  carregandoPublico.value = true
  falhaPublico.value = ''
  try {
    publico.value = await $fetch(`/api/admin/evento/${id}/publico`)
  } catch (e: any) {
    falhaPublico.value = e?.data?.statusMessage || e?.statusMessage
      || 'Não foi possível carregar o público. Confira a conexão e tente de novo.'
  } finally {
    carregandoPublico.value = false
  }
}
// no navegador: o `$fetch` do servidor não leva o cookie da sessão, e a aba viria com um 401
watch(aba, (v) => { if (v === 'publico') carregarPublico() })
onMounted(() => { if (aba.value === 'publico') carregarPublico() })

/** barra proporcional que não mente: 14 em 5000 não pode virar 0%. */
function pct(parte: number, total: number): number {
  if (!total || !parte) return 0
  const v = (parte / total) * 100
  return v >= 10 ? Math.round(v) : Math.max(Math.round(v * 10) / 10, 0.1)
}
const fmtPct = (v: number) => `${Number(v ?? 0).toLocaleString('pt-BR')}%`

/** 24 posições sempre, pra madrugada vazia aparecer como vazia */
const horasDaCompra = computed(() => {
  const mapa = new Map<number, number>(
    (publico.value?.horaDaCompra ?? []).map((h: any) => [h.hora, h.pedidos]))
  const pico = Math.max(1, ...mapa.values())
  return Array.from({ length: 24 }, (_, h) => ({
    hora: h, pedidos: mapa.get(h) ?? 0, altura: ((mapa.get(h) ?? 0) / pico) * 100,
  }))
})
const maxDistribuicao = computed(() =>
  Math.max(1, ...(publico.value?.distribuicao ?? []).map((d: any) => d.pessoas)))
const maxFaixa = computed(() =>
  Math.max(1, ...(publico.value?.idades?.faixas ?? []).map((f: any) => f.pessoas)))
const maxCidade = computed(() =>
  Math.max(1, ...(publico.value?.cidades?.top ?? []).map((c: any) => c.pessoas)))

useHead({ title: 'Dashboard do evento' })
</script>

<template>
  <div>
    <div class="flex flex-wrap items-end justify-between gap-3 py-5">
      <div>
        <h1 class="titulo text-2xl font-semibold text-tinta">Dashboard do evento</h1>
        <p class="mt-1 text-tinta-suave">
          Vendas, dinheiro e portaria — pela data do pagamento, no relógio do evento.
        </p>
      </div>
      <p v-if="data && aba === 'geral' && atualizadoAs" class="text-xs text-tinta-fraca" data-parte="atualizado">
        Atualizado às {{ atualizadoAs }}<template v-if="periodo === 'hoje'"> · atualiza sozinho a cada minuto</template>
      </p>
    </div>

    <!-- abas e período -->
    <div class="mb-5 flex flex-wrap items-center gap-2">
      <button type="button" :class="aba === 'geral' ? 'chip-ativo' : 'chip'" class="min-h-[40px]" @click="aba = 'geral'">
        <IconeMenu nome="financeiro" :tamanho="18" /> Visão geral
      </button>
      <button type="button" :class="aba === 'publico' ? 'chip-ativo' : 'chip'" class="min-h-[40px]" @click="aba = 'publico'">
        <IconeMenu nome="pessoas" :tamanho="18" /> Público
      </button>

      <!-- O período some na aba Público: ele não filtra aquela aba, e chip aceso que não faz nada
           faz o produtor achar que está vendo "os últimos 7 dias". -->
      <div v-if="aba === 'geral'" class="flex w-full flex-wrap items-center gap-2 lg:ml-auto lg:w-auto"
           data-parte="periodo">
        <button v-for="p in ([['hoje', 'Hoje'], ['ontem', 'Ontem'], ['7d', '7 dias'], ['tudo', 'Todo o período']] as const)"
                :key="p[0]" type="button" class="min-h-[40px]"
                :class="periodo === p[0] ? 'chip-ativo' : 'chip'" @click="escolher(p[0])">
          {{ p[1] }}
        </button>
        <div class="flex w-full items-center gap-2 sm:w-auto">
          <label class="sr-only" for="painel-de">De</label>
          <input id="painel-de" v-model="de" type="date" class="campo min-h-[40px] min-w-0 flex-1 px-3 py-1.5 sm:w-[9.25rem] sm:flex-none"
                 :class="periodo === 'personalizado' ? 'ring-2 ring-acao' : ''" aria-label="De">
          <span class="text-sm text-tinta-suave">até</span>
          <label class="sr-only" for="painel-ate">Até</label>
          <input id="painel-ate" v-model="ate" type="date" class="campo min-h-[40px] min-w-0 flex-1 px-3 py-1.5 sm:w-[9.25rem] sm:flex-none"
                 :class="periodo === 'personalizado' ? 'ring-2 ring-acao' : ''" aria-label="Até">
        </div>
      </div>
    </div>

    <div v-if="pending && !data && aba === 'geral'" class="card text-tinta-suave">Carregando…</div>

    <div v-else-if="falha && !data && aba === 'geral'" class="card" data-parte="falha-painel">
      <p class="rotulo-kpi text-erro">Não foi possível carregar o painel</p>
      <p class="mt-1 text-sm text-tinta-suave">{{ motivoDaFalha }}</p>
      <button type="button" class="btn-secundario mt-3" @click="refresh()">Tentar de novo</button>
    </div>

    <template v-else-if="data && aba === 'geral'">
      <!-- ================================================================ os cinco números
           Um tom da marca por número, numa faixa grossa no alto do cartão (piscina, uva, sol,
           limão, tinta): cor de verdade, sem o quadrado de degradê que pesava mais que o número. -->
      <p v-if="comparacao" class="mb-2 text-xs text-tinta-suave" data-parte="contra-que">
        ▲▼ comparam este período {{ contraQue }} — a tabela "Comparação", mais abaixo, mostra os dois lados.
      </p>
      <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <article class="card overflow-hidden pt-0" data-parte="kpi-vendas">
          <div class="-mx-5 mb-4 h-1.5 bg-pool-700" />
          <p class="rotulo-kpi flex items-center gap-2"><IconeMenu nome="carteira" :tamanho="18" /> Total de vendas</p>
          <p class="numero-kpi mt-2">{{ reais(t.cobradoCents) }}</p>
          <p v-if="variacao('cobrado')" class="mt-1 text-sm font-semibold" :class="variacao('cobrado')!.classe">
            {{ variacao('cobrado')!.texto }} <span class="font-normal text-tinta-suave">vs anterior</span>
          </p>
          <p v-if="periodo !== 'hoje'" class="mt-1 text-sm text-tinta-suave">
            {{ reais(t.hojeCents) }} hoje
          </p>
        </article>

        <article class="card overflow-hidden pt-0" data-parte="kpi-liquido">
          <div class="-mx-5 mb-4 h-1.5 bg-grape-600" />
          <p class="rotulo-kpi">Líquido do produtor</p>
          <!-- o que sobra pro produtor: SQL_LIQUIDO, o mesmo do borderô e dos financeiros (ADM-11) -->
          <p class="numero-kpi mt-2" data-parte="liquido">{{ reais(t.liquidoCents) }}</p>
          <p v-if="variacao('liquido')" class="mt-1 text-sm font-semibold" :class="variacao('liquido')!.classe">
            {{ variacao('liquido')!.texto }} <span class="font-normal text-tinta-suave">vs anterior</span>
          </p>
          <p v-if="t.liquidoNaPlataformaCents !== undefined" class="mt-1 text-sm text-tinta-suave" data-parte="liquido-partes">
            {{ reais(t.liquidoNaPlataformaCents) }} na plataforma · {{ reais(t.liquidoDiretoCents) }} recebido direto
          </p>
        </article>

        <article class="card overflow-hidden pt-0" data-parte="kpi-ingressos">
          <div class="-mx-5 mb-4 h-1.5 bg-sun-400" />
          <p class="rotulo-kpi flex items-center gap-2"><IconeMenu nome="bilhetes" :tamanho="18" /> Ingressos vendidos</p>
          <p class="numero-kpi mt-2" data-parte="ingressos-vendidos">{{ num(t.pagos) }}</p>
          <p v-if="variacao('ingressos')" class="mt-1 text-sm font-semibold" :class="variacao('ingressos')!.classe">
            {{ variacao('ingressos')!.texto }} <span class="font-normal text-tinta-suave">vs anterior</span>
          </p>
          <p class="mt-1 text-sm text-tinta-suave">
            {{ num(t.ingressosPorPedido) }} ingressos por pedido
            <template v-if="t.cortesiasEmitidas"> · + {{ num(t.cortesiasEmitidas) }} de cortesia</template>
          </p>
        </article>

        <!-- PÚBLICO NA PORTARIA (ADM-19): o retrato da porta pela mesma função do leitor -->
        <article class="card overflow-hidden pt-0" data-parte="kpi-publico">
          <div class="-mx-5 mb-4 h-1.5 bg-citrus-500" />
          <p class="rotulo-kpi flex items-center gap-2"><IconeMenu nome="validacao" :tamanho="18" /> Público na portaria</p>
          <p class="numero-kpi mt-2" data-parte="publico-pessoas">{{ num(portaria?.pessoas ?? data.publico?.pessoas ?? 0) }}</p>
          <p class="mt-1 text-sm text-tinta-suave">
            pessoas entraram<template v-if="portaria"> · {{ num(portaria.hoje?.pessoas ?? 0) }} hoje</template>
          </p>
          <p v-if="portaria?.aptos" class="mt-1 text-sm text-tinta-suave">
            {{ num(portaria.ingressos) }} de {{ num(portaria.aptos) }} ingressos · {{ fmtPct(portaria.comparecimentoPct) }}
          </p>
          <p v-if="portaria?.offline" class="mt-2"><span class="selo-alerta">{{ num(portaria.offline) }} decididas sem rede</span></p>
        </article>

        <article class="card overflow-hidden pt-0" data-parte="kpi-ticket">
          <div class="-mx-5 mb-4 h-1.5 bg-ink-700" />
          <p class="rotulo-kpi flex items-center gap-2"><IconeMenu nome="pedido" :tamanho="18" /> Ticket médio</p>
          <!-- só de quem PAGOU (ADM-12): cortesia e venda de R$ 0 derrubavam a média -->
          <p class="numero-kpi mt-2">{{ reais(t.ticketMedioPorPedidoCents) }}</p>
          <p v-if="variacao('ticketPorPedido')" class="mt-1 text-sm font-semibold" :class="variacao('ticketPorPedido')!.classe">
            {{ variacao('ticketPorPedido')!.texto }} <span class="font-normal text-tinta-suave">vs anterior</span>
          </p>
          <p class="mt-1 text-sm text-tinta-suave">
            por pedido · {{ reais(t.ticketMedioPorIngressoCents) }} por ingresso
          </p>
          <p class="mt-1 text-sm text-tinta-suave">
            em <strong class="text-tinta" data-parte="pedidos-pagos">{{ num(t.pedidosPagantes ?? t.pedidos) }}</strong>
            pedidos pagos<template v-if="t.pedidosSemCobranca"> · + {{ num(t.pedidosSemCobranca) }} sem cobrança (cortesia ou R$ 0)</template>
          </p>
        </article>
      </div>

      <!-- DEVOLVIDO AO COMPRADOR — linha própria, sem sinal de menos (ADM-11). Aparecia como
           "− R$ X" debaixo do total, e quem lia descontava de novo. -->
      <p v-if="t.estornadoCents" class="mt-3 text-sm text-tinta-suave" data-parte="devolvido">
        Devolvido ao comprador:
        <strong class="text-tinta">{{ reais(t.estornadoCents) }}</strong>
        <template v-if="t.pedidosComDevolucao">
          em {{ num(t.pedidosComDevolucao) }} {{ t.pedidosComDevolucao === 1 ? 'pedido' : 'pedidos' }}</template>.
        Não subtraia do total:
        <template v-if="devolvidoPorInteiro">{{ reais(devolvidoPorInteiro) }} de pedido estornado por inteiro, que já não entra nele</template><template
          v-if="devolvidoPorInteiro && t.estornadoNoLiquidoCents">; </template><template
          v-if="t.estornadoNoLiquidoCents">{{ reais(t.estornadoNoLiquidoCents) }} de estorno parcial, já descontado do líquido</template>.
      </p>

      <!-- ======================================================= dias + hoje por hora -->
      <div class="mt-4 grid gap-4 xl:grid-cols-12">
        <section class="card xl:col-span-8" data-parte="vendas-por-dia">
          <header class="flex flex-wrap items-baseline justify-between gap-2">
            <h2 class="titulo-bloco">Vendas por dia</h2>
            <p class="flex flex-wrap items-center gap-3 text-xs text-tinta-suave">
              <span class="flex items-center gap-1.5"><i class="h-3 w-3 rounded-sm bg-pool-700" /> vendido no dia (eixo da esquerda)</span>
              <span class="flex items-center gap-1.5"><i class="h-0.5 w-4 rounded bg-grape-600" /> acumulado (direita)</span>
            </p>
          </header>
          <p class="apoio-bloco">
            {{ reais(dias?.total ?? t.cobradoCents) }} em {{ num(serieDoGrafico.length) }}
            {{ serieDoGrafico.length === 1 ? 'dia' : 'dias' }}
            <template v-if="data.serieCortada"> · mostrando os últimos {{ num(serieDoGrafico.length) }} dias</template>
          </p>

          <div v-if="dias" ref="rolagemDias" class="mt-3 overflow-x-auto" data-parte="rolagem-dias">
            <svg :viewBox="`0 0 ${G.w} ${G.h}`" class="h-[260px] w-full min-w-[760px] lg:min-w-0"
                 role="img" :aria-label="`Vendas por dia: ${serieDoGrafico.length} dias, ${reais(dias.total)} no total`">
              <g v-for="(g, i) in dias.grade" :key="`g${i}`">
                <line :x1="G.e" :x2="G.w - G.d" :y1="g.y" :y2="g.y" stroke="#e2e0ea"
                      :stroke-dasharray="i ? '3 4' : ''" />
                <text :x="G.e - 8" :y="g.y + 4" text-anchor="end" font-size="12" fill="#433e57">{{ g.esquerda }}</text>
                <text :x="G.w - G.d + 8" :y="g.y + 4" text-anchor="start" font-size="12" fill="#583c8d">{{ g.direita }}</text>
              </g>
              <rect v-for="b in dias.barras" :key="b.dia" :x="b.x" :y="b.y" :width="b.w" :height="b.h"
                    rx="2" fill="#146f83" data-parte="barra-dia">
                <title>{{ diaMesDoDia(b.dia) }}: {{ reais(b.cobradoCents) }} · {{ num(b.ingressos) }} ingresso(s) · acumulado {{ reais(b.acumuladoCents) }}</title>
              </rect>
              <path :d="dias.linha" fill="none" stroke="#583c8d" stroke-width="2.5"
                    stroke-linejoin="round" stroke-linecap="round" />
              <circle :cx="dias.fim.x" :cy="dias.fim.y" r="4" fill="#583c8d" />
              <text v-for="(r, i) in dias.rotulosX" :key="`x${i}`" :x="r.x" :y="G.h - 8"
                    text-anchor="middle" font-size="12" fill="#433e57" data-parte="rotulo-x">{{ r.texto }}</text>
            </svg>
          </div>
          <div v-else class="mt-4 flex flex-col items-center gap-2 py-10 text-center" data-parte="dias-vazio">
            <IconeMenu nome="relatorio" :tamanho="28" class="text-tinta-suave" />
            <p class="text-sm text-tinta-suave">Nenhuma venda paga neste período.</p>
            <button v-if="periodo !== 'tudo'" type="button" class="btn-secundario" @click="escolher('tudo')">
              Ver todo o período
            </button>
          </div>
        </section>

        <section class="card xl:col-span-4" data-parte="hoje-por-hora">
          <h2 class="titulo-bloco">Hoje por hora</h2>
          <p class="apoio-bloco">
            <strong class="text-tinta">{{ reais(vendidoHoje) }}</strong> hoje · {{ reais(vendidoOntem) }} ontem inteiro
          </p>
          <!-- `h-full` em cada coluna: altura em % só resolve contra pai com altura definida -->
          <div class="mt-4 flex h-36 items-end gap-[3px]">
            <div v-for="h in horas" :key="h.hora" class="relative flex h-full flex-1 items-end justify-center"
                 :title="`${String(h.hora).padStart(2, '0')}h — hoje ${reais(h.hojeCents)} (${h.hojePedidos} pedido(s)) · ontem ${reais(h.ontemCents)}`">
              <div v-if="h.alturaOntem" class="absolute bottom-0 w-full rounded-t-sm bg-pool-200"
                   :style="{ height: `${h.alturaOntem}%` }" />
              <div class="relative w-3/5 rounded-t-sm"
                   :class="[h.hora === data.periodo?.horaAgora ? 'bg-grape-600' : 'bg-acao', h.alturaHoje ? '' : 'opacity-0']"
                   :style="{ height: h.alturaHoje ? `${h.alturaHoje}%` : '0' }" data-parte="barra-hora-hoje" />
            </div>
          </div>
          <div class="mt-2 flex justify-between text-[11px] tabular-nums text-tinta-suave">
            <span>00h</span><span>06h</span><span>12h</span><span>18h</span><span>23h</span>
          </div>
          <p class="mt-3 flex flex-wrap gap-3 text-xs text-tinta-suave">
            <span class="flex items-center gap-1.5"><i class="h-3 w-3 rounded-sm bg-acao" /> hoje</span>
            <span class="flex items-center gap-1.5"><i class="h-3 w-3 rounded-sm bg-grape-600" /> hora atual</span>
            <span class="flex items-center gap-1.5"><i class="h-3 w-3 rounded-sm bg-pool-200" /> ontem</span>
          </p>
        </section>
      </div>

      <!-- ================================================== canal · forma · tipo -->
      <div class="mt-4 grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
        <section class="card" data-parte="por-canal">
          <h2 class="titulo-bloco">Por canal</h2>
          <template v-if="data.porCanal.length">
            <!-- a barra empilhada: quanto de cada canal no total -->
            <div class="mt-4 flex h-3 overflow-hidden rounded-full bg-ink-100" aria-hidden="true">
              <div v-for="c in data.porCanal" :key="c.canal" class="h-full"
                   :style="{ width: `${somaCanais ? (c.cobradoCents / somaCanais) * 100 : 0}%`, background: COR_DO_CANAL[c.canal] ?? '#a09cb2' }" />
            </div>
            <ul class="mt-4 space-y-3">
              <li v-for="c in data.porCanal" :key="c.canal">
                <div class="flex items-baseline justify-between gap-2 text-sm">
                  <span class="flex items-center gap-2 text-tinta-corpo">
                    <i class="h-2.5 w-2.5 rounded-full" :style="{ background: COR_DO_CANAL[c.canal] ?? '#a09cb2' }" />
                    {{ nomeCanal[c.canal] ?? c.canal }}
                  </span>
                  <span class="font-semibold tabular-nums text-tinta">{{ reais(c.cobradoCents) }}</span>
                </div>
                <div class="mt-1.5 h-2 overflow-hidden rounded-full bg-ink-100">
                  <div class="h-full rounded-full" data-parte="barra-canal"
                       :style="{ width: `${larguraDaBarra(c.cobradoCents, maxCanal)}%`, background: COR_DO_CANAL[c.canal] ?? '#a09cb2' }" />
                </div>
                <p class="mt-1 text-xs text-tinta-suave">
                  {{ num(c.n) }} {{ c.n === 1 ? 'pedido' : 'pedidos' }}
                  <template v-if="somaCanais"> · {{ fmtPct(pct(c.cobradoCents, somaCanais)) }} do valor</template>
                  <template v-else-if="pedidosCanais"> · {{ fmtPct(pct(c.n, pedidosCanais)) }} dos pedidos</template>
                </p>
              </li>
            </ul>
          </template>
          <p v-else class="py-8 text-center text-sm text-tinta-suave">Sem vendas no período.</p>
        </section>

        <section class="card" data-parte="por-forma">
          <h2 class="titulo-bloco">Por forma de pagamento</h2>
          <ul v-if="data.porForma.length" class="mt-4 space-y-3">
            <li v-for="f in data.porForma" :key="f.forma ?? 'sem'">
              <div class="flex items-baseline justify-between gap-2 text-sm">
                <span class="text-tinta-corpo">{{ nomeForma[f.forma] ?? f.forma ?? 'Sem forma' }}</span>
                <span class="font-semibold tabular-nums text-tinta">{{ reais(f.cobradoCents) }}</span>
              </div>
              <div class="mt-1.5 h-2 overflow-hidden rounded-full bg-ink-100">
                <div class="h-full rounded-full bg-acao" data-parte="barra-forma"
                     :style="{ width: `${larguraDaBarra(f.cobradoCents, maxForma)}%` }" />
              </div>
              <p class="mt-1 text-xs text-tinta-suave">{{ num(f.n) }} {{ f.n === 1 ? 'pedido' : 'pedidos' }}</p>
            </li>
          </ul>
          <p v-else class="py-8 text-center text-sm text-tinta-suave">Sem vendas no período.</p>
        </section>

        <section class="card lg:col-span-2 xl:col-span-1" data-parte="por-tipo">
          <h2 class="titulo-bloco">Por tipo de ingresso</h2>
          <p class="apoio-bloco">ingressos no período, cortesia à parte</p>
          <template v-if="porTipo.total">
            <div class="mt-4 flex h-3 overflow-hidden rounded-full bg-ink-100" aria-hidden="true">
              <div v-for="l in porTipo.linhas" :key="l.chave" class="h-full" :class="l.classe"
                   :style="{ width: `${l.pct}%` }" />
            </div>
            <ul class="mt-4 space-y-2 text-sm">
              <li v-for="l in porTipo.linhas" :key="l.chave" class="flex items-center gap-2">
                <i class="h-2.5 w-2.5 shrink-0 rounded-full" :class="l.classe" />
                <span class="flex-1 text-tinta-corpo">{{ l.rotulo }}</span>
                <span class="font-semibold tabular-nums text-tinta">{{ num(l.ingressos) }}</span>
                <span class="w-12 text-right tabular-nums text-tinta-suave">{{ l.ingressos ? fmtPct(pct(l.ingressos, porTipo.total)) : '—' }}</span>
              </li>
            </ul>
          </template>
          <p v-else class="py-6 text-center text-sm text-tinta-suave">Sem ingressos no período.</p>

          <!-- A COTA DE MEIA de cada lote que vende meia — a mesma conta da trava da venda -->
          <div v-if="cotas.length" class="mt-5 border-t border-linha pt-4" data-parte="cota-meia">
            <h3 class="rotulo-kpi">Cota de meia-entrada (do lote inteiro)</h3>
            <ul class="mt-3 space-y-3">
              <li v-for="c in cotas" :key="c.loteId">
                <div class="flex items-baseline justify-between gap-2 text-sm">
                  <span class="min-w-0 truncate text-tinta-corpo">{{ c.setor }} · {{ c.lote }}</span>
                  <span class="shrink-0 tabular-nums text-tinta">{{ num(c.meias) }} de {{ num(c.cota) }}</span>
                </div>
                <div class="relative mt-1.5 h-2 overflow-hidden rounded-full bg-ink-100">
                  <div class="h-full rounded-full"
                       :class="c.estado === 'estourou' ? 'bg-erro' : c.estado === 'perto' ? 'bg-alerta' : 'bg-grape-600'"
                       :style="{ width: `${c.largura}%` }" />
                  <i class="absolute inset-y-0 w-0.5 bg-tinta" :style="{ left: `${c.marca}%` }" :title="`cota: ${num(c.cota)}`" />
                </div>
                <p v-if="c.estado === 'estourou'" class="faixa-erro mt-2">
                  Passou da cota: {{ num(c.meias) }} meias num lote de {{ num(c.quantidade) }} com cota de {{ num(c.cota) }}.
                </p>
                <p v-else-if="c.estado === 'perto'" class="faixa-aviso mt-2">
                  Perto da cota: restam {{ num(c.cota - c.meias) }} meias neste lote.
                </p>
              </li>
            </ul>
          </div>
        </section>
      </div>

      <!-- ====================================================== próximos dias -->
      <section v-if="data.proximosDias?.length" class="card mt-4" data-parte="proximos-dias">
        <header class="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <h2 class="titulo-bloco">Ocupação dos próximos dias</h2>
            <p class="apoio-bloco">pessoas já vendidas ou reservadas em cada dia, contra a capacidade</p>
          </div>
          <NuxtLink v-if="podeAbrir('/ingressos/sessoes')" :to="`/admin/evento/${id}/ingressos/sessoes`"
                    class="btn-secundario" data-parte="atalho-sessoes">Sessões</NuxtLink>
        </header>
        <ul class="mt-4 grid gap-3 md:grid-cols-2">
          <li v-for="s in data.proximosDias" :key="s.id" class="rounded-xl bg-fundo-cinza p-3 ring-1 ring-inset ring-linha">
            <div class="flex items-start justify-between gap-2">
              <div class="min-w-0">
                <p class="truncate font-semibold text-tinta">{{ s.titulo || diaMesDoDia(s.dia) }}</p>
                <p class="text-xs text-tinta-suave">{{ diaMesDoDia(s.dia) }} · {{ s.hora }}</p>
              </div>
              <span v-if="s.lotado" class="selo-erro">Lotado</span>
              <span v-else-if="s.capacidade !== null" class="selo-ok">{{ num(s.vagas) }} vagas</span>
              <span v-else class="selo-neutro">Sem teto</span>
            </div>
            <div v-if="s.capacidade" class="mt-2 h-2.5 overflow-hidden rounded-full bg-white ring-1 ring-inset ring-linha">
              <div class="h-full rounded-full" :class="s.lotado ? 'bg-erro' : 'bg-acao'"
                   :style="{ width: `${larguraDaBarra(s.ocupadas, s.capacidade)}%` }" />
            </div>
            <p class="mt-1 text-xs tabular-nums text-tinta-suave">
              {{ num(s.ocupadas) }}<template v-if="s.capacidade !== null"> de {{ num(s.capacidade) }}</template> pessoas
            </p>
          </li>
        </ul>
        <p v-if="data.sessoes && data.sessoes.futuras > data.proximosDias.length" class="mt-3 text-xs text-tinta-suave">
          e mais {{ num(data.sessoes.futuras - data.proximosDias.length) }} dia(s) em Sessões.
        </p>
      </section>

      <!-- ============================================= portaria de hoje + funil do site -->
      <div class="mt-4 grid gap-4 xl:grid-cols-12">
        <section class="card xl:col-span-7" data-parte="portaria-hoje">
          <header class="flex flex-wrap items-baseline justify-between gap-2">
            <div>
              <h2 class="titulo-bloco">Portaria hoje</h2>
              <p class="apoio-bloco">pessoas que entraram a cada 15 minutos, por portão</p>
            </div>
            <NuxtLink v-if="podeAbrir('/validacao/historico')" :to="`/admin/evento/${id}/validacao/historico`"
                      class="btn-secundario" data-parte="atalho-historico">Histórico</NuxtLink>
          </header>
          <div class="mt-3 flex flex-wrap gap-x-8 gap-y-2">
            <div>
              <p class="rotulo-kpi">Entraram hoje</p>
              <p class="numero-kpi mt-1">{{ num(portaria?.hoje?.pessoas ?? 0) }}</p>
              <p class="text-xs text-tinta-suave">em {{ num(portaria?.hoje?.passagens ?? 0) }} passagem(ns)</p>
            </div>
            <div>
              <p class="rotulo-kpi">Barrados hoje</p>
              <p class="numero-kpi mt-1" :class="barrados ? 'text-alerta' : ''">{{ num(barrados) }}</p>
              <p class="text-xs text-tinta-suave">
                <template v-for="(b, i) in portaria?.barradosHoje ?? []" :key="b.resultado"><template v-if="i"> · </template><NuxtLink
                  v-if="podeAbrir('/validacao/historico')"
                  :to="`/admin/evento/${id}/validacao/historico?resultado=${b.resultado}`"
                  class="underline" data-parte="atalho-barrados">{{ MOTIVO_DA_RECUSA[b.resultado] ?? b.resultado }} {{ num(b.n) }}</NuxtLink><span
                  v-else>{{ MOTIVO_DA_RECUSA[b.resultado] ?? b.resultado }} {{ num(b.n) }}</span></template>
                <template v-if="!barrados">ninguém barrado</template>
              </p>
            </div>
          </div>
          <template v-if="quartos.length">
            <div class="mt-4">
              <div class="flex h-32 items-end" :class="quartos.length > 40 ? 'gap-px' : 'gap-[2px]'">
                <div v-for="q in quartos" :key="q.quarto" class="flex h-full flex-1 flex-col justify-end"
                     :title="`${q.rotulo} — ${q.pessoas} pessoa(s)`">
                  <div v-for="f in q.fatias" :key="f.nome" class="w-full first:rounded-t-sm"
                       :style="{ height: `${f.altura}%`, background: f.cor }" />
                </div>
              </div>
              <div class="mt-1 flex justify-between text-[11px] tabular-nums text-tinta-suave">
                <span>{{ quartos[0].rotulo }}</span>
                <span v-if="quartos.length > 4">{{ quartos[Math.floor(quartos.length / 2)].rotulo }}</span>
                <span>{{ quartos[quartos.length - 1].rotulo }}</span>
              </div>
            </div>
            <p class="mt-2 flex flex-wrap gap-3 text-xs text-tinta-suave">
              <span v-for="(nome, i) in portaria.portoes" :key="nome" class="flex items-center gap-1.5">
                <i class="h-3 w-3 rounded-sm" :style="{ background: CORES_DOS_PORTOES[Math.min(i, CORES_DOS_PORTOES.length - 1)] }" /> {{ nome }}
              </span>
            </p>
          </template>
          <div v-else class="mt-4 flex flex-col items-center gap-2 py-6 text-center">
            <IconeMenu nome="validacao" :tamanho="28" class="text-tinta-suave" />
            <p class="text-sm text-tinta-suave">Ninguém passou pela portaria hoje.</p>
            <NuxtLink v-if="podeAbrir('/validacao')" :to="`/admin/evento/${id}/validacao`"
                      class="btn-secundario" data-parte="atalho-leitor">Abrir o leitor</NuxtLink>
          </div>
        </section>

        <section class="card xl:col-span-5" data-parte="funil-site">
          <h2 class="titulo-bloco">Checkout do site</h2>
          <!-- só o pedido online tem carrinho (ADM-28): balcão e cortesia nascem pagos -->
          <p class="apoio-bloco">pedidos online, por data de criação · balcão e cortesia não entram</p>
          <template v-if="funil">
            <p class="mt-3">
              <span class="numero-kpi" data-parte="funil-pct">{{ funil.pctFinalizados }}%</span>
              <span class="ml-1 text-sm text-tinta-suave">finalizados · de {{ num(funil.total) }} pedidos criados</span>
            </p>
            <div class="mt-3 flex h-4 overflow-hidden rounded-full bg-ink-100" data-parte="funil-barra">
              <div v-for="p in funil.partes" :key="p.chave" class="h-full"
                   :style="{ width: `${p.pct}%`, background: p.cor }" :title="`${p.rotulo}: ${p.n}`" />
            </div>
            <ul class="mt-4 space-y-2 text-sm">
              <li v-for="p in funil.partes" :key="p.chave" class="flex items-center gap-2">
                <i class="h-2.5 w-2.5 shrink-0 rounded-full" :style="{ background: p.cor }" />
                <span class="flex-1 text-tinta-corpo">{{ p.rotulo }}</span>
                <span class="font-semibold tabular-nums text-tinta">{{ num(p.n) }}</span>
                <span class="w-12 text-right tabular-nums text-tinta-suave">{{ fmtPct(pct(p.n, funil.total)) }}</span>
              </li>
            </ul>
          </template>
          <p v-else class="py-10 text-center text-sm text-tinta-suave">Sem pedidos no período.</p>
        </section>
      </div>

      <!-- ============================================================== comparação -->
      <section v-if="comparacao" class="card mt-4 overflow-hidden p-0" data-parte="comparacao">
        <header class="border-b border-linha p-4">
          <h2 class="titulo-bloco">Comparação</h2>
          <p class="apoio-bloco">este período {{ contraQue }}, pelas mesmas contas</p>
        </header>
        <ul class="divide-y divide-linha sm:hidden" data-parte="comparacao-celular">
          <li v-for="l in linhasDaComparacao" :key="l.rotulo" class="px-4 py-3">
            <p class="text-sm text-tinta-corpo">{{ l.rotulo }}</p>
            <p class="mt-1 flex flex-wrap items-baseline gap-x-3 text-sm tabular-nums">
              <strong class="text-base text-tinta">{{ l.dinheiro ? reais(l.atual) : num(l.atual) }}</strong>
              <span class="text-tinta-suave">antes {{ l.dinheiro ? reais(l.anterior) : num(l.anterior) }}</span>
              <span v-if="l.variacao" class="font-semibold" :class="l.variacao.classe">{{ l.variacao.texto }}</span>
              <span v-else class="text-tinta-suave">sem base</span>
            </p>
          </li>
          <li class="px-4 py-3">
            <p class="text-sm text-tinta-corpo">Conversão do site</p>
            <p class="mt-1 flex flex-wrap items-baseline gap-x-3 text-sm tabular-nums">
              <strong class="text-base text-tinta">{{ comparacao.atual.conversaoDoSitePct === null ? '—' : fmtPct(comparacao.atual.conversaoDoSitePct) }}</strong>
              <span class="text-tinta-suave">antes {{ comparacao.anterior.conversaoDoSitePct === null ? '—' : fmtPct(comparacao.anterior.conversaoDoSitePct) }}</span>
              <span v-if="conversaoPp" class="font-semibold" :class="conversaoPp.classe">{{ conversaoPp.texto }}</span>
            </p>
          </li>
        </ul>
        <div class="hidden overflow-x-auto sm:block">
          <table class="w-full min-w-[520px] text-sm">
            <thead class="bg-fundo-cinza text-left text-xs uppercase text-tinta-suave">
              <tr>
                <th class="px-4 py-2 font-semibold" />
                <th class="px-4 py-2 text-right font-semibold">Este período</th>
                <th class="px-4 py-2 text-right font-semibold">Anterior</th>
                <th class="px-4 py-2 text-right font-semibold">Variação</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="l in linhasDaComparacao" :key="l.rotulo" class="border-t border-linha" data-parte="linha-comparacao">
                <td class="px-4 py-2.5 text-tinta-corpo">{{ l.rotulo }}</td>
                <td class="whitespace-nowrap px-4 py-2.5 text-right font-semibold tabular-nums text-tinta">{{ l.dinheiro ? reais(l.atual) : num(l.atual) }}</td>
                <td class="whitespace-nowrap px-4 py-2.5 text-right tabular-nums text-tinta-suave">{{ l.dinheiro ? reais(l.anterior) : num(l.anterior) }}</td>
                <td class="px-4 py-2.5 text-right font-semibold tabular-nums">
                  <span v-if="l.variacao" :class="l.variacao.classe">{{ l.variacao.texto }}</span>
                  <span v-else class="font-normal text-tinta-suave">sem base</span>
                </td>
              </tr>
              <tr class="border-t border-linha">
                <td class="px-4 py-2.5 text-tinta-corpo">Conversão do site</td>
                <td class="px-4 py-2.5 text-right font-semibold tabular-nums text-tinta">
                  {{ comparacao.atual.conversaoDoSitePct === null ? '—' : fmtPct(comparacao.atual.conversaoDoSitePct) }}
                </td>
                <td class="px-4 py-2.5 text-right tabular-nums text-tinta-suave">
                  {{ comparacao.anterior.conversaoDoSitePct === null ? '—' : fmtPct(comparacao.anterior.conversaoDoSitePct) }}
                </td>
                <td class="px-4 py-2.5 text-right font-semibold tabular-nums">
                  <span v-if="conversaoPp" :class="conversaoPp.classe">{{ conversaoPp.texto }}</span>
                  <span v-else class="font-normal text-tinta-suave">—</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- ================================================================ por lote -->
      <section class="card mt-4 overflow-hidden p-0" data-parte="por-lote">
        <header class="border-b border-linha p-4">
          <h2 class="titulo-bloco">Vendas por lote</h2>
          <p class="apoio-bloco">"Vendidos" é o total histórico do lote; a coluna do período segue a régua do painel.</p>
        </header>
        <div class="overflow-x-auto">
          <table class="w-full min-w-[640px] text-sm">
            <thead class="bg-fundo-cinza text-left text-xs uppercase text-tinta-suave">
              <tr>
                <th class="px-4 py-2 font-semibold">Setor</th>
                <th class="px-4 py-2 font-semibold">Lote</th>
                <th class="px-4 py-2 text-right font-semibold">No período</th>
                <th class="px-4 py-2 font-semibold">Vendidos</th>
                <th class="px-4 py-2 text-right font-semibold">Estoque</th>
                <th class="px-4 py-2 text-right font-semibold">Arrecadado</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(s, i) in data.porSetor" :key="i" class="border-t border-linha">
                <td class="px-4 py-2.5 text-tinta-corpo">{{ s.setor }}</td>
                <td class="px-4 py-2.5 text-tinta-suave">{{ s.lote }}</td>
                <td class="px-4 py-2.5 text-right tabular-nums">{{ num(s.vendidosPeriodo) }}</td>
                <td class="px-4 py-2.5">
                  <div class="flex items-center gap-2">
                    <span class="w-12 text-right tabular-nums">{{ num(s.vendidos) }}</span>
                    <span class="h-1.5 w-20 overflow-hidden rounded-full bg-ink-100">
                      <span class="block h-full rounded-full bg-acao" data-parte="ocupacao-lote"
                            :style="{ width: `${larguraDaBarra(s.vendidos, s.quantidade)}%` }" />
                    </span>
                  </div>
                </td>
                <td class="whitespace-nowrap px-4 py-2.5 text-right tabular-nums text-tinta-suave">
                  {{ num(s.quantidade - s.vendidos - s.reservados) }} / {{ num(s.quantidade) }}
                </td>
                <td class="whitespace-nowrap px-4 py-2.5 text-right font-medium tabular-nums">{{ reais(s.cobradoCents) }}</td>
              </tr>
            </tbody>
            <!-- Fecha a conta na própria tela: a soma dos lotes é BRUTA (o cupom é desconto do
                 pedido), então a subtração aparece aqui. -->
            <tfoot class="border-t-2 border-linha-forte">
              <tr class="text-tinta-suave">
                <td class="px-4 py-2" colspan="5">Subtotal dos lotes</td>
                <td class="px-4 py-2 text-right tabular-nums">{{ reais(somaLotes) }}</td>
              </tr>
              <tr v-if="t.descontoCents" class="text-tinta-suave">
                <td class="px-4 py-2" colspan="5">Descontos (cupons)</td>
                <td class="px-4 py-2 text-right tabular-nums">− {{ reais(t.descontoCents) }}</td>
              </tr>
              <tr class="border-t border-linha font-semibold text-tinta">
                <td class="px-4 py-2.5" colspan="5">Total de vendas</td>
                <td class="px-4 py-2.5 text-right tabular-nums">{{ reais(t.cobradoCents) }}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </section>
    </template>

    <!-- ========================================================== público -->
    <template v-else-if="aba === 'publico'">
      <div v-if="!publico && falhaPublico" class="card" data-parte="falha-publico">
        <p class="rotulo-kpi text-erro">Não foi possível carregar o público</p>
        <p class="mt-1 text-sm text-tinta-suave">{{ falhaPublico }}</p>
        <button type="button" class="btn-secundario mt-3" :disabled="carregandoPublico"
                @click="carregarPublico()">
          Tentar de novo
        </button>
      </div>
      <div v-else-if="!publico" class="card text-tinta-suave">
        {{ carregandoPublico ? 'Carregando o público…' : 'Sem dados de público.' }}
      </div>

      <template v-else>
        <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <article class="card">
            <p class="rotulo-kpi">Pessoas que compraram</p>
            <p class="numero-kpi mt-2">{{ num(publico.pessoas.compradores) }}</p>
            <p class="mt-1 text-sm text-tinta-suave">
              {{ num(publico.pessoas.ingressosPorPessoa) }} ingressos por pessoa
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
          <section class="card">
            <h2 class="titulo-bloco">Quantos ingressos cada um leva</h2>
            <p class="apoio-bloco">Quem compra 1 chega sozinho; quem compra 6 chega de carro cheio e junto.</p>
            <ul class="mt-4 space-y-3">
              <li v-for="d in publico.distribuicao" :key="d.rotulo">
                <div class="flex items-baseline justify-between text-sm">
                  <span class="text-tinta-corpo">{{ d.rotulo }}</span>
                  <span class="tabular-nums text-tinta-suave">
                    {{ num(d.pessoas) }} {{ d.pessoas === 1 ? 'pessoa' : 'pessoas' }} · {{ num(d.ingressos) }} ingressos
                  </span>
                </div>
                <div class="mt-1.5 h-2 overflow-hidden rounded-full bg-ink-100">
                  <div class="h-full rounded-full bg-acao" :style="{ width: `${larguraDaBarra(d.pessoas, maxDistribuicao)}%` }" />
                </div>
              </li>
            </ul>
          </section>

          <section class="card">
            <h2 class="titulo-bloco">Origem pelo DDD do telefone</h2>
            <p class="apoio-bloco">
              É o DDD do número cadastrado, não o endereço: quem mudou de cidade levou o número junto.
            </p>
            <ul class="mt-4 space-y-3">
              <li v-for="o in publico.porDdd" :key="o.ddd">
                <div class="flex items-baseline justify-between text-sm">
                  <span class="text-tinta-corpo">
                    ({{ o.ddd }}) {{ o.uf }} <span v-if="o.regiao" class="text-tinta-suave">· {{ o.regiao }}</span>
                  </span>
                  <span class="tabular-nums text-tinta-suave">
                    {{ num(o.pessoas) }} · {{ fmtPct(pct(o.pessoas, publico.pessoas.compradores)) }}
                  </span>
                </div>
                <div class="mt-1.5 h-2 overflow-hidden rounded-full bg-ink-100">
                  <div class="h-full rounded-full bg-acao"
                       :style="{ width: `${larguraDaBarra(o.pessoas, publico.pessoas.compradores)}%` }" />
                </div>
              </li>
            </ul>
            <p v-if="publico.pessoas.semTelefone" class="mt-4 text-xs text-tinta-suave">
              {{ num(publico.pessoas.semTelefone) }}
              {{ publico.pessoas.semTelefone === 1 ? 'pessoa ficou' : 'pessoas ficaram' }}
              de fora desta conta por não ter telefone no cadastro.
            </p>
          </section>

          <!-- ADM-32: o checkout PERGUNTA nascimento e cidade (cadastro do 027, opcional) — aqui
               aparece o que foi respondido, com quantos responderam -->
          <section v-if="publico.idades" class="card" data-parte="faixa-etaria">
            <h2 class="titulo-bloco">Faixa etária</h2>
            <p class="apoio-bloco">
              idade no dia do evento · {{ num(publico.idades.informaram) }} de {{ num(publico.pessoas.compradores) }}
              compradores informaram a data de nascimento
            </p>
            <ul v-if="publico.idades.informaram" class="mt-4 space-y-3">
              <li v-for="f in publico.idades.faixas" :key="f.faixa">
                <div class="flex items-baseline justify-between text-sm">
                  <span class="text-tinta-corpo">{{ f.faixa }}</span>
                  <span class="tabular-nums text-tinta-suave">{{ num(f.pessoas) }} · {{ fmtPct(pct(f.pessoas, publico.idades.informaram)) }}</span>
                </div>
                <div class="mt-1.5 h-2 overflow-hidden rounded-full bg-ink-100">
                  <div class="h-full rounded-full bg-grape-600" :style="{ width: `${larguraDaBarra(f.pessoas, maxFaixa)}%` }" />
                </div>
              </li>
            </ul>
            <p v-else class="py-6 text-center text-sm text-tinta-suave">Ninguém informou a data de nascimento ainda.</p>
          </section>

          <section v-if="publico.cidades" class="card" data-parte="cidades">
            <h2 class="titulo-bloco">Cidade do cadastro</h2>
            <p class="apoio-bloco">
              {{ num(publico.cidades.informaram) }} de {{ num(publico.pessoas.compradores) }} compradores informaram o endereço
            </p>
            <ul v-if="publico.cidades.informaram" class="mt-4 space-y-3">
              <li v-for="c in publico.cidades.top" :key="`${c.cidade}-${c.uf}`">
                <div class="flex items-baseline justify-between text-sm">
                  <span class="text-tinta-corpo">{{ c.cidade }}<template v-if="c.uf"> · {{ c.uf }}</template></span>
                  <span class="tabular-nums text-tinta-suave">{{ num(c.pessoas) }}</span>
                </div>
                <div class="mt-1.5 h-2 overflow-hidden rounded-full bg-ink-100">
                  <div class="h-full rounded-full bg-sun-500" :style="{ width: `${larguraDaBarra(c.pessoas, maxCidade)}%` }" />
                </div>
              </li>
            </ul>
            <p v-else class="py-6 text-center text-sm text-tinta-suave">Ninguém informou o endereço ainda.</p>
          </section>
        </div>

        <section class="card mt-4">
          <h2 class="titulo-bloco">A que horas compram</h2>
          <p class="apoio-bloco">Hora do evento, por pedido pago. É a janela em que o anúncio encontra a pessoa decidindo.</p>
          <div class="mt-5 flex h-32 items-end gap-1">
            <div v-for="h in horasDaCompra" :key="h.hora" class="flex h-full flex-1 items-end"
                 :title="`${h.hora}h — ${h.pedidos} ${h.pedidos === 1 ? 'pedido' : 'pedidos'}`">
              <div class="w-full rounded-t-sm" :class="h.pedidos ? 'bg-acao' : 'bg-ink-100'"
                   :style="{ height: h.pedidos ? `${Math.max(h.altura, 6)}%` : '3px' }" />
            </div>
          </div>
          <div class="mt-2 flex justify-between text-[11px] tabular-nums text-tinta-suave">
            <span>00h</span><span>06h</span><span>12h</span><span>18h</span><span>23h</span>
          </div>
        </section>

        <section class="card mt-4 overflow-hidden p-0">
          <header class="border-b border-linha p-4">
            <h2 class="titulo-bloco">Quem mais comprou</h2>
          </header>
          <div class="overflow-x-auto">
            <table class="w-full min-w-[480px] text-sm">
              <thead class="bg-fundo-cinza text-left text-xs uppercase text-tinta-suave">
                <tr>
                  <th class="px-4 py-2 font-semibold">Pessoa</th>
                  <th class="px-4 py-2 text-right font-semibold">Ingressos</th>
                  <th class="px-4 py-2 text-right font-semibold">Pedidos</th>
                  <th class="px-4 py-2 text-right font-semibold">Gasto</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(c, i) in publico.topCompradores" :key="i" class="border-t border-linha">
                  <td class="px-4 py-2.5">
                    <p class="text-tinta-corpo">{{ c.nome }}</p>
                    <p class="text-xs text-tinta-suave">{{ c.email }}</p>
                  </td>
                  <td class="px-4 py-2.5 text-right tabular-nums">{{ num(c.ingressos) }}</td>
                  <td class="px-4 py-2.5 text-right tabular-nums text-tinta-suave">{{ num(c.pedidos) }}</td>
                  <td class="px-4 py-2.5 text-right font-medium tabular-nums">{{ reais(c.gastoCents) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <!-- O que a casa NÃO pergunta (ADM-32): só o que de fato não é coletado. Inventar esse
             número é pior que não ter — alguém compra mídia nele. -->
        <p v-if="publico.naoColetado?.length" class="mt-4 text-xs text-tinta-suave" data-parte="nao-coletado">
          Não dá pra mostrar {{ publico.naoColetado.join(', ') }}: o checkout não pergunta.
        </p>
      </template>
    </template>
  </div>
</template>
