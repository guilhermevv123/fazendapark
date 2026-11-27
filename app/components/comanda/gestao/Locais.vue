<script setup lang="ts">
/**
 * Locais de venda (055): os pontos que vendem no parque (restaurante, bar, sorveteria…).
 *
 * Cada local diz o que vende — o tablet dele só mostra essas categorias do cardápio. Local
 * novo (construíram um quiosque) é um botão: nome, o que vende, salvar. Local não se apaga
 * (tem venda antiga ligada a ele): desativa e some dos tablets.
 */
import { chamar, mensagemDoErro } from '~/composables/comandaOffline'
import { dataHora } from '~/composables/formato'

const d = ref<any>(null)
const erro = ref('')
const aviso = ref('')
async function carregar() {
  try { d.value = await chamar<any>('/api/comandas/cardapio'); erro.value = '' } catch (e) { erro.value = mensagemDoErro(e) }
}
onMounted(carregar)

const editando = ref<{ id?: string; nome: string; ativo: boolean; tudo: boolean; categorias: string[] } | null>(null)
const erroForm = ref('')
function abrir(p?: any) {
  erroForm.value = ''
  editando.value = p
    ? { id: p.id, nome: p.nome, ativo: p.ativo, tudo: !p.categorias, categorias: [...(p.categorias ?? [])] }
    : { nome: '', ativo: true, tudo: false, categorias: [] }
}
async function salvar() {
  const e = editando.value
  if (!e) return
  erroForm.value = ''
  try {
    await chamar('/api/comandas/cardapio', { method: 'POST', body: {
      tipo: 'ponto', id: e.id, nome: e.nome, ativo: e.ativo, categorias: e.tudo ? null : e.categorias } })
    aviso.value = e.id ? `${e.nome} atualizado.` : `${e.nome} criado. Já aparece nos tablets.`
    editando.value = null
    await carregar()
  } catch (x) { erroForm.value = mensagemDoErro(x) }
}
async function alternar(p: any) {
  try {
    await chamar('/api/comandas/cardapio', { method: 'POST', body: { tipo: 'ponto', id: p.id, nome: p.nome, ativo: !p.ativo } })
    await carregar()
  } catch (x) { erro.value = mensagemDoErro(x) }
}
const nomeDaCategoria = (id: string) => d.value?.categorias.find((c: any) => c.id === id)?.nome ?? '—'
</script>

<template>
  <div class="space-y-4">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <p class="text-sm text-ink-700">Cada local de venda escolhe o que vende. O tablet de cada local mostra só essas categorias do cardápio.</p>
      <button type="button" data-acao="novo-local" class="btn-primario" @click="abrir()">+ Novo local de venda</button>
    </div>
    <p v-if="aviso" class="faixa-aviso">{{ aviso }}</p>
    <p v-if="erro" class="faixa-erro">{{ erro }}</p>

    <!-- formulário -->
    <form v-if="editando" class="card space-y-4 p-5 ring-2 ring-acao" @submit.prevent="salvar">
      <p class="titulo-bloco">{{ editando.id ? 'Editar local' : 'Novo local de venda' }}</p>
      <label class="block">
        <span class="rotulo">Nome do local</span>
        <input v-model="editando.nome" class="campo text-lg" placeholder="Ex.: Quiosque da Praia" maxlength="60" required>
      </label>
      <div>
        <p class="rotulo">O que este local vende</p>
        <label class="mb-2 flex items-center gap-2 font-semibold"><input v-model="editando.tudo" type="checkbox" class="h-5 w-5"> Vende tudo do cardápio</label>
        <div v-if="!editando.tudo" class="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <label v-for="c in d?.categorias" :key="c.id"
                 class="flex min-h-[48px] cursor-pointer items-center gap-2 rounded-card border px-3 text-sm font-semibold"
                 :class="editando.categorias.includes(c.id) ? 'border-acao bg-acao-fraco text-acao' : 'border-linha'">
            <input v-model="editando.categorias" type="checkbox" :value="c.id" class="h-4 w-4"> {{ c.nome }}
          </label>
        </div>
      </div>
      <label v-if="editando.id" class="flex items-center gap-2"><input v-model="editando.ativo" type="checkbox" class="h-5 w-5"> Ativo (aparece nos tablets)</label>
      <p v-if="erroForm" class="faixa-erro">{{ erroForm }}</p>
      <div class="flex gap-2">
        <button type="button" class="btn-secundario" @click="editando = null">Cancelar</button>
        <button type="submit" class="btn-primario">Salvar</button>
      </div>
    </form>

    <!-- lista -->
    <div class="grid gap-3 md:grid-cols-2">
      <article v-for="p in d?.pontos" :key="p.id" class="card space-y-3 p-5" :class="p.ativo ? '' : 'opacity-60'">
        <div class="flex items-start justify-between gap-2">
          <div>
            <p class="titulo text-lg font-bold">{{ p.nome }}</p>
            <p class="text-xs text-ink-600">Criado {{ dataHora(p.criado_em) }} · {{ p.pedidos }} pedido(s) até hoje</p>
          </div>
          <span :class="p.ativo ? 'selo-ok' : 'selo-neutro'">{{ p.ativo ? 'Ativo' : 'Desativado' }}</span>
        </div>
        <div class="flex flex-wrap gap-1.5">
          <span v-if="!p.categorias" class="selo-neutro">Vende tudo</span>
          <span v-for="id in p.categorias ?? []" :key="id" class="selo-neutro">{{ nomeDaCategoria(id) }}</span>
        </div>
        <div class="flex gap-2">
          <button type="button" class="btn-secundario" @click="abrir(p)">Editar</button>
          <button type="button" class="btn-secundario" @click="alternar(p)">{{ p.ativo ? 'Desativar' : 'Reativar' }}</button>
        </div>
      </article>
    </div>
    <p v-if="d && !d.pontos.length" class="card p-8 text-center text-ink-600">Nenhum local ainda. Crie o primeiro.</p>
  </div>
</template>
