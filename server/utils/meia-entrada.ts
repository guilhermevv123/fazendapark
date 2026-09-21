/**
 * meia-entrada.ts — a regra legal da meia, num lugar só.
 *
 * Meia-entrada no Brasil não é desconto que o produtor dá: é obrigação com
 * três partes, e as três moram aqui.
 *
 *  1. **QUEM tem direito** — a lista de motivos é fechada por lei
 *     (Lei 12.933/2013 + Decreto 8.537/2015, Estatuto do Idoso, Estatuto da
 *     Juventude). Motivo fora da lista não é meia, é desconto — e desconto
 *     não consome cota nem pede documento na portaria.
 *
 *  2. **O QUE a portaria pede** — cada motivo tem o seu documento. É isso que
 *     separa um portão que funciona de uma discussão na fila: o operador não
 *     precisa saber a lei, precisa ler no ingresso qual papel pedir.
 *
 *  3. **QUANTAS cabem** — até 40% dos ingressos colocados à venda. A cota é a
 *     parte que quebra sozinha: ela é uma soma sobre o lote, e soma conferida
 *     sem a linha do lote travada passa em teste sequencial e não segura nada.
 *     Por isso `conferirCotaDeMeia` TRAVA primeiro e conta depois.
 *
 * Quem chama: server/api/checkout.post.ts. O balcão (pdv/venda.post.ts) ainda
 * não passa por aqui — ele exige o documento do comprador mas não pergunta o
 * motivo nem confere a cota. Está relatado na entrega; a função já está pronta
 * para ele.
 */
import type { PoolClient } from 'pg'

/** Espécie do tipo de ingresso. Espelha `ticket_types.kind` (db/015). */
export type Especie = 'inteira' | 'meia' | 'gratuito'

export interface MotivoDeMeia {
  /** como aparece na tela e no ingresso */
  rotulo: string
  /** o que a portaria pede na entrada */
  documento: string
  /** de onde vem a obrigação — vai no texto de ajuda do painel */
  base: string
  /**
   * O comprador precisa digitar o NÚMERO do documento na compra?
   *
   * Só onde o direito depende de uma credencial numerada que a portaria
   * confere contra a pessoa (carteira estudantil, ID Jovem). Idoso, PCD,
   * acompanhante e professor comprovam com documento físico no portão —
   * exigir um número na compra desses casos só cria campo que o comprador
   * preenche com qualquer coisa para o botão liberar.
   */
  exigeNumero: boolean
}

/**
 * Os motivos aceitos. As chaves são as MESMAS do CHECK em `order_items` e
 * `tickets` (db/015_meia_entrada.sql) — mudar uma sem a outra faz o INSERT
 * estourar com fila na frente.
 */
export const MOTIVOS: Record<string, MotivoDeMeia> = {
  estudante: {
    rotulo: 'Estudante',
    documento: 'Carteira de Identificação Estudantil (CIE) do ano vigente, com foto',
    base: 'Lei 12.933/2013',
    exigeNumero: true,
  },
  idoso: {
    rotulo: 'Idoso (60 anos ou mais)',
    documento: 'Documento oficial com foto que mostre a data de nascimento',
    base: 'Lei 10.741/2003 (Estatuto do Idoso), art. 23',
    exigeNumero: false,
  },
  pcd: {
    rotulo: 'Pessoa com deficiência',
    documento: 'Laudo médico, cartão do BPC/LOAS ou carteira de PCD, com documento oficial com foto',
    base: 'Lei 12.933/2013',
    exigeNumero: false,
  },
  acompanhante: {
    rotulo: 'Acompanhante de pessoa com deficiência',
    documento: 'Comprovação da pessoa com deficiência acompanhada, que precisa entrar junto',
    base: 'Lei 12.933/2013',
    exigeNumero: false,
  },
  jovem_baixa_renda: {
    rotulo: 'Jovem de baixa renda (15 a 29 anos)',
    documento: 'Identidade Jovem (ID Jovem) válida, com documento oficial com foto',
    base: 'Lei 12.852/2013 (Estatuto da Juventude), art. 23',
    exigeNumero: true,
  },
  professor: {
    rotulo: 'Professor da rede pública',
    documento: 'Carteira funcional ou contracheque recente, com documento oficial com foto',
    base: 'legislação estadual/municipal de meia-entrada para professores',
    exigeNumero: false,
  },
}

