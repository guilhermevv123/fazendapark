<script setup lang="ts">
/**
 * Reconciliação — o extrato do Asaas ao lado do nosso caixa.
 *
 * Até esta tela existir, a única forma de descobrir que um aviso de pagamento
 * se perdeu era o comprador reclamando no portão. Aqui os dois lados ficam um
 * ao lado do outro, e cada diferença tem NOME e o que fazer.
 *
 * Três decisões:
 *
 * - **O recorte mora na URL.** Quem achou a divergência manda o link pro
 *   sócio em vez de descrever o caminho por telefone.
 *
 * - **A tela diz em voz alta o que NÃO foi conferido.** "Nenhuma divergência"
 *   com metade dos pedidos sem conferência é a mentira mais cara que esta
 *   tela poderia contar; por isso o bloco de "não conferidos" fica no topo,
 *   junto do aviso da fonte, e não escondido no rodapé. O veredito da rota
 *   manda no TOM: sem extrato do Asaas de verdade, nenhum número desta tela
 *   fica verde — medido, o "0" de Divergências saía em `rgb(18,128,92)` com
 *   213 de 213 pedidos sem conferir.
 *
 * - **Olhar não é conferir.** Abrir a tela só LÊ. Conferir é um ato com
 *   autor e hora, e mora no botão "Registrar conferência" — antes disso, a
 *   própria abertura da página gravava duas linhas no livro (servidor +
 *   hidratação do `useFetch`) e o cartão de memória mostrava você mesmo, de
 *   cinco segundos atrás.
 *
 * - **Cada divergência traz a ação junto.** Divergência sem caminho de ação
 *   vira uma aba que a pessoa fecha.
 */
definePageMeta({ layout: 'admin' })

import PainelFalha from '~/components/painel/Falha.vue'
import PainelPeriodo from '~/components/painel/Periodo.vue'
import { ehChavePeriodo, type ChavePeriodo } from '~/composables/painelPeriodo'
import { useConsultaNaUrl } from '~/composables/consultaNaUrl'

// a URL é a fonte do recorte; `atual` é a última pedida enquanto a navegação anda (consultaNaUrl.ts)
const consulta = useConsultaNaUrl()

/**
 * O recorte é o que a URL diz — a cada troca, não só na montagem (REL-07, o mesmo padrão da
 * Visão geral e da Auditoria). O período fala o vocabulário do painel (proposta 10), sem "Tudo":
 * a conferência lê o extrato do gateway, que precisa de janela com começo. Padrão: este mês.
 * O "Hoje" é o dia do parque, resolvido pela rota — não o do navegador.
 */
const PADRAO: ChavePeriodo = 'mes'
const texto = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
const filtro = computed(() => {
  const q = consulta.atual.value
  const de = texto(q.de)
  const ate = texto(q.ate)
  const chave = ehChavePeriodo(q.periodo) && q.periodo !== 'tudo' ? q.periodo : PADRAO
  return { de, ate, periodo: (de || ate ? null : chave) as ChavePeriodo | null, eventoId: texto(q.eventoId) }
})

const params = computed(() => {
  const f = filtro.value
  const p: Record<string, string> = {}
  if (f.periodo && f.periodo !== PADRAO) p.periodo = f.periodo
  if (f.de) p.de = f.de
  if (f.ate) p.ate = f.ate
  if (f.eventoId) p.eventoId = f.eventoId
  return p
})

const { data, pending, error: falha, refresh } = await useFetch<any>(
  '/api/admin/reconciliacao', { query: params })

// a rota devolve o array cru, não um objeto com `eventos` dentro
const { data: eventos } = await useFetch<any[]>('/api/admin/eventos')

type Mudanca = Partial<{ periodo: string | null; de: string; ate: string; eventoId: string }>
function irPara(m: Mudanca) {
  const f = { ...filtro.value, ...m }
  const query: Record<string, string> = {}
  if (f.de || f.ate) {
    if (f.de) query.de = f.de
    if (f.ate) query.ate = f.ate
  } else if (f.periodo && f.periodo !== PADRAO) query.periodo = f.periodo
  if (f.eventoId) query.eventoId = f.eventoId
  return consulta.escrever(query, '/admin/reconciliacao')
}
const escolherPeriodo = (chave: string) => irPara({ periodo: chave, de: '', ate: '' })
const escolherDatas = (p: { de: string | null; ate: string | null }) => irPara({ periodo: null, de: p.de ?? '', ate: p.ate ?? '' })
const limpar = () => consulta.escrever({}, '/admin/reconciliacao')

