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
})
