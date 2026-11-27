<script setup lang="ts">
/**
 * Produtos (055): tudo o que o parque vende pelas comandas. O que é cadastrado aqui aparece
 * no "Novo pedido" do tablet de cada local que vende aquela categoria.
 *
 * Cada produto tem nome, preço, categoria e ícone (ilustração 3D escolhida na paleta; sem escolher,
 * o tablet acha uma pelo nome). Produto não se apaga — tem venda antiga ligada a ele: desativa, e some dos tablets.
 * Mudar o preço não mexe em conta já lançada.
 */
import { chamar, mensagemDoErro } from '~/composables/comandaOffline'
import { reais } from '~/composables/formato'
import { buscarIcones, iconeDaCategoria, iconeDoItem, nomeDoIcone } from '~/composables/comandaIcones'
import ComandaIcone from '~/components/comanda/Icone.vue'
import CampoMoeda from '~/components/CampoMoeda.vue'
import ModalLateral from '~/components/ModalLateral.vue'

const d = ref<any>(null)
const erro = ref('')
const aviso = ref('')
async function carregar() {
  try { d.value = await chamar<any>('/api/comandas/cardapio'); erro.value = '' } catch (e) { erro.value = mensagemDoErro(e) }
}
const route = useRoute()
onMounted(async () => {
  await carregar()
  // vindo do botão "+ Produto" do Novo pedido: já abre o cadastro
  if (route.query.novo === '1' && d.value) novoProduto()
})

const categoria = ref('')
const busca = ref('')
const mostrar = ref<'ativos' | 'esgotados' | 'desativados'>('ativos')
const catDe = (id: string) => d.value?.categorias.find((c: any) => c.id === id)
const produtos = computed(() => {
  const b = busca.value.trim().toLowerCase()
  return (d.value?.itens ?? []).filter((i: any) =>
    (!categoria.value || i.categoriaId === categoria.value)
    && (!b || i.nome.toLowerCase().includes(b))
    && (mostrar.value === 'desativados' ? !i.ativo : i.ativo && (mostrar.value !== 'esgotados' || i.esgotado)))
})
const contar = (catId: string) => (d.value?.itens ?? []).filter((i: any) => i.ativo && i.categoriaId === catId).length
const locaisDa = (catId: string) => (d.value?.pontos ?? []).filter((p: any) => p.ativo && (!p.categorias || p.categorias.includes(catId))).map((p: any) => p.nome)

// ---- formulário de produto / categoria
const editando = ref<any>(null)
const erroForm = ref('')
function novoProduto() {
  erroForm.value = ''
  editando.value = { tipo: 'item', nome: '', precoCents: 0, categoriaId: categoria.value || d.value?.categorias[0]?.id || '', icone: '', maior18: false, esgotado: false, ativo: true }
}
function editarProduto(i: any) { erroForm.value = ''; editando.value = { tipo: 'item', ...i, icone: i.icone ?? '' } }
function novaCategoria() { erroForm.value = ''; editando.value = { tipo: 'categoria', nome: '', icone: '', ativo: true } }
function editarCategoria(c: any) { erroForm.value = ''; editando.value = { tipo: 'categoria', ...c, icone: c.icone ?? '' } }
const buscaIcone = ref('')
const gruposDeIcones = computed(() => buscarIcones(buscaIcone.value))
watch(editando, () => { buscaIcone.value = '' })
const iconeAtual = computed(() => {
  const e = editando.value
  if (!e) return ''
  return e.tipo === 'item' ? iconeDoItem(e, catDe(e.categoriaId)) : iconeDaCategoria(e)
})
async function salvar() {
  erroForm.value = ''
  try {
    await chamar('/api/comandas/cardapio', { method: 'POST', body: editando.value })
    aviso.value = `${editando.value.nome} salvo.`
    editando.value = null
    await carregar()
  } catch (e) { erroForm.value = mensagemDoErro(e) }
}
async function alternar(i: any, campo: 'esgotado' | 'ativo') {
  try {
    await chamar('/api/comandas/cardapio', { method: 'POST', body: { tipo: 'item', ...i, [campo]: !i[campo] } })
    await carregar()
  } catch (e) { erro.value = mensagemDoErro(e) }
}
async function usarPadrao() {
  try {
    const r = await chamar<any>('/api/comandas/cardapio/padrao', { method: 'POST' })
    aviso.value = r.criados ? `${r.criados} produtos de exemplo criados. Ajuste nomes e preços.` : 'Os produtos de exemplo já estavam criados.'
    await carregar()
  } catch (e) { erro.value = mensagemDoErro(e) }
}
</script>

