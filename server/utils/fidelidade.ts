/**
 * Programa de fidelidade "Volte Mais" (dono, 05/10/2026) — 1ª visita a preço cheio, os próximos
 * retornos com desconto, e um selo de desconto na consumação.
 *
 * ## As decisões, com o porquê
 *
 * - **Quem ganha é o CPF**, não a conta nem o e-mail: é o que a conta do cliente exige único por
 *   organização (034) e o que a portaria confere no documento. A compra com desconto só sai com a
 *   CONTA na sessão — o CPF vem dela, nunca do corpo do pedido.
 * - **"Visitou" = passou na portaria** (`conta_visita = 'entrada'`, o padrão). Contar a compra
 *   abriria a porta mais barata do abuso: comprar, pedir reembolso e ganhar o retorno. Com
 *   'compra', o pedido precisa estar pago e não estornado.
 * - **A 1ª visita que vale é a paga a preço cheio**: pedido de valor > 0, sem cortesia e SEM
 *   fidelidade (o retorno não gera retorno novo — o crédito é fixo, `retornos` por CPF).
 * - **Uso = pedido em pé com o programa.** Não há saldo gravado: a pergunta "quantos já usou" é
 *   a contagem de pedidos com `loyalty_program_id` que ainda estão em pé (aguardando pagamento
 *   conta — senão duas abas abertas gastariam o mesmo retorno). Expirou, cancelou, estornou: o
 *   retorno volta sozinho.
 * - **Meia-entrada legal não acumula** (Lei 12.933/2013 + Senacon NT 3/2019): metade promocional e
 *   meia legal dão o mesmo valor, então o desconto não entra em ingresso de tipo com desconto
 *   próprio (meia) nem em ingresso grátis. Quem paga meia conta como visita normalmente.
 * - **Cupom não acumula**: pedido com cupom segue a regra do cupom (o campo está escondido no site
 *   desde 28/09; quando voltar, o cliente escolhe um dos dois).
 * - **Promoção tem prazo**: só liga com vigência (início e fim) — sem prazo a Senacon entende que
 *   deixa de ser promoção (o desconto vira o preço). O regulamento sai pronto daqui.
 * - **Consumação**: o bar é da Zig; os 10% viram um SELO no ingresso do retorno e na tela da
 *   portaria — o caixa confere e lança. Integração automática só quando a Zig tiver como receber.
 *
 * O que é conta pura (escolher ingresso, calcular o desconto, a regra do dia, o regulamento) não
 * toca o banco — os testes provam sem servidor. O que lê o banco recebe o `PoolClient` da
 * transação do checkout: a decisão é tomada com a trava do CPF na mão.
 */
import type { PoolClient } from 'pg'
import { PEDIDO_EM_PE } from './cupom'

import type { ProgramaDeFidelidade } from './fidelidade-texto'

/* ------------------------------------------------------------------ datas */

/** 'AAAA-MM-DD' do instante no fuso dado (o dia do evento é o do PARQUE, não o do servidor). */
export function diaNoFusoDaFidelidade(instante: Date | string, fuso = 'America/Bahia'): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: fuso }).format(new Date(instante))
}

function pascoaDoAno(a: number): Date {                       // Meeus/Jones/Butcher
  const A = a % 19, B = Math.floor(a / 100), C = a % 100, D = Math.floor(B / 4), E = B % 4
  const F = Math.floor((B + 8) / 25), G = Math.floor((B - F + 1) / 3), H = (19 * A + B - D - G + 15) % 30
  const I = Math.floor(C / 4), K = C % 4, L = (32 + 2 * E + 2 * I - H - K) % 7, M = Math.floor((A + 11 * H + 22 * L) / 451)
  const mes = Math.floor((H + L - 7 * M + 114) / 31), dia = ((H + L - 7 * M + 114) % 31) + 1
  return new Date(Date.UTC(a, mes - 1, dia))
}

/** Feriado NACIONAL do dia ('AAAA-MM-DD'), ou null. A mesma tabela dos robôs (calendario.js no vault). */
export function feriadoNacionalDoDia(iso: string): string | null {
  const a = Number(iso.slice(0, 4))
  const fixos: Record<string, string> = {
    '01-01': 'Confraternização Universal', '04-21': 'Tiradentes', '05-01': 'Dia do Trabalho',
    '09-07': 'Independência', '10-12': 'Nossa Senhora Aparecida', '11-02': 'Finados',
    '11-15': 'Proclamação da República', '11-20': 'Consciência Negra', '12-25': 'Natal',
  }
  const p = pascoaDoAno(a)
  const md = (n: number) => { const d = new Date(p.getTime() + n * 86_400_000); return `${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}` }
  const moveis: Record<string, string> = { [md(-48)]: 'Carnaval', [md(-47)]: 'Carnaval', [md(-2)]: 'Sexta-feira Santa', [md(60)]: 'Corpus Christi' }
  const k = iso.slice(5, 10)
  return fixos[k] ?? moveis[k] ?? null
}

