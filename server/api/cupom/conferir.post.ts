/**
 * POST /api/cupom/conferir — o cupom vale, ANTES de apertar pagar.
 *
 * Por que esta rota existe: até agora o comprador só descobria que o cupom não
 * servia no clique final. Ele digitava nome, e-mail, CPF, escolhia PIX, apertava
 * "Pagar com PIX" e levava de volta "O cupom X venceu em 03/09/2026". O código
 * do cupom quase sempre veio de um story, de um panfleto ou de um promoter — ou
 * seja, a chance de estar errado é alta e a descoberta acontecia no pior
 * instante possível, o do cartão na mão.
 *
 * ## Três regras que valem o arquivo
 *
 * 1. **A régua é a MESMA do checkout.** Quem decide aqui é `resgatarCupom`
 *    (utils/cupom.ts), o mesmíssimo código que roda na hora de cobrar, com as
 *    mesmas frases. Escrever uma segunda validação "só pra tela" é como a tela
 *    passa a dizer sim onde a cobrança diz não — e a segunda cópia sempre
 *    envelhece primeiro.
 *
 * 2. **Preço nunca vem do navegador.** O desconto que esta rota mostra é
 *    calculado com as faces RELIDAS do banco a partir dos ids do carrinho, e
 *    somado por `aplicarCupom` — a mesma função do checkout. Aceitar
 *    `faceCents` do cliente aqui seria oferecer ao comprador a chance de
 *    escolher quanto o desconto vale.
 *
 * 3. **Conferir não é reservar.** Esta rota não grava nada: não cria pedido,
 *    não soma `promo_codes.uses`, não segura vaga. O cupom que vale agora pode
 *    ter acabado daqui a dois minutos, e quem dá a palavra final continua sendo
 *    o checkout, com a linha do cupom travada. A resposta é uma PRÉVIA, e o
 *    texto da tela diz isso.
 *
 * ## Por que 200 mesmo quando o cupom não vale
 *
 * "Este cupom venceu" é uma RESPOSTA, não uma falha da requisição. Devolver 409
 * faria `$fetch` lançar exceção no caminho normal da conferência, e o try/catch
 * viraria fluxo de controle pra uma pergunta que foi respondida direitinho. O
 * checkout continua com 409 porque lá a compra realmente não aconteceu.
 */
import { z } from 'zod'
import { q, q1, tx } from '../../utils/db'
import { aplicarCupom, CupomRecusado, resgatarCupom } from '../../utils/cupom'
import { faceDoTipo, type ModoTaxa } from '../../utils/dinheiro'
import { cpfValido } from '../../utils/documento'
import { estaPublicado, portaDeVenda } from '../e/[slug].get'

const Entrada = z.object({
  eventSlug: z.string().min(1),
  codigo: z.string().trim().min(1).max(40),
  /**
   * CPF de quem vai comprar, só dígitos. É OPCIONAL de propósito: o comprador
   * costuma digitar o cupom antes do CPF, e travar a conferência até o CPF
   * existir devolveria o problema ao lugar de onde ele saiu. Sem CPF a
   * conferência roda PARCIAL — tudo menos "uma vez por pessoa" — e a resposta
   * diz isso em `parcial`.
   */
  documento: z.string().max(18).optional(),
  /**
   * O carrinho, só com ids e quantidade. Serve pra duas coisas: a restrição por
   * lote do cupom (`promo_codes.lot_ids`) e a prévia do desconto. Sem itens a
   * conferência ainda responde — só não mostra o valor.
   */
  itens: z.array(z.object({
    lotId: z.string().uuid(),
    ticketTypeId: z.string().uuid().nullish(),
    quantidade: z.number().int().positive().max(50),
  })).max(20).optional(),
})

