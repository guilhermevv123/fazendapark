<script setup lang="ts">
/**
 * Pontos de venda.
 *
 * É a tela que o produtor abre às 19h pra saber quem está vendendo e qual
 * guichê ainda não fechou. Por isso o estado do caixa aparece no próprio
 * cartão do ponto: a pergunta "o Portão A está aberto?" não pode custar uma
 * segunda tela.
 */
definePageMeta({ layout: 'admin' })

const route = useRoute()
const id = route.params.id as string

const { data, refresh, pending } = await useFetch<any>(() => `/api/admin/evento/${id}/pdv`)

const erro = ref('')
const aviso = ref('')
const salvando = ref(false)
const criando = ref(false)
const editando = ref<any>(null)

const FORMAS = [
  { v: 'dinheiro', nome: 'Dinheiro' },
  { v: 'debito', nome: 'Débito' },
  { v: 'credito', nome: 'Crédito' },
  { v: 'pix', nome: 'Pix' },
]

const novo = reactive({
  nome: '', local: '',
  formas: ['dinheiro', 'debito', 'credito', 'pix'] as string[],
})

// `reais` e `dataHora` vêm de `app/composables/formato.ts`.
const quando = dataHora

function alterna(lista: string[], v: string) {
  const i = lista.indexOf(v)
  if (i >= 0) lista.splice(i, 1)
  else lista.push(v)
}

async function criar() {
  if (!novo.formas.length) { erro.value = 'Escolha pelo menos uma forma de pagamento.'; return }
  criando.value = true; erro.value = ''
  try {
    await $fetch(`/api/admin/evento/${id}/pdv`, {
      method: 'POST',
      body: { nome: novo.nome.trim(), local: novo.local.trim() || null, formas: novo.formas },
    })
    aviso.value = `${novo.nome} criado. Abra o caixa pra começar a vender.`
    Object.assign(novo, { nome: '', local: '', formas: ['dinheiro', 'debito', 'credito', 'pix'] })
    await refresh()
  } catch (e: any) { erro.value = e?.data?.message ?? e?.statusMessage ?? 'Não deu pra criar.' }
  finally { criando.value = false }
}

async function salvarEdicao() {
  const p = editando.value
  salvando.value = true; erro.value = ''
  try {
    await $fetch(`/api/admin/evento/${id}/pdv`, {
      method: 'PATCH',
      body: { id: p.id, nome: p.nome.trim(), local: p.local?.trim() || null, formas: p.formas },
    })
    aviso.value = 'Ponto de venda salvo.'
    editando.value = null
    await refresh()
  } catch (e: any) { erro.value = e?.data?.message ?? e?.statusMessage ?? 'Não deu pra salvar.' }
  finally { salvando.value = false }
}

async function ativar(p: any, v: boolean) {
  salvando.value = true; erro.value = ''
  try {
    await $fetch(`/api/admin/evento/${id}/pdv`, { method: 'PATCH', body: { id: p.id, ativo: v } })
    aviso.value = v ? `${p.nome} reativado.` : `${p.nome} desativado. O histórico continua nos relatórios.`
    await refresh()
  } catch (e: any) { erro.value = e?.data?.message ?? e?.statusMessage ?? 'Não deu pra mudar.' }
  finally { salvando.value = false }
}

const abrindo = ref<any>(null)

/**
 * Fundo de troco em centavos INTEIROS, pela máscara do `CampoMoeda`.
 *
 * Aqui morava um `Number(texto.replace(',', '.')) * 100`: ele troca só a
 * PRIMEIRA vírgula e não sabe o que fazer com o ponto de milhar, então quem
 * digitasse "1.200,00" mandava `NaN` pro servidor — o fundo entrava zerado e
 * a conferência do fim da noite acusava R$ 1.200,00 de sobra na gaveta.
 */
const fundoCents = ref(0)

