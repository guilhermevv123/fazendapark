<script setup lang="ts">
/**
 * Relatórios da organização — todos os eventos juntos.
 *
 * O relatório de dentro do evento responde "como ESTA edição vendeu". Esta tela
 * responde a pergunta de cima: quanto o parque vendeu no período, por qual
 * canal e forma de pagamento, e de onde vem quem compra. Filtrando por um
 * evento, ela mostra o MESMO número do relatório dele (o teste trava isso) —
 * não é outra conta, é a mesma somada.
 *
 * O recorte (evento, de, até) vive na URL: o operador manda o link do que está
 * vendo. O período é pelo dia do PAGAMENTO, como a curva do relatório do evento.
 */
import { baixarCsv } from '~/composables/baixarCsv'

definePageMeta({ layout: 'admin' })

const route = useRoute()

const de = ref(String(route.query.de ?? ''))
const ate = ref(String(route.query.ate ?? ''))
const evento = ref(String(route.query.evento ?? ''))

const params = computed(() => ({
  de: de.value || undefined, ate: ate.value || undefined, evento: evento.value || undefined,
}))

const { data, pending, error: falha, refresh } = await useFetch<any>(
  '/api/admin/relatorios', { query: params })
// a lista completa pro filtro: `porEvento` do relatório encolhe quando já há um filtrado
const { data: eventos } = await useFetch<any[]>('/api/admin/eventos')

watch(params, (p) => {
  navigateTo({ query: Object.fromEntries(Object.entries(p).filter(([, v]) => v)) },
    { replace: true })
})

const temFiltro = computed(() => !!(de.value || ate.value || evento.value))
function limpar() { de.value = ''; ate.value = ''; evento.value = '' }

/* ------------------------------------------------------------ período */

// a régua de período sai de `formato.ts` (relógio LOCAL); `toISOString` converte
// pra UTC e às 21h de Brasília "hoje" já virou amanhã
const ATALHOS = { mes: 'Este mês', d30: '30 dias', d90: '90 dias', ano: 'Este ano', tudo: 'Tudo' } as const
type Atalho = keyof typeof ATALHOS

function faixaDo(qual: Atalho): [string, string] {
  if (qual === 'tudo') return ['', '']
  if (qual === 'mes') return [primeiroDiaDoMes(), diaLocal()]
  if (qual === 'd30') return [diaLocalMais(-29), diaLocal()]
  if (qual === 'd90') return [diaLocalMais(-89), diaLocal()]
  return [`${new Date().getFullYear()}-01-01`, diaLocal()]
}
function periodo(qual: Atalho) { const [d, a] = faixaDo(qual); de.value = d; ate.value = a }
const atalhoAtivo = computed<Atalho | null>(() => {
  for (const k of Object.keys(ATALHOS) as Atalho[]) {
    const [d, a] = faixaDo(k)
    if (d === de.value && a === ate.value) return k
  }
  return null
})

/* ------------------------------------------------------ como cada coisa lê */

const ROTULO_FORMA: Record<string, string> = {
  pix: 'PIX', credito: 'Cartão de crédito', debito: 'Cartão de débito',
  dinheiro: 'Dinheiro', cortesia: 'Cortesia',
}
const ROTULO_CANAL: Record<string, string> = {
  online: 'Site', bilheteria: 'Bilheteria', cortesia: 'Cortesia',
}
const ROTULO_SITUACAO: Record<string, string> = {
  ativo: 'Publicado', rascunho: 'Rascunho', pausado: 'Pausado', encerrado: 'Encerrado',
}
// mesmo dicionário de `clientes.vue` e do relatório do evento — status de
// pedido é um vocabulário só, não um por tela
const ROTULO_STATUS: Record<string, string> = {
  pago: 'Pago', aguardando_pagamento: 'Aguardando pagamento', em_analise: 'Em análise',
  expirado: 'Expirou sem pagar', cancelado: 'Cancelado', falhou: 'Pagamento falhou',
  estornado: 'Estornado', estornado_parcial: 'Estornado em parte',
  chargeback: 'Chargeback', disputa: 'Em disputa',
}

const pico = (lista: any[], campo: string) =>
  (lista ?? []).reduce((m: number, x: any) => Math.max(m, x[campo]), 0)
