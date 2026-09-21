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

const route = useRoute()

const de = ref(String(route.query.de ?? ''))
const ate = ref(String(route.query.ate ?? ''))
const eventoId = ref(String(route.query.eventoId ?? ''))

const params = computed(() => ({
  de: de.value || undefined,
  ate: ate.value || undefined,
  eventoId: eventoId.value || undefined,
}))

const { data, pending, error: falha, refresh } = await useFetch<any>(
  '/api/admin/reconciliacao', { query: params })

// a rota devolve o array cru, não um objeto com `eventos` dentro
const { data: eventos } = await useFetch<any[]>('/api/admin/eventos')

watch(params, (p) => {
  navigateTo({ query: Object.fromEntries(Object.entries(p).filter(([, v]) => v)) },
    { replace: true })
})

const brl = reais

/* ------------------------------------------------------------- período */

const ATALHOS = { hoje: 'Hoje', semana: '7 dias', mes: 'Este mês', passado: 'Mês passado' } as const
type Atalho = keyof typeof ATALHOS

function faixaDo(qual: Atalho): [string, string] {
  const hoje = new Date()
  if (qual === 'hoje') return [diaLocal(hoje), diaLocal(hoje)]
  if (qual === 'semana') return [diaLocalMais(-6, hoje), diaLocal(hoje)]
  if (qual === 'mes') return [primeiroDiaDoMes(hoje), diaLocal(hoje)]
  const primeiroDesteMes = new Date(hoje.getFullYear(), hoje.getMonth(), 1)
  const fimDoPassado = new Date(primeiroDesteMes)
  fimDoPassado.setDate(0)
  return [primeiroDiaDoMes(fimDoPassado), diaLocal(fimDoPassado)]
}

function periodo(qual: Atalho) {
  const [d, a] = faixaDo(qual)
  de.value = d
  ate.value = a
}

const atalhoAtivo = computed<Atalho | null>(() => {
  for (const k of Object.keys(ATALHOS) as Atalho[]) {
    const [d, a] = faixaDo(k)
    if (d === de.value && a === ate.value) return k
  }
  return null
})

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
    const busca: Record<string, string> = { registrar: '1' }
    if (de.value) busca.de = de.value
    if (ate.value) busca.ate = ate.value
    if (eventoId.value) busca.eventoId = eventoId.value

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

/** link pro pedido dentro do evento dele — a lista de vendas busca pelo código */
function linkDoPedido(d: any): string | null {
  if (!d.eventoId || !d.pedidoCodigo) return null
  return `/admin/evento/${d.eventoId}/vendas?busca=${encodeURIComponent(d.pedidoCodigo)}`
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
    d.nossoStatus ?? '', d.statusNoGateway ?? '',
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
      <div class="flex flex-wrap items-end gap-3">
        <div class="flex flex-wrap gap-2">
          <button v-for="(rotulo, chave) in ATALHOS" :key="chave" type="button"
                  :class="atalhoAtivo === chave ? 'chip-ativo' : 'chip'"
                  @click="periodo(chave as any)">
            {{ rotulo }}
          </button>
        </div>
        <div>
          <label class="rotulo" for="rec-de">De</label>
          <input id="rec-de" v-model="de" type="date" class="campo w-[170px]">
        </div>
        <div>
          <label class="rotulo" for="rec-ate">Até</label>
          <input id="rec-ate" v-model="ate" type="date" class="campo w-[170px]">
        </div>
        <div>
          <label class="rotulo" for="rec-evento">Evento</label>
          <select id="rec-evento" v-model="eventoId" class="campo w-[260px]">
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
        <span :class="TOM_SELO[veredito.tom]">{{ veredito.selo }}</span>
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
                  <span :class="SELO_STATUS[d.nossoStatus] ?? 'selo-neutro'">
                    {{ (d.nossoStatus ?? 'não existe').toUpperCase() }}
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
      <p v-if="data.totais.naoConferidos > data.naoConferidos.length"
         class="border-t border-linha px-4 py-3 text-xs text-tinta-fraca">
        Mostrando {{ data.naoConferidos.length }} de {{ data.totais.naoConferidos }}.
        Estreite o período para ver o resto.
      </p>
    </div>
  </div>

  <p v-else-if="pending" class="card mt-6 text-tinta-suave">Conferindo…</p>

  <div v-else class="card mt-6">
    <p class="rotulo-kpi text-erro">Não foi possível conferir</p>
    <p class="mt-1 text-sm text-tinta-suave">
      {{ (falha as any)?.data?.statusMessage || (falha as any)?.statusMessage
         || (falha as any)?.message || 'Erro desconhecido.' }}
    </p>
    <button type="button" class="btn-secundario mt-3" @click="refresh()">Tentar de novo</button>
  </div>
</template>
