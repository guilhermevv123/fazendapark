<script setup lang="ts">
/**
 * A janela de entrar / criar a conta do cliente (034) — abre de qualquer tela do site: o botão
 * "Entrar" do cabeçalho, ou o checkout quando a pessoa chega sem conta.
 *
 * No celular ela sobe de baixo (o polegar alcança o botão); no computador fica no meio. Esc e o
 * fundo fecham; o Tab não escapa enquanto ela está aberta.
 *
 * Criar a conta pede só o que o parque vai usar: nome completo, CPF, e-mail, celular e senha. O
 * Instagram e a cidade ficam num bloco "opcional", fechado.
 */
import {
  mascaraCep, mascaraCpf, mascaraLogin, mascaraTel, useContaDoCliente,
} from '~/composables/contaDoCliente'
import { prenderTab, soltarRolagem, travarRolagem } from '~/composables/painelFoco'
import { UFS } from '~~/server/utils/cadastro'
import { cpfValido } from '~~/server/utils/documento'

const { estado, janela, fechar, entrar, criar, urlSocial } = useContaDoCliente()
const route = useRoute()

const aba = computed({
  get: () => janela.value.aba,
  set: (v) => { janela.value = { ...janela.value, aba: v }; erro.value = ''; campoComErro.value = '' },
})
const enviando = ref(false)
const erro = ref('')
const campoComErro = ref('')
const verSenha = ref(false)
const mais = ref(false)
const buscandoCep = ref(false)
const painel = ref<HTMLElement | null>(null)

const login = reactive({ usuario: '', senha: '' })
/** "Esqueci a senha" (035): o mesmo campo de CPF/e-mail, e a resposta que não revela quem tem conta */
const esqueci = ref(false)
const esqueciEnviado = ref('')
const novo = reactive({
  nome: '', cpf: '', email: '', telefone: '', senha: '',
  instagram: '', cep: '', cidade: '', estado: '', aceitaNovidades: false,
})

/** CPF com os 11 números e o dígito errado: avisa na hora (a MESMA conta do servidor, `documento.ts`) */
const cpfTorto = computed(() => {
  const d = novo.cpf.replace(/\D/g, '')
  return d.length === 11 && !cpfValido(d)
})
const marca = (campo: string) => (campoComErro.value === campo ? 'ring-2 ring-danger-600' : '')
const invalido = (campo: string) => (campoComErro.value === campo ? 'true' : undefined)

function tecla(e: KeyboardEvent) {
  if (e.key === 'Escape') fechar()
  else prenderTab(painel.value, e)
}

// A janela só existe aberta (o app.vue a monta com `v-if`): montar = abrir, desmontar = fechar.
let quemAbriu: HTMLElement | null = null
onMounted(() => {
  quemAbriu = document.activeElement as HTMLElement | null
  travarRolagem()
  document.addEventListener('keydown', tecla)
  // no celular, focar o campo sobe o teclado por cima da janela antes de a pessoa ler o que é
  const dedo = window.matchMedia?.('(pointer: coarse)').matches
  nextTick(() => (dedo ? painel.value : painel.value?.querySelector<HTMLElement>('input'))?.focus())
})
onBeforeUnmount(() => {
  soltarRolagem()
  document.removeEventListener('keydown', tecla)
  if (quemAbriu?.isConnected) quemAbriu.focus()
})

function falhou(e: any) {
  erro.value = e?.data?.statusMessage || 'Não deu certo agora. Confira a internet e tente de novo.'
  campoComErro.value = e?.data?.data?.campo || ''
  nextTick(() => {
    if (campoComErro.value) document.getElementById(`conta-${campoComErro.value}`)?.focus()
  })
}

async function enviarEntrar() {
  erro.value = ''
  campoComErro.value = ''
  if (!login.usuario.trim() || !login.senha) {
    erro.value = 'Digite o CPF (ou e-mail) e a senha.'
    campoComErro.value = !login.usuario.trim() ? 'login' : 'senha'
    return
  }
  enviando.value = true
  try {
    await entrar(login.usuario, login.senha)
    login.senha = ''
    fechar()
  } catch (e) { falhou(e) } finally { enviando.value = false }
}

