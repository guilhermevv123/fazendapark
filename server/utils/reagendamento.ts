/**
 * Reagendamento pelo próprio cliente (dono, 30/09/2026): na conta ("Meus
 * ingressos"), o ingresso ganha "Reagendar" — a pessoa troca por outro
 * dia/ingresso que o parque tem à venda.
 *
 * O parque vende por EDIÇÃO (um evento por dia), então trocar de dia é trocar
 * de EVENTO. Por isso a troca não mexe no ingresso antigo por dentro: ele é
 * cancelado (o QR para de passar na portaria) e nasce um pedido NOVO, zerado,
 * no evento escolhido e na mesma conta. O dinheiro entrou uma vez só, no
 * pedido original, e continua contado lá — o pedido novo é R$ 0,00 e leva em
 * `rescheduled_from_ticket_id` (036) o ingresso que substituiu.
 *
 * Regras (as mesmas pra tela e pra rota — a tela só pergunta, quem decide é
 * `motivoSemReagendamento` + `opcoesDeReagendamento` aqui):
 *   · só o dono: o pedido tem de ser DESTA conta (`orders.customer_account_id`);
 *   · só ingresso válido, de pedido pago, antes de o evento começar;
 *   · convite (cortesia), passaporte e ingresso transferido ficam de fora;
 *   · destino: evento do mesmo parque, publicado, com venda aberta, no futuro,
 *     no MESMO tipo e desconto (inteira↔inteira, meia↔meia, criança↔criança) e que não custe MAIS do que
 *     a pessoa pagou por aquele ingresso — não se cobra diferença nem se
 *     devolve troco;
 *   · o estoque sai pelo `reservar()` de sempre (porta do lote, trava, faxina
 *     de carrinho vencido) e a meia confere a cota legal do lote novo.
 *
 * Nomes com "Reagend…" de propósito: todo export de `server/utils` vira
 * auto-import do Nitro e nome repetido troca o outro em silêncio.
 */
import type { PoolClient } from 'pg'
import { q1, q, tx } from './db'
import { reservar, EstoqueInsuficiente, LoteIndisponivel } from './estoque'
import { conferirCotaDeMeia, CotaDeMeiaEsgotada } from './meia-entrada'
import { gerarCodigo } from './ingresso'
import { faceDoTipo, precificar, type ModoTaxa } from './dinheiro'
import { LOTE_DA_VITRINE, portaDeVenda } from '../api/e/[slug].get'

/** O ingresso como o reagendamento precisa ver. */
export interface IngressoParaReagendar {
  id: string
  codigo: string
  status: string
  usadoEm: string | null
  transferido: boolean
  eventoId: string
  evento: string
  eventoInicio: string
  fuso: string | null
  loteId: string
  lote: string
  setor: string
  setorTipo: string
  tipoId: string | null
  tipo: string | null
  especie: string
  /** desconto do tipo (bps): a troca é pro MESMO tipo — inteira↔inteira, meia↔meia, criança↔criança */
  descontoBps: number
  pedidoId: string
  pedido: string
  pedidoStatus: string
  canal: string
  orgId: string
  contaId: string | null
  clienteId: string | null
  pagoCents: number
  titular: { nome: string | null; email: string | null; documento: string | null }
  meia: { motivo: string | null; documento: string | null; documentoExigido: string | null }
}

const SQL_INGRESSO = `
  SELECT t.id, t.code, t.status, t.checked_in_at, t.event_id, t.lot_id, t.ticket_type_id,
         t.holder_name, t.holder_email, t.holder_document,
         t.half_reason, t.half_document, t.half_document_required,
         EXISTS (SELECT 1 FROM ticket_transfers tr
                  WHERE tr.ticket_id = t.id AND tr.status = 'concluido') AS transferido,
         o.id AS order_id, o.code AS order_code, o.status AS order_status, o.channel,
         o.org_id, o.customer_account_id, o.customer_id,
         COALESCE(oi.unit_total_cents, 0) AS pago_cents,
         e.name AS evento, e.starts_at, e.timezone,
         l.name AS lote, s.name AS setor, s.kind AS setor_kind,
         tt.name AS tipo, COALESCE(tt.kind, 'inteira') AS especie, COALESCE(tt.discount_bps, 0) AS desconto
    FROM tickets t
    JOIN orders o ON o.id = t.order_id
    JOIN events e ON e.id = t.event_id
    JOIN lots l ON l.id = t.lot_id
    JOIN sectors s ON s.id = l.sector_id
    LEFT JOIN order_items oi ON oi.id = t.order_item_id
    LEFT JOIN ticket_types tt ON tt.id = t.ticket_type_id
   WHERE t.id = $1`

