/**
 * Cupom de consumação do "Volte Mais" (042, dono 05/10/2026).
 *
 * "A consumação não é registrada pelo sistema — preciso de um card, um ticket que mostra isso…
 * a moça vê se está válido ou não e aí pronto, já resgatou o bônus." O bar é da Zig: não dá pra
 * lançar o desconto lá por nós. O que dá é a atendente ter, no celular DELA, a resposta do
 * servidor: válido, já usado, não é hoje.
 *
 * ## Como funciona (o jeito mais simples que fecha a fraude barata)
 *
 * 1. O pedido do retorno (com `loyalty_program_id`) ganha UM cupom: QR (`/consumo/<token>`) e um
 *    código de 6 letras. Vai no ingresso, no e-mail e baixa como imagem.
 * 2. A atendente aponta a câmera do celular pro QR (o app de câmera comum abre o link) — logada no
 *    painel, a página mostra o botão "Dar baixa"; ou digita o código em Caixa do bar.
 * 3. O servidor decide: pedido de pé? É o dia da visita? Ainda tem uso? A entrada do dia passou na
 *    portaria? Print de tela reaproveitado volta "JÁ USADO", porque quem responde é o banco.
 * 4. A baixa vira linha em `loyalty_voucher_usos` (quem, quando) — a conferência com o relatório
 *    de descontos da Zig sai daqui.
 *
 * Amarrado à ENTRADA do dia: cupom repassado pra quem não entrou com aquele ingresso aparece como
 * "entrada não registrada". Não bloqueia de vez (a portaria pode estar sem internet e subir a
 * fila depois): a atendente confere o documento e libera com um toque a mais, e a baixa fica
 * marcada `sem_entrada` pro dono ver.
 *
 * Percentual, dia e limite ficam CONGELADOS no cupom no nascimento: mudar o programa amanhã não
 * muda o cupom que já está no e-mail do cliente.
 */
import { randomBytes, randomInt } from 'node:crypto'
import type { PoolClient } from 'pg'
import { db, q1, tx } from './db'
import { PEDIDO_VIVO } from './liquido'
import { diaNoFusoDaFidelidade } from './fidelidade'
import { baseDoSite } from './envio'

/** sem 0/O, 1/I: a atendente lê em voz alta e digita sem confundir */
const ALFABETO_DO_CUPOM = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

export function codigoNovoDoCupom(): string {
  let s = ''
  for (let i = 0; i < 6; i++) s += ALFABETO_DO_CUPOM[randomInt(ALFABETO_DO_CUPOM.length)]
  return s
}

/** O que a pessoa digita: maiúsculas, sem espaço/traço, O→0 não existe no alfabeto (vira O mesmo). */
export function codigoDoCupomLimpo(cru: string): string {
  return String(cru ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/0/g, 'O').replace(/1/g, 'I')
}

/* ------------------------------------------------------------------ o estado (conta pura) */

export type EstadoDoCupom = 'valido' | 'ativo' | 'usado' | 'antes_do_dia' | 'passou_o_dia' | 'pedido_cancelado'

export function estadoDoCupomDeConsumacao(c: {
  pedidoVale: boolean; dia: string; hoje: string; usos: number; usosMax: number; diaTodo: boolean
}): EstadoDoCupom {
  if (!c.pedidoVale) return 'pedido_cancelado'
  if (c.hoje < c.dia) return 'antes_do_dia'
  if (c.hoje > c.dia) return 'passou_o_dia'
  if (c.diaTodo) return c.usos > 0 ? 'ativo' : 'valido'
  return c.usos >= c.usosMax ? 'usado' : 'valido'
}

/** A frase grande da tela, a mesma pro cliente e pro caixa. */
export const RECADO_DO_CUPOM: Record<EstadoDoCupom, string> = {
  valido: 'VÁLIDO',
  ativo: 'ATIVO HOJE',
  usado: 'JÁ USADO',
  antes_do_dia: 'AINDA NÃO É O DIA',
  passou_o_dia: 'VENCIDO',
  pedido_cancelado: 'CANCELADO',
}

/** CPF pro caixa conferir com o documento sem expor o número inteiro: ***.456.789-** */
export function cpfParaConferir(doc: string | null | undefined): string | null {
  const d = String(doc ?? '').replace(/\D/g, '')
  return d.length === 11 ? `***.${d.slice(3, 6)}.${d.slice(6, 9)}-**` : null
}

