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

import PainelFalha from '~/components/painel/Falha.vue'

const { data, refresh, pending, error: falha } = await useFetch<any>('/api/admin/equipe')

const erro = ref('')
const salvando = ref(false)
const senhaNaTela = ref<{ nome: string; email: string; senha: string; papel?: string } | null>(null)
/** Duas confirmações em dois passos, cada uma com o seu estado: clicar
 *  "Desativar" numa linha não pode deixar "Nova senha" armado na mesma. */
const confirmando = ref('')
const confirmandoSenha = ref('')
/**
 * O `<select>` de papel é controlado por `:value`. Quando o servidor recusa
 * (422), `p.papel` não muda — então o Vue não tem o que corrigir e o select
 * continua mostrando o papel que NÃO foi gravado. Trocar a `key` depois do
 * erro recria o elemento com o valor verdadeiro.
 */
const versaoDasLinhas = ref(0)

/**
 * A lista de papéis vem do SERVIDOR (`data.papeis`), não daqui. Ela já foi
 * uma cópia escrita nesta página, e cópia de regra de permissão envelhece
 * calada: a grade muda no servidor e a tela continua prometendo o antigo,
 * sem erro, sem aviso, até alguém descobrir que "Marketing" não existe mais.
 */
type PapelDoCatalogo = { valor: string; rotulo: string; resumo: string; areas: string[] }
const papeis = computed<PapelDoCatalogo[]>(() => data.value?.papeis ?? [])
const rotuloDoPapel = (v: string) =>
  papeis.value.find((p) => p.valor === v)?.rotulo ?? v

const novo = reactive({ aberto: false, nome: '', email: '', papel: 'operacao' })
function abrirNovo() {
  erro.value = ''
  novo.aberto = true
}

async function criar() {
  erro.value = ''
  salvando.value = true
  try {
    const r = await $fetch<any>('/api/admin/equipe', {
      method: 'POST',
      body: { nome: novo.nome, email: novo.email, papel: novo.papel },
    })
    senhaNaTela.value = { nome: r.usuario.nome, email: r.usuario.email,
                          senha: r.senhaProvisoria, papel: r.usuario.papel }
    Object.assign(novo, { aberto: false, nome: '', email: '', papel: 'operacao' })
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
    versaoDasLinhas.value++
  } finally {
    salvando.value = false
    confirmando.value = ''
    confirmandoSenha.value = ''
  }
}

/**
 * EQP-01: trocar o papel no select PEDE confirmação antes de gravar.
 *
 * Gravar derruba todas as sessões da pessoa (`equipe/index.patch.ts`: quem foi rebaixado não pode
 * seguir com a tela velha aberta) — e antes isso acontecia no primeiro toque no select: mudar a
 * portaria pra Operação no meio do evento desconectava o celular do portão sem aviso. Agora o select
 * só ARMA a troca; a linha mostra o que vai acontecer, com o nome, e grava no "Confirmar troca".
 * Cancelar devolve o select ao papel verdadeiro (a `key` da linha muda e ele é recriado).
 */
const trocaDePapel = ref<{ id: string; nome: string; de: string; para: string; sessoes: number } | null>(null)
function armarTroca(p: any, para: string) {
  confirmando.value = ''
  confirmandoSenha.value = ''
  if (para === p.papel) { trocaDePapel.value = null; return }
  trocaDePapel.value = { id: p.id, nome: p.nome, de: p.papel, para, sessoes: Number(p.sessoesAbertas) || 0 }
}
function cancelarTroca() {
  trocaDePapel.value = null
  versaoDasLinhas.value++
}
async function confirmarTroca(p: any) {
  const t = trocaDePapel.value
  if (!t || t.id !== p.id) return
  trocaDePapel.value = null
  await mudar(p, { papel: t.para })
}

/** "Nova senha": primeiro clique arma, segundo sorteia. Derruba as sessões da pessoa. */
function pedirNovaSenha(p: any) {
  confirmando.value = ''
  if (trocaDePapel.value) cancelarTroca()
  if (confirmandoSenha.value === p.id) return mudar(p, { novaSenha: true })
  confirmandoSenha.value = p.id
}

