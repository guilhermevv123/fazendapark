/**
 * Comandas (055) — consumo com pulseira NFC, pago no fim do dia.
 *
 * Tudo da comanda passa por este arquivo: quem pode o quê, a conta (total, pago, falta),
 * o vínculo pulseira↔conta, o lançamento que chega do tablet (com ou sem internet) e a
 * linha do tempo. As rotas em `server/api/comandas/` só leem o pedido, chamam daqui e
 * respondem.
 *
 * ## As três regras que seguram o resto
 *
 * 1. **A pulseira não guarda nada.** Ela é o número que o leitor digita. A conta é a
 *    comanda; a pulseira só aponta pra ela enquanto o vínculo está aberto. Pagou → o
 *    vínculo fecha → a próxima leitura daquela pulseira vê uma pulseira LIVRE.
 * 2. **Nada some.** Item errado vira cancelado (quem, quando, motivo); pagamento errado
 *    vira anulado; conta juntada aponta pra onde foi. Todo ato vai pra `comanda_historico`.
 * 3. **O pedido do tablet sobe uma vez só.** O `id_local` nasce no tablet; reenviar o
 *    mesmo pedido (internet que vai e volta) devolve o que já foi gravado, sem lançar de
 *    novo. Pedido que chega depois de a conta fechar NÃO é recusado: entra marcado como
 *    pendência pro gerente decidir.
 *
 * Dinheiro em centavos inteiros, como em todo o sistema.
 */
import bcrypt from 'bcryptjs'
import { createHash } from 'node:crypto'
import type { H3Event } from 'h3'
import type { PoolClient } from 'pg'
import { q, q1, tx } from './db'

export type Nivel = 'atendente' | 'caixa' | 'gerente'
const ORDEM: Record<Nivel, number> = { atendente: 1, caixa: 2, gerente: 3 }

export function nivelCobre(tem: Nivel, precisa: Nivel): boolean {
  return ORDEM[tem] >= ORDEM[precisa]
}

export interface ContextoDaComanda {
  orgId: string
  usuarioId: string
  nome: string
  email: string
  nivel: Nivel
  master: boolean
  aparelho: string | null
  /** entrou pelo link do funcionário (não é usuário do sistema): o id do link */
  linkId?: string | null
}

export interface ConfigDaComanda {
  ativo: boolean
  limitePadraoCents: number
  atendenteFechaConta: boolean
  minutosParaDesfazer: number
  avisoContaAltaCents: number
  exigeCodigoWhatsapp: boolean
  /** "HH:MM", horário da Bahia: a partir daí o resumo do dia conta quem saiu sem pagar */
  horaFechamento: string
}

export const CONFIG_PADRAO: ConfigDaComanda = {
  ativo: false,
  limitePadraoCents: 0, // sem limite (o dono, 11/11/2026); o gerente pode pôr um em Equipe e regras
  atendenteFechaConta: true, // atendente e caixa fecham conta (o dono, 11/11/2026)
  minutosParaDesfazer: 5,
  avisoContaAltaCents: 50000,
  exigeCodigoWhatsapp: true,
  horaFechamento: '18:00',
}

export async function configDaComanda(orgId: string): Promise<ConfigDaComanda> {
  const r = await q1<any>(`SELECT * FROM comanda_config WHERE org_id = $1`, [orgId])
  if (!r) return { ...CONFIG_PADRAO }
  return {
    ativo: r.ativo,
    limitePadraoCents: Number(r.limite_padrao_cents),
    atendenteFechaConta: r.atendente_fecha_conta,
    minutosParaDesfazer: r.minutos_para_desfazer,
    avisoContaAltaCents: Number(r.aviso_conta_alta_cents),
    exigeCodigoWhatsapp: r.exige_codigo_whatsapp,
    horaFechamento: r.hora_fechamento ?? CONFIG_PADRAO.horaFechamento,
  }
}

/** O contexto que o `middleware/04.comandas.ts` deixou. Explode se a rota escapou dele. */
export function ctx(event: H3Event): ContextoDaComanda {
  const c = (event.context as any).comanda as ContextoDaComanda | undefined
  if (!c) throw new Error('comandas: rota sem o porteiro de /api/comandas')
  return c
}

