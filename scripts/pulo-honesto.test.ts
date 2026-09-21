/**
 * pulo-honesto.test.ts — a trava que impede tique verde falso de voltar.
 *
 * ## O defeito que isto guarda
 *
 * A convenção antiga da casa era anunciar o pulo e sair do caso:
 *
 *     it('…', async () => {
 *       if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
 *       …
 *     })
 *
 * O vitest conta esse `return` como **APROVADO**. Medido na suíte inteira com
 * `BASE_TESTE` numa porta morta: `684 passed | 89 skipped` — 271 tiques verdes
 * que não fizeram uma única requisição. Numa corrida de mutação é o pior
 * resultado possível: a invariante acabou de ser arrancada e a suíte responde
 * verde.
 *
 * `scripts/test-setup.ts` conserta isso de fora, sem reescrever os quinze
 * arquivos que ainda usam a convenção velha (e que estão abertos por outras
 * trilhas): embrulha o `console.warn` e, quando o texto começa com `(pulado`,
 * levanta o `ctx.skip()` do caso da vez. Depois: `413 passed | 360 skipped`.
 *
 * ## Por que este arquivo existe
 *
 * Porque a trava mora num setup file, que não tem caso nenhum olhando pra ela.
 * Trava sem teste é trava que some no primeiro refactor — e some CALADA, que é
 * exatamente a doença que ela cura. Aqui ela é exercida pelos dois lados: o
 * aviso de pulo tem que pular, e o que NÃO é aviso de pulo não pode pular.
 *
 * O último caso fecha o único buraco que sobra: a trava só enxerga quem
 * ANUNCIA. Um `return` calado dentro do `it()` continuaria sendo tique verde,
 * então ele é proibido por varredura.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/** O mesmo símbolo que `scripts/test-setup.ts` usa pra publicar o caso da vez. */
const CASO_DA_VEZ = Symbol.for('diamond-tickets.caso-da-vez')

/** Dublê de contexto: registra o pulo em vez de abortar o caso de verdade. */
function comDubleDeCaso(texto: string): string[] {
  const verdadeiro = (globalThis as any)[CASO_DA_VEZ]
  const pulou: string[] = []
  ;(globalThis as any)[CASO_DA_VEZ] = { skip: (motivo?: string) => pulou.push(motivo ?? '') }
  try {
    console.warn(texto)
  } finally {
    // devolver o contexto de verdade não é higiene: sem isto, o PRÓPRIO caso
    // seguinte perderia a trava e voltaria a poder sair verde sem rodar.
    ;(globalThis as any)[CASO_DA_VEZ] = verdadeiro
  }
  return pulou
}

describe('o aviso de pulo vira pulo de verdade', () => {
  it('o caso da vez está publicado enquanto um caso roda', () => {
    expect((globalThis as any)[CASO_DA_VEZ],
      'o `beforeEach` do setup não publicou o caso — a trava não tem em quem chamar `skip`')
      .toBeTruthy()
  })

  it('`(pulado…)` chama ctx.skip, com o motivo junto', () => {
    // o texto vai aparecer no stderr da rodada: é o teste da trava, não um caso
    // pulado de verdade.
    expect(comDubleDeCaso('  (pulado: ISTO É O TESTE DA TRAVA)'),
      'o aviso de pulo não virou `ctx.skip()` — o caso sairia contado como APROVADO')
      .toEqual(['(pulado: ISTO É O TESTE DA TRAVA)'])

    // a forma curta, sem motivo, também é pulo
    expect(comDubleDeCaso('  (pulada — TESTE DA TRAVA)').length).toBe(1)
  })

  it('aviso que não é de pulo passa direto', () => {
    // `(só o login fabricado: …)` anuncia caso que vai RODAR meio caminho.
    // Abortá-lo trocaria uma mentira por outra.
    expect(comDubleDeCaso('  (só o login fabricado: sem portaria semeada)'),
      'aviso de caso que ainda vai rodar virou pulo — meio teste é melhor que nenhum')
      .toEqual([])
    expect(comDubleDeCaso('[Vue warn] Property "x" was accessed during render'),
      'aviso do Vue virou pulo — a suíte inteira pularia sozinha')
      .toEqual([])
    expect(comDubleDeCaso('pulado, mas no meio da frase'),
      'a trava casou no meio do texto — aviso que fala de pulo não é aviso de pulo')
      .toEqual([])
  })

  it('fora de um caso, o aviso não derruba nada', () => {
    const verdadeiro = (globalThis as any)[CASO_DA_VEZ]
    ;(globalThis as any)[CASO_DA_VEZ] = null
    try {
      // `beforeAll`/`afterAll` também avisam; levantar o `PendingError` ali
      // derruba o arquivo inteiro com um erro que não é o defeito.
      expect(() => console.warn('  (pulado: fora de caso, TESTE DA TRAVA)')).not.toThrow()
    } finally {
      ;(globalThis as any)[CASO_DA_VEZ] = verdadeiro
    }
  })
})

