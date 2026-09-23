<script setup lang="ts">
/**
 * Campo de dinheiro em centavos.
 *
 * Trabalha sobre os DÍGITOS, não sobre o texto formatado: cada tecla altera o
 * número inteiro de centavos e a máscara é reconstruída a partir dele. Um
 * computed get/set que reformata a string a cada tecla parece equivalente e
 * não é — ele embaralha a posição do cursor e come dígito quando o milhar
 * entra ou sai.
 *
 * O valor que sai daqui é SEMPRE inteiro em centavos. Nada de float.
 *
 * `conferirAbaixo` (centavos): valor maior que zero e abaixo disso ganha um
 * alerta amarelo embaixo do campo. O campo preenche pelos centavos, então quem
 * digita "30" pensando em trinta reais fica com R$ 0,30 — e sem o alerta isso
 * só aparece quando o primeiro ingresso sai por trinta centavos.
 */
const props = defineProps<{
  modelValue: number; id?: string; disabled?: boolean; conferirAbaixo?: number
}>()

const conferir = computed(() =>
  !!props.conferirAbaixo && props.modelValue > 0 && props.modelValue < props.conferirAbaixo)
const emit = defineEmits<{ 'update:modelValue': [number] }>()

const formatar = (centavos: number) =>
  (centavos / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const texto = ref(formatar(props.modelValue ?? 0))

// Só reescreve de fora quando o valor realmente difere do que está na tela —
// senão a digitação do usuário é sobrescrita pelo próprio eco.
watch(() => props.modelValue, (v) => {
  const atual = Number(texto.value.replace(/\D/g, '')) || 0
  if (v !== atual) texto.value = formatar(v ?? 0)
})

function aoDigitar(e: Event) {
  const el = e.target as HTMLInputElement
  const digitos = el.value.replace(/\D/g, '').slice(0, 11)
  const centavos = Number(digitos || '0')
  texto.value = formatar(centavos)
  el.value = texto.value
  emit('update:modelValue', centavos)
}
</script>

<template>
  <div>
    <div class="relative">
      <span class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-tinta-fraca">
        R$
      </span>
      <input :id="id" :value="texto" :disabled="disabled" inputmode="numeric"
             class="campo pl-9 text-right tabular-nums" @input="aoDigitar">
    </div>
    <p v-if="conferir" role="status"
       class="mt-1 rounded-card border border-alerta bg-alerta-claro px-2 py-1 text-xs font-medium text-alerta">
      Confira o valor: R$ {{ formatar(modelValue) }}
    </p>
  </div>
</template>
