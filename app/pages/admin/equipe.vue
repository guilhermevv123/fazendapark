<script setup lang="ts">
/**
 * Equipe — quem entra no painel e com que poder.
 *
 * A senha nunca é digitada aqui: o servidor sorteia e devolve UMA vez. A tela
 * mostra num bloco que a pessoa copia e entrega. Campo de senha nesta tela
 * seria senha escolhida por um para outro — que sempre acaba sendo o nome da
 * empresa com 123.
 */
definePageMeta({ layout: 'admin' })

const { data, refresh, pending, error: falha } = await useFetch<any>('/api/admin/equipe')

const erro = ref('')
const salvando = ref(false)
const senhaNaTela = ref<{ nome: string; email: string; senha: string } | null>(null)
const confirmando = ref('')

const PAPEIS = [
  { v: 'master', r: 'Master', d: 'Tudo, inclusive mexer em outros masters' },
  { v: 'admin', r: 'Administrador', d: 'Tudo, menos mexer em master' },
  { v: 'financeiro', r: 'Financeiro', d: 'Borderô, transferências e relatórios' },
  { v: 'marketing', r: 'Marketing', d: 'Cupons, promoters e relatórios' },
  { v: 'operacional', r: 'Operacional', d: 'Ingressos, cortesias e vendas' },
  { v: 'portaria', r: 'Portaria', d: 'Só o leitor de entrada' },
  { v: 'leitura', r: 'Leitura', d: 'Vê tudo, não muda nada' },
]
const novo = reactive({ aberto: false, nome: '', email: '', papel: 'operacional' })

async function criar() {
  erro.value = ''
  salvando.value = true
  try {
    const r = await $fetch<any>('/api/admin/equipe', {
      method: 'POST',
      body: { nome: novo.nome, email: novo.email, papel: novo.papel },
    })
    senhaNaTela.value = { nome: r.usuario.nome, email: r.usuario.email, senha: r.senhaProvisoria }
    Object.assign(novo, { aberto: false, nome: '', email: '', papel: 'operacional' })
    await refresh()
  } catch (e: any) {
    erro.value = e?.data?.statusMessage || 'Não foi possível criar o acesso.'
  } finally {
    salvando.value = false
  }
}

async function mudar(p: any, corpo: any) {
  erro.value = ''
  salvando.value = true
  try {
    const r = await $fetch<any>('/api/admin/equipe', { method: 'PATCH', body: { id: p.id, ...corpo } })
    if (r.senhaProvisoria) {
      senhaNaTela.value = { nome: p.nome, email: p.email, senha: r.senhaProvisoria }
    }
    await refresh()
  } catch (e: any) {
    erro.value = e?.data?.statusMessage || 'Não foi possível salvar.'
  } finally {
    salvando.value = false
    confirmando.value = ''
  }
}

const copiado = ref(false)
async function copiar(t: string) {
  try {
    await navigator.clipboard.writeText(t)
    copiado.value = true
    setTimeout(() => { copiado.value = false }, 1800)
  } catch { /* sem permissão de área de transferência: a senha está na tela */ }
}

const quando = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : 'nunca entrou'

useHead({ title: 'Equipe' })
</script>

