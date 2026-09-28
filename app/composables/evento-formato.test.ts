/**
 * Uma escrita de dinheiro só nas telas do evento (ADM-48).
 *
 * Cinco telas tinham o seu `reais`/`brl` local com `toLocaleString('pt-BR', { style: 'currency' })`
 * — que escreve "R$ 10,00" com o espaço FINO (U+00A0) no lugar do espaço normal do `reais()` de
 * `app/composables/formato.ts`. O mesmo valor saía com dois textos diferentes (busca, cópia, CSV,
 * teste que compara texto), que é a armadilha que o CLAUDE.md descreve. Varre o fonte.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { reais } from './formato'

const APP = join(import.meta.dirname, '..')
function vues(dir: string, saida: string[] = []): string[] {
  if (!existsSync(dir)) return saida
  for (const f of readdirSync(dir)) {
    const p = join(dir, f)
    if (statSync(p).isDirectory()) vues(p, saida)
    else if (p.endsWith('.vue')) saida.push(p)
  }
  return saida
}

/** o fonte sem comentários de JS e de HTML — o comentário pode (e deve) citar o jeito errado */
const semComentario = (s: string) =>
  s.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

const ARQUIVOS = [...vues(join(APP, 'pages/admin/evento/[id]')), ...vues(join(APP, 'components/evento')),
  ...['LeitorCamera', 'FichasImpressas', 'EnvioDeImagem'].map((c) => join(APP, `components/${c}.vue`))]

describe('dinheiro escrito por um lugar só (ADM-48)', () => {
  it('o reais() da casa usa espaço normal — é por isso que uma cópia local diverge', () => {
    expect(reais(1000)).toBe('R$ 10,00')
    expect((10).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })).not.toBe(reais(1000))
  })

  it('nenhuma tela do evento formata moeda por conta própria', () => {
    expect(ARQUIVOS.length).toBeGreaterThan(20)
    const achados = ARQUIVOS.filter((f) => /style:\s*'currency'/.test(semComentario(readFileSync(f, 'utf8'))))
      .map((f) => f.slice(APP.length + 1))
    expect(achados, 'moeda formatada fora do reais() da casa').toEqual([])
  })
})
