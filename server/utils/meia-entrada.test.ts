/**
 * meia-entrada.test.ts — a cota legal e a comprovação da portaria.
 *
 * O que está sendo testado não é aritmética de desconto: é o que o sistema
 * RECUSA. Meia-entrada é obrigação com teto (até 40% dos ingressos, Decreto
 * 8.537/2015) e com comprovação na entrada (Lei 12.933/2013). As duas pontas
 * falham em silêncio quando ninguém segura:
 *
 *   * **a cota** é uma soma sobre o lote. Somar sem a linha do lote travada
 *     passa em teste sequencial e não segura nada — dois compradores leem
 *     "ainda cabe" no mesmo milissegundo e os dois gravam. Por isso o caso de
 *     concorrência aqui usa DUAS CONEXÕES do pool com a ordem forçada na mão,
 *     e não dois `fetch` com `Promise.all`: os dois fetch não chegam juntos no
 *     servidor de dev, o primeiro já gravou quando o segundo lê, e o teste
 *     fica verde com a trava arrancada;
 *
 *   * **o motivo** não dá erro nenhum quando falta. O ingresso sai, a venda
 *     fecha, e o buraco só aparece no portão: o operador lê "Meia-entrada" e
 *     não sabe qual documento pedir. Por isso o caso que vai até o fim
 *     confere o que ficou gravado NO INGRESSO, não no pedido.
 *
 * Fixture própria, ids próprios, `DELETE` no `afterAll`. O evento semeado não
 * é tocado. Sem servidor de dev no ar, a parte HTTP PULA em vez de falhar.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { q, q1, tx, db } from './db'
import { reservar } from './estoque'
import { SQL_TRAVA_LOTE } from './estoque'
import {
  conferirCotaDeMeia, COTA_LEGAL_BPS, cotaDeMeias, CotaDeMeiaEsgotada,
  CHAVES_DE_MOTIVO, documentoExigido, MOTIVOS, SQL_TRAVA_LOTE_DA_COTA,
} from './meia-entrada'

const BASE = process.env.BASE_TESTE ?? 'http://localhost:3100'
const SLUG = 'zz-meia-entrada'

const ORG = '0000e015-0000-4000-8000-000000000001'
const EVENTO = '0000e015-0000-4000-8000-000000000002'
const SETOR = '0000e015-0000-4000-8000-000000000003'
const LOTE = '0000e015-0000-4000-8000-000000000004'
const INTEIRA = '0000e015-0000-4000-8000-000000000005'
const MEIA = '0000e015-0000-4000-8000-000000000006'
const PROMO = '0000e015-0000-4000-8000-000000000007'
const GRATIS = '0000e015-0000-4000-8000-000000000008'

/** 10 ingressos no lote, 40% = 4 meias. O número pequeno é de propósito:
 *  a cota tem que ser o que segura, não o estoque do tipo nem o do lote. */
const NO_LOTE = 10
const COTA = 4

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

