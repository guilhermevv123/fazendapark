<script setup lang="ts">
/**
 * /conta/confirmar-email?t=… — o clique no link de confirmação (035, item 4.2 da proposta).
 * Confirma na hora ao abrir (é o que a pessoa espera de "clique aqui para confirmar"); não precisa
 * estar logado. O link vale 3 dias e só enquanto a conta tiver o e-mail pra onde ele foi.
 */
import { useContaDoCliente } from '~/composables/contaDoCliente'

const route = useRoute()
const { carregar } = useContaDoCliente()
const situacao = ref<'confirmando' | 'ok' | 'vencido' | 'falhou'>('confirmando')
const email = ref('')
const recado = ref('')

onMounted(async () => {
  const t = typeof route.query.t === 'string' ? route.query.t : ''
  if (!t) { situacao.value = 'vencido'; return }
  try {
    const r = await $fetch<any>('/api/conta/email/confirmar', { method: 'POST', body: { token: t } })
    email.value = r.email
    situacao.value = 'ok'
    carregar(null).catch(() => {})
  } catch (e: any) {
    recado.value = e?.data?.statusMessage || ''
    situacao.value = e?.statusCode === 410 ? 'vencido' : 'falhou'
  }
})

useHead({ title: 'Confirmar e-mail', meta: [{ name: 'robots', content: 'noindex' }] })
</script>

<template>
  <div class="min-h-screen">
    <CabecalhoPublico largura="max-w-3xl" />
    <main class="mx-auto max-w-md px-4 pb-16 pt-8">
      <h1 class="titulo text-2xl font-semibold text-tinta">Confirmar e-mail</h1>
      <p v-if="situacao === 'confirmando'" class="mt-4 text-tinta-suave">Confirmando…</p>
      <div v-else-if="situacao === 'ok'" class="card mt-5" data-parte="email-confirmado" role="status">
        <p class="font-semibold text-tinta">E-mail confirmado.</p>
        <p class="mt-1 text-sm text-tinta-suave">Os seus ingressos chegam em <strong>{{ email }}</strong>.</p>
        <NuxtLink to="/" class="btn-cta mt-4 block w-full py-3 text-center text-base">Ver os eventos</NuxtLink>
      </div>
      <div v-else class="card mt-5" data-parte="confirmacao-falhou">
        <p class="font-semibold text-tinta">
          {{ situacao === 'vencido' ? 'Este link não vale mais.' : 'Não deu pra confirmar agora.' }}
        </p>
        <p class="mt-1 text-sm text-tinta-suave">
          {{ recado || 'Confira a internet e abra o link de novo.' }}
        </p>
        <NuxtLink to="/conta" class="btn-secundario mt-4 block w-full py-3 text-center">Ir para Minha conta</NuxtLink>
      </div>
    </main>
  </div>
</template>
