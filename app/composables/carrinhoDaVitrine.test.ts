/**
 * carrinhoDaVitrine.test.ts — as travas da tela de compra.
 *
 * O que este arquivo testa não é aritmética de carrinho: é que o que a vitrine
 * MONTA é o que o checkout ACEITA. Por isso ele não se contenta com
 * asserção em memória — ele lê a vitrine de verdade (`GET /api/e/:slug`),
 * monta o carrinho com as mesmas funções que a página usa e COMPRA pela HTTP.
 *
 * Cada teste vem em par: o carrinho montado pelas regras passa, e o mesmo
 * carrinho com a regra arrancada é recusado pelo servidor com o recado que o
 * comprador leria. É assim que a mutação fica visível — um teste que só
 * confere `Math.min` continua verde no dia em que a tela parar de mandar a
 * declaração de meia-entrada, e o comprador é quem descobre.
 *
 * Fixture própria, ids próprios, `DELETE` no `afterAll`. O evento semeado não
 * é tocado. Sem servidor de dev no ar, a parte HTTP PULA em vez de falhar.
 */
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { db, q, q1 } from '../../server/utils/db'
import {
  ajustarQuantidade, carimboDePago, chaveDaLinha, destinoSemCarrinho,
  faltaNaDeclaracao, impedimentoDaLinha, itensDoCheckout, minimoDaLinha,
  pedeDeclaracaoDeMeia, pendenciasDoCarrinho, tetoDaLinha, totaisDoCarrinho,
  type LinhaDoPedido,
} from './carrinhoDaVitrine'

const BASE = process.env.BASE_TESTE ?? 'http://localhost:3100'
const SLUG = 'zz-carrinho-da-vitrine'

let orgId: string, eventId: string, sectorId: string, lotId: string
let tipoInteira: string, tipoMeia: string, tipoNominal: string, tipoGratuito: string
let noAr = false

/** CPF sintético que passa no dígito verificador. */
function cpf(): string {
  const d = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10))
  const dig = (arr: number[], peso: number) => {
    const r = (arr.reduce((a, n, i) => a + n * (peso - i), 0) * 10) % 11
    return r === 10 ? 0 : r
  }
  d.push(dig(d, 10)); d.push(dig(d, 11))
  return d.join('')
}

/** A vitrine como a página a recebe — mesma rota, mesmo JSON. */
async function vitrine(): Promise<any> {
  const r = await fetch(`${BASE}/api/e/${SLUG}`, { signal: AbortSignal.timeout(5000) })
  if (!r.ok) throw new Error(`vitrine respondeu ${r.status}`)
  return await r.json()
}

/** O lote e a variação, direto do JSON público. */
async function daVitrine(nomeDaVariacao: string) {
  const v = await vitrine()
  const lote = v.setores[0].lotes[0]
  const variacao = lote.variacoes.find((x: any) => x.nome === nomeDaVariacao)
  if (!variacao) throw new Error(`variação "${nomeDaVariacao}" não veio na vitrine`)
  return { lote, variacao }
}

async function comprar(itens: unknown[]) {
  const r = await fetch(`${BASE}/api/checkout`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      eventSlug: SLUG,
      itens,
      comprador: {
        nome: 'Comprador Da Vitrine',
        email: `v.${Date.now()}.${Math.random()}@exemplo.com`,
        documento: cpf(),
        telefone: '73998260963',
      },
      forma: 'pix',
    }),
  })
  const corpo = await r.json().catch(() => ({}))
  return { status: r.status, recado: corpo.statusMessage ?? corpo.message ?? '', corpo }
}

/** Uma linha do carrinho, montada como a vitrine monta. */
function linha(lote: any, variacao: any, quantidade: number, declaracao: any = null): LinhaDoPedido {
  return {
    loteId: lote.id,
    tipoId: variacao.tipoId ?? null,
    quantidade,
    nome: variacao.nome ?? lote.nome,
    setor: 'ZZ Pista',
    unitFaceCents: variacao.faceCents,
    unitTaxaCents: variacao.taxaCents,
    unitTotalCents: variacao.totalCents,
    pedeMeia: pedeDeclaracaoDeMeia(variacao),
    declaracao,
  }
}