/** "Maria S." — o que o cupom PÚBLICO mostra (quem não está logado não vê o nome inteiro). */
export function nomeCurtoDoTitular(nome: string | null | undefined): string | null {
  const partes = String(nome ?? '').trim().split(/\s+/).filter(Boolean)
  if (!partes.length) return null
  return partes.length === 1 ? partes[0]! : `${partes[0]} ${partes[partes.length - 1]![0]}.`
}

/* ------------------------------------------------------------------ nascer */

export type CupomDeConsumacao = {
  id: string; org_id: string; order_id: string; token: string; codigo: string
  consumacao_bps: number; usos_max: number; dia_todo: boolean; dia: string
}

/**
 * O cupom do pedido, criado na primeira vez que alguém pede (página do ingresso, e-mail, caixa).
 * `null` quando o pedido não é retorno do Volte Mais, não está de pé, ou o programa não dá
 * desconto na consumação. Idempotente: duas chamadas ao mesmo tempo dão o MESMO cupom.
 */
export async function garantirCupomDeConsumacao(orderId: string, c: Pick<PoolClient, 'query'> = db()): Promise<CupomDeConsumacao | null> {
  const ja = await c.query(
    `SELECT id, org_id, order_id, token, codigo, consumacao_bps, usos_max, dia_todo, to_char(dia, 'YYYY-MM-DD') AS dia
       FROM loyalty_vouchers WHERE order_id = $1`, [orderId])
  if (ja.rows[0]) return ja.rows[0] as CupomDeConsumacao

  const o = (await c.query(
    `SELECT o.id, o.org_id, o.loyalty_program_id, (${PEDIDO_VIVO('o.')}) AS vivo,
            lp.consumacao_bps, lp.consumacao_usos, lp.consumacao_dia_todo,
            e.timezone,
            COALESCE((SELECT min(ses.starts_at) FROM tickets t
                        JOIN lots l ON l.id = t.lot_id JOIN sectors s ON s.id = l.sector_id
                        JOIN event_sessions ses ON ses.id = s.session_id
                       WHERE t.order_id = o.id), e.starts_at) AS inicio
       FROM orders o
       JOIN events e ON e.id = o.event_id
       JOIN loyalty_programs lp ON lp.id = o.loyalty_program_id
      WHERE o.id = $1`, [orderId])).rows[0]
  if (!o || !o.vivo || Number(o.consumacao_bps) <= 0) return null

  const dia = diaNoFusoDaFidelidade(o.inicio, o.timezone || 'America/Bahia')
  for (let tentativa = 0; tentativa < 6; tentativa++) {
    const r = await c.query(
      `INSERT INTO loyalty_vouchers (org_id, order_id, program_id, token, codigo, consumacao_bps, usos_max, dia_todo, dia)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::date)
       ON CONFLICT (order_id) DO NOTHING
       RETURNING id, org_id, order_id, token, codigo, consumacao_bps, usos_max, dia_todo, to_char(dia, 'YYYY-MM-DD') AS dia`,
      [o.org_id, o.id, o.loyalty_program_id, randomBytes(18).toString('base64url'), codigoNovoDoCupom(),
       Number(o.consumacao_bps), Number(o.consumacao_usos), !!o.consumacao_dia_todo, dia],
    ).catch((e: any) => {
      // o código de 6 letras bateu com outro da mesma organização: sorteia de novo
      if (e?.code === '23505' && String(e?.constraint ?? '').includes('codigo')) return null
      throw e
    })
    if (r === null) continue
    if (r.rows[0]) return r.rows[0] as CupomDeConsumacao
    // perdeu a corrida pro outro pedido da mesma tela: devolve o que ele criou
    const outro = await c.query(
      `SELECT id, org_id, order_id, token, codigo, consumacao_bps, usos_max, dia_todo, to_char(dia, 'YYYY-MM-DD') AS dia
         FROM loyalty_vouchers WHERE order_id = $1`, [orderId])
    return (outro.rows[0] as CupomDeConsumacao) ?? null
  }
  throw new Error('não consegui sortear um código livre pro cupom de consumação')
}

/* ------------------------------------------------------------------ ler */

