<script setup lang="ts">
/**
 * Extrato — o dinheiro linha a linha, com corte por canal, ponto e período.
 *
 * As outras telas de relatório respondem "quanto"; esta responde "de onde".
 * É a tela que se abre quando alguém discorda de um número, porque é a única
 * em que dá pra apontar o pedido.
 *
 * Duas decisões de tela:
 *
 * - **O recorte manda em tudo.** Resumo, quadros e linhas saem da MESMA
 *   consulta filtrada. Um resumo que ignora o filtro é pior que não ter
 *   resumo: o total em cima discorda das linhas embaixo e a tela perde a
 *   autoridade inteira.
 *
 * - **Exporta o que está na tela.** O CSV sai do recorte atual, não do
 *   evento inteiro — quem filtrou três dias quer os três dias.
 */
definePageMeta({ layout: 'admin' })

const route = useRoute()
const id = route.params.id as string

/** o recorte vive na URL: filtro que some ao atualizar a página não serve pra conferência */
const de = ref(String(route.query.de ?? ''))
const ate = ref(String(route.query.ate ?? ''))
const canal = ref(String(route.query.canal ?? ''))
const ponto = ref(String(route.query.ponto ?? ''))
const forma = ref(String(route.query.forma ?? ''))

const params = computed(() => ({
  de: de.value || undefined, ate: ate.value || undefined,
  canal: canal.value || undefined, ponto: ponto.value || undefined,
  forma: forma.value || undefined,
}))

const { data, pending, error: falha, refresh } = await useFetch<any>(
  () => `/api/admin/evento/${id}/extrato`, { query: params })

watch(params, (p) => {
  navigateTo({ query: Object.fromEntries(Object.entries(p).filter(([, v]) => v)) },
    { replace: true })
})

const brl = (c: number) => (c / 100).toLocaleString('pt-BR',
  { style: 'currency', currency: 'BRL' })

const dia = (d: string | null) => d
  ? new Date(d).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit' })
  : '—'
const horario = (d: string | null) => d
  ? new Date(d).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit',
      hour: '2-digit', minute: '2-digit' })
  : '—'

const FORMA_LEGIVEL: Record<string, string> = {
  pix: 'Pix', credito: 'Crédito', debito: 'Débito',
  dinheiro: 'Dinheiro', cortesia: 'Cortesia',
}
const formaLegivel = (f: string | null) => f ? (FORMA_LEGIVEL[f] ?? f) : '—'

/** só destaca o que exige leitura: pago é o normal e normal não pede cor */
const COR_DO_STATUS: Record<string, string> = {
  pago: 'text-tinta-suave',
  estornado: 'text-erro',
  estornado_parcial: 'text-alerta',
  chargeback: 'text-erro',
  disputa: 'text-alerta',
}
const STATUS_LEGIVEL: Record<string, string> = {
  pago: 'Pago', estornado: 'Estornado', estornado_parcial: 'Estorno parcial',
  chargeback: 'Chargeback', disputa: 'Em disputa',
}

const temFiltro = computed(() =>
  !!(de.value || ate.value || canal.value || ponto.value || forma.value))

function limpar() {
  de.value = ''; ate.value = ''; canal.value = ''; ponto.value = ''; forma.value = ''
}

/**
 * Atalhos de período. `toISOString` fica de fora de propósito: ele converte
 * pra UTC antes de cortar, e às 21h de Brasília "hoje" já virou amanhã — o
 * atalho traria o dia errado justo no horário em que a bilheteria vende.
 */
const isoLocal = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

const ATALHOS = { hoje: 'Hoje', ontem: 'Ontem', mes: 'Este mês', tudo: 'Tudo' } as const
type Atalho = keyof typeof ATALHOS

function faixaDo(qual: Atalho): [string, string] {
  const hoje = new Date()
  if (qual === 'tudo') return ['', '']
  if (qual === 'hoje') return [isoLocal(hoje), isoLocal(hoje)]
  if (qual === 'ontem') {
    const o = new Date(hoje); o.setDate(o.getDate() - 1)
    return [isoLocal(o), isoLocal(o)]
  }
  return [isoLocal(new Date(hoje.getFullYear(), hoje.getMonth(), 1)), isoLocal(hoje)]
}

function periodo(qual: Atalho) {
  const [d, a] = faixaDo(qual)
  de.value = d; ate.value = a
}

