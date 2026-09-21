/**
 * catraca.test.ts — o livro de entradas e a portaria sem rede.
 *
 * `server/api/catraca.test.ts` já prova que o mesmo QR não entra duas vezes
 * ONLINE. Isto aqui prova a outra metade, a que o parque na Bahia usa quando o
 * 4G cai: a entrada nasce no tablet, sem servidor, e chega horas depois numa
 * fila. Três coisas podem dar errado nesse caminho, e nenhuma delas lança
 * exceção — todas as três contam gente errada em silêncio:
 *
 *  1. **a mesma fila reenviada conta a pessoa duas vezes.** Rede oscilando,
 *     operador cutucando o botão, aba reaberta: a remessa sobe de novo. A
 *     defesa é o id da passagem nascer no DISPOSITIVO e a gravação ser
 *     `ON CONFLICT (id) DO NOTHING`. Aqui a mesma fila sobe duas vezes e as
 *     linhas são CONTADAS no banco depois — a resposta da rota pode dizer
 *     qualquer coisa, quem decide é o `count(*)`.
 *
 *  2. **o conflito de duas catracas offline some.** Os dois tablets têm o
 *     ingresso como válido na lista baixada e os dois deixam entrar. Recusar a
 *     segunda na sincronização "resolveria" o número e apagaria uma pessoa que
 *     está fisicamente dentro. As duas passagens têm que existir E aparecer.
 *
 *  3. **a hora e a contagem vêm do aparelho.** `now()` na sincronização joga o
 *     pico das 14h pras 18h; aceitar o `pessoas` do tablet entrega o público do
 *     evento pra um aparelho que passou a noite fora de rede.
 *
 * Fixture própria, `DELETE` no fim. Nada do evento semeado é tocado. Sem
 * servidor de dev no ar, PULA em vez de falhar — com `ctx.skip()`, que sai
 * CONTADO como pulado. A saída seca que estava aqui saía como ✓: medido com a
 * porta fechada, este arquivo imprimia `Tests 36 passed (36)` sem ter
 * sincronizado uma fila; e com o servidor OCUPADO (proxy segurando a primeira
 * resposta por 3 s e devolvendo 200) dava a mesma coisa, porque a sonda
 * esperava 2,5 s, uma vez só.
 *
 * Os ids saíram de FIXOS pra marcados por corrida. Com dois `npx vitest run`
 * ao mesmo tempo no mesmo banco — o dia a dia aqui — o `afterAll` de uma
 * apagava a organização que a outra estava usando (`tickets_org_id_fkey`), e
 * o slug fixo batia em `organizations_slug_key`. Ver `scripts/test-setup.ts`.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  anunciarPulo, BASE_DE_TESTE, MARCA_MAIUSCULA, seForaDoArPula, sondarServidor,
  uuidDaCorrida, type Sonda,
} from '../../scripts/test-setup'
import { db, q, tx } from './db'
import { montarQr } from './ingresso'
import {
  conferirRelogio, DOCUMENTO_GENERICO, MEIA_SEM_MOTIVO, meiaDoIngresso,
  normalizarFila, retratoDoPublico, SQL_GRAVA_ENTRADA,
} from './catraca'
import { emitirNaTransacao, EXIGENCIA_SEM_MOTIVO, exigenciaDeMeia } from './emissao'
import { documentoExigido } from './meia-entrada'

const BASE = BASE_DE_TESTE

/* ids DESTA corrida, prefixo próprio desta suíte: limpa o que criou, e só */
const fixtura = (n: number) => uuidDaCorrida('utils/catraca', n)
const ORG = fixtura(1)
const PORTEIRO = fixtura(2)
const EVENTO = fixtura(3)
const SESSAO = fixtura(4)
const SETOR = fixtura(6)
const LOTE = fixtura(7)
const SETOR_MESA = fixtura(8)
const LOTE_MESA = fixtura(9)
const FINANCEIRO = fixtura(10)
/** tipo de ingresso com `kind = 'meia'` (coluna gerada: desconto + documento) */
const TIPO_MEIA = fixtura(11)
/** sessão que só abre daqui a semanas — é nela que mora o cliente que chega cedo */
const SESSAO_FUTURA = fixtura(12)

const ORG_VIZINHA = fixtura(21)
const EVENTO_VIZINHO = fixtura(23)
const SETOR_VIZINHO = fixtura(26)
const LOTE_VIZINHO = fixtura(27)

const MARCA_MINUSCULA = MARCA_MAIUSCULA.toLowerCase()
const EMAIL_PORTEIRO = `porteiro.${MARCA_MINUSCULA}@entradas.invalido`
const EMAIL_FINANCEIRO = `financeiro.${MARCA_MINUSCULA}@entradas.invalido`
const SENHA = 'diamond123'

/**
 * `code` é UNIQUE na tabela `tickets` inteira — não por evento.
 *
 * Com o código fixo, a segunda corrida simultânea reaproveitava o ingresso da
 * primeira (`ON CONFLICT (code) DO NOTHING` engole calado) e passava a contar
 * entradas que não eram dela. A marca da corrida separa os dois bancos de
 * prova sem mudar nada do que o teste pergunta.
 */
const cod = (sufixo: string) => `ZZE-${MARCA_MAIUSCULA}-${sufixo}`

/** um uuid por passagem, como o tablet faria */
const passagemId = (n: string) => uuidDaCorrida('utils/catraca-passagem', Number(n))

let sonda: Sonda = { noAr: false, porque: 'o beforeAll não chegou a rodar' }
let cookie = ''
let cookieFinanceiro = ''

async function sincronizar(corpo: Record<string, any>, ck = cookie) {
  const r = await fetch(`${BASE}/api/portaria/sincronizar`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: ck, origin: BASE },
    body: JSON.stringify({ eventId: EVENTO, comLista: false, ...corpo }),
  })
  return { status: r.status, corpo: await r.json().catch(() => ({})) as any }
}

async function ler(qr: string, gate = 'PORTAO-1') {
  const r = await fetch(`${BASE}/api/checkin`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie, origin: BASE },
    body: JSON.stringify({ qr, eventId: EVENTO, gate }),
  })
  return { status: r.status, corpo: await r.json().catch(() => ({})) as any }
}

/** A verdade sobre quantas pessoas entraram: contada no banco, não na resposta. */
async function livroDoEvento() {
  const [l] = await q<any>(
    `SELECT count(*)::int AS linhas, COALESCE(sum(people),0)::int AS pessoas
       FROM entries WHERE event_id = $1`, [EVENTO])
  return l
}

async function passagensDe(code: string) {
  return q<any>(
    `SELECT e.* FROM entries e JOIN tickets t ON t.id = e.ticket_id
      WHERE t.code = $1 ORDER BY e.entered_at`, [code])
}

async function ingresso(code: string) {
  const [t] = await q<any>(
    `SELECT id, status, checked_in_at FROM tickets WHERE code = $1`, [code])
  return t
}

async function semearIngresso(code: string, setor = SETOR, lote = LOTE,
                              org = ORG, evento = EVENTO, sessao: string | null = SESSAO,
                              status = 'valido') {
  await q(
    `INSERT INTO tickets (org_id, event_id, session_id, sector_id, lot_id,
                          code, qr_secret, status, holder_name)
     VALUES ($1,$2,$3,$4,$5,$6,'teste',$7,'Fulano da Fila')
     ON CONFLICT (code) DO NOTHING`, [org, evento, sessao, setor, lote, code, status])
}

/** ingresso de meia-entrada já carimbado como a migração 015 carimba */
async function semearMeia(code: string, motivo = 'estudante', numero = 'CIE 2026-44120') {
  await q(
    `INSERT INTO tickets (org_id, event_id, session_id, sector_id, lot_id,
                          code, qr_secret, status, holder_name,
                          half_reason, half_document, half_document_required)
     VALUES ($1,$2,$3,$4,$5,$6,'teste','valido','Meia da Fila',$7,$8,$9)
     ON CONFLICT (code) DO NOTHING`,
    [ORG, EVENTO, SESSAO, SETOR, LOTE, code, motivo, numero,
     'Carteira de Identificação Estudantil (CIE) do ano vigente, com foto'])
}

/**
 * As DUAS meias sem motivo declarado, que são a maioria do banco de verdade.
 *
 * `velha`  — vendida antes da migração 015: só tem o texto congelado que o
 *            passo 5 daquela migração escreveu ("documento que comprove…").
 * `balcao` — vendida hoje no guichê: `pdv/venda.post.ts` não pergunta o motivo
 *            e o gatilho da 015 só derruba a venda ONLINE sem motivo, então
 *            ela nasce sem motivo E sem texto. Só o tipo diz que é meia.
 */
async function semearMeiaSemMotivo(code: string, forma: 'velha' | 'balcao') {
  await q(
    `INSERT INTO tickets (org_id, event_id, session_id, sector_id, lot_id,
                          ticket_type_id, code, qr_secret, status, holder_name,
                          half_document_required)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'teste','valido','Meia Sem Motivo',$8)
     ON CONFLICT (code) DO NOTHING`,
    [ORG, EVENTO, SESSAO, SETOR, LOTE, TIPO_MEIA, code,
     forma === 'velha'
       ? 'Documento que comprove o direito à meia-entrada '
         + '(carteira de estudante, 60+, PCD, ID Jovem ou carteira funcional de professor)'
       : null])
}