/** As chaves, na ordem em que o painel e o checkout listam. */
export const CHAVES_DE_MOTIVO = Object.keys(MOTIVOS)

/** "Estudante, Idoso (60 anos ou mais), …" — pra dentro de mensagem de erro. */
export const MOTIVOS_EM_TEXTO = CHAVES_DE_MOTIVO.map((k) => MOTIVOS[k].rotulo).join(', ')

export const motivoValido = (m: unknown): m is string =>
  typeof m === 'string' && Object.hasOwn(MOTIVOS, m)

/** O que a portaria vai pedir. É este texto que é gravado no ingresso. */
export function documentoExigido(motivo: string): string {
  const m = MOTIVOS[motivo]
  if (!m) throw new Error(`motivo de meia-entrada desconhecido: ${motivo}`)
  return m.documento
}

export function rotuloDoMotivo(motivo: string): string {
  return MOTIVOS[motivo]?.rotulo ?? motivo
}

/**
 * O teto legal: 40% dos ingressos colocados à venda
 * (Decreto 8.537/2015, art. 1º, §9º).
 */
export const COTA_LEGAL_BPS = 4000

/**
 * Quantas meias cabem num lote.
 *
 * Arredonda PARA BAIXO: 40% de 7 é 2,8, e vender a terceira é passar da cota.
 * A obrigação é "até 40%", não "aproximadamente 40%".
 */
export function cotaDeMeias(quantidadeDoLote: number, bps: number = COTA_LEGAL_BPS): number {
  const q = Number(quantidadeDoLote)
  const b = Number(bps)
  if (!Number.isFinite(q) || !Number.isFinite(b) || q <= 0 || b <= 0) return 0
  return Math.floor((q * b) / 10_000)
}

/**
 * A cota deste lote acabou — e o erro diz quantas ainda cabiam, porque quem
 * lê isto está com o cartão na mão.
 */
export class CotaDeMeiaEsgotada extends Error {
  constructor(
    public readonly lotId: string,
    public readonly nomeDoLote: string,
    public readonly cota: number,
    /** quantas meias este lote já tinha ANTES deste pedido */
    public readonly antes: number,
    public readonly pedido: number,
  ) {
    super(`meia-entrada de "${nomeDoLote}": cota ${cota}, já vendidas ${antes}, pedido ${pedido}`)
    this.name = 'CotaDeMeiaEsgotada'
  }

  /** quantas ainda cabiam quando este comprador chegou */
  get restavam(): number {
    return Math.max(this.cota - this.antes, 0)
  }

  /**
   * O que o comprador lê. Nunca "erro seco": diz o que acabou, por que existe
   * um limite, e o que dá pra fazer agora — a inteira do mesmo lote continua
   * à venda, e é essa a saída.
   */
  get recado(): string {
    if (this.restavam <= 0) {
      return `As meias-entradas deste lote acabaram. A lei reserva até 40% dos ingressos `
        + `para meia-entrada e essa parte de "${this.nomeDoLote}" já foi vendida. `
        + 'Você ainda pode comprar a inteira deste lote.'
    }
    const resta = this.restavam === 1
      ? 'Restou 1 meia-entrada'
      : `Restaram ${this.restavam} meias-entradas`
    return `${resta} em "${this.nomeDoLote}" e você pediu ${this.pedido}. `
      + `Leve ${this.restavam} como meia e o resto como inteira.`
  }
}

