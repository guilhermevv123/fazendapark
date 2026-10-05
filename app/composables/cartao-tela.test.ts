// @vitest-environment happy-dom
/**
 * cartao-tela.test.ts — o formulário de cartão de crédito (dono, 05/10), na tela:
 *   · digitar o número agrupa, reconhece a bandeira (no campo e no desenho) e para no tamanho dela;
 *   · a frente do cartão mostra só os 4 primeiros e os 4 últimos;
 *   · "MM/AA" vira mês/ano; o nome sai em maiúsculas; o código de segurança vira o cartão;
 *   · erro só depois de sair do campo — e `mostrarErros()` mostra todos de uma vez;
 *   · o v-model devolve os dados e o evento `conferencia` diz se está tudo certo.
 * A conta pura (bandeira, Luhn, validade) está em `cartao.test.ts`.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { defineComponent, h, nextTick, ref } from 'vue'
import { limparTela, montarTela } from './.vitest-setup-dom'
import type { ConferenciaDoCartao, DadosDoCartao } from './cartao'

let tela: Awaited<ReturnType<typeof montarTela>> | null = null
afterEach(() => { tela?.unmount(); tela = null; limparTela() })

const estado = ref<DadosDoCartao>({ numero: '', titular: '', mes: '', ano: '', cvv: '' })
const ultima = ref<ConferenciaDoCartao | null>(null)
const filho = ref<any>(null)

async function abrir() {
  estado.value = { numero: '', titular: '', mes: '', ano: '', cvv: '' }
  const { default: CartaoDeCredito } = await import('../components/CartaoDeCredito.vue')
  const Casca = defineComponent({
    setup: () => () => h(CartaoDeCredito, {
      ref: filho,
      modelValue: estado.value,
      'onUpdate:modelValue': (v: DadosDoCartao) => { estado.value = v },
      onConferencia: (c: ConferenciaDoCartao) => { ultima.value = c },
    }),
  })
  tela = await montarTela(Casca)
  await nextTick()
}
const campo = (parte: string) => tela!.find(`[data-parte="${parte}"]`)
async function digitar(parte: string, texto: string) {
  const el = campo(parte)
  ;(el.element as HTMLInputElement).value = texto
  await el.trigger('input'); await nextTick()
}

describe('cartão de crédito · a tela', () => {
  it('número: agrupa, reconhece a bandeira e mostra só as pontas no desenho', async () => {
    await abrir()
    await digitar('campo-numero', '4111111111111111')
    expect(estado.value.numero).toBe('4111111111111111')
    expect((campo('campo-numero').element as HTMLInputElement).value).toBe('4111 1111 1111 1111')
    expect(campo('bandeira').text()).toBe('Visa')
    expect(campo('bandeira-no-cartao').attributes('data-bandeira')).toBe('visa')
    const desenho = tela!.findAll('.numero .rolo span:last-child').map((s) => s.text()).join('')
    expect(desenho).toBe('4111••••••••1111')
  })

  it('Elo que começa com 4 não vira Visa; Amex para em 15 dígitos e pede 4 no código', async () => {
    await abrir()
    await digitar('campo-numero', '4011784545454545')
    expect(campo('bandeira').text()).toBe('Elo')
    await digitar('campo-numero', '3782822463100059999')
    expect(estado.value.numero).toBe('378282246310005')
    expect((campo('campo-numero').element as HTMLInputElement).value).toBe('3782 822463 10005')
    expect(campo('campo-cvv').attributes('placeholder')).toBe('4 dígitos')
  })

  it('validade "MM/AA", nome em maiúsculas, e o código de segurança vira o cartão', async () => {
    await abrir()
    await digitar('campo-validade', '1229')
    expect(estado.value).toMatchObject({ mes: '12', ano: '2029' })
    expect((campo('campo-validade').element as HTMLInputElement).value).toBe('12/29')
    await digitar('campo-titular', 'maria da silva')
    expect(estado.value.titular).toBe('MARIA DA SILVA')
    await campo('campo-cvv').trigger('focus'); await nextTick()
    expect(tela!.find('.cartao').classes()).toContain('virado')
    await campo('campo-cvv').trigger('blur'); await nextTick()
    expect(tela!.find('.cartao').classes()).not.toContain('virado')
  })

  it('erro só depois de sair do campo; mostrarErros() mostra tudo o que falta', async () => {
    await abrir()
    await digitar('campo-numero', '4111111111111112')
    expect(tela!.text()).not.toContain('algum dígito está errado')
    await campo('campo-numero').trigger('blur'); await nextTick()
    expect(tela!.text()).toContain('algum dígito está errado')
    filho.value.mostrarErros(); await nextTick()
    expect(tela!.text()).toContain('nome e sobrenome')
    expect(tela!.text()).toContain('mês e o ano')
    expect(tela!.text()).toContain('código de segurança')
  })

  it('preenchido certo: a conferência sai ok', async () => {
    await abrir()
    await digitar('campo-numero', '5555555555554444')
    await digitar('campo-titular', 'Maria da Silva')
    await digitar('campo-validade', '1229')
    await digitar('campo-cvv', '123')
    expect(ultima.value?.ok).toBe(true)
    expect(ultima.value?.bandeira?.id).toBe('mastercard')
  })
})