const brl = reais

/* --------------------------------------------------------- leitura da tela */

const TIPOS = [
  'webhook_perdido', 'sem_cobranca_no_asaas', 'cobranca_repetida', 'valor_diferente',
] as const

const porTipo = computed(() => {
  const m: Record<string, any[]> = Object.fromEntries(TIPOS.map((t) => [t, []]))
  for (const d of data.value?.divergencias ?? []) (m[d.tipo] ??= []).push(d)
  return m
})

const totalDivergencias = computed(() => {
  const t = data.value?.totais
  return t
    ? t.webhookPerdido + t.semCobranca + t.valorDiferente + (t.cobrancaRepetida ?? 0)
    : 0
})

/* ------------------------------------------- a lista vem cortada; o contador não
 *
 * A rota manda no máximo `tetoDaLista` (300) linhas de divergência e os
 * contadores INTEIROS — de propósito, pra o KPI não dizer "300" num período
 * com 4.000. O preço é que, passado o teto, três números da MESMA tela falam
 * de conjuntos diferentes e nada avisava: o cartão "Divergências" contava
 * 4.000, o cabeçalho de cada seção contava as linhas que couberam, e o botão
 * "Exportar divergências" baixava um CSV de 300 linhas com o nome do período
 * inteiro. Esse arquivo é o que alguém usa pra fechar o mês — truncado em
 * silêncio, ele vira a versão oficial de um número errado.
 *
 * Agora o corte tem voz: faixa em cima, "N de M" no cabeçalho da seção e
 * PARCIAL no nome do arquivo, com os dois números dentro dele.
 */
const CHAVE_DO_TOTAL: Record<string, string> = {
  webhook_perdido: 'webhookPerdido',
  sem_cobranca_no_asaas: 'semCobranca',
  cobranca_repetida: 'cobrancaRepetida',
  valor_diferente: 'valorDiferente',
}
const totalDoTipo = (tipo: string) => Number(data.value?.totais?.[CHAVE_DO_TOTAL[tipo]!] ?? 0)

const divergenciasNaTela = computed(() => data.value?.divergencias?.length ?? 0)
const listaCortada = computed(() => divergenciasNaTela.value < totalDivergencias.value)

/* ----------------------------------------------------------- o veredito
 *
 * Quem decide o tom é a rota, não a tela: é lá que se sabe se o extrato veio
 * do Asaas, se veio inteiro e se sobrou pedido sem conferir. Aqui só se
 * pinta. `ok` (verde) é a única cor que afirma alguma coisa — e ela só
 * aparece quando a conferência aconteceu de verdade.
 */
const veredito = computed(() => data.value?.veredito
  ?? { conferido: false, tom: 'alerta' as const, selo: '' })

const TOM_SELO: Record<string, string> = {
  ok: 'selo-ok', alerta: 'selo-alerta', erro: 'selo-erro',
}

/* ------------------------------------------- registrar a conferência (o ato) */

const registrando = ref(false)
const registrado = ref<string | null>(null)
const registroFalhou = ref<string | null>(null)

/**
 * O único caminho que escreve no livro de conferências.
 *
 * O cabeçalho vai junto de propósito: o cookie é `SameSite=Lax` e ainda
 * viajaria numa navegação vinda de outro site, que não consegue mandar
 * cabeçalho nenhum. Sem ele a rota lê e devolve o motivo em vez de gravar.
 */
