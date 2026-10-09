<script setup lang="ts">
/**
 * /redefinir-senha?t=…&de=… — a senha nova da EQUIPE pelo link do e-mail (051).
 *
 * Abre perguntando se o link ainda vale (sem gastar): vencido avisa ANTES de a pessoa digitar duas
 * senhas e oferece pedir outro. Salvou: a pessoa já entra e segue pra onde estava (painel ou portaria).
 */
definePageMeta({ layout: false })

const route = useRoute()
const token = typeof route.query.t === 'string' ? route.query.t : ''
const de = typeof route.query.de === 'string' ? route.query.de : '/admin'

const estado = ref<'conferindo' | 'valido' | 'vencido' | 'esqueci'>('conferindo')
const nome = ref('')
const nova = ref('')
const confirma = ref('')
const erro = ref('')
const enviando = ref(false)

onMounted(async () => {
  const r = await $fetch<{ valido: boolean; nome: string | null }>('/api/auth/redefinir', { query: { t: token } })
    .catch(() => ({ valido: false, nome: null }))
  nome.value = r.nome ?? ''
  estado.value = r.valido ? 'valido' : 'vencido'
})

async function salvar() {
  if (enviando.value) return
  erro.value = ''
  if (nova.value.length < 8) { erro.value = 'A senha precisa ter pelo menos 8 caracteres.'; return }
  if (nova.value !== confirma.value) { erro.value = 'As duas senhas não são iguais.'; return }
  enviando.value = true
  try {
    const r = await $fetch<{ destino: string }>('/api/auth/redefinir', {
      method: 'POST', body: { token, senha: nova.value, de },
    })
    nova.value = ''; confirma.value = ''
    // recarrega a sessão do zero: o painel e a portaria leem /api/auth/eu ao abrir
    window.location.assign(r.destino || '/admin')
  } catch (e: any) {
    if (e?.statusCode === 410 || e?.data?.statusCode === 410) estado.value = 'vencido'
    erro.value = e?.data?.statusMessage || 'Não foi possível salvar a senha. Tente de novo.'
  } finally {
    enviando.value = false
  }
}

useHead({ title: 'Criar senha nova' })
</script>

<template>
  <div class="grid min-h-dvh bg-white lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
    <aside class="relative isolate hidden overflow-hidden bg-grape-950 lg:block">
      <div aria-hidden="true"
           class="absolute -inset-[20%] -z-10 animate-drift bg-[radial-gradient(40%_34%_at_28%_32%,rgb(79_198_219/0.55),transparent_70%),radial-gradient(36%_30%_at_74%_66%,rgb(143_212_234/0.32),transparent_70%),radial-gradient(26%_22%_at_58%_18%,rgb(253_185_42/0.2),transparent_70%)] blur-2xl" />
      <OndasMarca class="absolute inset-x-0 bottom-0 -z-10 h-64 w-full text-white/[0.08]" />
      <div class="flex h-full flex-col justify-between p-12 xl:p-16">
        <NuxtLink to="/" class="w-fit"><LogoMarca clara class="h-14" /></NuxtLink>
        <p class="titulo text-[46px] font-semibold leading-[1.02] tracking-[-0.03em] text-white xl:text-[56px]">
          Uma senha nova,<br><span class="text-pool-300">em um minuto.</span>
        </p>
        <p class="text-[13px] text-white/55">Acesso restrito à equipe.</p>
      </div>
    </aside>

    <main class="flex min-h-dvh flex-col px-5 py-6 sm:px-10">
      <NuxtLink to="/" class="w-fit lg:hidden"><LogoMarca class="h-10" /></NuxtLink>

      <div class="mx-auto flex w-full max-w-[400px] flex-1 flex-col justify-center py-10">
        <p v-if="estado === 'conferindo'" class="text-center text-ink-500" data-parte="conferindo">Conferindo o link…</p>

        <EsqueciSenha v-else-if="estado === 'esqueci'" :de="de" class="animate-rise-in"
                      @voltar="navigateTo(de.startsWith('/portaria') ? '/portaria' : '/entrar')" />

        <div v-else-if="estado === 'vencido'" class="grid animate-rise-in gap-5" data-parte="link-vencido">
          <div>
            <h1 class="titulo text-[30px] font-semibold tracking-[-0.02em] text-ink-900">Link vencido</h1>
            <p class="mt-2 text-[15px] leading-6 text-ink-500">
              Este link não vale mais: ele dura 30 minutos, funciona uma vez só e é trocado quando
              você pede outro. Peça um link novo — leva um minuto.
            </p>
          </div>
          <button type="button" class="btn-primario w-full py-3" data-parte="pedir-outro" @click="estado = 'esqueci'">
            Pedir outro link
          </button>
        </div>

        <form v-else class="grid animate-rise-in gap-5" data-parte="nova-senha" @submit.prevent="salvar">
          <div>
            <h1 class="titulo text-[30px] font-semibold tracking-[-0.02em] text-ink-900">Criar senha nova</h1>
            <p class="mt-1 text-[15px] text-ink-500">
              <template v-if="nome">{{ nome }}, escolha</template><template v-else>Escolha</template>
              a sua senha nova. É com ela que você entra no painel e na portaria.
            </p>
          </div>
          <p v-if="erro" class="faixa-erro" role="alert">{{ erro }}</p>
          <div>
            <label for="senha-nova" class="rotulo">Senha nova</label>
            <input id="senha-nova" v-model="nova" type="password" autocomplete="new-password" required
                   minlength="8" class="campo">
            <p class="mt-1 text-xs text-ink-500">Pelo menos 8 caracteres.</p>
          </div>
          <div>
            <label for="senha-confirma" class="rotulo">Repita a senha</label>
            <input id="senha-confirma" v-model="confirma" type="password" autocomplete="new-password" required class="campo">
          </div>
          <button type="submit" class="btn-primario w-full py-3" :disabled="enviando" data-parte="salvar-senha">
            {{ enviando ? 'Salvando…' : 'Salvar e entrar' }}
          </button>
        </form>
      </div>

      <p class="text-center text-[13px] text-ink-500">Conquista Park · Ubatã, Bahia</p>
    </main>
  </div>
</template>
