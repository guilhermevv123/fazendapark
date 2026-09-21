<script setup lang="ts">
/**
 * Tela de login.
 *
 * Guarda para onde a pessoa queria ir (`?de=`) e volta pra lá depois de
 * entrar. Cair sempre na home depois do login obriga o operador a refazer o
 * caminho inteiro — e é o tipo de atrito que ninguém reporta como bug.
 */
definePageMeta({ layout: false })

const route = useRoute()
const email = ref('')
const senha = ref('')
const erro = ref('')
const enviando = ref(false)

async function entrar() {
  erro.value = ''
  enviando.value = true
  try {
    await $fetch('/api/auth/entrar', {
      method: 'POST',
      body: { email: email.value.trim(), senha: senha.value },
    })
    const destino = (route.query.de as string) || '/admin'
    // Só aceita destino interno: `?de=https://outro.site` transformaria a
    // tela de login num redirecionador aberto, prato feito pra phishing.
    await navigateTo(destino.startsWith('/') && !destino.startsWith('//') ? destino : '/admin')
  } catch (e: any) {
    erro.value = e?.data?.statusMessage || 'Não foi possível entrar.'
  } finally {
    enviando.value = false
  }
}

useHead({ title: 'Entrar' })
</script>

<template>
  <div class="grid min-h-screen lg:grid-cols-2">
    <!-- lado da marca -->
    <div class="hidden flex-col justify-between bg-menu p-10 text-white lg:flex">
      <p class="titulo text-xl font-black">diamond<span class="font-light">.tickets</span></p>
      <div>
        <p class="titulo text-3xl font-bold leading-tight">
          Ingressos, portaria e dinheiro<br>no mesmo lugar.
        </p>
        <p class="mt-3 max-w-md text-white/70">
          Venda, valide na entrada e acompanhe o caixa do evento sem intermediário
          entre você e o que foi vendido.
        </p>
      </div>
      <p class="text-sm text-white/50">© {{ new Date().getFullYear() }}</p>
    </div>

    <!-- lado do formulário -->
    <div class="flex items-center justify-center bg-fundo p-6">
      <form class="w-full max-w-sm" @submit.prevent="entrar">
        <p class="titulo mb-8 text-xl font-black text-menu lg:hidden">
          diamond<span class="font-light">.tickets</span>
        </p>

        <h1 class="titulo text-2xl font-bold text-tinta">Entrar</h1>
        <p class="mt-1 text-tinta-suave">Use o e-mail da sua conta.</p>

        <div class="mt-6">
          <label for="email" class="rotulo">E-mail</label>
          <input id="email" v-model="email" type="email" autocomplete="username" required
                 class="campo" placeholder="voce@empresa.com.br">
        </div>

        <div class="mt-4">
          <label for="senha" class="rotulo">Senha</label>
          <input id="senha" v-model="senha" type="password" autocomplete="current-password" required
                 class="campo">
        </div>

        <p v-if="erro" class="mt-4 rounded-card border border-erro bg-erro-claro px-3 py-2 text-sm text-erro">
          {{ erro }}
        </p>

        <button type="submit" class="btn-primario mt-6 w-full justify-center" :disabled="enviando">
          {{ enviando ? 'Entrando…' : 'Entrar' }}
        </button>
      </form>
    </div>
  </div>
</template>
