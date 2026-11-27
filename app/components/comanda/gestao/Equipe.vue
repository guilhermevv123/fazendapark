<script setup lang="ts">
/**
 * Equipe e regras (055): quem usa a comanda e com que nível, o PIN do gerente, e as regras
 * (limite padrão, prazo para desfazer, quem fecha conta). O login das pessoas é o MESMO do
 * painel (Configurações → Equipe); aqui se dá o nível na comanda. O dono também cria aqui o
 * login de um funcionário novo (papel Portaria + nível), que entra no app do tablet.
 */
import { chamar, mensagemDoErro } from '~/composables/comandaOffline'
import CampoMoeda from '~/components/CampoMoeda.vue'

const pessoas = ref<any[]>([])
const config = ref<any>(null)
/** os locais de venda ativos, para prender o funcionário a eles (056) */
const locais = ref<{ id: string; nome: string }[]>([])
const erro = ref('')
const aviso = ref('')
const pin = ref('')
async function carregar() {
  try {
    pessoas.value = (await chamar<any>('/api/comandas/equipe')).pessoas
    const e = await chamar<any>('/api/comandas/estado')
    config.value = { ...e.config }
    locais.value = e.pontos ?? []
    erro.value = ''
  } catch (e) { erro.value = mensagemDoErro(e) }
}
onMounted(carregar)

async function nivel(p: any, n: string) {
  try {
    await chamar('/api/comandas/equipe', { method: 'POST', body: { userId: p.id, nivel: n || null } })
    await carregar()
  } catch (e) { erro.value = mensagemDoErro(e) }
}
async function salvarPin() {
  try {
    await chamar('/api/comandas/equipe', { method: 'POST', body: { pin: pin.value } })
    pin.value = ''
    aviso.value = 'PIN salvo.'
    await carregar()
  } catch (e) { erro.value = mensagemDoErro(e) }
}
async function salvarConfig() {
  try {
    config.value = (await chamar<any>('/api/comandas/config', { method: 'POST', body: config.value })).config
    aviso.value = 'Regras salvas.'
  } catch (e) { erro.value = mensagemDoErro(e) }
}
/* ---- criar login de funcionário (só o dono) */
const souDono = computed(() => pessoas.value.some((p) => p.eu && p.master))
const novo = ref<{ nome: string; email: string; senha: string; nivel: string; pontos: string[] }>({ nome: '', email: '', senha: '', nivel: 'atendente', pontos: [] })
const verSenha = ref(false)
const criando = ref(false)
/** o login recém-criado, para o aviso de "pronto" */
const criado = ref<{ nome: string; email: string } | null>(null)
async function criarLogin() {
  erro.value = ''
  criando.value = true
  try {
    const r = await chamar<any>('/api/comandas/equipe', { method: 'POST', body: { criar: novo.value } })
    criado.value = { nome: novo.value.nome.trim(), email: novo.value.email.trim().toLowerCase() }
    novo.value = { nome: '', email: '', senha: '', nivel: 'atendente', pontos: [] }
    await carregar()
  } catch (e) { erro.value = mensagemDoErro(e) } finally { criando.value = false }
}

const nomeDoLocal = (id: string) => locais.value.find((l) => l.id === id)?.nome ?? 'local apagado'
/** a pessoa cujos locais o dono está mudando, e a escolha em andamento */
const mudandoLocal = ref<{ id: string; pontos: string[] } | null>(null)
async function salvarLocais() {
  const m = mudandoLocal.value
  if (!m) return
  try {
    await chamar('/api/comandas/equipe', { method: 'POST', body: { userId: m.id, pontos: m.pontos } })
    mudandoLocal.value = null
    await carregar()
  } catch (e) { erro.value = mensagemDoErro(e) }
}

const NIVEL: Record<string, string> = { atendente: 'Atendente — lança pedido, vê conta, desfaz o próprio pedido', caixa: 'Caixa — fecha conta, corrige, troca pulseira', gerente: 'Gerente — tudo, inclusive desconto, perdão e cobrança' }
</script>

