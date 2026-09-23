/**
 * PATCH /api/admin/evento/:id/configuracoes — edita o cadastro do evento.
 *
 * É a rota do que a pessoa preencheu no assistente de criação. Separada da
 * rota de ingressos de propósito: lá se mexe em estoque e preço, aqui se mexe
 * em identidade, endereço e política. Misturar as duas faria uma tela de
 * endereço poder, por descuido de payload, baixar a quantidade de um lote.
 *
 * Três guardas que o banco sozinho não dá:
 *
 * - **slug** é a URL pública. Mudar depois de vender quebra todo link que já
 *   circulou, então só troca enquanto o evento é rascunho.
 * - **fim não pode vir antes do início** — o CHECK do banco não cobre isso, e
 *   a data invertida faz a janela de check-in fechar antes de abrir.
 * - **`sales_end_at` e `sales_end_minutes_after` se excluem** (é CHECK no
 *   banco). Preencher um limpa o outro aqui, senão a gravação morre com
 *   violação de constraint e a tela mostra "erro interno".
 *
 * E quatro sobre a situação e a data, porque aqui elas eram só rótulo:
 *
 * - **cancelado e adiado não se escolhem aqui.** Mudar o status pra
 *   'cancelado' fechava a vitrine e mais nada: pedido seguia pago, ingresso
 *   válido, catraca abrindo. Quem cancela é `cancelar.post.ts` (invalida e
 *   devolve); quem adia é `remarcar.post.ts` (avisa e dá a escolha).
 * - **cancelado não volta.** O dinheiro já está sendo devolvido e o ingresso
 *   já morreu; reabrir a venda venderia um evento sem ninguém dentro.
 * - **publicar exige ingresso.** Sem lote visível, a página abre sem nada
 *   pra vender.
 * - **com venda feita, a data não muda por aqui.** Quem comprou pro dia 10 e
 *   não foi avisado chega no portão no dia 10. Adiar é o caminho que avisa.
 */
import { z } from 'zod'
import { autorDaRequisicao, registrarAuditoria } from '../../../../utils/auditoria'
import { q1, tx } from '../../../../utils/db'
import { explicarErro } from '../index.post'

/**
 * URL externa (`https://…`, quem cola um link de fora) OU caminho relativo
 * do nosso proxy de imagem (`/api/midia/…`, o que o upload devolve).
 *
 * `.url()` sozinho travaria o próprio upload: `server/utils/storage-r2.ts`
 * NUNCA devolve URL absoluta de propósito — gravar `https://…` no banco
 * prende a imagem no domínio de HOJE (a mesma lição já paga no Diamond CRM,
 * `feedback_url-ambiente-persistido`: um deploy que mude de endereço deixa
 * pra trás todo banner salvo com o domínio velho).
 */
const UrlOuCaminhoDeImagem = z.string().max(600)
  .refine((v) => /^https?:\/\//.test(v) || v.startsWith('/'),
    'Use uma URL (https://…) ou envie um arquivo.')

const Entrada = z.object({
  nome: z.string().min(2).max(160).optional(),
  slug: z.string().min(3).max(80).regex(/^[a-z0-9-]+$/,
    'Use só letras minúsculas, números e hífen').optional(),
  descricao: z.string().max(20_000).nullish(),
  // 'cancelado' e 'adiado' continuam no enum SÓ pra a recusa sair com frase,
  // e não com "opção inválida" — ver a trava lá embaixo.
  status: z.enum(['rascunho', 'ativo', 'encerrado', 'cancelado', 'adiado', 'oculto']).optional(),
  comecaEm: z.string().datetime({ offset: true }).optional(),
  terminaEm: z.string().datetime({ offset: true }).optional(),
  vendaAte: z.string().datetime({ offset: true }).nullish(),
  vendaAteMinutos: z.number().int().min(0).max(10_080).nullish(),
  esconderFim: z.boolean().optional(),
  classificacao: z.number().int().min(0).max(21).optional(),
  substantivo: z.string().min(2).max(40).optional(),
  online: z.boolean().optional(),
  urlTransmissao: z.string().url().max(500).nullish().or(z.literal('')),
  local: z.string().max(160).nullish(),
  cep: z.string().max(12).nullish(),
  endereco: z.string().max(200).nullish(),
  numero: z.string().max(20).nullish(),
  bairro: z.string().max(120).nullish(),
  cidade: z.string().max(120).nullish(),
  uf: z.string().max(2).nullish(),
  complemento: z.string().max(160).nullish(),
  banner: UrlOuCaminhoDeImagem.nullish().or(z.literal('')),
  thumb: UrlOuCaminhoDeImagem.nullish().or(z.literal('')),
  categoria: z.string().max(60).nullish(),
  tags: z.array(z.string().max(40)).max(20).optional(),
  suporteTipo: z.enum(['telefone', 'whatsapp', 'email']).nullish(),
  suporteValor: z.string().max(160).nullish(),
  privado: z.boolean().optional(),
  minutosDeReserva: z.number().int().min(5).max(120).optional(),
  agruparPorSetor: z.boolean().optional(),
  taxaBps: z.number().int().min(0).max(5000).optional(),
  modoTaxaOnline: z.enum(['repassar', 'absorver']).optional(),
  modoTaxaPdv: z.enum(['repassar', 'absorver']).optional(),
  maxPorCliente: z.number().int().min(1).max(200).nullish(),
})