/**
 * Uma venda de BALCÃO, pelo caminho de verdade: `emitirNaTransacao`, o mesmo
 * que `pdv/venda.post.ts` chama dentro da transação do guichê.
 *
 * O item nasce SEM as três colunas de meia, exatamente como o PDV insere hoje
 * (medido em `server/api/admin/evento/[id]/pdv/venda.post.ts`: o INSERT de
 * `order_items` lista sete colunas e nenhuma delas é `half_*`). É esse buraco
 * que faz o gatilho da migração 015 não ter o que copiar.
 */
let contadorDeVendas = 0
async function venderNoBalcao(tipo: string | null) {
  const codigo = `ZZ-BALCAO-${process.pid}-${++contadorDeVendas}`
  return tx(async (c) => {
    const ord = await c.query(
      `INSERT INTO orders (org_id, event_id, code, status, channel,
                           face_cents, fee_cents, platform_cents, discount_cents, total_cents,
                           payment_method)
       VALUES ($1,$2,$3,'aguardando_pagamento','bilheteria', 500,0,0,0,500,'dinheiro')
       RETURNING id`, [ORG, EVENTO, codigo])
    const orderId = ord.rows[0].id

    await c.query(
      `INSERT INTO order_items (order_id, lot_id, ticket_type_id, quantity,
                                unit_face_cents, unit_fee_cents, unit_total_cents)
       VALUES ($1,$2,$3,1,500,0,500)`, [orderId, LOTE, tipo])

    // `confirmar()` exige reserva em pé — no guichê ela foi feita um instante
    // antes, no mesmo commit. Sem isto a emissão estoura por outro motivo e o
    // teste passaria a provar outra coisa.
    await c.query(`UPDATE lots SET reserved = reserved + 1 WHERE id = $1`, [LOTE])

    const emissao = await emitirNaTransacao(c, orderId)
    const { rows } = await c.query(
      `SELECT code, half_reason, half_document, half_document_required
         FROM tickets WHERE order_id = $1`, [orderId])
    return { emissao, ingressos: rows as any[] }
  })
}

beforeAll(async () => {
  sonda = await sondarServidor()
  anunciarPulo('server/utils/catraca.test.ts', sonda)
  if (!sonda.noAr) return

  // nome e slug também levam a marca: `organizations_slug_key` e o slug do
  // evento são UNIQUE, e `ON CONFLICT (id)` não cobre conflito em OUTRO
  // índice único — foi esse o erro da segunda corrida simultânea.
  for (const [org, nome, slug] of [
    [ORG, `ZZ ENTRADAS CASA ${MARCA_MAIUSCULA}`, `zz-entradas-casa-${MARCA_MINUSCULA}`],
    [ORG_VIZINHA, `ZZ ENTRADAS VIZINHA ${MARCA_MAIUSCULA}`,
     `zz-entradas-vizinha-${MARCA_MINUSCULA}`],
  ] as const) {
    await q(`INSERT INTO organizations (id, name, slug) VALUES ($1,$2,$3)
             ON CONFLICT (id) DO NOTHING`, [org, nome, slug])
  }

  for (const [ev, org, nome, slug] of [
    [EVENTO, ORG, `ZZ ENTRADAS ${MARCA_MAIUSCULA}`, `zz-entradas-ev-${MARCA_MINUSCULA}`],
    [EVENTO_VIZINHO, ORG_VIZINHA, `ZZ ENTRADAS VZ ${MARCA_MAIUSCULA}`,
     `zz-entradas-vz-ev-${MARCA_MINUSCULA}`],
  ] as const) {
    await q(
      `INSERT INTO events (id, org_id, name, slug, starts_at, ends_at, status)
       VALUES ($1,$2,$3,$4, now() - interval '1 hour', now() + interval '8 hours', 'ativo')
       ON CONFLICT (id) DO NOTHING`, [ev, org, nome, slug])
  }

  await q(
    `INSERT INTO event_sessions (id, event_id, starts_at, ends_at, title)
     VALUES ($1,$2, now() - interval '1 hour', now() + interval '8 hours', 'Aberta')
     ON CONFLICT (id) DO NOTHING`, [SESSAO, EVENTO])

  // A sessão de daqui a três semanas: é o estado em que os 23 ingressos de
  // meia do evento semeado desta instalação estão hoje, e o estado em que o
  // cliente pergunta "o que eu preciso levar?" enquanto ainda dá tempo de
  // voltar em casa buscar.
  await q(
    `INSERT INTO event_sessions (id, event_id, starts_at, ends_at, title)
     VALUES ($1,$2, now() + interval '21 days', now() + interval '21 days 8 hours', 'Ainda vem')
     ON CONFLICT (id) DO NOTHING`, [SESSAO_FUTURA, EVENTO])

  // Setor comum (1 pessoa) e setor MESA (4 pessoas por unidade vendida) — é o
  // par que separa "contar leitura" de "contar gente".
  await q(`INSERT INTO sectors (id, event_id, name, admits) VALUES ($1,$2,'ZZ PISTA',1)
           ON CONFLICT (id) DO NOTHING`, [SETOR, EVENTO])
  await q(`INSERT INTO sectors (id, event_id, name, admits) VALUES ($1,$2,'ZZ MESA 4',4)
           ON CONFLICT (id) DO NOTHING`, [SETOR_MESA, EVENTO])
  await q(`INSERT INTO sectors (id, event_id, name, admits) VALUES ($1,$2,'ZZ PISTA VZ',1)
           ON CONFLICT (id) DO NOTHING`, [SETOR_VIZINHO, EVENTO_VIZINHO])

  for (const [lote, setor] of [
    [LOTE, SETOR], [LOTE_MESA, SETOR_MESA], [LOTE_VIZINHO, SETOR_VIZINHO],
  ] as const) {
    await q(`INSERT INTO lots (id, sector_id, name, price_cents, quantity)
             VALUES ($1,$2,'ZZ LOTE', 1000, 500) ON CONFLICT (id) DO NOTHING`, [lote, setor])
  }

  // `kind` é coluna GERADA (db/015): desconto > 0 + exige documento = 'meia'.
  // Semear o tipo em vez de escrever 'meia' à mão é o que garante que o teste
  // usa a mesma regra que o banco de produção aplica.
  await q(
    `INSERT INTO ticket_types (id, lot_id, name, quantity, discount_bps, requires_document)
     VALUES ($1,$2,'Meia-entrada', 200, 5000, true)
     ON CONFLICT (id) DO NOTHING`, [TIPO_MEIA, LOTE])

  // O porteiro de verdade, com o papel de portaria. A senha vem do hash já
  // semeado — o teste não gera hash.
  await q(
    `INSERT INTO users (id, org_id, name, email, password_hash, role, papel)
     SELECT $1, $2, 'Porteiro Fila', $3, password_hash, 'portaria', 'portaria'
       FROM users WHERE email = 'dono@fazendapark.com.br'
     ON CONFLICT (id) DO NOTHING`, [PORTEIRO, ORG, EMAIL_PORTEIRO])

  // E alguém do financeiro, que NÃO é da portaria. `role = 'admin'` de
  // propósito: na grade grossa legada o admin tem portaria, então este usuário
  // só é barrado se a grade FINA estiver de fato sendo consultada pela rota.
  await q(
    `INSERT INTO users (id, org_id, name, email, password_hash, role, papel)
     SELECT $1, $2, 'Financeiro Fila', $3, password_hash, 'admin', 'financeiro'
       FROM users WHERE email = 'dono@fazendapark.com.br'
     ON CONFLICT (id) DO NOTHING`, [FINANCEIRO, ORG, EMAIL_FINANCEIRO])

  const entrar = async (email: string) => {
    const r = await fetch(`${BASE}/api/auth/entrar`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, senha: SENHA }),
    })
    return (r.headers.getSetCookie?.() ?? [])
      .map((c) => c.split(';')[0]).find((c) => c.startsWith('dt_sessao=')) ?? ''
  }
  cookie = await entrar(EMAIL_PORTEIRO)
  cookieFinanceiro = await entrar(EMAIL_FINANCEIRO)
}, 40_000)

afterAll(async () => {
  if (!sonda.noAr) return
  await q(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [[ORG, ORG_VIZINHA]])
  await db().end()
})


