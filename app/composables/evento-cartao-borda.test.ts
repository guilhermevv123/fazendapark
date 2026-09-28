/**
 * Cor de borda em `.card` sem largura de borda não pinta nada (ADM-58).
 *
 * O `.card` da casa desenha o contorno com `ring-1` (app/assets/base.css), não com `border`: sem
 * `border`/`border-2`/…, a classe `border-alerta` existe, o `telas.test.ts` não reclama e o
 * destaque de alerta/erro simplesmente não aparece — o aviso do relógio torto do leitor, o card
 * "Valor retido" do financeiro, o conflito de passagem no histórico. A cor do destaque vai no
 * anel (`ring-alerta/50`), que é o contorno que o cartão já tem.
 *
 * Varre o fonte das telas do evento e dos componentes: cada tag com `card` na classe e cor de
 * borda (na classe fixa ou no `:class`) precisa ter também a largura da borda.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const APP = join(import.meta.dirname, '..')

function vues(dir: string, saida: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f)
    if (statSync(p).isDirectory()) vues(p, saida)
    else if (p.endsWith('.vue')) saida.push(p)
  }
  return saida
}

/** uma tag de abertura, com atributos entre aspas que podem ter `>` dentro (`a > b`, `=>`) */
const TAG = /<[a-zA-Z][^>"']*(?:"[^"]*"[^>"']*|'[^']*'[^>"']*)*>/g
const COR_DE_BORDA = /(?:^|[\s'"`])((?:hover:|focus:)?border-(?:alerta|erro|ok|acao|linha|tinta|pool|grape|sun|citrus|ink)[\w-]*(?:\/\d+)?)/
const LARGURA = /(?:^|[\s'"`])(?:hover:|focus:)?border(?:-[0-9]+|-[xytblr](?:-[0-9]+)?)?(?=[\s'"`]|$)/

/** `nome:linha classe` de cada cartão com cor de borda e sem borda, num fonte `.vue` */
function achadosNoFonte(src: string, nome: string): string[] {
  const achados: string[] = []
  const ini = src.indexOf('<template')
  if (ini < 0) return achados
  for (const m of src.slice(ini).matchAll(TAG)) {
    const tag = m[0]
    const fixa = /\sclass="([^"]*)"/.exec(tag)?.[1] ?? ''
    if (!/(^|\s)card(\s|$)/.test(fixa)) continue
    const tudo = `${fixa} ${/\s:class="([^"]*)"/.exec(tag)?.[1] ?? ''}`
    const cor = COR_DE_BORDA.exec(tudo)
    if (cor && !LARGURA.test(tudo)) {
      achados.push(`${nome}:${src.slice(0, ini + (m.index ?? 0)).split('\n').length} ${cor[1]}`)
    }
  }
  return achados
}

const cartoesSemBorda = (arquivos: string[]) =>
  arquivos.flatMap((f) => achadosNoFonte(readFileSync(f, 'utf8'), f.slice(APP.length + 1)))

const ARQUIVOS = [...vues(join(APP, 'pages/admin/evento')), ...vues(join(APP, 'components'))]

describe('cartão com cor de borda tem borda (ADM-58)', () => {
  it('a varredura lê as telas e ACHA o defeito quando ele existe (senão o verde abaixo não prova nada)', () => {
    expect(ARQUIVOS.length).toBeGreaterThan(20)
    const amostra = [
      '<template>',
      '  <div class="card mt-3 border-alerta bg-alerta-claro">sem largura</div>',
      '  <p class="card border-2 border-erro">com largura</p>',
      '  <div class="card" :class="retido > 0 && \'border-ok/50\'">no :class</div>',
      '  <div class="card ring-alerta/50">anel</div>',
      '  <button class="card text-left hover:border-acao" @click="x = a > b">hover</button>',
      '</template>',
    ].join('\n')
    expect(achadosNoFonte(amostra, 'amostra.vue')).toEqual([
      'amostra.vue:2 border-alerta', 'amostra.vue:4 border-ok/50', 'amostra.vue:6 hover:border-acao',
    ])
  })

  it('nenhum .card das telas do evento pinta cor numa borda que não existe', () => {
    expect(cartoesSemBorda(ARQUIVOS), 'destaque que não aparece: troque por ring-<cor>/50').toEqual([])
  })
})
