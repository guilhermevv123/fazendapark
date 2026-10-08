<script setup lang="ts">
/**
 * Visão geral — as vendas de todos os eventos do parque, e quem compra.
 *
 * O relatório de dentro do evento responde "como ESTA edição vendeu". Esta tela responde a
 * pergunta de cima: quanto o parque vendeu no período, por onde, e quem compra. Filtrando por um
 * evento ela mostra o MESMO número do relatório dele (`relatorios-organizacao.test.ts` trava) — não
 * é outra conta, é a mesma somada.
 *
 * ## O redesenho de 27/09 (auditoria do painel da organização, propostas 1–10)
 *
 * O dono olhando no celular: "muito vazio, pouca cor, coisas muito pequenas". A tela passa a abrir
 * no que ele quer saber primeiro — o LÍQUIDO, em destaque, com a conta que fecha embaixo (REL-02) —,
 * depois os três números de apoio com a variação contra o período anterior de mesmo tamanho, e só
 * então as quebras. Cada indicador tem UM tom da marca (`<PainelKpi>`); os números são os que a rota
 * já devolvia (mesmas réguas de `liquido.ts`): o redesenho não inventa conta.
 *
 * ## O recorte mora na URL, e a TELA lê a URL (REL-07)
 *
 * Antes os filtros eram `ref` preenchidos uma vez, na montagem: clicar em "Visão geral" no menu com
 * um filtro ativo limpava a URL e deixava a tela filtrada (e o F5 mudava os números). Agora o
 * recorte é um `computed` da própria rota — URL e tela são a mesma coisa, sempre. O período vai
 * como CHAVE (`?periodo=7d`) e quem diz que dia é hoje é o servidor, no calendário do parque.
 * Sem nada na URL, abre em "30 dias" (proposta 10: "Tudo" como padrão abria a vida inteira).
 */
import { baixarCsv } from '~/composables/baixarCsv'
import { useConsultaNaUrl } from '~/composables/consultaNaUrl'
import { centavosParaPlanilha } from '~/composables/painelPlanilha'
import { ehPapel, podeAbrirPagina, type Papel } from '~~/server/utils/papeis'
import {
  ehChavePeriodo, problemaNoPeriodo, rotuloDoPeriodo, type ChavePeriodo,
} from '~/composables/painelPeriodo'
import { escolherPasso, serieContinua, variacao, detalheDoPonto, type Passo } from '~/composables/painelGrafico'
import PainelKpi from '~/components/painel/Kpi.vue'
import PainelGraficoBarras from '~/components/painel/GraficoBarras.vue'
import PainelPeriodo from '~/components/painel/Periodo.vue'
import PainelVazio from '~/components/painel/Vazio.vue'
import PainelFalha from '~/components/painel/Falha.vue'
import PainelBarraEmpilhada from '~/components/painel/BarraEmpilhada.vue'
import PainelEsqueleto from '~/components/painel/Esqueleto.vue'

definePageMeta({ layout: 'admin' })

// a URL é a fonte do recorte; `atual` é a última pedida enquanto a navegação anda (consultaNaUrl.ts)
const consulta = useConsultaNaUrl()
const PADRAO: ChavePeriodo = '30d'

/* ------------------------------------------------------------- o recorte */

const texto = (v: unknown) => (typeof v === 'string' && v ? v : null)

/**
 * O recorte que a URL pede. Data à mão só vale inteira e em ordem: a data errada é barrada no
 * próprio filtro (`<PainelPeriodo>`, REL-10) e nunca chega aqui — a não ser que alguém edite a URL
 * na mão, e aí vale o padrão, em vez de uma tela inteira de erro.
 */
const filtro = computed(() => {
  const q = consulta.atual.value
  const de0 = texto(q.de)
  const ate0 = texto(q.ate)
  const aMao = !!(de0 || ate0) && !problemaNoPeriodo(de0, ate0)
  return {
    evento: texto(q.evento),
    de: aMao ? de0 : null,
    ate: aMao ? ate0 : null,
    periodo: aMao ? null : (ehChavePeriodo(q.periodo) ? q.periodo : PADRAO) as ChavePeriodo | null,
  }
})

const params = computed(() => {
  const f = filtro.value
  const p: Record<string, string> = {}
  if (f.evento) p.evento = f.evento
  if (f.periodo) p.periodo = f.periodo
  if (f.de) p.de = f.de
  if (f.ate) p.ate = f.ate
  return p
})

const { data, pending, error: falha, refresh } = await useFetch<any>('/api/admin/relatorios', { query: params })
// a lista completa pro filtro: `porEvento` do relatório encolhe quando já há um filtrado
const { data: eventos } = await useFetch<any[]>('/api/admin/eventos')
// Mesma `key` do layout: o Nuxt reaproveita a resposta de quem está logado.
const { data: eu } = await useFetch<any>('/api/auth/eu', { key: 'auth-eu' })
const papel = computed<Papel | null>(() => {
  const p = eu.value?.usuario?.papel
  return ehPapel(p) ? p : null
})
/** REL-04: "Ver os clientes" era porta fechada pro financeiro (Clientes é do master) */
const abreClientes = computed(() => !!papel.value && podeAbrirPagina(papel.value, '/admin/clientes'))

/** Troca o recorte ESCREVENDO NA URL — a tela vem atrás, pelo `computed` acima. */
function irPara(mudanca: Partial<{ evento: string | null; periodo: string | null; de: string | null; ate: string | null }>) {
  const f = { ...filtro.value, ...mudanca }
  const query: Record<string, string> = {}
  if (f.evento) query.evento = f.evento
  if (f.de || f.ate) {
    if (f.de) query.de = f.de
    if (f.ate) query.ate = f.ate
  } else if (f.periodo && f.periodo !== PADRAO) {
    query.periodo = f.periodo
  }
  // `replace`: mexer no filtro não empilha histórico — o Voltar sai da tela (matriz, caso 141)
  return consulta.escrever(query)
}
const escolherPeriodo = (chave: string) => irPara({ periodo: chave, de: null, ate: null })
const escolherDatas = (p: { de: string | null; ate: string | null }) => irPara({ periodo: null, de: p.de, ate: p.ate })
const escolherEvento = (id: string) => irPara({ evento: id || null })