export default defineEventHandler(async (event) => {
  const p = Entrada.safeParse(await readBody(event))
  if (!p.success) {
    throw createError({ statusCode: 400, statusMessage: 'Dados inválidos', data: p.error.flatten() })
  }
  const dados = p.data
  const codigo = dados.codigo.toUpperCase()
  const documento = (dados.documento ?? '').replace(/\D/g, '')
  // CPF pela metade não é CPF: mandar os 5 dígitos já digitados pra contagem
  // de "uma vez por pessoa" acharia zero usos e daria um sim que não vale.
  const doc = cpfValido(documento) ? documento : ''

  const ev = await q1<any>(
    `SELECT id, status, starts_at, ends_at, sales_end_at, sales_end_minutes_after,
            timezone, fee_bps, fee_mode_online
       FROM events WHERE slug = $1`, [dados.eventSlug])
  // Rascunho e oculto respondem o MESMO 404 do slug que não existe, igual à
  // vitrine. Medido antes desta linha: `GET /api/e/zz-auditor-rascunho` → 404
  // (idêntico a um slug inventado), e esta rota → 200 com
  // `motivo: "venda_fechada"`. A diferença entre as duas respostas é a
  // confirmação de que o evento EXISTE e está sendo preparado — exatamente o
  // que a vitrine se dá ao trabalho de esconder, entregue por uma rota nova
  // que ninguém precisa de login pra chamar. Cupom de pré-venda fechada vaza
  // o lançamento junto.
  if (!ev || !estaPublicado(ev)) {
    throw createError({ statusCode: 404, statusMessage: 'Evento não encontrado' })
  }

  // Evento fechado não tem cupom bom: a mesma porta do checkout, a mesma frase.
  const porta = portaDeVenda(ev)
  if (!porta.aberta) {
    return { ok: false, codigo, motivo: 'venda_fechada', recado: porta.recado, parcial: false }
  }

  const itens = dados.itens ?? []
  const linhas = itens.length ? await facesDoBanco(ev, itens) : []

  try {
    // `tx` porque `resgatarCupom` trava a linha do cupom antes de contar — é o
    // que faz dele a régua de verdade e não uma cópia. A transação é curta e
    // não escreve nada; o COMMIT solta a trava no mesmo milissegundo.
    const cupom = await tx((c) => resgatarCupom(c, {
      eventId: ev.id, codigo, documento: doc,
      lotIdsDoPedido: itens.map((i) => i.lotId),
      fuso: ev.timezone,
    }))

    // Prévia do desconto — só quando há carrinho pra descontar.
    const total = linhas.length
      ? aplicarCupom(linhas, Number(ev.fee_bps), ev.fee_mode_online as ModoTaxa, cupom)
      : null

    return {
      ok: true,
      codigo: cupom.codigo,
      parcial: !doc,
      descontoCents: total?.discountCents ?? null,
      totalCents: total?.totalCents ?? null,
      recado: total
        ? `Cupom ${cupom.codigo} aplicado.`
        : `Cupom ${cupom.codigo} é válido.`,
    }
  } catch (e: any) {
    if (e instanceof CupomRecusado) {
      return { ok: false, codigo, motivo: e.motivo, recado: e.recado, parcial: false }
    }
    throw e
  }
})

/**
 * As faces dos itens do carrinho, RELIDAS do banco — id entra, preço sai.
 *
 * Mesma leitura do checkout, e de propósito: é ela que impede a prévia de
 * desconto de sair de um preço que o navegador mandou. Lote de outro evento
 * para aqui com 400, igual lá.
 */
async function facesDoBanco(ev: any, itens: any[]) {
  const lotIds = [...new Set(itens.map((i) => i.lotId))]
  const lotes = await q<any>(
    `SELECT l.id, l.price_cents, s.event_id
       FROM lots l JOIN sectors s ON s.id = l.sector_id
      WHERE l.id = ANY($1::uuid[])`, [lotIds])
  const porLote = new Map(lotes.map((l) => [l.id, l]))

  const tipoIds = itens.map((i) => i.ticketTypeId).filter(Boolean) as string[]
  const tipos = tipoIds.length
    ? await q<any>(`SELECT id, lot_id, discount_bps FROM ticket_types WHERE id = ANY($1::uuid[])`,
        [tipoIds])
    : []
  const porTipo = new Map(tipos.map((t) => [t.id, t]))

  return itens.map((it) => {
    const lote = porLote.get(it.lotId)
    if (!lote) throw createError({ statusCode: 404, statusMessage: 'Lote não encontrado' })
    if (lote.event_id !== ev.id) {
      throw createError({ statusCode: 400, statusMessage: 'Lote não pertence a este evento' })
    }
    let face = Number(lote.price_cents)
    if (it.ticketTypeId) {
      const t = porTipo.get(it.ticketTypeId)
      if (!t) throw createError({ statusCode: 404, statusMessage: 'Tipo de ingresso não encontrado' })
      if (t.lot_id !== it.lotId) {
        throw createError({ statusCode: 400, statusMessage: 'Tipo de ingresso não é deste lote' })
      }
      face = faceDoTipo(face, Number(t.discount_bps), Number(ev.fee_bps), ev.fee_mode_online as ModoTaxa)
    }
    return { quantidade: it.quantidade, faceUnitCents: face }
  })
}
