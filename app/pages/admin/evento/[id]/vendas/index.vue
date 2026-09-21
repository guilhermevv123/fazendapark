<script setup lang="ts">
/**
 * Vendas: a lista de pedidos, com a ficha completa num painel lateral.
 *
 * O painel abre ao lado em vez de navegar pra outra página porque a pergunta
 * que traz alguém aqui quase nunca é sobre UM pedido — é "achei três com o
 * mesmo nome, qual deles pagou". Trocar de página a cada conferência perde o
 * filtro e o lugar da lista.
 */
definePageMeta({ layout: 'admin' })

const route = useRoute()
const id = route.params.id as string

const busca = ref('')
const situacao = ref('')
const canal = ref('')
const pagina = ref(1)

// debounce na busca: cada tecla disparando consulta é o jeito mais fácil de
// transformar uma lista de 10 mil pedidos em travamento.
const buscaDebounced = ref('')
let timer: any
watch(busca, (v) => {
  clearTimeout(timer)
  timer = setTimeout(() => { buscaDebounced.value = v; pagina.value = 1 }, 300)
})
watch([situacao, canal], () => { pagina.value = 1 })

const { data, pending, error: falha, refresh } = await useFetch<any>(
  () => `/api/admin/evento/${id}/vendas`, {
    query: { busca: buscaDebounced, situacao, canal, pagina },
  })

// `reais` e `diaMesHora` vêm de `app/composables/formato.ts` — a formatação
// de centavo e de data mora num lugar só.
const quando = diaMesHora

const SITUACOES: Record<string, { texto: string; classe: string }> = {
  pago:                 { texto: 'PAGO',      classe: 'selo-ok' },
  aguardando_pagamento: { texto: 'AGUARDANDO', classe: 'selo-alerta' },
  cancelado:            { texto: 'CANCELADO', classe: 'selo-erro' },
  expirado:             { texto: 'EXPIRADO',  classe: 'selo-neutro' },
  estornado:            { texto: 'ESTORNADO', classe: 'selo-erro' },
  rascunho:             { texto: 'RASCUNHO',  classe: 'selo-neutro' },
}
const CANAIS: Record<string, string> = {
  online: 'Online', bilheteria: 'Bilheteria', pdv_produtor: 'PDV',
  pdv_ticketeira: 'PDV ticketeira', cortesia: 'Cortesia',
}
const FORMAS: Record<string, string> = {
  pix: 'PIX', credito: 'Crédito', debito: 'Débito', dinheiro: 'Dinheiro', cortesia: 'Cortesia',
}

/* ------------------------------------------------------------ ficha ----- */
const abertoId = ref('')
const { data: ficha, pending: carregandoFicha } = await useFetch<any>(
  () => (abertoId.value ? `/api/admin/pedido/${abertoId.value}` : ''),
  { immediate: false, watch: [abertoId] })

const paginas = computed(() => Math.max(1, Math.ceil((data.value?.total ?? 0) / (data.value?.porPagina ?? 50))))

useHead({ title: 'Vendas' })
</script>