async function registrar() {
  registrando.value = true
  registroFalhou.value = null
  try {
    // o período que a ROTA resolveu (o atalho vira datas do parque) — é ele que o livro guarda
    const busca: Record<string, string> = { registrar: '1' }
    if (data.value?.periodo?.de) busca.de = data.value.periodo.de
    if (data.value?.periodo?.ate) busca.ate = data.value.periodo.ate
    if (filtro.value.eventoId) busca.eventoId = filtro.value.eventoId

    const r = await $fetch<any>('/api/admin/reconciliacao', {
      query: busca,
      headers: { 'x-diamond-conferencia': '1' },
    })
    if (r?.registro?.gravado) registrado.value = r.registro.quando
    else registroFalhou.value = r?.registro?.porque ?? 'Não consegui registrar a conferência.'
    // relê pra o cartão de memória mostrar o registro que acabou de nascer
    await refresh()
  } catch (e: any) {
    registroFalhou.value = e?.data?.statusMessage ?? e?.statusMessage
      ?? e?.message ?? 'Não consegui registrar a conferência.'
  } finally {
    registrando.value = false
  }
}

// trocou de período/evento: o registro de antes não fala mais do que está na tela
watch(params, () => { registrado.value = null; registroFalhou.value = null })

/** o sinal importa: positivo é dinheiro no gateway que não está aqui */
const corDaDiferenca = (c: number) => (c === 0 ? 'text-tinta-fraca' : 'text-erro')

/**
 * A "Diferença" só quer dizer alguma coisa quando os dois lados foram
 * conferidos. Sem credencial do Asaas o extrato vem vazio, e a subtração
 * pintava o caixa inteiro de vermelho — "O gateway pagou R$ 0,00 · Diferença
 * −R$ 16.139,75" — ao lado de "Divergências 0" e "179 pedidos não conferidos".
 * É o número maior da tela acusando exatamente o que ela não olhou.
 *
 * A régua é a do veredito, e não mais "sobrou pedido sem conferir": contra o
 * gateway simulado é possível conferir todos os pedidos e mesmo assim não ter
 * conferido nada com o Asaas — a subtração continuaria falando de um extrato
 * que ninguém leu.
 */
const daPraFechar = computed(() => veredito.value.conferido)

const SELO_STATUS: Record<string, string> = {
  pago: 'selo-ok', estornado_parcial: 'selo-alerta', expirado: 'selo-neutro',
  aguardando_pagamento: 'selo-alerta', cancelado: 'selo-neutro', estornado: 'selo-neutro',
  chargeback: 'selo-erro', disputa: 'selo-erro', falhou: 'selo-erro',
}

/**
 * A situação do pedido com o nome de gente — o mesmo dicionário de Clientes e da Visão geral
 * (status de pedido é um vocabulário só). A linha imprimia o valor cru do banco em caixa alta
 * ("ESTORNADO_PARCIAL", "AGUARDANDO_PAGAMENTO"), o mesmo defeito do FIN-07 no Financeiro.
 */
const ROTULO_STATUS: Record<string, string> = {
  pago: 'Pago', aguardando_pagamento: 'Aguardando pagamento', em_analise: 'Em análise',
  expirado: 'Expirou sem pagar', cancelado: 'Cancelado', falhou: 'Pagamento falhou',
  estornado: 'Estornado', estornado_parcial: 'Estornado em parte',
  chargeback: 'Chargeback', disputa: 'Em disputa',
}
const rotuloDoStatus = (s: string | null | undefined) =>
  s ? (ROTULO_STATUS[s] ?? s.replace(/_/g, ' ')) : 'Não existe aqui'

/**
 * Link pro pedido dentro do evento dele. É o `?pedido=<id>` que a lista de Vendas LÊ (abre a
 * ficha do pedido direto); o `?busca=<código>` sozinho, que ia antes, a tela de Vendas ignora —
 * "Abrir o pedido" caía na lista inteira, sem busca nenhuma. O código segue junto, pra quem ler
 * o endereço saber de que pedido se trata.
 */
function linkDoPedido(d: any): string | null {
  if (!d.eventoId || !d.pedidoId) return null
  const q = new URLSearchParams({ pedido: d.pedidoId })
  if (d.pedidoCodigo) q.set('busca', d.pedidoCodigo)
  return `/admin/evento/${d.eventoId}/vendas?${q}`
}

/** o que dizer da linha: o aviso do gateway está guardado aqui ou nunca chegou? */
function situacaoDoAviso(d: any): string {
  if (!d.aviso) return 'Nenhum aviso deste pagamento chegou aqui.'
  if (!d.aviso.processado) {
    return `Aviso ${d.aviso.evento} guardado e NÃO processado`
      + (d.aviso.tentativas ? ` — ${d.aviso.tentativas} tentativa(s)` : '')
      + (d.aviso.erro ? `: ${d.aviso.erro}` : '.')
  }
  return `Aviso ${d.aviso.evento} guardado e já processado`
    + (d.aviso.erro ? ` com erro: ${d.aviso.erro}` : '.')
}