/** qual atalho corresponde ao recorte atual — sem isso o botão não mostra onde se está */
const atalhoAtivo = computed<Atalho | null>(() => {
  for (const k of Object.keys(ATALHOS) as Atalho[]) {
    const [d, a] = faixaDo(k)
    if (d === de.value && a === ate.value) return k
  }
  return null
})

/**
 * Líquido do produtor no recorte inteiro.
 *
 * Somado a partir do `porCanal`, que já sabe quem pagou a taxa em cada canal.
 * Recalcular aqui com um modo só seria o jeito mais fácil de a tela inventar
 * um número que o borderô não confirma.
 */
const liquido = computed(() =>
  (data.value?.porCanal ?? []).reduce((s: number, c: any) => s + c.liquidoCents, 0))

function exportar() {
  baixarCsv(
    `extrato-${id.slice(0, 8)}${de.value ? `-${de.value}` : ''}`,
    ['Pedido', 'Status', 'Pago em', 'Canal', 'Ponto', 'Operador', 'Forma', 'Parcelas',
     'Comprador', 'E-mail', 'Documento', 'Promoter', 'Cupom', 'Ingressos',
     'Face', 'Taxa do comprador', 'Taxa da plataforma', 'Desconto', 'Total cobrado',
     'Estornado'],
    (data.value?.linhas ?? []).map((l: any) => [
      l.pedido, STATUS_LEGIVEL[l.status] ?? l.status, horario(l.pagoEm),
      l.canal, l.ponto ?? '', l.operador ?? '', formaLegivel(l.forma),
      l.parcelas, l.comprador ?? '', l.email ?? '', l.documento ?? '',
      l.promoter ?? '', l.cupom ?? '', l.ingressos,
      brl(l.faceCents), brl(l.taxaCompradorCents), brl(l.taxaPlataformaCents),
      brl(l.descontoCents), brl(l.totalCents), brl(l.estornadoCents),
    ]))
}

useHead({ title: 'Extrato' })
</script>