describe('fila da portaria offline', () => {
  /**
   * A TRAVA DA FIXTURA DESTA CORRIDA — e por que ela é um caso, não um comentário.
   *
   * Não precisa de servidor: lê o próprio arquivo. A corrida simultânea que
   * expõe o defeito é, por definição, corrida de sorte; o que dá pra travar é a
   * REGRA que a evita. Duas partes, e as duas já falharam de verdade aqui:
   *
   *  1. **nenhum id de fixtura é literal.** Com uuid fixo, duas corridas no
   *     mesmo banco disputam a MESMA linha, e o `afterAll` de uma apaga a
   *     organização que a outra está usando — medido:
   *     `insert or update on table "tickets" violates foreign key constraint
   *     "tickets_org_id_fkey"`, com os 12 casos saindo como "skipped";
   *
   *  2. **nenhum `code` de ingresso é literal.** `tickets.code` é UNIQUE na
   *     tabela inteira: o `ON CONFLICT (code) DO NOTHING` da segunda corrida não
   *     insere nada, calado, e ela passa a ler o ingresso da primeira — de outra
   *     organização, de outro evento. A porta responde `invalido` e a mensagem
   *     fala de assinatura. Este foi o defeito que sobreviveu à primeira rodada
   *     do conserto, justamente porque os literais estavam DENTRO dos casos e
   *     só os do topo tinham sido marcados.
   *
   * Comentário não é conferido: o corpo do arquivo é lido sem comentário pra
   * esta varredura não acusar os parágrafos que explicam o defeito.
   */
  it('a fixtura é da corrida, não do repositório', () => {
    const fonte = readFileSync(new URL(import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((linha) => {
        const barras = linha.search(/(^|[^:])\/\//)
        return barras >= 0 ? linha.slice(0, linha.indexOf('//', barras)) : linha
      })
      .join('\n')

    const uuidsFixos = fonte.match(/'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'/g) ?? []
    expect(uuidsFixos, 'id de fixtura literal: duas corridas disputam a mesma linha')
      .toEqual([])

    const codigosFixos = fonte.match(/'ZZ[A-Z]-[A-Z0-9]+-[A-Z0-9]+'/g) ?? []
    expect(codigosFixos, '`code` literal: `tickets.code` é UNIQUE e a segunda corrida lê o ingresso da primeira')
      .toEqual([])

    // A varredura achou ALGUMA coisa? Sem isto, um dia a regex para de casar e
    // as duas listas ficam vazias afirmando saúde que ninguém conferiu.
    expect(fonte, 'a fixtura parou de carregar a marca da corrida').toContain('MARCA_MAIUSCULA')
    expect(fonte.match(/uuidDaCorrida\(/g)?.length ?? 0,
      'nenhum id sai mais de `uuidDaCorrida` — a marca da corrida sumiu')
      .toBeGreaterThan(0)
  })

  it('o porteiro entrou (senão nada abaixo prova nada)', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    expect(cookie, 'login do porteiro falhou — o teste ficaria verde à toa').toBeTruthy()
  }, 20_000)

  it('a MESMA fila sincronizada duas vezes conta cada pessoa uma vez', async (ctx) => {
    seForaDoArPula(ctx, sonda)

    const a = cod('FILA-AAAA')
    const b = cod('FILA-BBBB')
    await semearIngresso(a)
    await semearIngresso(b)

    const fila = [
      { id: passagemId('01'), qr: montarQr(a, EVENTO), gate: 'NORTE',
        em: new Date(Date.now() - 90 * 60_000).toISOString(), offline: true },
      { id: passagemId('02'), qr: montarQr(b, EVENTO), gate: 'NORTE',
        em: new Date(Date.now() - 80 * 60_000).toISOString(), offline: true },
    ]

    const antes = await livroDoEvento()
    const r1 = await sincronizar({ deviceId: 'TABLET-NORTE', fila })
    expect(r1.status, JSON.stringify(r1.corpo)).toBe(200)
    expect(r1.corpo.resumo.aplicadas).toBe(2)

    const meio = await livroDoEvento()
    expect(meio.linhas - antes.linhas).toBe(2)

    // O reenvio. A rede do parque devolve o mesmo POST mais de uma vez com
    // frequência; é este caso, e não o primeiro, que decide se o número do
    // público presta.
    const r2 = await sincronizar({ deviceId: 'TABLET-NORTE', fila })

    // O banco primeiro, e de propósito: a resposta da rota pode chamar o
    // reenvio de qualquer coisa — o que não pode é existir linha nova.
    const depois = await livroDoEvento()
    expect(depois.linhas,
      `a mesma fila reenviada virou ${depois.linhas - meio.linhas} pessoa(s) a mais`)
      .toBe(meio.linhas)
    expect(depois.pessoas).toBe(meio.pessoas)

    expect(r2.corpo.resumo.aplicadas, 'o reenvio criou entrada nova').toBe(0)
    expect(r2.corpo.resumo.repetidas).toBe(2)

    // e cada ingresso tem UMA passagem, não duas
    expect((await passagensDe(a)).length).toBe(1)
    expect((await passagensDe(b)).length).toBe(1)
  }, 30_000)

  it('id repetido dentro da mesma remessa não vira duas pessoas', async (ctx) => {
    seForaDoArPula(ctx, sonda)

    const c = cod('FILA-CCCC')
    await semearIngresso(c)
    const item = { id: passagemId('03'), qr: montarQr(c, EVENTO), gate: 'NORTE',
                   em: new Date().toISOString(), offline: true }

    const r = await sincronizar({ deviceId: 'TABLET-NORTE', fila: [item, item] })
    expect(r.corpo.resumo.aplicadas).toBe(1)
    expect(r.corpo.resumo.repetidas).toBe(1)
    expect((await passagensDe(c)).length).toBe(1)
  }, 30_000)

  it('dois tablets sem rede deixam o mesmo QR entrar — e o conflito APARECE', async (ctx) => {
    seForaDoArPula(ctx, sonda)

    const d = cod('FILA-DDDD')
    await semearIngresso(d)
    const qr = montarQr(d, EVENTO)
    const h1 = new Date(Date.now() - 60 * 60_000).toISOString()
    const h2 = new Date(Date.now() - 50 * 60_000).toISOString()

    await sincronizar({ deviceId: 'TABLET-NORTE',
      fila: [{ id: passagemId('04'), qr, gate: 'NORTE', em: h1, offline: true }] })
    const r = await sincronizar({ deviceId: 'TABLET-SUL',
      fila: [{ id: passagemId('05'), qr, gate: 'SUL', em: h2, offline: true }] })

    // O ponto que um UNIQUE(ticket_id) — ou um "recusa a segunda" na rota —
    // estragaria: as DUAS passagens continuam no livro. A pessoa passou pela
    // roleta duas vezes; sumir com a segunda deixaria o parque contando menos
    // gente do que tem dentro.
    expect((await passagensDe(d)).length,
      'a segunda passagem foi descartada e o parque conta gente a menos').toBe(2)

    expect(r.corpo.itens[0].resultado,
      'a segunda passagem foi tratada como entrada normal').toBe('conflito')

    const c = r.corpo.conflitos.find((x: any) => x.codigo === d)
    expect(c, 'o mesmo ingresso entrou por dois portões e o conflito não aparece').toBeTruthy()
    expect(c.passagens).toBe(2)
    expect(c.dispositivos).toBe(2)
    expect(c.detalhe.map((x: any) => x.gate).sort()).toEqual(['NORTE', 'SUL'])

    // O carimbo do ingresso continua sendo o da PRIMEIRA passagem.
    const t = await ingresso(d)
    expect(new Date(t.checked_in_at).getTime()).toBe(new Date(h1).getTime())
  }, 30_000)

  it('a hora é a da passagem no tablet, não a da sincronização', async (ctx) => {
    seForaDoArPula(ctx, sonda)

    const e = cod('FILA-EEEE')
    await semearIngresso(e)
    const passou = new Date(Date.now() - 4 * 3600_000).toISOString()

    await sincronizar({ deviceId: 'TABLET-NORTE',
      fila: [{ id: passagemId('06'), qr: montarQr(e, EVENTO), gate: 'NORTE',
               em: passou, offline: true }] })

    const [linha] = await passagensDe(e)
    expect(new Date(linha.entered_at).getTime(),
      'a entrada foi carimbada com a hora em que a rede voltou').toBe(new Date(passou).getTime())
    // a distância entre passar e sincronizar é o tamanho do apagão de rede, e
    // só dá pra medir se as duas horas forem guardadas separadas
    expect(new Date(linha.synced_at).getTime())
      .toBeGreaterThan(new Date(linha.entered_at).getTime())

    const t = await ingresso(e)
    expect(new Date(t.checked_in_at).getTime(),
      'o ingresso ficou com a hora da sincronização').toBe(new Date(passou).getTime())
  }, 30_000)

  it('mesa de 4 conta 4 pessoas, e o número do tablet é ignorado', async (ctx) => {
    seForaDoArPula(ctx, sonda)

    const f = cod('FILA-FFFF')
    await semearIngresso(f, SETOR_MESA, LOTE_MESA)

    const antes = await livroDoEvento()
    const r = await sincronizar({ deviceId: 'TABLET-NORTE', fila: [{
      id: passagemId('07'), qr: montarQr(f, EVENTO), gate: 'NORTE',
      em: new Date().toISOString(), offline: true,
      // o tablet mandando a própria contagem: tem que ser ignorada
      pessoas: 99, people: 99,
    }] })
    expect(r.corpo.resumo.aplicadas).toBe(1)

    const [linha] = await passagensDe(f)
    expect(linha.people, 'a contagem veio do aparelho em vez do setor').toBe(4)

    const depois = await livroDoEvento()
    expect(depois.linhas - antes.linhas, 'uma leitura, uma linha').toBe(1)
    expect(depois.pessoas - antes.pessoas, 'uma mesa de 4 entrou contando 1 pessoa').toBe(4)
  }, 30_000)

  it('ingresso de outra organização não entra no livro pela fila', async (ctx) => {
    seForaDoArPula(ctx, sonda)

    const vz = cod('FILA-VIZI')
    await semearIngresso(vz, SETOR_VIZINHO, LOTE_VIZINHO, ORG_VIZINHA, EVENTO_VIZINHO, null)

    // O porteiro da CASA manda na fila dele um ingresso legítimo da vizinha,
    // com a assinatura certa do evento dela.
    const r = await sincronizar({ deviceId: 'TABLET-NORTE', fila: [{
      id: passagemId('08'), qr: montarQr(vz, EVENTO_VIZINHO), gate: 'NORTE',
      em: new Date().toISOString(), offline: true,
    }] })
    expect(r.corpo.itens[0].resultado).toBe('invalido')
    expect((await passagensDe(vz)).length,
      'a fila de uma produtora gravou entrada de ingresso de outra').toBe(0)
    expect((await ingresso(vz)).status).toBe('valido')
  }, 30_000)

  it('QR fabricado não vira gente no relatório', async (ctx) => {
    seForaDoArPula(ctx, sonda)

    const g = cod('FILA-GGGG')
    await semearIngresso(g)
    const antes = await livroDoEvento()

    const r = await sincronizar({ deviceId: 'TABLET-NORTE', fila: [{
      id: passagemId('09'), qr: `DT1:${EVENTO}:${g}:AAAAAAAAAA`, gate: 'NORTE',
      em: new Date().toISOString(), offline: true,
    }] })
    expect(r.corpo.itens[0].resultado).toBe('invalido')
    expect((await livroDoEvento()).pessoas, 'QR fabricado contou como pessoa').toBe(antes.pessoas)
    expect((await ingresso(g)).status).toBe('valido')
  }, 30_000)

  it('quem não é da portaria não sincroniza fila nenhuma', async (ctx) => {
    seForaDoArPula(ctx, sonda)

    // `role = 'admin'` passa pela grade grossa legada. Se esta rota tivesse
    // nascido sem consultar a grade fina — e ela nasce assim, porque
    // `/api/portaria/*` não cai em nenhum middleware — este POST seria 200.
    const r = await sincronizar({ deviceId: 'X', fila: [] }, cookieFinanceiro)
    expect(r.status, 'o financeiro sincronizou a portaria').toBe(403)
  }, 30_000)

  it('a leitura online também vai pro livro, e a recusa diz por onde a pessoa entrou', async (ctx) => {
    seForaDoArPula(ctx, sonda)

    const h = cod('FILA-HHHH')
    await semearIngresso(h)

    const r1 = await ler(montarQr(h, EVENTO), 'PORTAO-VIP')
    expect(r1.corpo.resultado, JSON.stringify(r1.corpo)).toBe('ok')

    const [linha] = await passagensDe(h)
    expect(linha, 'leitura online não virou linha no livro de entradas').toBeTruthy()
    expect(linha.gate).toBe('PORTAO-VIP')
    expect(linha.offline).toBe(false)
    expect(linha.operator_id).toBe(PORTEIRO)

    // A recusa útil: "já entrou" sem dizer ONDE para a fila com o cliente
    // jurando que não entrou.
    const r2 = await ler(montarQr(h, EVENTO), 'PORTAO-SUL')
    expect(r2.corpo.resultado).toBe('ja_usado')
    expect(r2.corpo.portao, 'a recusa não diz por qual portão a pessoa entrou').toBe('PORTAO-VIP')
    expect(r2.corpo.entrouEm, 'a recusa não diz a hora da entrada').toBeTruthy()

    // e a segunda leitura não criou uma segunda pessoa
    expect((await passagensDe(h)).length).toBe(1)
  }, 30_000)

  /**
   * O recibo que morre no caminho — e é ele que este módulo inteiro existe
   * pra sobreviver.
   *
   * A tela lê ONLINE, o servidor grava a entrada e carimba o ingresso, e a
   * resposta se perde (o 4G do parque cai entre o INSERT e o recibo). A tela
   * não viu nada: decide no aparelho e põe a passagem na fila. Se a fila
   * carregar um id NOVO, o `ON CONFLICT (id)` não dispara e a mesma pessoa
   * entra duas vezes no livro — medido contra o servidor, uma mesa de 4 lida
   * uma vez virou 8 pessoas no público e o cliente apareceu no painel de
   * "entradas repetidas" como suspeito de fraude.
   *
   * O `entradaId` que o dispositivo manda no `/api/checkin` é a defesa, e
   * nenhum teste a exercitava: trocar `entradaId ?? randomUUID()` por
   * `randomUUID()` em `checkin.post.ts` deixava a suíte inteira VERDE.
   */
  it('recibo perdido: a passagem que voltou pela fila não vira uma segunda pessoa', async (ctx) => {
    seForaDoArPula(ctx, sonda)

    const i = cod('FILA-IIII')
    // mesa de 4 de propósito: se o erro voltar, ele volta em quádruplo
    await semearIngresso(i, SETOR_MESA, LOTE_MESA)
    const qr = montarQr(i, EVENTO)
    const idDaPassagem = passagemId('10')

    // 1. a leitura online, com o id que o aparelho criou ANTES de mandar
    const r1 = await fetch(`${BASE}/api/checkin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, origin: BASE },
      body: JSON.stringify({ qr, eventId: EVENTO, gate: 'NORTE',
                             entradaId: idDaPassagem, deviceId: 'TABLET-NORTE' }),
    })
    const c1 = await r1.json().catch(() => ({})) as any
    expect(c1.resultado, JSON.stringify(c1)).toBe('ok')

    const antes = await livroDoEvento()

    // 2. o recibo se perdeu: a MESMA passagem sobe pela fila, com o MESMO id
    const r = await sincronizar({ deviceId: 'TABLET-NORTE', fila: [{
      id: idDaPassagem, qr, gate: 'NORTE',
      em: new Date().toISOString(), offline: true }] })

    // O banco primeiro: a resposta da rota pode chamar isso do que quiser, o
    // que não pode é a mesa entrar de novo.
    const depois = await livroDoEvento()
    expect(depois.pessoas - antes.pessoas,
      `a passagem voltou pela fila e contou ${depois.pessoas - antes.pessoas} pessoa(s) a mais`)
      .toBe(0)
    expect((await passagensDe(i)).length,
      'uma passagem física virou duas linhas no livro').toBe(1)

    expect(r.corpo.itens[0].resultado,
      'a volta pela fila foi tratada como entrada nova').toBe('repetida')
    expect(r.corpo.conflitos.find((x: any) => x.codigo === i),
      'quem passou UMA vez foi parar na lista de entradas repetidas').toBeFalsy()
  }, 30_000)

  /**
   * A cerca de organização mora DENTRO do `SQL_GRAVA_ENTRADA` (`t.org_id =
   * $3`) justamente pra não depender de uma consulta antes que alguém possa
   * esquecer de escrever. Só que a rota de hoje barra o ingresso da vizinha
   * bem antes, pelo evento do QR — então aquele `WHERE` nunca é exercido por
   * ela: arrancá-lo deixava a suíte inteira VERDE.
   *
   * Aqui a instrução compartilhada é chamada na mão, que é o único jeito de
   * travar a cerca onde ela de fato está.
   */
  it('o livro recusa ingresso de outra organização mesmo chamado direto', async (ctx) => {
    seForaDoArPula(ctx, sonda)

    const vz = cod('FILA-CERCA')
    await semearIngresso(vz, SETOR_VIZINHO, LOTE_VIZINHO, ORG_VIZINHA, EVENTO_VIZINHO, null)
    const [t] = await q<any>(`SELECT id FROM tickets WHERE code = $1`, [vz])

    const forasteiro = await q<any>(SQL_GRAVA_ENTRADA,
      [passagemId('11'), t.id, ORG, 'NORTE', 'TABLET-NORTE', PORTEIRO, true, null])
    expect(forasteiro.length,
      'o livro da casa aceitou ingresso de outra organização').toBe(0)

    // O par positivo: sem ele, o teste acima ficaria verde com o SQL quebrado
    // de qualquer outro jeito (coluna errada, JOIN vazio, parâmetro trocado).
    const daCasa = await q<any>(SQL_GRAVA_ENTRADA,
      [passagemId('12'), t.id, ORG_VIZINHA, 'NORTE', 'TABLET-NORTE', null, true, null])
    expect(daCasa.length,
      'o livro recusou o ingresso da própria organização').toBe(1)
  }, 30_000)

  it('o público sai de sum(people): a resposta bate com o banco', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await sincronizar({ deviceId: 'TABLET-NORTE', fila: [] })
    const banco = await livroDoEvento()
    // A rota responde o público do EVENTO; o livro conta o mesmo evento.
    expect(r.corpo.publico.pessoas).toBe(banco.pessoas)
    expect(r.corpo.publico.entradas).toBe(banco.linhas)
    expect(r.corpo.publico.pessoas,
      'o público está contando leitura em vez de pessoa').toBeGreaterThan(banco.linhas)
  }, 30_000)

  /**
   * O relógio do tablet — furo medido em 21/09.
   *
   * O campo `em` era só `z.string().datetime({ offset: true })` e ia direto
   * pro `entries.entered_at` E pro `tickets.checked_in_at`. Um tablet barato
   * que perdeu o NTP no apagão gravava passagem em 1970 ou em 2035, e o
   * gráfico de fila por hora do evento — o que dimensiona quantos portões
   * abrir no ano que vem — ficava com pontos a décadas de distância, pra
   * sempre. Medido contra o servidor antes do conserto: `entered_at` =
   * 1970-01-01, `checked_in_at` = 2035-06-01, `publico.ultima` = 2035.
   *
   * O que NÃO pode acontecer no conserto: descartar a passagem. A pessoa
   * passou pela roleta. O que é recusado é o INSTANTE.
   */
  it('relógio do tablet fora da janela do evento não entra no livro', async (ctx) => {
    seForaDoArPula(ctx, sonda)

    const velho = cod('FILA-RLG1')
    const futuro = cod('FILA-RLG2')
    await semearIngresso(velho)
    await semearIngresso(futuro)

    const antes = await livroDoEvento()
    const agora = Date.now()
    const r = await sincronizar({ deviceId: 'TABLET-SEM-NTP', fila: [
      { id: passagemId('13'), qr: montarQr(velho, EVENTO), gate: 'NORTE',
        em: '1970-01-01T03:00:00.000Z', offline: true },
      { id: passagemId('14'), qr: montarQr(futuro, EVENTO), gate: 'NORTE',
        em: '2035-06-01T12:00:00.000Z', offline: true },
    ] })
    expect(r.status, JSON.stringify(r.corpo)).toBe(200)

    // 1. a pessoa entrou. Recusar a passagem seria apagar quem está dentro.
    expect(r.corpo.resumo.aplicadas, 'a passagem foi descartada por causa do relógio').toBe(2)
    expect((await livroDoEvento()).linhas - antes.linhas).toBe(2)

    // 2. e o instante do aparelho NÃO entrou no livro
    for (const code of [velho, futuro]) {
      const [linha] = await passagensDe(code)
      const t = new Date(linha.entered_at).getTime()
      expect(Math.abs(t - agora),
        `entered_at de ${code} ficou em ${linha.entered_at} — a hora do tablet passou`)
        .toBeLessThan(5 * 60_000)

      const ing = await ingresso(code)
      expect(Math.abs(new Date(ing.checked_in_at).getTime() - agora),
        `checked_in_at de ${code} ficou em ${ing.checked_in_at}`).toBeLessThan(5 * 60_000)
    }

    // 3. nenhuma passagem do evento está no futuro — é este número que o
    //    painel mostra como "última entrada"
    expect(new Date(r.corpo.publico.ultima).getTime(),
      'a última entrada do evento está no futuro').toBeLessThanOrEqual(Date.now() + 60_000)

    // 4. e a divergência APARECE, com a hora que o aparelho mandou. Escondê-la
    //    deixaria o tablet errado a noite inteira sem ninguém saber.
    expect(r.corpo.resumo.relogioTorto, 'o relógio torto não foi relatado').toBe(2)
    expect(r.corpo.relogio, 'a resposta não diz qual aparelho estava com a hora errada').toBeTruthy()
    expect(r.corpo.relogio.dispositivo).toBe('TABLET-SEM-NTP')
    expect(String(r.corpo.relogio.piorEnviado ?? ''),
      'a hora que o aparelho mandou não voltou pra tela').toMatch(/1970|2035/)
    expect(r.corpo.itens[0].relogio?.enviado).toBe('1970-01-01T03:00:00.000Z')
    expect(r.corpo.itens[0].relogio?.motivo).toBeTruthy()
  }, 30_000)

  /**
   * O par positivo da cerca acima, e ele é obrigatório: trocar o `quando` por
   * `null` sempre — ou seja, carimbar tudo com `now()` — faria o teste do
   * relógio torto passar e destruiria a razão de existir da rota (a fila que
   * ficou horas offline). Os dois juntos deixam só um comportamento possível.
   *
   * O teste "a hora é a da passagem no tablet" acima já cobre 4h atrás; este
   * cobre a borda longe: uma fila de ONTEM à noite, dentro da janela do
   * evento, que só subiu agora.
   */
  it('a hora boa do tablet continua passando — a cerca não carimba tudo com now()', async (ctx) => {
    seForaDoArPula(ctx, sonda)

    const j = cod('FILA-RLG3')
    await semearIngresso(j)
    // o evento da fixture abre 1h atrás e fecha em 8h; 50 minutos atrás é uma
    // passagem legítima que o servidor não tem por que reescrever
    const passou = new Date(Date.now() - 50 * 60_000).toISOString()

    const r = await sincronizar({ deviceId: 'TABLET-CERTO', fila: [
      { id: passagemId('15'), qr: montarQr(j, EVENTO), gate: 'NORTE', em: passou, offline: true },
    ] })
    expect(r.corpo.resumo.relogioTorto, 'um relógio certo foi acusado de torto').toBe(0)
    expect(r.corpo.relogio).toBeFalsy()

    const [linha] = await passagensDe(j)
    expect(new Date(linha.entered_at).getTime(),
      'a cerca do relógio reescreveu a hora de uma passagem legítima')
      .toBe(new Date(passou).getTime())
  }, 30_000)

  /**
   * Os três KPIs da tela de validação — furo medido em 21/09 no evento
   * semeado: "Pessoas dentro = 2 (em 2 passagens)" ao lado de "Já entraram = 0
   * (de 392 aptos)" e "Comparecimento = 0%", na mesma tela, ao mesmo tempo.
   *
   * Causa: `entries` (o LIVRO) e `tickets.status` (a TRAVA) contam coisas
   * diferentes, e ninguém reconciliou. A trava volta atrás — cancelamento,
   * transferência, reemissão — e nunca existiu para a passagem retroativa da
   * migração 013. Quem entrou está no livro.
   *
   * Este teste FABRICA a divergência (entrada no livro, ingresso destravado) e
   * exige que o retrato continue contando a pessoa. Voltar o numerador pra
   * `status = 'usado'` deixa o teste vermelho na hora.
   */
  it('o retrato do público conta o livro, não o carimbo do ingresso', async (ctx) => {
    seForaDoArPula(ctx, sonda)

    const k = cod('FILA-KPI1')
    await semearIngresso(k)
    await sincronizar({ deviceId: 'TABLET-NORTE', fila: [
      { id: passagemId('16'), qr: montarQr(k, EVENTO), gate: 'NORTE',
        em: new Date().toISOString(), offline: true },
    ] })

    // O que a migração 013 deixou no evento semeado, reproduzido: a passagem
    // existe no livro e o ingresso não está carimbado.
    await q(`UPDATE tickets SET status = 'valido', checked_in_at = NULL WHERE code = $1`, [k])
    expect((await ingresso(k)).status).toBe('valido')

    const r = await sincronizar({ deviceId: 'TABLET-NORTE', fila: [] })
    const pub = r.corpo.publico

    const [banco] = await q<any>(
      `SELECT count(DISTINCT e.ticket_id)::int AS ingressos,
              COALESCE(sum(e.people),0)::int    AS pessoas,
              (SELECT count(*)::int FROM tickets t
                WHERE t.event_id = $1 AND t.status = 'usado')  AS usados
         FROM entries e WHERE e.event_id = $1`, [EVENTO])

    expect(pub.ingressos,
      '"Já entraram" voltou a sair do carimbo do ingresso em vez do livro')
      .toBe(banco.ingressos)
    expect(pub.ingressos,
      'o teste não fabricou divergência nenhuma — não prova nada')
      .toBeGreaterThan(banco.usados)

    // Numerador e denominador do MESMO retrato: é assim que os três cards
    // param de poder discordar.
    expect(pub.aptos, 'o denominador sumiu do retrato').toBeGreaterThan(0)
    expect(pub.comparecimentoPct)
      .toBe(retratoDoPublico({ ...pub }).comparecimentoPct)
    expect(pub.pessoas).toBe(banco.pessoas)
  }, 30_000)

  /**
   * Meia-entrada na porta — furo medido em 21/09: `/api/checkin` não pedia
   * `half_reason`, `half_document` nem `half_document_required` no SELECT.
   * O dado estava gravado no ingresso desde a migração 015 e o operador lia
   * só o nome do tipo ("Meia-entrada"), sem saber QUAL papel pedir — que é
   * exatamente o problema que aquela migração existe pra resolver.
   */
  it('a portaria lê o que foi carimbado na meia — online e na lista offline', async (ctx) => {
    seForaDoArPula(ctx, sonda)

    const m = cod('FILA-MEIA')
    await semearMeia(m)

    // 1. "só conferir": a pergunta que o operador faz ANTES de deixar entrar
    const consulta = await fetch(`${BASE}/api/checkin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, origin: BASE },
      body: JSON.stringify({ qr: montarQr(m, EVENTO), eventId: EVENTO,
                             gate: 'NORTE', apenasConsultar: true }),
    })
    const c = await consulta.json() as any
    expect(c.resultado, JSON.stringify(c)).toBe('ok')
    // O veredito do ingresso BOM, e ele precisa estar preso aqui: desde que a
    // consulta passou a responder fora do horário, `ok` deixou de ser o
    // literal `true` e virou conta (`!foraDaSessao`). Medido: trocando essa
    // conta por `false`, a suíte INTEIRA seguia verde — e na tela o operador
    // lia "AINDA NÃO" em faixa laranja num ingresso sem defeito nenhum, que é
    // a classe de bug que só aparece olhando.
    expect(c.ok,
      'a consulta de um ingresso bom, dentro do horário, deixou de dizer que ele vale')
      .toBe(true)
    expect(c.mensagem, 'a consulta boa mudou de frase na cara do operador')
      .toBe('Válido (não marcado)')
    expect(c.consulta, 'a resposta parou de se identificar como consulta: a tela decide '
      + 'entre "VÁLIDO" e "PODE ENTRAR" por este campo').toBe(true)
    expect(c.ingresso?.meia, 'a consulta não diz que o ingresso é meia-entrada').toBeTruthy()
    expect(c.ingresso.meia.rotulo).toBe('Estudante')
    expect(c.ingresso.meia.documento,
      'o operador não recebe QUAL documento pedir').toMatch(/Estudantil/i)
    expect(c.ingresso.meia.numero,
      'o número declarado na compra não chegou na porta').toBe('CIE 2026-44120')

    // 2. a validação de verdade leva a mesma informação
    const r = await ler(montarQr(m, EVENTO), 'PORTAO-MEIA')
    expect(r.corpo.resultado, JSON.stringify(r.corpo)).toBe('ok')
    expect(r.corpo.ingresso?.meia?.documento,
      'a validação mostra menos que a consulta').toMatch(/Estudantil/i)

    // 3. e a lista que desce pro tablet também — é no apagão que o operador
    //    mais precisa e menos tem a quem perguntar
    const lista = await sincronizar({ deviceId: 'TABLET-NORTE', fila: [], comLista: true })
    const naLista = lista.corpo.lista?.ingressos?.find((i: any) => i.codigo === m)
    expect(naLista, 'o ingresso sumiu da lista baixada').toBeTruthy()
    expect(naLista.meia?.documento,
      'sem rede o operador volta a não saber qual papel pedir').toMatch(/Estudantil/i)

    // 4. ingresso inteira não ganha bloco de meia — senão a tela pede
    //    documento de todo mundo e o operador para de ler o aviso
    const inteira = cod('FILA-INTE')
    await semearIngresso(inteira)
    const ri = await ler(montarQr(inteira, EVENTO), 'PORTAO-MEIA')
    expect(ri.corpo.ingresso?.meia,
      'ingresso inteira apareceu como meia-entrada').toBeFalsy()
  }, 30_000)

  /**
   * A meia SEM motivo declarado — que é a meia que este banco tem de verdade.
   *
   * O caso acima só cobre o ingresso nascido depois da migração 015, com
   * `half_reason` preenchido. Medido nesta instalação em 21/09, com a consulta
   * já trazendo os três campos: `ticket_types.kind = 'meia'` em 25 ingressos,
   * `half_document_required` preenchido em 25, `half_reason` preenchido em
   * **1**. Nos outros 24 a porta devolvia `meia: null` e a tela mostrava só
   * "Meia-entrada" — a frase exata do defeito que a 015 existe pra matar.
   *
   * Medido na tela antes do conserto, com o leitor aberto e um ingresso desses
   * lido pelo campo: "PODE ENTRAR / Liberado / … · **Meia-entrada**", sem
   * bloco de documento nenhum.
   *
   * São dois caminhos, e os dois precisam aparecer: a meia VELHA (tem o texto
   * congelado do passo 5 da 015) e a do BALCÃO (não tem nem motivo nem texto;
   * só o tipo diz que é meia).
   */
  it('a meia sem motivo — a velha e a do balcão — também diz qual papel pedir', async (ctx) => {
    seForaDoArPula(ctx, sonda)

    const velha = cod('MEIA-VELH')
    const balcao = cod('MEIA-BALC')
    await semearMeiaSemMotivo(velha, 'velha')
    await semearMeiaSemMotivo(balcao, 'balcao')

    // 1. a velha: o texto que a migração 015 carimbou tem que chegar na porta
    const rv = await ler(montarQr(velha, EVENTO), 'PORTAO-MEIA')
    expect(rv.corpo.resultado, JSON.stringify(rv.corpo)).toBe('ok')
    expect(rv.corpo.ingresso?.meia,
      'meia vendida antes da 015 voltou a chegar na porta como ingresso comum')
      .toBeTruthy()
    expect(rv.corpo.ingresso.meia.documento,
      'o texto congelado pela migração 015 morreu na borda da consulta')
      .toMatch(/carteira de estudante/i)
    expect(rv.corpo.ingresso.meia.rotulo,
      'a tela precisa dizer que ninguém declarou o motivo, não inventar um')
      .toBe(MEIA_SEM_MOTIVO)

    // 2. a do balcão: sem motivo e sem texto, sobra a espécie do tipo
    const rb = await ler(montarQr(balcao, EVENTO), 'PORTAO-MEIA')
    expect(rb.corpo.resultado, JSON.stringify(rb.corpo)).toBe('ok')
    expect(rb.corpo.ingresso?.meia,
      'meia de balcão chega na porta sem dizer que é meia').toBeTruthy()
    expect(rb.corpo.ingresso.meia.documento).toBe(DOCUMENTO_GENERICO)

    // 3. e as duas descem na lista do tablet — é no apagão que o operador não
    //    tem a quem perguntar
    const lista = await sincronizar({ deviceId: 'TABLET-NORTE', fila: [], comLista: true })
    for (const [code, trecho] of [[velha, /carteira de estudante/i],
                                  [balcao, /supervisor/i]] as const) {
      const naLista = lista.corpo.lista?.ingressos?.find((i: any) => i.codigo === code)
      expect(naLista, `${code} sumiu da lista baixada`).toBeTruthy()
      expect(naLista.meia?.documento,
        `sem rede, ${code} volta a não dizer qual papel pedir`).toMatch(trecho)
    }
  }, 30_000)

  /**
   * A meia que NASCE hoje no balcão chega na porta dizendo que é meia.
   *
   * ## O que estava errado, medido no banco em 21/09
   *
   * ```
   * SELECT tt.kind, count(*), count(t.half_reason) FROM tickets t
   *   JOIN ticket_types tt ON tt.id = t.ticket_type_id GROUP BY 1;
   *   meia | 23 | 0
   * ```
   *
   * Zero. E não é dívida de linha velha só: `pdv/venda.post.ts` insere
   * `order_items` sem nenhuma coluna `half_*`, o gatilho da 015 copia do item
   * (não tem o que copiar) e a `RAISE` daquela migração é restrita ao canal
   * `online`. Então a meia vendida no guichê HOJE nasce com as três colunas
   * nulas, e a única coisa no banco que sabe que aquele ingresso é meia é
   * `ticket_types.kind` — coluna de outra tabela, que qualquer consulta pode
   * esquecer de trazer. Foi exatamente esse esquecimento que deixou a portaria
   * cega até a frota passada.
   *
   * Este teste prova que o ingresso passa a carregar a exigência no PRÓPRIO
   * corpo, e prova as duas metades que se equilibram:
   *
   *  • a exigência é gravada (≠ NULL), então a porta não depende de JOIN;
   *  • o MOTIVO continua nulo, porque ninguém perguntou. Carimbar "estudante"
   *    aqui deixaria a portaria conferindo o papel errado e apagaria pra sempre
   *    a chance de contar quantos ficaram sem.
   */
  it('a meia do balcão nasce com a exigência carimbada — e sem motivo inventado', async (ctx) => {
    seForaDoArPula(ctx, sonda)

    const { emissao, ingressos } = await venderNoBalcao(TIPO_MEIA)
    expect(emissao.emitiu, JSON.stringify(emissao)).toBe(true)
    expect(ingressos.length).toBe(1)
    const t = ingressos[0]

    expect(t.half_document_required,
      'a meia do balcão nasceu muda: nada no corpo do ingresso diz que há documento a pedir')
      .toBe(EXIGENCIA_SEM_MOTIVO)
    expect(t.half_reason,
      'a emissão inventou um motivo que ninguém declarou — rastro falso é pior que faltando')
      .toBeNull()
    expect(emissao.meiasSemMotivo,
      'a emissão não relatou que saiu meia sem motivo, e o número não chega ao produtor')
      .toBe(1)

    // E a porta lê isso. Sem `tt.kind` na consulta o ingresso continuaria
    // reconhecido, que é o ponto: a prova saiu do JOIN e entrou no ingresso.
    const r = await ler(montarQr(t.code, EVENTO), 'PORTAO-BALCAO')
    expect(r.corpo.resultado, JSON.stringify(r.corpo)).toBe('ok')
    expect(r.corpo.ingresso?.meia?.documento,
      'a exigência carimbada na emissão não chegou na portaria')
      .toBe(EXIGENCIA_SEM_MOTIVO)
    expect(r.corpo.ingresso.meia.motivo,
      'a porta passou a afirmar um motivo que o ingresso não tem').toBeNull()
  }, 30_000)

  /**
   * O contrapeso do teste acima: ingresso que NÃO é meia não pode sair
   * carimbado.
   *
   * Um aviso que aparece em todo mundo é um aviso que o operador aprende a
   * pular — e aí ele pula justamente no ingresso que precisava de conferência.
   * Sem este teste, "carimbar sempre" é implementado como "carimbar tudo" e
   * ninguém percebe até a portaria parar de olhar.
   */
  it('inteira vendida no mesmo guichê não ganha carimbo de documento', async (ctx) => {
    seForaDoArPula(ctx, sonda)

    const { emissao, ingressos } = await venderNoBalcao(null)
    expect(emissao.emitiu, JSON.stringify(emissao)).toBe(true)
    expect(ingressos[0].half_document_required,
      'ingresso sem espécie de meia saiu pedindo documento').toBeNull()
    expect(emissao.meiasSemMotivo).toBe(0)

    const r = await ler(montarQr(ingressos[0].code, EVENTO), 'PORTAO-BALCAO')
    expect(r.corpo.ingresso?.meia,
      'inteira apareceu na porta como meia-entrada').toBeFalsy()
  }, 30_000)

  /**
   * "Só conferir" responde mesmo fora do horário da sessão.
   *
   * Medido antes do conserto, nesta instalação: os 23 ingressos de meia do
   * evento semeado estão numa sessão que abre em outubro, e
   * `POST /api/checkin {apenasConsultar:true}` em qualquer um deles devolvia
   * `{resultado:'fora_da_sessao', mensagem:'Fora do horário desta sessão'}` e
   * mais nada — sem titular, sem setor, sem o bloco de meia. O operador
   * pergunta "o que este cliente precisa trazer?" e recebe silêncio.
   *
   * É a pior hora possível pra receber silêncio: quem chega cedo é justamente
   * quem ainda tem tempo de ir buscar a carteira de estudante em casa. A
   * consulta não marca nada e não registra leitura — recusar a RESPOSTA não
   * protege coisa nenhuma.
   *
   * O que ela não pode é mentir: o veredito segue negativo. As duas coisas
   * juntas são a prova — dados presentes E `ok: false`.
   */
  it('"só conferir" fora do horário responde o que pedir, sem dizer que pode entrar', async (ctx) => {
    seForaDoArPula(ctx, sonda)

    // um ingresso de meia na sessão que só abre daqui a três semanas
    const cedo = cod('MEIA-CEDO')
    await q(
      `INSERT INTO tickets (org_id, event_id, session_id, sector_id, lot_id,
                            ticket_type_id, code, qr_secret, status, holder_name,
                            half_document_required)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'teste','valido','Chegou Cedo',$8)
       ON CONFLICT (code) DO NOTHING`,
      [ORG, EVENTO, SESSAO_FUTURA, SETOR, LOTE, TIPO_MEIA, cedo, EXIGENCIA_SEM_MOTIVO])

    const r = await fetch(`${BASE}/api/checkin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, origin: BASE },
      body: JSON.stringify({ qr: montarQr(cedo, EVENTO), eventId: EVENTO,
                             gate: 'NORTE', apenasConsultar: true }),
    })
    const c = await r.json() as any

    expect(c.ingresso,
      'a consulta fora do horário voltou vazia — o operador recebeu silêncio')
      .toBeTruthy()
    expect(c.ingresso.meia?.documento,
      'o cliente que chegou cedo não descobriu qual papel precisa trazer')
      .toBe(EXIGENCIA_SEM_MOTIVO)
    expect(c.ok,
      'a consulta disse que pode entrar fora do horário da sessão').toBe(false)
    expect(c.resultado).toBe('fora_da_sessao')
    expect(c.consulta, 'a consulta deixou de se identificar como consulta').toBe(true)

    // E o ingresso NÃO foi queimado: consulta não marca.
    const depois = await ingresso(cedo)
    expect(depois.status,
      '"só conferir" marcou entrada — o ingresso foi queimado antes da hora')
      .toBe('valido')

    // A validação de verdade continua barrando, e continua registrando.
    const real = await ler(montarQr(cedo, EVENTO), 'PORTAO-CEDO')
    expect(real.corpo.resultado,
      'o conserto da consulta abriu a porta fora do horário').toBe('fora_da_sessao')
    expect((await ingresso(cedo)).status).toBe('valido')
  }, 30_000)

  /**
   * A faixa do relógio torto descreve UMA passagem — e tem que ser a mesma nas
   * três partes.
   *
   * O motivo saía de `tortos[0]` e a hora do PIOR. Numa remessa com um item no
   * futuro seguido de um em 1970, a tela escrevia "este aparelho marcou a
   * passagem no futuro — a pior marcava 01/01/1970, 00:00": a frase não fecha,
   * e o operador manda acertar a coisa errada.
   */
  it('a faixa do relógio descreve a MESMA passagem no motivo e na hora', async (ctx) => {
    seForaDoArPula(ctx, sonda)

    const f = cod('FILA-RLG4')
    const g = cod('FILA-RLG5')
    await semearIngresso(f)
    await semearIngresso(g)

    // ordem de propósito: o FUTURO primeiro, o pior (1970) depois
    const r = await sincronizar({ deviceId: 'TABLET-MISTO', fila: [
      { id: passagemId('17'), qr: montarQr(f, EVENTO), gate: 'NORTE',
        em: '2035-06-01T12:00:00.000Z', offline: true },
      { id: passagemId('18'), qr: montarQr(g, EVENTO), gate: 'NORTE',
        em: '1970-01-01T03:00:00.000Z', offline: true },
    ] })

    expect(r.corpo.resumo.relogioTorto).toBe(2)
    expect(r.corpo.relogio.piorEnviado).toBe('1970-01-01T03:00:00.000Z')
    expect(r.corpo.relogio.motivo,
      'a faixa diz um motivo e mostra a hora de outra passagem')
      .toBe('este aparelho marcou a passagem fora do período do evento')
  }, 30_000)
})

describe('meiaDoIngresso (sem banco)', () => {
  it('a meia velha mostra o texto congelado, e diz que o motivo não veio', () => {
    // exatamente a linha que a migração 015 deixou: texto sim, motivo não
    const m = meiaDoIngresso({
      half_reason: null, half_document: null, especie: 'meia',
      half_document_required: 'Documento que comprove o direito à meia-entrada',
    })
    expect(m, 'meia anterior à 015 voltou a ser tratada como ingresso comum').toBeTruthy()
    expect(m!.rotulo).toBe(MEIA_SEM_MOTIVO)
    expect(m!.documento).toBe('Documento que comprove o direito à meia-entrada')
    expect(m!.motivo).toBeNull()
  })

  it('a meia do balcão, sem motivo E sem texto, ainda pede documento', () => {
    const m = meiaDoIngresso({ especie: 'meia' })
    expect(m, 'meia de balcão chega na porta como inteira').toBeTruthy()
    expect(m!.documento).toBe(DOCUMENTO_GENERICO)
  })

  it('o motivo declarado tem rótulo próprio, e o texto congelado vence a tabela', () => {
    const m = meiaDoIngresso({
      half_reason: 'idoso', half_document: null, especie: 'meia',
      half_document_required: 'Certidão de nascimento — texto da época da compra',
    })
    expect(m!.rotulo).toBe('Idoso (60 anos ou mais)')
    expect(m!.documento, 'a lei mudou e a tela deixou de mostrar o que foi prometido')
      .toBe('Certidão de nascimento — texto da época da compra')
  })

  it('inteira e gratuito não ganham bloco — senão o operador para de ler o aviso', () => {
    expect(meiaDoIngresso({ especie: 'inteira' })).toBeNull()
    expect(meiaDoIngresso({ especie: 'gratuito' })).toBeNull()
    expect(meiaDoIngresso({}), 'ingresso sem tipo virou meia').toBeNull()
    expect(meiaDoIngresso(null)).toBeNull()
  })
})

/**
 * A régua que decide o que fica congelado no ingresso de meia.
 *
 * Mora aqui, no arquivo da portaria, porque é a portaria que sofre quando ela
 * erra: o operador com fila na frente lendo um ingresso que não diz qual papel
 * pedir é o sintoma, e a emissão é a causa.
 */
describe('exigenciaDeMeia (sem banco)', () => {
  it('o texto congelado na compra vence tudo — foi o que foi prometido', () => {
    expect(exigenciaDeMeia({
      especie: 'meia', motivoDaMeia: 'idoso',
      exigenciaCongelada: 'Certidão de nascimento — redação da época da compra',
    })).toBe('Certidão de nascimento — redação da época da compra')
  })

  it('com motivo e sem texto, o texto sai da tabela de motivos', () => {
    expect(exigenciaDeMeia({ especie: 'meia', motivoDaMeia: 'estudante' }))
      .toBe(documentoExigido('estudante'))
  })

  it('sem motivo nenhum, o carimbo é explícito — e explícito não é NULL', () => {
    const sem = exigenciaDeMeia({ especie: 'meia' })
    expect(sem, 'a meia sem motivo voltou a nascer muda').toBe(EXIGENCIA_SEM_MOTIVO)
    expect(sem).not.toBeNull()
  })

  it('motivo fora da lista não vira texto inventado', () => {
    // dado velho, importação, rota de fora: o vocabulário é fechado por lei
    // (db/015 e utils/meia-entrada.ts). Traduzir um motivo desconhecido seria
    // mandar o operador pedir um papel que ninguém prometeu.
    expect(exigenciaDeMeia({ especie: 'meia', motivoDaMeia: 'amigo_do_dono' }))
      .toBe(EXIGENCIA_SEM_MOTIVO)
  })

  it('inteira e gratuidade não ganham exigência — aviso em todo mundo ninguém lê', () => {
    expect(exigenciaDeMeia({ especie: 'inteira', motivoDaMeia: 'estudante' })).toBeNull()
    expect(exigenciaDeMeia({ especie: 'gratuito' })).toBeNull()
    // lote sem variação vende com `ticket_type_id` nulo: sem espécie, sem meia
    expect(exigenciaDeMeia({ especie: null })).toBeNull()
    expect(exigenciaDeMeia({})).toBeNull()
  })
})

describe('normalizarFila (sem banco)', () => {
  const item = (id: string, qr = 'X') => ({ id, qr })

  it('tira o id repetido e mantém a PRIMEIRA ocorrência', () => {
    const { fila, repetidasNoEnvio } = normalizarFila([
      item('a', 'primeiro'), item('b'), item('a', 'segundo'),
    ])
    expect(fila.length).toBe(2)
    expect(fila[0].qr).toBe('primeiro')
    expect(repetidasNoEnvio).toBe(1)
  })

  it('fila limpa passa inteira', () => {
    const { fila, repetidasNoEnvio } = normalizarFila([item('a'), item('b'), item('c')])
    expect(fila.length).toBe(3)
    expect(repetidasNoEnvio).toBe(0)
  })
})

describe('conferirRelogio (sem banco)', () => {
  // um evento noturno de 8h, a forma do parque
  const evento = {
    starts_at: '2026-09-21T19:00:00.000Z',
    ends_at: '2026-09-22T03:00:00.000Z',
  }
  /** a rede voltou de manhã e o tablet só então conseguiu subir a fila */
  const manha = new Date('2026-09-22T12:00:00.000Z')
  /** e o instante em que a porta está de fato funcionando */
  const durante = new Date('2026-09-21T23:00:00.000Z')

  it('sem hora enviada, o servidor carimba', () => {
    const r = conferirRelogio(null, evento, manha)
    expect(r.torto).toBe(false)
    // `em: null` é o que faz o COALESCE do insert usar now()
    expect(r.em).toBeNull()
  })

  it('a fila que passou a noite offline, dentro do evento, é aceita', () => {
    // passou às 22h30 (hora local do evento), sincronizou 10h depois
    const r = conferirRelogio('2026-09-22T01:30:00.000Z', evento, manha)
    expect(r.torto, 'a cerca recusou a fila offline — o motivo da rota existir').toBe(false)
    expect(r.em).toBe('2026-09-22T01:30:00.000Z')
  })

  it('1970 é recusado e a hora enviada volta pra tela', () => {
    const r = conferirRelogio('1970-01-01T03:00:00.000Z', evento, manha)
    expect(r.torto).toBe(true)
    expect(r.motivo).toBe('fora_do_evento')
    expect(r.em, 'a hora de 1970 foi pro livro').toBeNull()
    expect(r.enviado, 'o que o aparelho mandou sumiu da resposta')
      .toBe('1970-01-01T03:00:00.000Z')
  })

  it('passagem no futuro é recusada — ninguém entra depois de agora', () => {
    const r = conferirRelogio('2035-06-01T12:00:00.000Z', evento, manha)
    expect(r.torto).toBe(true)
    expect(r.motivo).toBe('futuro')
    expect(r.em).toBeNull()
  })

  it('adiantamento de poucos minutos passa: relógio de tablet nunca bate exato', () => {
    const r = conferirRelogio('2026-09-21T23:03:00.000Z', evento, durante)
    expect(r.torto, 'três minutos de diferença viraram alarme').toBe(false)
  })

  it('teste de portão semanas antes da abertura não vira alarme', () => {
    // a passagem é AGORA; o evento é que está longe. O aparelho está certo.
    const longe = { starts_at: '2026-12-01T19:00:00.000Z', ends_at: '2026-12-02T03:00:00.000Z' }
    expect(conferirRelogio(manha.toISOString(), longe, manha).torto).toBe(false)
  })

  it('data ilegível não derruba a passagem, só a hora', () => {
    const r = conferirRelogio('ontem de tarde', evento, manha)
    expect(r.torto).toBe(true)
    expect(r.motivo).toBe('formato')
    expect(r.em).toBeNull()
  })
})

describe('retratoDoPublico (sem banco)', () => {
  it('o comparecimento divide INGRESSO por ingresso, não pessoa por ingresso', () => {
    // mesa de 4: 1 ingresso, 4 pessoas. Dividir pessoas por aptos passaria de
    // 100% em qualquer evento com mesa.
    const r = retratoDoPublico({ entradas: 1, pessoas: 4, ingressos: 1, offline: 0, aptos: 4 })
    expect(r.comparecimentoPct).toBe(25)
  })

  it('2 de 442 não vira "0%" ao lado de "2 entraram"', () => {
    const r = retratoDoPublico({ entradas: 2, pessoas: 2, ingressos: 2, offline: 0, aptos: 442 })
    expect(r.comparecimentoPct,
      'o arredondamento zerou um comparecimento que existe').toBe(0.5)
  })

  it('parque vazio é 0% mesmo, e evento sem ingresso apto não divide por zero', () => {
    expect(retratoDoPublico({ ingressos: 0, aptos: 442 }).comparecimentoPct).toBe(0)
    expect(retratoDoPublico({ ingressos: 0, aptos: 0 }).comparecimentoPct).toBe(0)
  })

  it('acima de 10% o número é inteiro — casa decimal ali é ruído', () => {
    expect(retratoDoPublico({ ingressos: 137, aptos: 442 }).comparecimentoPct).toBe(31)
  })
})

/* ===========================================================================
 * A faixa da meia sem motivo, e a marca de lista cortada que ela precisa
 * ======================================================================== */

/**
 * A contagem que o leitor de entrada mostra pro produtor ("N de M meias deste
 * evento sem motivo registrado") sai da LISTA baixada pelo tablet. Quando o
 * servidor corta essa lista no teto (20 mil ingressos), a contagem cobre um
 * pedaço do evento e a faixa tem que DIZER isso.
 *
 * ## O defeito, medido
 *
 * A marca do corte morava só em memória (`const listaTruncada = ref(false)`).
 * `onMounted` restaurava a lista do `localStorage` — `{ em, ingressos }` — e
 * mais nada, então depois de um F5 a marca voltava `false` com a lista cortada
 * intacta na tela. Rodando o que a tela faz, linha por linha:
 *
 *     baixou (truncada: true) -> parcial = true
 *     reabriu                 -> parcial = false   <-- a faixa mente
 *
 * E o F5 não é hipótese aqui: este leitor é a única tela do sistema feita pra
 * **reabrir sem rede** (service worker + lista no `localStorage`). Reaberta
 * offline, `sincronizar()` não roda e nada redescobre o corte — a faixa passa
 * a apresentar um número parcial como se fosse o do evento inteiro, que é
 * exatamente o que o comentário dela diz que ela existe pra não fazer.
 *
 * ## Por que o teste lê o fonte
 *
 * A trava é a gravação e a leitura andarem JUNTAS: uma gravação de
 * `CHAVE_LISTA` que esqueça `truncada` desfaz o conserto sozinha, mesmo com o
 * resto no lugar. O que este caso prende é que existe UM caminho de gravação
 * (`guardarLista`) e que ele carrega a marca — e que a montagem a lê de volta.
 * Montar a página inteira aqui exigiria `useRoute`, `$fetch`, service worker e
 * `navigator.onLine` de mentira, e o que sobraria provado seria o dublê.
 */
describe('leitor de entrada — a marca de lista cortada sobrevive ao F5', () => {
  const TELA = join(import.meta.dirname, '../../app/pages/admin/evento/[id]/validacao/index.vue')
  const fonte = () => readFileSync(TELA, 'utf8')

  it('a lista só é gravada por um caminho, e ele carrega a marca do corte', () => {
    const tela = fonte()

    // A varredura acha alguma coisa? Sem isto, a tela pode ter sido renomeada
    // e os dois casos abaixo passariam afirmando saúde que ninguém conferiu.
    expect(tela, 'a faixa da meia sem motivo sumiu da tela')
      .toContain('meia(s)-entrada(s) deste evento sem motivo registrado')
    expect(tela, 'a faixa parou de perguntar se a contagem está parcial')
      .toContain('meiasDoEvento.parcial')

    const gravacoes = tela.match(/guardar\(CHAVE_LISTA,/g) ?? []
    expect(gravacoes.length,
      'a lista voltou a ser gravada em mais de um lugar: a gravação que esquecer '
      + '`truncada` apaga a marca do corte sozinha')
      .toBe(1)

    const guardarLista = tela.slice(tela.indexOf('function guardarLista()'))
      .slice(0, tela.slice(tela.indexOf('function guardarLista()')).indexOf('\n}') + 2)
    expect(guardarLista,
      'a gravação da lista não leva a marca do corte: depois do F5 a faixa '
      + 'apresenta uma contagem parcial como se fosse a do evento inteiro')
      .toContain('truncada: listaTruncada.value')
  })

  /**
   * Os dois casos da meia não podem voltar a ser a mesma tela.
   *
   * O defeito original: com motivo e sem motivo renderizavam idênticos — mesmo
   * título de 24px, mesmo rótulo auxiliar em cinza — e a ausência de motivo
   * aparecia só como um texto ocupando o lugar do motivo. Com o tablet na mão e
   * sol batendo, o operador não repara.
   *
   * O que prende aqui é a DIFERENÇA: o bloco sem motivo tem borda de alerta e
   * título maior, e diz o que pedir. Colapsar os dois num `v-if` só (que é o
   * jeito natural de "simplificar" isto) fica vermelho.
   *
   * As medidas vêm do CSS compilado, não de fé: `text-3xl` = 1,875rem = 30px,
   * `border-4` = 4px e `border-alerta` = rgb(178 106 0) — conferidos em
   * `.output/public/_nuxt/entry.*.css` depois do `npm run build`. Classe que
   * não existe não gera nada, e `app/composables/telas.test.ts` varre isso pra
   * todas as telas.
   */
  it('a meia sem motivo é um bloco de natureza diferente, não o mesmo com outro texto', () => {
    const tela = fonte()

    expect(tela, 'o bloco da meia COM motivo sumiu')
      .toContain('v-if="ultima.ingresso?.meia?.motivo"')
    expect(tela, 'os dois casos da meia voltaram a ser o mesmo bloco: sem motivo declarado '
      + 'o operador lê a mesma tela de sempre e libera por reflexo')
      .toContain('v-else-if="ultima.ingresso?.meia"')

    const semMotivo = tela.slice(tela.indexOf('v-else-if="ultima.ingresso?.meia"'))
    const bloco = semMotivo.slice(0, semMotivo.indexOf('</div>'))

    expect(bloco, 'o aviso da meia sem motivo perdeu a borda de alerta').toContain('border-4')
    expect(bloco, 'a borda do aviso ficou sem cor de alerta').toContain('border-alerta')
    expect(bloco, 'o título do aviso encolheu pro tamanho do bloco comum').toContain('text-3xl')
    expect(bloco, 'o aviso parou de dizer com todas as letras que não há motivo registrado')
      .toContain('MEIA-ENTRADA SEM MOTIVO REGISTRADO')
    expect(bloco, 'o operador voltou a não saber QUAL papel pedir quando não há motivo')
      .toMatch(/estudante, idoso \(60\+\), PCD, ID Jovem ou professor/)
  })

  it('a montagem lê a marca de volta — senão gravar não adianta', () => {
    const tela = fonte()
    const montagem = tela.slice(tela.indexOf('onMounted('), tela.indexOf('await registrarWorker'))

    expect(montagem,
      'a montagem restaura a lista guardada mas não a marca de corte dela: o tablet '
      + 'que reabriu sem rede conta meia de um pedaço do evento e chama de total')
      .toContain('listaTruncada.value = Boolean(guardada.truncada)')
  })
})