const temFiltro = computed(() => !!filtro.value.evento || filtro.value.periodo !== PADRAO)
function limpar() { return consulta.escrever({}) }

/** o período que o SERVIDOR resolveu (é o que os números cobrem) */
const resolvido = computed(() => ({ de: data.value?.filtro?.de ?? null, ate: data.value?.filtro?.ate ?? null }))
const nomeDoRecorte = computed(() => rotuloDoPeriodo(resolvido.value.de, resolvido.value.ate))
/** "Nada pago de 29/08 a 27/09/2026 neste evento." — o vazio diz QUAL recorte está vazio */
const fraseDoVazio = computed(() => {
  const { de, ate } = resolvido.value
  const quando = !de && !ate ? 'até agora'
    : de && ate && de === ate ? `em ${nomeDoRecorte.value}`
      : de && ate ? `de ${nomeDoRecorte.value}` : nomeDoRecorte.value
  return `Nada pago ${quando}${filtro.value.evento ? ' neste evento' : ''}.`
})

/* ------------------------------------------------------ como cada coisa lê */

const ROTULO_FORMA: Record<string, string> = {
  pix: 'PIX', credito: 'Cartão de crédito', debito: 'Cartão de débito',
  dinheiro: 'Dinheiro', cortesia: 'Cortesia',
}
const ROTULO_CANAL: Record<string, string> = {
  online: 'Site', bilheteria: 'Bilheteria', pdv_produtor: 'Ponto de venda próprio',
  pdv_ticketeira: 'Ponto de venda parceiro', cortesia: 'Cortesia',
}
/** as cores dos canais na barra empilhada (hex: a largura é dinâmica) */
const COR_CANAL: Record<string, string> = {
  online: '#1789a1', // pool-600
  bilheteria: '#7a56ab', // grape-500
  pdv_produtor: '#f29b0c', // sun-500
  pdv_ticketeira: '#7b921b', // citrus-600
}
const ROTULO_SITUACAO: Record<string, string> = {
  ativo: 'Publicado', rascunho: 'Rascunho', encerrado: 'Encerrado', cancelado: 'Cancelado',
  adiado: 'Adiado', oculto: 'Oculto',
}
// mesmo dicionário de `clientes.vue` e do relatório do evento — status de
// pedido é um vocabulário só, não um por tela
const ROTULO_STATUS: Record<string, string> = {
  pago: 'Pago', aguardando_pagamento: 'Aguardando pagamento', em_analise: 'Em análise',
  expirado: 'Expirou sem pagar', cancelado: 'Cancelado', falhou: 'Pagamento falhou',
  estornado: 'Estornado', estornado_parcial: 'Estornado em parte',
  chargeback: 'Chargeback', disputa: 'Em disputa',
}

const n = (v: number | null | undefined) => Number(v ?? 0).toLocaleString('pt-BR')
const pct = (parte: number, todo: number) => (todo > 0 ? Math.round((parte / todo) * 100) : 0)
const pico = (lista: any[] | undefined, campo: string) =>
  (lista ?? []).reduce((m: number, x: any) => Math.max(m, Number(x[campo] ?? 0)), 0)
const largura = (v: number, max: number) => `${max ? Math.max((v / max) * 100, v > 0 ? 3 : 0) : 0}%`

/* ------------------------------------------------------------ os números */

const r = computed(() => data.value?.resumo ?? {})
const antes = computed(() => data.value?.anterior?.resumo ?? null)
const contra = computed(() => {
  const a = data.value?.anterior
  return a ? rotuloDoPeriodo(a.de, a.ate) : ''
})
/** a variação só existe com base: sem período anterior (Tudo, "desde"), nenhum selo */
const varDe = (campo: string) => (antes.value ? variacao(Number(r.value[campo] ?? 0), Number(antes.value[campo] ?? 0)) : null)

const ingressosVenda = computed(() => Number(r.value.ingressosVenda ?? r.value.ingressos ?? 0))
const pedidosVenda = computed(() => Number(r.value.pedidosVenda ?? r.value.pedidos ?? 0))
const ticketVenda = computed(() => Number(r.value.ticketMedioVendaCents ?? r.value.ticketMedioPorPedidoCents ?? 0))

/* ------------------------------------------------------------- Cobrança */

/**
 * O funil (proposta 7): todo pedido criado no período cai em UM ramo — os ramos somam os criados.
 * "Pagos" são os que seguem valendo (pago e estornado em parte: a MESMA régua do resumo).
 */
const RAMOS = [
  { chave: 'pagos', rotulo: 'Pagos', status: ['pago', 'estornado_parcial'], cor: 'bg-success-600', texto: 'text-success-800' },
  { chave: 'aguardando', rotulo: 'Aguardando', status: ['aguardando_pagamento', 'em_analise'], cor: 'bg-sun-400', texto: 'text-sun-800' },
  { chave: 'nao', rotulo: 'Não concluíram', status: ['expirado', 'cancelado', 'falhou'], cor: 'bg-ink-300', texto: 'text-ink-700' },
  { chave: 'devolvidos', rotulo: 'Devolvidos', status: ['estornado', 'chargeback', 'disputa'], cor: 'bg-danger-600', texto: 'text-danger-700' },
] as const
const cobranca = computed(() => {
  const lista: any[] = data.value?.cobranca?.porStatus ?? []
  const criados = Number(data.value?.cobranca?.criados ?? 0)
  const ramos = RAMOS.map((ramo) => {
    const itens = lista.filter((s) => (ramo.status as readonly string[]).includes(s.status))
    return {
      ...ramo, itens,
      pedidos: itens.reduce((s, x) => s + Number(x.pedidos), 0),
      cobradoCents: itens.reduce((s, x) => s + Number(x.cobradoCents), 0),
    }
  })
  // status que um dia apareça sem ramo não pode sumir da conta: entra em "Não concluíram"
  const conhecidos = new Set<string>(RAMOS.flatMap((x) => [...x.status]))
  const soltos = lista.filter((s) => !conhecidos.has(s.status))
  if (soltos.length) {
    const nao = ramos.find((x) => x.chave === 'nao')!
    nao.itens = [...nao.itens, ...soltos]
    nao.pedidos += soltos.reduce((s, x) => s + Number(x.pedidos), 0)
    nao.cobradoCents += soltos.reduce((s, x) => s + Number(x.cobradoCents), 0)
  }
  const pagos = ramos[0]!.pedidos
  return { criados, ramos, pagos, conversao: pct(pagos, criados), aguardando: ramos[1]! }
})

