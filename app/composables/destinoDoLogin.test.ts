/**
 * B27 (auditoria 27/09): o login com `?de=` estranho dizia "Não foi possível entrar." DEPOIS de a
 * sessão já existir, e a checagem de destino deixava passar `/\outro.site`.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { DESTINO_PADRAO, destinoDoLogin } from './destinoDoLogin'

const ORIGEM = 'https://ingressos.conquistapark.com.br'

describe('pra onde o login manda', () => {
  it('destino interno passa inteiro, com busca e âncora', () => {
    expect(destinoDoLogin('/admin/clientes', ORIGEM)).toBe('/admin/clientes')
    expect(destinoDoLogin('/admin/evento/abc/vendas?pedido=PED-1#x', ORIGEM)).toBe('/admin/evento/abc/vendas?pedido=PED-1#x')
  })

  it('sem destino, ou destino que não é texto, vai pro painel', () => {
    for (const de of [undefined, null, '', '   ', 42, ['/admin/x']]) expect(destinoDoLogin(de, ORIGEM)).toBe(DESTINO_PADRAO)
  })

  it('nenhuma forma de mandar pra fora passa — cai no painel, sem erro', () => {
    for (const de of [
      'https://exemplo.invalido/roubo',
      '//exemplo.invalido/roubo',
      '/\\exemplo.invalido/roubo',
      '\\\\exemplo.invalido',
      'javascript:alert(1)',
      '/\texemplo.invalido',
      '/%0a/exemplo.invalido',
      'admin/clientes',
    ]) {
      const saida = destinoDoLogin(de, ORIGEM)
      expect(new URL(saida, ORIGEM).origin, de).toBe(ORIGEM)
      expect(saida.startsWith('/'), de).toBe(true)
    }
    expect(destinoDoLogin('/\\exemplo.invalido/roubo', ORIGEM)).toBe(DESTINO_PADRAO)
    expect(destinoDoLogin('//exemplo.invalido/roubo', ORIGEM)).toBe(DESTINO_PADRAO)
  })

  it('a tela de login usa esta régua (e não uma cópia dela)', () => {
    const tela = readFileSync(new URL('../pages/entrar.vue', import.meta.url), 'utf8')
    expect(tela).toContain('destinoDoLogin(')
    expect(tela).not.toMatch(/destino\.startsWith\('\/'\)/)
  })
})
