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
 *   junto do aviso da fonte, e não escondido no rodapé.
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

const TIPOS = ['webhook_perdido', 'sem_cobranca_no_asaas', 'valor_diferente'] as const

const porTipo = computed(() => {
  const m: Record<string, any[]> = { webhook_perdido: [], sem_cobranca_no_asaas: [], valor_diferente: [] }
  for (const d of data.value?.divergencias ?? []) (m[d.tipo] ??= []).push(d)
  return m
})

const totalDivergencias = computed(() => {
  const t = data.value?.totais
  return t ? t.webhookPerdido + t.semCobranca + t.valorDiferente : 0
})

/** o sinal importa: positivo é dinheiro no gateway que não está aqui */
const corDaDiferenca = (c: number) => (c === 0 ? 'text-tinta-fraca' : 'text-erro')

/**
 * A "Diferença" só quer dizer alguma coisa quando os dois lados foram
 * conferidos. Sem credencial do Asaas o extrato vem vazio, e a subtração
 * pintava o caixa inteiro de vermelho — "O gateway pagou R$ 0,00 · Diferença
 * −R$ 16.139,75" — ao lado de "Divergências 0" e "179 pedidos não conferidos".
 * É o número maior da tela acusando exatamente o que ela não olhou.
 */
const daPraFechar = computed(() => !(data.value?.totais?.naoConferidos > 0))

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
  const linhas = (data.value?.divergencias ?? []).map((d: any) => [
    CATALOGO_ROTULO(d.tipo), d.cobrancaId ?? '', d.pedidoCodigo ?? '', d.evento ?? '',
    d.nossoStatus ?? '', d.statusNoGateway ?? '',
    d.nossoCents == null ? '' : brl(d.nossoCents),
    d.gatewayCents == null ? '' : brl(d.gatewayCents),
    brl(d.diferencaCents), dataHora(d.quando, ''), d.explicacao,
  ])
  baixarCsv(`reconciliacao-${data.value?.periodo?.de}-a-${data.value?.periodo?.ate}`,
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
        <h1 class="titulo text-2xl font-bold text-tinta">Reconciliação</h1>
        <p class="mt-1 max-w-3xl text-tinta-suave">
          O que a plataforma diz que recebeu, ao lado do que o gateway diz que pagou.
          Os valores são o que o <strong>comprador pagou</strong> (bruto), não o líquido
          do produtor — essa conta é a do borderô.
        </p>
      </div>
      <button type="button" class="btn-secundario" :disabled="!data.divergencias.length"
              @click="exportar">
        <IconeMenu nome="exportar" :tamanho="18" /> Exportar divergências
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
      </div>

      <p class="mt-3 text-xs text-tinta-fraca">
        Fonte: <strong class="text-tinta-suave">{{ data.fonte.rotulo }}</strong>
        <template v-if="data.fonte.ambiente"> ({{ data.fonte.ambiente }})</template>
        <template v-if="data.anterior">
          · conferência anterior em {{ dataHora(data.anterior.quando) }}
          <template v-if="data.anterior.por">por {{ data.anterior.por }}</template>
          — {{ data.anterior.divergencias }} divergência(s)
        </template>
      </p>
    </div>

    <!-- ------------------------------------------------- aviso sobre a fonte -->
    <div v-if="data.fonte.erro" class="faixa-erro mt-4">{{ data.fonte.aviso }}</div>
    <div v-else-if="data.fonte.aviso" class="faixa-aviso mt-4">{{ data.fonte.aviso }}</div>

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
        <p class="numero-kpi mt-1">{{ brl(data.totais.gatewayCents) }}</p>
        <p class="mt-1 text-xs text-tinta-fraca">
          {{ data.totais.cobrancas }} cobrança(s) recebida(s) no período
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
        <p v-else class="mt-1 text-xs text-alerta">
          Não dá pra fechar: {{ brl(data.totais.naoConferidosCents) }} em
          {{ data.totais.naoConferidos }} pedido(s) não foram conferidos.
        </p>
      </div>
      <div class="card">
        <p class="rotulo-kpi">Divergências</p>
        <p class="numero-kpi mt-1" :class="totalDivergencias ? 'text-erro' : 'text-ok'">
          {{ totalDivergencias }}
        </p>
        <p class="mt-1 text-xs" :class="data.totais.naoConferidos ? 'text-alerta' : 'text-tinta-fraca'">
          <template v-if="data.totais.naoConferidos">
            {{ data.totais.naoConferidos }} pedido(s) não conferidos
          </template>
          <template v-else>
            {{ data.totais.conferidos }} pedido(s) conferidos
          </template>
        </p>
      </div>
    </div>

    <p v-if="!totalDivergencias && !data.totais.naoConferidos && data.fonte.completa"
       class="card mt-4 py-10 text-center text-ok">
      Os dois lados fecham no período. Nenhuma divergência.
    </p>

    <!-- ------------------------------------------------ as três divergências -->
    <section v-for="tipo in TIPOS" :key="tipo">
      <div v-if="porTipo[tipo].length" class="card mt-4 p-0">
        <div class="border-b border-linha px-4 py-3">
          <div class="flex flex-wrap items-center gap-2">
            <span :class="data.catalogo[tipo].gravidade === 'grave' ? 'selo-erro' : 'selo-alerta'">
              {{ data.catalogo[tipo].gravidade === 'grave' ? 'GRAVE' : 'ATENÇÃO' }}
            </span>
            <span class="titulo text-sm font-bold text-tinta-rotulo">
              {{ data.catalogo[tipo].rotulo }} · {{ porTipo[tipo].length }}
            </span>
          </div>
          <p class="mt-1 text-sm text-tinta-suave">{{ data.catalogo[tipo].oQueE }}</p>
          <div class="mt-2 rounded-card border border-linha bg-fundo-cinza p-3">
            <p class="titulo text-xs font-bold text-tinta-rotulo">
              O que fazer: {{ data.catalogo[tipo].acao.rotulo }}
            </p>
            <p class="mt-1 text-sm text-tinta-corpo">{{ data.catalogo[tipo].acao.comoFazer }}</p>
          </div>
        </div>

        <div class="overflow-x-auto">
          <table class="w-full min-w-[980px] border-collapse text-sm">
            <thead>
              <tr class="border-b border-linha bg-fundo-cinza/60 text-left">
                <th class="titulo px-4 py-2 text-xs font-bold uppercase tracking-wide text-tinta-rotulo">
                  Cobrança / pedido
                </th>
                <th class="titulo px-3 py-2 text-xs font-bold uppercase tracking-wide text-tinta-rotulo">
                  Aqui
                </th>
                <th class="titulo px-3 py-2 text-xs font-bold uppercase tracking-wide text-tinta-rotulo">
                  No gateway
                </th>
                <th class="titulo px-3 py-2 text-right text-xs font-bold uppercase tracking-wide text-tinta-rotulo">
                  Nosso
                </th>
                <th class="titulo px-3 py-2 text-right text-xs font-bold uppercase tracking-wide text-tinta-rotulo">
                  Gateway
                </th>
                <th class="titulo px-3 py-2 text-right text-xs font-bold uppercase tracking-wide text-tinta-rotulo">
                  Diferença
                </th>
                <th class="titulo px-4 py-2 text-right text-xs font-bold uppercase tracking-wide text-tinta-rotulo">
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
        <p class="titulo text-sm font-bold text-alerta">
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