async function enviarEsqueci() {
  erro.value = ''
  campoComErro.value = ''
  if (!login.usuario.trim()) {
    erro.value = 'Digite o seu CPF ou o e-mail da conta.'
    campoComErro.value = 'login'
    return
  }
  enviando.value = true
  try {
    const r = await $fetch<any>('/api/conta/senha/esqueci', {
      method: 'POST', body: { login: login.usuario, evento: estado.value.evento },
    })
    esqueciEnviado.value = r.mensagem
  } catch (e) { falhou(e) } finally { enviando.value = false }
}
function abrirEsqueci(sim: boolean) {
  esqueci.value = sim
  esqueciEnviado.value = ''
  erro.value = ''
  campoComErro.value = ''
}

async function enviarCriar() {
  erro.value = ''
  campoComErro.value = ''
  if (cpfTorto.value) {
    erro.value = 'CPF inválido. Confira os 11 números.'
    campoComErro.value = 'cpf'
    nextTick(() => document.getElementById('conta-cpf')?.focus())
    return
  }
  enviando.value = true
  try {
    await criar({
      nome: novo.nome, cpf: novo.cpf, email: novo.email, telefone: novo.telefone, senha: novo.senha,
      instagram: novo.instagram || null,
      endereco: novo.cidade || novo.estado || novo.cep
        ? { cep: novo.cep, cidade: novo.cidade, estado: novo.estado }
        : null,
      aceitaNovidades: novo.aceitaNovidades,
    })
    novo.senha = ''
    fechar()
  } catch (e) {
    falhou(e)
    if (['instagram', 'cep', 'cidade', 'estado'].includes(campoComErro.value)) mais.value = true
  } finally { enviando.value = false }
}

async function buscarCep() {
  const cep = novo.cep.replace(/\D/g, '')
  if (cep.length !== 8) return
  buscandoCep.value = true
  try {
    const r: any = await $fetch(`https://viacep.com.br/ws/${cep}/json/`)
    if (novo.cep.replace(/\D/g, '') !== cep || r?.erro) return
    novo.cidade = r.localidade || novo.cidade
    novo.estado = r.uf || novo.estado
  } catch { /* sem CEP, a pessoa digita a cidade */ } finally { buscandoCep.value = false }
}

const temSocial = computed(() => estado.value.social.google || estado.value.social.apple)
</script>