async function abrirCaixa() {
  const p = abrindo.value
  salvando.value = true; erro.value = ''
  try {
    const r: any = await $fetch(`/api/admin/evento/${id}/pdv/turno`, {
      method: 'POST', body: { pontoId: p.id, fundoCents: fundoCents.value },
    })
    abrindo.value = null; fundoCents.value = 0
    await navigateTo(`/admin/evento/${id}/pdv/vender?turno=${r.turnoId}`)
  } catch (e: any) { erro.value = e?.data?.message ?? e?.statusMessage ?? 'Não deu pra abrir o caixa.' }
  finally { salvando.value = false }
}
</script>

<template>
  <div v-if="data">
    <div class="flex flex-wrap items-start justify-between gap-3 py-5">
      <div>
        <h1 class="titulo text-2xl font-bold text-tinta">Pontos de venda</h1>
        <p class="mt-1 text-tinta-suave">
          Os guichês da bilheteria física, e o caixa de cada um.
        </p>
      </div>
      <NuxtLink :to="`/admin/evento/${id}/pdv/caixa`" class="btn-secundario">
        Conferência de caixa
      </NuxtLink>
    </div>

    <AbasSecao :evento-id="id" />

    <p v-if="erro" class="faixa-erro mt-4">{{ erro }}</p>
    <p v-else-if="aviso" class="faixa-aviso mt-4">{{ aviso }}</p>

    <!-- total da bilheteria -->
    <div class="mt-4 grid gap-3 sm:grid-cols-3">
      <div class="card">
        <p class="rotulo-kpi">Vendido na bilheteria</p>
        <p class="numero-kpi mt-1">{{ reais(data.resumo.brutoCents) }}</p>
        <p class="mt-1 text-xs text-tinta-fraca">{{ data.resumo.pedidos }} venda(s) no balcão</p>
      </div>
      <div class="card">
        <p class="rotulo-kpi">Em dinheiro</p>
        <p class="numero-kpi mt-1">{{ reais(data.resumo.dinheiroCents) }}</p>
        <p class="mt-1 text-xs text-tinta-fraca">é o que passou pela gaveta</p>
      </div>
      <div class="card">
        <p class="rotulo-kpi">Caixas abertos agora</p>
        <p class="numero-kpi mt-1">{{ data.pontos.filter((p: any) => p.turno).length }}</p>
        <p class="mt-1 text-xs text-tinta-fraca">de {{ data.pontos.filter((p: any) => p.ativo).length }} ponto(s) ativo(s)</p>
      </div>
    </div>

    <!-- os pontos -->
    <section class="mt-4 grid gap-3 md:grid-cols-2">
      <article v-for="p in data.pontos" :key="p.id" class="card"
               :class="p.ativo ? '' : 'opacity-60'">
        <header class="flex items-start justify-between gap-3">
          <div>
            <h2 class="titulo text-lg font-bold text-tinta">{{ p.nome }}</h2>
            <p class="text-sm text-tinta-suave">{{ p.local || 'sem local anotado' }}</p>
          </div>
          <span v-if="!p.ativo" class="selo-neutro">Desativado</span>
          <span v-else-if="p.turno" class="selo-ok">Caixa aberto</span>
          <span v-else class="selo-neutro">Caixa fechado</span>
        </header>

        <div class="mt-3 flex flex-wrap gap-1">
          <span v-for="f in p.formas" :key="f" class="selo-neutro">
            {{ FORMAS.find((x) => x.v === f)?.nome ?? f }}
          </span>
        </div>

        <dl v-if="p.turno" class="mt-4 grid grid-cols-3 gap-3 border-t border-linha pt-3">
          <div>
            <dt class="text-xs text-tinta-fraca">Operador</dt>
            <dd class="text-sm font-bold text-tinta">{{ p.turno.operador }}</dd>
          </div>
          <div>
            <dt class="text-xs text-tinta-fraca">Abriu</dt>
            <dd class="text-sm font-bold text-tinta tabular-nums">{{ quando(p.turno.abriuEm) }}</dd>
          </div>
          <div>
            <dt class="text-xs text-tinta-fraca">Vendeu no turno</dt>
            <dd class="text-sm font-bold text-tinta tabular-nums">{{ reais(p.turno.totalCents) }}</dd>
          </div>
        </dl>
        <p v-else class="mt-4 border-t border-linha pt-3 text-sm text-tinta-suave">
          Hoje: {{ p.hoje.pedidos }} venda(s), {{ reais(p.hoje.totalCents) }}.
        </p>

        <footer class="mt-4 flex flex-wrap gap-2">
          <NuxtLink v-if="p.turno" :to="`/admin/evento/${id}/pdv/vender?turno=${p.turno.id}`"
                    class="btn-primario">Vender</NuxtLink>
          <button v-else-if="p.ativo" type="button" class="btn-primario"
                  @click="abrindo = p; fundoCents = 0">Abrir caixa</button>

          <NuxtLink v-if="p.turno" :to="`/admin/evento/${id}/pdv/caixa?turno=${p.turno.id}`"
                    class="btn-secundario">Conferir e fechar</NuxtLink>

          <button type="button" class="btn-secundario"
                  @click="editando = { id: p.id, nome: p.nome, local: p.local, formas: [...p.formas] }">
            Editar
          </button>
          <button v-if="p.ativo" type="button" class="btn-secundario" :disabled="salvando"
                  @click="ativar(p, false)">Desativar</button>
          <button v-else type="button" class="btn-secundario" :disabled="salvando"
                  @click="ativar(p, true)">Reativar</button>
        </footer>
      </article>
    </section>

    <p v-if="!data.pontos.length && !pending" class="card mt-4 text-center text-tinta-suave">
      Nenhum ponto de venda ainda. Crie o primeiro abaixo — normalmente é o guichê do portão.
    </p>

    <!-- criar -->
    <section class="card mt-4">
      <h2 class="rotulo-kpi">Novo ponto de venda</h2>
      <p class="mt-1 text-xs text-tinta-fraca">
        Marque só as formas que este guichê realmente tem. O que não está marcado
        nem aparece na tela de venda.
      </p>
      <form class="mt-4 grid gap-3 md:grid-cols-4" @submit.prevent="criar">
        <div class="md:col-span-1">
          <label class="rotulo">Nome</label>
          <input v-model="novo.nome" class="campo" placeholder="Guichê Portão A" required>
        </div>
        <div class="md:col-span-1">
          <label class="rotulo">Onde fica</label>
          <input v-model="novo.local" class="campo" placeholder="Entrada principal">
        </div>
        <div class="md:col-span-1">
          <label class="rotulo">Formas de pagamento</label>
          <div class="flex flex-wrap gap-2">
            <button v-for="f in FORMAS" :key="f.v" type="button"
                    :class="novo.formas.includes(f.v) ? 'chip-ativo' : 'chip'"
                    @click="alterna(novo.formas, f.v)">{{ f.nome }}</button>
          </div>
        </div>
        <div class="flex items-end md:col-span-1">
          <button class="btn-primario w-full" :disabled="criando">
            {{ criando ? 'Criando…' : 'Criar ponto' }}
          </button>
        </div>
      </form>
    </section>

    <!-- turnos recentes -->
    <section v-if="data.turnos.length" class="card mt-4 overflow-hidden p-0">
      <header class="border-b border-linha p-4">
        <h2 class="rotulo-kpi">Caixas recentes</h2>
        <p class="mt-1 text-xs text-tinta-fraca">
          A diferença é o que o operador contou menos o que o sistema esperava.
        </p>
      </header>
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="bg-fundo-cinza text-left text-xs uppercase text-tinta-suave">
            <tr>
              <th class="px-4 py-2">Ponto</th>
              <th class="px-4 py-2">Operador</th>
              <th class="px-4 py-2">Abriu</th>
              <th class="px-4 py-2">Fechou</th>
              <th class="px-4 py-2 text-right">Vendas</th>
              <th class="px-4 py-2 text-right">Contado</th>
              <th class="px-4 py-2 text-right">Diferença</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="t in data.turnos" :key="t.id" class="border-t border-linha">
              <td class="px-4 py-2 font-bold text-tinta">{{ t.ponto }}</td>
              <td class="px-4 py-2">{{ t.operador }}</td>
              <td class="px-4 py-2 tabular-nums">{{ quando(t.abriuEm) }}</td>
              <td class="px-4 py-2 tabular-nums">
                <span v-if="t.status === 'aberto'" class="selo-ok">Aberto</span>
                <template v-else>{{ quando(t.fechouEm) }}</template>
              </td>
              <td class="px-4 py-2 text-right tabular-nums">{{ reais(t.totalCents) }}</td>
              <td class="px-4 py-2 text-right tabular-nums">
                {{ t.contadoCents === null ? '—' : reais(t.contadoCents) }}
              </td>
              <td class="px-4 py-2 text-right tabular-nums">
                <span v-if="t.diferencaCents === null" class="text-tinta-fraca">—</span>
                <span v-else-if="t.diferencaCents === 0" class="selo-ok">bate</span>
                <span v-else :class="t.diferencaCents > 0 ? 'selo-alerta' : 'selo-erro'">
                  {{ t.diferencaCents > 0 ? '+' : '' }}{{ reais(t.diferencaCents) }}
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- abrir caixa -->
    <div v-if="abrindo" class="fixed inset-0 z-50 flex items-center justify-center bg-tinta/40 p-4"
         @click.self="abrindo = null">
      <div class="w-full max-w-md rounded-card bg-fundo-card p-5">
        <h2 class="titulo text-lg font-bold text-tinta">Abrir caixa — {{ abrindo.nome }}</h2>
        <p class="mt-1 text-sm text-tinta-suave">
          Quanto de troco está na gaveta agora, antes de vender qualquer coisa?
          Esse número é o que faz a conferência do fim da noite bater.
        </p>
        <label for="fundo" class="rotulo mt-4">Fundo de troco</label>
        <CampoMoeda id="fundo" v-model="fundoCents" @keyup.enter="abrirCaixa" />
        <div class="mt-5 flex gap-2">
          <button type="button" class="btn-secundario flex-1" @click="abrindo = null">Cancelar</button>
          <button type="button" class="btn-primario flex-1" :disabled="salvando" @click="abrirCaixa">
            {{ salvando ? 'Abrindo…' : 'Abrir e vender' }}
          </button>
        </div>
      </div>
    </div>

    <!-- editar ponto -->
    <div v-if="editando" class="fixed inset-0 z-50 flex items-center justify-center bg-tinta/40 p-4"
         @click.self="editando = null">
      <div class="w-full max-w-md rounded-card bg-fundo-card p-5">
        <h2 class="titulo text-lg font-bold text-tinta">Editar ponto de venda</h2>
        <label class="rotulo mt-4">Nome</label>
        <input v-model="editando.nome" class="campo">
        <label class="rotulo mt-3">Onde fica</label>
        <input v-model="editando.local" class="campo">
        <label class="rotulo mt-3">Formas de pagamento</label>
        <div class="flex flex-wrap gap-2">
          <button v-for="f in FORMAS" :key="f.v" type="button"
                  :class="editando.formas.includes(f.v) ? 'chip-ativo' : 'chip'"
                  @click="alterna(editando.formas, f.v)">{{ f.nome }}</button>
        </div>
        <div class="mt-5 flex gap-2">
          <button type="button" class="btn-secundario flex-1" @click="editando = null">Cancelar</button>
          <button type="button" class="btn-primario flex-1" :disabled="salvando" @click="salvarEdicao">
            {{ salvando ? 'Salvando…' : 'Salvar' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
