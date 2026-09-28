// @vitest-environment happy-dom
/**
 * campo-moeda.test.ts — o `<CampoMoeda>` depois de GER-02.
 *
 *   · a máscara é a do formatador único (conta inteira; nada de `centavos / 100` em float);
 *   · com `maximo`, a tecla que passaria do teto é segurada e o campo DIZ o limite — antes aceitava
 *     11 dígitos e o servidor respondia 400 com o número em centavos;
 *   · colar "1234.5" é R$ 1.234,50 (valor), não R$ 123,45 (fila de dígitos).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { limparTela, montarTela } from './.vitest-setup-dom'

vi.setConfig({ testTimeout: 30_000 })
afterEach(() => limparTela())

async function campo(props: Record<string, unknown> = {}) {
  const emitidos: number[] = []
  const tela = await montarTela(await import('../components/CampoMoeda.vue'), {
    rota: { path: '/' },
    props: { modelValue: 0, 'onUpdate:modelValue': (v: number) => emitidos.push(v), ...props },
  })
  return { tela, emitidos, input: tela.find('input') }
}

describe('CampoMoeda (GER-02)', () => {
  it('cada tecla empurra os centavos, e a máscara é a do formatador único', async () => {
    const { input, emitidos } = await campo()
    await input.setValue('815')
    expect((input.element as HTMLInputElement).value).toBe('8,15')
    await input.setValue('1.234,567')
    expect((input.element as HTMLInputElement).value).toBe('12.345,67')
    expect(emitidos.at(-1)).toBe(1_234_567)
  })

  it('com teto: a tecla que passaria dele é segurada, e o campo diz o limite', async () => {
    const { tela, input, emitidos } = await campo({ maximo: 100_000_00 })
    await input.setValue('10000000') // R$ 100.000,00 — no teto, passa
    expect((input.element as HTMLInputElement).value).toBe('100.000,00')
    expect(tela.find('[data-parte="teto"]').exists()).toBe(false)
    await input.setValue('100000001') // um dígito a mais: R$ 1.000.000,01
    expect((input.element as HTMLInputElement).value).toBe('100.000,00')
    expect(emitidos.at(-1)).toBe(100_000_00)
    expect(tela.find('[data-parte="teto"]').text()).toBe('O máximo aqui é R$ 100.000,00.')
  })

  it('colar "1234.5" é R$ 1.234,50; colar "R$ 1.234,50" também', async () => {
    const { input, emitidos } = await campo()
    const colar = async (texto: string) => {
      const ev = new Event('paste', { bubbles: true, cancelable: true }) as any
      ev.clipboardData = { getData: () => texto }
      input.element.dispatchEvent(ev)
      await Promise.resolve()
      return ev.defaultPrevented
    }
    expect(await colar('1234.5')).toBe(true)
    expect((input.element as HTMLInputElement).value).toBe('1.234,50')
    expect(emitidos.at(-1)).toBe(123_450)
    await colar('R$ 1.234,50')
    expect(emitidos.at(-1)).toBe(123_450)
  })

  /*
   * #65 (28/09): o clique no campo alinhado à direita põe o cursor no COMEÇO do "0,00". O dígito
   * entrava na frente e virava o mais significativo — "1" dava R$ 10,00; "123456", R$ 12.300,04.
   */
  it('com o cursor no começo, a tecla entra na ponta dos centavos: 1 → 0,01 e 123456 → 1.234,56', async () => {
    const { input, emitidos } = await campo({ maximo: 100_000_00 })
    const el = input.element as HTMLInputElement
    // o que o navegador faz com uma tecla: `beforeinput` com a seleção de antes, a caixa muda, `input`
    const teclar = async (digito: string, onde: 'começo' | 'meio' | 'fim') => {
      const v = el.value
      const pos = onde === 'começo' ? 0 : onde === 'meio' ? 1 : v.length
      el.setSelectionRange(pos, pos)
      el.dispatchEvent(new Event('beforeinput', { bubbles: true, cancelable: true }))
      el.value = v.slice(0, pos) + digito + v.slice(pos)
      el.dispatchEvent(new Event('input', { bubbles: true }))
      await Promise.resolve()
    }
    await teclar('1', 'começo')
    expect(el.value).toBe('0,01')
    expect(emitidos.at(-1)).toBe(1)
    for (const d of '23456') await teclar(d, 'começo')
    expect(el.value).toBe('1.234,56')
    expect(emitidos.at(-1)).toBe(123_456)
    await teclar('7', 'meio')
    expect(el.value).toBe('12.345,67')
  })

  it('apagar tira da ponta; tudo selecionado troca o valor; um pedaço selecionado vale o que ficou escrito', async () => {
    const { centavosDaTecla } = await import('./formato')
    const cursor = (i: number) => ({ ini: i, fim: i })
    expect(centavosDaTecla('1.234,56', '1.234,5', cursor(8))).toBe(12_345) // Backspace no fim
    expect(centavosDaTecla('1.234,56', '.234,56', cursor(1))).toBe(12_345) // Backspace depois do 1: tira da PONTA
    expect(centavosDaTecla('1.234,56', '1.23456', cursor(6))).toBe(12_345) // apagou só a vírgula
    expect(centavosDaTecla('1.234,56', '', { ini: 0, fim: 8 })).toBe(0) // tudo selecionado e apagado
    expect(centavosDaTecla('1.234,56', '5', { ini: 0, fim: 8 })).toBe(5) // tudo selecionado e digitado 5
    expect(centavosDaTecla('1.234,56', '1.294,56', { ini: 3, fim: 4 })).toBe(129_456) // um pedaço: vale o escrito
    expect(centavosDaTecla('0,00', '0,000', cursor(4))).toBe(0) // zero depois de zero continua zero
    expect(centavosDaTecla('0,01', '0,010', cursor(4))).toBe(10)
    expect(centavosDaTecla('0,00', '00,00', cursor(0))).toBe(0)
    // sem a seleção (valor posto por programa, preenchimento automático): vale o que está escrito
    expect(centavosDaTecla('0,00', '10000000')).toBe(10_000_000)
  })
})