<template>
  <div class="space-y-4">
    <p v-if="aviso" class="faixa-aviso">{{ aviso }}</p>
    <p v-if="erro" class="faixa-erro">{{ erro }}</p>

    <div v-if="config" class="card space-y-4 p-5">
      <p class="titulo-bloco">Regras</p>
      <label class="flex items-center gap-3 rounded-card p-3" :class="config.ativo ? 'bg-success-50' : 'bg-warning-50'">
        <input v-model="config.ativo" type="checkbox" class="h-6 w-6">
        <span><b>Comandas ligadas para a equipe</b><br><span class="text-sm text-ink-700">Desligado: só o dono entra. Ligado: quem tem nível abaixo entra.</span></span>
      </label>
      <div class="grid gap-3 sm:grid-cols-2">
        <label class="block"><span class="rotulo">Limite padrão por conta (R$ 0 = sem limite)</span><CampoMoeda v-model="config.limitePadraoCents" /></label>
        <label class="block"><span class="rotulo">Avisar quando a conta passar de</span><CampoMoeda v-model="config.avisoContaAltaCents" /></label>
        <label class="block"><span class="rotulo">Horário em que o parque fecha</span><input v-model="config.horaFechamento" type="time" class="campo">
          <span class="mt-1 block text-xs text-ink-600">A partir deste horário, o Resumo do dia conta quem saiu sem pagar.</span></label>
        <label class="block"><span class="rotulo">Minutos para o atendente desfazer o próprio pedido</span><input v-model.number="config.minutosParaDesfazer" type="number" min="0" max="60" class="campo"></label>
      </div>
      <label class="flex items-center gap-2"><input v-model="config.atendenteFechaConta" type="checkbox" class="h-5 w-5"> Atendente também pode fechar conta</label>
      <label class="flex items-center gap-2"><input v-model="config.exigeCodigoWhatsapp" type="checkbox" class="h-5 w-5"> Conta sem ingresso exige código no WhatsApp</label>
      <button type="button" class="btn-primario" @click="salvarConfig">Salvar regras</button>
    </div>

    <div class="card space-y-3 p-5">
      <p class="titulo-bloco">Meu PIN de gerente</p>
      <p class="text-sm text-ink-700">É o que você digita no tablet do atendente para liberar limite, desconto ou correção.</p>
      <div class="flex gap-2"><input v-model="pin" type="password" inputmode="numeric" maxlength="6" class="campo w-40" placeholder="4 a 6 números"><button type="button" class="btn-secundario" :disabled="pin.length < 4" @click="salvarPin">Salvar PIN</button></div>
    </div>

    <div v-if="souDono" class="card space-y-3 p-5" data-parte="criar-login">
      <div>
        <p class="titulo-bloco">Criar login de funcionário</p>
        <p class="text-sm text-ink-700">O funcionário entra no <b>app do tablet</b> com este e-mail e esta senha.</p>
      </div>
      <form class="grid gap-2 sm:grid-cols-[1fr_1fr_1fr_auto_auto]" @submit.prevent="criarLogin">
        <input v-model="novo.nome" class="campo" placeholder="Nome (ex.: João do bar)" maxlength="120" aria-label="Nome do funcionário">
        <input v-model="novo.email" type="email" class="campo" placeholder="E-mail do funcionário" autocapitalize="none" spellcheck="false" aria-label="E-mail do funcionário">
        <div class="relative">
          <input v-model="novo.senha" :type="verSenha ? 'text' : 'password'" class="campo pr-16" placeholder="Senha (mín. 8)" autocomplete="new-password" aria-label="Senha do funcionário">
          <button type="button" class="absolute right-2 top-1/2 -translate-y-1/2 text-xs font-semibold text-acao" @click="verSenha = !verSenha">{{ verSenha ? 'Esconder' : 'Ver' }}</button>
        </div>
        <select v-model="novo.nivel" class="campo w-auto" aria-label="Nível nas comandas">
          <option value="atendente">Atendente</option>
          <option value="caixa">Caixa</option>
          <option value="gerente">Gerente</option>
        </select>
        <button type="submit" class="btn-primario" :disabled="criando || novo.nome.trim().length < 2 || !novo.email.includes('@') || novo.senha.length < 8 || (locais.length > 0 && !novo.pontos.length)">{{ criando ? 'Criando…' : 'Criar login' }}</button>
        <fieldset v-if="locais.length" class="sm:col-span-5">
          <legend class="rotulo">Onde ele atende</legend>
          <div class="flex flex-wrap gap-2">
            <label v-for="l in locais" :key="l.id" class="flex min-h-[44px] cursor-pointer items-center gap-2 rounded-card border px-3 text-sm font-semibold"
                   :class="novo.pontos.includes(l.id) ? 'border-acao bg-acao-fraco text-acao' : 'border-linha bg-white text-ink-700'">
              <input v-model="novo.pontos" type="checkbox" :value="l.id" class="h-4 w-4"> {{ l.nome }}
            </label>
          </div>
          <span class="mt-1 block text-xs text-ink-600">Ele só vê e só lança nesses locais, e não consegue trocar. Marque pelo menos um.</span>
        </fieldset>
      </form>
      <div v-if="criado" class="space-y-2 rounded-card border-l-4 border-l-acao bg-acao-fraco p-4" data-parte="login-criado">
        <p class="font-semibold text-ink-900">Login de {{ criado.nome }} criado</p>
        <p class="text-sm text-ink-700">Ele já pode entrar no app do tablet com <b class="font-mono">{{ criado.email }}</b> e a senha que você escolheu.</p>
        <button type="button" class="text-sm font-semibold text-ink-600 hover:text-ink-900" @click="criado = null">Fechar</button>
      </div>
    </div>

    <div class="card p-5">
      <p class="titulo-bloco">Quem usa as comandas</p>
      <p class="text-sm text-ink-700">Quem já tem login no sistema: escolha o nível ao lado do nome.</p>
      <ul class="mt-3 divide-y divide-linha">
        <li v-for="p in pessoas" :key="p.id" class="flex flex-wrap items-center justify-between gap-2 py-3" :class="p.ativo ? '' : 'opacity-50'">
          <span><b>{{ p.nome }}</b> <span class="text-sm text-ink-600">{{ p.email }}</span>
            <span v-if="p.temPin" class="selo-neutro ml-1">tem PIN</span>
            <span v-if="p.soComandas" class="selo-neutro ml-1">só comandas</span>
            <span v-if="!p.master && p.nivel" class="block text-xs text-ink-600">
              Atende em: {{ p.pontos.length ? p.pontos.map(nomeDoLocal).join(', ') : 'todos os locais' }}
              <button v-if="souDono" type="button" class="ml-1 font-semibold text-acao" @click="mudandoLocal = { id: p.id, pontos: [...p.pontos] }">mudar</button>
            </span>
            <span v-if="mudandoLocal?.id === p.id" class="mt-2 flex flex-wrap items-center gap-2">
              <label v-for="l in locais" :key="l.id" class="flex items-center gap-1.5 text-sm">
                <input v-model="mudandoLocal!.pontos" type="checkbox" :value="l.id" class="h-4 w-4"> {{ l.nome }}
              </label>
              <span class="text-xs text-ink-600">(nenhum marcado = todos)</span>
              <button type="button" class="btn-primario px-3 py-1.5 text-xs" @click="salvarLocais">Salvar</button>
              <button type="button" class="btn-secundario px-3 py-1.5 text-xs" @click="mudandoLocal = null">Cancelar</button>
            </span></span>
          <span v-if="p.master" class="selo-ok">Dono — gerente</span>
          <select v-else :value="p.nivel ?? ''" class="campo w-auto" @change="nivel(p, ($event.target as HTMLSelectElement).value)">
            <option value="">Sem acesso</option>
            <option v-for="(t, k) in NIVEL" :key="k" :value="k">{{ t }}</option>
          </select>
        </li>
      </ul>
    </div>
  </div>
</template>