const COLUNA: Record<string, string> = {
  nome: 'name', slug: 'slug', descricao: 'description', status: 'status',
  comecaEm: 'starts_at', terminaEm: 'ends_at',
  vendaAte: 'sales_end_at', vendaAteMinutos: 'sales_end_minutes_after',
  esconderFim: 'hide_end_date', classificacao: 'age_rating', substantivo: 'ticket_noun',
  online: 'is_online', urlTransmissao: 'stream_url',
  local: 'venue_name', cep: 'zip_code', endereco: 'address', numero: 'address_number',
  bairro: 'neighborhood', cidade: 'city', uf: 'state', complemento: 'complement',
  banner: 'banner_url', thumb: 'thumb_url', categoria: 'category', tags: 'tags',
  suporteTipo: 'support_kind', suporteValor: 'support_value',
  privado: 'is_private', minutosDeReserva: 'hold_minutes', agruparPorSetor: 'group_by_sector',
  taxaBps: 'fee_bps', modoTaxaOnline: 'fee_mode_online', modoTaxaPdv: 'fee_mode_pos',
  maxPorCliente: 'max_per_customer',
}

/** O nome do campo como a tela de Configurações mostra — pro erro dizer QUAL. */
const ROTULO: Record<string, string> = {
  nome: 'Nome do evento', slug: 'Endereço público', descricao: 'Descrição', status: 'Situação',
  comecaEm: 'Começa em', terminaEm: 'Termina em', vendaAte: 'Venda encerra em',
  vendaAteMinutos: 'Minutos após o início', esconderFim: 'Não mostrar a data de término',
  classificacao: 'Classificação etária', substantivo: 'Como chamar o ingresso',
  urlTransmissao: 'Link da transmissão', local: 'Nome do local', cep: 'CEP',
  endereco: 'Endereço', numero: 'Número', bairro: 'Bairro', cidade: 'Cidade', uf: 'UF',
  complemento: 'Complemento', banner: 'Banner', thumb: 'Miniatura', categoria: 'Categoria',
  tags: 'Tags', suporteTipo: 'Canal de suporte', suporteValor: 'Contato de suporte',
  minutosDeReserva: 'Minutos de reserva no carrinho', taxaBps: 'Taxa de serviço',
  modoTaxaOnline: 'Taxa no site', modoTaxaPdv: 'Taxa na bilheteria',
  maxPorCliente: 'Máximo por cliente',
}

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  const p = Entrada.safeParse(await readBody(event))
  if (!p.success) {
    throw createError({
      statusCode: 400,
      statusMessage: explicarErro(p.error, ROTULO),
      data: p.error.flatten(),
    })
  }
  const campos = { ...p.data }

  // `vendidos` conta pedido pago e estornado parcial: o parcial ainda tem
  // ingresso válido e gente vindo, e é gente que precisa ser avisada.
  const atual = await q1<any>(
    `SELECT id, org_id, slug, status, starts_at, ends_at,
            (SELECT count(*) FROM orders WHERE event_id = events.id
                AND status IN ('pago', 'estornado_parcial'))::int AS vendidos
       FROM events WHERE id = $1`, [id])
  if (!atual) throw createError({ statusCode: 404, statusMessage: 'Evento não encontrado' })

  // Mandar a situação que já está gravada não é mudança — a tela manda o
  // formulário que o operador viu, e o status igual não pode esbarrar nas
  // travas de baixo.
  if (campos.status === atual.status) delete campos.status

  if (atual.status === 'cancelado' && campos.status) {
    throw createError({
      statusCode: 409,
      statusMessage: 'Evento cancelado não volta a vender: os ingressos foram invalidados e '
        + 'as compras estão na fila de devolução. Para vender de novo, crie um evento novo.',
    })
  }
  if (campos.status === 'cancelado') {
    throw createError({
      statusCode: 422,
      statusMessage: 'Cancelar é pelo botão "Cancelar evento e devolver", no fim desta tela — '
        + 'é ele que invalida os ingressos e devolve o dinheiro.',
    })
  }
  if (campos.status === 'adiado') {
    throw createError({
      statusCode: 422,
      statusMessage: 'Adiar é pelo bloco "Adiar para outra data", no fim desta tela — '
        + 'é ele que muda a data e avisa quem comprou.',
    })
  }

  // Publicar (ou deixar vendendo por link) sem nada à venda abre uma página
  // vazia. Lote com preço zero só existe com a marca de gratuito (as rotas de
  // ingresso recusam R$ 0,00 sem ela), então "visível e com estoque" basta.
  if (campos.status === 'ativo' || campos.status === 'oculto') {
    const tem = await q1<any>(
      `SELECT 1 FROM lots l JOIN sectors s ON s.id = l.sector_id
        WHERE s.event_id = $1 AND l.visible AND l.quantity > 0 LIMIT 1`, [id])
    if (!tem) {
      throw createError({
        statusCode: 422,
        statusMessage: 'Cadastre pelo menos um ingresso antes de publicar — '
          + 'nenhum lote deste evento está visível à venda.',
      })
    }
  }

  // Data mexida com venda feita: o comprador não fica sabendo e chega no dia
  // velho. Compara o INSTANTE, não o texto — a tela pode mandar o mesmo
  // horário em outro formato.
  const mexeNaData = (novo: string | undefined, velho: string | Date) =>
    novo !== undefined && new Date(novo).getTime() !== new Date(velho).getTime()
  if (atual.vendidos > 0
      && (mexeNaData(campos.comecaEm, atual.starts_at) || mexeNaData(campos.terminaEm, atual.ends_at))) {
    throw createError({
      statusCode: 409,
      statusMessage: 'Com ingressos vendidos, mude a data por Adiar evento — os compradores são avisados.',
    })
  }

  if (campos.slug && campos.slug !== atual.slug && atual.vendidos > 0) {
    throw createError({
      statusCode: 409,
      statusMessage: 'O endereço do evento não muda depois da primeira venda — '
        + 'todo link já divulgado pararia de funcionar.',
    })
  }

  // Fim antes do início. Compara contra o que JÁ está gravado quando só uma
  // das duas datas vem no payload — senão mudar só a data de início passa
  // livre e deixa o evento invertido.
  const comeca = campos.comecaEm ? new Date(campos.comecaEm) : new Date(atual.starts_at)
  const termina = campos.terminaEm ? new Date(campos.terminaEm) : new Date(atual.ends_at)
  if (termina.getTime() < comeca.getTime()) {
    throw createError({
      statusCode: 422,
      statusMessage: 'O fim do evento não pode ser antes do início.',
    })
  }

  // CHECK do banco: as duas formas de encerrar a venda se excluem. Quem
  // preenche uma zera a outra aqui, com a intenção explícita.
  if (campos.vendaAte) campos.vendaAteMinutos = null
  else if (campos.vendaAteMinutos != null) campos.vendaAte = null

  // string vazia de campo de URL é "apagar", não "gravar ''"
  for (const k of ['urlTransmissao', 'banner', 'thumb'] as const) {
    if (campos[k] === '') (campos as any)[k] = null
  }
  if (campos.uf) campos.uf = campos.uf.toUpperCase()

  const set: string[] = []
  const par: any[] = [id]
  for (const [chave, valor] of Object.entries(campos)) {
    const col = COLUNA[chave]
    if (!col || valor === undefined) continue
    par.push(valor)
    set.push(`${col} = $${par.length}`)
  }
  if (!set.length) return { ok: true, semMudanca: true }

  return await tx(async (c) => {
    try {
      const { rows } = await c.query(
        `UPDATE events SET ${set.join(', ')}, updated_at = now()
          WHERE id = $1 RETURNING id, slug, status`, par)
      await registrarAuditoria({
        autor: autorDaRequisicao(event),
        entidade: 'evento',
        entidadeId: id!,
        acao: 'editado',
        depois: campos,
      }, c)
      return { ok: true, evento: rows[0] }
    } catch (e: any) {
      // 23505 = unique_violation. O slug é o único campo aqui com índice
      // único, e "já existe" é informação do usuário, não erro de servidor.
      if (e?.code === '23505') {
        throw createError({
          statusCode: 409,
          statusMessage: `O endereço "${campos.slug}" já está em uso por outro evento.`,
        })
      }
      throw e
    }
  })
})