const largura = (v: number, max: number) => `${max ? Math.max((v / max) * 100, v > 0 ? 3 : 0) : 0}%`

const picoDia = computed(() => pico(data.value?.porDia, 'cobradoCents'))
const picoForma = computed(() => pico(data.value?.porForma, 'cobradoCents'))
const picoCanal = computed(() => pico(data.value?.porCanal, 'cobradoCents'))
const picoCobranca = computed(() => pico(data.value?.cobranca?.porStatus, 'pedidos'))
const picoCidade = computed(() => pico(data.value?.clientes?.porCidade, 'clientes'))
const picoFaixa = computed(() => pico(data.value?.clientes?.porFaixa, 'clientes'))
const pct = (parte: number, todo: number) => (todo > 0 ? Math.round((parte / todo) * 100) : 0)

/* ----------------------------------------------------------- planilha */

function exportar() {
  const r = data.value.resumo
  const linhas: (string | number)[][] = [
    ['Indicador', 'Valor', ''],
    ['Total cobrado', reais(r.cobradoCents), ''],
    ['Líquido do produtor', reais(r.liquidoCents), ''],
    ['Pedidos', r.pedidos, ''],
    ['Ingressos', r.ingressos, ''],
    ['Clientes', r.clientes, ''],
    ['Ticket médio por pedido', reais(r.ticketMedioPorPedidoCents), ''],
    ['', '', ''],
    ['Evento', 'Pedidos', 'Cobrado'],
    ...data.value.porEvento.map((e: any) => [e.nome, e.pedidos, reais(e.cobradoCents)]),
    ['', '', ''],
    ['Dia', 'Pedidos', 'Cobrado'],
    ...data.value.porDia.map((d: any) => [dataCurta(d.dia), d.pedidos, reais(d.cobradoCents)]),
  ]
  const [cab, ...resto] = linhas
  baixarCsv(`relatorio-organizacao-${diaLocal()}`, cab.map(String), resto)
}

useHead({ title: 'Relatórios' })
</script>

