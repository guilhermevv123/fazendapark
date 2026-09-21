/**
 * POST /api/admin/evento — cria o evento.
 *
 * Nasce SEMPRE como rascunho, nunca publicado. Publicar é um ato separado
 * (PATCH de status) porque um evento recém-criado ainda não tem ingresso
 * configurado: publicar junto abriria uma página de venda sem nada pra vender.
 *
 * O slug é a única coisa aqui que o produtor não pode mudar depois sem
 * quebrar link já divulgado — então é gerado com cuidado e conferido contra
 * as rotas reservadas do próprio site.
 */
import { z } from 'zod'
import { q1, tx } from '../../../utils/db'

/**
 * Prefixos que já são rota do site. Um evento com slug "admin" ou "api"
 * sequestraria a rota — e o sintoma seria "a página de vendas abre o painel",
 * que ninguém liga a um cadastro feito três semanas antes.
 */
const RESERVADOS = new Set([
  'admin', 'api', 'e', 'p', 'ingressos', 'pedido', 'checkin', 'login',
  'sobre', 'termos', 'privacidade', 'suporte', 'ajuda', '_nuxt', 'assets',
])

const Entrada = z.object({
  orgId: z.string().uuid(),
  nome: z.string().min(3).max(140),
  slug: z.string().min(3).max(80).regex(/^[a-z0-9-]+$/).optional(),
  descricao: z.string().max(20_000).optional(),

  inicio: z.string().datetime({ offset: true }),
  fim: z.string().datetime({ offset: true }),
  fuso: z.string().max(60).default('America/Bahia'),
  esconderFim: z.boolean().default(false),

  // encerramento da venda: data fixa OU minutos após o início, nunca os dois
  encerraVendasEm: z.string().datetime({ offset: true }).nullish(),
  encerraVendasMinutosApos: z.number().int().min(0).max(10_080).nullish(),

  faixaEtaria: z.number().int().min(0).max(21).default(0),
  substantivo: z.string().max(40).default('Ingressos'),
  categoria: z.string().max(80).optional(),
  subcategorias: z.array(z.string().max(80)).max(10).default([]),
  tags: z.array(z.string().max(40)).max(20).default([]),

  online: z.boolean().default(false),
  linkTransmissao: z.string().url().optional(),
  local: z.object({
    nome: z.string().max(140).optional(),
    cep: z.string().max(9).optional(),
    endereco: z.string().max(200).optional(),
    numero: z.string().max(20).optional(),
    bairro: z.string().max(120).optional(),
    cidade: z.string().max(120).optional(),
    estado: z.string().length(2).optional(),
    complemento: z.string().max(140).optional(),
  }).default({}),

  banner: z.string().url().optional(),
  thumb: z.string().url().optional(),

  suporte: z.object({
    tipo: z.enum(['telefone', 'whatsapp', 'email']),
    valor: z.string().min(5).max(140),
  }).nullish(),

  taxaBps: z.number().int().min(0).max(5000).default(1000),
  modoTaxaOnline: z.enum(['repassar', 'absorver']).default('repassar'),
  modoTaxaPdv: z.enum(['repassar', 'absorver']).default('absorver'),
  maxPorCliente: z.number().int().min(1).max(200).nullish(),
  minutosDeReserva: z.number().int().min(5).max(120).default(20),
  privado: z.boolean().default(false),

  sessoes: z.array(z.object({
    titulo: z.string().max(80).optional(),
    inicio: z.string().datetime({ offset: true }),
    fim: z.string().datetime({ offset: true }),
  })).max(60).default([]),

  /**
   * A árvore de ingressos vem junto, e é gravada na MESMA transação do evento.
   *
   * O caminho óbvio seria criar o evento no passo 1 e ir configurando o resto
   * nos passos seguintes — e é assim que o banco enche de rascunho órfão de
   * gente que abriu o assistente, mudou de ideia e fechou a aba. Aqui, ou sai
   * o evento inteiro com setor, lote e tipo, ou não sai nada.
   *
   * `indiceSessao` amarra o setor a uma sessão que ainda não tem id: as
   * sessões são inseridas antes, e o índice vira o id real dentro da
   * transação.
   */
  setores: z.array(z.object({
    nome: z.string().min(1).max(120),
    tipo: z.enum(['ingresso', 'passaporte', 'mesa', 'camarote']).default('ingresso'),
    descricao: z.string().max(500).optional(),
    capacidade: z.number().int().min(1).max(1_000_000).nullish(),
    indiceSessao: z.number().int().min(0).max(59).nullish(),
    lotes: z.array(z.object({
      nome: z.string().min(1).max(120),
      faceCents: z.number().int().min(0).max(100_000_00),
      quantidade: z.number().int().min(1).max(1_000_000),
      minPorCompra: z.number().int().min(1).max(50).default(1),
      maxPorCompra: z.number().int().min(1).max(50).default(10),
      tipos: z.array(z.object({
        nome: z.string().min(1).max(80),
        quantidade: z.number().int().min(1).max(1_000_000),
        descontoBps: z.number().int().min(0).max(10_000).default(0),
        exigeDocumento: z.boolean().default(false),
      })).max(20).default([]),
    })).max(40).default([]),
  })).max(60).default([]),
})