// ===========================================================================
// O buraco que sobra: quem pula CALADO
// ===========================================================================
const IGNORADAS = new Set(['node_modules', '.git', '.nuxt', '.output', 'dist'])

function arquivosDeTeste(dir: string): string[] {
  const achados: string[] = []
  for (const n of readdirSync(dir, { withFileTypes: true })) {
    if (IGNORADAS.has(n.name)) continue
    const p = join(dir, n.name)
    if (n.isDirectory()) achados.push(...arquivosDeTeste(p))
    else if (n.name.endsWith('.test.ts')) achados.push(p)
  }
  return achados
}

/**
 * Todo `return` guardado por `noAr` que esteja DENTRO de um `it()` e não
 * anuncie nada. A trava de runtime não enxerga esses — ela depende do aviso.
 *
 * Ganchos (`beforeAll`/`afterAll`) ficam de fora de propósito: ali o `return`
 * calado é o certo, porque não há caso pra pular e a montagem da fixtura
 * simplesmente não acontece.
 */
function pulosCalados(raiz: string): string[] {
  const achados: string[] = []
  for (const arq of arquivosDeTeste(raiz)) {
    const linhas = readFileSync(arq, 'utf8').split('\n')
    let onde = ''
    for (let i = 0; i < linhas.length; i++) {
      const linha = linhas[i]
      if (/^\s*(it|test)(\.\w+)?\(/.test(linha)) onde = 'caso'
      else if (/^\s*(beforeAll|afterAll|beforeEach|afterEach)\(/.test(linha)) onde = 'gancho'
      if (onde !== 'caso') continue
      const m = linha.match(/^\s*if \(!(?:noAr|sonda\.noAr)[^)]*\) (.*)$/)
      if (!m || !/\breturn\b/.test(m[1]) || /console\.warn/.test(m[1])) continue
      achados.push(`${arq.slice(raiz.length + 1)}:${i + 1}  →  ${linha.trim()}`)
    }
  }
  return achados
}

describe('ninguém pula calado', () => {
  it('nenhum `it()` sai por `return` sem anunciar', () => {
    const raiz = join(import.meta.dirname, '..')
    const arquivos = arquivosDeTeste(raiz)

    // a varredura vale o que ela enxerga: 33 arquivos de teste hoje. Piso, e
    // não igualdade, porque arquivo de teste nasce toda semana aqui.
    expect(arquivos.length, 'a varredura não achou arquivo de teste — o caminho mudou, '
      + 'e um caso verde aqui não quer dizer que ninguém pula calado')
      .toBeGreaterThanOrEqual(30)

    expect(pulosCalados(raiz),
      'caso que sai por `return` sem avisar: a trava do `console.warn` não enxerga, '
      + 'e ele sai contado como APROVADO. Use `seForaDoArPula(ctx, sonda)` de '
      + '`scripts/test-setup.ts` — ele pula com `ctx.skip()`, que sai contado como pulado')
      .toEqual([])
  })
})