<template>
  <div v-if="data">
    <div class="flex flex-wrap items-start justify-between gap-3 py-5">
      <div>
        <h1 class="titulo text-2xl font-bold text-tinta">Equipe</h1>
        <p class="mt-1 text-tinta-suave">
          Quem entra no painel de {{ data.organizacao?.nome }} e com que poder.
        </p>
      </div>
      <button type="button" class="btn-primario" @click="novo.aberto = true">
        Dar acesso a alguém
      </button>
    </div>

    <p v-if="erro" class="rounded-card border border-erro bg-erro-claro px-3 py-2 text-sm text-erro">
      {{ erro }}
    </p>

    <div v-if="senhaNaTela"
         class="mt-4 rounded-card border-2 border-acao bg-acao-fraco px-5 py-4 entra-bloco">
      <p class="titulo text-base font-bold text-tinta">
        Senha de {{ senhaNaTela.nome }} — anote agora
      </p>
      <p class="mt-1 text-sm text-tinta-suave">
        Esta senha não fica guardada em lugar nenhum em texto. Fechando este aviso,
        só é possível sortear outra.
      </p>
      <div class="mt-3 flex flex-wrap items-center gap-3">
        <code class="rounded-card border border-linha bg-fundo-card px-4 py-2 font-mono text-lg tracking-wider text-tinta">
          {{ senhaNaTela.senha }}
        </code>
        <button type="button" class="btn-secundario" @click="copiar(senhaNaTela.senha)">
          <IconeMenu nome="copia" :tamanho="18" /> {{ copiado ? 'Copiado' : 'Copiar' }}
        </button>
        <button type="button" class="btn-secundario" @click="senhaNaTela = null">Entendi</button>
      </div>
      <p class="mt-2 text-xs text-tinta-fraca">
        Login: <strong>{{ senhaNaTela.email }}</strong>
      </p>
    </div>

    <div class="card mt-4 overflow-x-auto p-0">
      <table class="w-full min-w-[820px] border-collapse text-sm">
        <thead>
          <tr class="border-b border-linha bg-fundo-cinza/60 text-left">
            <th class="titulo px-4 py-2 text-xs font-bold uppercase tracking-wide text-tinta-rotulo">Pessoa</th>
            <th class="titulo px-3 py-2 text-xs font-bold uppercase tracking-wide text-tinta-rotulo">Papel</th>
            <th class="titulo px-3 py-2 text-xs font-bold uppercase tracking-wide text-tinta-rotulo">Última entrada</th>
            <th class="titulo px-3 py-2 text-xs font-bold uppercase tracking-wide text-tinta-rotulo">Sessões</th>
            <th class="titulo px-4 py-2 text-right text-xs font-bold uppercase tracking-wide text-tinta-rotulo">Ações</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="p in data.pessoas" :key="p.id"
              class="border-b border-linha last:border-0" :class="p.ativo ? '' : 'opacity-55'">
            <td class="px-4 py-3">
              <p class="font-medium text-tinta">
                {{ p.nome }}
                <span v-if="p.id === data.eu" class="selo-neutro ml-1">você</span>
                <span v-if="!p.ativo" class="selo-erro ml-1">DESATIVADO</span>
              </p>
              <p class="text-xs text-tinta-fraca">{{ p.email }}</p>
            </td>
            <td class="px-3 py-3">
              <select :value="p.papel" class="campo py-1 text-sm"
                      :disabled="salvando || p.id === data.eu"
                      @change="mudar(p, { papel: ($event.target as HTMLSelectElement).value })">
                <option v-for="o in PAPEIS" :key="o.v" :value="o.v">{{ o.r }}</option>
              </select>
            </td>
            <td class="px-3 py-3 text-xs text-tinta-suave">
              {{ quando(p.ultimaEntrada) }}
              <span v-if="p.leituras" class="block text-tinta-fraca">
                {{ p.leituras }} leituras na porta
              </span>
            </td>
            <td class="px-3 py-3 text-center tabular-nums"
                :class="p.sessoesAbertas ? 'text-tinta' : 'text-tinta-fraca'">
              {{ p.sessoesAbertas }}
            </td>
            <td class="px-4 py-3 text-right">
              <button type="button" class="px-2 text-sm text-tinta-fraca hover:text-acao"
                      :disabled="salvando" @click="mudar(p, { novaSenha: true })">
                Nova senha
              </button>
              <button type="button" class="px-2 text-sm disabled:opacity-30"
                      :class="confirmando === p.id ? 'font-bold text-erro' : 'text-tinta-fraca hover:text-erro'"
                      :disabled="salvando || p.id === data.eu"
                      @click="p.ativo
                        ? (confirmando === p.id ? mudar(p, { ativo: false }) : confirmando = p.id)
                        : mudar(p, { ativo: true })">
                {{ p.ativo ? (confirmando === p.id ? 'Confirmar' : 'Desativar') : 'Reativar' }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="card mt-4">
      <p class="rotulo-kpi">O que cada papel pode</p>
      <dl class="mt-3 grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
        <div v-for="o in PAPEIS" :key="o.v" class="flex gap-2">
          <dt class="w-28 shrink-0 font-medium text-tinta">{{ o.r }}</dt>
          <dd class="text-tinta-suave">{{ o.d }}</dd>
        </div>
      </dl>
    </div>

    <ModalLateral v-if="novo.aberto" titulo="Dar acesso a alguém" @fechar="novo.aberto = false">
      <div class="grid gap-3">
        <div>
          <label class="rotulo">Nome</label>
          <input v-model="novo.nome" class="campo" placeholder="Nome completo">
        </div>
        <div>
          <label class="rotulo">E-mail (é o login)</label>
          <input v-model="novo.email" type="email" class="campo" placeholder="pessoa@empresa.com.br">
        </div>
        <div>
          <label class="rotulo">Papel</label>
          <select v-model="novo.papel" class="campo">
            <option v-for="o in PAPEIS" :key="o.v" :value="o.v">{{ o.r }} — {{ o.d }}</option>
          </select>
        </div>
        <p class="rounded-card bg-fundo-cinza px-3 py-2 text-xs text-tinta-suave">
          A senha é sorteada pelo sistema e aparece uma vez, na tela, depois de criar.
          Não existe campo de senha aqui de propósito.
        </p>
      </div>
      <template #acoes>
        <button type="button" class="btn-secundario" @click="novo.aberto = false">Cancelar</button>
        <button type="button" class="btn-primario"
                :disabled="salvando || novo.nome.trim().length < 2 || !novo.email.includes('@')"
                @click="criar">
          {{ salvando ? 'Criando…' : 'Criar acesso' }}
        </button>
      </template>
    </ModalLateral>
  </div>

  <p v-else-if="pending" class="card mt-6 text-tinta-suave">Carregando…</p>

  <div v-else class="card mt-6">
    <p class="rotulo-kpi text-erro">Não foi possível carregar a equipe</p>
    <p class="mt-1 text-sm text-tinta-suave">
      {{ (falha as any)?.data?.statusMessage || (falha as any)?.message || 'Erro desconhecido.' }}
    </p>
    <button type="button" class="btn-secundario mt-3" @click="refresh()">Tentar de novo</button>
  </div>
</template>

<style scoped>
/* Animação de montagem em CSS, não <Transition>: com a aba em segundo plano
   o Vue deixaria o bloco parado em opacidade 0 e a senha nunca apareceria. */
@keyframes entra-bloco-kf { from { transform: translateY(-4px); opacity: 0 } to { transform: none; opacity: 1 } }
.entra-bloco { animation: entra-bloco-kf .16s ease-out both }
</style>
