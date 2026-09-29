<script setup lang="ts">
/**
 * `/conta/entrar` — o endereço de "entre na sua conta" do site (034), e a volta do Google/Apple
 * quando a entrada não deu certo (`?erro=<código>`).
 *
 * O erro chega como CÓDIGO e a frase mora aqui (ver `MotivoDaRecusaSocial`): texto livre vindo da
 * URL deixaria qualquer um montar um link do site com um recado falso escrito na página.
 */
import { useContaDoCliente } from '~/composables/contaDoCliente'

const route = useRoute()
const { estado, abrir, garantir } = useContaDoCliente()

const RECADOS: Record<string, string> = {
  desligado: 'Entrar com Google ou Apple ainda não está ligado neste site. Use o CPF e a senha.',
  cancelado: 'A entrada foi cancelada. Tente de novo, ou use o CPF e a senha.',
  expirou: 'O tempo para entrar acabou. Tente de novo.',
  falhou: 'Não deu para confirmar a entrada. Tente de novo, ou use o CPF e a senha.',
  sem_rede: 'Não conseguimos falar com o Google ou a Apple agora. Tente de novo em instantes.',
}
const recado = computed(() => {
  const codigo = String(route.query.erro ?? '')
  return codigo ? (RECADOS[codigo] ?? RECADOS.falhou) : ''
})
/** Só caminho DESTE site, e nunca uma rota da API (mesma régua de `destinoSeguroDoCliente`). */
const volta = computed(() => {
  const v = String(route.query.volta ?? '')
  return v.startsWith('/') && !v.startsWith('//') && !v.startsWith('/api/') ? v : '/conta'
})

onMounted(async () => {
  const s = await garantir(null)
  if (s.conta) return void navigateTo(volta.value, { replace: true })
  abrir('entrar', null)
})
// entrou pela janela: segue pra onde ia
watch(() => estado.value.conta, (c) => { if (c) navigateTo(volta.value, { replace: true }) })

useHead({ title: 'Entrar' })
</script>

<template>
  <div class="min-h-screen">
    <CabecalhoPublico largura="max-w-3xl" :conta="false" />
    <main class="mx-auto max-w-md px-4 pb-16 pt-10">
      <section class="card py-8 text-center">
        <h1 class="titulo text-2xl font-semibold text-tinta">Entre na sua conta</h1>
        <p class="mx-auto mt-2 max-w-sm text-tinta-suave">
          Com a conta, a compra fica guardada e os ingressos chegam no seu e-mail.
        </p>
        <p v-if="recado" class="faixa-erro mt-5 text-left" role="alert">{{ recado }}</p>
        <div class="mt-6 grid gap-2">
          <button type="button" class="btn-cta py-3" @click="abrir('entrar', null)">Entrar</button>
          <button type="button" class="btn-secundario py-3" @click="abrir('criar', null)">Criar conta</button>
        </div>
      </section>
    </main>
  </div>
</template>