const diaDaSemana = (iso: string) => new Date(`${iso}T12:00:00Z`).getUTCDay()
const somaDias = (iso: string, n: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)

/* ------------------------------------------------------------------ regra do dia */

export type RegraDoDia = { vale: true } | { vale: false; motivo: string }

/** O retorno vale pra ESTE evento? (vigência, dia da semana, feriado, evento fora) — conta pura. */
export function regraDoDiaDaFidelidade(p: ProgramaDeFidelidade, evento: { id: string; dia: string }, hoje: string): RegraDoDia {
  if (!p.ativo) return { vale: false, motivo: 'programa desligado' }
  if (!p.vigencia_inicio) return { vale: false, motivo: 'programa sem início de vigência' }
  if (hoje < p.vigencia_inicio) return { vale: false, motivo: 'a promoção ainda não começou' }
  if (p.vigencia_fim && hoje > p.vigencia_fim) return { vale: false, motivo: 'a promoção terminou' }
  if (p.eventos_fora.includes(evento.id)) return { vale: false, motivo: 'não vale neste evento' }
  const feriado = feriadoNacionalDoDia(evento.dia)
  if (feriado && !p.vale_feriado) return { vale: false, motivo: `não vale em feriado (${feriado})` }
  if (!feriado && !p.dias_semana.includes(diaDaSemana(evento.dia))) return { vale: false, motivo: 'não vale nesse dia da semana' }
  return { vale: true }
}

/* ------------------------------------------------------------------ o desconto */

export type LinhaDaFidelidade = {
  /** a face JÁ do tipo (meia já está pela metade aqui) */
  faceUnitCents: number
  quantidade: number
  /** tipo com desconto próprio (meia) ou que exige documento: não recebe o desconto */
  tipoComDesconto: boolean
}

/**
 * Quais ingressos recebem o desconto e quanto: os MAIS CAROS elegíveis primeiro, até
 * `ingressos_por_compra`. Conta pura, centavo inteiro, arredondamento pra baixo (o centavo que
 * sobra é do parque, nunca um desconto maior que o anunciado).
 */
export function descontoDaFidelidade(linhas: LinhaDaFidelidade[], p: Pick<ProgramaDeFidelidade, 'desconto_bps' | 'ingressos_por_compra'>): { cents: number; ingressos: number } {
  const unidades: number[] = []
  for (const l of linhas) {
    if (l.tipoComDesconto || l.faceUnitCents <= 0) continue
    for (let i = 0; i < l.quantidade; i++) unidades.push(l.faceUnitCents)
  }
  unidades.sort((a, b) => b - a)
  const escolhidas = unidades.slice(0, Math.max(0, p.ingressos_por_compra))
  const cents = escolhidas.reduce((s, face) => s + Math.floor((face * p.desconto_bps) / 10_000), 0)
  return { cents, ingressos: escolhidas.length }
}

/* ------------------------------------------------------------------ o CPF no programa */

export type SituacaoNaFidelidade =
  | { qualificado: false; motivo: string }
  /** `restantes` null = sem limite (programa permanente, 042) */
  | { qualificado: true; primeiraVisita: string; usados: number; restantes: number | null; validoAte: string | null }

const FILTRO_PEDIDO_CHEIO = `o.org_id = $1 AND cu.document = $2 AND o.total_cents > 0
  AND COALESCE(o.loyalty_discount_cents, 0) = 0 AND o.loyalty_program_id IS NULL`

/**
 * Onde o CPF está no programa: já fez a 1ª visita que vale? quantos retornos usou? até quando?
 * `c` é a transação do checkout (com a trava do CPF) ou o pool, na prévia.
 */
export async function situacaoNaFidelidade(
  c: Pick<PoolClient, 'query'>, p: ProgramaDeFidelidade, documento: string, fuso = 'America/Bahia',
): Promise<SituacaoNaFidelidade> {
  const desde = p.vale_visita_anterior ? null : p.vigencia_inicio
  const primeira = p.conta_visita === 'entrada'
    ? await c.query(
        `SELECT min(en.entered_at) AS em
           FROM entries en
           JOIN tickets t    ON t.id = en.ticket_id
           JOIN orders o     ON o.id = t.order_id
           JOIN customers cu ON cu.id = o.customer_id
          WHERE ${FILTRO_PEDIDO_CHEIO} AND NOT t.is_courtesy
            AND o.status IN ('pago', 'estornado_parcial')
            AND ($3::date IS NULL OR (en.entered_at AT TIME ZONE $4)::date >= $3::date)`,
        [p.org_id, documento, desde, fuso])
    : await c.query(
        `SELECT min(o.paid_at) AS em
           FROM orders o
           JOIN customers cu ON cu.id = o.customer_id
          WHERE ${FILTRO_PEDIDO_CHEIO} AND o.status = 'pago' AND o.paid_at IS NOT NULL
            AND ($3::date IS NULL OR (o.paid_at AT TIME ZONE $4)::date >= $3::date)`,
        [p.org_id, documento, desde, fuso])
  const em = primeira.rows[0]?.em
  if (!em) {
    return { qualificado: false, motivo: p.conta_visita === 'entrada'
      ? 'o desconto começa depois da primeira visita (entrada na portaria) com ingresso inteiro'
      : 'o desconto começa depois da primeira compra paga a preço cheio' }
  }
  const usados = Number((await c.query(
    `SELECT count(*)::int AS n
       FROM orders o JOIN customers cu ON cu.id = o.customer_id
      WHERE o.loyalty_program_id = $1 AND cu.document = $2 AND o.status = ANY($3::text[])`,
    [p.id, documento, PEDIDO_EM_PE as unknown as string[]])).rows[0]?.n ?? 0)
  const primeiraVisita = diaNoFusoDaFidelidade(em, fuso)
  const prazo = p.prazo_dias ? somaDias(primeiraVisita, p.prazo_dias) : null
  const validoAte = [prazo, p.vigencia_fim].filter(Boolean).sort()[0] ?? null
  return { qualificado: true, primeiraVisita, usados, restantes: p.retornos == null ? null : Math.max(0, p.retornos - usados), validoAte }
}

