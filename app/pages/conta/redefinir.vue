<script setup lang="ts">
/**
 * /conta/redefinir?t=… — a senha nova pelo link do e-mail (035, item 4.4 da proposta).
 *
 * Ao abrir, pergunta ao servidor se o link ainda vale (sem gastar): vencido avisa antes de a
 * pessoa digitar. Senha nova duas vezes; o servidor confere a régua (8+, nem CPF nem e-mail) antes
 * de gastar o link, grava, derruba as outras sessões e já deixa ESTE aparelho dentro da conta.
 */
import { useContaDoCliente } from '~/composables/contaDoCliente'

const route = useRoute()
const token = computed(() => (typeof route.query.t === 'string' ? route.query.t : ''))
const { carregar, abrir } = useContaDoCliente()

const situacao = ref<'conferindo' | 'valido' | 'vencido'>('conferindo')
const senha = ref('')
const repetir = ref('')
const verSenha = ref(false)
const erro = ref('')
const enviando = ref(false)
const pronto = ref(false)

onMounted(async () => {
  if (!token.value) { situacao.value = 'vencido'; return }
  try {
    const r = await $fetch<any>('/api/conta/senha/link', { query: { t: token.value } })
    situacao.value = r.valido ? 'valido' : 'vencido'
  } catch {
    // sem resposta: deixa tentar — quem decide de verdade é o POST
    situacao.value = 'valido'
  }
})

async function salvar() {
  erro.value = ''
  if (senha.value.length < 8) { erro.value = 'A senha precisa de pelo menos 8 caracteres.'; return }
  if (senha.value !== repetir.value) { erro.value = 'As duas senhas não são iguais.'; return }
  enviando.value = true
  try {
    await $fetch('/api/conta/senha/redefinir', { method: 'POST', body: { token: token.value, senha: senha.value } })
    senha.value = ''
    repetir.value = ''
    pronto.value = true
    await carregar(null)
  } catch (e: any) {
    if (e?.statusCode === 410 || e?.data?.data?.tipo === 'link') situacao.value = 'vencido'
    erro.value = e?.data?.statusMessage || 'Não deu certo agora. Confira a internet e tente de novo.'
  } finally {
    enviando.value = false
  }
}

useHead({ title: 'Criar senha nova', meta: [{ name: 'robots', content: 'noindex' }] })
</script>

<template>
  <div class="min-h-screen">
    <CabecalhoPublico largura="max-w-3xl" :conta="false" />
    <main class="mx-auto max-w-md px-4 pb-16 pt-8">
      <h1 class="titulo text-2xl font-semibold text-tinta">Criar senha nova</h1>

      <p v-if="situacao === 'conferindo'" class="mt-4 text-tinta-suave">Conferindo o link…</p>

      <div v-else-if="pronto" class="card mt-5" data-parte="senha-trocada" role="status">
        <p class="font-semibold text-tinta">Pronto: sua senha foi trocada.</p>
        <p class="mt-1 text-sm text-tinta-suave">Você já está dentro da conta. Os outros aparelhos saíram.</p>
        <NuxtLink to="/conta" class="btn-cta mt-4 block w-full py-3 text-center text-base">Ir para Minha conta</NuxtLink>
      </div>

      <div v-else-if="situacao === 'vencido'" class="card mt-5" data-parte="link-vencido">
        <p class="font-semibold text-tinta">Este link não vale mais.</p>
        <p class="mt-1 text-sm text-tinta-suave">
          Ele vence em 30 minutos, funciona uma vez só e deixa de valer quando um link mais novo é pedido.
        </p>
        <button type="button" class="btn-cta mt-4 w-full py-3 text-base" @click="abrir('entrar', null)">
          Pedir outro link
        </button>
      </div>

      <form v-else class="card mt-5 space-y-4" novalidate data-parte="nova-senha" @submit.prevent="salvar">
        <div>
          <label for="senha-nova" class="rotulo">Senha nova</label>
          <div class="relative">
            <input id="senha-nova" v-model="senha" :type="verSenha ? 'text' : 'password'" autocomplete="new-password"
                   class="campo pr-20">
            <button type="button" class="absolute inset-y-0 right-0 px-3 text-sm font-semibold text-acao"
                    :aria-pressed="verSenha" @click="verSenha = !verSenha">
              {{ verSenha ? 'Esconder' : 'Mostrar' }}
            </button>
          </div>
          <p class="mt-1 text-xs text-tinta-suave">Pelo menos 8 caracteres. Não use o CPF nem o e-mail.</p>
        </div>
        <div>
          <label for="senha-repetir" class="rotulo">Repita a senha nova</label>
          <input id="senha-repetir" v-model="repetir" :type="verSenha ? 'text' : 'password'" autocomplete="new-password"
                 class="campo">
        </div>
        <p v-if="erro" class="faixa-erro" role="alert">{{ erro }}</p>
        <button type="submit" class="btn-cta w-full py-3 text-base" :disabled="enviando">
          {{ enviando ? 'Salvando…' : 'Salvar a senha nova' }}
        </button>
      </form>
    </main>
  </div>
</template>