export default defineEventHandler(async (event) => {
  const p = Entrada.safeParse(await readBody(event))
  if (!p.success) {
    throw createError({ statusCode: 400, statusMessage: 'Dados inválidos', data: p.error.flatten() })
  }
  const d = p.data

  if (new Date(d.fim) <= new Date(d.inicio)) {
    throw createError({ statusCode: 422, statusMessage: 'O término tem que ser depois do início' })
  }
  if (d.encerraVendasEm && d.encerraVendasMinutosApos != null) {
    throw createError({
      statusCode: 422,
      statusMessage: 'Escolha encerrar a venda por data OU por minutos após o início, não os dois',
    })
  }
  if (!d.online && !d.local.cidade) {
    throw createError({ statusCode: 422, statusMessage: 'Evento presencial precisa de cidade' })
  }
  if (d.online && !d.linkTransmissao) {
    throw createError({ statusCode: 422, statusMessage: 'Evento online precisa do link de transmissão' })
  }

  // A organização vem da SESSÃO, não do payload. Antes o `orgId` do corpo era
  // aceito como veio, e só se conferia que a organização existia — qualquer
  // login podia criar evento dentro da conta de outro produtor, com nome e
  // slug à escolha, e o evento nasceria no painel do vizinho.
  const orgId = (event.context as any).sessao?.orgId
  if (!orgId) throw createError({ statusCode: 401, statusMessage: 'Sessão sem organização' })
  if (d.orgId !== orgId) {
    throw createError({
      statusCode: 403,
      statusMessage: 'Você só cria evento na sua própria organização.',
    })
  }

  const slug = await slugLivre(d.slug ?? paraSlug(d.nome))

  const criado = await tx(async (c) => {
    const ev = await c.query(
      `INSERT INTO events (org_id, name, slug, description, status,
         starts_at, ends_at, sales_end_at, sales_end_minutes_after, timezone, hide_end_date,
         age_rating, ticket_noun, category, subcategories, tags,
         is_online, stream_url, venue_name, zip_code, address, address_number,
         neighborhood, city, state, complement, banner_url, thumb_url,
         support_kind, support_value, fee_bps, fee_mode_online, fee_mode_pos,
         max_per_customer, hold_minutes, is_private)
       VALUES ($1,$2,$3,$4,'rascunho',
         $5,$6,$7,$8,$9,$10,
         $11,$12,$13,$14,$15,
         $16,$17,$18,$19,$20,$21,
         $22,$23,$24,$25,$26,$27,
         $28,$29,$30,$31,$32,
         $33,$34,$35)
       RETURNING id, slug`,
      [orgId, d.nome.trim(), slug, d.descricao ?? null,
       d.inicio, d.fim, d.encerraVendasEm ?? null, d.encerraVendasMinutosApos ?? null,
       d.fuso, d.esconderFim,
       d.faixaEtaria, d.substantivo, d.categoria ?? null, d.subcategorias, d.tags,
       d.online, d.linkTransmissao ?? null, d.local.nome ?? null, d.local.cep ?? null,
       d.local.endereco ?? null, d.local.numero ?? null, d.local.bairro ?? null,
       d.local.cidade ?? null, d.local.estado ?? null, d.local.complemento ?? null,
       d.banner ?? null, d.thumb ?? null,
       d.suporte?.tipo ?? null, d.suporte?.valor ?? null,
       d.taxaBps, d.modoTaxaOnline, d.modoTaxaPdv,
       d.maxPorCliente ?? null, d.minutosDeReserva, d.privado])

    const id = ev.rows[0].id

    const idsSessao: string[] = []
    for (const [i, s] of d.sessoes.entries()) {
      const r = await c.query(
        `INSERT INTO event_sessions (event_id, title, starts_at, ends_at, sort_order)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [id, s.titulo ?? null, s.inicio, s.fim, i + 1])
      idsSessao.push(r.rows[0].id)
    }

    let nLotes = 0
    for (const [is, s] of d.setores.entries()) {
      if (s.indiceSessao != null && !idsSessao[s.indiceSessao]) {
        throw createError({
          statusCode: 422,
          statusMessage: `O setor "${s.nome}" aponta para uma sessão que não existe`,
        })
      }
      const soma = s.lotes.reduce((a, l) => a + l.quantidade, 0)
      if (s.capacidade && soma > s.capacidade) {
        throw createError({
          statusCode: 422,
          statusMessage: `"${s.nome}": os lotes somam ${soma} para uma capacidade de ${s.capacidade}`,
        })
      }

      const rs = await c.query(
        `INSERT INTO sectors (event_id, session_id, name, kind, description, capacity, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [id, s.indiceSessao != null ? idsSessao[s.indiceSessao] : null,
         s.nome.trim(), s.tipo, s.descricao ?? null, s.capacidade ?? null, is + 1])

      for (const [il, l] of s.lotes.entries()) {
        if (l.minPorCompra > l.maxPorCompra) {
          throw createError({
            statusCode: 422,
            statusMessage: `"${l.nome}": o mínimo por compra não pode passar do máximo`,
          })
        }
        const somaTipos = l.tipos.reduce((a, t) => a + t.quantidade, 0)
        if (somaTipos > l.quantidade) {
          throw createError({
            statusCode: 422,
            statusMessage: `"${l.nome}": os tipos somam ${somaTipos} de ${l.quantidade} disponíveis`,
          })
        }

        const rl = await c.query(
          `INSERT INTO lots (sector_id, name, price_cents, quantity,
                             min_per_order, max_per_order, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [rs.rows[0].id, l.nome.trim(), l.faceCents, l.quantidade,
           l.minPorCompra, l.maxPorCompra, il + 1])
        nLotes++

        for (const [it, t] of l.tipos.entries()) {
          await c.query(
            `INSERT INTO ticket_types (lot_id, name, quantity, discount_bps,
                                       requires_document, sort_order)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [rl.rows[0].id, t.nome.trim(), t.quantidade, t.descontoBps,
             t.exigeDocumento, it + 1])
        }
      }
    }

    await c.query(
      `INSERT INTO audit_log (entity, entity_id, action, after)
       VALUES ('event', $1, 'criado', $2::jsonb)`,
      [id, JSON.stringify({
        nome: d.nome, slug, sessoes: d.sessoes.length,
        setores: d.setores.length, lotes: nLotes,
      })])

    return { id, slug: ev.rows[0].slug }
  })

  return { ok: true, ...criado, status: 'rascunho' }
})

/** "Conquista Park 4ª Edição" → "conquista-park-4a-edicao" */
export function paraSlug(s: string) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70)
}

/** Acrescenta -2, -3… até achar um livre, e nunca devolve rota reservada. */
async function slugLivre(base: string) {
  let candidato = base || 'evento'
  for (let n = 1; n < 60; n++) {
    const colide = RESERVADOS.has(candidato)
      || await q1(`SELECT 1 FROM events WHERE slug = $1`, [candidato])
    if (!colide) return candidato
    candidato = `${base}-${n + 1}`
  }
  throw createError({ statusCode: 409, statusMessage: 'Não foi possível gerar um endereço livre' })
}