export type UsoDoCupom = { em: string; por: string | null; semEntrada: boolean }
export type SituacaoDoCupom = {
  cupom: CupomDeConsumacao
  estado: EstadoDoCupom
  recado: string
  consumacaoPct: number
  hoje: string
  pedido: string
  evento: string
  programa: string
  titular: string | null
  documento: string | null
  /** hora (no fuso do parque) da 1ª entrada de hoje de algum ingresso do pedido, ou null */
  entradaHoje: string | null
  usos: UsoDoCupom[]
  restam: number | null
}

const SQL_DO_CUPOM = `
  SELECT v.id, v.org_id, v.order_id, v.token, v.codigo, v.consumacao_bps, v.usos_max, v.dia_todo,
         to_char(v.dia, 'YYYY-MM-DD') AS dia,
         o.code AS pedido, (${PEDIDO_VIVO('o.')}) AS vivo, e.name AS evento, COALESCE(e.timezone, 'America/Bahia') AS fuso,
         lp.nome AS programa, cu.name AS titular, cu.document AS documento
    FROM loyalty_vouchers v
    JOIN orders o ON o.id = v.order_id
    JOIN events e ON e.id = o.event_id
    JOIN loyalty_programs lp ON lp.id = v.program_id
    LEFT JOIN customers cu ON cu.id = o.customer_id`

async function situacaoDaLinha(c: Pick<PoolClient, 'query'>, v: any, agora = new Date()): Promise<SituacaoDoCupom> {
  const hoje = diaNoFusoDaFidelidade(agora, v.fuso)
  const usos = (await c.query(
    `SELECT to_char(usado_em AT TIME ZONE $2, 'HH24:MI') AS em, usado_por AS por, sem_entrada AS "semEntrada"
       FROM loyalty_voucher_usos WHERE voucher_id = $1 ORDER BY usado_em`, [v.id, v.fuso])).rows as UsoDoCupom[]
  const entrada = (await c.query(
    `SELECT to_char(min(en.entered_at) AT TIME ZONE $2, 'HH24:MI') AS em
       FROM entries en JOIN tickets t ON t.id = en.ticket_id
      WHERE t.order_id = $1 AND (en.entered_at AT TIME ZONE $2)::date = $3::date`,
    [v.order_id, v.fuso, hoje])).rows[0]?.em ?? null
  const estado = estadoDoCupomDeConsumacao({
    pedidoVale: !!v.vivo, dia: v.dia, hoje, usos: usos.length, usosMax: Number(v.usos_max), diaTodo: !!v.dia_todo,
  })
  return {
    cupom: { id: v.id, org_id: v.org_id, order_id: v.order_id, token: v.token, codigo: v.codigo,
             consumacao_bps: Number(v.consumacao_bps), usos_max: Number(v.usos_max), dia_todo: !!v.dia_todo, dia: v.dia },
    estado, recado: RECADO_DO_CUPOM[estado], consumacaoPct: Number(v.consumacao_bps) / 100, hoje,
    pedido: v.pedido, evento: v.evento, programa: v.programa, titular: v.titular ?? null, documento: v.documento ?? null,
    entradaHoje: entrada, usos, restam: v.dia_todo ? null : Math.max(0, Number(v.usos_max) - usos.length),
  }
}

export async function cupomDeConsumacaoPeloToken(token: string, agora?: Date): Promise<SituacaoDoCupom | null> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null
  const v = await q1<any>(`${SQL_DO_CUPOM} WHERE v.token = $1`, [token])
  return v ? situacaoDaLinha(db(), v, agora) : null
}

export async function cupomDeConsumacaoPeloCodigo(orgId: string, codigo: string, agora?: Date): Promise<SituacaoDoCupom | null> {
  const limpo = codigoDoCupomLimpo(codigo)
  if (!/^[A-HJ-NP-Z2-9]{6}$/.test(limpo)) return null
  const v = await q1<any>(`${SQL_DO_CUPOM} WHERE v.org_id = $1 AND v.codigo = $2`, [orgId, limpo])
  return v ? situacaoDaLinha(db(), v, agora) : null
}

/* ------------------------------------------------------------------ dar baixa */

export class CupomRecusadoNoCaixa extends Error {
  constructor(public tipo: EstadoDoCupom | 'sem_entrada' | 'inexistente', public situacao: SituacaoDoCupom | null, recado: string) {
    super(recado)
  }
}

/**
 * A baixa no caixa. Trava a linha do cupom (duas atendentes ao mesmo tempo não dão dois usos de
 * um cupom de uso único), decide de novo com tudo na mão, e grava quem deu a baixa.
 * Sem a entrada do dia registrada, só passa com `semEntrada: true` (a atendente conferiu o
 * documento) — e a baixa fica marcada.
 */
