<script setup lang="ts">
/**
 * Página pública de compra.
 *
 * Duas decisões de produto contra o que a plataforma de origem faz hoje:
 *  1. O preço mostrado é o TOTAL que sai do bolso, com a taxa já dentro e
 *     discriminada embaixo. Descobrir a taxa só no fim do checkout é o que
 *     produz boa parte do abandono (no painel deles: 29%).
 *  2. O resumo acompanha a rolagem no celular. Ninguém rola de volta pra
 *     conferir o total antes de pagar.
 */
const route = useRoute()
const { data, error } = await useFetch<any>(`/api/e/${route.params.slug}`)

const reais = (c: number) =>
  (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })

/** chave do carrinho: loteId|tipoId */
const carrinho = ref<Record<string, number>>({})

function chave(loteId: string, tipoId: string | null) { return `${loteId}|${tipoId ?? ''}` }

function ajustar(lote: any, v: any, delta: number) {
  const k = chave(lote.id, v.tipoId)
  const atual = carrinho.value[k] ?? 0
  const novo = Math.min(Math.max(atual + delta, 0), lote.maxPorCompra)
  if (novo === 0) delete carrinho.value[k]
  else carrinho.value[k] = novo
  carrinho.value = { ...carrinho.value }
}

const itens = computed(() => {
  const saida: any[] = []
  for (const setor of data.value?.setores ?? []) {
    for (const lote of setor.lotes) {
      for (const v of lote.variacoes) {
        const n = carrinho.value[chave(lote.id, v.tipoId)] ?? 0
        if (n > 0) saida.push({ setor, lote, variacao: v, quantidade: n })
      }
    }
  }
  return saida
})

const totais = computed(() => {
  let face = 0, taxa = 0, total = 0, n = 0
  for (const i of itens.value) {
    face += i.variacao.faceCents * i.quantidade
    taxa += i.variacao.taxaCents * i.quantidade
    total += i.variacao.totalCents * i.quantidade
    n += i.quantidade
  }
  return { face, taxa, total, n }
})

const dataFmt = (d: string) =>
  new Date(d).toLocaleDateString('pt-BR', {
    day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })

const ROTULO: Record<string, string> = {
  esgotado: 'Esgotado', encerrado: 'Encerrado', em_breve: 'Em breve',
  fechado: 'Vendas fechadas', ultimas: 'Últimas unidades', disponivel: '',
}

function irParaPagamento() {
  const payload = itens.value.map((i) => ({
    lotId: i.lote.id, ticketTypeId: i.variacao.tipoId, quantidade: i.quantidade,
  }))
  sessionStorage.setItem('dt:carrinho', JSON.stringify({
    slug: route.params.slug, itens: payload, totais: totais.value,
  }))
  navigateTo(`/e/${route.params.slug}/pagamento`)
}

useHead(() => ({
  title: data.value?.evento ? `${data.value.evento.nome} — ingressos` : 'Ingressos',
}))
</script>

