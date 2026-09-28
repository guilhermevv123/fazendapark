/**
 * consultaNaUrl.test.ts — filtro na URL sem perder troca rápida (auditoria 28/09).
 *
 * O roteador daqui é LENTO de propósito, como o de verdade: cada navegação do /admin espera o
 * middleware conferir a sessão no servidor. O defeito só existia nessa janela — com dublê que
 * navega na hora, a segunda troca sempre encontrava a primeira já na rota e tudo passava.
 *
 * Mutação conferida: `atual` lendo só `rota.query` (sem a pedida) deixa vermelho o caso das duas
 * trocas seguidas; o `finally` limpando sem comparar deixa vermelho o da navegação velha que
 * termina por último; as telas voltando a `navigateTo({ … query … })` deixam vermelho o último.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { computed, nextTick, reactive } from 'vue'
import type { LocationQuery } from 'vue-router'
import { criarConsultaNaUrl } from './consultaNaUrl'

/** Roteador que só termina a navegação quando o teste manda (a janela do middleware). */
function roteadorLento(rota: { path: string; query: LocationQuery }) {
  const pendentes: { para: any; terminar: () => void; cancelar: () => void; falhar: (e: Error) => void }[] = []
  return {
    pendentes,
    replace(para: { path: string; query: any }) {
      return new Promise<void>((resolve, reject) => {
        pendentes.push({
          para,
          terminar: () => { rota.path = para.path; rota.query = { ...para.query }; resolve() },
          // o vue-router cancela a navegação que uma mais nova atropelou: resolve sem mexer na rota
          cancelar: () => resolve(),
          falhar: (e) => reject(e),
        })
      })
    },
  }
}

const giro = () => new Promise((r) => setTimeout(r, 0))

describe('duas trocas antes de a primeira chegar na rota', () => {
  it('a segunda parte da primeira (não da rota velha) e a URL final tem as duas', async () => {
    const rota = reactive({ path: '/admin/agentes', query: {} as LocationQuery })
    const roteador = roteadorLento(rota)
    const c = criarConsultaNaUrl(rota, roteador)

    c.escrever({ canal: 'instagram' })
    // a tela já lê o pedido — o chip acende no clique, sem esperar o servidor
    expect(c.atual.value).toEqual({ canal: 'instagram' })
    expect(rota.query).toEqual({})

    // a segunda troca monta a consulta a partir de `atual` (é o que as telas fazem)
    c.escrever({ ...c.atual.value, q: 'ingresso' })
    expect(c.atual.value).toEqual({ canal: 'instagram', q: 'ingresso' })

    // a navegação velha termina; a pedida nova continua valendo
    roteador.pendentes[0]!.terminar()
    await giro()
    expect(c.atual.value).toEqual({ canal: 'instagram', q: 'ingresso' })

    roteador.pendentes[1]!.terminar()
    await giro()
    expect(rota.query).toEqual({ canal: 'instagram', q: 'ingresso' })
    expect(c.atual.value).toEqual({ canal: 'instagram', q: 'ingresso' })
  })

  it('a navegação velha, cancelada pela nova, não apaga a pedida da nova', async () => {
    const rota = reactive({ path: '/admin/clientes', query: {} as LocationQuery })
    const roteador = roteadorLento(rota)
    const c = criarConsultaNaUrl(rota, roteador)
    c.escrever({ faixa: '18a24' })
    c.escrever({ ...c.atual.value, ordem: 'nome' })
    roteador.pendentes[0]!.cancelar()
    await giro()
    // a rota ainda está vazia, mas a tela segue mostrando o que a pessoa pediu por último
    expect(rota.query).toEqual({})
    expect(c.atual.value).toEqual({ faixa: '18a24', ordem: 'nome' })
    roteador.pendentes[1]!.terminar()
    await giro()
    expect(rota.query).toEqual({ faixa: '18a24', ordem: 'nome' })
    expect(c.atual.value).toEqual({ faixa: '18a24', ordem: 'nome' })
  })
})

describe('um pedido por troca', () => {
  it('a rota chegando IGUAL à pedida não troca o objeto — a tela não busca de novo a mesma coisa', async () => {
    const rota = reactive({ path: '/admin/clientes', query: {} as LocationQuery })
    const roteador = roteadorLento(rota)
    const c = criarConsultaNaUrl(rota, roteador)
    let recalculos = 0
    const filtro = computed(() => { recalculos++; return { ...c.atual.value } })
    filtro.value
    c.escrever({ faixa: '18a24', ordem: 'nome' })
    const pedido = c.atual.value
    filtro.value
    expect(recalculos).toBe(2)
    roteador.pendentes[0]!.terminar() // a rota chega com as chaves em outra ordem, mesmo conteúdo
    rota.query = { ordem: 'nome', faixa: '18a24' }
    await giro()
    expect(c.atual.value).toBe(pedido)
    filtro.value
    expect(recalculos, 'o filtro da tela recalculou (e o useFetch buscaria de novo)').toBe(2)
    // conteúdo diferente, aí sim troca
    rota.query = { faixa: '18a24' }
    await nextTick()
    expect(c.atual.value).toEqual({ faixa: '18a24' })
  })
})

