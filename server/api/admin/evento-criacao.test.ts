/**
 * evento-criacao.test.ts — o POST do assistente de "Criar evento", pelo servidor de verdade.
 *
 *   · EVT-09: a mesma criação chegando duas vezes (a resposta se perdeu e a pessoa clicou de novo)
 *     devolve o evento que já existe — um evento só, sem "-2" à venda em paralelo. Inclusive com os
 *     dois cliques AO MESMO TEMPO (é o índice parcial da migração 031 que segura a corrida);
 *   · EVT-06: UF minúscula grava maiúscula; UF torta volta com frase dizendo o campo;
 *   · EVT-14: sem faixa etária no pedido, o evento nasce "Livre" (0).
 *
 * Cria eventos na organização do seed (prefixo próprio no nome) e apaga no fim — os atos de
 * auditoria dos eventos de teste saem com a licença de expurgo, na mesma transação.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { anunciarPulo, seForaDoArPula, sondarServidor, type Sonda } from '../../../scripts/test-setup'
import { comSessao, entrar } from '../../../scripts/teste-sessao'
import { db, q, q1 } from '../../utils/db'

const MARCA = `zzcria-${randomUUID().slice(0, 8)}`
let sonda: Sonda = { noAr: false, porque: 'o beforeAll não chegou a rodar' }
let http: ReturnType<typeof comSessao>

async function chamar(body: unknown) {
  const r = await http('/api/admin/evento', { method: 'POST', body: JSON.stringify(body) })
  return { status: r.status, corpo: await r.json().catch(() => ({})) as any }
}

function evento(extra: Record<string, unknown> = {}) {
  return {
    nome: `${MARCA} evento ${randomUUID().slice(0, 4)}`,
    inicio: '2031-03-10T20:00:00.000Z',
    fim: '2031-03-11T04:00:00.000Z',
    local: { cidade: 'Ubatã', estado: 'BA' },
    setores: [{ nome: 'Pista', lotes: [{ nome: '1º lote', faceCents: 5000, quantidade: 60 }] }],
    ...extra,
  }
}

const quantosComNome = async (nome: string) =>
  Number((await q1<any>(`SELECT count(*)::int AS n FROM events WHERE name = $1`, [nome]))!.n)

beforeAll(async () => {
  sonda = await sondarServidor('/api/auth/eu')
  anunciarPulo('server/api/admin/evento-criacao.test.ts', sonda)
  if (!sonda.noAr) return
  http = comSessao(await entrar('master'))
}, 60_000)

afterAll(async () => {
  if (sonda.noAr) {
    const c = await db().connect()
    try {
      await c.query('BEGIN')
      await c.query(`SET LOCAL auditoria.expurgo = 'liberado'`)
      await c.query(`DELETE FROM audit_log WHERE entity = 'evento'
                        AND entity_id IN (SELECT id::text FROM events WHERE name LIKE $1)`, [`${MARCA}%`])
      await c.query(`DELETE FROM events WHERE name LIKE $1`, [`${MARCA}%`])
      await c.query('COMMIT')
    } finally {
      try { await c.query('ROLLBACK') } catch { /* já fechou */ }
      c.release()
    }
  }
  await db().end()
})