/* ------------------------------------------------------------ o gráfico */

const campoGrafico = ref<'cobradoCents' | 'liquidoCents'>('cobradoCents')
const faixaDoGrafico = computed(() => {
  const f = data.value?.filtro ?? {}
  const dias: any[] = data.value?.porDia ?? []
  const de = f.de ?? f.primeiroDia ?? dias[0]?.dia ?? null
  const ate = f.ate ?? f.hoje ?? dias[dias.length - 1]?.dia ?? null
  return de && ate && de <= ate ? { de: String(de).slice(0, 10), ate: String(ate).slice(0, 10) } : null
})
const passo = computed<Passo>(() => (faixaDoGrafico.value ? escolherPasso(faixaDoGrafico.value.de, faixaDoGrafico.value.ate) : 'dia'))
const CAMPOS = ['cobradoCents', 'liquidoCents', 'pedidos']
const serie = computed(() => {
  const fx = faixaDoGrafico.value
  return fx ? serieContinua(data.value?.porDia ?? [], fx.de, fx.ate, passo.value, CAMPOS) : []
})
const serieAntes = computed(() => {
  const a = data.value?.anterior
  return a?.de && a?.ate ? serieContinua(a.porDia ?? [], a.de, a.ate, passo.value, CAMPOS) : null
})
const pontos = computed(() => serie.value.map((p, i) => ({
  chave: p.chave,
  valor: Number(p[campoGrafico.value]),
  anterior: serieAntes.value ? Number(serieAntes.value[i]?.[campoGrafico.value] ?? 0) : null,
  extra: `${n(Number(p.pedidos))} ${Number(p.pedidos) === 1 ? 'pedido' : 'pedidos'}`,
})))
const tituloDoGrafico = computed(() => ({ dia: 'Vendas por dia', semana: 'Vendas por semana', mes: 'Vendas por mês' })[passo.value])
const maiorPonto = computed(() => pontos.value.reduce<null | { chave: string; valor: number }>(
  (m, p) => (p.valor > (m?.valor ?? 0) ? p : m), null))

/* --------------------------------------------------------------- canal */

const canaisDeVenda = computed(() => (data.value?.porCanal ?? []).filter((c: any) => c.canal !== 'cortesia'))
const canalCortesia = computed(() => (data.value?.porCanal ?? []).find((c: any) => c.canal === 'cortesia') ?? null)
const partesDoCanal = computed(() => canaisDeVenda.value.map((c: any) => ({
  rotulo: ROTULO_CANAL[c.canal] ?? c.canal,
  valor: Number(c.cobradoCents),
  cor: COR_CANAL[c.canal] ?? '#a09cb2',
  texto: reais(c.cobradoCents),
  dica: `${n(c.pedidos)} ${c.pedidos === 1 ? 'pedido' : 'pedidos'}${c.ingressos !== undefined ? ` · ${n(c.ingressos)} ingressos` : ''}`,
})))

/* ------------------------------------------------------------ planilhas */

/**
 * REL-11: a planilha era UMA tabela com três misturadas e dinheiro como texto ("R$ 1.234,56"), que
 * o Excel não soma. Agora cada tabela é um arquivo, e dinheiro sai como NÚMERO no formato que o
 * Excel brasileiro lê (`1234,56`, sem milhar e sem `R$`) — a coluna diz que é em reais.
 */
const numeroCsv = centavosParaPlanilha
const exportarAberto = ref(false)
const sufixo = computed(() => {
  const f = data.value?.filtro ?? {}
  return f.de || f.ate ? `${f.de ?? 'inicio'}-a-${f.ate ?? 'hoje'}` : 'todo-o-periodo'
})