<template>
  <div>
    <div class="flex flex-wrap items-start justify-between gap-3 py-5">
      <div>
        <h1 class="titulo text-2xl font-semibold text-tinta">Relatórios</h1>
        <p class="mt-1 text-tinta-suave">
          As vendas de todos os eventos da organização, e quem compra.
        </p>
      </div>
      <button type="button" class="btn-secundario" :disabled="!data" @click="exportar">
        <IconeMenu nome="exportar" :tamanho="18" /> Exportar
      </button>
    </div>

    <!-- recorte -->
    <div class="card">
      <div class="flex flex-wrap items-end gap-3">
        <label class="block">
          <span class="rotulo">Evento</span>
          <select v-model="evento" class="campo w-64">
            <option value="">Todos os eventos</option>
            <option v-for="e in eventos ?? []" :key="e.id" :value="e.id">{{ e.nome }}</option>
          </select>
        </label>
        <label class="block">
          <span class="rotulo">De</span>
          <input v-model="de" type="date" class="campo w-40">
        </label>
        <label class="block">
          <span class="rotulo">Até</span>
          <input v-model="ate" type="date" class="campo w-40">
        </label>
        <button v-if="temFiltro" type="button" class="btn-secundario" @click="limpar">
          Limpar filtros
        </button>
      </div>
      <div class="mt-3 flex flex-wrap items-center gap-2 border-t border-linha pt-3">
        <span class="text-xs text-tinta-fraca">Período:</span>
        <button v-for="(rotulo, chave) in ATALHOS" :key="chave" type="button"
                :class="atalhoAtivo === chave ? 'chip-ativo' : 'chip'" @click="periodo(chave)">
          {{ rotulo }}
        </button>
      </div>
    </div>

    <template v-if="data">
      <p v-if="!data.resumo.pedidos" class="card mt-4 py-12 text-center text-tinta-suave">
        Nenhuma venda paga nesse recorte.
      </p>

      <template v-else>
        <div class="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div class="card">
            <p class="rotulo-kpi">Total cobrado</p>
            <p class="numero-kpi mt-1">{{ reais(data.resumo.cobradoCents) }}</p>
            <p class="mt-1 text-xs text-tinta-fraca">
              ingressos {{ reais(data.resumo.faceCents) }} + taxa {{ reais(data.resumo.taxaCents) }}
            </p>
          </div>
          <div class="card">
            <p class="rotulo-kpi">Líquido do produtor</p>
            <p class="numero-kpi mt-1">{{ reais(data.resumo.liquidoCents) }}</p>
            <p class="mt-1 text-xs text-tinta-fraca">depois da taxa e das devoluções</p>
          </div>
          <div class="card">
            <p class="rotulo-kpi">Ingressos</p>
            <p class="numero-kpi mt-1">{{ data.resumo.ingressos.toLocaleString('pt-BR') }}</p>
            <p class="mt-1 text-xs text-tinta-fraca">
              em {{ data.resumo.pedidos.toLocaleString('pt-BR') }} pedidos
            </p>
          </div>
          <div class="card">
            <p class="rotulo-kpi">Ticket médio</p>
            <p class="numero-kpi mt-1">{{ reais(data.resumo.ticketMedioPorPedidoCents) }}</p>
            <p class="mt-1 text-xs text-tinta-fraca">
              por pedido · {{ reais(data.resumo.ticketMedioPorIngressoCents) }} por ingresso
            </p>
          </div>
          <div class="card">
            <p class="rotulo-kpi">Clientes</p>
            <p class="numero-kpi mt-1">{{ data.resumo.clientes.toLocaleString('pt-BR') }}</p>
            <p class="mt-1 text-xs text-tinta-fraca">
              pessoas diferentes que compraram
              <template v-if="data.resumo.pedidosSemCliente">
                · {{ data.resumo.pedidosSemCliente }}
                {{ data.resumo.pedidosSemCliente === 1 ? 'venda' : 'vendas' }} sem cliente identificado
              </template>
            </p>
          </div>
          <div class="card">
            <p class="rotulo-kpi">Descontos</p>
            <p class="numero-kpi mt-1">{{ reais(data.resumo.descontoCents) }}</p>
            <p class="mt-1 text-xs text-tinta-fraca">em cupons usados no período</p>
          </div>
        </div>

        <div v-if="data.porDia.length" class="card mt-4">
          <div class="flex items-baseline justify-between">
            <p class="rotulo-kpi">Vendas por dia</p>
            <p class="text-xs text-tinta-fraca">maior dia: {{ reais(picoDia) }}</p>
          </div>
          <div class="mt-3 flex items-end gap-1.5" style="height: 130px">
            <div v-for="d in data.porDia" :key="d.dia" class="group relative min-w-[6px] flex-1"
                 :title="`${dataCurta(d.dia)} — ${d.pedidos} pedidos, ${reais(d.cobradoCents)}`">
              <div class="rounded-t bg-acao transition-opacity group-hover:opacity-75"
                   :style="{ height: `${picoDia ? Math.max((d.cobradoCents / picoDia) * 118, 2) : 2}px` }" />
            </div>
          </div>
          <div class="mt-1 flex justify-between text-xs text-tinta-fraca">
            <span>{{ dataCurta(data.porDia[0].dia) }}</span>
            <span>{{ data.porDia.length }} dias com venda</span>
            <span>{{ dataCurta(data.porDia[data.porDia.length - 1].dia) }}</span>
          </div>
        </div>

        <div class="card mt-4 p-0">
          <p class="titulo border-b border-linha px-4 py-3 text-sm font-semibold text-tinta-rotulo">
            Por evento
          </p>
          <div class="overflow-x-auto">
            <table class="w-full min-w-[34rem] text-sm">
              <tbody>
                <tr v-for="e in data.porEvento" :key="e.id" class="border-b border-linha last:border-0">
                  <td class="px-4 py-2.5">
                    <NuxtLink :to="`/admin/evento/${e.id}/relatorios`" class="text-tinta hover:text-acao hover:underline">
                      {{ e.nome }}
                    </NuxtLink>
                    <p class="text-xs text-tinta-fraca">
                      {{ dataCurta(e.comeca) }} · {{ ROTULO_SITUACAO[e.situacao] ?? e.situacao }}
                    </p>
                  </td>
                  <td class="px-3 py-2.5 text-right tabular-nums text-tinta-suave">
                    {{ e.ingressos }} ing. · {{ e.pedidos }} ped.
                  </td>
                  <td class="px-3 py-2.5 text-right tabular-nums text-tinta">{{ reais(e.cobradoCents) }}</td>
                  <td class="px-4 py-2.5 text-right tabular-nums text-tinta-suave">
                    {{ reais(e.liquidoCents) }}
                    <span class="block text-xs text-tinta-fraca">líquido</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div class="mt-4 grid gap-3 lg:grid-cols-2">
          <div class="card">
            <p class="rotulo-kpi">Forma de pagamento</p>
            <table class="mt-3 w-full text-sm">
              <tbody>
                <tr v-for="f in data.porForma" :key="f.forma ?? 'sem'" class="border-b border-linha last:border-0">
                  <td class="py-2 text-tinta">{{ ROTULO_FORMA[f.forma] ?? 'Não informada' }}</td>
                  <td class="py-2 text-right tabular-nums text-tinta-suave">{{ f.pedidos }}</td>
                  <td class="w-24 py-2 pl-3">
                    <div class="h-1.5 rounded-full bg-fundo-cinza">
                      <div class="h-1.5 rounded-full bg-acao" :style="{ width: largura(f.cobradoCents, picoForma) }" />
                    </div>
                  </td>
                  <td class="py-2 text-right tabular-nums text-tinta">{{ reais(f.cobradoCents) }}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div class="card">
            <p class="rotulo-kpi">Onde a venda aconteceu</p>
            <table class="mt-3 w-full text-sm">
              <tbody>
                <tr v-for="c in data.porCanal" :key="c.canal" class="border-b border-linha last:border-0">
                  <td class="py-2 text-tinta">{{ ROTULO_CANAL[c.canal] ?? c.canal }}</td>
                  <td class="py-2 text-right tabular-nums text-tinta-suave">{{ c.pedidos }}</td>
                  <td class="w-24 py-2 pl-3">
                    <div class="h-1.5 rounded-full bg-fundo-cinza">
                      <div class="h-1.5 rounded-full bg-acao" :style="{ width: largura(c.cobradoCents, picoCanal) }" />
                    </div>
                  </td>
                  <td class="py-2 text-right tabular-nums text-tinta">{{ reais(c.cobradoCents) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </template>

      <!-- fora do v-else: tem que aparecer mesmo sem venda paga (todo mundo com PIX pendente) -->
      <div v-if="data.cobranca?.porStatus?.length" class="card mt-4">
        <p class="rotulo-kpi">Cobrança</p>
        <table class="mt-3 w-full text-sm">
          <tbody>
            <tr v-for="s in data.cobranca.porStatus" :key="s.status"
                class="border-b border-linha last:border-0">
              <td class="py-2 text-tinta">{{ ROTULO_STATUS[s.status] ?? s.status }}</td>
              <td class="py-2 text-right tabular-nums text-tinta-suave">{{ s.pedidos }}</td>
              <td class="w-24 py-2 pl-3">
                <div class="h-1.5 rounded-full bg-fundo-cinza">
                  <div class="h-1.5 rounded-full"
                       :class="s.status === 'pago' ? 'bg-ok' : s.status === 'aguardando_pagamento' ? 'bg-alerta' : 'bg-linha-forte'"
                       :style="{ width: largura(s.pedidos, picoCobranca) }" />
                </div>
              </td>
              <td class="w-12 py-2 text-right text-xs tabular-nums text-tinta-fraca">
                {{ pct(s.pedidos, data.cobranca.criados) }}%
              </td>
              <td class="py-2 pl-3 text-right tabular-nums text-tinta">{{ reais(s.cobradoCents) }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <template v-if="data.resumo.pedidos">
        <!-- quem compra -->
        <div class="card mt-4">
          <div class="flex flex-wrap items-baseline justify-between gap-2">
            <p class="rotulo-kpi">Quem compra</p>
            <NuxtLink to="/admin/clientes" class="text-sm text-acao hover:underline">Ver os clientes</NuxtLink>
          </div>
          <p class="mt-1 text-xs text-tinta-fraca">
            {{ data.clientes.total.toLocaleString('pt-BR') }} clientes no recorte ·
            {{ pct(data.clientes.comCadastro, data.clientes.total) }}% com cadastro completo ·
            {{ pct(data.clientes.aceitamNovidades, data.clientes.total) }}% aceitam novidades
          </p>

          <div class="mt-4 grid gap-6 lg:grid-cols-2">
            <div>
              <p class="text-sm font-semibold text-tinta">De onde vêm</p>
              <p v-if="!data.clientes.porCidade.length" class="mt-2 text-sm text-tinta-fraca">
                Ninguém informou a cidade ainda. Ela vem do formulário de compra do site.
              </p>
              <table v-else class="mt-2 w-full text-sm">
                <tbody>
                  <tr v-for="c in data.clientes.porCidade" :key="`${c.estado}|${c.cidade}`"
                      class="border-b border-linha last:border-0">
                    <td class="py-1.5 text-tinta">{{ c.cidade }} <span class="text-xs text-tinta-fraca">{{ c.estado }}</span></td>
                    <td class="w-28 py-1.5 pl-3">
                      <div class="h-1.5 rounded-full bg-fundo-cinza">
                        <div class="h-1.5 rounded-full bg-acao" :style="{ width: largura(c.clientes, picoCidade) }" />
                      </div>
                    </td>
                    <td class="w-10 py-1.5 text-right tabular-nums text-tinta-suave">{{ c.clientes }}</td>
                  </tr>
                </tbody>
              </table>
              <p v-if="data.clientes.semCidade" class="mt-2 text-xs text-tinta-fraca">
                {{ data.clientes.semCidade }} sem cidade informada.
              </p>
            </div>

            <div>
              <p class="text-sm font-semibold text-tinta">Faixa de idade</p>
              <p v-if="data.clientes.semIdade === data.clientes.total" class="mt-2 text-sm text-tinta-fraca">
                Ninguém informou a idade ainda. Ela vem do formulário de compra do site.
              </p>
              <table v-else class="mt-2 w-full text-sm">
                <tbody>
                  <tr v-for="f in data.clientes.porFaixa" :key="f.chave" class="border-b border-linha last:border-0">
                    <td class="py-1.5 text-tinta">{{ f.rotulo }}</td>
                    <td class="w-28 py-1.5 pl-3">
                      <div class="h-1.5 rounded-full bg-fundo-cinza">
                        <div class="h-1.5 rounded-full bg-acao" :style="{ width: largura(f.clientes, picoFaixa) }" />
                      </div>
                    </td>
                    <td class="w-10 py-1.5 text-right tabular-nums text-tinta-suave">{{ f.clientes }}</td>
                  </tr>
                </tbody>
              </table>
              <p v-if="data.clientes.semIdade" class="mt-2 text-xs text-tinta-fraca">
                {{ data.clientes.semIdade }} sem idade informada.
              </p>
            </div>
          </div>
        </div>

        <div v-if="data.topCompradores.length" class="card mt-4 p-0">
          <p class="titulo border-b border-linha px-4 py-3 text-sm font-semibold text-tinta-rotulo">
            Quem mais comprou
          </p>
          <!-- e-mail comprido não quebra sozinho: a tabela rola dentro do cartão em vez de esticar a página -->
          <div class="overflow-x-auto">
          <table class="w-full min-w-[28rem] text-sm">
            <tbody>
              <tr v-for="(c, i) in data.topCompradores" :key="c.id" class="border-b border-linha last:border-0">
                <td class="w-8 px-4 py-2.5 text-xs tabular-nums text-tinta-fraca">{{ i + 1 }}</td>
                <td class="py-2.5">
                  <p class="text-tinta">{{ c.nome }}</p>
                  <p class="text-xs text-tinta-fraca">{{ c.email }}</p>
                </td>
                <td class="px-3 py-2.5 text-right tabular-nums text-tinta-suave">
                  {{ c.pedidos }} ped. · {{ c.ingressos }} ing.
                </td>
                <td class="px-4 py-2.5 text-right font-medium tabular-nums text-tinta">{{ reais(c.gastoCents) }}</td>
              </tr>
            </tbody>
          </table>
          </div>
        </div>
      </template>
    </template>

    <p v-else-if="pending" class="card mt-6 text-tinta-suave">Carregando…</p>

    <div v-else class="card mt-6">
      <p class="rotulo-kpi text-erro">Não foi possível carregar o relatório</p>
      <p class="mt-1 text-sm text-tinta-suave">
        {{ (falha as any)?.data?.statusMessage || (falha as any)?.message || 'Erro desconhecido.' }}
      </p>
      <button type="button" class="btn-secundario mt-3" @click="refresh()">Tentar de novo</button>
    </div>
  </div>
</template>