function pedirDesativar(p: any) {
  confirmandoSenha.value = ''
  if (trocaDePapel.value) cancelarTroca()
  if (!p.ativo) return mudar(p, { ativo: true })
  if (confirmando.value === p.id) return mudar(p, { ativo: false })
  confirmando.value = p.id
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
  <div>
    <template v-if="data">
      <div class="flex flex-wrap items-start justify-between gap-3 py-5">
        <div>
          <h1 class="titulo text-2xl font-semibold text-tinta">Equipe</h1>
          <p class="mt-1 text-tinta-suave">
            Quem entra no painel de {{ data.organizacao?.nome }} e com que poder.
          </p>
        </div>
        <button type="button" class="btn-primario" @click="abrirNovo">
          Dar acesso a alguém
        </button>
      </div>

      <p v-if="erro" class="rounded-card border border-erro bg-erro-claro px-3 py-2 text-sm text-erro">
        {{ erro }}
      </p>
    </template>

    <!-- A senha sorteada fica FORA do `v-if="data"`: se o refresh depois do
         sorteio falhar, o Nuxt zera `data` e a senha — que só existe aqui —
         sumiria junto com a tabela. -->
    <div v-if="senhaNaTela"
         class="mt-4 rounded-card border-2 border-acao bg-acao-fraco px-5 py-4 entra-bloco">
      <p class="titulo text-base font-semibold text-tinta">
        Senha provisória de {{ senhaNaTela.nome }} — anote agora
      </p>
      <p class="mt-1 text-sm text-tinta-suave">
        Entregue esta senha. No primeiro acesso a pessoa entra com ela e o sistema pede pra criar
        a própria — a partir daí, esta deixa de valer. Fechando este aviso, só é possível sortear outra.
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
        <span v-if="senhaNaTela.papel"> — acesso de {{ rotuloDoPapel(senhaNaTela.papel) }}</span>
      </p>
    </div>

    <div v-if="data">
      <div class="card mt-4 overflow-x-auto p-0">
        <table class="w-full min-w-[820px] border-collapse text-sm">
          <thead>
            <tr class="border-b border-linha bg-fundo-cinza/60 text-left">
              <th class="titulo px-4 py-2 text-xs font-semibold uppercase tracking-wide text-tinta-rotulo">Pessoa</th>
              <th class="titulo px-3 py-2 text-xs font-semibold uppercase tracking-wide text-tinta-rotulo">Papel</th>
              <th class="titulo px-3 py-2 text-xs font-semibold uppercase tracking-wide text-tinta-rotulo">Última entrada</th>
              <th class="titulo px-3 py-2 text-xs font-semibold uppercase tracking-wide text-tinta-rotulo">Sessões</th>
              <th class="titulo px-4 py-2 text-right text-xs font-semibold uppercase tracking-wide text-tinta-rotulo">Ações</th>
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
                  <span v-else-if="p.senhaProvisoria" class="selo-alerta ml-1"
                        title="Ainda não entrou para criar a própria senha">SENHA PROVISÓRIA</span>
                </p>
                <p class="text-xs text-tinta-fraca">{{ p.email }}</p>
              </td>
              <td class="px-3 py-3">
                <select :key="`${p.id}-${versaoDasLinhas}`" :value="p.papel" class="campo min-h-[40px] py-1 text-sm"
                        data-parte="papel" :aria-label="`Papel de ${p.nome}`"
                        :disabled="salvando || p.id === data.eu"
                        :title="p.id === data.eu ? 'O próprio papel não se muda aqui — peça a outro master.' : undefined"
                        @change="armarTroca(p, ($event.target as HTMLSelectElement).value)">
                  <option v-for="o in papeis" :key="o.valor" :value="o.valor">{{ o.rotulo }}</option>
                </select>
                <!-- EQP-01: a troca só grava depois daqui, e diz o que vai acontecer com quem está dentro -->
                <div v-if="trocaDePapel?.id === p.id" class="mt-2 max-w-[18rem] rounded-card border border-alerta bg-alerta-claro px-3 py-2 text-xs text-tinta"
                     role="alert" data-parte="confirmar-papel">
                  <p>
                    Mudar <strong>{{ p.nome }}</strong> de {{ rotuloDoPapel(trocaDePapel.de) }} para
                    <strong>{{ rotuloDoPapel(trocaDePapel.para) }}</strong>?
                    {{ trocaDePapel.sessoes
                      ? `Isso desconecta ${p.nome} agora (${trocaDePapel.sessoes} ${trocaDePapel.sessoes === 1 ? 'sessão aberta' : 'sessões abertas'}); `
                      : `Se ${p.nome} estiver dentro, sai na hora; ` }}
                    entra de novo com a mesma senha, já com o menu novo.
                  </p>
                  <div class="mt-2 flex flex-wrap gap-2">
                    <button type="button" class="btn-primario min-h-[40px] px-3 py-1 text-xs" data-acao="confirmar-papel"
                            :disabled="salvando" @click="confirmarTroca(p)">
                      Confirmar troca
                    </button>
                    <button type="button" class="btn-secundario min-h-[40px] px-3 py-1 text-xs" data-acao="cancelar-papel"
                            @click="cancelarTroca">
                      Cancelar
                    </button>
                  </div>
                </div>
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
                <!-- Na linha "você" fica travado: sortear a própria senha derrubava
                     a sessão de quem clicou. A própria se troca no menu da conta. -->
                <button type="button" class="min-h-[40px] px-2 text-sm disabled:opacity-30"
                        data-acao="nova-senha"
                        :class="confirmandoSenha === p.id ? 'font-semibold text-acao' : 'text-tinta-fraca hover:text-acao'"
                        :disabled="salvando || p.id === data.eu"
                        :title="p.id === data.eu ? 'Pra trocar a sua senha, use “Trocar senha” no menu da conta.' : undefined"
                        @click="pedirNovaSenha(p)">
                  {{ confirmandoSenha === p.id ? 'Confirmar nova senha' : 'Nova senha' }}
                </button>
                <button type="button" class="min-h-[40px] px-2 text-sm disabled:opacity-30"
                        data-acao="desativar"
                        :class="confirmando === p.id ? 'font-semibold text-erro' : 'text-tinta-fraca hover:text-erro'"
                        :disabled="salvando || p.id === data.eu"
                        @click="pedirDesativar(p)">
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
          <div v-for="o in papeis" :key="o.valor" class="flex gap-2">
            <dt class="w-28 shrink-0 font-medium text-tinta">{{ o.rotulo }}</dt>
            <dd class="text-tinta-suave">{{ o.resumo }}</dd>
          </div>
        </dl>
        <p class="mt-3 border-t border-linha pt-3 text-xs text-tinta-fraca">
          Quem tranca é o servidor, em toda chamada — não o menu. Rebaixar alguém
          aqui vale na requisição seguinte, mesmo com a tela dele já aberta.
        </p>
      </div>

      <ModalLateral v-if="novo.aberto" titulo="Dar acesso a alguém" @fechar="novo.aberto = false">
        <div class="grid gap-3">
          <!-- o erro repete aqui dentro: o de cima da página fica atrás do fundo escuro -->
          <p v-if="erro" class="rounded-card border border-erro bg-erro-claro px-3 py-2 text-sm text-erro" role="alert">
            {{ erro }}
          </p>
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
              <option v-for="o in papeis" :key="o.valor" :value="o.valor">{{ o.rotulo }}</option>
            </select>
            <p class="mt-1 text-xs text-tinta-suave">
              {{ papeis.find((o) => o.valor === novo.papel)?.resumo }}
            </p>
          </div>
          <p class="rounded-card bg-fundo-cinza px-3 py-2 text-xs text-tinta-suave">
            O sistema sorteia uma senha provisória e mostra uma vez, depois de criar. No primeiro
            acesso a pessoa entra com ela e cria a própria senha.
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

    <!-- GER-01: 403 diz o motivo sem "Tentar de novo"; sessão vencida leva ao login -->
    <PainelFalha v-else :falha="falha" o-que="a equipe" :tentar="refresh" />
  </div>
</template>

<style scoped>
/* Animação de montagem em CSS, não <Transition>: com a aba em segundo plano
   o Vue deixaria o bloco parado em opacidade 0 e a senha nunca apareceria. */
@keyframes entra-bloco-kf { from { transform: translateY(-4px); opacity: 0 } to { transform: none; opacity: 1 } }
.entra-bloco { animation: entra-bloco-kf .16s ease-out both }
</style>