const PLANILHAS = computed(() => {
  const d = data.value
  if (!d) return []
  const lista: { nome: string; arquivo: string; cab: string[]; linhas: (string | number)[][] }[] = [
    {
      nome: 'Resumo', arquivo: 'resumo', cab: ['Indicador', 'Valor'],
      linhas: [
        ['Período', nomeDoRecorte.value],
        ['Total cobrado (R$)', numeroCsv(r.value.cobradoCents)],
        ['Ingressos, pelo valor de face (R$)', numeroCsv(r.value.faceCents)],
        ['Descontos (R$)', numeroCsv(r.value.descontoCents)],
        ['Taxa cobrada do comprador (R$)', numeroCsv(r.value.taxaCents)],
        ['Taxa da plataforma (R$)', numeroCsv(r.value.taxaPlataformaCents)],
        ['Devolvido em pedidos que seguem valendo (R$)', numeroCsv(r.value.estornadoNoLiquidoCents)],
        ['Líquido do produtor (R$)', numeroCsv(r.value.liquidoCents)],
        ['Pedidos pagos', Number(r.value.pedidos ?? 0)],
        ['Ingressos', Number(r.value.ingressos ?? 0)],
        ['Pedidos de venda (sem cortesia)', pedidosVenda.value],
        ['Ingressos vendidos (sem cortesia)', ingressosVenda.value],
        ['Cortesias emitidas (ingressos)', Number(r.value.ingressosCortesia ?? 0)],
        ['Ticket médio por venda (R$)', numeroCsv(ticketVenda.value)],
        ['Clientes', Number(r.value.clientes ?? 0)],
        ['Devolvido ao comprador, todo status (R$)', numeroCsv(r.value.devolvidoTotalCents)],
      ],
    },
    {
      nome: 'Vendas por dia', arquivo: 'por-dia', cab: ['Dia', 'Pedidos', 'Cobrado (R$)', 'Líquido (R$)'],
      linhas: (faixaDoGrafico.value
        ? serieContinua(d.porDia ?? [], faixaDoGrafico.value.de, faixaDoGrafico.value.ate, 'dia', CAMPOS)
        : []).map((p) => [dataCurta(p.chave), Number(p.pedidos), numeroCsv(Number(p.cobradoCents)), numeroCsv(Number(p.liquidoCents))]),
    },
    {
      nome: 'Por evento', arquivo: 'por-evento', cab: ['Evento', 'Data', 'Situação', 'Pedidos', 'Ingressos', 'Cobrado (R$)', 'Líquido (R$)'],
      linhas: (d.porEvento ?? []).map((e: any) => [e.nome, dataCurta(e.comeca), ROTULO_SITUACAO[e.situacao] ?? e.situacao,
        e.pedidos, e.ingressos, numeroCsv(e.cobradoCents), numeroCsv(e.liquidoCents)]),
    },
    {
      nome: 'Por tipo de ingresso', arquivo: 'por-tipo', cab: ['Tipo', 'Ingressos', 'Valor pelo preço do ingresso (R$)'],
      linhas: (d.porTipo ?? []).map((t: any) => [t.tipo, t.ingressos, numeroCsv(t.valorCents)]),
    },
    {
      nome: 'Onde a venda aconteceu', arquivo: 'por-canal', cab: ['Canal', 'Pedidos', 'Ingressos', 'Cobrado (R$)', 'Líquido (R$)'],
      linhas: (d.porCanal ?? []).map((c: any) => [ROTULO_CANAL[c.canal] ?? c.canal, c.pedidos, c.ingressos ?? '',
        numeroCsv(c.cobradoCents), numeroCsv(c.liquidoCents)]),
    },
    {
      nome: 'Forma de pagamento', arquivo: 'por-forma', cab: ['Forma', 'Pedidos', 'Cobrado (R$)', 'Líquido (R$)'],
      linhas: (d.porForma ?? []).map((f: any) => [ROTULO_FORMA[f.forma] ?? 'Não informada', f.pedidos,
        numeroCsv(f.cobradoCents), numeroCsv(f.liquidoCents)]),
    },
    {
      nome: 'Cobrança', arquivo: 'cobranca', cab: ['Situação', 'Pedidos', 'Valor (R$)'],
      linhas: (d.cobranca?.porStatus ?? []).map((s: any) => [ROTULO_STATUS[s.status] ?? s.status, s.pedidos, numeroCsv(s.cobradoCents)]),
    },
    {
      nome: 'Quem mais comprou', arquivo: 'quem-mais-comprou', cab: ['Cliente', 'E-mail', 'Pedidos', 'Ingressos', 'Pagou (R$)'],
      linhas: (d.topCompradores ?? []).map((c: any) => [c.nome, c.email ?? '', c.pedidos, c.ingressos, numeroCsv(c.gastoCents)]),
    },
  ]
  return lista
})
function exportar(p: { arquivo: string; cab: string[]; linhas: (string | number)[][] }) {
  exportarAberto.value = false
  baixarCsv(`visao-geral-${p.arquivo}-${sufixo.value}`, p.cab, p.linhas)
}

useHead({ title: 'Visão geral' })
</script>