/** Recusa com a frase que o atendente entende. */
export function exigirNivel(event: H3Event, precisa: Nivel): ContextoDaComanda {
  const c = ctx(event)
  if (!nivelCobre(c.nivel, precisa)) {
    const nome = { atendente: 'atendente', caixa: 'caixa', gerente: 'gerente' }[precisa]
    throw createError({ statusCode: 403, statusMessage: `Isto é do ${nome}. Chame o gerente.` })
  }
  return c
}

/** Erro de regra (não de sistema): 422 com a mensagem e um código pra tela decidir o que mostrar. */
export function recusa(mensagem: string, codigo: string, extra: Record<string, unknown> = {}): never {
  throw createError({ statusCode: 422, statusMessage: mensagem, data: { codigo, ...extra } })
}

/* ------------------------------------------------------------------ PIN do gerente */

/**
 * Confere o PIN do gerente digitado no tablet. Devolve quem liberou (pra linha do tempo).
 * O próprio usuário gerente/master não precisa de PIN: quem já é gerente libera sozinho.
 */
export async function liberacaoDoGerente(
  c: ContextoDaComanda, pin: unknown,
): Promise<{ id: string; nome: string } | null> {
  if (c.nivel === 'gerente') return { id: c.usuarioId, nome: c.nome }
  const p = String(pin ?? '').replace(/\D/g, '')
  if (p.length < 4 || p.length > 6) return null
  // Chute de PIN: 5 erros seguidos travam este usuário por 15 minutos (mesmo com o PIN certo).
  const chave = `${c.orgId}:${c.usuarioId}`
  const t = tentativasDePin.get(chave)
  if (t && t.travadoAte > Date.now()) {
    recusa('PIN errado muitas vezes. Espere 15 minutos ou chame o gerente para liberar no tablet dele.', 'pin_travado')
  }
  const gerentes = await q<any>(
    `SELECT a.user_id, a.pin_hash, u.name FROM comanda_acessos a JOIN users u ON u.id = a.user_id
      WHERE a.org_id = $1 AND a.nivel = 'gerente' AND a.pin_hash IS NOT NULL AND u.active`,
    [c.orgId])
  for (const g of gerentes) {
    if (await bcrypt.compare(p, g.pin_hash)) { tentativasDePin.delete(chave); return { id: g.user_id, nome: g.name } }
  }
  const erros = (t && t.travadoAte <= Date.now() && t.travadoAte > 0 ? 0 : t?.erros ?? 0) + 1
  tentativasDePin.set(chave, { erros: erros >= 5 ? 0 : erros, travadoAte: erros >= 5 ? Date.now() + 15 * 60_000 : 0 })
  if (erros >= 5) {
    await registrar(null, c, { acao: 'pin_travado', descricao: `PIN do gerente errado 5 vezes por ${c.nome} — travado por 15 minutos` }).catch(() => {})
  }
  return null
}
const tentativasDePin = new Map<string, { erros: number; travadoAte: number }>()

export async function exigirGerente(c: ContextoDaComanda, pin: unknown) {
  const g = await liberacaoDoGerente(c, pin)
  if (!g) recusa('Precisa do PIN do gerente para isto.', 'precisa_gerente')
  return g
}

/* ------------------------------------------------------------------ linha do tempo */

export interface Registro {
  comandaId?: string | null
  acao: string
  descricao: string
  detalhes?: Record<string, unknown> | null
}

export async function registrar(cl: PoolClient | null, c: ContextoDaComanda, r: Registro) {
  const sql = `INSERT INTO comanda_historico (org_id, comanda_id, quem, quem_nome, aparelho, acao, descricao, detalhes)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`
  const par = [c.orgId, r.comandaId ?? null, c.usuarioId, c.nome, c.aparelho, r.acao, r.descricao,
    r.detalhes ? JSON.stringify(r.detalhes) : null]
  if (cl) await cl.query(sql, par)
  else await q(sql, par)
}

/* ------------------------------------------------------------------ a conta */

/** Expressões da conta, num lugar só. `c` é o alias de `comandas`. */
export const SQL_TOTAL_ITENS = `COALESCE((SELECT SUM(i.preco_cents * i.quantidade - i.desconto_cents)
  FROM comanda_lancamento_itens i WHERE i.comanda_id = c.id AND NOT i.cancelado), 0)`
export const SQL_TOTAL = `GREATEST(${SQL_TOTAL_ITENS} - c.desconto_cents, 0)`
export const SQL_PAGO = `COALESCE((SELECT SUM(p.valor_cents) FROM comanda_pagamentos p
  WHERE p.comanda_id = c.id AND NOT p.anulado), 0)`