export async function programaDeFidelidadeDaOrg(c: Pick<PoolClient, 'query'>, orgId: string): Promise<ProgramaDeFidelidade | null> {
  const r = await c.query(
    `SELECT id, org_id, nome, ativo, desconto_bps, retornos, prazo_dias, ingressos_por_compra, conta_visita,
            dias_semana, vale_feriado, eventos_fora::text[] AS eventos_fora, vale_visita_anterior, consumacao_bps,
            consumacao_usos, consumacao_dia_todo,
            to_char(vigencia_inicio, 'YYYY-MM-DD') AS vigencia_inicio, to_char(vigencia_fim, 'YYYY-MM-DD') AS vigencia_fim,
            regulamento
       FROM loyalty_programs WHERE org_id = $1`, [orgId])
  return (r.rows[0] as ProgramaDeFidelidade | undefined) ?? null
}

/* ------------------------------------------------------------------ o pedido */

export type BeneficioNoPedido =
  | { aplica: false; motivo: string; programa: ProgramaDeFidelidade | null }
  | { aplica: true; programa: ProgramaDeFidelidade; cents: number; ingressos: number; restantesDepois: number | null; validoAte: string | null }

/**
 * O desconto deste pedido, decidido com tudo na mão: programa, regra do dia, situação do CPF e
 * as linhas. Quem chama dentro da transação do checkout trava o CPF ANTES (`travarCpfNaFidelidade`).
 */
export async function beneficioDeFidelidade(
  c: Pick<PoolClient, 'query'>,
  ctx: { orgId: string; evento: { id: string; inicio: string | Date; fuso?: string | null }; documento: string;
         linhas: LinhaDaFidelidade[]; temCupom: boolean; hoje?: string },
): Promise<BeneficioNoPedido> {
  const p = await programaDeFidelidadeDaOrg(c, ctx.orgId)
  if (!p) return { aplica: false, motivo: 'sem programa', programa: null }
  const fuso = ctx.evento.fuso || 'America/Bahia'
  const hoje = ctx.hoje ?? diaNoFusoDaFidelidade(new Date(), fuso)
  const diaDoEvento = diaNoFusoDaFidelidade(ctx.evento.inicio, fuso)
  const regra = regraDoDiaDaFidelidade(p, { id: ctx.evento.id, dia: diaDoEvento }, hoje)
  if (!regra.vale) return { aplica: false, motivo: regra.motivo, programa: p }
  if (ctx.temCupom) return { aplica: false, motivo: 'pedido com cupom (não acumula)', programa: p }
  const s = await situacaoNaFidelidade(c, p, ctx.documento, fuso)
  if (!s.qualificado) return { aplica: false, motivo: s.motivo, programa: p }
  if (s.restantes !== null && s.restantes <= 0) return { aplica: false, motivo: `os ${p.retornos} retornos com desconto já foram usados`, programa: p }
  if (s.validoAte && diaDoEvento > s.validoAte) {
    return { aplica: false, motivo: `o desconto vale pra visitas até ${s.validoAte.split('-').reverse().join('/')}`, programa: p }
  }
  const d = descontoDaFidelidade(ctx.linhas, p)
  if (d.cents <= 0) return { aplica: false, motivo: 'nenhum ingresso do pedido recebe o desconto (meia e grátis não acumulam)', programa: p }
  return { aplica: true, programa: p, cents: d.cents, ingressos: d.ingressos, restantesDepois: s.restantes === null ? null : s.restantes - 1, validoAte: s.validoAte }
}

/** Trava do CPF no programa (a organização inteira, não só o evento): duas abas não gastam o mesmo retorno. */
export async function travarCpfNaFidelidade(c: Pick<PoolClient, 'query'>, orgId: string, documento: string) {
  await c.query(`SELECT pg_advisory_xact_lock(hashtext('fidelidade:' || $1::text), hashtext($2::text))`, [orgId, documento])
}