<template>
  <div class="pb-10">
    <!-- ================================================================ topo -->
    <div class="flex flex-wrap items-start justify-between gap-3 py-5">
      <div class="min-w-0">
        <h1 class="titulo text-2xl font-semibold text-ink-900 sm:text-[28px]">Visão geral</h1>
        <p class="mt-1 text-[15px] text-ink-700">As vendas de todos os eventos do parque, e quem compra.</p>
      </div>
      <div class="relative">
        <button type="button" class="btn-secundario min-h-[40px]" :disabled="!data" :aria-expanded="exportarAberto"
                data-acao="exportar" @click="exportarAberto = !exportarAberto">
          <IconeMenu nome="exportar" :tamanho="18" /> Exportar planilhas
          <IconeMenu nome="baixo" :tamanho="14" />
        </button>
        <div v-if="exportarAberto" class="absolute right-0 z-20 mt-2 w-72 rounded-2xl bg-white p-2 shadow-pop ring-1 ring-ink-200"
             data-parte="menu-exportar">
          <p class="px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-ink-600">Um arquivo por tabela</p>
          <button v-for="p in PLANILHAS" :key="p.arquivo" type="button"
                  class="flex min-h-[40px] w-full items-center justify-between gap-3 rounded-xl px-3 text-left text-sm font-medium text-ink-900 hover:bg-pool-50"
                  :data-planilha="p.arquivo" @click="exportar(p)">
            {{ p.nome }} <span class="text-xs font-normal text-ink-600">{{ n(p.linhas.length) }} linhas</span>
          </button>
        </div>
      </div>
    </div>

    <!-- ============================================================ recorte -->
    <div class="card grid gap-4">
      <div class="flex flex-wrap items-end gap-3">
        <label class="block min-w-0 flex-1 sm:flex-none">
          <span class="rotulo">Evento</span>
          <select class="campo w-full sm:w-72" :value="filtro.evento ?? ''" data-parte="filtro-evento"
                  @change="escolherEvento(($event.target as HTMLSelectElement).value)">
            <option value="">Todos os eventos</option>
            <option v-for="e in eventos ?? []" :key="e.id" :value="e.id">{{ e.nome }}</option>
          </select>
        </label>
        <button v-if="temFiltro" type="button" class="btn-secundario min-h-[40px]" data-acao="limpar-filtros" @click="limpar">
          Limpar filtros
        </button>
      </div>
      <PainelPeriodo :periodo="filtro.periodo" :de="resolvido.de" :ate="resolvido.ate" :carregando="pending"
                     @escolher="escolherPeriodo" @datas="escolherDatas" />
    </div>

    <!-- ========================================================== estados -->
    <PainelEsqueleto v-if="pending" class="mt-4" />

    <PainelFalha v-else-if="falha" :falha="falha" o-que="a visão geral" :tentar="refresh" />

    <template v-else-if="data">
      <PainelVazio v-if="!r.pedidos" class="mt-4" icone="relatorio" titulo="Nenhuma venda paga nesse recorte."
                   :texto="fraseDoVazio">
        <button v-if="filtro.periodo !== 'tudo'" type="button" class="btn-primario min-h-[40px]" data-acao="ver-tudo"
                @click="escolherPeriodo('tudo')">
          Ver todo o período
        </button>
        <button v-if="filtro.evento" type="button" class="btn-secundario min-h-[40px]" @click="escolherEvento('')">
          Ver todos os eventos
        </button>
        <a v-if="cobranca.aguardando.pedidos" href="#cobranca"
           class="btn-secundario min-h-[40px] border-sun-300 bg-sun-50 text-sun-800" data-parte="aguardando-no-vazio">
          {{ n(cobranca.aguardando.pedidos) }} {{ cobranca.aguardando.pedidos === 1 ? 'pedido esperando' : 'pedidos esperando' }} pagamento
        </a>
      </PainelVazio>

      <template v-else>
        <!-- ------------------------------------------------ os 4 números -->
        <div class="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <PainelKpi rotulo="Líquido do produtor" :valor="reais(r.liquidoCents)" tom="grape" icone="carteira" destaque
                     :variacao="varDe('liquidoCents')" :contra="contra" data-kpi="liquido">
            <!-- REL-02: a conta que fecha, com os nomes que o Financeiro usa -->
            <dl class="grid gap-0.5 tabular-nums" data-parte="conta-do-liquido">
              <div class="flex justify-between gap-3"><dt>cobrado</dt><dd>{{ reais(r.cobradoCents) }}</dd></div>
              <div class="flex justify-between gap-3"><dt>− taxa da plataforma</dt><dd>{{ reais(r.taxaPlataformaCents ?? 0) }}</dd></div>
              <div v-if="r.estornadoNoLiquidoCents" class="flex justify-between gap-3">
                <dt>− devolvido em parte</dt><dd>{{ reais(r.estornadoNoLiquidoCents) }}</dd>
              </div>
            </dl>
          </PainelKpi>

          <PainelKpi rotulo="Total cobrado" :valor="reais(r.cobradoCents)" tom="pool" icone="vendas"
                     :variacao="varDe('cobradoCents')" :contra="contra" data-kpi="cobrado">
            <span data-parte="conta-do-cobrado">
              ingressos {{ reais(r.faceCents) }}<template v-if="r.descontoCents"> − descontos {{ reais(r.descontoCents) }}</template>
              + taxa {{ reais(r.taxaCents) }}
            </span>
          </PainelKpi>

          <PainelKpi rotulo="Ingressos vendidos" :valor="n(ingressosVenda)" tom="sun" icone="ingresso"
                     :variacao="varDe('ingressosVenda')" :contra="contra" data-kpi="ingressos">
            em {{ n(pedidosVenda) }} {{ pedidosVenda === 1 ? 'venda' : 'vendas' }}<template v-if="r.ingressosCortesia">
              · cortesias à parte</template>
          </PainelKpi>

          <PainelKpi rotulo="Ticket médio" :valor="reais(ticketVenda)" tom="pool" icone="etiqueta"
                     :variacao="varDe('ticketMedioVendaCents')" :contra="contra" data-kpi="ticket">
            por venda, sem cortesia · {{ reais(r.ticketMedioPorIngressoCents ?? 0) }} por ingresso
          </PainelKpi>
        </div>

        <!-- ------------------------------------ faixa secundária (menor) -->
        <div class="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4" data-parte="faixa-secundaria">
          <div class="flex flex-col gap-2 rounded-2xl bg-white p-4 ring-1 ring-ink-200/70 sm:flex-row sm:items-start sm:gap-3">
            <span class="grid size-9 shrink-0 place-items-center rounded-xl bg-sun-100 text-sun-800"><IconeMenu nome="etiqueta" :tamanho="18" /></span>
            <div class="min-w-0">
              <p class="text-[13px] font-semibold text-ink-700">Descontos</p>
              <p class="titulo text-lg font-semibold tabular-nums text-ink-900">{{ reais(r.descontoCents ?? 0) }}</p>
              <p class="text-xs text-ink-600">em cupons</p>
            </div>
          </div>
          <div class="flex flex-col gap-2 rounded-2xl bg-white p-4 ring-1 ring-ink-200/70 sm:flex-row sm:items-start sm:gap-3">
            <span class="grid size-9 shrink-0 place-items-center rounded-xl bg-danger-100 text-danger-700"><IconeMenu nome="voltar" :tamanho="18" /></span>
            <div class="min-w-0">
              <p class="text-[13px] font-semibold text-ink-700">Devolvido</p>
              <p class="titulo text-lg font-semibold tabular-nums text-danger-700" data-parte="devolvido">{{ reais(r.devolvidoTotalCents ?? r.estornadoNoLiquidoCents ?? 0) }}</p>
              <p class="text-xs text-ink-600">ao comprador, inclusive estorno total</p>
            </div>
          </div>
          <div class="flex flex-col gap-2 rounded-2xl bg-white p-4 ring-1 ring-ink-200/70 sm:flex-row sm:items-start sm:gap-3">
            <span class="grid size-9 shrink-0 place-items-center rounded-xl bg-citrus-100 text-citrus-700"><IconeMenu nome="presente" :tamanho="18" /></span>
            <div class="min-w-0">
              <p class="text-[13px] font-semibold text-ink-700">Cortesias</p>
              <p class="titulo text-lg font-semibold tabular-nums text-ink-900" data-parte="cortesias">{{ n(r.ingressosCortesia ?? 0) }}</p>
              <p class="text-xs text-ink-600">ingressos, fora do ticket médio</p>
            </div>
          </div>
          <div class="flex flex-col gap-2 rounded-2xl bg-white p-4 ring-1 ring-ink-200/70 sm:flex-row sm:items-start sm:gap-3">
            <span class="grid size-9 shrink-0 place-items-center rounded-xl bg-success-100 text-success-700"><IconeMenu nome="check" :tamanho="18" /></span>
            <div class="min-w-0">
              <p class="text-[13px] font-semibold text-ink-700">Conversão</p>
              <p class="titulo text-lg font-semibold tabular-nums text-success-800" data-parte="conversao">{{ cobranca.conversao }}%</p>
              <p class="text-xs text-ink-600">{{ n(cobranca.pagos) }} de {{ n(cobranca.criados) }} pedidos criados</p>
            </div>
          </div>
        </div>

        <!-- ------------------------------------------------------ gráfico -->
        <section v-if="pontos.length" class="card mt-4" aria-labelledby="titulo-grafico">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 id="titulo-grafico" class="titulo text-lg font-semibold text-ink-900">{{ tituloDoGrafico }}</h2>
              <p v-if="maiorPonto" class="text-sm text-ink-700">
                melhor {{ passo === 'dia' ? 'dia' : passo === 'semana' ? 'semana' : 'mês' }}: {{ detalheDoPonto(maiorPonto.chave, passo) }},
                <strong class="tabular-nums text-ink-900">{{ reais(maiorPonto.valor) }}</strong>
              </p>
            </div>
            <div class="flex gap-2" role="group" aria-label="O que o gráfico mostra">
              <button type="button" class="min-h-[40px] sm:min-h-0" :class="campoGrafico === 'cobradoCents' ? 'chip-ativo' : 'chip'"
                      :aria-pressed="campoGrafico === 'cobradoCents'" @click="campoGrafico = 'cobradoCents'">Cobrado</button>
              <button type="button" class="min-h-[40px] sm:min-h-0" :class="campoGrafico === 'liquidoCents' ? 'chip-ativo' : 'chip'"
                      :aria-pressed="campoGrafico === 'liquidoCents'" @click="campoGrafico = 'liquidoCents'">Líquido</button>
            </div>
          </div>
          <div class="mt-5">
            <PainelGraficoBarras :pontos="pontos" :passo="passo" :formatar="reais"
                                 :cor="campoGrafico === 'liquidoCents' ? '#583c8d' : '#1789a1'"
                                 :rotulo-acessivel="`${tituloDoGrafico}, ${nomeDoRecorte}`"
                                 :nome-anterior="contra ? `período anterior (${contra})` : 'período anterior'" />
          </div>
        </section>

        <!-- ------------------------------------------ canal e tipo de ingresso -->
        <div class="mt-4 grid gap-4 lg:grid-cols-2">
          <section class="card" aria-labelledby="titulo-canal">
            <h2 id="titulo-canal" class="titulo text-lg font-semibold text-ink-900">Onde a venda aconteceu</h2>
            <p class="mb-4 text-sm text-ink-700">Pelo valor cobrado. Cortesia não é venda e fica à parte.</p>
            <PainelBarraEmpilhada v-if="partesDoCanal.length" :partes="partesDoCanal" rotulo-acessivel="Venda por canal" />
            <p v-else class="text-sm text-ink-700">Só cortesias nesse recorte.</p>
            <p v-if="canalCortesia" class="mt-4 flex items-center gap-2 rounded-xl bg-citrus-50 px-3 py-2 text-sm text-ink-800" data-parte="canal-cortesia">
              <IconeMenu nome="presente" :tamanho="16" class="text-citrus-700" />
              {{ n(canalCortesia.ingressos ?? 0) }} {{ canalCortesia.ingressos === 1 ? 'cortesia emitida' : 'cortesias emitidas' }}
              em {{ n(canalCortesia.pedidos) }} {{ canalCortesia.pedidos === 1 ? 'emissão' : 'emissões' }} — R$ 0,00, não entra no cobrado
            </p>
          </section>

          <section class="card" aria-labelledby="titulo-tipo">
            <h2 id="titulo-tipo" class="titulo text-lg font-semibold text-ink-900">Por tipo de ingresso</h2>
            <p class="mb-3 text-sm text-ink-700">Pelo preço de cada ingresso na compra, antes de cupom e devolução.</p>
            <p v-if="!(data.porTipo ?? []).length" class="text-sm text-ink-700">Nenhum ingresso vendido nesse recorte.</p>
            <div v-else class="relative overflow-x-auto">
              <table class="w-full text-sm">
                <thead>
                  <tr class="border-b border-ink-200 text-left text-xs font-semibold uppercase tracking-wide text-ink-600">
                    <th class="py-2 font-semibold">Tipo</th><th class="hidden w-24 py-2 sm:table-cell" /><th class="py-2 text-right font-semibold">Ingressos</th>
                    <th class="py-2 pl-3 text-right font-semibold">Valor</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="t in data.porTipo" :key="t.tipo" class="border-b border-ink-100 last:border-0" data-parte="linha-tipo">
                    <td class="py-2.5 font-medium text-ink-900">{{ t.tipo }}</td>
                    <td class="hidden w-24 py-2.5 pl-2 sm:table-cell">
                      <div class="h-2 rounded-full bg-ink-100"><div class="h-2 rounded-full bg-sun-400" :style="{ width: largura(t.ingressos, pico(data.porTipo, 'ingressos')) }" /></div>
                    </td>
                    <td class="py-2.5 text-right tabular-nums text-ink-800">{{ n(t.ingressos) }}</td>
                    <td class="py-2.5 pl-3 text-right font-medium tabular-nums text-ink-900">{{ reais(t.valorCents) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>
        </div>

        <!-- ---------------------------------------------------- por evento -->
        <section class="card mt-4 p-0" aria-labelledby="titulo-evento">
          <h2 id="titulo-evento" class="titulo border-b border-ink-200 px-4 py-3 text-lg font-semibold text-ink-900 sm:px-5">Por evento</h2>
          <div class="relative overflow-x-auto">
            <table class="tabela-cartoes w-full text-sm sm:min-w-[36rem]">
              <thead>
                <tr class="border-b border-ink-200 text-left text-xs font-semibold uppercase tracking-wide text-ink-600">
                  <th class="px-4 py-2 font-semibold sm:px-5">Evento</th>
                  <th class="hidden px-3 py-2 text-right font-semibold sm:table-cell">Ingressos</th>
                  <th class="hidden px-3 py-2 text-right font-semibold sm:table-cell">Pedidos</th>
                  <th class="hidden px-3 py-2 text-right font-semibold sm:table-cell">Cobrado</th>
                  <th class="px-4 py-2 text-right font-semibold sm:px-5">Líquido</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="e in data.porEvento" :key="e.id" class="border-b border-ink-100 last:border-0" data-parte="linha-evento">
                  <td class="px-4 py-3 sm:px-5">
                    <NuxtLink :to="`/admin/evento/${e.id}/relatorios`" class="font-medium text-ink-900 hover:text-pool-700 hover:underline">
                      {{ e.nome }}
                    </NuxtLink>
                    <p class="text-xs text-ink-600">{{ dataCurta(e.comeca) }} · {{ ROTULO_SITUACAO[e.situacao] ?? e.situacao }}</p>
                    <p class="text-xs text-ink-700 sm:hidden">{{ n(e.ingressos) }} ingressos · {{ n(e.pedidos) }} pedidos</p>
                  </td>
                  <td class="hidden px-3 py-3 text-right tabular-nums text-ink-800 sm:table-cell">{{ n(e.ingressos) }}</td>
                  <td class="hidden px-3 py-3 text-right tabular-nums text-ink-800 sm:table-cell">{{ n(e.pedidos) }}</td>
                  <td class="hidden px-3 py-3 text-right tabular-nums text-ink-900 sm:table-cell">{{ reais(e.cobradoCents) }}</td>
                  <td class="px-4 py-3 text-right font-semibold tabular-nums text-grape-800 sm:px-5">
                    {{ reais(e.liquidoCents) }}
                    <span class="block whitespace-nowrap text-xs font-normal text-ink-600 sm:hidden">cobrado {{ reais(e.cobradoCents) }}</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <!-- ------------------------------------------------ forma de pagamento -->
        <section class="card mt-4" aria-labelledby="titulo-forma">
          <h2 id="titulo-forma" class="titulo text-lg font-semibold text-ink-900">Forma de pagamento</h2>
          <div class="relative mt-3 overflow-x-auto">
            <table class="w-full text-sm">
              <thead>
                <tr class="border-b border-ink-200 text-left text-xs font-semibold uppercase tracking-wide text-ink-600">
                  <th class="py-2 font-semibold">Forma</th><th class="py-2 text-right font-semibold">Pedidos</th>
                  <th class="hidden w-32 py-2 sm:table-cell" /><th class="py-2 text-right font-semibold">Cobrado</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="f in data.porForma" :key="f.forma ?? 'sem'" class="border-b border-ink-100 last:border-0">
                  <td class="py-2.5 font-medium text-ink-900">{{ ROTULO_FORMA[f.forma] ?? 'Não informada' }}</td>
                  <td class="py-2.5 text-right tabular-nums text-ink-800">{{ n(f.pedidos) }}</td>
                  <td class="hidden w-32 py-2.5 pl-3 sm:table-cell">
                    <div class="h-2 rounded-full bg-ink-100"><div class="h-2 rounded-full bg-pool-600" :style="{ width: largura(f.cobradoCents, pico(data.porForma, 'cobradoCents')) }" /></div>
                  </td>
                  <td class="py-2.5 text-right tabular-nums text-ink-900">{{ reais(f.cobradoCents) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      </template>

      <!-- =================================================== Cobrança (funil)
           Fora do v-else de propósito: tem que aparecer mesmo sem venda paga (todo mundo com PIX
           pendente é justamente quando ela mais importa — telas.test.ts, seção 4). -->
      <section v-if="data.cobranca?.porStatus?.length" id="cobranca" class="card mt-4" aria-labelledby="titulo-cobranca">
        <div class="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="titulo-cobranca" class="titulo text-lg font-semibold text-ink-900">Cobrança</h2>
          <NuxtLink v-if="filtro.evento && cobranca.aguardando.pedidos" :to="`/admin/evento/${filtro.evento}/vendas`"
                    class="text-sm font-semibold text-pool-700 hover:underline">Ver as vendas do evento</NuxtLink>
        </div>
        <p class="text-sm text-ink-700">Todo pedido criado no período (pela data da criação), pago ou não.</p>

        <p class="mt-4 flex flex-wrap items-baseline gap-x-2 text-ink-800" data-parte="funil-topo">
          <span class="titulo text-[28px] font-semibold tabular-nums text-ink-900">{{ n(cobranca.criados) }}</span>
          {{ cobranca.criados === 1 ? 'pedido criado' : 'pedidos criados' }} →
          <span class="titulo text-[28px] font-semibold tabular-nums text-success-800">{{ n(cobranca.pagos) }}</span>
          {{ cobranca.pagos === 1 ? 'pago' : 'pagos' }}
          <span class="selo-ok">{{ cobranca.conversao }}% de conversão</span>
        </p>

        <div class="mt-3 flex h-4 w-full overflow-hidden rounded-full bg-ink-100" role="img"
             :aria-label="`Cobrança: ${cobranca.ramos.map((x) => `${x.rotulo} ${x.pedidos}`).join(', ')}`">
          <div v-for="ramo in cobranca.ramos" v-show="ramo.pedidos" :key="ramo.chave" :class="ramo.cor"
               :style="{ width: `${cobranca.criados ? (ramo.pedidos / cobranca.criados) * 100 : 0}%` }" />
        </div>

        <ul class="mt-4 grid grid-cols-2 gap-3 xl:grid-cols-4">
          <li v-for="ramo in cobranca.ramos" :key="ramo.chave" class="rounded-xl bg-ink-50 p-3" :data-ramo="ramo.chave">
            <p class="flex items-center gap-2 text-sm font-semibold text-ink-900">
              <span class="size-2.5 rounded-full" :class="ramo.cor" /> {{ ramo.rotulo }}
            </p>
            <p class="mt-1 flex items-baseline justify-between gap-2">
              <span class="titulo text-xl font-semibold tabular-nums" :class="ramo.texto">{{ n(ramo.pedidos) }}</span>
              <span class="text-xs font-semibold tabular-nums text-ink-600">{{ pct(ramo.pedidos, cobranca.criados) }}%</span>
            </p>
            <p class="text-sm tabular-nums text-ink-800">{{ reais(ramo.cobradoCents) }}</p>
            <ul v-if="ramo.itens.length" class="mt-2 grid gap-0.5 border-t border-ink-200 pt-2 text-xs text-ink-700">
              <li v-for="s in ramo.itens" :key="s.status" class="flex flex-wrap justify-between gap-x-2">
                <span>{{ ROTULO_STATUS[s.status] ?? s.status }}</span>
                <span class="tabular-nums">{{ n(s.pedidos) }} · {{ reais(s.cobradoCents) }}</span>
              </li>
            </ul>
          </li>
        </ul>
      </section>

      <template v-if="r.pedidos">
        <!-- ---------------------------------------------------- quem compra -->
        <section class="card mt-4" aria-labelledby="titulo-quem">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div class="flex items-center gap-3">
              <span class="grid size-11 shrink-0 place-items-center rounded-xl bg-citrus-100 text-citrus-700"><IconeMenu nome="pessoas" :tamanho="22" /></span>
              <div>
                <h2 id="titulo-quem" class="titulo text-lg font-semibold text-ink-900">Quem compra</h2>
                <p class="text-sm text-ink-700">
                  <strong class="tabular-nums text-ink-900" data-parte="clientes">{{ n(data.clientes.total) }}</strong>
                  {{ data.clientes.total === 1 ? 'pessoa comprou' : 'pessoas diferentes compraram' }} ·
                  {{ pct(data.clientes.comCadastro, data.clientes.total) }}% com cadastro completo ·
                  {{ pct(data.clientes.aceitamNovidades, data.clientes.total) }}% aceitam novidades
                </p>
                <p v-if="r.pedidosSemCliente" class="text-xs text-ink-600">
                  + {{ n(r.pedidosSemCliente) }} {{ r.pedidosSemCliente === 1 ? 'venda' : 'vendas' }} sem cliente identificado (balcão sem cadastro)
                </p>
              </div>
            </div>
            <NuxtLink v-if="abreClientes" to="/admin/clientes" class="btn-secundario min-h-[40px]" data-acao="ver-clientes">
              Ver os clientes
            </NuxtLink>
          </div>

          <div class="mt-5 grid gap-6 lg:grid-cols-2">
            <div>
              <p class="text-sm font-semibold text-ink-900">De onde vêm</p>
              <p v-if="!data.clientes.porCidade.length" class="mt-2 text-sm text-ink-700">
                Ninguém informou a cidade ainda. Ela vem do formulário de compra do site.
              </p>
              <table v-else class="mt-2 w-full text-sm">
                <tbody>
                  <tr v-for="c in data.clientes.porCidade" :key="`${c.estado}|${c.cidade}`" class="border-b border-ink-100 last:border-0">
                    <td class="py-2 text-ink-900">{{ c.cidade }} <span class="text-xs text-ink-600">{{ c.estado }}</span></td>
                    <td class="w-28 py-2 pl-3">
                      <div class="h-2 rounded-full bg-ink-100"><div class="h-2 rounded-full bg-citrus-500" :style="{ width: largura(c.clientes, pico(data.clientes.porCidade, 'clientes')) }" /></div>
                    </td>
                    <td class="w-12 py-2 text-right tabular-nums text-ink-800">{{ n(c.clientes) }}</td>
                  </tr>
                </tbody>
              </table>
              <p v-if="data.clientes.semCidade" class="mt-2 text-xs text-ink-600">{{ n(data.clientes.semCidade) }} sem cidade informada.</p>
            </div>

            <div>
              <p class="text-sm font-semibold text-ink-900">Faixa de idade</p>
              <p v-if="data.clientes.semIdade === data.clientes.total" class="mt-2 text-sm text-ink-700">
                Ninguém informou a idade ainda. Ela vem do formulário de compra do site.
              </p>
              <table v-else class="mt-2 w-full text-sm">
                <tbody>
                  <tr v-for="f in data.clientes.porFaixa" :key="f.chave" class="border-b border-ink-100 last:border-0">
                    <td class="py-2 text-ink-900">{{ f.rotulo }}</td>
                    <td class="w-28 py-2 pl-3">
                      <div class="h-2 rounded-full bg-ink-100"><div class="h-2 rounded-full bg-grape-400" :style="{ width: largura(f.clientes, pico(data.clientes.porFaixa, 'clientes')) }" /></div>
                    </td>
                    <td class="w-12 py-2 text-right tabular-nums text-ink-800">{{ n(f.clientes) }}</td>
                  </tr>
                </tbody>
              </table>
              <p v-if="data.clientes.semIdade" class="mt-2 text-xs text-ink-600">{{ n(data.clientes.semIdade) }} sem idade informada.</p>
            </div>
          </div>
        </section>

        <!-- ---------------------------------------------- quem mais comprou -->
        <section v-if="data.topCompradores.length" class="card mt-4 p-0" aria-labelledby="titulo-top">
          <div class="border-b border-ink-200 px-4 py-3 sm:px-5">
            <h2 id="titulo-top" class="titulo text-lg font-semibold text-ink-900">Quem mais comprou</h2>
            <p v-if="!abreClientes" class="text-xs text-ink-600" data-parte="email-parcial">
              E-mail parcial: o contato completo fica na base de clientes, que é do master.
            </p>
          </div>
          <!-- e-mail comprido não quebra sozinho: a tabela rola dentro do cartão em vez de esticar a página -->
          <div class="relative overflow-x-auto">
            <table class="tabela-cartoes w-full text-sm sm:min-w-[30rem]">
              <thead>
                <tr class="border-b border-ink-200 text-left text-xs font-semibold uppercase tracking-wide text-ink-600">
                  <th class="w-10 px-4 py-2 font-semibold sm:px-5">#</th><th class="py-2 font-semibold">Cliente</th>
                  <th class="hidden px-3 py-2 text-right font-semibold sm:table-cell">Pedidos</th><th class="hidden px-3 py-2 text-right font-semibold sm:table-cell">Ingressos</th>
                  <th class="px-4 py-2 text-right font-semibold sm:px-5">Pagou</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(c, i) in data.topCompradores" :key="c.id" class="border-b border-ink-100 last:border-0" data-parte="linha-top">
                  <td class="px-4 py-2.5 text-xs tabular-nums text-ink-600 sm:px-5">{{ i + 1 }}</td>
                  <td class="py-2.5">
                    <p class="font-medium text-ink-900">{{ c.nome }}</p>
                    <p class="break-all text-xs text-ink-600" data-parte="email-top">{{ c.email }}</p>
                    <p class="text-xs text-ink-700 sm:hidden">{{ n(c.pedidos) }} {{ c.pedidos === 1 ? 'pedido' : 'pedidos' }} · {{ n(c.ingressos) }} ingressos</p>
                  </td>
                  <td class="hidden px-3 py-2.5 text-right tabular-nums text-ink-800 sm:table-cell">{{ n(c.pedidos) }}</td>
                  <td class="hidden px-3 py-2.5 text-right tabular-nums text-ink-800 sm:table-cell">{{ n(c.ingressos) }}</td>
                  <td class="px-4 py-2.5 text-right font-semibold tabular-nums text-ink-900 sm:px-5">{{ reais(c.gastoCents) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      </template>
    </template>
  </div>
</template>