describe('EVT-09 — a mesma criação duas vezes é UM evento', () => {
  it('o segundo pedido com a mesma chave devolve o mesmo evento, marcado como repetido', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const corpo = evento({ chaveDeCriacao: randomUUID() })
    const primeiro = await chamar(corpo)
    expect(primeiro.status, JSON.stringify(primeiro.corpo)).toBe(200)
    expect(primeiro.corpo.repetido).toBeUndefined()
    const segundo = await chamar(corpo)
    expect(segundo.status, JSON.stringify(segundo.corpo)).toBe(200)
    expect(segundo.corpo).toMatchObject({ id: primeiro.corpo.id, slug: primeiro.corpo.slug, repetido: true })
    expect(await quantosComNome(corpo.nome), 'nasceu um segundo evento com "-2"').toBe(1)
  })

  it('dois cliques ao mesmo tempo com a mesma chave: um evento só', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const corpo = evento({ chaveDeCriacao: randomUUID() })
    const [a, b] = await Promise.all([chamar(corpo), chamar(corpo)])
    expect([a.status, b.status]).toEqual([200, 200])
    expect(a.corpo.id).toBe(b.corpo.id)
    expect(await quantosComNome(corpo.nome)).toBe(1)
  })

  it('a corrida de verdade: o segundo INSERT espera o primeiro e devolve ele (sem 500)', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    // O "primeiro clique" é uma transação ABERTA com o evento já inserido (mesma chave, mesmo
    // endereço): o POST não o enxerga no "já feito", tira o mesmo slug e o INSERT dele fica
    // esperando o índice único. Quando o primeiro grava, o POST cai em 23505 — e tem que ler e
    // devolver o primeiro, não estourar.
    const chave = randomUUID()
    const corpo = evento({ chaveDeCriacao: chave })
    const slug = corpo.nome.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70)
    const org = (await q1<any>(`SELECT org_id FROM users WHERE email = 'dono@fazendapark.com.br'`))!.org_id
    const primeiro = await db().connect()
    try {
      await primeiro.query('BEGIN')
      const { rows: [ev] } = await primeiro.query(
        `INSERT INTO events (org_id, name, slug, starts_at, ends_at, status, creation_key)
         VALUES ($1, $2, $3, '2031-03-10T20:00:00Z', '2031-03-11T04:00:00Z', 'ativo', $4) RETURNING id`,
        [org, corpo.nome, slug, chave])
      const pedido = chamar(corpo)
      await new Promise((ok) => setTimeout(ok, 700)) // o POST chega no INSERT e espera
      await primeiro.query('COMMIT')
      const r = await pedido
      expect(r.status, JSON.stringify(r.corpo)).toBe(200)
      expect(r.corpo).toMatchObject({ id: ev.id, repetido: true })
      expect(await quantosComNome(corpo.nome)).toBe(1)
    } finally {
      try { await primeiro.query('ROLLBACK') } catch { /* já gravou */ }
      primeiro.release()
    }
  })

  it('a chave é da organização: não serve de porta pro evento de outra', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const chave = randomUUID()
    const meu = await chamar(evento({ chaveDeCriacao: chave }))
    const linha = await q1<any>(`SELECT org_id, creation_key FROM events WHERE id = $1`, [meu.corpo.id])
    expect(linha.creation_key).toBe(chave)
    // a busca do "já feito" é `org_id = sessão AND creation_key = chave`
    const deOutra = await q1<any>(
      `SELECT count(*)::int AS n FROM events WHERE creation_key = $1 AND org_id <> $2`, [chave, linha.org_id])
    expect(deOutra.n).toBe(0)
  })
})

describe('EVT-06 e EVT-14 — o que o evento grava', () => {
  it('UF "ba" grava "BA"; sem faixa etária no pedido, nasce Livre (0)', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await chamar(evento({ local: { cidade: 'Ubatã', estado: 'ba' } }))
    expect(r.status, JSON.stringify(r.corpo)).toBe(200)
    const linha = await q1<any>(`SELECT state, age_rating FROM events WHERE id = $1`, [r.corpo.id])
    expect(linha).toEqual({ state: 'BA', age_rating: 0 })
  })

  it('UF torta volta 400 dizendo o campo', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await chamar(evento({ local: { cidade: 'Ubatã', estado: 'B4' } }))
    expect(r.status).toBe(400)
    expect(r.corpo.statusMessage).toBe('Endereço › Estado (UF): use as duas letras do estado (ex.: BA)')
  })

  // 28/09: o fuso era texto livre — "America/Ubata" nascia gravado; medido no banco de teste: o
  // passaporte na portaria dá erro no `AT TIME ZONE` cru ("time zone not recognized"), o e-mail do
  // ingresso morre no `Intl` (RangeError), e painel/extrato/relatórios caem em silêncio na Bahia
  it('fuso torto volta 400 dizendo o campo, e nenhum evento nasce', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const corpo = evento({ fuso: 'America/Ubata' })
    const r = await chamar(corpo)
    expect(r.status).toBe(400)
    expect(r.corpo.statusMessage).toBe('Fuso horário: fuso que não existe (use um nome como America/Bahia)')
    expect(await quantosComNome(corpo.nome)).toBe(0)
  })

  it('fuso de verdade grava (Manaus) e o painel do evento abre com ele; sem fuso, Bahia', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const manaus = await chamar(evento({ fuso: 'America/Manaus' }))
    expect(manaus.status, JSON.stringify(manaus.corpo)).toBe(200)
    expect((await q1<any>(`SELECT timezone FROM events WHERE id = $1`, [manaus.corpo.id]))!.timezone).toBe('America/Manaus')
    const painel = await http(`/api/admin/evento/${manaus.corpo.id}/dashboard`)
    expect(painel.status).toBe(200)
    const padrao = await chamar(evento())
    expect((await q1<any>(`SELECT timezone FROM events WHERE id = $1`, [padrao.corpo.id]))!.timezone).toBe('America/Bahia')
  })
})

