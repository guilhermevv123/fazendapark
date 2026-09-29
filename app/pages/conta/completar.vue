<script setup lang="ts">
/**
 * `/conta/completar` — quem entrou pelo Google/Apple e ainda não tinha conta (034).
 *
 * O provedor já provou quem é (e, quase sempre, o e-mail); falta o que ele não tem: o CPF e o
 * celular — e o nome, quando a Apple não mandou. O pacote com o que ele disse vem assinado num
 * cookie de 15 minutos (`conta-social.ts`); passou disso, a pessoa entra de novo.
 */
import { mascaraCpf, mascaraTel, useContaDoCliente } from '~/composables/contaDoCliente'

const { estado } = useContaDoCliente()

const pendente = ref<{ provedor: 'google' | 'apple'; nome: string | null; email: string | null; emailVerificado: boolean } | null>(null)
const vencido = ref(false)
const form = reactive({ nome: '', email: '', cpf: '', telefone: '', aceitaNovidades: false })
const enviando = ref(false)
const erro = ref('')
const campoComErro = ref('')
const marca = (campo: string) => (campoComErro.value === campo ? 'ring-2 ring-danger-600' : '')
const invalido = (campo: string) => (campoComErro.value === campo ? 'true' : undefined)
const nomeDoProvedor = computed(() => (pendente.value?.provedor === 'apple' ? 'a Apple' : 'o Google'))

onMounted(async () => {
  try {
    const r = await $fetch<any>('/api/conta/completar')
    pendente.value = r
    form.nome = r.nome ?? ''
    form.email = r.email ?? ''
  } catch {
    vencido.value = true
  }
})

async function concluir() {
  erro.value = ''
  campoComErro.value = ''
  enviando.value = true
  try {
    const r = await $fetch<any>('/api/conta/completar', {
      method: 'POST',
      body: {
        nome: form.nome, cpf: form.cpf, telefone: form.telefone, aceitaNovidades: form.aceitaNovidades,
        // o e-mail que o provedor PROVOU não é trocável; o servidor ignora o daqui nesse caso
        email: pendente.value?.emailVerificado ? undefined : form.email,
      },
    })
    estado.value = { ...estado.value, carregada: true, conta: r.conta }
    await navigateTo(r.destino || '/conta', { replace: true })
  } catch (e: any) {
    if (e?.statusCode === 401) { vencido.value = true; return }
    erro.value = e?.data?.statusMessage || 'Não deu pra concluir agora. Confira a internet e tente de novo.'
    campoComErro.value = e?.data?.data?.campo || ''
  } finally { enviando.value = false }
}

useHead({ title: 'Concluir cadastro' })
</script>

<template>
  <div class="min-h-screen">
    <CabecalhoPublico largura="max-w-3xl" :conta="false" />
    <main class="mx-auto max-w-md px-4 pb-16 pt-8">
      <section v-if="vencido" class="card py-8 text-center">
        <h1 class="titulo text-xl font-semibold text-tinta">O tempo para concluir acabou</h1>
        <p class="mt-2 text-tinta-suave">Entre de novo — leva um clique.</p>
        <NuxtLink to="/conta/entrar" class="btn-cta mt-6 inline-flex px-6 py-3">Entrar</NuxtLink>
      </section>

      <div v-else-if="!pendente" class="card h-64 animate-pulse bg-ink-50" aria-busy="true" aria-label="Carregando" />

      <section v-else class="card">
        <h1 class="titulo text-xl font-semibold text-tinta">Falta pouco</h1>
        <p class="mt-1 text-sm text-tinta-suave">
          Você entrou com {{ nomeDoProvedor }}. Pra comprar ingressos, o parque precisa do seu CPF e do
          seu celular — é só desta vez.
        </p>
        <form class="mt-5 space-y-4" novalidate @submit.prevent="concluir">
          <div>
            <label for="completar-nome" class="rotulo">Nome completo</label>
            <input id="completar-nome" v-model="form.nome" autocomplete="name" maxlength="120" class="campo"
                   :class="marca('nome')" :aria-invalid="invalido('nome')">
            <p class="mt-1 text-xs text-tinta-fraca">Vai impresso no ingresso.</p>
          </div>
          <div>
            <label for="completar-email" class="rotulo">E-mail</label>
            <input v-if="!pendente.emailVerificado" id="completar-email" v-model="form.email" type="email"
                   autocomplete="email" maxlength="160" class="campo" :class="marca('email')"
                   :aria-invalid="invalido('email')">
            <p v-else id="completar-email" class="campo cursor-not-allowed bg-ink-50 text-tinta-suave">{{ pendente.email }}</p>
          </div>
          <div class="grid gap-4 sm:grid-cols-2">
            <div>
              <label for="completar-cpf" class="rotulo">CPF</label>
              <input id="completar-cpf" :value="form.cpf" inputmode="numeric" autocomplete="off"
                     class="campo tabular-nums" :class="marca('cpf')" :aria-invalid="invalido('cpf')"
                     placeholder="000.000.000-00"
                     @input="form.cpf = mascaraCpf(($event.target as HTMLInputElement).value)">
            </div>
            <div>
              <label for="completar-telefone" class="rotulo">Celular (WhatsApp)</label>
              <input id="completar-telefone" :value="form.telefone" inputmode="numeric" autocomplete="tel"
                     class="campo tabular-nums" :class="marca('telefone')" :aria-invalid="invalido('telefone')"
                     placeholder="(73) 99999-0000"
                     @input="form.telefone = mascaraTel(($event.target as HTMLInputElement).value)">
            </div>
          </div>
          <label class="flex items-start gap-2.5 text-sm text-tinta-corpo">
            <input v-model="form.aceitaNovidades" type="checkbox" class="mt-1 h-4 w-4 accent-pool-600">
            <span>Quero receber novidades e ofertas do parque por WhatsApp, e-mail e Instagram.</span>
          </label>
          <p v-if="erro" class="faixa-erro" role="alert">{{ erro }}</p>
          <button type="submit" class="btn-cta w-full py-3 text-base" :disabled="enviando">
            {{ enviando ? 'Concluindo…' : 'Concluir e continuar' }}
          </button>
        </form>
      </section>
    </main>
  </div>
</template>