<template>
  <div>
    <div class="flex flex-wrap items-end justify-between gap-3 py-5">
      <div>
        <h1 class="titulo text-2xl font-bold text-tinta">Vendas</h1>
        <p class="mt-1 text-tinta-suave">Todo pedido do evento, pago ou não.</p>
      </div>
    </div>

    <AbasSecao :evento-id="id" />

    <!-- filtros -->
    <div class="card mb-4 flex flex-wrap items-center gap-3">
      <div class="relative min-w-[260px] flex-1">
        <span class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-tinta-fraca">
          <IconeMenu nome="busca" :tamanho="16" />
        </span>
        <input v-model="busca" class="campo pl-9"
               placeholder="Código do pedido, nome, e-mail, CPF ou telefone">
      </div>
      <select v-model="situacao" class="campo w-auto">
        <option value="">Todas as situações</option>
        <option v-for="(v, k) in SITUACOES" :key="k" :value="k">{{ v.texto }}</option>
      </select>
      <select v-model="canal" class="campo w-auto">
        <option value="">Todos os canais</option>
        <option v-for="(v, k) in CANAIS" :key="k" :value="k">{{ v }}</option>
      </select>
    </div>

    <!-- totais do filtro atual -->
    <div v-if="data" class="mb-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <div class="card">
        <p class="rotulo-kpi">Recebido</p>
        <p class="numero-kpi mt-1 text-ok">{{ reais(data.totais.pagoCents) }}</p>
      </div>
      <div class="card">
        <p class="rotulo-kpi">Aguardando</p>
        <p class="numero-kpi mt-1 text-alerta">{{ reais(data.totais.pendenteCents) }}</p>
      </div>
      <div class="card">
        <p class="rotulo-kpi">Ingressos pagos</p>
        <p class="numero-kpi mt-1">{{ data.totais.ingressosPagos }}</p>
      </div>
      <div class="card">
        <p class="rotulo-kpi">Pedidos</p>
        <p class="numero-kpi mt-1">{{ data.totais.pedidos }}</p>
        <p v-if="data.totais.estornadoCents" class="mt-1 text-sm text-erro">
          {{ reais(data.totais.estornadoCents) }} estornado
        </p>
      </div>
    </div>

    <p v-if="falha" class="card border-erro text-erro">
      Não foi possível carregar as vendas.
      <button type="button" class="ml-2 underline" @click="refresh()">Tentar de novo</button>
    </p>

    <!-- lista -->
    <div v-else-if="data" class="card overflow-x-auto p-0">
      <table class="w-full text-sm">
        <thead class="border-b border-linha text-left text-xs uppercase text-tinta-fraca">
          <tr>
            <th class="px-4 py-3 font-medium">Pedido</th>
            <th class="px-4 py-3 font-medium">Cliente</th>
            <th class="px-4 py-3 font-medium">Canal</th>
            <th class="px-4 py-3 text-right font-medium">Ingressos</th>
            <th class="px-4 py-3 text-right font-medium">Total</th>
            <th class="px-4 py-3 font-medium">Situação</th>
            <th class="px-4 py-3 font-medium">Quando</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="p in data.pedidos" :key="p.id"
              class="cursor-pointer border-b border-linha last:border-0 hover:bg-acao-fraco"
              @click="abertoId = p.id">
            <td class="whitespace-nowrap px-4 py-3 font-medium text-tinta">{{ p.codigo }}</td>
            <td class="px-4 py-3">
              <p class="text-tinta">{{ p.cliente ?? '—' }}</p>
              <p class="text-xs text-tinta-fraca">{{ p.email }}</p>
            </td>
            <td class="whitespace-nowrap px-4 py-3 text-tinta-suave">
              {{ CANAIS[p.canal] ?? p.canal }}
              <span v-if="p.forma" class="text-tinta-fraca">· {{ FORMAS[p.forma] ?? p.forma }}</span>
            </td>
            <td class="px-4 py-3 text-right tabular-nums text-tinta">
              {{ p.itens }}
              <span v-if="p.entraram" class="text-xs text-ok">({{ p.entraram }} entrou)</span>
            </td>
            <td class="px-4 py-3 text-right tabular-nums font-medium text-tinta">
              {{ reais(p.totalCents) }}
            </td>
            <td class="px-4 py-3">
              <span :class="SITUACOES[p.situacao]?.classe ?? 'selo-neutro'">
                {{ SITUACOES[p.situacao]?.texto ?? p.situacao }}
              </span>
            </td>
            <td class="whitespace-nowrap px-4 py-3 text-tinta-suave">
              {{ quando(p.pagoEm ?? p.criadoEm) }}
            </td>
          </tr>
          <tr v-if="!data.pedidos.length">
            <td colspan="7" class="px-4 py-12 text-center text-tinta-suave">
              Nenhum pedido com esses filtros.
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <p v-else-if="pending" class="card text-tinta-suave">Carregando…</p>

    <!-- paginação -->
    <div v-if="paginas > 1" class="mt-4 flex items-center justify-center gap-2">
      <button type="button" class="btn-secundario" :disabled="pagina <= 1" @click="pagina--">
        Anterior
      </button>
      <span class="text-sm text-tinta-suave">página {{ pagina }} de {{ paginas }}</span>
      <button type="button" class="btn-secundario" :disabled="pagina >= paginas" @click="pagina++">
        Próxima
      </button>
    </div>

    <!-- ficha do pedido -->
    <div v-if="abertoId" class="fixed inset-0 z-30 flex justify-end bg-black/30"
         @click.self="abertoId = ''">
      <aside class="flex h-full w-full max-w-lg flex-col overflow-y-auto bg-white shadow-xl">
        <header class="sticky top-0 flex items-center gap-3 border-b border-linha bg-white px-5 py-4">
          <h2 class="titulo text-lg font-bold text-tinta">
            {{ ficha?.pedido?.codigo ?? 'Pedido' }}
          </h2>
          <span v-if="ficha" :class="SITUACOES[ficha.pedido.situacao]?.classe ?? 'selo-neutro'">
            {{ SITUACOES[ficha.pedido.situacao]?.texto ?? ficha.pedido.situacao }}
          </span>
          <button type="button" class="ml-auto text-tinta-fraca hover:text-tinta"
                  aria-label="Fechar" @click="abertoId = ''">
            <IconeMenu nome="fechar" />
          </button>
        </header>

        <p v-if="carregandoFicha && !ficha" class="p-5 text-tinta-suave">Carregando…</p>

        <div v-else-if="ficha" class="space-y-5 p-5">
          <section>
            <p class="rotulo-kpi">Cliente</p>
            <p class="mt-1 text-tinta">{{ ficha.cliente.nome ?? '—' }}</p>
            <p class="text-sm text-tinta-suave">{{ ficha.cliente.email }}</p>
            <p class="text-sm text-tinta-suave">
              {{ ficha.cliente.documento ?? 'sem documento' }}
              <template v-if="ficha.cliente.telefone"> · {{ ficha.cliente.telefone }}</template>
            </p>
          </section>

          <section>
            <p class="rotulo-kpi">O que comprou</p>
            <table class="mt-2 w-full text-sm">
              <tbody>
                <tr v-for="(i, k) in ficha.itens" :key="k" class="border-b border-linha last:border-0">
                  <td class="py-2">
                    <p class="text-tinta">{{ i.setor }} · {{ i.lote }}</p>
                    <p class="text-xs text-tinta-fraca">{{ i.tipo ?? 'Inteira' }}</p>
                  </td>
                  <td class="py-2 text-right tabular-nums text-tinta-suave">
                    {{ i.quantidade }} × {{ reais(i.totalCents) }}
                  </td>
                  <td class="py-2 text-right tabular-nums font-medium text-tinta">
                    {{ reais(i.somaCents) }}
                  </td>
                </tr>
              </tbody>
              <tfoot class="border-t-2 border-linha-forte">
                <tr v-if="ficha.pedido.descontoCents">
                  <td colspan="2" class="py-1 text-right text-tinta-suave">Desconto</td>
                  <td class="py-1 text-right tabular-nums text-erro">
                    −{{ reais(ficha.pedido.descontoCents) }}
                  </td>
                </tr>
                <tr>
                  <td colspan="2" class="py-1 text-right font-medium text-tinta">Total</td>
                  <td class="py-1 text-right tabular-nums font-bold text-tinta">
                    {{ reais(ficha.pedido.totalCents) }}
                  </td>
                </tr>
              </tfoot>
            </table>
          </section>

          <section v-if="ficha.ingressos.length">
            <p class="rotulo-kpi">Ingressos emitidos ({{ ficha.ingressos.length }})</p>
            <ul class="mt-2 space-y-1.5">
              <li v-for="t in ficha.ingressos" :key="t.id"
                  class="flex flex-wrap items-center gap-2 rounded-card border border-linha px-3 py-2 text-sm">
                <span class="font-mono text-tinta">{{ t.codigo }}</span>
                <span class="text-tinta-suave">{{ t.setor }}</span>
                <span v-if="t.cortesia" class="selo-neutro">CORTESIA</span>
                <span v-if="t.entrouEm" class="ml-auto text-xs text-ok">
                  entrou {{ quando(t.entrouEm) }}
                  <template v-if="t.validadoPor"> · {{ t.validadoPor }}</template>
                </span>
                <span v-else-if="t.situacao === 'cancelado'" class="ml-auto selo-erro">CANCELADO</span>
                <span v-else class="ml-auto text-xs text-tinta-fraca">não entrou</span>
              </li>
            </ul>
          </section>

          <section>
            <p class="rotulo-kpi">Linha do tempo</p>
            <dl class="mt-2 space-y-1 text-sm">
              <div class="flex justify-between"><dt class="text-tinta-suave">Criado</dt>
                <dd class="text-tinta">{{ quando(ficha.pedido.criadoEm) }}</dd></div>
              <div v-if="ficha.pedido.pagoEm" class="flex justify-between">
                <dt class="text-tinta-suave">Pago</dt>
                <dd class="text-ok">{{ quando(ficha.pedido.pagoEm) }}</dd></div>
              <div v-if="ficha.pedido.canceladoEm" class="flex justify-between">
                <dt class="text-tinta-suave">Cancelado</dt>
                <dd class="text-erro">{{ quando(ficha.pedido.canceladoEm) }}</dd></div>
              <div v-if="ficha.pedido.estornadoEm" class="flex justify-between">
                <dt class="text-tinta-suave">Estornado</dt>
                <dd class="text-erro">{{ quando(ficha.pedido.estornadoEm) }}</dd></div>
            </dl>
          </section>

          <section v-if="ficha.gateway.length">
            <p class="rotulo-kpi">O que o gateway mandou</p>
            <p class="mt-1 text-xs text-tinta-fraca">
              É isto que responde "mas eu paguei": ou o evento chegou, ou não chegou.
            </p>
            <ul class="mt-2 space-y-1 text-sm">
              <li v-for="g in ficha.gateway" :key="g.id"
                  class="flex items-center gap-2 border-b border-linha py-1.5 last:border-0">
                <span class="font-mono text-xs text-tinta">{{ g.tipo }}</span>
                <span v-if="g.resumo.situacao" class="text-tinta-suave">{{ g.resumo.situacao }}</span>
                <span class="ml-auto text-xs text-tinta-fraca">{{ quando(g.em) }}</span>
              </li>
            </ul>
          </section>

          <p v-else class="text-sm text-tinta-fraca">
            Nenhum evento de pagamento registrado para este pedido.
          </p>
        </div>
      </aside>
    </div>
  </div>
</template>