function exportar() {
  // O nome do arquivo é a última chance de o corte aparecer: o CSV sai da tela
  // e vira anexo de e-mail, planilha do sócio, prova do fechamento. Quem abre
  // não tem como saber que faltam linhas se o nome promete o período inteiro.
  const periodoNoNome = `${data.value?.periodo?.de}-a-${data.value?.periodo?.ate}`
  const nome = listaCortada.value
    ? `reconciliacao-${periodoNoNome}-PARCIAL-${divergenciasNaTela.value}`
      + `-de-${totalDivergencias.value}`
    : `reconciliacao-${periodoNoNome}`
  const linhas = (data.value?.divergencias ?? []).map((d: any) => [
    CATALOGO_ROTULO(d.tipo), d.cobrancaId ?? '', d.pedidoCodigo ?? '', d.evento ?? '',
    rotuloDoStatus(d.nossoStatus), d.statusNoGateway ?? '',
    d.nossoCents == null ? '' : brl(d.nossoCents),
    d.gatewayCents == null ? '' : brl(d.gatewayCents),
    brl(d.diferencaCents), dataHora(d.quando, ''), d.explicacao,
  ])
  baixarCsv(nome,
    ['Divergência', 'Cobrança', 'Pedido', 'Evento', 'Aqui', 'No gateway',
     'Nosso', 'Gateway', 'Diferença', 'Quando', 'O que é'],
    linhas)
}

const CATALOGO_ROTULO = (tipo: string) => data.value?.catalogo?.[tipo]?.rotulo ?? tipo

useHead({ title: 'Reconciliação' })
</script>