export const SQL_PULSEIRA_ATIVA = `(SELECT pu.uid FROM comanda_vinculos v JOIN comanda_pulseiras pu ON pu.id = v.pulseira_id
  WHERE v.comanda_id = c.id AND v.fim_em IS NULL ORDER BY v.inicio_em DESC LIMIT 1)`

export interface ResumoDaConta {
  id: string
  numero: number
  situacao: string
  nome: string
  responsavelNome: string
  responsavelTelefone: string | null
  dadosConfirmados: boolean
  origem: string
  orderId: string | null
  menorDeIdade: boolean
  limiteCents: number
  totalCents: number
  pagoCents: number
  faltaCents: number
  abertaEm: string
  fechadaEm: string | null
  pulseira: string | null
  ultimoPedidoEm: string | null
}

export const SQL_RESUMO = `
  SELECT c.id, c.numero, c.situacao, c.nome, c.responsavel_nome, c.responsavel_telefone,
         c.dados_confirmados, c.origem, c.order_id, c.menor_de_idade, c.limite_cents,
         c.aberta_em, c.fechada_em,
         ${SQL_TOTAL} AS total_cents, ${SQL_PAGO} AS pago_cents, ${SQL_PULSEIRA_ATIVA} AS pulseira,
         (SELECT MAX(l.feito_em) FROM comanda_lancamentos l WHERE l.comanda_id = c.id) AS ultimo_pedido_em
    FROM comandas c`

export function resumoDaLinha(r: any): ResumoDaConta {
  const total = Number(r.total_cents)
  const pago = Number(r.pago_cents)
  return {
    id: r.id,
    numero: Number(r.numero),
    situacao: r.situacao,
    nome: r.nome,
    responsavelNome: r.responsavel_nome,
    responsavelTelefone: r.responsavel_telefone,
    dadosConfirmados: r.dados_confirmados,
    origem: r.origem,
    orderId: r.order_id,
    menorDeIdade: r.menor_de_idade,
    limiteCents: Number(r.limite_cents),
    totalCents: total,
    pagoCents: pago,
    faltaCents: Math.max(total - pago, 0),
    abertaEm: r.aberta_em,
    fechadaEm: r.fechada_em,
    pulseira: r.pulseira ?? null,
    ultimoPedidoEm: r.ultimo_pedido_em ?? null,
  }
}

export async function resumoDaComanda(orgId: string, id: string, cl?: PoolClient): Promise<ResumoDaConta | null> {
  const sql = `${SQL_RESUMO} WHERE c.org_id = $1 AND c.id = $2`
  const r = cl ? (await cl.query(sql, [orgId, id])).rows[0] : await q1<any>(sql, [orgId, id])
  return r ? resumoDaLinha(r) : null
}

/** Segue `juntada_em` até a conta que recebeu tudo (máx. 10 saltos, pra nunca girar em círculo). */
export async function contaFinal(cl: PoolClient, orgId: string, id: string): Promise<string> {
  let atual = id
  for (let i = 0; i < 10; i++) {
    const r = (await cl.query(`SELECT situacao, juntada_em FROM comandas WHERE org_id = $1 AND id = $2`, [orgId, atual])).rows[0]
    if (!r || r.situacao !== 'juntada' || !r.juntada_em) return atual
    atual = r.juntada_em
  }
  return atual
}

/* ------------------------------------------------------------------ pulseira */

/** Normaliza o que o leitor digitou. Só letras e números; o zero da frente fica. */
/**
 * Confere o PIN do link do funcionário (o link sozinho não abre). Certo: fica lembrado 10 min
 * na memória para o tablet não pagar o bcrypt a cada 6 s.
 *
 * Chute de PIN: a tentativa é RESERVADA no banco (um UPDATE atômico) ANTES de conferir — mandar
 * vários palpites ao mesmo tempo não escapa da conta. 5 erros travam o link 15 min; 20 erros no
 * total desligam o link de vez (o gerente gera outro). O PIN certo zera só os 5 da vez.
 */
