<script setup lang="ts">
/**
 * "Crie a sua senha" — o 2º passo do login de quem entrou com a senha provisória da Equipe.
 *
 * Dono, 06/10: "eu quero que a pessoa possa colocar essa primeira senha e depois já resetar
 * automaticamente". O master entrega a senha sorteada; a pessoa entra com ela e cai aqui antes de
 * ver qualquer tela. Quem decide é o mesmo `POST /api/auth/senha` do "Trocar senha" (mínimo de 8,
 * diferente da atual, confere a atual) — que também tira a marca de provisória.
 *
 * `provisoria` vem preenchida quando a pessoa ACABOU de digitá-la no login (não pede de novo).
 * Sem ela (voltou depois, F5, outro aparelho), a tela pede a provisória junto.
 */
const props = defineProps<{ provisoria?: string; nome?: string }>()
const emit = defineEmits<{ pronto: [] }>()

const atual = ref(props.provisoria ?? '')
const nova = ref('')
const confirma = ref('')
const erro = ref('')
const enviando = ref(false)
const pedeAtual = !props.provisoria

async function salvar() {
  if (enviando.value) return
  erro.value = ''
  if (nova.value.length < 8) { erro.value = 'A senha precisa ter pelo menos 8 caracteres.'; return }
  if (nova.value !== confirma.value) { erro.value = 'As duas senhas não são iguais.'; return }
  if (nova.value === atual.value) { erro.value = 'Escolha uma senha diferente da provisória.'; return }
  enviando.value = true
  try {
    await $fetch('/api/auth/senha', { method: 'POST', body: { atual: atual.value, nova: nova.value } })
    // as senhas não ficam em memória depois de usadas
    atual.value = ''; nova.value = ''; confirma.value = ''
    emit('pronto')
  } catch (e: any) {
    erro.value = e?.data?.statusMessage || 'Não foi possível salvar a senha. Tente de novo.'
  } finally {
    enviando.value = false
  }
}
</script>

<template>
  <form class="grid gap-5" data-parte="criar-senha" @submit.prevent="salvar">
    <div>
      <h1 class="titulo text-[30px] font-semibold tracking-[-0.02em] text-ink-900">Crie a sua senha</h1>
      <p class="mt-1 text-[15px] text-ink-500">
        <template v-if="nome">{{ nome.split(' ')[0] }}, a</template><template v-else>A</template>
        senha que você recebeu é provisória. Escolha a sua — é com ela que você entra daqui pra frente.
      </p>
    </div>

    <p v-if="erro" class="faixa-erro" role="alert">{{ erro }}</p>

    <div v-if="pedeAtual">
      <label for="senha-provisoria" class="rotulo">Senha provisória</label>
      <input id="senha-provisoria" v-model="atual" type="password" autocomplete="current-password"
             required class="campo">
    </div>
    <div>
      <label for="senha-nova" class="rotulo">Sua senha</label>
      <input id="senha-nova" v-model="nova" type="password" autocomplete="new-password" required
             minlength="8" class="campo">
      <p class="mt-1 text-xs text-ink-500">Pelo menos 8 caracteres.</p>
    </div>
    <div>
      <label for="senha-confirma" class="rotulo">Repita a senha</label>
      <input id="senha-confirma" v-model="confirma" type="password" autocomplete="new-password" required
             class="campo">
    </div>

    <button type="submit" class="btn-primario w-full py-3" :disabled="enviando">
      {{ enviando ? 'Salvando…' : 'Salvar e entrar' }}
    </button>
  </form>
</template>
