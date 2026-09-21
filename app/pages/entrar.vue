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
  <div class="grid min-h-dvh bg-white lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
    <!-- lado da marca: o roxo da logo, com a luz da piscina se movendo devagar -->
    <aside class="relative isolate hidden overflow-hidden bg-grape-950 lg:block">
      <div aria-hidden="true"
           class="absolute -inset-[20%] -z-10 animate-drift bg-[radial-gradient(40%_34%_at_28%_32%,rgb(79_198_219/0.55),transparent_70%),radial-gradient(36%_30%_at_74%_66%,rgb(143_212_234/0.32),transparent_70%),radial-gradient(26%_22%_at_58%_18%,rgb(253_185_42/0.2),transparent_70%)] blur-2xl" />
      <div aria-hidden="true"
           class="absolute inset-0 -z-10 bg-[linear-gradient(180deg,transparent_35%,rgb(27_19_48/0.9)_100%)]" />
      <OndasMarca class="absolute inset-x-0 bottom-0 -z-10 h-64 w-full text-white/[0.08]" />

      <div class="flex h-full flex-col justify-between p-12 xl:p-16">
        <NuxtLink to="/" class="w-fit">
          <LogoMarca clara class="h-14" />
        </NuxtLink>
        <div>
          <p class="titulo text-[46px] font-semibold leading-[1.02] tracking-[-0.03em] text-white xl:text-[56px]">
            Cada entrada,<br>cada venda,<br>
            <span class="text-pool-300">no lugar certo.</span>
          </p>
          <p class="mt-6 max-w-md text-[15px] leading-7 text-white/70">
            Sistema de gestão do Conquista Park: ingressos, portaria, caixa e
            financeiro num só lugar.
          </p>
        </div>
        <p class="text-[13px] text-white/55">Acesso restrito à equipe.</p>
      </div>
    </aside>

    <!-- lado do formulário -->
    <main class="flex min-h-dvh flex-col px-5 py-6 sm:px-10">
      <NuxtLink to="/" class="w-fit lg:hidden">
        <LogoMarca class="h-10" />
      </NuxtLink>

      <div class="mx-auto flex w-full max-w-[400px] flex-1 flex-col justify-center py-10">
        <form class="grid animate-rise-in gap-5" @submit.prevent="entrar">
          <div>
            <h1 class="titulo text-[30px] font-semibold tracking-[-0.02em] text-ink-900">Entrar</h1>
            <p class="mt-1 text-[15px] text-ink-500">Use o e-mail e a senha do seu acesso de equipe.</p>
          </div>

          <p v-if="erro" class="faixa-erro" role="alert">{{ erro }}</p>

          <div>
            <label for="email" class="rotulo">E-mail</label>
            <input id="email" v-model="email" type="email" autocomplete="username" required
                   inputmode="email" autocapitalize="none" spellcheck="false"
                   class="campo" placeholder="voce@conquistapark.com.br">
          </div>

          <div>
            <label for="senha" class="rotulo">Senha</label>
            <input id="senha" v-model="senha" type="password" autocomplete="current-password" required
                   class="campo">
          </div>

          <button type="submit" class="btn-primario w-full py-3" :disabled="enviando">
            {{ enviando ? 'Entrando…' : 'Entrar' }}
          </button>
        </form>
      </div>

      <p class="text-center text-[13px] text-ink-500">Conquista Park · Ubatã, Bahia</p>
    </main>
  </div>
</template>
