// @vitest-environment happy-dom
/**
 * 10/10: "Pagar" não fazia nada com o armazenamento do navegador bloqueado.
 * O ajudante tem que segurar o carrinho na aba nos dois mundos — sessionStorage
 * funcionando (igual a antes) e sessionStorage lançando erro.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apagarDaAba, gravarNaAba, lerDaAba } from './armazenamentoDaAba'

/** Um sessionStorage de mentira: guarda num objeto e lança nos métodos pedidos. */
function storageQueFalha(falham: Array<'getItem' | 'setItem' | 'removeItem'>, inicial: Record<string, string> = {}) {
  const dados: Record<string, string> = { ...inicial }
  const erro = () => { throw new DOMException('bloqueado', 'SecurityError') }
  return {
    dados,
    getItem: (k: string) => (falham.includes('getItem') ? erro() : (k in dados ? dados[k] : null)),
    setItem: (k: string, v: string) => { if (falham.includes('setItem')) erro(); dados[k] = v },
    removeItem: (k: string) => { if (falham.includes('removeItem')) erro(); delete dados[k] },
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  apagarDaAba('dt:teste')
  sessionStorage.clear()
})

describe('armazenamento da aba', () => {
  it('com o sessionStorage funcionando, grava nele (o F5 continua achando o carrinho)', () => {
    gravarNaAba('dt:teste', '{"a":1}')
    expect(sessionStorage.getItem('dt:teste')).toBe('{"a":1}')
    expect(lerDaAba('dt:teste')).toBe('{"a":1}')
    apagarDaAba('dt:teste')
    expect(sessionStorage.getItem('dt:teste')).toBeNull()
    expect(lerDaAba('dt:teste')).toBeNull()
  })

  it('setItem lançando erro (cota cheia, cookies bloqueados) não derruba o clique e a aba ainda lê', () => {
    vi.stubGlobal('sessionStorage', storageQueFalha(['setItem']))
    expect(() => gravarNaAba('dt:teste', '{"b":2}')).not.toThrow()
    expect(lerDaAba('dt:teste')).toBe('{"b":2}')
  })

  it('getItem/removeItem lançando erro (armazenamento bloqueado) também não derrubam nada', () => {
    vi.stubGlobal('sessionStorage', storageQueFalha(['getItem', 'setItem', 'removeItem']))
    expect(() => gravarNaAba('dt:teste', 'x')).not.toThrow()
    expect(lerDaAba('dt:teste')).toBe('x')
    expect(() => apagarDaAba('dt:teste')).not.toThrow()
    expect(lerDaAba('dt:teste')).toBeNull()
  })

  it('gravação que falhou não deixa o valor VELHO voltar depois', () => {
    const falso = storageQueFalha(['setItem'], { 'dt:teste': 'velho' })
    vi.stubGlobal('sessionStorage', falso)
    gravarNaAba('dt:teste', 'novo')
    expect(lerDaAba('dt:teste')).toBe('novo')
    expect(falso.dados['dt:teste']).toBeUndefined()
  })

  it('voltou a gravar: o sessionStorage volta a mandar (a cópia em memória sai)', () => {
    vi.stubGlobal('sessionStorage', storageQueFalha(['setItem']))
    gravarNaAba('dt:teste', 'memoria')
    vi.unstubAllGlobals()
    gravarNaAba('dt:teste', 'gravado')
    sessionStorage.setItem('dt:teste', 'mudou-no-storage')
    expect(lerDaAba('dt:teste')).toBe('mudou-no-storage')
  })
})
