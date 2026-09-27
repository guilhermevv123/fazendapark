/**
 * A chave do QR com `kid` (PROD-03, 27/09).
 *
 * O que este arquivo trava, e por quê:
 *
 *  1. **O DT1 já vendido continua entrando.** Os dois vetores abaixo foram
 *     gerados pela implementação ANTIGA (`NUXT_SESSION_SECRET` direto no HMAC),
 *     antes da troca. Se a conta do DT1 mudar um byte, todo ingresso vendido
 *     vira "Ingresso inválido" na catraca — e o teste fica vermelho aqui, não no
 *     portão do parque.
 *  2. **Trocar de chave não mata o que foi vendido** — o `kid` diz qual chave
 *     confere, e a antiga só sai da lista quando o dono tirar.
 *  3. **Assinatura trocada e kid desconhecido falham**, e o segundo sai marcado
 *     como chave aposentada (não como fabricação).
 *  4. **O estado da configuração nunca carrega o segredo.**
 *
 * Função pura: não precisa de servidor nem de banco. O ambiente é trocado caso
 * a caso e devolvido no fim.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { estadoDasChavesDeIngresso, lerQr, montarQr } from './ingresso'

const SEGREDO_ANTIGO = 'segredo-antigo-da-sessao-com-folga'
const EVENTO = '3cd875a0-e230-448a-892b-d4cc840b1948'
/** gerados em 27/09 pela implementação anterior, com SEGREDO_ANTIGO */
const DT1_VENDIDO = `DT1:${EVENTO}:CON-7F3K-92AB:ABRYZ5M6QJ`
const DT1_VENDIDO_2 = 'DT1:00000000-0000-4000-8000-000000000001:ING-AAAA-BBBB:ZACPEU29W9'

/** 32 bytes em base64 — duas chaves diferentes */
const CHAVE_A = Buffer.alloc(32, 7).toString('base64')
const CHAVE_B = Buffer.alloc(32, 9).toString('base64')

const VARIAVEIS = ['TICKET_KEYS', 'TICKET_KEY_LEGADO_DT1', 'NUXT_SESSION_SECRET'] as const
let guardado: Record<string, string | undefined> = {}

beforeEach(() => {
  guardado = Object.fromEntries(VARIAVEIS.map((v) => [v, process.env[v]]))
  for (const v of VARIAVEIS) delete process.env[v]
})
afterEach(() => {
  for (const v of VARIAVEIS) {
    if (guardado[v] === undefined) delete process.env[v]
    else process.env[v] = guardado[v]
  }
})

describe('QR · o ingresso DT1 já vendido', () => {
  it('passa com a chave antiga — e continua passando depois de ligar TICKET_KEYS', () => {
    process.env.NUXT_SESSION_SECRET = SEGREDO_ANTIGO
    expect(lerQr(DT1_VENDIDO)).toMatchObject({ ok: true, eventId: EVENTO, code: 'CON-7F3K-92AB' })
    expect(lerQr(DT1_VENDIDO_2).ok).toBe(true)

    process.env.TICKET_KEYS = `k1:${CHAVE_A}`
    expect(lerQr(DT1_VENDIDO).ok,
      'ligar a chave nova matou o QR que já estava no e-mail do comprador').toBe(true)
  })

  it('sem TICKET_KEYS a casa emite o DT1 de sempre, byte a byte', () => {
    process.env.NUXT_SESSION_SECRET = SEGREDO_ANTIGO
    expect(montarQr('CON-7F3K-92AB', EVENTO),
      'a conta do DT1 mudou: todo ingresso vendido viraria inválido').toBe(DT1_VENDIDO)
  })

  it('trocar NUXT_SESSION_SECRET não mata o DT1 quando TICKET_KEY_LEGADO_DT1 guarda a antiga', () => {
    process.env.NUXT_SESSION_SECRET = 'outro-segredo-novinho-de-sessao'
    process.env.TICKET_KEY_LEGADO_DT1 = SEGREDO_ANTIGO
    process.env.TICKET_KEYS = `k1:${CHAVE_A}`
    expect(lerQr(DT1_VENDIDO).ok).toBe(true)
  })

  it('DT1 sem a chave antiga falha — marcado como chave aposentada, não como fabricado', () => {
    process.env.TICKET_KEYS = `k1:${CHAVE_A}`
    const lido = lerQr(DT1_VENDIDO)
    expect(lido.ok).toBe(false)
    expect(lido.motivo).toBe('assinatura')
    expect(lido.chaveAposentada).toBe(true)
    expect(lido.code).toBe('CON-7F3K-92AB')
  })
})

