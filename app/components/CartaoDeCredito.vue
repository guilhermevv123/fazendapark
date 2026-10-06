<script setup lang="ts">
/**
 * Cartão de crédito na tela de pagamento (dono, 05/10): o cartão desenhado acompanha o que a pessoa
 * digita — bandeira reconhecida pelo começo do número, só os 4 primeiros e os 4 últimos dígitos à
 * vista, vira pro verso no código de segurança — e cada campo diz em português o que está errado.
 *
 * A conta (bandeira, dígito verificador, tamanho, validade) mora em `composables/cartao.ts`; o
 * servidor confere de novo antes de mandar ao Asaas. Este componente NÃO envia nada e NÃO guarda
 * nada (sem storage, sem log): devolve os dados pelo v-model e a conferência pelo evento.
 *
 * Só CRÉDITO: a doc do Asaas não aceita dados de cartão de DÉBITO pela API — débito continua na
 * página segura do Asaas.
 */
import { useId } from 'vue'
import {
  bandeiraDoCartao, conferirCartao, numeroAgrupado, numeroNaFrenteDoCartao, soDigitosDoCartao,
  tamanhoMaximoDoNumero, type ConferenciaDoCartao, type DadosDoCartao,
} from '~/composables/cartao'

const props = defineProps<{ modelValue: DadosDoCartao; desabilitado?: boolean }>()
const emit = defineEmits<{
  'update:modelValue': [DadosDoCartao]
  conferencia: [ConferenciaDoCartao]
}>()

type Campo = 'numero' | 'titular' | 'validade' | 'cvv'
const foco = ref<Campo | null>(null)
/** campo que a pessoa já deixou: só a partir daí o erro aparece (não grita enquanto digita) */
const tocados = reactive<Record<Campo, boolean>>({ numero: false, titular: false, validade: false, cvv: false })

const dados = computed(() => props.modelValue)
const mudar = (parte: Partial<DadosDoCartao>) => emit('update:modelValue', { ...dados.value, ...parte })

const bandeira = computed(() => bandeiraDoCartao(dados.value.numero))
const conferencia = computed(() => conferirCartao(dados.value))
watch(conferencia, (c) => emit('conferencia', c), { immediate: true })

const frente = computed(() => numeroNaFrenteDoCartao(dados.value.numero))
/** posições onde um grupo termina (o espaço do cartão: 4-4-4-4, Amex 4-6-5) */
const fimDeGrupo = computed(() => {
  const fins = new Set<number>()
  let soma = 0
  for (const g of bandeira.value?.grupos ?? [4, 4, 4, 4]) { soma += g; fins.add(soma - 1) }
  fins.delete(frente.value.length - 1)
  return fins
})
const virado = computed(() => foco.value === 'cvv')

/* --- número --- */
const numeroNoCampo = computed(() => numeroAgrupado(dados.value.numero))
function digitouNumero(e: Event) {
  const alvo = e.target as HTMLInputElement
  const d = soDigitosDoCartao(alvo.value)
  const numero = d.slice(0, tamanhoMaximoDoNumero(d))
  mudar({ numero })
  // o campo mostra agrupado: devolve o texto certo mesmo quando o v-model não mudou (dígito a mais)
  alvo.value = numeroAgrupado(numero)
}

/* --- validade "MM/AA" --- */
const validadeNoCampo = ref(
  dados.value.mes ? `${dados.value.mes}/${(dados.value.ano || '').slice(-2)}` : '')
function digitouValidade(e: Event) {
  const alvo = e.target as HTMLInputElement
  let d = alvo.value.replace(/\D/g, '').slice(0, 4)
  if (d.length === 1 && Number(d) > 1) d = `0${d}` // "5" vira "05"
  const texto = d.length > 2 ? `${d.slice(0, 2)}/${d.slice(2)}` : d
  validadeNoCampo.value = texto
  alvo.value = texto
  const mes = d.length >= 2 ? d.slice(0, 2) : ''
  const ano = d.length === 4 ? `20${d.slice(2)}` : ''
  mudar({ mes, ano })
}