beforeAll(async () => {
  orgId = (await q1<any>(
    `INSERT INTO organizations (name, slug)
     VALUES ('ZZ Carrinho', 'zz-carrinho-' || gen_random_uuid()) RETURNING id`))!.id
  eventId = (await q1<any>(
    `INSERT INTO events (org_id, name, slug, status, starts_at, ends_at, fee_bps, fee_mode_online)
     VALUES ($1, 'ZZ Carrinho da Vitrine', $2, 'ativo',
             now() + interval '10 days', now() + interval '11 days', 1000, 'repassar')
     RETURNING id`, [orgId, SLUG]))!.id
  sectorId = (await q1<any>(
    `INSERT INTO sectors (event_id, name) VALUES ($1, 'ZZ Pista') RETURNING id`, [eventId]))!.id
  lotId = (await q1<any>(
    `INSERT INTO lots (sector_id, name, price_cents, quantity, min_per_order, max_per_order, channels)
     VALUES ($1, 'ZZ Lote', 10000, 100, 1, 10, '{online}') RETURNING id`, [sectorId]))!.id

  // As três espécies que a coluna gerada `ticket_types.kind` produz — e é a
  // terceira que existe só pra provar o buraco conhecido da vitrine pública
  // (preço cheio COM documento é inteira pro banco, meia pra tela).
  tipoInteira = (await q1<any>(
    `INSERT INTO ticket_types (lot_id, name, quantity, discount_bps, requires_document, sort_order)
     VALUES ($1, 'Inteira', 100, 0, false, 1) RETURNING id`, [lotId]))!.id
  tipoMeia = (await q1<any>(
    `INSERT INTO ticket_types (lot_id, name, quantity, discount_bps, requires_document, sort_order)
     VALUES ($1, 'Meia-entrada', 100, 5000, true, 2) RETURNING id`, [lotId]))!.id
  tipoNominal = (await q1<any>(
    `INSERT INTO ticket_types (lot_id, name, quantity, discount_bps, requires_document, sort_order)
     VALUES ($1, 'Nominal', 100, 0, true, 3) RETURNING id`, [lotId]))!.id
  // Desconto de 100% = espécie `gratuito` (a coluna gerada da db/015). É o
  // "Criança até 3 anos" do parque, e é o único caminho em que o CHECKOUT já
  // responde `pago` — sem cobrança, sem gateway, sem vigia.
  tipoGratuito = (await q1<any>(
    `INSERT INTO ticket_types (lot_id, name, quantity, discount_bps, requires_document, sort_order)
     VALUES ($1, 'Crianca de colo', 100, 10000, false, 4) RETURNING id`, [lotId]))!.id

  try {
    const r = await fetch(`${BASE}/api/e/${SLUG}`, { signal: AbortSignal.timeout(3000) })
    noAr = r.ok
  } catch { noAr = false }
})

afterAll(async () => {
  await q(`DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE org_id = $1)`, [orgId])
  await q(`DELETE FROM tickets WHERE order_id IN (SELECT id FROM orders WHERE org_id = $1)`, [orgId])
  await q(`DELETE FROM orders WHERE org_id = $1`, [orgId])
  await q(`DELETE FROM organizations WHERE id = $1`, [orgId])
  await db().end()
})

/** Devolve o lote ao estado inicial: nada vendido, nada reservado. */
beforeEach(async () => {
  await q(`DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE org_id = $1)`, [orgId])
  await q(`DELETE FROM tickets WHERE order_id IN (SELECT id FROM orders WHERE org_id = $1)`, [orgId])
  await q(`DELETE FROM orders WHERE org_id = $1`, [orgId])
  await q(`UPDATE lots SET sold = 0, reserved = 0, quantity = 100,
                           min_per_order = 1, max_per_order = 10 WHERE id = $1`, [lotId])
  await q(`UPDATE ticket_types SET sold = 0, quantity = 100 WHERE lot_id = $1`, [lotId])
})

const pular = () => {
  if (!noAr) console.warn('  (pulado: servidor fora do ar em ' + BASE + ')')
  return !noAr
}

