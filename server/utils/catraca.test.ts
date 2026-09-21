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
 * Fixture própria, ids fixos, `DELETE` no fim. Nada do evento semeado é
 * tocado. Sem servidor de dev no ar, PULA em vez de falhar.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { db, q } from './db'
import { montarQr } from './ingresso'
import {
  conferirRelogio, DOCUMENTO_GENERICO, MEIA_SEM_MOTIVO, meiaDoIngresso,
  normalizarFila, retratoDoPublico, SQL_GRAVA_ENTRADA,
} from './catraca'

const BASE = process.env.BASE_TESTE ?? 'http://localhost:3100'

/* ids fixos, prefixo próprio desta suíte: o teste limpa exatamente o que criou */
const ORG = '0000e013-0000-4000-8000-000000000001'
const PORTEIRO = '0000e013-0000-4000-8000-000000000002'
const EVENTO = '0000e013-0000-4000-8000-000000000003'
const SESSAO = '0000e013-0000-4000-8000-000000000004'
const SETOR = '0000e013-0000-4000-8000-000000000006'
const LOTE = '0000e013-0000-4000-8000-000000000007'
const SETOR_MESA = '0000e013-0000-4000-8000-000000000008'
const LOTE_MESA = '0000e013-0000-4000-8000-000000000009'
const FINANCEIRO = '0000e013-0000-4000-8000-00000000000a'
/** tipo de ingresso com `kind = 'meia'` (coluna gerada: desconto + documento) */
const TIPO_MEIA = '0000e013-0000-4000-8000-00000000000b'

const ORG_VIZINHA = '0000e014-0000-4000-8000-000000000001'
const EVENTO_VIZINHO = '0000e014-0000-4000-8000-000000000003'
const SETOR_VIZINHO = '0000e014-0000-4000-8000-000000000006'
const LOTE_VIZINHO = '0000e014-0000-4000-8000-000000000007'

const EMAIL_PORTEIRO = 'porteiro.fila@entradas.invalido'
const EMAIL_FINANCEIRO = 'financeiro.fila@entradas.invalido'
const SENHA = 'diamond123'

/** um uuid por passagem, como o tablet faria */
const passagemId = (n: string) => `0000f113-0000-4000-8000-0000000000${n}`

let noAr = false
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