export async function darBaixaNoCupom(
  ref: { orgId: string; token?: string; codigo?: string }, quem: string, opcoes: { semEntrada?: boolean; agora?: Date } = {},
): Promise<SituacaoDoCupom> {
  return tx(async (c) => {
    const onde = ref.token ? `v.token = $2` : `v.codigo = $2`
    const valor = ref.token ?? codigoDoCupomLimpo(ref.codigo ?? '')
    const v = (await c.query(`${SQL_DO_CUPOM} WHERE v.org_id = $1 AND ${onde} FOR UPDATE OF v`, [ref.orgId, valor])).rows[0]
    if (!v) throw new CupomRecusadoNoCaixa('inexistente', null, 'Cupom não encontrado neste parque. Confira o código.')
    const s = await situacaoDaLinha(c, v, opcoes.agora)
    if (s.estado === 'ativo') return s // vale o dia todo e já foi ativado: nada a gravar, segue verde
    if (s.estado !== 'valido') {
      throw new CupomRecusadoNoCaixa(s.estado, s, ({
        usado: `Este cupom já foi usado${s.usos.length ? ` às ${s.usos[s.usos.length - 1]!.em}` : ''}.`,
        antes_do_dia: `Este cupom vale só no dia da visita (${s.cupom.dia.split('-').reverse().join('/')}).`,
        passou_o_dia: `Este cupom era do dia ${s.cupom.dia.split('-').reverse().join('/')}.`,
        pedido_cancelado: 'O pedido deste cupom foi cancelado ou estornado.',
      } as Record<string, string>)[s.estado] ?? 'Cupom não está válido.')
    }
    if (!s.entradaHoje && !opcoes.semEntrada) {
      throw new CupomRecusadoNoCaixa('sem_entrada', s,
        'A entrada deste ingresso hoje ainda não aparece na portaria. Confira o documento com foto antes de liberar.')
    }
    await c.query(
      `INSERT INTO loyalty_voucher_usos (voucher_id, usado_por, sem_entrada) VALUES ($1, $2, $3)`,
      [v.id, quem.slice(0, 200), !s.entradaHoje])
    return situacaoDaLinha(c, v, opcoes.agora)
  })
}

/** As últimas baixas da organização (Inteligência → Promoções e o Caixa do bar). */
export async function ultimasBaixasDeCupom(orgId: string, limite = 30) {
  return (await db().query(
    `SELECT u.id, to_char(u.usado_em AT TIME ZONE COALESCE(e.timezone, 'America/Bahia'), 'DD/MM HH24:MI') AS em,
            u.usado_por AS por, u.sem_entrada AS "semEntrada", v.codigo, v.consumacao_bps AS "consumacaoBps",
            o.code AS pedido, cu.name AS titular
       FROM loyalty_voucher_usos u
       JOIN loyalty_vouchers v ON v.id = u.voucher_id
       JOIN orders o ON o.id = v.order_id
       JOIN events e ON e.id = o.event_id
       LEFT JOIN customers cu ON cu.id = o.customer_id
      WHERE v.org_id = $1
      ORDER BY u.usado_em DESC LIMIT $2`, [orgId, limite])).rows
}

/** A versão do caixa: nome inteiro e CPF mascarado pra conferir com o documento. */
export function situacaoParaOCaixa(s: SituacaoDoCupom) {
  return {
    estado: s.estado, recado: s.recado, consumacaoPct: s.consumacaoPct, dia: s.cupom.dia, hoje: s.hoje,
    codigo: s.cupom.codigo, token: s.cupom.token, programa: s.programa, evento: s.evento, pedido: s.pedido,
    titular: s.titular, cpf: cpfParaConferir(s.documento), entradaHoje: s.entradaHoje,
    diaTodo: s.cupom.dia_todo, usosMax: s.cupom.usos_max, usos: s.usos, restam: s.restam,
  }
}

/** O link do cupom (o que o QR carrega). Em produção, o endereço oficial; fora dela, quem pediu. */
export function enderecoDoCupom(token: string, origem: string): string {
  const base = process.env.NODE_ENV === 'production' ? (baseDoSite() ?? origem) : origem
  return `${base.replace(/\/+$/, '')}/consumo/${token}`
}