/* ====================================================================== */
/* 1. o que a tela deixa montar                                           */
/* ====================================================================== */

describe('teto: a variação manda, não o lote', () => {
  it('vale o MENOR entre o teto do lote e o da variação', () => {
    expect(tetoDaLinha({ maxPorCompra: 10 }, { maxPorCompra: 3 })).toBe(3)
    expect(tetoDaLinha({ maxPorCompra: 2 }, { maxPorCompra: 8 })).toBe(2)
  })

  it('variação sem teto próprio herda o do lote, e nada fica negativo', () => {
    expect(tetoDaLinha({ maxPorCompra: 4 }, {})).toBe(4)
    expect(tetoDaLinha({ maxPorCompra: -1 }, { maxPorCompra: -5 })).toBe(0)
  })

  it('clicar "+" dez vezes numa variação com 3 na prateleira para em 3', () => {
    const lote = { maxPorCompra: 10, minPorCompra: 1 }
    const v = { maxPorCompra: 3 }
    let n = 0
    for (let i = 0; i < 10; i++) n = ajustarQuantidade(n, 1, lote, v)
    expect(n).toBe(3)
  })
})

describe('mínimo do lote — a trava que só existe na tela', () => {
  it('o primeiro "+" já entra no mínimo', () => {
    expect(ajustarQuantidade(0, 1, { maxPorCompra: 10, minPorCompra: 4 }, { maxPorCompra: 10 })).toBe(4)
  })

  it('descer abaixo do mínimo tira a linha, em vez de parar num número que não compra', () => {
    const lote = { maxPorCompra: 10, minPorCompra: 4 }
    expect(ajustarQuantidade(4, -1, lote, { maxPorCompra: 10 })).toBe(0)
    expect(ajustarQuantidade(5, -1, lote, { maxPorCompra: 10 })).toBe(4)
  })

  it('mínimo maior que o que restou não vende — e a tela diz por quê', () => {
    const lote = { maxPorCompra: 2, minPorCompra: 4 }
    const v = { maxPorCompra: 2 }
    expect(ajustarQuantidade(0, 1, lote, v)).toBe(0)
    expect(impedimentoDaLinha(lote, v)).toBe('Mínimo de 4 por compra, e só restam 2')
  })

  it('minPorCompra ausente ou torto vira 1, nunca 0 nem NaN', () => {
    expect(minimoDaLinha({})).toBe(1)
    expect(minimoDaLinha({ minPorCompra: 0 })).toBe(1)
    expect(minimoDaLinha({ minPorCompra: 'x' })).toBe(1)
  })
})

describe('declaração de meia-entrada', () => {
  it('a lista de motivos é a da lei — motivo inventado não passa', () => {
    expect(faltaNaDeclaracao({ motivo: '', documento: '' })).toMatch(/Escolha o motivo/)
    expect(faltaNaDeclaracao({ motivo: 'amigo_do_dono', documento: '' }))
      .toMatch(/previstos em lei/)
    expect(faltaNaDeclaracao({ motivo: 'idoso', documento: '' })).toBeNull()
  })

  it('motivo que depende de credencial numerada exige o número', () => {
    expect(faltaNaDeclaracao({ motivo: 'estudante', documento: '' }))
      .toMatch(/Informe o número/)
    expect(faltaNaDeclaracao({ motivo: 'estudante', documento: '  ' }))
      .toMatch(/Informe o número/)
    expect(faltaNaDeclaracao({ motivo: 'estudante', documento: '2024-118822' })).toBeNull()
  })

  it('gratuidade não é meia: total zero não pede motivo', () => {
    expect(pedeDeclaracaoDeMeia({ exigeDocumento: true, totalCents: 0 })).toBe(false)
    expect(pedeDeclaracaoDeMeia({ exigeDocumento: true, totalCents: 1650 })).toBe(true)
    expect(pedeDeclaracaoDeMeia({ exigeDocumento: false, totalCents: 3300 })).toBe(false)
  })

  it('o carrinho lista o que falta, por linha, antes de deixar pagar', () => {
    const linhas = [
      linha({ id: 'l1' }, { tipoId: 't1', nome: 'Meia-entrada', exigeDocumento: true, totalCents: 1650 },
        2, { motivo: '', documento: '' }),
      linha({ id: 'l1' }, { tipoId: 't2', nome: 'Inteira', exigeDocumento: false, totalCents: 3300 }, 1),
    ]
    expect(pendenciasDoCarrinho(linhas)).toEqual(['Meia-entrada: escolha o motivo da meia-entrada'])
  })
})