function paraIngresso(r: any): IngressoParaReagendar {
  return {
    id: r.id, codigo: r.code, status: r.status, usadoEm: r.checked_in_at,
    transferido: Boolean(r.transferido),
    eventoId: r.event_id, evento: r.evento, eventoInicio: r.starts_at, fuso: r.timezone,
    loteId: r.lot_id, lote: r.lote, setor: r.setor, setorTipo: r.setor_kind,
    tipoId: r.ticket_type_id, tipo: r.tipo, especie: r.especie, descontoBps: Number(r.desconto),
    pedidoId: r.order_id, pedido: r.order_code, pedidoStatus: r.order_status, canal: r.channel,
    orgId: r.org_id, contaId: r.customer_account_id, clienteId: r.customer_id,
    pagoCents: Number(r.pago_cents),
    titular: { nome: r.holder_name, email: r.holder_email, documento: r.holder_document },
    meia: { motivo: r.half_reason, documento: r.half_document, documentoExigido: r.half_document_required },
  }
}

/** Busca o ingresso SÓ se ele for desta conta — de outra pessoa, some (404, não 403). */
export async function ingressoDaContaParaReagendar(
  contaId: string, ingressoId: string, c?: PoolClient,
): Promise<IngressoParaReagendar | null> {
  if (!/^[0-9a-f-]{36}$/i.test(ingressoId)) return null
  const sql = c ? SQL_INGRESSO + ' FOR UPDATE OF t, o' : SQL_INGRESSO
  const r = c ? (await c.query(sql, [ingressoId])).rows[0] : await q1<any>(sql, [ingressoId])
  if (!r || r.customer_account_id !== contaId) return null
  return paraIngresso(r)
}

/** Por que este ingresso NÃO pode ser reagendado — `null` quando pode. Frase pro cliente. */
export function motivoSemReagendamento(i: IngressoParaReagendar, agora = new Date()): string | null {
  if (!['pago', 'estornado_parcial'].includes(i.pedidoStatus)) {
    return 'Só dá pra reagendar ingresso de pedido pago.'
  }
  if (i.canal === 'cortesia') {
    return 'Convite da casa não é reagendado pelo site. Fale com o parque.'
  }
  if (i.transferido) return 'Este ingresso foi transferido para outra pessoa.'
  if (i.status === 'usado' || i.usadoEm) return 'Este ingresso já foi utilizado.'
  if (i.status !== 'valido') return 'Este ingresso não está mais válido.'
  if (i.setorTipo === 'passaporte') {
    return 'Passaporte vale por mais de um dia e não é reagendado pelo site. Fale com o parque.'
  }
  if (new Date(i.eventoInicio) <= agora) {
    return 'O dia deste ingresso já começou — não dá mais pra reagendar.'
  }
  return null
}

/** Uma opção de troca: um tipo de ingresso num lote de outro dia. */
export interface OpcaoDeReagendamento {
  eventoId: string
  evento: string
  slug: string
  inicio: string
  fuso: string | null
  banner: string | null
  setor: string
  loteId: string
  lote: string
  tipoId: string
  tipo: string
  totalCents: number
}

const SQL_OPCOES = `
  SELECT e.id AS evento_id, e.name AS evento, e.slug, e.starts_at, e.ends_at, e.sales_end_at,
         e.sales_end_minutes_after, e.timezone, e.status, e.fee_bps, e.fee_mode_online,
         e.banner_url, e.max_per_customer,
         s.name AS setor, s.session_id, s.id AS setor_id, s.sort_order,
         l.id AS lote_id, l.name AS lote, l.price_cents,
         tt.id AS tipo_id, tt.name AS tipo, tt.discount_bps
    FROM events e
    JOIN sectors s ON s.event_id = e.id AND s.kind = 'ingresso'
    JOIN lots l ON l.sector_id = s.id AND ${LOTE_DA_VITRINE}
    JOIN ticket_types tt ON tt.lot_id = l.id
   WHERE e.org_id = $1 AND e.id <> $2
     AND e.status = 'ativo' AND NOT e.is_private AND e.starts_at > now()
     AND tt.kind = $3 AND tt.discount_bps = $4
     AND (l.starts_at IS NULL OR l.starts_at <= now())
     AND (l.expires_at IS NULL OR l.expires_at > now())
     AND l.min_per_order <= 1 AND l.max_per_order >= 1
     AND l.quantity - l.sold - l.reserved > 0
     AND tt.quantity - tt.sold > 0`