export async function conferirPinDoLink(link: { id: string; pin_hash: string | null }, bruto: unknown) {
  const negar = (mensagem: string, codigo: string): never => {
    throw createError({ statusCode: 401, statusMessage: mensagem, data: { codigo } })
  }
  if (!link.pin_hash) negar('Este código é antigo e não tem PIN. Peça um código novo ao gerente.', 'link_sem_pin')
  const pin = String(bruto ?? '').replace(/\D/g, '')
  if (pin.length !== 4) negar('Digite o seu PIN de 4 números.', 'pin')
  const chave = `${link.id}:${hashDoLink(link.pin_hash + pin)}`
  if ((pinsDoLink.get(chave) ?? 0) > Date.now()) return

  // reserva a tentativa: só passa quem não está travado e ainda tem tentativa
  const vez = await q1<{ erros_pin: number }>(
    `UPDATE comanda_links SET erros_pin = erros_pin + 1, erros_total = erros_total + 1
      WHERE id = $1 AND desativado_em IS NULL AND (travado_ate IS NULL OR travado_ate <= now()) AND erros_pin < 5
      RETURNING erros_pin`, [link.id])
  if (!vez) negar('PIN errado muitas vezes. Espere 15 minutos ou peça ao gerente um código novo.', 'pin_travado')

  if (await bcrypt.compare(pin, link.pin_hash!)) {
    pinsDoLink.set(chave, Date.now() + 10 * 60_000)
    // acertou: devolve a tentativa reservada (não conta como erro) e zera os erros da vez
    await q(`UPDATE comanda_links SET erros_pin = 0, erros_total = GREATEST(erros_total - 1, 0) WHERE id = $1`, [link.id])
    return
  }
  const r = await q1<any>(
    `UPDATE comanda_links
        SET travado_ate = CASE WHEN erros_pin >= 5 THEN now() + interval '15 minutes' ELSE travado_ate END,
            erros_pin = CASE WHEN erros_pin >= 5 THEN 0 ELSE erros_pin END,
            desativado_em = CASE WHEN erros_total >= 20 THEN now() ELSE desativado_em END
      WHERE id = $1 RETURNING erros_pin, travado_ate, desativado_em`, [link.id])
  if (r?.desativado_em) negar('PIN errado vezes demais. Este código foi desligado: peça um código novo ao gerente.', 'link')
  if (r?.travado_ate && new Date(r.travado_ate).getTime() > Date.now()) {
    negar('PIN errado 5 vezes. O acesso ficou travado por 15 minutos.', 'pin_travado')
  }
  negar(`PIN errado. Restam ${5 - Number(r?.erros_pin ?? 0)} tentativa(s).`, 'pin')
}
const pinsDoLink = new Map<string, number>()

/** O segredo do link do funcionário nunca é guardado: só o hash. */
export function hashDoLink(segredo: string): string {
  return createHash('sha256').update(segredo).digest('hex')
}

export function uidLimpo(bruto: unknown): string | null {
  const u = String(bruto ?? '').trim().replace(/[^0-9A-Za-z]/g, '')
  return /^[0-9A-Za-z]{4,24}$/.test(u) ? u : null
}

export type SituacaoDaPulseira =
  | { tipo: 'nao_cadastrada'; uid: string }
  | { tipo: 'bloqueada'; uid: string; motivo: string | null }
  | { tipo: 'descartada'; uid: string }
  | { tipo: 'livre'; uid: string; pulseiraId: string }
  | { tipo: 'em_uso'; uid: string; pulseiraId: string; conta: ResumoDaConta }

export async function situacaoDaPulseira(orgId: string, uidBruto: unknown): Promise<SituacaoDaPulseira> {
  const uid = uidLimpo(uidBruto)
  if (!uid) recusa('Leitura inválida. Encoste a pulseira de novo.', 'leitura_invalida')
  const p = await q1<any>(`SELECT * FROM comanda_pulseiras WHERE org_id = $1 AND uid = $2`, [orgId, uid])
  if (!p) return { tipo: 'nao_cadastrada', uid }
  if (p.descartada) return { tipo: 'descartada', uid }
  if (p.bloqueada) return { tipo: 'bloqueada', uid, motivo: p.motivo }
  const v = await q1<any>(
    `SELECT comanda_id FROM comanda_vinculos WHERE pulseira_id = $1 AND fim_em IS NULL`, [p.id])
  if (!v) return { tipo: 'livre', uid, pulseiraId: p.id }
  const conta = await resumoDaComanda(orgId, v.comanda_id)
  if (!conta) return { tipo: 'livre', uid, pulseiraId: p.id }
  return { tipo: 'em_uso', uid, pulseiraId: p.id, conta }
}