<template>
  <Teleport to="body">
    <div class="fixed inset-0 z-[60] flex items-end justify-center bg-ink-950/60 sm:items-center sm:p-4"
         data-parte="janela-da-conta" @click.self="fechar()">
      <div ref="painel" role="dialog" aria-modal="true" aria-labelledby="titulo-da-conta" tabindex="-1"
           class="outline-none max-h-[92dvh] w-full overflow-y-auto rounded-t-2xl bg-white shadow-2xl sm:max-w-md sm:rounded-2xl">
        <div class="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-ink-100 bg-white px-5 py-4">
          <h2 id="titulo-da-conta" class="titulo text-xl font-bold text-tinta">
            {{ aba === 'entrar' ? 'Entre na sua conta' : 'Crie a sua conta' }}
          </h2>
          <button type="button" aria-label="Fechar"
                  class="grid h-10 w-10 place-items-center rounded-lg text-ink-600 transition-colors hover:bg-ink-100 hover:text-ink-900"
                  @click="fechar()">
            <svg viewBox="0 0 24 24" class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" stroke-linecap="round" />
            </svg>
          </button>
        </div>

        <div class="px-5 pb-6 pt-4">
          <p v-if="janela.motivo" class="faixa-aviso mb-4" role="status">{{ janela.motivo }}</p>

          <div class="grid grid-cols-2 gap-1 rounded-xl bg-ink-100 p-1" role="tablist" aria-label="Entrar ou criar conta">
            <button type="button" role="tab" :aria-selected="aba === 'entrar'"
                    class="min-h-[42px] rounded-lg text-sm font-semibold transition-colors"
                    :class="aba === 'entrar' ? 'bg-white text-tinta shadow-sm' : 'text-ink-600 hover:text-ink-900'"
                    @click="aba = 'entrar'">
              Já tenho conta
            </button>
            <button type="button" role="tab" :aria-selected="aba === 'criar'"
                    class="min-h-[42px] rounded-lg text-sm font-semibold transition-colors"
                    :class="aba === 'criar' ? 'bg-white text-tinta shadow-sm' : 'text-ink-600 hover:text-ink-900'"
                    @click="aba = 'criar'">
              Criar conta
            </button>
          </div>

          <!-- Google / Apple: só com as chaves no servidor -->
          <div v-if="temSocial" class="mt-4 grid gap-2">
            <a v-if="estado.social.google" :href="urlSocial('google', route.fullPath)"
               class="flex min-h-[46px] items-center justify-center gap-3 rounded-lg border border-ink-300 bg-white px-4 text-sm font-semibold text-ink-900 transition-colors hover:bg-ink-50">
              <svg viewBox="0 0 48 48" class="h-5 w-5" aria-hidden="true">
                <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.2-.1-2.3-.4-3.5z" />
                <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
                <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z" />
                <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.2-.1-2.3-.4-3.5z" />
              </svg>
              Continuar com o Google
            </a>
            <a v-if="estado.social.apple" :href="urlSocial('apple', route.fullPath)"
               class="flex min-h-[46px] items-center justify-center gap-3 rounded-lg bg-black px-4 text-sm font-semibold text-white transition-colors hover:bg-ink-900">
              <svg viewBox="0 0 24 24" class="h-5 w-5" fill="currentColor" aria-hidden="true">
                <path d="M16.37 1.43c0 1.14-.42 2.2-1.25 3.06-.9.93-2 1.47-3.18 1.38a3.3 3.3 0 0 1-.02-.42c0-1.1.47-2.27 1.3-3.14.42-.44.95-.8 1.6-1.09.65-.28 1.26-.43 1.83-.46.02.23.03.45.03.67zM20.9 17.3c-.39.9-.85 1.72-1.39 2.49-.73 1.04-1.33 1.76-1.8 2.16-.72.66-1.49 1-2.32 1.02-.6 0-1.31-.17-2.15-.51-.84-.34-1.6-.51-2.3-.51-.74 0-1.53.17-2.38.51-.85.34-1.54.52-2.06.54-.8.03-1.59-.32-2.38-1.05-.5-.44-1.13-1.19-1.88-2.26-.8-1.13-1.46-2.44-1.98-3.93C.72 14.16.46 12.6.46 11.1c0-1.73.37-3.22 1.12-4.47a6.58 6.58 0 0 1 2.35-2.38 6.32 6.32 0 0 1 3.18-.9c.62 0 1.44.2 2.46.58 1.01.38 1.66.57 1.95.57.21 0 .94-.23 2.18-.67 1.17-.42 2.16-.6 2.97-.53 2.2.18 3.85 1.04 4.95 2.6-1.97 1.19-2.94 2.86-2.92 5 .02 1.67.62 3.06 1.8 4.16.54.51 1.14.9 1.8 1.18-.14.42-.3.82-.46 1.21z" />
              </svg>
              Continuar com a Apple
            </a>
            <p class="mt-1 flex items-center gap-3 text-xs text-tinta-fraca">
              <span class="h-px flex-1 bg-ink-200" /> ou com o seu CPF <span class="h-px flex-1 bg-ink-200" />
            </p>
          </div>

          <!-- ------------------------------------------------------------ entrar -->
          <!-- ----------------------------------------------------- esqueci a senha -->
          <form v-if="aba === 'entrar' && esqueci" class="mt-4 space-y-4" novalidate data-parte="esqueci-senha"
                @submit.prevent="enviarEsqueci">
            <div>
              <p class="titulo text-lg font-semibold text-tinta">Esqueci a senha</p>
              <p class="mt-1 text-sm text-tinta-suave">
                Digite o CPF ou o e-mail da conta. Mandamos um link para o e-mail cadastrado criar uma senha nova.
              </p>
            </div>
            <div>
              <label for="conta-login" class="rotulo">CPF ou e-mail</label>
              <input id="conta-login" :value="login.usuario" autocomplete="username" autocapitalize="none"
                     inputmode="email" class="campo" :class="marca('login')" :aria-invalid="invalido('login')"
                     placeholder="000.000.000-00"
                     @input="login.usuario = mascaraLogin(($event.target as HTMLInputElement).value)">
            </div>
            <p v-if="esqueciEnviado" class="faixa-aviso" role="status" data-parte="esqueci-enviado">{{ esqueciEnviado }}</p>
            <p v-if="erro" class="faixa-erro" role="alert">{{ erro }}</p>
            <button v-if="!esqueciEnviado" type="submit" class="btn-cta w-full py-3 text-base" :disabled="enviando">
              {{ enviando ? 'Enviando…' : 'Enviar o link' }}
            </button>
            <p class="text-center text-sm">
              <button type="button" class="font-semibold text-acao hover:underline" @click="abrirEsqueci(false)">
                Voltar para entrar
              </button>
            </p>
          </form>

          <form v-else-if="aba === 'entrar'" class="mt-4 space-y-4" novalidate @submit.prevent="enviarEntrar">
            <div>
              <label for="conta-login" class="rotulo">CPF ou e-mail</label>
              <input id="conta-login" :value="login.usuario" autocomplete="username" autocapitalize="none"
                     inputmode="email" class="campo" :class="marca('login')" :aria-invalid="invalido('login')"
                     placeholder="000.000.000-00"
                     @input="login.usuario = mascaraLogin(($event.target as HTMLInputElement).value)">
            </div>
            <div>
              <label for="conta-senha" class="rotulo">Senha</label>
              <div class="relative">
                <input id="conta-senha" v-model="login.senha" :type="verSenha ? 'text' : 'password'"
                       autocomplete="current-password" class="campo pr-20" :class="marca('senha')"
                       :aria-invalid="invalido('senha')">
                <button type="button" class="absolute inset-y-0 right-0 px-3 text-sm font-semibold text-acao"
                        :aria-pressed="verSenha" @click="verSenha = !verSenha">
                  {{ verSenha ? 'Esconder' : 'Mostrar' }}
                </button>
              </div>
            </div>
            <p class="-mt-2 text-right">
              <button type="button" class="text-sm font-semibold text-acao hover:underline" data-parte="abrir-esqueci"
                      @click="abrirEsqueci(true)">
                Esqueci a senha
              </button>
            </p>
            <p v-if="erro" class="faixa-erro" role="alert">{{ erro }}</p>
            <button type="submit" class="btn-cta w-full py-3 text-base" :disabled="enviando">
              {{ enviando ? 'Entrando…' : 'Entrar' }}
            </button>
            <p class="text-center text-sm text-tinta-suave">
              Ainda não tem conta?
              <button type="button" class="font-semibold text-acao hover:underline" @click="aba = 'criar'">
                Criar agora
              </button>
            </p>
          </form>

          <!-- ------------------------------------------------------------- criar -->
          <form v-else class="mt-4 space-y-4" novalidate @submit.prevent="enviarCriar">
            <div>
              <label for="conta-nome" class="rotulo">Nome completo</label>
              <input id="conta-nome" v-model="novo.nome" autocomplete="name" maxlength="120"
                     class="campo" :class="marca('nome')" :aria-invalid="invalido('nome')">
              <p class="mt-1 text-xs text-tinta-fraca">Vai impresso no ingresso.</p>
            </div>
            <div class="grid gap-4 sm:grid-cols-2">
              <div>
                <label for="conta-cpf" class="rotulo">CPF</label>
                <input id="conta-cpf" :value="novo.cpf" inputmode="numeric" autocomplete="off"
                       class="campo tabular-nums" :class="cpfTorto ? 'ring-2 ring-danger-600' : marca('cpf')"
                       :aria-invalid="cpfTorto ? 'true' : invalido('cpf')" aria-describedby="conta-cpf-aviso"
                       placeholder="000.000.000-00"
                       @input="novo.cpf = mascaraCpf(($event.target as HTMLInputElement).value)">
                <p v-if="cpfTorto" id="conta-cpf-aviso" class="mt-1 text-sm font-semibold text-erro" data-parte="cpf-invalido">
                  CPF inválido. Confira os 11 números.
                </p>
              </div>
              <div>
                <label for="conta-telefone" class="rotulo">Celular (WhatsApp)</label>
                <input id="conta-telefone" :value="novo.telefone" inputmode="numeric" autocomplete="tel"
                       class="campo tabular-nums" :class="marca('telefone')" :aria-invalid="invalido('telefone')"
                       placeholder="(73) 99999-0000"
                       @input="novo.telefone = mascaraTel(($event.target as HTMLInputElement).value)">
              </div>
            </div>
            <div>
              <label for="conta-email" class="rotulo">E-mail</label>
              <input id="conta-email" v-model="novo.email" type="email" autocomplete="email" maxlength="160"
                     class="campo" :class="marca('email')" :aria-invalid="invalido('email')">
              <p class="mt-1 text-xs text-tinta-fraca">É pra onde vão os ingressos.</p>
            </div>
            <div>
              <label for="conta-senha-nova" class="rotulo">Crie uma senha</label>
              <div class="relative">
                <input id="conta-senha-nova" v-model="novo.senha" :type="verSenha ? 'text' : 'password'"
                       autocomplete="new-password" class="campo pr-20" :class="marca('senha')"
                       :aria-invalid="invalido('senha')">
                <button type="button" class="absolute inset-y-0 right-0 px-3 text-sm font-semibold text-acao"
                        :aria-pressed="verSenha" @click="verSenha = !verSenha">
                  {{ verSenha ? 'Esconder' : 'Mostrar' }}
                </button>
              </div>
              <p class="mt-1 text-xs text-tinta-fraca">Pelo menos 8 caracteres. Você entra com o CPF e esta senha.</p>
            </div>

            <div class="rounded-xl border border-ink-200">
              <button type="button" class="flex w-full items-center justify-between px-4 py-3 text-left text-sm font-semibold text-tinta"
                      :aria-expanded="mais" @click="mais = !mais">
                <span>Instagram e cidade <span class="font-normal text-tinta-fraca">(opcional)</span></span>
                <svg viewBox="0 0 20 20" class="h-4 w-4 transition-transform" :class="mais ? 'rotate-180' : ''"
                     fill="currentColor" aria-hidden="true"><path d="M5.3 7.3a1 1 0 0 1 1.4 0L10 10.6l3.3-3.3a1 1 0 1 1 1.4 1.4l-4 4a1 1 0 0 1-1.4 0l-4-4a1 1 0 0 1 0-1.4z" /></svg>
              </button>
              <div v-if="mais" class="space-y-4 border-t border-ink-200 px-4 pb-4 pt-3">
                <div>
                  <label for="conta-instagram" class="rotulo">Instagram</label>
                  <input id="conta-instagram" v-model="novo.instagram" placeholder="@seunome" autocapitalize="none"
                         maxlength="60" class="campo" :class="marca('instagram')" :aria-invalid="invalido('instagram')">
                </div>
                <div class="grid grid-cols-[1fr_5.5rem] gap-3 sm:grid-cols-[8rem_1fr_5.5rem]">
                  <div class="col-span-2 sm:col-span-1">
                    <label for="conta-cep" class="rotulo">CEP</label>
                    <input id="conta-cep" :value="novo.cep" inputmode="numeric" placeholder="00000-000"
                           autocomplete="postal-code" class="campo tabular-nums" :class="marca('cep')"
                           :aria-invalid="invalido('cep')"
                           @input="novo.cep = mascaraCep(($event.target as HTMLInputElement).value); buscarCep()">
                  </div>
                  <div>
                    <label for="conta-cidade" class="rotulo">Cidade</label>
                    <input id="conta-cidade" v-model="novo.cidade" autocomplete="address-level2" maxlength="80"
                           class="campo" :class="marca('cidade')" :aria-invalid="invalido('cidade')">
                  </div>
                  <div>
                    <label for="conta-estado" class="rotulo">UF</label>
                    <select id="conta-estado" v-model="novo.estado" class="campo" :class="marca('estado')"
                            :aria-invalid="invalido('estado')">
                      <option value="">—</option>
                      <option v-for="uf in UFS" :key="uf" :value="uf">{{ uf }}</option>
                    </select>
                  </div>
                </div>
                <p v-if="buscandoCep" class="-mt-2 text-xs text-tinta-suave">Buscando o CEP…</p>
              </div>
            </div>

            <label class="flex items-start gap-2.5 text-sm text-tinta-corpo">
              <input v-model="novo.aceitaNovidades" type="checkbox" class="mt-1 h-4 w-4 accent-pool-600">
              <span>Quero receber novidades e ofertas do parque por WhatsApp, e-mail e Instagram.</span>
            </label>

            <p v-if="erro" class="faixa-erro" role="alert">{{ erro }}</p>
            <button type="submit" class="btn-cta w-full py-3 text-base" :disabled="enviando">
              {{ enviando ? 'Criando a conta…' : 'Criar conta e continuar' }}
            </button>
            <p class="text-center text-xs text-tinta-fraca">
              Ao criar a conta você concorda com os
              <NuxtLink to="/termos" target="_blank" class="font-semibold text-acao hover:underline">termos</NuxtLink>
              e a
              <NuxtLink to="/privacidade" target="_blank" class="font-semibold text-acao hover:underline">política de privacidade</NuxtLink>.
            </p>
          </form>
        </div>
      </div>
    </div>
  </Teleport>
</template>