/**
 * A trava do lote, como statement solto — mesmo motivo de `SQL_TRAVA_LOTE` em
 * estoque.ts: o teste de concorrência roda EXATAMENTE esta linha. Um teste que
 * escreve o próprio `FOR UPDATE` prova que o Postgres trava, não que a cota
 * trava, e continua verde no dia em que esta função parar de travar.
 */
export const SQL_TRAVA_LOTE_DA_COTA = `SELECT id FROM lots WHERE id = $1 FOR UPDATE`

/**
 * Quantas meias já saíram deste lote, somando TODOS os tipos de meia dele
 * (um lote pode ter "Meia estudante" e "Meia idoso" — a cota é do lote, não
 * de cada tipo).
 *
 * `LEFT JOIN` + `FILTER`, e não `WHERE tt.kind = 'meia'`: com o WHERE, um lote
 * que ainda não tem nenhum tipo de meia simplesmente SOME do resultado, a
 * função lê `undefined` e a conferência vira no-op — o mesmo jeito silencioso
 * que um JOIN tem de comer linha sem par.
 *
 * `GROUP BY l.id` basta porque `id` é a chave: o Postgres resolve as outras
 * colunas por dependência funcional.
 */
export const SQL_MEIAS_DO_LOTE = `
  SELECT l.id, l.name, l.quantity, l.half_quota_bps,
         COALESCE(SUM(tt.sold) FILTER (WHERE tt.kind = 'meia'), 0)::int AS meias
    FROM lots l
    LEFT JOIN ticket_types tt ON tt.lot_id = l.id
   WHERE l.id = $1
   GROUP BY l.id`

export interface CotaDoLote {
  cota: number
  /** meias já contabilizadas no lote, INCLUINDO o pedido em andamento */
  vendidas: number
  /** quantas ainda cabem depois deste pedido */
  restam: number
}

/**
 * Confere a cota de meia deste lote. Chamar SEMPRE dentro da transação que
 * acabou de reservar o estoque — e DEPOIS de `reservar()`, nunca antes.
 *
 * Por que depois: `reservar()` já somou este pedido em `ticket_types.sold`.
 * Contar aqui é contar o mundo COM o pedido dentro, que é exatamente a
 * pergunta ("se esta venda passar, a cota estoura?"). Conferir antes seria
 * decidir sobre um estoque que o próprio pedido ainda não ocupou, e dois
 * compradores simultâneos leriam os dois "ainda cabe".
 *
 * Por que isso serializa: a primeira linha é `FOR UPDATE` na linha do lote. Em
 * Postgres a trava dura até o COMMIT, então quando esta função é chamada
 * depois de `reservar()` (que já travou o mesmo lote) a segunda transação nem
 * chega a contar — ela fica pendurada na trava e só lê o total depois que a
 * primeira gravou. O `FOR UPDATE` repetido aqui não custa nada nesse caso e é
 * o que deixa a função segura para quem a chamar sozinha (o balcão, amanhã).
 */
export async function conferirCotaDeMeia(
  c: PoolClient, lotId: string, meiasPedidas: number,
): Promise<CotaDoLote> {
  await c.query(SQL_TRAVA_LOTE_DA_COTA, [lotId])

  const { rows } = await c.query(SQL_MEIAS_DO_LOTE, [lotId])
  const lote = rows[0]
  // Lote inexistente não é problema desta função: quem reserva estoque grita
  // primeiro, com a mensagem certa.
  if (!lote) return { cota: 0, vendidas: 0, restam: 0 }

  const cota = cotaDeMeias(Number(lote.quantity), Number(lote.half_quota_bps))
  const vendidas = Number(lote.meias)

  if (vendidas > cota) {
    throw new CotaDeMeiaEsgotada(
      lotId, lote.name, cota, Math.max(vendidas - meiasPedidas, 0), meiasPedidas)
  }
  return { cota, vendidas, restam: Math.max(cota - vendidas, 0) }
}