const post = (rota: string, body: unknown) =>
  fetch(`${BASE}${rota}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })

/** Uma compra pela rota de verdade. Devolve status + o recado que o comprador lê. */
async function comprar(itens: any[]) {
  const r = await post('/api/checkout', {
    eventSlug: SLUG,
    itens,
    comprador: {
      nome: 'Comprador de Teste',
      email: `m.${Date.now()}.${Math.random().toString(36).slice(2)}@exemplo.com`,
      documento: cpf(), telefone: '73998260963',
    },
    forma: 'pix',
  })
  const corpo = await r.json().catch(() => ({}))
  return { status: r.status, recado: corpo.statusMessage ?? corpo.message ?? '', corpo }
}

/** Zera o mundo entre os casos: sem pedido, sem ingresso, estoque cheio. */
async function limpar() {
  await q(`DELETE FROM tickets WHERE org_id = $1`, [ORG])
  await q(`DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE org_id = $1)`, [ORG])
  await q(`DELETE FROM orders WHERE org_id = $1`, [ORG])
  await q(`UPDATE lots SET sold = 0, reserved = 0, quantity = $2, half_quota_bps = $3
            WHERE id = $1`, [LOTE, NO_LOTE, COTA_LEGAL_BPS])
  await q(`UPDATE ticket_types SET sold = 0 WHERE lot_id = $1`, [LOTE])
}

beforeAll(async () => {
  await q(`INSERT INTO organizations (id, name, slug)
           VALUES ($1,'ZZ MEIA ENTRADA','zz-meia-entrada-org')
           ON CONFLICT (id) DO NOTHING`, [ORG])
  await q(
    `INSERT INTO events (id, org_id, name, slug, status, starts_at, ends_at,
                         fee_bps, fee_mode_online)
     VALUES ($1,$2,'ZZ MEIA ENTRADA',$3,'ativo',
             now() + interval '10 days', now() + interval '11 days', 1000, 'repassar')
     ON CONFLICT (id) DO UPDATE SET status = 'ativo',
       starts_at = EXCLUDED.starts_at, ends_at = EXCLUDED.ends_at`, [EVENTO, ORG, SLUG])
  await q(`INSERT INTO sectors (id, event_id, name) VALUES ($1,$2,'ZZ PISTA')
           ON CONFLICT (id) DO NOTHING`, [SETOR, EVENTO])
  await q(
    `INSERT INTO lots (id, sector_id, name, price_cents, quantity, max_per_order, channels, visible)
     VALUES ($1,$2,'ZZ LOTE MEIA',10000,$3,10,'{online}',true)
     ON CONFLICT (id) DO UPDATE SET quantity = EXCLUDED.quantity, sold = 0, reserved = 0`,
    [LOTE, SETOR, NO_LOTE])

  // Os quatro cantos da espécie gerada (db/015): desconto zero, desconto COM
  // documento, desconto SEM documento e gratuidade.
  const tipo = async (id: string, nome: string, desconto: number, doc: boolean) =>
    q(`INSERT INTO ticket_types (id, lot_id, name, quantity, discount_bps, requires_document)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (id) DO UPDATE SET sold = 0, discount_bps = EXCLUDED.discount_bps,
         requires_document = EXCLUDED.requires_document, quantity = EXCLUDED.quantity`,
      [id, LOTE, nome, NO_LOTE, desconto, doc])
  await tipo(INTEIRA, 'ZZ Inteira', 0, false)
  await tipo(MEIA, 'ZZ Meia-entrada', 5000, true)
  await tipo(PROMO, 'ZZ Promo 50%', 5000, false)
  await tipo(GRATIS, 'ZZ Cortesia infantil', 10_000, false)

  await limpar()

  try {
    noAr = (await fetch(`${BASE}/api/e/${SLUG}`, { signal: AbortSignal.timeout(3000) })).ok
  } catch { noAr = false }
}, 30_000)

afterAll(async () => {
  await q(`DELETE FROM tickets WHERE org_id = $1`, [ORG])
  await q(`DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE org_id = $1)`, [ORG])
  await q(`DELETE FROM orders WHERE org_id = $1`, [ORG])
  await q(`DELETE FROM organizations WHERE id = $1`, [ORG])
})

/* ====================================================================== */
/* 1. a régua: quem tem direito e quantas cabem                           */
/* ====================================================================== */
describe('a régua da meia-entrada', () => {
  it('a cota é 40% do lote, arredondando pra baixo', () => {
    expect(cotaDeMeias(NO_LOTE)).toBe(COTA)
    // 40% de 7 é 2,8 — a terceira já passa do teto. "Até 40%" não é
    // "aproximadamente 40%".
    expect(cotaDeMeias(7), 'arredondou pra cima e vendeu uma meia a mais que a lei permite').toBe(2)
    expect(cotaDeMeias(0)).toBe(0)
    expect(cotaDeMeias(5000)).toBe(2000)
    // produtor que resolveu oferecer mais do que a lei exige
    expect(cotaDeMeias(100, 5000)).toBe(50)
  })

  it('todo motivo previsto diz qual documento a portaria pede', () => {
    expect(CHAVES_DE_MOTIVO).toEqual(
      ['estudante', 'idoso', 'pcd', 'acompanhante', 'jovem_baixa_renda', 'professor'])
    for (const chave of CHAVES_DE_MOTIVO) {
      const m = MOTIVOS[chave]
      expect(m.rotulo.length, `${chave} sem rótulo`).toBeGreaterThan(2)
      // Quem lê isto está no portão com fila atrás: tem que dizer O QUE pedir,
      // não repetir o nome do benefício.
      expect(m.documento.length, `${chave} não diz o que a portaria pede`).toBeGreaterThan(15)
      expect(m.base.length, `${chave} sem base legal`).toBeGreaterThan(5)
    }
    expect(documentoExigido('estudante')).toContain('CIE')
    expect(documentoExigido('jovem_baixa_renda')).toContain('ID Jovem')
    expect(() => documentoExigido('amigo_do_dono')).toThrow()
  })

  it('a recusa diz o que acabou e o que dá pra fazer agora', () => {
    const acabou = new CotaDeMeiaEsgotada(LOTE, 'ZZ LOTE MEIA', 4, 4, 1)
    expect(acabou.restavam).toBe(0)
    expect(acabou.recado).toContain('As meias-entradas deste lote acabaram')
    // sem esta frase o comprador fecha a aba achando que o evento esgotou
    expect(acabou.recado, 'não disse que a inteira continua à venda').toContain('inteira')

    const quaseAcabou = new CotaDeMeiaEsgotada(LOTE, 'ZZ LOTE MEIA', 4, 3, 2)
    expect(quaseAcabou.restavam).toBe(1)
    expect(quaseAcabou.recado).toContain('Restou 1 meia-entrada')
    expect(quaseAcabou.recado).toContain('você pediu 2')
  })
})

/* ====================================================================== */
/* 2. a espécie sai do banco, não de um campo que ninguém preenche        */
/* ====================================================================== */
describe('espécie do tipo de ingresso', () => {
  const especie = async (id: string) =>
    (await q1<any>(`SELECT kind FROM ticket_types WHERE id = $1`, [id]))!.kind

  it('desconto com documento é meia; desconto sem documento é promoção', async () => {
    expect(await especie(INTEIRA)).toBe('inteira')
    expect(await especie(MEIA)).toBe('meia')
    // O caso que justifica a regra ter DOIS campos: uma promoção de 50% para
    // todo mundo não é meia-entrada. Se fosse, ela passaria a exigir motivo do
    // comprador e ficaria presa em 40% do lote sem ninguém ter pedido isso.
    expect(await especie(PROMO),
      'promoção de 50% virou meia-entrada e passou a consumir cota legal').toBe('inteira')
    expect(await especie(GRATIS)).toBe('gratuito')
  })

  it('a espécie acompanha a edição do tipo, sem ninguém gravar coluna', async () => {
    await q(`UPDATE ticket_types SET requires_document = true WHERE id = $1`, [PROMO])
    expect(await especie(PROMO)).toBe('meia')
    await q(`UPDATE ticket_types SET requires_document = false WHERE id = $1`, [PROMO])
    expect(await especie(PROMO)).toBe('inteira')
  })
})

/* ====================================================================== */
/* 3. a cota, contra o banco                                              */
/* ====================================================================== */
/** Uma venda como o checkout faz: reserva estoque e confere a cota na mesma tx. */
async function venderMeia(quantidade: number) {
  return tx(async (c) => {
    await reservar(c, [{ lotId: LOTE, ticketTypeId: MEIA, quantidade }], { canal: 'online' })
    return conferirCotaDeMeia(c, LOTE, quantidade)
  })
}

describe('a cota do lote', () => {
  it('deixa vender até a cota e recusa a próxima', async () => {
    await limpar()

    const r = await venderMeia(COTA)
    expect(r.cota).toBe(COTA)
    expect(r.restam).toBe(0)

    await expect(venderMeia(1), 'vendeu a quinta meia num lote onde a lei permite quatro')
      .rejects.toThrow(CotaDeMeiaEsgotada)

    // e a tentativa recusada não pode ter comido estoque: o rollback devolve
    const t = await q1<any>(`SELECT sold FROM ticket_types WHERE id = $1`, [MEIA])
    expect(Number(t!.sold), 'a meia recusada ficou marcada como vendida assim mesmo').toBe(COTA)
  })

  it('a inteira do mesmo lote continua à venda depois da cota estourar', async () => {
    await limpar()
    await venderMeia(COTA)

    await expect(tx(async (c) => {
      await reservar(c, [{ lotId: LOTE, ticketTypeId: INTEIRA, quantidade: 5 }], { canal: 'online' })
      return conferirCotaDeMeia(c, LOTE, 0)
    }), 'a cota da meia travou a venda da inteira').resolves.toBeTruthy()
  })

  it('a cota é do LOTE, somando todos os tipos de meia dele', async () => {
    await limpar()
    // PROMO vira meia-entrada também: duas prateleiras, uma cota só.
    await q(`UPDATE ticket_types SET requires_document = true WHERE id = $1`, [PROMO])
    try {
      await tx(async (c) => {
        await reservar(c, [{ lotId: LOTE, ticketTypeId: MEIA, quantidade: 2 }], { canal: 'online' })
        return conferirCotaDeMeia(c, LOTE, 2)
      })
      await expect(tx(async (c) => {
        await reservar(c, [{ lotId: LOTE, ticketTypeId: PROMO, quantidade: 3 }], { canal: 'online' })
        return conferirCotaDeMeia(c, LOTE, 3)
      }), 'cada tipo de meia ganhou uma cota própria — a soma passou dos 40%')
        .rejects.toThrow(CotaDeMeiaEsgotada)
    } finally {
      await q(`UPDATE ticket_types SET requires_document = false WHERE id = $1`, [PROMO])
    }
  })

  it('a cota do lote não enxerga a meia de outro lote', async () => {
    await limpar()
    const outro = await q1<any>(
      `INSERT INTO lots (sector_id, name, price_cents, quantity, channels)
       VALUES ($1,'ZZ OUTRO LOTE',10000,$2,'{online}') RETURNING id`, [SETOR, NO_LOTE])
    const tipoDoOutro = await q1<any>(
      `INSERT INTO ticket_types (lot_id, name, quantity, discount_bps, requires_document)
       VALUES ($1,'ZZ Meia do outro',$2,5000,true) RETURNING id`, [outro!.id, NO_LOTE])
    try {
      await venderMeia(COTA)
      await expect(tx(async (c) => {
        await reservar(c, [{ lotId: outro!.id, ticketTypeId: tipoDoOutro!.id, quantidade: 1 }],
          { canal: 'online' })
        return conferirCotaDeMeia(c, outro!.id, 1)
      }), 'a cota de um lote barrou a venda de outro').resolves.toBeTruthy()
    } finally {
      await q(`DELETE FROM ticket_types WHERE lot_id = $1`, [outro!.id])
      await q(`DELETE FROM lots WHERE id = $1`, [outro!.id])
    }
  })

  /**
   * A cota que vale é a GRAVADA NO LOTE, não os 40% chumbados no código.
   *
   * `lots.half_quota_bps` existe pra o produtor abrir mais meia do que a lei
   * obriga (ou fechar um lote em que ela não cabe). Coluna de configuração que
   * o servidor não lê é o defeito mais caro deste repositório: a tela salva, o
   * número fica gravado, e a recusa acontece noutro lugar — o produtor abriu
   * 80% de meia, o comprador ouve "acabou" nos 40%, e ninguém consegue provar
   * quem está errado.
   *
   * Sem este caso, trocar `Number(lote.half_quota_bps)` por `COTA_LEGAL_BPS`
   * dentro de `conferirCotaDeMeia` deixa os outros 20 casos VERDES: todos eles
   * rodam no default 4000, onde as duas contas dão o mesmo número. Por isso o
   * caso puxa a coluna para os dois lados — cota MAIOR tem que deixar passar o
   * que 40% recusaria, cota MENOR tem que recusar o que 40% deixaria passar.
   */
  it('a cota que vale é a gravada no lote, não os 40% chumbados no código', async () => {
    try {
      // 80% de 10 = 8 meias: o produtor ofereceu mais do que a lei exige
      await limpar()
      await q(`UPDATE lots SET half_quota_bps = 8000 WHERE id = $1`, [LOTE])
      const largo = await venderMeia(COTA + 1)
      expect(largo.cota,
        'a cota saiu dos 40% da lei e não do half_quota_bps gravado no lote').toBe(8)
      expect(largo.vendidas).toBe(COTA + 1)

      // 20% de 10 = 2 meias: o mesmo lote com a cota fechada
      await limpar()
      await q(`UPDATE lots SET half_quota_bps = 2000 WHERE id = $1`, [LOTE])
      await expect(venderMeia(3),
        'vendeu 3 meias num lote cuja cota gravada é 2 — a coluna não foi lida')
        .rejects.toThrow(CotaDeMeiaEsgotada)
    } finally {
      await q(`UPDATE lots SET half_quota_bps = $2 WHERE id = $1`, [LOTE, COTA_LEGAL_BPS])
    }
  })

  /**
   * Concorrência de verdade — e por que não dá com dois `fetch`.
   *
   * Dois pedidos disparados com `Promise.all` não chegam juntos no servidor de
   * dev: o primeiro já gravou quando o segundo lê, e o caso fica VERDE mesmo
   * com a trava arrancada. Aqui a ordem é forçada na mão, em duas conexões do
   * pool, rodando exatamente as linhas que a rota roda.
   */
  it('o segundo comprador espera a trava e aí não cabe mais', async () => {
    await limpar()
    // três meias já vendidas: cabe exatamente mais uma na cota de quatro
    await q(`UPDATE ticket_types SET sold = 3 WHERE id = $1`, [MEIA])
    await q(`UPDATE lots SET reserved = 3 WHERE id = $1`, [LOTE])

    const c1 = await db().connect()
    const c2 = await db().connect()
    try {
      await c1.query('BEGIN')
      await c2.query('BEGIN')

      // A pega a última vaga da cota
      await reservar(c1, [{ lotId: LOTE, ticketTypeId: MEIA, quantidade: 1 }], { canal: 'online' })
      const cotaA = await conferirCotaDeMeia(c1, LOTE, 1)
      expect(cotaA.vendidas).toBe(COTA)
      expect(cotaA.restam).toBe(0)

      // B tenta e FICA PENDURADO na trava do lote — a promessa não resolve
      // enquanto A não terminar. É isto que o caso precisa provar.
      let bPassou = false
      const bEsperando = c2.query(SQL_TRAVA_LOTE, [LOTE])
        .then(() => { bPassou = true })
        // se o caso falhar antes do COMMIT, o `finally` solta a trava e esta
        // promessa resolve sozinha; sem o catch viraria rejeição solta.
        .catch(() => {})

      await new Promise((r) => setTimeout(r, 400))
      expect(bPassou,
        'o segundo comprador leu o lote sem esperar — a trava não está segurando').toBe(false)

      await c1.query('COMMIT')

      // agora B anda, e tem que enxergar a meia que A levou
      await bEsperando
      await c2.query(`UPDATE ticket_types SET sold = sold + 1 WHERE id = $1`, [MEIA])
      await expect(conferirCotaDeMeia(c2, LOTE, 1),
        'o segundo passou da cota porque leu o estoque de antes do primeiro')
        .rejects.toThrow(CotaDeMeiaEsgotada)
      await c2.query('ROLLBACK')
    } finally {
      // ROLLBACK antes de devolver ao pool, SEMPRE: `release()` não desfaz
      // transação aberta, e o `FOR UPDATE` preso trava o caso seguinte até o
      // timeout — uma falha vira duas, e a segunda aponta pro lugar errado.
      await c1.query('ROLLBACK').catch(() => {})
      await c2.query('ROLLBACK').catch(() => {})
      c1.release()
      c2.release()
    }

    const t = await q1<any>(`SELECT sold FROM ticket_types WHERE id = $1`, [MEIA])
    expect(Number(t!.sold), 'saiu mais meia do que a cota do lote').toBeLessThanOrEqual(COTA)
  }, 30_000)

  /**
   * O caso acima prova a ordem no caminho da rota — onde quem trava é
   * `reservar()`. Mas a cota também precisa travar SOZINHA: é assim que o
   * balcão vai chamá-la amanhã, e é o único jeito de este arquivo ficar
   * vermelho quando o `FOR UPDATE` daqui for arrancado. Sem este caso, tirar a
   * trava de `conferirCotaDeMeia` não derrubaria teste nenhum.
   */
  it('a contagem da cota só acontece depois da trava do lote', async () => {
    await limpar()
    const c1 = await db().connect()
    const c2 = await db().connect()
    try {
      await c1.query('BEGIN')
      await c2.query('BEGIN')

      await conferirCotaDeMeia(c1, LOTE, 0)

      let bPassou = false
      const bEsperando = conferirCotaDeMeia(c2, LOTE, 0)
        .then(() => { bPassou = true })
        .catch(() => {})

      await new Promise((r) => setTimeout(r, 400))
      expect(bPassou,
        'a segunda conexão contou a cota sem esperar a primeira: a conta não está travada, '
        + 'e dois compradores simultâneos passam dos 40%').toBe(false)

      await c1.query('COMMIT')
      await bEsperando
      await c2.query('ROLLBACK')
    } finally {
      await c1.query('ROLLBACK').catch(() => {})
      await c2.query('ROLLBACK').catch(() => {})
      c1.release()
      c2.release()
    }
  }, 30_000)

  it('a trava do lote vem antes da contagem', async () => {
    // A trava é statement exportado pelo mesmo motivo de `SQL_TRAVA_LOTE`:
    // o caso acima roda EXATAMENTE a linha da função, não uma cópia que
    // envelhece sozinha.
    expect(SQL_TRAVA_LOTE_DA_COTA).toContain('FOR UPDATE')
  })
})

/* ====================================================================== */
/* 4. a rota, que é onde o comprador está                                 */
/* ====================================================================== */
describe('o checkout pela HTTP', () => {
  const meiaDe = (n: number, motivo?: string, documento?: string) => ([{
    lotId: LOTE, ticketTypeId: MEIA, quantidade: n,
    ...(motivo ? { meia: { motivo, ...(documento ? { documento } : {}) } } : {}),
  }])

  it('não vende meia sem o motivo — e diz quais existem', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    await limpar()

    const r = await comprar(meiaDe(1))
    expect(r.status, `vendeu meia sem motivo: a portaria não sabe o que pedir — ${r.recado}`).toBe(422)
    expect(r.recado).toContain('Estudante')
    expect(r.recado).toContain('Idoso')
    expect(r.corpo?.data?.tipo).toBe('meia_sem_motivo')

    const nada = await q1<any>(`SELECT count(*)::int AS n FROM orders WHERE org_id = $1`, [ORG])
    expect(nada!.n, 'recusou na resposta e gravou o pedido assim mesmo').toBe(0)
  }, 20_000)

  it('não aceita motivo que a lei não prevê', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    await limpar()

    const r = await comprar(meiaDe(1, 'amigo_do_dono'))
    expect(r.status, `aceitou um motivo inventado — ${r.recado}`).toBe(422)
    expect(r.recado).toContain('não dá direito a meia-entrada')
  }, 20_000)

  it('estudante sem o número da carteira não passa', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    await limpar()

    const r = await comprar(meiaDe(1, 'estudante'))
    expect(r.status, `vendeu meia de estudante sem carteira — ${r.recado}`).toBe(422)
    expect(r.recado).toContain('CIE')

    // idoso comprova no portão com documento com foto: não tem número pra digitar
    const idoso = await comprar(meiaDe(1, 'idoso'))
    expect(idoso.status, `pediu número de documento pra quem comprova com RG — ${idoso.recado}`).toBe(200)
  }, 20_000)

  it('motivo de meia numa inteira é recusado', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    await limpar()

    const r = await comprar([{
      lotId: LOTE, ticketTypeId: INTEIRA, quantidade: 1,
      meia: { motivo: 'idoso' },
    }])
    expect(r.status, `gravou motivo de meia numa inteira — a portaria vai pedir documento `
      + `de quem não precisa: ${r.recado}`).toBe(422)
  }, 20_000)

  /**
   * O caso que vai até o fim: o que foi declarado na compra tem que estar NO
   * INGRESSO, que é o papel que chega na portaria. Conferir no pedido não
   * valeria: ingresso transferido, reenviado ou impresso não leva o pedido
   * junto.
   */
  it('o ingresso emitido carrega o motivo e o documento que a portaria pede', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    await limpar()

    const r = await comprar(meiaDe(2, 'estudante', '2026778899'))
    expect(r.status, `recusou uma meia declarada direitinho — ${r.recado}`).toBe(200)

    const pago = await post('/api/dev/pagar', { pedido: r.corpo.pedidoId })
    expect((await pago.json()).emitiu, 'o pagamento não emitiu o ingresso').toBe(true)

    const ingressos = await q<any>(
      `SELECT half_reason, half_document, half_document_required
         FROM tickets WHERE order_id = $1`, [r.corpo.pedidoId])
    expect(ingressos.length).toBe(2)
    for (const i of ingressos) {
      expect(i.half_reason, 'o ingresso saiu sem dizer por que é meia').toBe('estudante')
      expect(i.half_document, 'o ingresso saiu sem a carteira declarada').toBe('2026778899')
      expect(i.half_document_required,
        'o ingresso não diz o que a portaria tem que pedir').toContain('CIE')
    }
  }, 30_000)

  it('quando a cota acaba, o comprador ouve isso — não um erro seco', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    await limpar()

    const cheio = await comprar(meiaDe(COTA, 'idoso'))
    expect(cheio.status, `não vendeu as ${COTA} meias que cabem — ${cheio.recado}`).toBe(200)

    const demais = await comprar(meiaDe(1, 'idoso'))
    expect(demais.status, `vendeu a meia de número ${COTA + 1} num lote de ${NO_LOTE}`).toBe(409)
    expect(demais.recado).toContain('As meias-entradas deste lote acabaram')
    expect(demais.recado, 'não disse que a inteira continua à venda').toContain('inteira')
    expect(demais.corpo?.data?.tipo).toBe('cota_meia')

    // e a inteira do mesmo lote realmente continua vendendo
    const inteira = await comprar([{ lotId: LOTE, ticketTypeId: INTEIRA, quantidade: 1 }])
    expect(inteira.status, `a cota da meia derrubou a venda da inteira — ${inteira.recado}`).toBe(200)

    const t = await q1<any>(`SELECT sold FROM ticket_types WHERE id = $1`, [MEIA])
    expect(Number(t!.sold), 'a rota recusou na resposta e tirou a meia do estoque assim mesmo')
      .toBe(COTA)
  }, 30_000)

  it('pedido de mais meias do que restam diz quantas restam', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    await limpar()

    expect((await comprar(meiaDe(3, 'idoso'))).status).toBe(200)
    const r = await comprar(meiaDe(2, 'idoso'))
    expect(r.status).toBe(409)
    expect(r.recado).toContain('Restou 1 meia-entrada')
  }, 30_000)
})

/* ====================================================================== */
/* 5. a rede do banco                                                     */
/* ====================================================================== */
describe('a rede: ingresso de meia sem motivo não nasce', () => {
  it('o banco recusa o ingresso de meia de um pedido online sem motivo declarado', async () => {
    await limpar()

    const pedido = await q1<any>(
      `INSERT INTO orders (org_id, event_id, code, status, channel,
                           face_cents, fee_cents, platform_cents, discount_cents, total_cents)
       VALUES ($1,$2,'ZZ-MEIA-REDE','pago','online',5000,500,500,0,5500)
       RETURNING id`, [ORG, EVENTO])
    const item = await q1<any>(
      `INSERT INTO order_items (order_id, lot_id, ticket_type_id, quantity,
                                unit_face_cents, unit_fee_cents, unit_total_cents)
       VALUES ($1,$2,$3,1,5000,500,5500) RETURNING id`, [pedido!.id, LOTE, MEIA])

    const nascer = () => q(
      `INSERT INTO tickets (org_id, event_id, order_id, order_item_id, sector_id, lot_id,
                            ticket_type_id, code, qr_secret)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'ZZ-REDE-' || substr(gen_random_uuid()::text,1,8),'x')`,
      [ORG, EVENTO, pedido!.id, item!.id, SETOR, LOTE, MEIA])

    await expect(nascer(),
      'nasceu ingresso de meia sem motivo: a portaria não tem o que conferir')
      .rejects.toThrow()

    // com o motivo no item, o ingresso nasce JÁ CARIMBADO — sem a rota
    // precisar lembrar de copiar coluna nenhuma
    await q(`UPDATE order_items SET half_reason = 'idoso',
                                    half_document_required = $2 WHERE id = $1`,
      [item!.id, documentoExigido('idoso')])
    await nascer()

    const t = await q1<any>(
      `SELECT half_reason, half_document_required FROM tickets WHERE order_item_id = $1`, [item!.id])
    expect(t!.half_reason).toBe('idoso')
    expect(t!.half_document_required).toBe(documentoExigido('idoso'))
  }, 20_000)
})