function totalDaOpcao(r: any): number {
  const modo = (r.fee_mode_online ?? 'repassar') as ModoTaxa
  const fee = Number(r.fee_bps ?? 0)
  return precificar(faceDoTipo(Number(r.price_cents), Number(r.discount_bps ?? 0), fee, modo), fee, modo)
    .totalCents
}

function paraOpcao(r: any): OpcaoDeReagendamento {
  return {
    eventoId: r.evento_id, evento: r.evento, slug: r.slug, inicio: r.starts_at, fuso: r.timezone,
    banner: r.banner_url, setor: r.setor, loteId: r.lote_id, lote: r.lote,
    tipoId: r.tipo_id, tipo: r.tipo, totalCents: totalDaOpcao(r),
  }
}

async function linhasDeOpcoes(i: IngressoParaReagendar, filtro = '', extra: unknown[] = [], c?: PoolClient) {
  const sql = `${SQL_OPCOES} ${filtro} ORDER BY e.starts_at, s.sort_order, l.price_cents, tt.name`
  const params = [i.orgId, i.eventoId, i.especie, i.descontoBps, ...extra]
  const rows = c ? (await c.query(sql, params)).rows : await q<any>(sql, params)
  // A porta do EVENTO (status, fim, prazo de venda) é a mesma função da vitrine e do checkout.
  return rows.filter((r) => portaDeVenda(r).aberta && totalDaOpcao(r) <= i.pagoCents)
}

/** Os dias/ingressos pra onde este ingresso pode ir. */
export async function opcoesDeReagendamento(i: IngressoParaReagendar): Promise<OpcaoDeReagendamento[]> {
  return (await linhasDeOpcoes(i)).map(paraOpcao)
}

/** Recusa com a frase pro cliente e o status HTTP. */
export class RecusaDoReagendamento extends Error {
  constructor(public status: number, mensagem: string) { super(mensagem) }
}

/**
 * Faz a troca numa transação só: o ingresso novo nasce e o antigo morre juntos,
 * ou nenhum dos dois. Devolve o código do pedido novo (a página do ingresso).
 */