function digitouTitular(e: Event) {
  mudar({ titular: (e.target as HTMLInputElement).value.toUpperCase().replace(/[^A-ZÀ-Ý' .-]/g, '').slice(0, 26) })
}
function digitouCvv(e: Event) {
  const alvo = e.target as HTMLInputElement
  const cvv = soDigitosDoCartao(alvo.value, bandeira.value?.cvv ?? 4)
  mudar({ cvv }); alvo.value = cvv
}

function saiu(c: Campo) { tocados[c] = true; if (foco.value === c) foco.value = null }
const erro = (c: Campo) => (tocados[c] ? conferencia.value[c] : null)

/** Marca todos como tocados — a página chama antes de pagar, pra mostrar o que falta. */
function mostrarErros() { (Object.keys(tocados) as Campo[]).forEach((c) => { tocados[c] = true }) }
defineExpose({ mostrarErros })

const ID = useId()
</script>

<template>
  <div class="cartao-cc grid gap-5" data-parte="cartao-de-credito">
    <!-- O desenho do cartão: repete o que está nos campos, então é decorativo pra leitor de tela. -->
    <div class="palco mx-auto w-full max-w-[380px]" aria-hidden="true">
      <!-- a chegada (dono, 06/10: "uma animação top, aparece o cartão"): o cartão entra girando e
           assenta; enquanto o banco responde, a luz corre por ele. A virada do CVV fica no .cartao
           de dentro, então as duas animações não brigam pelo mesmo transform. -->
      <div class="chegada" :class="{ processando: desabilitado }">
      <div class="cartao" :class="{ virado }">
        <div class="face frente">
          <div class="flex items-start justify-between">
            <span class="chip" />
            <span class="marca" :data-bandeira="bandeira?.id ?? 'nenhuma'" data-parte="bandeira-no-cartao">
              <template v-if="bandeira?.id === 'mastercard'">
                <span class="mc"><i /><i /></span>
              </template>
              <template v-else>{{ bandeira?.nome ?? 'Cartão' }}</template>
            </span>
          </div>

          <div class="numero" :class="{ aceso: foco === 'numero' }">
            <span v-for="(c, i) in frente" :key="i" class="slot"
                  :class="{ cheio: c !== '#', grupo: fimDeGrupo.has(i) }">
              <span class="rolo"><span>#</span><span>{{ c === '#' ? '' : c }}</span></span>
            </span>
          </div>

          <div class="flex items-end justify-between gap-3">
            <div class="min-w-0" :class="{ aceso: foco === 'titular' }">
              <p class="legenda">Nome no cartão</p>
              <p class="truncate text-[15px] font-semibold tracking-wide">{{ dados.titular || 'SEU NOME AQUI' }}</p>
            </div>
            <div class="shrink-0 text-right" :class="{ aceso: foco === 'validade' }">
              <p class="legenda">Validade</p>
              <p class="text-[15px] font-semibold tabular-nums">{{ dados.mes || 'MM' }}/{{ dados.ano ? dados.ano.slice(-2) : 'AA' }}</p>
            </div>
          </div>
          <span class="luz" />
        </div>

        <div class="face verso">
          <div class="tarja" />
          <div class="px-6">
            <p class="legenda mt-5 text-right">Código de segurança</p>
            <div class="assinatura" :class="{ aceso: foco === 'cvv' }">
              <span class="tabular-nums tracking-[0.3em]">{{ '•'.repeat(dados.cvv.length) || '•••' }}</span>
            </div>
          </div>
        </div>
      </div>
      </div>
    </div>
    <p v-if="desabilitado" class="-mt-1 flex items-center justify-center gap-2 text-sm font-semibold text-pool-700"
       role="status" data-parte="confirmando-com-o-banco">
      <span class="girando" aria-hidden="true" />Confirmando com o banco…
    </p>

    <fieldset class="grid gap-4" :disabled="desabilitado">
      <legend class="sr-only">Dados do cartão de crédito</legend>

      <div>
        <label :for="`${ID}-numero`" class="rotulo">Número do cartão</label>
        <div class="relative">
          <input :id="`${ID}-numero`" class="campo pr-28 tabular-nums tracking-wide" inputmode="numeric"
                 autocomplete="cc-number" placeholder="0000 0000 0000 0000" :value="numeroNoCampo"
                 :aria-invalid="!!erro('numero')" :aria-describedby="erro('numero') ? `${ID}-numero-erro` : undefined"
                 data-parte="campo-numero"
                 @input="digitouNumero" @focus="foco = 'numero'" @blur="saiu('numero')">
          <span v-if="bandeira" class="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 rounded-md bg-ink-100 px-2 py-0.5 text-xs font-semibold text-ink-700"
                data-parte="bandeira">{{ bandeira.curto ?? bandeira.nome }}</span>
        </div>
        <p v-if="erro('numero')" :id="`${ID}-numero-erro`" class="mt-1 text-sm text-danger-700">{{ erro('numero') }}</p>
      </div>

      <div>
        <label :for="`${ID}-titular`" class="rotulo">Nome impresso no cartão</label>
        <input :id="`${ID}-titular`" class="campo uppercase" autocomplete="cc-name" placeholder="COMO ESTÁ NO CARTÃO"
               :value="dados.titular" :aria-invalid="!!erro('titular')" data-parte="campo-titular"
               @input="digitouTitular" @focus="foco = 'titular'" @blur="saiu('titular')">
        <p v-if="erro('titular')" class="mt-1 text-sm text-danger-700">{{ erro('titular') }}</p>
      </div>

      <div class="grid grid-cols-2 gap-3">
        <div>
          <label :for="`${ID}-validade`" class="rotulo">Validade</label>
          <input :id="`${ID}-validade`" class="campo tabular-nums" inputmode="numeric" autocomplete="cc-exp"
                 placeholder="MM/AA" :value="validadeNoCampo" :aria-invalid="!!erro('validade')" data-parte="campo-validade"
                 @input="digitouValidade" @focus="foco = 'validade'" @blur="saiu('validade')">
          <p v-if="erro('validade')" class="mt-1 text-sm text-danger-700">{{ erro('validade') }}</p>
        </div>
        <div>
          <label :for="`${ID}-cvv`" class="rotulo">Código de segurança</label>
          <input :id="`${ID}-cvv`" class="campo tabular-nums" inputmode="numeric" autocomplete="cc-csc"
                 :placeholder="bandeira?.cvv === 4 ? '4 dígitos' : '3 dígitos'" :value="dados.cvv"
                 :aria-invalid="!!erro('cvv')" data-parte="campo-cvv"
                 @input="digitouCvv" @focus="foco = 'cvv'" @blur="saiu('cvv')">
          <p v-if="erro('cvv')" class="mt-1 text-sm text-danger-700">{{ erro('cvv') }}</p>
        </div>
      </div>

      <p class="flex items-center gap-2 text-xs text-tinta-fraca">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" />
        </svg>
        Pagamento processado pelo Asaas. O número do cartão não fica guardado no Conquista Park.
      </p>
    </fieldset>
  </div>
</template>

<style scoped>
.palco { perspective: 1200px; }
.chegada { transform-style: preserve-3d; animation: chegar 0.95s cubic-bezier(0.2, 0.8, 0.2, 1) both; }
@keyframes chegar {
  0% { opacity: 0; transform: translateY(46px) rotateX(38deg) rotateY(-28deg) rotateZ(-6deg) scale(0.82); }
  60% { opacity: 1; transform: translateY(-6px) rotateX(-4deg) rotateY(6deg) rotateZ(1deg) scale(1.02); }
  100% { opacity: 1; transform: none; }
}
/* o reflexo que passa uma vez quando o cartão assenta, e em laço enquanto o banco responde */
.luz {
  position: absolute; inset: -40% auto -40% -60%; width: 45%; z-index: 2; pointer-events: none;
  background: linear-gradient(100deg, transparent, rgb(255 255 255 / 0.38), transparent);
  transform: rotate(18deg) translateX(0);
  animation: reflexo 1.1s 0.75s ease-in-out both;
}
@keyframes reflexo { from { transform: rotate(18deg) translateX(0); } to { transform: rotate(18deg) translateX(520%); } }
.processando { animation: respirar 1.6s ease-in-out infinite; }
.processando .luz { animation: reflexo 1.3s ease-in-out infinite; }
@keyframes respirar { 0%, 100% { transform: none; } 50% { transform: translateY(-4px) scale(1.015); } }
.girando { width: 16px; height: 16px; border-radius: 9999px; border: 2px solid currentColor; border-right-color: transparent; animation: girar 0.8s linear infinite; }
@keyframes girar { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .girando { animation-duration: 2.4s; }
  .chegada, .processando, .luz, .processando .luz { animation: none; }
  .luz { display: none; }
}
.cartao {
  position: relative;
  aspect-ratio: 1.586;
  transform-style: preserve-3d;
  transition: transform 0.7s cubic-bezier(0.3, 0.7, 0.2, 1);
}
.cartao.virado { transform: rotateY(180deg); }
@media (prefers-reduced-motion: reduce) { .cartao { transition: none; } }

.face {
  position: absolute;
  inset: 0;
  border-radius: 16px;
  overflow: hidden;
  color: #fff;
  backface-visibility: hidden;
  -webkit-backface-visibility: hidden;
  background: linear-gradient(135deg, #146f83, #07303a);
  box-shadow: 0 24px 40px -18px rgb(7 48 58 / 0.6);
}
/* os dois anéis de luz da marca (azul piscina e sol), desfocados atrás do conteúdo */
.face::before, .face::after {
  content: '';
  position: absolute;
  border-radius: 9999px;
  filter: blur(14px);
  pointer-events: none;
}
.face::before { width: 70%; aspect-ratio: 1; left: -18%; top: -38%; border: 14px solid #fdb92a; opacity: 0.55; }
.face::after { width: 75%; aspect-ratio: 1; left: -45%; top: 55%; border: 14px solid #8fd4ea; opacity: 0.6; }
.frente { display: flex; flex-direction: column; justify-content: space-between; padding: 20px 22px; }
.frente > * { position: relative; z-index: 1; }
.verso { transform: rotateY(180deg); padding-top: 22px; }
.verso > * { position: relative; z-index: 1; }

.chip {
  width: 42px; height: 32px; border-radius: 6px;
  background: linear-gradient(135deg, #f6e27a, #c9a227);
  box-shadow: inset 0 0 0 1px rgb(0 0 0 / 0.15);
}
.marca { font-weight: 800; font-size: 18px; letter-spacing: 0.02em; text-shadow: 0 1px 2px rgb(0 0 0 / 0.3); }
.marca[data-bandeira='visa'] { font-style: italic; font-size: 24px; letter-spacing: 0.04em; }
.marca[data-bandeira='nenhuma'] { opacity: 0.6; font-weight: 600; font-size: 14px; }
.mc { display: inline-flex; }
.mc i { width: 30px; height: 30px; border-radius: 9999px; display: block; }
.mc i:first-child { background: #eb001b; }
.mc i:last-child { background: #f79e1b; margin-left: -12px; mix-blend-mode: screen; }

.legenda { font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; opacity: 0.75; }

.numero { display: flex; height: 30px; overflow: hidden; font-size: 21px; font-weight: 600; font-variant-numeric: tabular-nums; }
.slot { display: inline-block; width: 0.66em; text-align: center; }
.slot.grupo { margin-right: 0.45em; }
.rolo { display: flex; flex-direction: column; transition: transform 0.2s ease-out; }
.rolo > span { height: 30px; line-height: 30px; }
.slot.cheio .rolo { transform: translateY(-30px); }

.aceso { border-radius: 8px; box-shadow: 0 0 0 2px rgb(255 255 255 / 0.85), 0 0 12px rgb(255 255 255 / 0.5); transition: box-shadow 0.2s; }

.tarja { height: 42px; background: #111827; }
.assinatura {
  margin-top: 6px; height: 42px; border-radius: 8px; background: #fff; color: #111827;
  display: flex; align-items: center; justify-content: flex-end; padding: 0 14px; font-size: 18px;
}

@media (max-width: 380px) {
  .frente { padding: 14px 16px; }
  .numero { font-size: 17px; }
}
</style>
