/**
 * componente-dinamico.test.ts — a trava do bug que chegou a ir pro ar.
 *
 * `<component :is="'NuxtLink'">`, com o NOME do componente em TEXTO, não
 * funciona no Nuxt: `<NuxtLink>` (e os outros embutidos — `NuxtPage`,
 * `NuxtLayout`, `ClientOnly`) o Nuxt troca por um IMPORT no compilador, não
 * registra o nome em lugar nenhum que `resolveComponent` alcance, e o Vue
 * desenha um elemento INVENTADO (`<nuxtlink to="…">`) sem `href` — o clique
 * não faz nada, só seleciona o texto.
 *
 * Foi exatamente o que aconteceu em `layouts/admin.vue`: o menu inteiro do
 * painel virou texto morto, e ninguém tinha como notar olhando o código —
 * só clicando. O conserto é sempre o mesmo: `resolveComponent('NOME')`
 * ATRIBUÍDO A UMA VARIÁVEL, e a variável (não a string) dentro do `:is`.
 *
 * Esta trava varre toda tela por essa forma, e ela NUNCA está certa — não é
 * um cheiro, é o bug pronto.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const RAIZ_DO_APP = join(import.meta.dirname, '..', 'app')

/** Os que o Nuxt injeta por compilador — a lista cresce se um dia usarmos mais. */
const COMPONENTES_DO_NUXT = ['NuxtLink', 'NuxtPage', 'NuxtLayout', 'ClientOnly']

function arquivosVue(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((ent) => {
    const caminho = join(dir, ent.name)
    return ent.isDirectory() ? arquivosVue(caminho) : (ent.name.endsWith('.vue') ? [caminho] : [])
  })
}

/**
 * Tira comentário de bloco, de linha e de HTML antes de varrer.
 *
 * Sem isto a trava acusa a PRÓPRIA explicação: o comentário que descreve o
 * bug cita `:is="… 'NuxtLink'"` pelo nome, do jeito que apareceu na tela
 * quebrada — e apagar essa frase pra calar o alarme era apagar a parte que
 * impede o bug de voltar. Mesmo problema, mesma solução de
 * `app/composables/formato.test.ts` (`codigoDe`).
 */
function semComentarios(fonte: string): string {
  return fonte
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .split('\n')
    .map((linha) => {
      const i = linha.search(/(^|[^:])\/\//)
      return i < 0 ? linha : linha.slice(0, linha.indexOf('//', i))
    })
    .join('\n')
}

const arquivos = arquivosVue(RAIZ_DO_APP).map((caminho) => ({ caminho, codigo: semComentarios(readFileSync(caminho, 'utf8')) }))

describe('nenhum :is="…" carrega o nome de um componente do Nuxt como texto', () => {
  it(`varreu pelo menos uma tela (achou ${arquivos.length} arquivo(s) .vue)`, () => {
    // sem isto, um `RAIZ_DO_APP` errado deixaria os casos abaixo verdes à toa
    expect(arquivos.length).toBeGreaterThan(10)
  })

  for (const nome of COMPONENTES_DO_NUXT) {
    it(`nenhuma tela usa '${nome}' como string dentro de :is`, () => {
      // aspas simples OU duplas ao redor do nome, em qualquer lugar de um
      // `:is="…"` (a expressão pode ser um `?:`, como foi o caso real)
      const re = new RegExp(`:is="[^"]*['"]${nome}['"]`)
      const culpados = arquivos
        .filter((a) => re.test(a.codigo))
        .map((a) => a.caminho.slice(RAIZ_DO_APP.length + 1))
      expect(culpados).toEqual([])
    })
  }
})