describe('o corpo que vai pro checkout', () => {
  const lote = { id: 'lote-1' }
  const meia = { tipoId: 'tipo-1', nome: 'Meia-entrada', exigeDocumento: true, totalCents: 1650 }

  it('não manda preço nenhum — preço é do servidor', () => {
    const [item] = itensDoCheckout([linha(lote, meia, 2, { motivo: 'idoso', documento: '' })])
    expect(Object.keys(item).sort()).toEqual(['lotId', 'meia', 'quantidade', 'ticketTypeId'])
  })

  it('a declaração vai junto, e o documento em branco não vira string vazia', () => {
    const [item] = itensDoCheckout([linha(lote, meia, 2, { motivo: 'idoso', documento: '   ' })]) as any[]
    expect(item.meia).toEqual({ motivo: 'idoso', documento: undefined })
  })

  it('`semDeclaracao` tira a meia do corpo — é a saída do 422 `meia_em_inteira`', () => {
    const [item] = itensDoCheckout(
      [linha(lote, meia, 1, { motivo: 'idoso', documento: '' })], { semDeclaracao: true }) as any[]
    expect(item.meia).toBeUndefined()
  })

  it('a soma separa face e taxa — a taxa tem que aparecer antes do último clique', () => {
    const linhas = [
      linha({ id: 'l' }, { tipoId: 'a', faceCents: 3000, taxaCents: 300, totalCents: 3300 }, 2),
      linha({ id: 'l' }, { tipoId: 'b', faceCents: 1500, taxaCents: 150, totalCents: 1650 }, 1),
    ]
    expect(totaisDoCarrinho(linhas)).toEqual({ face: 7500, taxa: 750, total: 8250, n: 3 })
  })

  it('a chave da linha separa variações do mesmo lote', () => {
    expect(chaveDaLinha('l', 'a')).not.toBe(chaveDaLinha('l', 'b'))
    expect(chaveDaLinha('l', null)).toBe('l|')
  })
})

describe('F5 na tela de "deu certo" não volta pra vitrine', () => {
  it('quem acabou de pagar cai no ingresso, não em "escolha seus ingressos"', () => {
    expect(destinoSemCarrinho(SLUG, { slug: SLUG, pedido: 'PED-AAAA-BBBB' }))
      .toBe('/ingressos/PED-AAAA-BBBB')
  })

  it('sem compra nesta aba, o desvio é a vitrine', () => {
    expect(destinoSemCarrinho(SLUG, null)).toBe(`/e/${SLUG}`)
  })

  it('pagamento de OUTRO evento não sequestra o desvio', () => {
    // Duas abas, dois eventos, mesma `sessionStorage` por aba — sem conferir o
    // slug, o comprador do evento B abriria o ingresso do evento A.
    expect(destinoSemCarrinho(SLUG, { slug: 'outro-evento', pedido: 'PED-XXXX-YYYY' }))
      .toBe(`/e/${SLUG}`)
  })

  it('carimbo pela metade (sem código) também volta pra vitrine', () => {
    expect(destinoSemCarrinho(SLUG, { slug: SLUG })).toBe(`/e/${SLUG}`)
  })
})

/* ====================================================================== */
/* 1b. o carimbo de "esta aba pagou" — os DOIS caminhos                    */
/* ====================================================================== */

/**
 * `destinoSemCarrinho` só sabe desviar quem TEM carimbo. Quem escreve o
 * carimbo é a outra metade da regra, e era essa metade que faltava: o pedido
 * que já nasce pago (total zero — ingresso gratuito, cupom de 100% com taxa
 * absorvida) nunca passava pelo vigia que gravava `dt:pago`.
 *
 * Medido no navegador ANTES do conserto, com um tipo de espécie `gratuito`:
 * tela "Ingressos emitidos" (pedido PED-VM23-Q742) com `dt:carrinho`,
 * `dt:pedido` e `dt:pago` os três `null`, e F5 caindo em `/e/<slug>` —
 * "Escolha seus ingressos" na cara de quem tinha o ingresso na mão.
 */