describe('QR · DT2 com kid', () => {
  it('emite com o kid da PRIMEIRA chave, e confere', () => {
    process.env.TICKET_KEYS = `k2:${CHAVE_B},k1:${CHAVE_A}`
    const qr = montarQr('CON-AAAA-BBBB', EVENTO)
    expect(qr).toMatch(new RegExp(`^DT2:k2:${EVENTO}:CON-AAAA-BBBB:[A-Z0-9]{10}$`))
    expect(lerQr(qr)).toMatchObject({ ok: true, eventId: EVENTO, code: 'CON-AAAA-BBBB', kid: 'k2' })
  })

  it('trocar de chave não mata o que foi vendido com a anterior', () => {
    process.env.TICKET_KEYS = `k1:${CHAVE_A}`
    const vendidoComK1 = montarQr('CON-CCCC-DDDD', EVENTO)

    process.env.TICKET_KEYS = `k2:${CHAVE_B},k1:${CHAVE_A}`
    const novo = montarQr('CON-EEEE-FFFF', EVENTO)
    expect(novo.startsWith('DT2:k2:')).toBe(true)
    expect(lerQr(vendidoComK1).ok, 'a chave nova derrubou o ingresso assinado com a anterior').toBe(true)
    expect(lerQr(novo).ok).toBe(true)
  })

  it('assinatura trocada falha (e não é confundida com chave aposentada)', () => {
    process.env.TICKET_KEYS = `k1:${CHAVE_A}`
    const qr = montarQr('CON-GGGG-HHHH', EVENTO)
    const falso = qr.slice(0, -1) + (qr.at(-1) === 'A' ? 'B' : 'A')
    const lido = lerQr(falso)
    expect(lido.ok).toBe(false)
    expect(lido.motivo).toBe('assinatura')
    expect(lido.chaveAposentada).toBeUndefined()

    // o código e o evento estão dentro da assinatura
    expect(lerQr(qr.replace('CON-GGGG-HHHH', 'CON-GGGG-HHHJ')).ok).toBe(false)
    expect(lerQr(qr.replace(EVENTO, '00000000-0000-4000-8000-000000000000')).ok).toBe(false)
  })

  it('o kid está dentro da assinatura: a mesma chave com outro nome não confere', () => {
    process.env.TICKET_KEYS = `k2:${CHAVE_A},k1:${CHAVE_A}`
    const qr = montarQr('CON-JJJJ-KKKK', EVENTO)
    expect(lerQr(qr).ok).toBe(true)
    expect(lerQr(qr.replace('DT2:k2:', 'DT2:k1:')).ok,
      'dava pra trocar o kid do QR e continuar valendo').toBe(false)
  })

  it('kid desconhecido falha — chave aposentada, com o código pra portaria conferir', () => {
    process.env.TICKET_KEYS = `k1:${CHAVE_A}`
    const qr = montarQr('CON-LLLL-MMMM', EVENTO)
    process.env.TICKET_KEYS = `k2:${CHAVE_B}`
    const lido = lerQr(qr)
    expect(lido.ok, 'aceitou QR de uma chave que não está mais na lista').toBe(false)
    expect(lido.motivo).toBe('assinatura')
    expect(lido.chaveAposentada).toBe(true)
    expect(lido.code).toBe('CON-LLLL-MMMM')
    expect(lido.kid).toBe('k1')
  })

  it('DT1 com a mesma chave do DT2 não vira DT2 (e vice-versa)', () => {
    process.env.NUXT_SESSION_SECRET = SEGREDO_ANTIGO
    process.env.TICKET_KEYS = `k1:${CHAVE_A}`
    const dt2 = montarQr('CON-NNNN-PPPP', EVENTO)
    const assinatura = dt2.split(':')[4]
    expect(lerQr(`DT1:${EVENTO}:CON-NNNN-PPPP:${assinatura}`).ok).toBe(false)
  })

  it('recusa lixo e formato torto', () => {
    process.env.TICKET_KEYS = `k1:${CHAVE_A}`
    for (const lixo of ['', 'qualquer coisa', 'DT1:a:b', 'DT2:k1:a:b', 'DT2::a:b:c', 'DT3:k1:a:b:c']) {
      expect(lerQr(lixo).ok, `aceitou "${lixo}"`).toBe(false)
    }
  })
})

describe('QR · configuração torta falha alto, e nunca mostra o segredo', () => {
  it('chave curta, kid inválido e kid repetido viram problema escrito', () => {
    process.env.NUXT_SESSION_SECRET = SEGREDO_ANTIGO
    process.env.TICKET_KEYS = `k1:${Buffer.alloc(8, 1).toString('base64')},nome com espaço:${CHAVE_A}`
    const e = estadoDasChavesDeIngresso()
    expect(e.assinaCom, 'sem chave nova válida a casa segue no formato antigo').toBe('DT1')
    expect(e.problemas.join(' | ')).toMatch(/8 bytes/)
    expect(e.problemas.join(' | ')).toMatch(/kid/)
    // e não quebra a venda: segue assinando DT1 com a chave antiga
    expect(montarQr('CON-QQQQ-RRRR', EVENTO).startsWith('DT1:')).toBe(true)

    process.env.TICKET_KEYS = `k1:${CHAVE_A},k1:${CHAVE_B}`
    expect(estadoDasChavesDeIngresso().problemas.join(' | ')).toMatch(/duas vezes/)
  })

  it('sem chave nenhuma, montar QR explode com o nome da variável', () => {
    expect(() => montarQr('CON-SSSS-TTTT', EVENTO)).toThrow(/TICKET_KEYS/)
    expect(estadoDasChavesDeIngresso().assinaCom).toBeNull()
  })

  it('o estado diz SIM/NÃO e o kid — nunca o segredo', () => {
    process.env.NUXT_SESSION_SECRET = SEGREDO_ANTIGO
    process.env.TICKET_KEYS = `k2:${CHAVE_B},k1:${CHAVE_A}`
    const e = estadoDasChavesDeIngresso()
    expect(e).toMatchObject({ assinaCom: 'DT2', kid: 'k2', kids: ['k2', 'k1'], confereDT1: true })
    const texto = JSON.stringify(e)
    for (const segredo of [CHAVE_A, CHAVE_B, SEGREDO_ANTIGO]) expect(texto).not.toContain(segredo)
  })
})