export async function reagendarIngressoDoCliente(
  contaId: string, ingressoId: string, destino: { loteId: string; tipoId: string },
): Promise<{ pedido: string; ingresso: string }> {
  return tx(async (c) => {
    const i = await ingressoDaContaParaReagendar(contaId, ingressoId, c)
    if (!i) throw new RecusaDoReagendamento(404, 'Ingresso não encontrado na sua conta.')
    const motivo = motivoSemReagendamento(i)
    if (motivo) throw new RecusaDoReagendamento(409, motivo)

    const [d] = await linhasDeOpcoes(i, 'AND l.id = $5 AND tt.id = $6', [destino.loteId, destino.tipoId], c)
    if (!d) {
      throw new RecusaDoReagendamento(409,
        'Essa opção não está mais disponível para troca. Escolha outro dia ou ingresso.')
    }

    // Limite por cliente do evento novo (o mesmo que o checkout respeita).
    if (d.max_per_customer != null) {
      const { rows: [ja] } = await c.query(
        `SELECT count(*)::int AS n FROM tickets t JOIN orders o ON o.id = t.order_id
          WHERE o.event_id = $1 AND o.customer_account_id = $2 AND t.status IN ('valido','usado')`,
        [d.evento_id, contaId])
      if (ja.n + 1 > Number(d.max_per_customer)) {
        throw new RecusaDoReagendamento(409,
          `Você já tem o máximo de ${d.max_per_customer} ingresso(s) para ${d.evento}.`)
      }
    }

    // Os dois lotes travados na ordem do id: duas trocas cruzadas (A→B e B→A)
    // pegariam os mesmos lotes em ordens opostas e travariam uma na outra.
    await c.query(`SELECT id FROM lots WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
      [[i.loteId, d.lote_id]])

    try {
      await reservar(c, [{ lotId: d.lote_id, ticketTypeId: d.tipo_id, quantidade: 1 }], { canal: 'online' })
    } catch (e) {
      if (e instanceof EstoqueInsuficiente || e instanceof LoteIndisponivel) {
        throw new RecusaDoReagendamento(409, 'Esse ingresso acabou de esgotar. Escolha outro dia ou ingresso.')
      }
      throw e
    }
    // Sem pagamento pendente: a reserva vira venda na hora.
    await c.query(
      `UPDATE lots SET reserved = reserved - 1, sold = sold + 1 WHERE id = $1 AND reserved >= 1`,
      [d.lote_id])

    const { rows: [pedido] } = await c.query(
      `INSERT INTO orders (org_id, event_id, code, status, channel, face_cents, fee_cents,
                           platform_cents, discount_cents, total_cents, paid_at,
                           customer_id, customer_account_id, rescheduled_from_ticket_id)
       VALUES ($1,$2,$3,'pago','online',0,0,0,0,0,now(),$4,$5,$6)
       RETURNING id, code`,
      [i.orgId, d.evento_id, gerarCodigo('PED'), i.clienteId, contaId, i.id])

    const { rows: [item] } = await c.query(
      `INSERT INTO order_items (order_id, lot_id, ticket_type_id, quantity,
                                unit_face_cents, unit_fee_cents, unit_total_cents,
                                half_reason, half_document, half_document_required)
       VALUES ($1,$2,$3,1,0,0,0,$4,$5,$6) RETURNING id`,
      [pedido.id, d.lote_id, d.tipo_id, i.meia.motivo, i.meia.documento, i.meia.documentoExigido])

    const prefixo = String(d.slug || 'ING').replace(/[^a-zA-Z]/g, '').slice(0, 3) || 'ING'
    const { rows: [novo] } = await c.query(
      `INSERT INTO tickets (org_id, event_id, session_id, order_id, order_item_id,
                            sector_id, lot_id, ticket_type_id, code, qr_secret, status, is_courtesy,
                            holder_name, holder_email, holder_document,
                            half_reason, half_document, half_document_required)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,encode(gen_random_bytes(16),'hex'),'valido',false,
               $10,$11,$12,$13,$14,$15)
       RETURNING id, code`,
      [i.orgId, d.evento_id, d.session_id, pedido.id, item.id, d.setor_id, d.lote_id, d.tipo_id,
       gerarCodigo(prefixo), i.titular.nome, i.titular.email, i.titular.documento,
       i.meia.motivo, i.meia.documento, i.meia.documentoExigido])

    if (i.especie === 'meia') {
      try {
        await conferirCotaDeMeia(c, d.lote_id, 1)
      } catch (e) {
        if (e instanceof CotaDeMeiaEsgotada) {
          throw new RecusaDoReagendamento(409, 'A meia-entrada desse dia esgotou. Escolha outro dia.')
        }
        throw e
      }
    }

    // O antigo morre: QR recusado na portaria, vaga de volta pro lote dele.
    const morto = await c.query(
      `UPDATE tickets SET status = 'cancelado', canceled_at = now()
        WHERE id = $1 AND status = 'valido'`, [i.id])
    if (morto.rowCount !== 1) {
      throw new RecusaDoReagendamento(409, 'Este ingresso mudou agora há pouco. Recarregue a página.')
    }
    await c.query(`UPDATE lots SET sold = sold - 1 WHERE id = $1 AND sold >= 1`, [i.loteId])
    if (i.tipoId) {
      await c.query(`UPDATE ticket_types SET sold = sold - 1 WHERE id = $1 AND sold >= 1`, [i.tipoId])
    }

    // Rastro na MESMA transação (sem usuário da equipe: quem fez foi o cliente).
    const rastro = {
      conta: contaId, pedidoOriginal: i.pedido, pedidoNovo: pedido.code,
      codigoAnterior: i.codigo, codigoNovo: novo.code,
      de: { evento: i.eventoId, lote: i.loteId, tipo: i.tipoId },
      para: { evento: d.evento_id, lote: d.lote_id, tipo: d.tipo_id },
    }
    await c.query(
      `INSERT INTO audit_log (org_id, entity, entity_id, action, after)
       VALUES ($1,'ingresso',$2,'reagendado_pelo_cliente',$3::jsonb),
              ($1,'ingresso',$4,'emitido_por_reagendamento',$3::jsonb)`,
      [i.orgId, i.id, JSON.stringify(rastro), novo.id])

    return { pedido: pedido.code as string, ingresso: novo.id as string }
  })
}
