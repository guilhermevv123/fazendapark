<script setup lang="ts">
import { destinoDoLogin } from '~/composables/destinoDoLogin'
import CriarSenha from '~/components/CriarSenha.vue'
import EsqueciSenha from '~/components/EsqueciSenha.vue'
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
/**
 * 2º passo: entrou com a senha provisória da Equipe → cria a própria antes de abrir o painel.
 * `provisoria` guarda o que acabou de digitar (não pede de novo); vindo do porteiro do /admin
 * (`?trocar=1`, F5 ou outro aparelho) ela não está em memória e o componente pede junto.
 */
const criandoSenha = ref(route.query.trocar === '1')
const provisoria = ref('')
const nome = ref('')
/** "Esqueci a senha" (051): o link de senha nova por e-mail, sem depender de um master */
const esqueci = ref(false)
const destino = () => destinoDoLogin(route.query.de, useRequestURL().origin)
// `?trocar=1` sem sessão (link copiado, sessão vencida): não há senha a trocar — volta ao login
onMounted(async () => {
  if (!criandoSenha.value || provisoria.value) return
  const eu = await $fetch<any>('/api/auth/eu').catch(() => null)
  if (!eu?.usuario?.trocarSenha) {
    if (eu?.usuario) await navigateTo(destino())
    else criandoSenha.value = false
  } else nome.value = eu.usuario.nome ?? ''
})

// Digitou antes de a página terminar de carregar (celular com internet lenta): quando a
// hidratação do Vue chega, o v-model escreve o valor dele ('') por cima do que está no campo e o
// login vai vazio. `onBeforeMount` roda ANTES da hidratação, com o HTML do servidor ainda na
// tela — é a última chance de ler o que a pessoa já digitou. Achado pelo E2E em 27/09.
onBeforeMount(() => {
  const campo = (id: string) => (document.getElementById(id) as HTMLInputElement | null)?.value ?? ''
  if (!email.value) email.value = campo('email')
  if (!senha.value) senha.value = campo('senha')
})

async function entrar() {
  erro.value = ''
  enviando.value = true
  try {
    const r = await $fetch<{ trocarSenha?: boolean; usuario?: { nome?: string } }>('/api/auth/entrar', {
      method: 'POST',
      body: { email: email.value.trim(), senha: senha.value },
    })
    if (r?.trocarSenha) {
      provisoria.value = senha.value
      nome.value = r.usuario?.nome ?? ''
      senha.value = ''
      criandoSenha.value = true
      return
    }
    // Só destino desta casa (ver app/composables/destinoDoLogin.ts): o resto vai pro painel,
    // sem erro — a sessão já existe neste ponto e "não foi possível entrar" seria mentira (B27).
    await navigateTo(destino())
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
        <CriarSenha v-if="criandoSenha" :provisoria="provisoria || undefined" :nome="nome"
                    class="animate-rise-in" @pronto="navigateTo(destino())" />
        <EsqueciSenha v-else-if="esqueci" :email="email" :de="String(route.query.de ?? '/admin')"
                      class="animate-rise-in" @voltar="esqueci = false" />
        <form v-else class="grid animate-rise-in gap-5" @submit.prevent="entrar">
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

          <button type="button" class="mx-auto min-h-[44px] px-3 text-[14px] font-semibold text-pool-700 underline-offset-4 hover:underline"
                  data-parte="esqueci-a-senha" @click="esqueci = true; erro = ''">
            Esqueci a senha
          </button>
        </form>
      </div>

      <p class="text-center text-[13px] text-ink-500">Conquista Park · Entre Gandu e Itamaraty, Bahia</p>
    </main>
  </div>
</template>