/*
 * A frase da recusa diz o campo como a TELA o chama, e o limite como a gente lê (rodada de
 * variações, 28/09): "descricao: aceita no máximo 20000 caractere(s)" (#63), "campos › admite: o
 * mínimo é 1" (#97), "Comissão: o máximo é 10000" (bps numa tela em %), "o mínimo é 0" num campo
 * que recusa o 0, e o motivo de 600 letras da cortesia respondido com "Diga o motivo" (#8).
 */
describe('Frases de recusa — o campo da tela e o limite legível', () => {
  const lote = (extra: Record<string, unknown>) =>
    evento({ setores: [{ nome: 'Pista', lotes: [{ nome: '1º lote', faceCents: 5000, quantidade: 60, ...extra }] }] })

  it('no assistente: descrição longa, lote sem nome, quantidade, taxa e desconto', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const casos: [Record<string, unknown>, string][] = [
      [evento({ descricao: 'a'.repeat(20_001) }), 'Descrição do evento: aceita no máximo 20.000 caractere(s)'],
      [lote({ nome: '' }), 'Setores › nº 1 › Lotes › nº 1 › Nome do lote: precisa de pelo menos 1 caractere(s)'],
      [lote({ quantidade: 1_000_001 }), 'Setores › nº 1 › Lotes › nº 1 › Quantidade: o máximo é 1.000.000'],
      [evento({ taxaBps: 6000 }), 'Taxa de serviço: não pode passar de 50%'],
      [lote({ tipos: [{ nome: 'Meia', quantidade: 10, descontoBps: 10_001 }] }),
        'Setores › nº 1 › Lotes › nº 1 › Tipos de ingresso › nº 1 › Desconto: não pode passar de 100%'],
    ]
    for (const [corpo, frase] of casos) {
      const r = await chamar(corpo)
      expect(r.status, frase).toBe(400)
      expect(r.corpo.statusMessage).toBe(frase)
      expect(await quantosComNome(String(corpo.nome)), 'a recusa criou evento').toBe(0)
    }
  })

  it('nas rotas do evento: pessoas por unidade, cupom de 0, motivo da cortesia e observação do caixa', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const criado = await chamar(evento())
    expect(criado.status, JSON.stringify(criado.corpo)).toBe(200)
    const id = criado.corpo.id
    const setorId = (await q1<any>(`SELECT id FROM sectors WHERE event_id = $1 LIMIT 1`, [id]))!.id
    const enviar = async (rota: string, method: string, body: unknown) => {
      const r = await http(`/api/admin/evento/${id}/${rota}`, { method, body: JSON.stringify(body) })
      return { status: r.status, frase: ((await r.json().catch(() => ({}))) as any).statusMessage }
    }
    expect(await enviar('ingressos', 'PATCH', { o: 'setor', id: setorId, campos: { admite: 0 } }))
      .toEqual({ status: 400, frase: 'Pessoas por unidade: o mínimo é 1' })
    expect(await enviar('cupons', 'POST', { codigo: `ZZ${MARCA.slice(-6).toUpperCase()}`, tipo: 'percentual', valor: 0 }))
      .toEqual({ status: 400, frase: 'Valor do desconto: precisa ser maior que 0' })
    expect(await enviar('cortesias', 'POST', {
      loteId: randomUUID(), motivo: 'a'.repeat(201), responsavel: 'Diretoria', pessoas: [{ nome: 'Fulano de Tal' }],
    })).toEqual({ status: 400, frase: 'O motivo aceita no máximo 200 caracteres — este tem mais. Encurte e emita de novo.' })
    expect(await enviar('pdv/turno', 'PATCH', { turnoId: randomUUID(), contadoCents: 0, observacao: 'x'.repeat(401) }))
      .toEqual({ status: 400, frase: 'A observação aceita no máximo 400 caracteres — encurte e feche o caixa de novo.' })
  })
})