<template>
  <div v-if="data">
    <div class="flex flex-wrap items-start justify-between gap-3 py-5">
      <div>
        <h1 class="titulo text-2xl font-semibold text-tinta">Reconciliação</h1>
        <p class="mt-1 max-w-3xl text-tinta-suave">
          O que a plataforma diz que recebeu, ao lado do que o gateway diz que pagou.
          Os valores são o que o <strong>comprador pagou</strong> (bruto), não o líquido
          do produtor — essa conta é a do borderô.
        </p>
      </div>
      <button type="button" class="btn-secundario" :disabled="!data.divergencias.length"
              @click="exportar">
        <IconeMenu nome="exportar" :tamanho="18" />
        <template v-if="listaCortada">
          Exportar {{ divergenciasNaTela }} de {{ totalDivergencias }}
        </template>
        <template v-else>Exportar divergências</template>
      </button>
    </div>

    <!-- ----------------------------------------------------------- filtros -->
    <div class="card">
      <PainelPeriodo :periodo="filtro.periodo" :de="data.periodo?.de ?? null" :ate="data.periodo?.ate ?? null"
                     :carregando="pending" :sem="['tudo']"
                     @escolher="escolherPeriodo" @datas="escolherDatas" />
      <div class="mt-3 flex flex-wrap items-end gap-3 border-t border-linha pt-3">
        <div>
          <label class="rotulo" for="rec-evento">Evento</label>
          <select id="rec-evento" :value="filtro.eventoId" class="campo w-full sm:w-[260px]" data-parte="filtro-evento"
                  @change="irPara({ eventoId: ($event.target as HTMLSelectElement).value })">
            <option value="">Todos os eventos</option>
            <option v-for="e in (eventos ?? [])" :key="e.id" :value="e.id">
              {{ e.nome }}
            </option>
          </select>
        </div>
        <button type="button" class="btn-secundario" :disabled="pending" @click="refresh()">
          {{ pending ? 'Conferindo…' : 'Conferir de novo' }}
        </button>
        <button type="button" class="btn-secundario" :disabled="registrando || pending"
                @click="registrar()">
          {{ registrando ? 'Registrando…' : 'Registrar conferência' }}
        </button>
      </div>

      <!-- O veredito em voz alta, no tamanho do resto da tela: é ele que
           separa "conferi e fecha" de "não conferi nada". -->
      <p class="mt-3 flex flex-wrap items-center gap-2 text-xs text-tinta-fraca">
        <!-- no celular o veredito quebra linha em vez de vazar do cartão -->
        <span class="max-w-full whitespace-normal" :class="TOM_SELO[veredito.tom]" data-parte="veredito">{{ veredito.selo }}</span>
        <span>
          Fonte: <strong class="text-tinta-suave">{{ data.fonte.rotulo }}</strong>
          <template v-if="data.fonte.ambiente"> ({{ data.fonte.ambiente }})</template>
        </span>
        <span v-if="data.ultimaConferencia">
          · última conferência registrada em {{ dataHora(data.ultimaConferencia.quando) }}
          <template v-if="data.ultimaConferencia.por">
            por {{ data.ultimaConferencia.por }}
          </template>
          ({{ data.ultimaConferencia.de }} a {{ data.ultimaConferencia.ate }})
          — {{ data.ultimaConferencia.divergencias }} divergência(s)
        </span>
        <span v-else>· nenhuma conferência registrada nesta organização</span>
      </p>

      <p v-if="registrado" class="mt-2 text-xs text-ok">
        Conferência registrada em {{ dataHora(registrado) }}. O livro guarda este período,
        a fonte usada e quem conferiu.
      </p>
      <p v-else-if="registroFalhou" class="mt-2 text-xs text-erro">{{ registroFalhou }}</p>
    </div>

    <!-- ------------------------------------------------- aviso sobre a fonte -->
    <div v-if="data.fonte.aviso"
         class="mt-4" :class="veredito.tom === 'erro' ? 'faixa-erro' : 'faixa-aviso'">
      {{ data.fonte.aviso }}
    </div>

    <!-- ---------------------------------------------------------------- KPIs -->
    <div class="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <div class="card">
        <p class="rotulo-kpi">A plataforma recebeu</p>
        <p class="numero-kpi mt-1">{{ brl(data.totais.nossoCents) }}</p>
        <p class="mt-1 text-xs text-tinta-fraca">
          {{ data.totais.pedidos }} pedido(s) com cobrança no gateway
        </p>
      </div>
      <div class="card">
        <p class="rotulo-kpi">O gateway pagou</p>
        <p class="numero-kpi mt-1" :class="veredito.conferido ? '' : 'text-tinta-fraca'">
          {{ brl(data.totais.gatewayCents) }}
        </p>
        <!-- o número sem a fonte ao lado vira afirmação: "o gateway pagou
             R$ 0,00" quando a verdade é que ninguém leu extrato nenhum -->
        <p class="mt-1 text-xs" :class="veredito.conferido ? 'text-tinta-fraca' : 'text-alerta'">
          {{ data.totais.cobrancas }} cobrança(s) recebida(s) · {{ data.fonte.rotulo }}
        </p>
      </div>
      <div class="card">
        <p class="rotulo-kpi">Diferença</p>
        <p v-if="daPraFechar" class="numero-kpi mt-1"
           :class="corDaDiferenca(data.totais.diferencaCents)">
          {{ brl(data.totais.diferencaCents) }}
        </p>
        <p v-else class="numero-kpi mt-1 text-tinta-fraca">—</p>
        <p v-if="daPraFechar" class="mt-1 text-xs text-tinta-fraca">gateway menos plataforma</p>
        <p v-else-if="data.totais.naoConferidos" class="mt-1 text-xs text-alerta">
          Não dá pra fechar: {{ brl(data.totais.naoConferidosCents) }} em
          {{ data.totais.naoConferidos }} pedido(s) não foram conferidos.
        </p>
        <p v-else class="mt-1 text-xs text-alerta">{{ veredito.selo }}</p>
      </div>
      <div class="card">
        <p class="rotulo-kpi">Divergências</p>
        <!-- Verde aqui é uma AFIRMAÇÃO ("está tudo certo"), e ela só pode
             aparecer quando a conferência aconteceu de verdade. Com o extrato
             vazio o zero saía verde ao lado de "213 pedido(s) não conferidos"
             em cinza de 12px: a tela dava por conferido o que não olhou. -->
        <p class="numero-kpi mt-1"
           :class="totalDivergencias ? 'text-erro'
                   : veredito.conferido ? 'text-ok' : 'text-tinta-fraca'">
          {{ totalDivergencias }}
        </p>
        <p class="mt-1 text-xs" :class="veredito.conferido ? 'text-tinta-fraca' : 'text-alerta'">
          <!-- o número de pedidos sem conferência é mais específico que o
               selo, e é ele que diz o tamanho do silêncio -->
          <template v-if="data.totais.naoConferidos">
            {{ data.totais.naoConferidos }} pedido(s) não conferidos
          </template>
          <template v-else-if="!veredito.conferido">{{ veredito.selo }}</template>
          <template v-else>{{ data.totais.conferidos }} pedido(s) conferidos</template>
        </p>
      </div>
    </div>

    <p v-if="!totalDivergencias && veredito.conferido"
       class="card mt-4 py-10 text-center text-ok">
      Os dois lados fecham no período. Nenhuma divergência.
    </p>

    <!-- O corte da lista dito em voz alta: sem isto o cartão conta 4.000, a
         tabela mostra 300 e o CSV sai com 300 debaixo do nome do mês inteiro. -->
    <div v-if="listaCortada" class="faixa-aviso mt-4">
      Mostrando {{ divergenciasNaTela }} das {{ totalDivergencias }} divergências —
      o teto desta tela é {{ data.tetoDaLista }} linhas. Os cartões acima contam TODAS;
      as tabelas abaixo e a exportação levam só estas {{ divergenciasNaTela }}.
      Estreite o período (ou filtre por evento) antes de fechar o mês com este arquivo.
    </div>

    <!-- ------------------------------------------------ as três divergências -->
    <section v-for="tipo in TIPOS" :key="tipo">
      <div v-if="porTipo[tipo].length" class="card mt-4 p-0">
        <div class="border-b border-linha px-4 py-3">
          <div class="flex flex-wrap items-center gap-2">
            <span :class="data.catalogo[tipo].gravidade === 'grave' ? 'selo-erro' : 'selo-alerta'">
              {{ data.catalogo[tipo].gravidade === 'grave' ? 'GRAVE' : 'ATENÇÃO' }}
            </span>
            <span class="titulo text-sm font-semibold text-tinta-rotulo">
              {{ data.catalogo[tipo].rotulo }} · {{ porTipo[tipo].length }}
              <!-- o cabeçalho conta o que está na tabela; quando isso é menos
                   que o total do tipo, os dois números precisam aparecer -->
              <template v-if="totalDoTipo(tipo) > porTipo[tipo].length">
                de {{ totalDoTipo(tipo) }}
              </template>
            </span>
          </div>
          <p class="mt-1 text-sm text-tinta-suave">{{ data.catalogo[tipo].oQueE }}</p>
          <div class="mt-2 rounded-card border border-linha bg-fundo-cinza p-3">
            <p class="titulo text-xs font-semibold text-tinta-rotulo">
              O que fazer: {{ data.catalogo[tipo].acao.rotulo }}
            </p>
            <p class="mt-1 text-sm text-tinta-corpo">{{ data.catalogo[tipo].acao.comoFazer }}</p>
          </div>
        </div>

        <div class="overflow-x-auto">
          <table class="w-full min-w-[980px] border-collapse text-sm">
            <thead>
              <tr class="border-b border-linha bg-fundo-cinza/60 text-left">
                <th class="titulo px-4 py-2 text-xs font-semibold uppercase tracking-wide text-tinta-rotulo">
                  Cobrança / pedido
                </th>
                <th class="titulo px-3 py-2 text-xs font-semibold uppercase tracking-wide text-tinta-rotulo">
                  Aqui
                </th>
                <th class="titulo px-3 py-2 text-xs font-semibold uppercase tracking-wide text-tinta-rotulo">
                  No gateway
                </th>
                <th class="titulo px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-tinta-rotulo">
                  Nosso
                </th>
                <th class="titulo px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-tinta-rotulo">
                  Gateway
                </th>
                <th class="titulo px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-tinta-rotulo">
                  Diferença
                </th>
                <th class="titulo px-4 py-2 text-right text-xs font-semibold uppercase tracking-wide text-tinta-rotulo">
                  Ação
                </th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="d in porTipo[tipo]" :key="`${d.tipo}-${d.cobrancaId}-${d.pedidoId}`"
                  class="border-b border-linha last:border-0 align-top">
                <td class="px-4 py-3">
                  <span class="block font-mono text-xs text-tinta-suave">
                    {{ d.cobrancaId ?? 'sem id de cobrança' }}
                  </span>
                  <span class="block text-tinta">
                    {{ d.pedidoCodigo ?? 'nenhum pedido aqui' }}
                    <template v-if="d.evento"> · {{ d.evento }}</template>
                  </span>
                  <span class="block text-xs text-tinta-fraca">{{ d.explicacao }}</span>
                </td>
                <td class="px-3 py-3">
                  <span :class="SELO_STATUS[d.nossoStatus] ?? 'selo-neutro'" data-parte="situacao-pedido">
                    {{ rotuloDoStatus(d.nossoStatus) }}
                  </span>
                  <span v-if="d.quando" class="mt-1 block text-xs text-tinta-fraca">
                    {{ dataHora(d.quando) }}
                  </span>
                </td>
                <td class="px-3 py-3">
                  <span class="font-mono text-xs text-tinta-suave">
                    {{ d.statusNoGateway ?? '—' }}
                  </span>
                </td>
                <td class="px-3 py-3 text-right tabular-nums text-tinta">
                  {{ d.nossoCents == null ? '—' : brl(d.nossoCents) }}
                </td>
                <td class="px-3 py-3 text-right tabular-nums text-tinta">
                  {{ d.gatewayCents == null ? '—' : brl(d.gatewayCents) }}
                </td>
                <td class="px-3 py-3 text-right font-medium tabular-nums"
                    :class="corDaDiferenca(d.diferencaCents)">
                  {{ brl(d.diferencaCents) }}
                </td>
                <td class="px-4 py-3 text-right">
                  <span class="block text-xs text-tinta-suave">{{ situacaoDoAviso(d) }}</span>
                  <NuxtLink v-if="linkDoPedido(d)" :to="linkDoPedido(d)!"
                            class="mt-1 inline-block text-sm text-acao hover:underline">
                    Abrir o pedido
                  </NuxtLink>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </section>

    <!-- ------------------------------------------------------ não conferidos -->
    <div v-if="data.naoConferidos.length" class="card mt-4 p-0">
      <div class="border-b border-linha px-4 py-3">
        <p class="titulo text-sm font-semibold text-alerta">
          Não conferidos · {{ data.totais.naoConferidos }}
        </p>
        <p class="mt-1 text-sm text-tinta-suave">
          Estes pedidos não foram comparados com o extrato. Não são divergência — são
          o tamanho do que esta conferência não olhou.
        </p>
      </div>
      <div class="overflow-x-auto">
      <table class="w-full text-sm">
        <tbody>
          <tr v-for="n in data.naoConferidos" :key="n.pedidoId"
              class="border-b border-linha last:border-0">
            <td class="px-4 py-2.5">
              <span class="block text-tinta">{{ n.pedidoCodigo }}</span>
              <span class="block font-mono text-xs text-tinta-fraca">
                {{ n.cobrancaId ?? '—' }}
              </span>
            </td>
            <td class="px-3 py-2.5 text-xs text-tinta-suave">{{ n.motivo }}</td>
            <td class="px-4 py-2.5 text-right tabular-nums text-tinta">{{ brl(n.nossoCents) }}</td>
          </tr>
        </tbody>
      </table>
      </div>
      <p v-if="data.totais.naoConferidos > data.naoConferidos.length"
         class="border-t border-linha px-4 py-3 text-xs text-tinta-fraca">
        Mostrando {{ data.naoConferidos.length }} de {{ data.totais.naoConferidos }}.
        Estreite o período para ver o resto.
      </p>
    </div>
  </div>

  <p v-else-if="pending" class="card mt-6 text-tinta-suave">Conferindo…</p>

  <!-- GER-01: 403 diz o motivo sem "Tentar de novo"; período torto na URL oferece limpar -->
  <PainelFalha v-else :falha="falha" o-que="a reconciliação" :tentar="refresh" :limpar="limpar" />
</template>