describe('carimbo de pago: quem nasce pago também precisa ser lembrado', () => {
  it('a resposta do checkout que JÁ vem paga vira carimbo, e o carimbo desvia', () => {
    // Exatamente o corpo que checkout.post.ts devolve quando totalCents é 0:
    // sem `expiraEm`, sem `pagamento`, sem `descontoCents`.
    const respostaGratuita = { ok: true, pedido: 'PED-VM23-Q742', pedidoId: 'uuid', status: 'pago', totalCents: 0 }
    const carimbo = carimboDePago(SLUG, respostaGratuita)
    expect(carimbo).toEqual({ slug: SLUG, pedido: 'PED-VM23-Q742' })
    expect(destinoSemCarrinho(SLUG, carimbo)).toBe('/ingressos/PED-VM23-Q742')
  })

  it('pedido ainda em aberto não carimba nada', () => {
    const emAberto = { status: 'aguardando_pagamento', pedido: 'PED-AAAA-BBBB' }
    expect(carimboDePago(SLUG, emAberto)).toBeNull()
    expect(carimboDePago(SLUG, null)).toBeNull()
  })

  it('o vigia carimba com o código que a tela já tinha quando a consulta não traz', () => {
    // `/api/pedido/:id` devolve `pedido`, mas a tela guarda o código desde o
    // checkout: o carimbo não pode depender de qual das duas rotas respondeu.
    expect(carimboDePago(SLUG, { status: 'pago' }, 'PED-CCCC-DDDD'))
      .toEqual({ slug: SLUG, pedido: 'PED-CCCC-DDDD' })
    // Sem código de lado nenhum não dá pra desviar: meio carimbo mandaria o
    // comprador pra `/ingressos/undefined`.
    expect(carimboDePago(SLUG, { status: 'pago' })).toBeNull()
  })

  /**
   * A trava que o teste de função pura NÃO pega: a tela pode ter a função e
   * simplesmente não chamar. Foi assim que o buraco existiu — `setItem` morava
   * dentro de `aplicarEstado`, que só o vigia alcança.
   *
   * Arrancar a chamada do caminho "já nasce pago" deixa este teste vermelho.
   */
  it('a tela de pagamento carimba nos DOIS caminhos, e num lugar só', () => {
    const tela = readFileSync(
      new URL('../pages/e/[slug]/pagamento.vue', import.meta.url), 'utf8')

    const gravacoes = tela.match(/sessionStorage\.setItem\(\s*CHAVE_PAGO/g) ?? []
    expect(gravacoes, 'CHAVE_PAGO tem que ser gravada num lugar só').toHaveLength(1)

    const chamadas = tela.match(/\blembrarPago\(/g) ?? []
    // 1 declaração + os 2 caminhos que chegam em "pago".
    expect(chamadas.length, 'os dois caminhos de pago precisam carimbar')
      .toBeGreaterThanOrEqual(3)

    // E nenhum `etapa = 'pago'` pode estar longe de um carimbo: os dois trechos
    // que mudam a tela pra "Ingressos emitidos" citam `lembrarPago` por perto.
    for (const m of tela.matchAll(/etapa\.value = 'pago'/g)) {
      const vizinhanca = tela.slice(Math.max(0, m.index! - 400), m.index! + 400)
      expect(vizinhanca, 'tela vai pra "pago" sem carimbar').toContain('lembrarPago(')
    }
  })
})

/* ====================================================================== */
/* 2. o carrinho montado aqui é comprado de verdade                       */
/* ====================================================================== */

describe('vitrine → carrinho → checkout, pela HTTP', () => {
  it('a meia-entrada declarada na tela COMPRA, e o motivo chega no ingresso', async () => {
    if (pular()) return
    const { lote, variacao } = await daVitrine('Meia-entrada')
    expect(pedeDeclaracaoDeMeia(variacao)).toBe(true)

    const l = linha(lote, variacao, ajustarQuantidade(0, 1, lote, variacao),
      { motivo: 'estudante', documento: '2026-99881' })
    const r = await comprar(itensDoCheckout([l]))
    expect(r.status).toBe(200)

    const item = await q1<any>(
      `SELECT half_reason, half_document, half_document_required
         FROM order_items WHERE order_id = (SELECT id FROM orders WHERE code = $1)`,
      [r.corpo.pedido])
    expect(item!.half_reason).toBe('estudante')
    expect(item!.half_document).toBe('2026-99881')
    // O texto que a portaria lê no ingresso é congelado na compra.
    expect(item!.half_document_required).toMatch(/Estudantil/)
  })

  /**
   * O par do teste acima: sem a declaração, a MESMA compra morre em 422. É
   * isto que prova que mandar a meia é invariante e não enfeite — arrancar a
   * declaração de `itensDoCheckout` transforma o teste de cima em vermelho
   * com este recado.
   */
  it('a mesma compra SEM a declaração é recusada, com a lista de motivos no recado', async () => {
    if (pular()) return
    const { lote, variacao } = await daVitrine('Meia-entrada')
    const l = linha(lote, variacao, 1, { motivo: 'estudante', documento: '2026-99881' })

    const r = await comprar(itensDoCheckout([l], { semDeclaracao: true }))
    expect(r.status).toBe(422)
    expect(r.corpo.data?.tipo).toBe('meia_sem_motivo')
    expect(r.recado).toMatch(/escolha o motivo da meia-entrada/)
  })

  it('a quantidade que a tela deixa montar é a que o estoque aguenta', async () => {
    if (pular()) return
    // Sobram 3 meias — o resto do lote continua cheio, então o teto de 3 só
    // pode vir da VARIAÇÃO. É exatamente o caso que clampar pelo lote perdia.
    await q(`UPDATE ticket_types SET quantity = 3 WHERE id = $1`, [tipoMeia])

    const { lote, variacao } = await daVitrine('Meia-entrada')
    expect(tetoDaLinha(lote, variacao)).toBe(3)

    let n = 0
    for (let i = 0; i < 10; i++) n = ajustarQuantidade(n, 1, lote, variacao)
    const ok = await comprar(itensDoCheckout(
      [linha(lote, variacao, n, { motivo: 'idoso', documento: '' })]))
    expect(ok.status).toBe(200)
  })

  it('sem o teto, o mesmo clique vira 409 na cara do comprador', async () => {
    if (pular()) return
    await q(`UPDATE ticket_types SET quantity = 3 WHERE id = $1`, [tipoMeia])
    const { lote, variacao } = await daVitrine('Meia-entrada')

    // 10 é o que dez cliques dariam sem o clamp de `ajustarQuantidade`.
    const r = await comprar(itensDoCheckout(
      [linha(lote, variacao, 10, { motivo: 'idoso', documento: '' })]))
    expect(r.status).toBe(409)
    expect(r.corpo.data?.tipo).toBe('estoque')
    expect(r.recado).toMatch(/Restaram 3 ingressos/)
  })

  it('inteira não leva declaração nenhuma no corpo', async () => {
    if (pular()) return
    const { lote, variacao } = await daVitrine('Inteira')
    expect(pedeDeclaracaoDeMeia(variacao)).toBe(false)
    const [item] = itensDoCheckout([linha(lote, variacao, 2)]) as any[]
    expect(item.meia).toBeUndefined()
    expect((await comprar([item])).status).toBe(200)
  })

  /**
   * O buraco conhecido, com a saída provada.
   *
   * "Nominal" tem preço cheio e exige documento: o banco chama de inteira
   * (`discount_bps = 0`), a vitrine pública não recebe o desconto e chama de
   * meia. Sem o reenvio, quem escolhesse esse ingresso ficaria preso numa tela
   * que pede um motivo que o servidor recusa.
   */
  it('ingresso nominal: o 422 `meia_em_inteira` tem saída, e ela compra', async () => {
    if (pular()) return
    const { lote, variacao } = await daVitrine('Nominal')
    expect(pedeDeclaracaoDeMeia(variacao)).toBe(true)      // a tela erra de propósito aqui
    const l = linha(lote, variacao, 1, { motivo: 'idoso', documento: '' })

    const recusado = await comprar(itensDoCheckout([l]))
    expect(recusado.status).toBe(422)
    expect(recusado.corpo.data?.tipo).toBe('meia_em_inteira')

    const aceito = await comprar(itensDoCheckout([l], { semDeclaracao: true }))
    expect(aceito.status).toBe(200)
  })

  /**
   * O caminho que não tem gateway: total zero fecha o pedido dentro do próprio
   * `POST /api/checkout` (`if (total.totalCents === 0)`), e a tela vai direto
   * pra "Ingressos emitidos" sem o vigia rodar uma vez sequer.
   *
   * O que este teste prende é a PONTE: a resposta real dessa compra tem que
   * bastar pro carimbo. Se o checkout parar de mandar o código do pedido nesse
   * ramo, o carimbo vira `null` e o F5 volta a devolver pra vitrine quem já
   * tem o ingresso — e ninguém descobre por exceção nenhuma.
   */
  it('ingresso gratuito fecha no próprio checkout — e a resposta dá conta do carimbo', async () => {
    if (pular()) return
    const { lote, variacao } = await daVitrine('Crianca de colo')
    expect(variacao.totalCents).toBe(0)
    expect(pedeDeclaracaoDeMeia(variacao)).toBe(false)   // gratuidade não é meia

    const r = await comprar(itensDoCheckout([linha(lote, variacao, 1)]))
    expect(r.status).toBe(200)
    // Nasce pago, sem cobrança: é este ramo que não tinha carimbo.
    expect(r.corpo.status).toBe('pago')
    expect(r.corpo.pagamento).toBeUndefined()

    const carimbo = carimboDePago(SLUG, r.corpo)
    expect(carimbo).not.toBeNull()
    expect(destinoSemCarrinho(SLUG, carimbo)).toBe(`/ingressos/${r.corpo.pedido}`)

    // E o destino do carimbo é uma página que existe de verdade, com o
    // ingresso já emitido — desviar pra um 404 seria trocar de problema.
    const pagina = await fetch(`${BASE}/api/pedido/${r.corpo.pedido}`)
    expect(pagina.status).toBe(200)
    const corpo = await pagina.json()
    expect(corpo.status).toBe('pago')
    expect(corpo.ingressos).toHaveLength(1)
  })

  it('o pedido criado pela tela paga e emite ingresso com o carimbo da meia', async () => {
    if (pular()) return
    const { lote, variacao } = await daVitrine('Meia-entrada')
    const r = await comprar(itensDoCheckout(
      [linha(lote, variacao, 2, { motivo: 'jovem_baixa_renda', documento: 'IDJ-771' })]))
    expect(r.status).toBe(200)

    // O gateway simulado é quem permite exercitar o caminho inteiro na
    // máquina; `/api/dev/pagar` chama a MESMA emissão do webhook do Asaas.
    const pago = await fetch(`${BASE}/api/dev/pagar`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pedido: r.corpo.pedidoId }),
    })
    expect(pago.status).toBe(200)

    const ingressos = await q<any>(
      `SELECT code, status, half_reason, half_document
         FROM tickets WHERE order_id = $1`, [r.corpo.pedidoId])
    expect(ingressos).toHaveLength(2)
    // O gatilho da migração 015 derruba a emissão de meia online sem motivo:
    // estes dois ingressos existirem é a prova de que o motivo chegou lá.
    expect(ingressos.every((t) => t.half_reason === 'jovem_baixa_renda')).toBe(true)
    expect(ingressos.every((t) => t.half_document === 'IDJ-771')).toBe(true)

    // E a página do comprador acha o pedido pelo CÓDIGO, que é o que ele tem.
    const pagina = await fetch(`${BASE}/api/pedido/${r.corpo.pedido}`)
    const corpo = await pagina.json()
    expect(corpo.status).toBe('pago')
    expect(corpo.ingressos).toHaveLength(2)
  })
})
