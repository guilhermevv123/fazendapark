/**
 * Tarefa de fundo: devolve pra prateleira o ingresso de carrinho abandonado.
 *
 * `liberarExpirados` existia, estava testada e **ninguém chamava** — o
 * defeito que não aparece em teste nenhum porque a função passa em todos.
 * Em produção o efeito é lento e caro: cada PIX não pago segura o lugar pra
 * sempre, `lots.reserved` só sobe, e o evento mostra "esgotado" com a casa
 * pela metade. No painel da Zig o abandono batia 57%.
 *
 * Roda de minuto em minuto. Pode rodar em várias instâncias ao mesmo tempo:
 * a varredura usa `FOR UPDATE SKIP LOCKED`, então duas cópias dividem a fila
 * em vez de brigar pela mesma linha.
 *
 * Só fala quando fez alguma coisa. Log de "0 liberados" a cada minuto entope
 * o diário e esconde o dia em que liberar 300 de uma vez seria o aviso de
 * que algo quebrou no pagamento.
 *
 * ## Cada etapa por si (ADM-52)
 *
 * As etapas eram chamadas em fila, sem rede: uma exceção na primeira (banco
 * piscando no meio da varredura, um pedido torto) derrubava a rodada inteira
 * — e junto a expiração das TRANSFERÊNCIAS, que não tem nada com isso. Uma
 * transferência parada tranca o ingresso (o índice único deixa uma pendente
 * por ingresso), então o dono ficava sem conseguir mandar de novo por causa
 * de um defeito em outro lugar. Agora cada etapa tem o seu `try`: a que cai
 * vira linha de erro no log e no resultado, e as outras seguem.
 */
import { liberarExpirados } from '../utils/estoque'
import { cancelarCobrancasDeExpirados, varrerCobrancasDoAsaas, varrerEmAnalise } from '../utils/asaas'
import { expirarTransferencias } from '../utils/transferencia'
import { esquecerCadastrosPendentes } from '../utils/cadastro'
import { db, tx } from '../utils/db'

export interface Etapa {
  nome: string
  rodar: () => Promise<number>
  /** a frase quando fez alguma coisa (nada feito = silêncio) */
  falar: (n: number) => string
}

export const ETAPAS: Etapa[] = [
  {
    nome: 'pedidos vencidos',
    rodar: () => tx((c) => liberarExpirados(c)),
    falar: (n) => `[estoque] ${n} pedido(s) vencido(s) — estoque devolvido`,
  },
  {
    // A cobrança do pedido que acabou de cair (aqui ou na reserva sob demanda
    // de `reclamarVencidosDoLote`) é cancelada no gateway DEPOIS do commit:
    // rede de terceiro não segura estoque, e gateway fora não impede a
    // devolução. Falha de UMA cobrança vira linha no `audit_log` do pedido; o
    // pagamento que escapar é tratado na emissão (reserva refeita, ou
    // pendência visível no painel).
    nome: 'cobranças de reserva vencida',
    rodar: async () => {
      const r = await cancelarCobrancasDeExpirados()
      const falhas = r.filter((x) => !x.ok).length
      if (falhas) console.warn(`[asaas] ${falhas} cobrança(s) vencida(s) com erro ao cancelar (ver audit_log do pedido)`)
      return r.length - falhas
    },
    falar: (n) => `[asaas] cobranças de reserva vencida: ${n} cancelada(s)`,
  },
  {
    // Transferência parada também tranca: o índice único deixa uma pendente
    // por ingresso, então enquanto a antiga não vence o dono não consegue
    // mandar de novo — nem pro mesmo e-mail escrito certo.
    nome: 'transferências paradas',
    rodar: () => tx((c) => expirarTransferencias(c)),
    falar: (n) => `[transferencia] ${n} venceram sem aceite`,
  },
  {
    // B09: cartão em análise de risco não tem prazo — pergunta ao gateway e
    // só solta o que ele disser que não foi pago (ver `decidirEmAnalise`).
    nome: 'análise de risco sem saída',
    rodar: async () => (await varrerEmAnalise()).filter((d) => d.desfecho === 'solto').length,
    falar: (n) => `[asaas] ${n} pedido(s) em análise de risco soltos (o gateway disse que não foi pago)`,
  },
  {
    // LGPD: o formulário do pedido que morreu sem pagar não fica guardado.
    nome: 'cadastro de pedido morto',
    rodar: () => esquecerCadastrosPendentes(db()),
    falar: (n) => `[cadastro] ${n} formulário(s) de pedido não pago apagado(s)`,
  },
  {
    // A rede de baixo do webhook do Asaas (05/10). O cartão (e o Pix plano B) só virava ingresso
    // pelo aviso: aviso perdido, URL errada no painel ou a fila de webhooks PAUSADA pelo Asaas (15
    // falhas seguidas) e o comprador pago ficava sem ingresso. Pergunta `GET /payments/{id}` pelos
    // pedidos esperando há mais de 5 min e pelos expirados recentes, e aplica o pago pelo MESMO
    // caminho do webhook. POR ÚLTIMO e com prazo próprio (25 s): é a única etapa sem pressa, e
    // a devolução do estoque (a primeira) já aconteceu antes dela. Para na primeira falha
    // passageira (Asaas fora, 429). Sem organização com chave do Asaas, nenhuma chamada sai.
    nome: 'cobranças do asaas pagas sem aviso',
    rodar: async () => (await varrerCobrancasDoAsaas({ ate: Date.now() + 25_000 }))
      .filter((d) => d.ok && d.aplicado).length,
    falar: (n) => `[asaas] ${n} pagamento(s) achado(s) pela varredura (o webhook não tinha avisado) e aplicado(s)`,
  },
]

export interface ResultadoDaVarredura {
  feitos: Record<string, number>
  falhas: Record<string, string>
}

/** Roda TODAS as etapas; a que cai não leva as outras junto. */
export async function varrer(etapas: Etapa[] = ETAPAS): Promise<ResultadoDaVarredura> {
  const feitos: Record<string, number> = {}
  const falhas: Record<string, string> = {}
  for (const e of etapas) {
    try {
      const n = await e.rodar()
      feitos[e.nome] = n
      if (n > 0) console.log(e.falar(n))
    } catch (erro: any) {
      falhas[e.nome] = erro?.message ?? String(erro)
      console.error(`[liberar-expirados] a etapa "${e.nome}" falhou e as outras seguiram: ${falhas[e.nome]}`)
    }
  }
  return { feitos, falhas }
}

export default defineTask({
  meta: {
    name: 'liberar-expirados',
    description: 'Expira pedidos vencidos, devolve estoque, cancela a cobrança, vence transferências paradas, '
      + 'pergunta ao gateway pelos pedidos em análise de risco, apaga o cadastro de pedido não pago '
      + 'e pergunta ao Asaas pelo que foi pago sem aviso',
  },
  async run() {
    return { result: await varrer() }
  },
})