<template>
  <div>
    <div class="flex flex-wrap items-start justify-between gap-3 py-5">
      <div>
        <h1 class="titulo text-2xl font-bold text-tinta">Extrato</h1>
        <p class="mt-1 text-tinta-suave">
          Todo dinheiro que entrou, linha a linha. Data de pagamento, não de criação.
        </p>
      </div>
      <button type="button" class="btn-secundario" :disabled="!data?.linhas?.length"
              @click="exportar">
        <IconeMenu nome="exportar" :tamanho="18" /> Exportar
      </button>
    </div>

    <AbasSecao :evento-id="id" />

    <!-- recorte -->
    <div class="card mt-5">
      <div class="flex flex-wrap items-end gap-3">
        <label class="block">
          <span class="rotulo">De</span>
          <input v-model="de" type="date" class="campo w-40">
        </label>
        <label class="block">
          <span class="rotulo">Até</span>
          <input v-model="ate" type="date" class="campo w-40">
        </label>
        <label class="block">
          <span class="rotulo">Canal</span>
          <select v-model="canal" class="campo w-44">
            <option value="">Todos</option>
            <option value="online">Site</option>
            <option value="bilheteria">Bilheteria</option>
            <option value="pdv_produtor">PDV do produtor</option>
            <option value="pdv_ticketeira">PDV da ticketeira</option>
            <option value="cortesia">Cortesia</option>
          </select>
        </label>
        <label v-if="data?.pontos?.length" class="block">
          <span class="rotulo">Ponto de venda</span>
          <select v-model="ponto" class="campo w-48">
            <option value="">Todos</option>
            <option v-for="p in data.pontos" :key="p.id" :value="p.id">{{ p.nome }}</option>
          </select>
        </label>
        <label class="block">
          <span class="rotulo">Forma</span>
          <select v-model="forma" class="campo w-36">
            <option value="">Todas</option>
            <option value="pix">Pix</option>
            <option value="credito">Crédito</option>
            <option value="debito">Débito</option>
            <option value="dinheiro">Dinheiro</option>
            <option value="cortesia">Cortesia</option>
          </select>
        </label>
        <button v-if="temFiltro" type="button" class="btn-secundario" @click="limpar">
          Limpar filtros
        </button>
      </div>

      <div class="mt-3 flex flex-wrap items-center gap-2 border-t border-linha pt-3">
        <span class="text-xs text-tinta-fraca">Período:</span>
        <button v-for="(rotulo, chave) in ATALHOS" :key="chave" type="button"
                :class="atalhoAtivo === chave ? 'chip-ativo' : 'chip'"
                @click="periodo(chave)">
          {{ rotulo }}
        </button>
      </div>
    </div>

    <p v-if="falha" class="faixa-erro mt-4">Não consegui carregar o extrato.
      <button type="button" class="underline" @click="refresh()">Tentar de novo</button>
    </p>

    <template v-if="data">
      <!-- resumo do recorte -->
      <div class="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div class="card">
          <p class="rotulo-kpi">Cobrado do comprador</p>
          <p class="numero-kpi mt-1">{{ brl(data.totais.cobradoCents) }}</p>
          <p class="mt-1 text-xs text-tinta-fraca">
            {{ data.totais.pedidos }} pedidos · {{ data.totais.ingressos }} ingressos
          </p>
        </div>
        <div class="card">
          <p class="rotulo-kpi">Face dos ingressos</p>
          <p class="numero-kpi mt-1">{{ brl(data.totais.faceCents) }}</p>
          <p class="mt-1 text-xs text-tinta-fraca">
            desconto aplicado {{ brl(data.totais.descontoCents) }}
          </p>
        </div>
        <div class="card">
          <p class="rotulo-kpi">Taxa da plataforma</p>
          <p class="numero-kpi mt-1">{{ brl(data.totais.taxaPlataformaCents) }}</p>
          <p class="mt-1 text-xs text-tinta-fraca">
            {{ (data.evento.feeBps / 100).toLocaleString('pt-BR') }}% sobre a face
          </p>
        </div>
        <div class="card">
          <p class="rotulo-kpi">Líquido do produtor</p>
          <p class="numero-kpi mt-1">{{ brl(liquido) }}</p>
          <p v-if="data.totais.estornadoCents" class="mt-1 text-xs text-erro">
            já sem {{ brl(data.totais.estornadoCents) }} estornados
          </p>
          <p v-else class="mt-1 text-xs text-tinta-fraca">nenhum estorno no período</p>
        </div>
      </div>

      <!-- cortes -->
      <div class="mt-4 grid gap-3 lg:grid-cols-3">
        <div class="card p-0">
          <p class="titulo border-b border-linha px-4 py-3 text-sm font-bold text-tinta">
            Por canal
          </p>
          <p v-if="!data.porCanal.length" class="px-4 py-6 text-sm text-tinta-fraca">
            Nada no período.
          </p>
          <div v-for="c in data.porCanal" :key="c.canal"
               class="border-b border-linha px-4 py-3 last:border-0">
            <div class="flex items-baseline justify-between gap-2">
              <span class="font-medium text-tinta">{{ c.nome }}</span>
              <span class="tabular-nums text-tinta">{{ brl(c.cobradoCents) }}</span>
            </div>
            <p class="mt-0.5 text-xs text-tinta-fraca">
              {{ c.pedidos }} pedidos · {{ c.ingressos }} ingressos
              <!-- cortesia não tem taxa: dizer quem a pagou seria ruído -->
              <template v-if="c.taxaPagaPor"> · taxa paga
                {{ c.taxaPagaPor === 'os dois' ? 'em parte pelo produtor' : `pelo ${c.taxaPagaPor}` }}
              </template>
            </p>
            <p v-if="c.cobradoCents" class="mt-0.5 text-xs text-tinta-suave">
              líquido {{ brl(c.liquidoCents) }}
            </p>
          </div>
        </div>

        <div class="card p-0">
          <p class="titulo border-b border-linha px-4 py-3 text-sm font-bold text-tinta">
            Por ponto de venda
          </p>
          <p v-if="!data.porPonto.length" class="px-4 py-6 text-sm text-tinta-fraca">
            Nenhuma venda de balcão no período.
          </p>
          <div v-for="p in data.porPonto" :key="(p.id ?? 'sem') + (p.operador ?? '')"
               class="border-b border-linha px-4 py-3 last:border-0">
            <div class="flex items-baseline justify-between gap-2">
              <span class="font-medium" :class="p.semPonto ? 'text-tinta-suave' : 'text-tinta'">
                {{ p.ponto }}
              </span>
              <span class="tabular-nums text-tinta">{{ brl(p.cobradoCents) }}</span>
            </div>
            <p class="mt-0.5 text-xs text-tinta-fraca">
              <template v-if="p.operador">{{ p.operador }} · </template>
              {{ p.pedidos }} pedidos · {{ p.ingressos }} ingressos
            </p>
            <p v-if="p.semPonto" class="mt-0.5 text-xs text-alerta">
              venda de balcão anterior ao cadastro dos guichês
            </p>
            <p v-else class="mt-0.5 text-xs text-tinta-suave">
              em dinheiro {{ brl(p.dinheiroCents) }}
            </p>
          </div>
        </div>

        <div class="card p-0">
          <p class="titulo border-b border-linha px-4 py-3 text-sm font-bold text-tinta">
            Por forma de pagamento
          </p>
          <p v-if="!data.porForma.length" class="px-4 py-6 text-sm text-tinta-fraca">
            Nada no período.
          </p>
          <div v-for="f in data.porForma" :key="f.forma"
               class="flex items-baseline justify-between gap-2 border-b border-linha px-4 py-3 last:border-0">
            <div>
              <p class="font-medium text-tinta">{{ formaLegivel(f.forma) }}</p>
              <p class="text-xs text-tinta-fraca">{{ f.pedidos }} pedidos</p>
            </div>
            <span class="tabular-nums text-tinta">{{ brl(f.cobradoCents) }}</span>
          </div>
        </div>
      </div>

      <!-- por dia -->
      <div v-if="data.porDia.length > 1" class="card mt-4 p-0">
        <p class="titulo border-b border-linha px-4 py-3 text-sm font-bold text-tinta">
          Por dia de pagamento
        </p>
        <div class="overflow-x-auto">
          <table class="w-full min-w-[520px] border-collapse text-sm">
            <thead>
              <tr class="border-b border-linha bg-fundo-cinza/60 text-left">
                <th class="titulo px-4 py-2 text-xs font-bold uppercase tracking-wide text-tinta-rotulo">Dia</th>
                <th class="titulo px-3 py-2 text-right text-xs font-bold uppercase tracking-wide text-tinta-rotulo">Pedidos</th>
                <th class="titulo px-3 py-2 text-right text-xs font-bold uppercase tracking-wide text-tinta-rotulo">Ingressos</th>
                <th class="titulo px-3 py-2 text-right text-xs font-bold uppercase tracking-wide text-tinta-rotulo">Face</th>
                <th class="titulo px-3 py-2 text-right text-xs font-bold uppercase tracking-wide text-tinta-rotulo">Taxa</th>
                <th class="titulo px-4 py-2 text-right text-xs font-bold uppercase tracking-wide text-tinta-rotulo">Cobrado</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="d in data.porDia" :key="d.dia" class="border-b border-linha last:border-0">
                <td class="px-4 py-2.5 text-tinta">{{ dia(d.dia) }}</td>
                <td class="px-3 py-2.5 text-right tabular-nums text-tinta-suave">{{ d.pedidos }}</td>
                <td class="px-3 py-2.5 text-right tabular-nums text-tinta-suave">{{ d.ingressos }}</td>
                <td class="px-3 py-2.5 text-right tabular-nums text-tinta-suave">{{ brl(d.faceCents) }}</td>
                <td class="px-3 py-2.5 text-right tabular-nums text-tinta-fraca">{{ brl(d.taxaCents) }}</td>
                <td class="px-4 py-2.5 text-right font-medium tabular-nums text-tinta">{{ brl(d.cobradoCents) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- as linhas -->
      <p v-if="!data.linhas.length" class="card mt-4 py-12 text-center text-tinta-suave">
        {{ temFiltro ? 'Nenhum pedido neste recorte.' : 'Nenhum pedido pago ainda.' }}
      </p>

      <div v-else class="card mt-4 overflow-x-auto p-0">
        <div class="flex items-center justify-between border-b border-linha px-4 py-3">
          <p class="titulo text-sm font-bold text-tinta">
            {{ data.linhas.length }} {{ data.linhas.length === 1 ? 'pedido' : 'pedidos' }}
          </p>
          <p v-if="data.truncado" class="text-xs text-alerta">
            mostrando os {{ data.filtros.limite }} mais recentes — use o filtro de período
            pra ver o resto
          </p>
        </div>
        <table class="w-full min-w-[1080px] border-collapse text-sm">
          <thead>
            <tr class="border-b border-linha bg-fundo-cinza/60 text-left">
              <th class="titulo px-4 py-2 text-xs font-bold uppercase tracking-wide text-tinta-rotulo">Pedido</th>
              <th class="titulo px-3 py-2 text-xs font-bold uppercase tracking-wide text-tinta-rotulo">Pago em</th>
              <th class="titulo px-3 py-2 text-xs font-bold uppercase tracking-wide text-tinta-rotulo">Comprador</th>
              <th class="titulo px-3 py-2 text-xs font-bold uppercase tracking-wide text-tinta-rotulo">Canal</th>
              <th class="titulo px-3 py-2 text-xs font-bold uppercase tracking-wide text-tinta-rotulo">Forma</th>
              <th class="titulo px-3 py-2 text-right text-xs font-bold uppercase tracking-wide text-tinta-rotulo">Ingr.</th>
              <th class="titulo px-3 py-2 text-right text-xs font-bold uppercase tracking-wide text-tinta-rotulo">Face</th>
              <th class="titulo px-3 py-2 text-right text-xs font-bold uppercase tracking-wide text-tinta-rotulo">Taxa</th>
              <th class="titulo px-4 py-2 text-right text-xs font-bold uppercase tracking-wide text-tinta-rotulo">Cobrado</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="l in data.linhas" :key="l.id" class="border-b border-linha last:border-0">
              <td class="px-4 py-3">
                <NuxtLink :to="`/admin/pedido/${l.id}`"
                          class="font-medium text-acao hover:underline">{{ l.pedido }}</NuxtLink>
                <p class="text-xs" :class="COR_DO_STATUS[l.status] ?? 'text-tinta-fraca'">
                  {{ STATUS_LEGIVEL[l.status] ?? l.status }}
                  <template v-if="l.estornadoCents"> · {{ brl(l.estornadoCents) }}</template>
                </p>
              </td>
              <td class="px-3 py-3 whitespace-nowrap text-tinta-suave">{{ horario(l.pagoEm) }}</td>
              <td class="px-3 py-3">
                <p class="text-tinta">{{ l.comprador ?? '—' }}</p>
                <p v-if="l.promoter || l.cupom" class="text-xs text-tinta-fraca">
                  <template v-if="l.promoter">{{ l.promoter }}</template>
                  <template v-if="l.promoter && l.cupom"> · </template>
                  <template v-if="l.cupom">cupom {{ l.cupom }}</template>
                </p>
              </td>
              <td class="px-3 py-3">
                <p class="text-tinta-suave">{{ l.canal }}</p>
                <p v-if="l.ponto" class="text-xs text-tinta-fraca">
                  {{ l.ponto }}<template v-if="l.operador"> · {{ l.operador }}</template>
                </p>
              </td>
              <td class="px-3 py-3">
                <p class="text-tinta-suave">{{ formaLegivel(l.forma) }}</p>
                <p v-if="l.parcelas > 1" class="text-xs text-tinta-fraca">{{ l.parcelas }}×</p>
                <p v-else-if="l.trocoCents" class="text-xs text-tinta-fraca">
                  troco {{ brl(l.trocoCents) }}
                </p>
              </td>
              <td class="px-3 py-3 text-right tabular-nums text-tinta-suave">{{ l.ingressos }}</td>
              <td class="px-3 py-3 text-right tabular-nums text-tinta-suave">{{ brl(l.faceCents) }}</td>
              <td class="px-3 py-3 text-right tabular-nums text-tinta-fraca">
                {{ brl(l.taxaPlataformaCents) }}
              </td>
              <td class="px-4 py-3 text-right font-medium tabular-nums text-tinta">
                {{ brl(l.totalCents) }}
              </td>
            </tr>
          </tbody>
          <tfoot>
            <tr class="border-t-2 border-linha-forte bg-fundo-cinza/40 font-bold">
              <td class="titulo px-4 py-3 text-tinta" colspan="5">
                Total<template v-if="data.truncado"> das linhas visíveis</template>
              </td>
              <td class="px-3 py-3 text-right tabular-nums text-tinta">
                {{ data.linhas.reduce((s: number, l: any) => s + l.ingressos, 0) }}
              </td>
              <td class="px-3 py-3 text-right tabular-nums text-tinta">
                {{ brl(data.linhas.reduce((s: number, l: any) => s + l.faceCents, 0)) }}
              </td>
              <td class="px-3 py-3 text-right tabular-nums text-tinta">
                {{ brl(data.linhas.reduce((s: number, l: any) => s + l.taxaPlataformaCents, 0)) }}
              </td>
              <td class="px-4 py-3 text-right tabular-nums text-tinta">
                {{ brl(data.linhas.reduce((s: number, l: any) => s + l.totalCents, 0)) }}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </template>

    <p v-else-if="pending" class="card mt-4 py-12 text-center text-tinta-suave">Carregando…</p>
  </div>
</template>