/** Fecha todo vínculo ativo da conta (pagou, encerrou o dia, juntou). A pulseira volta a ficar livre. */
export async function soltarPulseiras(cl: PoolClient, c: ContextoDaComanda, comandaId: string, motivo: string) {
  await cl.query(
    `UPDATE comanda_vinculos SET fim_em = now(), fim_por = $2, fim_motivo = $3
      WHERE comanda_id = $1 AND fim_em IS NULL`, [comandaId, c.usuarioId, motivo])
}

/* ------------------------------------------------------------------ o grupo (quem comprou junto) */

/** As outras contas do mesmo pedido de ingresso, abertas ou não, do dia. */
export async function grupoDaConta(orgId: string, conta: { id: string; orderId: string | null }) {
  if (!conta.orderId) return []
  const linhas = await q<any>(
    `${SQL_RESUMO} WHERE c.org_id = $1 AND c.order_id = $2 AND c.id <> $3
       AND c.situacao IN ('aberta','nao_paga','cobrada')
     ORDER BY c.aberta_em`, [orgId, conta.orderId, conta.id])
  return linhas.map(resumoDaLinha)
}

/* ------------------------------------------------------------------ lançamento */

export interface ItemPedido { itemId: string; quantidade: number }

export interface PedidoDoTablet {
  idLocal: string
  uid?: string | null
  comandaId?: string | null
  itens: ItemPedido[]
  mesa?: string | null
  /** o nome que o atendente digitou antes de passar a pulseira (obrigatório na tela) */
  cliente?: string | null
  observacao?: string | null
  pontoId?: string | null
  feitoEm?: string | null
  semInternet?: boolean
  pin?: string | null
}

export type ResultadoDoPedido =
  | { idLocal: string; ok: true; jaExistia: boolean; lancamentoId: string; comandaId: string;
      totalCents: number; nome: string; pendencia: boolean }
  | { idLocal: string; ok: false; codigo: string; mensagem: string; extra?: Record<string, unknown> }

const ID_LOCAL = /^[0-9A-Za-z_-]{8,80}$/

/**
 * Grava UM pedido vindo do tablet. Idempotente pelo `idLocal`.
 *
 * Com internet, as regras valem na hora (limite, +18, conta fechada → recusa e a tela
 * explica). Sem internet o atendente já entregou a bebida: o pedido é GRAVADO mesmo assim,
 * e o que fugiu da regra vira linha do tempo / pendência pro gerente olhar. Recusar um
 * pedido offline seria o pior dos dois mundos: o produto já saiu e a conta não registra.
 */
