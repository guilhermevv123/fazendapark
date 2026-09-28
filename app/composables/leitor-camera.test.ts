// @vitest-environment happy-dom
/**
 * Câmera da portaria: "Tentar de novo" não deixa a câmera anterior acesa (ADM-59, 27/09).
 *
 * Sem `BarcodeDetector` (iPhone, Chrome de computador) o leitor baixa o jsQR na hora. Com a rede
 * caindo nesse instante, a câmera JÁ estava aberta: a tela mostrava o erro, o "Tentar de novo"
 * pedia outra câmera e a primeira seguia ligada em segundo plano — LED aceso e bateria indo, no
 * aparelho que precisa durar o dia inteiro na portaria.
 *
 * E o "Tentar de novo" não tinha como dar certo: o navegador guarda a falha do `import()` e nem pede
 * o arquivo outra vez (medido no Chrome: 1 pedido em 3 tentativas, a última com a rede de volta).
 * Agora a câmera apaga na hora e o botão recarrega a página — a lista e a fila da portaria moram
 * no aparelho e voltam junto.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('jsqr', () => { throw new Error('sem rede: o pedaço do leitor não baixou') })

type Faixa = { stop: ReturnType<typeof vi.fn>; getCapabilities: () => any; parada: boolean }
const cameras: Faixa[] = []
const linhaDoTempo: string[] = []

function novaCamera() {
  const faixa: Faixa = {
    parada: false,
    stop: vi.fn(() => { faixa.parada = true; linhaDoTempo.push(`parou ${cameras.indexOf(faixa) + 1}`) }),
    getCapabilities: () => ({}),
  }
  cameras.push(faixa)
  linhaDoTempo.push(`abriu ${cameras.length}`)
  return { getTracks: () => [faixa], getVideoTracks: () => [faixa] }
}

beforeEach(() => {
  cameras.length = 0
  linhaDoTempo.length = 0
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn(async () => novaCamera()) },
  })
  ;(window as any).BarcodeDetector = undefined
  HTMLMediaElement.prototype.play = function () { return Promise.resolve() } as any
  // o happy-dom só aceita MediaStream de verdade no srcObject; a câmera aqui é de mentira
  Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', {
    configurable: true,
    get() { return (this as any)._fonte ?? null },
    set(v) { (this as any)._fonte = v },
  })
})
afterEach(() => { vi.useRealTimers() })

const esperar = async () => {
  const { flushPromises } = await import('@vue/test-utils')
  for (let i = 0; i < 5; i++) await flushPromises()
}

describe('câmera da portaria: o leitor falhou, a câmera apaga (ADM-59)', () => {
  it('jsQR sem rede: a câmera desliga na hora e o botão recarrega a página (o import() não tenta de novo)', async () => {
    const recarga = vi.spyOn(window.location, 'reload').mockImplementation(() => {})
    const { mount } = await import('@vue/test-utils')
    const Leitor = (await import('../components/LeitorCamera.vue')).default
    const w = mount(Leitor, { attachTo: document.body })
    await esperar()

    expect(cameras, 'a câmera nem abriu — o teste não prova nada').toHaveLength(1)
    expect(w.text()).toContain('Não deu pra carregar o leitor')
    expect(w.text(), 'o erro não aponta a saída que funciona sem rede').toContain('campo de código')
    expect(cameras[0].parada, 'leitor falhou e a câmera ficou acesa esperando').toBe(true)

    const botao = w.find('[data-parte="recarregar"]')
    expect(botao.exists(), '"Tentar de novo" aqui abre outra câmera e o import() falha de novo sem nem pedir o arquivo')
      .toBe(true)
    await botao.trigger('click')
    await esperar()
    expect(recarga).toHaveBeenCalledOnce()
    expect(cameras, 'abriu outra câmera em vez de recarregar').toHaveLength(1)
    w.unmount()
    recarga.mockRestore()
  })

  it('câmera recusada: "Tentar de novo" pede a câmera outra vez (a permissão muda sem recarregar)', async () => {
    ;(window as any).BarcodeDetector = class { detect() { return Promise.resolve([]) } }
    const pedir = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('negado'), { name: 'NotAllowedError' }))
      .mockImplementation(async () => novaCamera())
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: pedir } })
    const { mount } = await import('@vue/test-utils')
    const Leitor = (await import('../components/LeitorCamera.vue')).default
    const w = mount(Leitor, { attachTo: document.body })
    await esperar()
    expect(w.text()).toContain('A câmera está bloqueada')
    await w.findAll('button').find((b) => b.text() === 'Tentar de novo')!.trigger('click')
    await esperar()
    expect(pedir).toHaveBeenCalledTimes(2)
    expect(cameras).toHaveLength(1)
    expect(cameras[0].parada).toBe(false)
    w.unmount()
    expect(cameras[0].parada, 'saiu do modo câmera e ela seguiu ligada').toBe(true)
  })
})
