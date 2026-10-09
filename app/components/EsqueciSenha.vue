<script setup lang="ts">
/**
 * "Esqueci a senha" da EQUIPE (051) — no login do painel e da portaria.
 *
 * Dono, 09/10: "coloca o esqueci a senha em tudo, mesmo na portaria e no admin ... pra evitar dor de
 * cabeça". Pede o e-mail (vem preenchido com o que já estava no login), manda o link de 30 minutos
 * e diz SEMPRE a mesma coisa — exista o acesso ou não. O link volta pra onde a pessoa estava (`de`).
 */
const props = defineProps<{ email?: string; de?: string }>()
const emit = defineEmits<{ voltar: [] }>()

const email = ref(props.email ?? '')
const enviando = ref(false)
const erro = ref('')
const pronto = ref('')

async function pedir() {
  if (enviando.value) return
  erro.value = ''
  enviando.value = true
  try {
    const r = await $fetch<{ mensagem: string }>('/api/auth/esqueci', {
      method: 'POST', body: { email: email.value.trim(), de: props.de },
    })
    pronto.value = r.mensagem
  } catch (e: any) {
    erro.value = e?.data?.statusMessage || 'Não deu pra mandar o link agora. Tente de novo em instantes.'
  } finally {
    enviando.value = false
  }
}
</script>

<template>
  <div class="grid gap-5" data-parte="esqueci-senha">
    <div>
      <h1 class="titulo text-[30px] font-semibold tracking-[-0.02em] text-ink-900">Esqueci a senha</h1>
      <p class="mt-1 text-[15px] text-ink-500">
        Digite o e-mail do seu acesso. Mandamos um link para você criar uma senha nova.
      </p>
    </div>

    <template v-if="pronto">
      <div class="rounded-[8px] border border-pool-200 bg-pool-50 p-4 text-[15px] leading-6 text-ink-800"
           role="status" data-parte="esqueci-pronto">
        <p class="font-semibold text-ink-900">Confira o seu e-mail</p>
        <p class="mt-1">{{ pronto }}</p>
      </div>
      <button type="button" class="btn-secundario w-full py-3" data-parte="esqueci-voltar" @click="emit('voltar')">
        Voltar para entrar
      </button>
    </template>

    <form v-else class="grid gap-5" @submit.prevent="pedir">
      <p v-if="erro" class="faixa-erro" role="alert">{{ erro }}</p>
      <div>
        <label for="email-esqueci" class="rotulo">E-mail</label>
        <input id="email-esqueci" v-model="email" type="email" autocomplete="username" required
               inputmode="email" autocapitalize="none" spellcheck="false" class="campo"
               placeholder="nome@gmail.com">
        <p class="mt-1 text-xs text-ink-500">Confira o final: <strong>@gmail.com</strong>, <strong>@hotmail.com</strong>…</p>
      </div>
      <button type="submit" class="btn-primario w-full py-3" :disabled="enviando" data-parte="esqueci-enviar">
        {{ enviando ? 'Enviando…' : 'Mandar link para o meu e-mail' }}
      </button>
      <button type="button" class="btn-secundario w-full py-3" :disabled="enviando" @click="emit('voltar')">
        Voltar
      </button>
    </form>
  </div>
</template>