<template>
  <div v-if="error" class="mx-auto max-w-2xl px-4 py-24 text-center">
    <p class="titulo text-2xl font-bold text-tinta">Evento não encontrado</p>
    <p class="mt-2 text-tinta-suave">Confira o link ou fale com quem te mandou.</p>
  </div>

  <div v-else-if="data" class="min-h-screen pb-40 lg:pb-16">
    <header class="bg-menu text-white">
      <div class="mx-auto flex max-w-5xl items-center gap-3 px-4 py-3">
        <NuxtLink to="/" class="titulo text-lg font-black tracking-tight">
          diamond<span class="font-normal opacity-70">.tickets</span>
        </NuxtLink>
        <span class="ml-auto truncate text-sm text-white/80">{{ data.evento.organizacao }}</span>
      </div>
    </header>

    <main class="mx-auto max-w-5xl px-4">
      <!-- ======================================================= capa ---- -->
      <section class="card mt-6 overflow-hidden p-0">
        <div class="grid gap-0 md:grid-cols-[1fr_260px]">
          <div class="p-6 md:p-8">
            <span v-if="!data.evento.vendasAbertas" class="selo-neutro mb-3">VENDAS FECHADAS</span>
            <h1 class="titulo text-3xl font-black leading-tight text-tinta md:text-4xl">
              {{ data.evento.nome }}
            </h1>

            <dl class="mt-5 grid gap-3 text-[15px]">
              <div class="flex gap-3">
                <dt class="w-20 shrink-0 text-sm font-medium text-tinta-fraca">Quando</dt>
                <dd class="text-tinta-corpo">
                  {{ dataFmt(data.evento.inicio) }}
                  <span v-if="data.evento.fim" class="text-tinta-suave">
                    até {{ dataFmt(data.evento.fim) }}
                  </span>
                </dd>
              </div>
              <div v-if="!data.evento.local.online" class="flex gap-3">
                <dt class="w-20 shrink-0 text-sm font-medium text-tinta-fraca">Onde</dt>
                <dd>
                  <span class="font-medium text-tinta">{{ data.evento.local.nome }}</span><br>
                  <span class="text-tinta-suave">
                    {{ data.evento.local.endereco }} — {{ data.evento.local.cidade }}/{{ data.evento.local.estado }}
                  </span>
                </dd>
              </div>
              <div v-if="data.evento.classificacao" class="flex gap-3">
                <dt class="w-20 shrink-0 text-sm font-medium text-tinta-fraca">Idade</dt>
                <dd class="text-tinta-corpo">{{ data.evento.classificacao }} anos</dd>
              </div>
            </dl>
          </div>

          <div class="flex items-center border-t border-linha bg-acao-fraco px-6 py-5 md:border-l md:border-t-0">
            <div class="w-full">
              <p class="text-sm font-medium text-tinta-suave">A partir de</p>
              <p class="titulo mt-1 text-3xl font-black text-tinta">
                {{ data.evento.aPartirDeCents != null ? reais(data.evento.aPartirDeCents) : '—' }}
              </p>
              <p class="mt-1 text-xs text-tinta-fraca">taxa de serviço já incluída</p>
            </div>
          </div>
        </div>
      </section>

      <!-- =================================================== seleção ----- -->
      <section class="mt-6 grid gap-6 lg:grid-cols-[1fr_320px]">
        <div>
          <h2 class="titulo text-lg font-bold text-tinta">
            Escolha seus {{ data.evento.substantivo.toLowerCase() }}
          </h2>

          <div v-for="setor in data.setores" :key="setor.id" class="mt-4">
            <div class="flex items-baseline gap-2">
              <h3 class="titulo text-base font-bold text-tinta">{{ setor.nome }}</h3>
              <span v-if="setor.tipo === 'passaporte'" class="selo-neutro">COMBO</span>
            </div>

            <div v-for="lote in setor.lotes" :key="lote.id" class="card mt-2 p-0">
              <div v-for="(v, idx) in lote.variacoes" :key="v.tipoId ?? 'base'"
                   class="flex items-center gap-4 p-4"
                   :class="idx > 0 ? 'border-t border-linha' : ''">
                <div class="min-w-0 flex-1">
                  <p class="font-medium text-tinta">
                    {{ v.nome ?? lote.nome }}
                    <span v-if="v.exigeDocumento" class="text-xs font-normal text-tinta-fraca">
                      · com documento
                    </span>
                  </p>
                  <p class="mt-0.5">
                    <span class="titulo text-lg font-bold text-tinta">{{ reais(v.totalCents) }}</span>
                    <span v-if="v.taxaCents" class="ml-2 text-sm text-tinta-fraca">
                      {{ reais(v.faceCents) }} + {{ reais(v.taxaCents) }} de taxa
                    </span>
                  </p>
                  <p v-if="ROTULO[lote.situacao]" class="mt-1 text-xs font-medium"
                     :class="lote.situacao === 'ultimas' ? 'text-alerta' : 'text-tinta-fraca'">
                    {{ ROTULO[lote.situacao] }}
                  </p>
                </div>

                <div v-if="lote.situacao === 'disponivel' || lote.situacao === 'ultimas'"
                     class="flex shrink-0 items-center gap-1">
                  <button type="button"
                          class="flex h-9 w-9 items-center justify-center rounded-card border border-linha-forte
                                 text-lg leading-none text-tinta hover:bg-fundo-cinza disabled:opacity-30"
                          :disabled="!(carrinho[chave(lote.id, v.tipoId)] > 0)"
                          :aria-label="`Remover um ${v.nome ?? lote.nome}`"
                          @click="ajustar(lote, v, -1)">−</button>
                  <span class="w-8 text-center font-medium tabular-nums text-tinta">
                    {{ carrinho[chave(lote.id, v.tipoId)] ?? 0 }}
                  </span>
                  <button type="button"
                          class="flex h-9 w-9 items-center justify-center rounded-card bg-acao text-lg
                                 leading-none text-white hover:bg-acao-escuro disabled:bg-tinta-fraca"
                          :disabled="v.esgotado || (carrinho[chave(lote.id, v.tipoId)] ?? 0) >= lote.maxPorCompra"
                          :aria-label="`Adicionar um ${v.nome ?? lote.nome}`"
                          @click="ajustar(lote, v, 1)">+</button>
                </div>
              </div>
            </div>
          </div>

          <div v-if="data.evento.descricao" class="card mt-6">
            <h2 class="titulo text-base font-bold text-tinta">Sobre o evento</h2>
            <p class="mt-2 whitespace-pre-line leading-relaxed text-tinta-corpo">
              {{ data.evento.descricao }}
            </p>
          </div>
        </div>

        <!-- resumo: fixo no desktop, barra no celular -->
        <aside class="hidden lg:block">
          <div class="card sticky top-6">
            <p class="rotulo-kpi">Seu pedido</p>

            <p v-if="!totais.n" class="mt-3 text-sm text-tinta-suave">
              Nenhum ingresso escolhido ainda.
            </p>

            <ul v-else class="mt-3 space-y-2 text-sm">
              <li v-for="i in itens" :key="chave(i.lote.id, i.variacao.tipoId)"
                  class="flex justify-between gap-3">
                <span class="min-w-0">
                  <span class="font-medium tabular-nums">{{ i.quantidade }}×</span>
                  <span class="text-tinta-corpo"> {{ i.variacao.nome ?? i.lote.nome }}</span>
                  <span class="block text-xs text-tinta-fraca">{{ i.setor.nome }}</span>
                </span>
                <span class="shrink-0 tabular-nums text-tinta">
                  {{ reais(i.variacao.totalCents * i.quantidade) }}
                </span>
              </li>
            </ul>

            <div v-if="totais.n" class="mt-4 border-t border-linha pt-3 text-sm">
              <div class="flex justify-between text-tinta-suave">
                <span>Ingressos</span><span class="tabular-nums">{{ reais(totais.face) }}</span>
              </div>
              <div v-if="totais.taxa" class="mt-1 flex justify-between text-tinta-suave">
                <span>Taxa de serviço</span><span class="tabular-nums">{{ reais(totais.taxa) }}</span>
              </div>
              <div class="mt-2 flex items-baseline justify-between border-t border-linha pt-2">
                <span class="titulo font-bold text-tinta">Total</span>
                <span class="titulo text-xl font-black tabular-nums text-tinta">{{ reais(totais.total) }}</span>
              </div>
            </div>

            <button type="button" class="btn-primario mt-4 w-full py-3"
                    :disabled="!totais.n || !data.evento.vendasAbertas"
                    @click="irParaPagamento">
              {{ data.evento.vendasAbertas ? 'Ir para pagamento' : 'Vendas fechadas' }}
            </button>
          </div>
        </aside>
      </section>
    </main>

    <!-- barra do celular -->
    <div v-if="totais.n"
         class="fixed inset-x-0 bottom-0 z-20 border-t border-linha bg-white p-4 shadow-[0_-2px_12px_rgba(18,38,63,.08)] lg:hidden">
      <div class="mx-auto flex max-w-5xl items-center gap-4">
        <div class="min-w-0 flex-1">
          <p class="text-xs text-tinta-fraca">
            {{ totais.n }} {{ totais.n === 1 ? 'ingresso' : 'ingressos' }}
          </p>
          <p class="titulo text-xl font-black tabular-nums text-tinta">{{ reais(totais.total) }}</p>
          <p v-if="totais.taxa" class="text-xs text-tinta-fraca">
            já com {{ reais(totais.taxa) }} de taxa
          </p>
        </div>
        <button type="button" class="btn-primario shrink-0 px-6 py-3"
                :disabled="!data.evento.vendasAbertas" @click="irParaPagamento">
          Pagar
        </button>
      </div>
    </div>
  </div>
</template>
