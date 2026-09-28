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
 *
 * GER-02 (27/09): a máscara formatava DIVIDINDO em float (`centavos / 100`), aceitava 11 dígitos
 * (R$ 999 milhões, contra o teto de R$ 100.000,00 do servidor — que respondia 400 com o número em
 * centavos) e colar "1234.5" virava R$ 123,45. Agora: a conta é a do formatador único
 * (`centavosParaTexto`, inteira), o campo aceita um TETO (`maximo`) e diz qual é quando a tecla
 * passaria dele, e colar lê o texto como VALOR (`paraCentavos`: "1234.5" é R$ 1.234,50;
 * "R$ 1.234,50" também), não como uma fila de dígitos.
 *
 * O teto padrão continua o de antes (11 dígitos): este campo também é o do saque e o do fundo de
 * caixa, que não têm o teto do preço de ingresso. Quem é PREÇO passa `:maximo="TETO_DO_INGRESSO"`
 * (R$ 100.000,00, o mesmo `faceCents` ≤ 100_000_00 do servidor).
 */
import { centavosDigitados, centavosParaTexto, paraCentavos } from '~/composables/formato'

const props = defineProps<{
  modelValue: number; id?: string; disabled?: boolean; conferirAbaixo?: number
  /** teto em centavos (preço de ingresso: 100_000_00, o do servidor); padrão: 11 dígitos */
  maximo?: number
}>()
const TETO_PADRAO = 99_999_999_999
const teto = computed(() => props.maximo ?? TETO_PADRAO)
const passouDoTeto = ref(false)

const conferir = computed(() =>
  !!props.conferirAbaixo && props.modelValue > 0 && props.modelValue < props.conferirAbaixo)
const emit = defineEmits<{ 'update:modelValue': [number] }>()

const formatar = (centavos: number) => centavosParaTexto(centavos || 0)

const texto = ref(formatar(props.modelValue ?? 0))

// Só reescreve de fora quando o valor realmente difere do que está na tela —
// senão a digitação do usuário é sobrescrita pelo próprio eco.
watch(() => props.modelValue, (v) => {
  const atual = Number(texto.value.replace(/\D/g, '')) || 0
  if (v !== atual) texto.value = formatar(v ?? 0)
})

function aplicar(el: HTMLInputElement, centavos: number) {
  if (centavos > teto.value) {
    // a tecla (ou o colado) passaria do teto: o campo fica com o que tinha e DIZ o limite
    passouDoTeto.value = true
    el.value = texto.value
    return
  }
  passouDoTeto.value = false
  texto.value = formatar(centavos)
  el.value = texto.value
  emit('update:modelValue', centavos)
}

function aoDigitar(e: Event) {
  const el = e.target as HTMLInputElement
  aplicar(el, centavosDigitados(el.value))
}

/** colar é VALOR, não tecla: "1234.5" é R$ 1.234,50 (e substitui o que estava no campo) */
function aoColar(e: ClipboardEvent) {
  const colado = e.clipboardData?.getData('text') ?? ''
  if (!/\d/.test(colado)) return
  e.preventDefault()
  aplicar(e.target as HTMLInputElement, Math.max(0, paraCentavos(colado)))
}
</script>

<template>
  <div>
    <div class="relative">
      <span class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-tinta-fraca">
        R$
      </span>
      <input :id="id" :value="texto" :disabled="disabled" inputmode="numeric"
             class="campo pl-9 text-right tabular-nums" @input="aoDigitar" @paste="aoColar">
    </div>
    <p v-if="conferir" role="status"
       class="mt-1 rounded-card border border-alerta bg-alerta-claro px-2 py-1 text-xs font-medium text-alerta">
      Confira o valor: R$ {{ formatar(modelValue) }}
    </p>
    <p v-if="passouDoTeto" role="status" data-parte="teto"
       class="mt-1 rounded-card border border-alerta bg-alerta-claro px-2 py-1 text-xs font-medium text-alerta">
      O máximo aqui é R$ {{ formatar(teto) }}.
    </p>
  </div>
</template>