export async function gravarPedido(c: ContextoDaComanda, p: PedidoDoTablet): Promise<ResultadoDoPedido> {
  const idLocal = String(p.idLocal ?? '')
  const falha = (codigo: string, mensagem: string, extra?: Record<string, unknown>): ResultadoDoPedido =>
    ({ idLocal, ok: false, codigo, mensagem, extra })
  if (!ID_LOCAL.test(idLocal)) return falha('pedido_invalido', 'Pedido sem identificação. Refaça o pedido.')

  // já gravado? devolve o mesmo (é o reenvio de um tablet que perdeu a resposta)
  const ja = await q1<any>(
    `SELECT l.id, l.comanda_id, l.chegou_depois_de_fechada, c.nome
       FROM comanda_lancamentos l JOIN comandas c ON c.id = l.comanda_id
      WHERE l.id_local = $1 AND l.org_id = $2`, [idLocal, c.orgId])
  if (ja) {
    const r = await resumoDaComanda(c.orgId, ja.comanda_id)
    return { idLocal, ok: true, jaExistia: true, lancamentoId: ja.id, comandaId: ja.comanda_id,
      totalCents: r?.totalCents ?? 0, nome: ja.nome, pendencia: ja.chegou_depois_de_fechada }
  }

  const itensPedidos = (Array.isArray(p.itens) ? p.itens : [])
    .map((i) => ({ itemId: String(i?.itemId ?? ''), quantidade: Math.trunc(Number(i?.quantidade)) }))
    .filter((i) => i.itemId && i.quantidade > 0)
  if (!itensPedidos.length) return falha('sem_itens', 'O pedido está vazio. Escolha pelo menos um item.')
  // id que não é uuid daria erro 500 no banco e travaria a fila inteira do tablet
  if (itensPedidos.some((i) => !EH_UUID.test(i.itemId))) return falha('item_sumiu', 'Um item do pedido não existe mais no cardápio. Refaça o pedido.')
  if (p.comandaId && !EH_UUID.test(String(p.comandaId))) return falha('sem_conta', 'Conta inválida. Encoste a pulseira de novo.')
  if (itensPedidos.some((i) => i.quantidade > 999)) return falha('quantidade', 'Quantidade alta demais num item.')

  const feitoEm = paraDataValida(p.feitoEm) ?? new Date()
  // "Sem internet": o tablet não tinha como pedir o PIN do gerente nem saber que a conta fechou.
  // `semInternet` = o RELÓGIO DO SERVIDOR confirma (o último sinal deste aparelho, `estado.get` a
  // cada 6 s, parou há mais de 30 s, e o aparelho é deste usuário) — só serve para a marca
  // "feito sem internet". Confirmado ou não, o sinal é do tablet e dá para forjar (é só ficar
  // 30 s quieto), então ele NUNCA libera nada sozinho: ver `dizSemInternet` abaixo.
  const sinal = c.aparelho ? aparelhos.get(c.aparelho) : undefined
  const semInternet = !!p.semInternet && !!sinal && sinal.orgId === c.orgId && sinal.usuarioId === c.usuarioId
    && Date.now() - sinal.visto > 30_000
  // O tablet diz que estava sem internet. Recusar faria o pedido sumir — o produto já foi
  // entregue. Então, se quebrar uma regra (fechada, +18, limite, esgotado) sem PIN, ele entra
  // mas vai para as pendências: o gerente confere e decide cobrar ou cancelar.
  // Ninguém passa da regra sem um gerente olhar.
  const dizSemInternet = !!p.semInternet
  const paraConferir: string[] = []

  try {
    return await tx(async (cl) => {
      // a conta: pelo id que o tablet guardou, ou pela pulseira
      let comandaId: string | null = null
      const uid = p.uid ? uidLimpo(p.uid) : null
      if (p.comandaId) {
        const r = (await cl.query(`SELECT id FROM comandas WHERE org_id = $1 AND id = $2`, [c.orgId, p.comandaId])).rows[0]
        comandaId = r?.id ?? null
      }
      if (!comandaId && uid) {
        const r = (await cl.query(
          `SELECT v.comanda_id FROM comanda_vinculos v JOIN comanda_pulseiras pu ON pu.id = v.pulseira_id
            WHERE pu.org_id = $1 AND pu.uid = $2 AND v.fim_em IS NULL`, [c.orgId, uid])).rows[0]
        comandaId = r?.comanda_id ?? null
      }
      if (!comandaId) return falha('sem_conta', 'Esta pulseira não tem conta aberta. Abra a conta antes de lançar.')
      comandaId = await contaFinal(cl, c.orgId, comandaId)

      // trava a conta: dois tablets lançando pro mesmo cliente somam certo, um depois do outro
      const conta = (await cl.query(`SELECT * FROM comandas WHERE id = $1 FOR UPDATE`, [comandaId])).rows[0]
      const fechada = conta.situacao !== 'aberta'
      if (fechada && dizSemInternet) paraConferir.push('a conta já estava fechada')
      else if (fechada) {
        return falha('conta_fechada', `Esta conta já foi fechada${conta.fechada_em ? ' às ' + horaCurta(conta.fechada_em) : ''}. Não aceita pedido novo.`)
      }

      // o cardápio de agora (preço do servidor, sempre)
      const ids = [...new Set(itensPedidos.map((i) => i.itemId))]
      const cardapio = (await cl.query(
        `SELECT id, nome, preco_cents, maior_18, esgotado, ativo FROM comanda_itens WHERE org_id = $1 AND id = ANY($2::uuid[])`,
        [c.orgId, ids])).rows
      const porId = new Map(cardapio.map((r: any) => [r.id, r]))
      const faltando = ids.filter((id) => !porId.has(id))
      if (faltando.length) return falha('item_sumiu', 'Um item do pedido não existe mais no cardápio. Refaça o pedido.')

      let gerenteQueLiberou: { id: string; nome: string } | null = null
      const precisaLiberar = async (motivo: string, codigo: string, extra: Record<string, unknown> = {}) => {
        gerenteQueLiberou = gerenteQueLiberou ?? await liberacaoDoGerente(c, p.pin)
        if (!gerenteQueLiberou && dizSemInternet) { paraConferir.push(motivo); return true }
        if (!gerenteQueLiberou) throw new RecusaDoPedido(codigo, motivo, extra)
        return true
      }

      const avisos: string[] = []
      const indisponivel = cardapio.filter((r: any) => !r.ativo || r.esgotado)
      if (indisponivel.length && dizSemInternet) paraConferir.push(`${indisponivel.map((r: any) => r.nome).join(', ')} estava esgotado`)
      else if (indisponivel.length) {
        return falha('esgotado', `${indisponivel.map((r: any) => r.nome).join(', ')} está esgotado ou fora do cardápio.`)
      }
      if (conta.menor_de_idade && cardapio.some((r: any) => r.maior_18)) {
        const nomes = cardapio.filter((r: any) => r.maior_18).map((r: any) => r.nome).join(', ')
        await precisaLiberar(`Pulseira de menor de idade: ${nomes} é proibido para menores.`, 'menor_de_idade')
        avisos.push(`item +18 (${nomes}) em pulseira de menor`)
      }

      const novoCents = itensPedidos.reduce((s, i) => s + Number(porId.get(i.itemId).preco_cents) * i.quantidade, 0)
      const atual = Number((await cl.query(`SELECT ${SQL_TOTAL} AS t FROM comandas c WHERE c.id = $1`, [comandaId])).rows[0].t)
      const limite = Number(conta.limite_cents)
      if (limite > 0 && atual + novoCents > limite) {
        await precisaLiberar(
          `Passa do limite da conta (${reaisTexto(limite)}). Já gastou ${reaisTexto(atual)}; com este pedido vai a ${reaisTexto(atual + novoCents)}.`,
          'limite', { atualCents: atual, novoCents, limiteCents: limite })
        avisos.push(`passou do limite de ${reaisTexto(limite)}`)
      }

      // local obrigatório com internet; sem internet o pedido entra mesmo assim (o produto já saiu)
      const pontoId = await pontoValido(cl, c.orgId, p.pontoId)
      if (!pontoId && !p.semInternet) return falha('ponto_obrigatorio', 'Escolha o local de venda deste tablet antes de lançar.')
      const pendente = fechada || paraConferir.length > 0

      const lanc = (await cl.query(
        `INSERT INTO comanda_lancamentos (org_id, comanda_id, id_local, pulseira_uid, ponto_id, atendente_id, aparelho,
                                          mesa, observacao, feito_em, feito_sem_internet, chegou_depois_de_fechada, limite_liberado_por, cliente_nome, link_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
        [c.orgId, comandaId, idLocal, uid, pontoId, c.usuarioId, c.aparelho,
          texto(p.mesa, 40), texto(p.observacao, 200), feitoEm, dizSemInternet, pendente,
          (gerenteQueLiberou as any)?.id ?? null, texto(p.cliente, 60), c.linkId ?? null])).rows[0]

      for (const i of itensPedidos) {
        const it = porId.get(i.itemId)
        await cl.query(
          `INSERT INTO comanda_lancamento_itens (org_id, lancamento_id, comanda_id, item_id, nome, preco_cents, quantidade)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`, [c.orgId, lanc.id, comandaId, it.id, it.nome, it.preco_cents, i.quantidade])
      }

      const resumoItens = itensPedidos.map((i) => `${i.quantidade}× ${porId.get(i.itemId).nome}`).join(', ')
      await registrar(cl, c, {
        comandaId,
        acao: pendente ? 'pedido_apos_fechar' : 'pedido',
        descricao: `Pedido ${reaisTexto(novoCents)}: ${resumoItens}`
          + (semInternet ? ' (feito sem internet)' : dizSemInternet ? ' (tablet disse que estava sem internet)' : '')
          + (fechada ? ' — CHEGOU DEPOIS DE A CONTA FECHAR' : '')
          + (paraConferir.length ? ` — PARA O GERENTE CONFERIR: ${paraConferir.join('; ')}` : '')
          + ((gerenteQueLiberou as any) ? ` — liberado por ${(gerenteQueLiberou as any).nome}` : '')
          + (avisos.length ? ` — atenção: ${avisos.join('; ')}` : ''),
        detalhes: { lancamentoId: lanc.id, idLocal, mesa: p.mesa ?? null, cliente: p.cliente ?? null, feitoEm, semInternet, avisos },
      })

      const total = Number((await cl.query(`SELECT ${SQL_TOTAL} AS t FROM comandas c WHERE c.id = $1`, [comandaId])).rows[0].t)
      return { idLocal, ok: true as const, jaExistia: false, lancamentoId: lanc.id, comandaId,
        totalCents: total, nome: conta.nome, pendencia: pendente }
    })
  } catch (e: any) {
    if (e instanceof RecusaDoPedido) return falha(e.codigo, e.message, e.extra)
    // dois envios do MESMO pedido ao mesmo tempo: o segundo bate no UNIQUE e devolve o primeiro
    if (e?.code === '23505' && String(e?.constraint ?? '').includes('id_local')) return gravarPedido(c, p)
    throw e
  }
}

class RecusaDoPedido extends Error {
  constructor(public codigo: string, mensagem: string, public extra: Record<string, unknown> = {}) { super(mensagem) }
}

const EH_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function pontoValido(cl: PoolClient, orgId: string, id: unknown): Promise<string | null> {
  if (!id || typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) return null
  const r = (await cl.query(`SELECT id FROM comanda_pontos WHERE org_id = $1 AND id = $2`, [orgId, id])).rows[0]
  return r?.id ?? null
}

/* ------------------------------------------------------------------ aparelhos (quem está sem internet) */

/**
 * Cada tablet avisa a cada sincronia quantos pedidos tem na fila. Fica em memória do
 * processo: é um aviso operacional ("o tablet do João tem 3 pedidos sem enviar"), não
 * dado de dinheiro — se o servidor reiniciar, o próximo sinal de cada tablet repõe.
 */
const aparelhos = new Map<string, { aparelho: string; orgId: string; usuarioId: string; nome: string; pendentes: number; visto: number }>()

export function sinalDoAparelho(c: ContextoDaComanda, pendentes: number) {
  if (!c.aparelho) return
  aparelhos.set(c.aparelho, { aparelho: c.aparelho, orgId: c.orgId, usuarioId: c.usuarioId, nome: c.nome,
    pendentes: Math.max(0, Math.trunc(pendentes) || 0), visto: Date.now() })
}

export function aparelhosDaOrg(orgId: string) {
  const agora = Date.now()
  return [...aparelhos.values()]
    .filter((a) => a.orgId === orgId && agora - a.visto < 12 * 3600_000)
    .map((a) => ({ ...a, semSinalHaMin: Math.floor((agora - a.visto) / 60_000) }))
    .sort((a, b) => b.visto - a.visto)
}

/** Tablets que podem estar segurando pedido: têm fila, ou sumiram há mais de 2 min. */
export function aparelhosComRisco(orgId: string) {
  return aparelhosDaOrg(orgId).filter((a) => a.pendentes > 0 || a.semSinalHaMin >= 2)
}

/* ------------------------------------------------------------------ miudezas */

export function texto(v: unknown, max: number): string | null {
  const t = String(v ?? '').trim()
  return t ? t.slice(0, max) : null
}

export function paraDataValida(v: unknown): Date | null {
  if (!v) return null
  const d = new Date(String(v))
  if (Number.isNaN(d.getTime())) return null
  // relógio de tablet muito errado: fica a hora do servidor
  if (Math.abs(Date.now() - d.getTime()) > 3 * 86_400_000) return null
  return d
}

export function reaisTexto(cents: number): string {
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }).replace(/ /g, ' ')
}

export function horaCurta(d: Date | string): string {
  return new Date(d).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Bahia' })
}

export function telefoneLimpo(v: unknown): string | null {
  let t = String(v ?? '').replace(/\D/g, '')
  if (t.startsWith('55') && t.length >= 12) t = t.slice(2)
  return t.length === 10 || t.length === 11 ? t : null
}

export function documentoLimpo(v: unknown): string | null {
  const t = String(v ?? '').replace(/\D/g, '')
  return t.length === 11 ? t : null
}

/** O dia "de hoje" no fuso do parque, e o começo/fim dele em timestamptz. */
export function intervaloDoDia(dia?: unknown): { dia: string; inicio: string; fim: string } {
  const hoje = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Bahia' })
  const d = typeof dia === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dia) ? dia : hoje
  // Bahia é UTC−3 o ano todo (sem horário de verão)
  return { dia: d, inicio: `${d}T00:00:00-03:00`, fim: `${d}T23:59:59.999-03:00` }
}