describe('o que vai pra URL', () => {
  it('vazio, nulo e falso ficam de fora; número e verdadeiro viram texto; o caminho é o da rota', async () => {
    const rota = reactive({ path: '/admin/financeiro', query: {} as LocationQuery })
    const roteador = roteadorLento(rota)
    const c = criarConsultaNaUrl(rota, roteador)
    c.escrever({ periodo: 'ano', de: '', ate: null, evento: undefined, pagina: 2, novidades: true, cadastro: false })
    expect(roteador.pendentes[0]!.para).toEqual({ path: '/admin/financeiro', query: { periodo: 'ano', pagina: '2', novidades: 'true' } })
    c.escrever({}, '/admin/outra')
    expect(roteador.pendentes[1]!.para).toEqual({ path: '/admin/outra', query: {} })
  })

  it('navegação recusada (sessão caiu, middleware mandou pro login): a tela volta a ler a rota', async () => {
    const rota = reactive({ path: '/admin/auditoria', query: { pessoa: 'u1' } as LocationQuery })
    const roteador = roteadorLento(rota)
    const c = criarConsultaNaUrl(rota, roteador)
    const pedido = c.escrever({ pessoa: 'u1', entidade: 'estorno' })
    expect(c.atual.value).toEqual({ pessoa: 'u1', entidade: 'estorno' })
    roteador.pendentes[0]!.falhar(new Error('recusada'))
    await expect(pedido).rejects.toThrow('recusada')
    expect(c.atual.value).toEqual({ pessoa: 'u1' })
  })

  it('`atual` é reativo: a URL mudando por fora (clique no menu) chega na tela', async () => {
    const rota = reactive({ path: '/admin/relatorios', query: { evento: 'e1' } as LocationQuery })
    const c = criarConsultaNaUrl(rota, roteadorLento(rota))
    expect(c.atual.value).toEqual({ evento: 'e1' })
    rota.query = {}
    await nextTick()
    expect(c.atual.value).toEqual({})
  })
})

describe('trocar: só as chaves dadas, a partir da última pedida', () => {
  it('mantém as outras chaves da consulta ATUAL (não da rota velha) e tira as que vêm vazias', async () => {
    const rota = reactive({ path: '/admin/evento/e1/vendas', query: { canal: 'online', pedido: 'p1' } as LocationQuery })
    const roteador = roteadorLento(rota)
    const c = criarConsultaNaUrl(rota, roteador)
    c.trocar({ busca: 'ana' })
    // a segunda troca sai antes de a primeira chegar na rota: tem que levar a busca junto
    c.trocar({ pedido: null })
    expect(roteador.pendentes[1]!.para).toEqual({ path: '/admin/evento/e1/vendas', query: { canal: 'online', busca: 'ana' } })
  })
})

describe('as telas usam esta régua', () => {
  // As telas do painel com filtro na URL. `navigateTo({ … query … })` em filtro é a armadilha 1
  // de volta; `route.query` montando a consulta nova é a armadilha 2.
  const TELAS = ['index', 'clientes', 'relatorios', 'financeiro', 'reconciliacao', 'auditoria', 'agentes']
  const pasta = new URL('../pages/admin/', import.meta.url)

  it('as telas do evento que liam a rota velha no meio da troca também usam a régua', () => {
    const doEvento = new URL('../pages/admin/evento/[id]/', import.meta.url)
    for (const tela of ['ingressos/cortesias', 'ingressos/sessoes', 'vendas/index', 'relatorios/extrato']) {
      const fonte = readFileSync(new URL(`${tela}.vue`, doEvento), 'utf8')
      expect(fonte, tela).toContain('useConsultaNaUrl()')
      expect(fonte, tela).not.toMatch(/navigateTo\(\{[^)]*query/)
      expect(fonte, tela).not.toMatch(/\.\.\.route\.query/)
    }
  })

  it('nenhuma tela de filtro volta ao navigateTo com consulta, e todas leem `consulta.atual`', () => {
    const existentes = readdirSync(pasta).filter((f) => f.endsWith('.vue')).map((f) => f.replace(/\.vue$/, ''))
    for (const tela of TELAS) {
      expect(existentes, tela).toContain(tela)
      const fonte = readFileSync(new URL(`${tela}.vue`, pasta), 'utf8')
      expect(fonte, tela).toContain('useConsultaNaUrl()')
      expect(fonte, tela).not.toMatch(/navigateTo\(\{[^)]*query/)
      expect(fonte, tela).not.toMatch(/\broute\.query\b/)
    }
  })
})