beforeAll(async () => {
  try {
    noAr = (await fetch(`${BASE}/api/auth/eu`, { signal: AbortSignal.timeout(2500) })).status < 500
  } catch { noAr = false }
  if (!noAr) return

  for (const [org, nome, slug] of [
    [ORG, 'ZZ ENTRADAS CASA', 'zz-entradas-casa'],
    [ORG_VIZINHA, 'ZZ ENTRADAS VIZINHA', 'zz-entradas-vizinha'],
  ] as const) {
    await q(`INSERT INTO organizations (id, name, slug) VALUES ($1,$2,$3)
             ON CONFLICT (id) DO NOTHING`, [org, nome, slug])
  }

  for (const [ev, org, nome, slug] of [
    [EVENTO, ORG, 'ZZ ENTRADAS', 'zz-entradas-ev'],
    [EVENTO_VIZINHO, ORG_VIZINHA, 'ZZ ENTRADAS VZ', 'zz-entradas-vz-ev'],
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
  if (!noAr) return
  await q(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [[ORG, ORG_VIZINHA]])
  await db().end()
})

const pulado = () => void console.warn('  (pulado: servidor fora do ar)')

describe('fila da portaria offline', () => {
  it('o porteiro entrou (senão nada abaixo prova nada)', async () => {
    if (!noAr) return pulado()
    expect(cookie, 'login do porteiro falhou — o teste ficaria verde à toa').toBeTruthy()
  }, 20_000)

  it('a MESMA fila sincronizada duas vezes conta cada pessoa uma vez', async () => {
    if (!noAr) return pulado()

    const a = 'ZZE-FILA-AAAA'
    const b = 'ZZE-FILA-BBBB'
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

  it('id repetido dentro da mesma remessa não vira duas pessoas', async () => {
    if (!noAr) return pulado()

    const c = 'ZZE-FILA-CCCC'
    await semearIngresso(c)
    const item = { id: passagemId('03'), qr: montarQr(c, EVENTO), gate: 'NORTE',
                   em: new Date().toISOString(), offline: true }

    const r = await sincronizar({ deviceId: 'TABLET-NORTE', fila: [item, item] })
    expect(r.corpo.resumo.aplicadas).toBe(1)
    expect(r.corpo.resumo.repetidas).toBe(1)
    expect((await passagensDe(c)).length).toBe(1)
  }, 30_000)

  it('dois tablets sem rede deixam o mesmo QR entrar — e o conflito APARECE', async () => {
    if (!noAr) return pulado()

    const d = 'ZZE-FILA-DDDD'
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

  it('a hora é a da passagem no tablet, não a da sincronização', async () => {
    if (!noAr) return pulado()

    const e = 'ZZE-FILA-EEEE'
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

  it('mesa de 4 conta 4 pessoas, e o número do tablet é ignorado', async () => {
    if (!noAr) return pulado()

    const f = 'ZZE-FILA-FFFF'
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

  it('ingresso de outra organização não entra no livro pela fila', async () => {
    if (!noAr) return pulado()

    const vz = 'ZZE-FILA-VIZI'
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

  it('QR fabricado não vira gente no relatório', async () => {
    if (!noAr) return pulado()

    const g = 'ZZE-FILA-GGGG'
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

  it('quem não é da portaria não sincroniza fila nenhuma', async () => {
    if (!noAr) return pulado()

    // `role = 'admin'` passa pela grade grossa legada. Se esta rota tivesse
    // nascido sem consultar a grade fina — e ela nasce assim, porque
    // `/api/portaria/*` não cai em nenhum middleware — este POST seria 200.
    const r = await sincronizar({ deviceId: 'X', fila: [] }, cookieFinanceiro)
    expect(r.status, 'o financeiro sincronizou a portaria').toBe(403)
  }, 30_000)

  it('a leitura online também vai pro livro, e a recusa diz por onde a pessoa entrou', async () => {
    if (!noAr) return pulado()

    const h = 'ZZE-FILA-HHHH'
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
  it('recibo perdido: a passagem que voltou pela fila não vira uma segunda pessoa', async () => {
    if (!noAr) return pulado()

    const i = 'ZZE-FILA-IIII'
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
  it('o livro recusa ingresso de outra organização mesmo chamado direto', async () => {
    if (!noAr) return pulado()

    const vz = 'ZZE-FILA-CERCA'
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

  it('o público sai de sum(people): a resposta bate com o banco', async () => {
    if (!noAr) return pulado()
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
  it('relógio do tablet fora da janela do evento não entra no livro', async () => {
    if (!noAr) return pulado()

    const velho = 'ZZE-FILA-RLG1'
    const futuro = 'ZZE-FILA-RLG2'
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
  it('a hora boa do tablet continua passando — a cerca não carimba tudo com now()', async () => {
    if (!noAr) return pulado()

    const j = 'ZZE-FILA-RLG3'
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
  it('o retrato do público conta o livro, não o carimbo do ingresso', async () => {
    if (!noAr) return pulado()

    const k = 'ZZE-FILA-KPI1'
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
  it('a portaria lê o que foi carimbado na meia — online e na lista offline', async () => {
    if (!noAr) return pulado()

    const m = 'ZZE-FILA-MEIA'
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
    const inteira = 'ZZE-FILA-INTE'
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
  it('a meia sem motivo — a velha e a do balcão — também diz qual papel pedir', async () => {
    if (!noAr) return pulado()

    const velha = 'ZZE-MEIA-VELH'
    const balcao = 'ZZE-MEIA-BALC'
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
   * A faixa do relógio torto descreve UMA passagem — e tem que ser a mesma nas
   * três partes.
   *
   * O motivo saía de `tortos[0]` e a hora do PIOR. Numa remessa com um item no
   * futuro seguido de um em 1970, a tela escrevia "este aparelho marcou a
   * passagem no futuro — a pior marcava 01/01/1970, 00:00": a frase não fecha,
   * e o operador manda acertar a coisa errada.
   */
  it('a faixa do relógio descreve a MESMA passagem no motivo e na hora', async () => {
    if (!noAr) return pulado()

    const f = 'ZZE-FILA-RLG4'
    const g = 'ZZE-FILA-RLG5'
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