<template>
  <div class="space-y-4">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <p class="text-sm text-ink-700">O que você cadastrar aqui aparece no <b>Novo pedido</b> dos tablets dos locais que vendem aquela categoria.</p>
      <div class="flex gap-2">
        <button type="button" class="btn-secundario" @click="novaCategoria">+ Categoria</button>
        <button type="button" data-acao="novo-produto" class="btn-primario" @click="novoProduto">+ Novo produto</button>
      </div>
    </div>
    <p v-if="aviso" class="faixa-aviso">{{ aviso }}</p>
    <p v-if="erro" class="faixa-erro">{{ erro }}</p>

    <div v-if="d && !d.itens.length" class="card space-y-3 p-8 text-center">
      <p class="text-lg font-semibold">Nenhum produto ainda.</p>
      <p class="text-sm text-ink-600">Cadastre um por um, ou comece com uma lista de exemplo (batata, cerveja, água…) e ajuste os preços.</p>
      <div class="flex justify-center gap-2">
        <button type="button" class="btn-secundario" @click="usarPadrao">Começar com a lista de exemplo</button>
        <button type="button" class="btn-primario" @click="novoProduto">+ Novo produto</button>
      </div>
    </div>

    <div v-else-if="d" class="grid gap-4 lg:grid-cols-[240px_1fr]">
      <!-- categorias -->
      <aside class="card h-fit p-2">
        <button type="button" class="flex w-full items-center gap-3 rounded-card px-3 py-2.5 text-left font-semibold"
                :class="!categoria ? 'bg-acao-fraco text-acao' : 'hover:bg-ink-50'" @click="categoria = ''">
          <ComandaIcone icone="🍽️" :tamanho="28" /><span class="flex-1">Todos</span><span class="text-xs text-ink-600">{{ d.itens.filter((i: any) => i.ativo).length }}</span>
        </button>
        <div v-for="c in d.categorias" :key="c.id" class="group flex items-center rounded-card"
             :class="categoria === c.id ? 'bg-acao-fraco text-acao' : 'hover:bg-ink-50'">
          <button type="button" class="flex flex-1 items-center gap-3 px-3 py-2.5 text-left font-semibold" :class="c.ativo ? '' : 'opacity-50'" @click="categoria = c.id">
            <ComandaIcone :icone="iconeDaCategoria(c)" :tamanho="28" /><span class="flex-1">{{ c.nome }}</span><span class="text-xs text-ink-600">{{ contar(c.id) }}</span>
          </button>
          <button type="button" class="px-2 text-xs font-semibold text-acao opacity-0 group-hover:opacity-100" :aria-label="`Editar ${c.nome}`" @click="editarCategoria(c)">Editar</button>
        </div>
      </aside>

      <section class="space-y-3">
        <div class="flex flex-wrap gap-2">
          <input v-model="busca" class="campo max-w-xs" placeholder="Buscar produto">
          <div class="flex gap-1">
            <button v-for="m in (['ativos', 'esgotados', 'desativados'] as const)" :key="m" type="button" class="chip" :class="mostrar === m ? 'chip-ativo' : ''" @click="mostrar = m">
              {{ { ativos: 'À venda', esgotados: 'Esgotados', desativados: 'Desativados' }[m] }}
            </button>
          </div>
        </div>
        <p v-if="categoria" class="text-xs text-ink-600">Vendido em: {{ locaisDa(categoria).join(', ') || 'nenhum local — marque em Configurações → Locais de venda' }}</p>

        <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <article v-for="i in produtos" :key="i.id" class="card flex gap-3 p-4" :class="i.ativo ? '' : 'opacity-60'">
            <div class="flex h-16 w-16 shrink-0 items-center justify-center rounded-card bg-gradient-to-b from-ink-50 to-white ring-1 ring-linha"><ComandaIcone :icone="iconeDoItem(i, catDe(i.categoriaId))" :tamanho="48" /></div>
            <div class="min-w-0 flex-1">
              <p class="truncate font-semibold">{{ i.nome }}</p>
              <p class="titulo text-lg font-bold text-acao">{{ reais(i.precoCents) }}</p>
              <p class="text-xs text-ink-600">{{ catDe(i.categoriaId)?.nome }} · {{ i.vendidos }} vendido(s)</p>
              <div class="mt-1 flex flex-wrap gap-1">
                <span v-if="i.maior18" class="selo-neutro">+18</span>
                <span v-if="i.esgotado" class="selo-erro">esgotado</span>
              </div>
              <div class="mt-2 flex gap-1.5">
                <button type="button" class="btn-secundario px-3 py-1.5 text-xs" @click="editarProduto(i)">Editar</button>
                <button v-if="i.ativo" type="button" class="btn-secundario px-3 py-1.5 text-xs" @click="alternar(i, 'esgotado')">{{ i.esgotado ? 'Voltou' : 'Esgotou' }}</button>
                <button v-else type="button" class="btn-secundario px-3 py-1.5 text-xs" @click="alternar(i, 'ativo')">Reativar</button>
              </div>
            </div>
          </article>
        </div>
        <p v-if="!produtos.length" class="card p-8 text-center text-ink-600">Nenhum produto aqui.</p>
      </section>
    </div>

    <!-- formulário -->
    <ModalLateral v-if="editando" :titulo="editando.tipo === 'item' ? (editando.id ? 'Editar produto' : 'Novo produto') : (editando.id ? 'Editar categoria' : 'Nova categoria')" @fechar="editando = null">
      <form class="space-y-4" @submit.prevent="salvar">
        <!-- como vai aparecer no tablet -->
        <div class="flex items-center gap-4 rounded-card bg-ink-50 p-3">
          <div class="flex h-24 w-24 shrink-0 items-center justify-center rounded-card bg-white shadow-sm ring-1 ring-linha">
            <ComandaIcone :icone="iconeAtual" :tamanho="72" />
          </div>
          <div class="min-w-0 space-y-1">
            <p class="truncate font-semibold">{{ editando.nome || (editando.tipo === 'item' ? 'Novo produto' : 'Nova categoria') }}</p>
            <p v-if="editando.tipo === 'item'" class="titulo font-bold text-acao">{{ reais(editando.precoCents || 0) }}</p>
            <p class="text-xs text-ink-600">{{ editando.icone ? `Ícone: ${nomeDoIcone(editando.icone) || 'escolhido'}` : 'Ícone automático, pelo nome.' }}</p>
          </div>
        </div>
        <label class="block"><span class="rotulo">Nome</span>
          <input v-model="editando.nome" class="campo text-lg" :placeholder="editando.tipo === 'item' ? 'Ex.: Batata frita' : 'Ex.: Porções'" :maxlength="editando.tipo === 'item' ? 60 : 40" required></label>
        <template v-if="editando.tipo === 'item'">
          <label class="block"><span class="rotulo">Preço</span><CampoMoeda v-model="editando.precoCents" /></label>
          <label class="block"><span class="rotulo">Categoria</span>
            <select v-model="editando.categoriaId" class="campo" required>
              <option v-for="c in d.categorias" :key="c.id" :value="c.id">{{ c.nome }}</option>
            </select></label>
          <p v-if="editando.categoriaId" class="-mt-2 text-xs text-ink-600">Aparece em: {{ locaisDa(editando.categoriaId).join(', ') || 'nenhum local' }}</p>
        </template>
        <div class="space-y-2">
          <div class="flex items-center justify-between gap-2">
            <p class="rotulo !mb-0">Ícone</p>
            <button type="button" class="chip" :class="!editando.icone ? 'chip-ativo' : ''" @click="editando.icone = ''">Automático</button>
          </div>
          <div class="relative">
            <svg viewBox="0 0 24 24" class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-500" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
            <input v-model="buscaIcone" class="campo pl-9" placeholder="Buscar ícone (ex.: cerveja, açaí, boia)" autocomplete="off">
          </div>
          <div class="max-h-80 space-y-3 overflow-y-auto rounded-card border border-linha p-2">
            <div v-for="g in gruposDeIcones" :key="g.grupo">
              <p class="px-1 pb-1 text-[11px] font-bold uppercase tracking-wide text-ink-500">{{ g.grupo }}</p>
              <div class="grid grid-cols-[repeat(auto-fill,minmax(64px,1fr))] gap-1.5">
                <button v-for="i in g.icones" :key="i.e" type="button" :title="i.nome" :aria-label="i.nome" :aria-pressed="editando.icone === i.e"
                        class="flex h-16 items-center justify-center rounded-card border transition"
                        :class="editando.icone === i.e ? 'border-acao bg-acao-fraco ring-2 ring-acao' : 'border-transparent hover:border-linha hover:bg-ink-50'"
                        @click="editando.icone = i.e">
                  <ComandaIcone :icone="i.e" :tamanho="44" />
                </button>
              </div>
            </div>
            <p v-if="!gruposDeIcones.length" class="p-4 text-center text-sm text-ink-600">Nenhum ícone com "{{ buscaIcone.trim() }}". Tente outra palavra, ou deixe no automático.</p>
          </div>
        </div>
        <template v-if="editando.tipo === 'item'">
          <label class="flex items-center gap-2"><input v-model="editando.maior18" type="checkbox" class="h-5 w-5"> Bebida alcoólica (só para maior de 18)</label>
          <label class="flex items-center gap-2"><input v-model="editando.esgotado" type="checkbox" class="h-5 w-5"> Esgotado agora</label>
        </template>
        <label class="flex items-center gap-2"><input v-model="editando.ativo" type="checkbox" class="h-5 w-5"> {{ editando.tipo === 'item' ? 'À venda (aparece nos tablets)' : 'Ativa (aparece nos tablets)' }}</label>
        <p v-if="erroForm" class="faixa-erro">{{ erroForm }}</p>
        <div class="flex gap-2">
          <button type="button" class="btn-secundario flex-1" @click="editando = null">Cancelar</button>
          <button type="submit" class="btn-primario flex-1">Salvar</button>
        </div>
      </form>
    </ModalLateral>
  </div>
</template>
