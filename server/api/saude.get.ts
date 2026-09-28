/**
 * GET /api/saude — a pergunta que um monitor externo faz a cada minuto:
 * "dá pra vender e entregar agora?"
 *
 * Responde 200 quando sim e **503 quando não** — é o status que o monitor lê
 * (UptimeRobot, o HEALTHCHECK do contêiner), sem precisar entender o corpo.
 * O corpo diz o porquê, pra quem abrir:
 *
 *   · o banco responde (e em quanto tempo);
 *   · há quanto tempo chegou o último aviso do Asaas, e quantos estão sem baixa;
 *   · a fila de e-mail anda (a mesma régua de `/admin/filas`: `vereditoDaFila`);
 *   · a varredura de expirados roda (reserva vencida e ainda presa = parou —
 *     é o sinal de PROD-07 em produção, não só no build);
 *   · cartão em análise há mais de 48 h (B09);
 *   · a configuração em SIM/NÃO, e os eventos à venda sem como cobrar.
 *
 * **Nunca sai valor de variável nem segredo** — nem pedaço de chave, nem URL
 * de banco. Só SIM/NÃO, contagens, idades e o slug (público) do evento.
 *
 * Pública de propósito (o monitor não tem sessão), e barata: a resposta fica
 * 5 s em memória, então martelar a rota não vira carga no banco.
 *
 * Em PRODUÇÃO o diagnóstico (números, SIM/NÃO, frases) só sai com o cabeçalho
 * `x-monitor-token` igual ao `MONITOR_TOKEN` do ambiente (32+ caracteres); sem
 * ele a resposta é só `ok` e o status — o que um monitor de uptime precisa.
 * Contagem de fila e de pedido parado é informação do negócio, e "o freio por
 * IP está desligado" é informação pra quem ataca. Fora de produção sai tudo.
 */
import { createHash, timingSafeEqual } from 'node:crypto'
import { q1 } from '../utils/db'
import { PEDIDO_VIVO } from '../utils/liquido'
import { conferirConfiguracao, eventosSemPagamentoOnline } from '../utils/asaas'
import { emPortugues, FILA_DE_ENVIO, vereditoDaFila } from '../utils/envio'
import { estadoDoCofre } from '../utils/cofre-banco'

const CACHE_MS = 5_000
let guardada: { ate: number; status: number; corpo: any } | null = null

/** Reserva vencida há mais que isto e ainda presa: a varredura (a cada minuto) parou. */
const TOLERANCIA_EXPIRADOS_MIN = 10

/** O monitor pode ver o diagnóstico? Fora de produção, sempre. */
export function monitorAutorizado(recebido: string | null | undefined, env = process.env): boolean {
  if (env.NODE_ENV !== 'production') return true
  const esperado = String(env.MONITOR_TOKEN ?? '')
  if (esperado.length < 32) return false
  const a = createHash('sha256').update(esperado).digest()
  const b = createHash('sha256').update(String(recebido ?? '')).digest()
  return timingSafeEqual(a, b)
}

export default defineEventHandler(async (event) => {
  setResponseHeader(event, 'cache-control', 'no-store')
  const agora = Date.now()
  if (!guardada || guardada.ate <= agora) {
    const { status, corpo } = await medir()
    guardada = { ate: agora + CACHE_MS, status, corpo }
  }
  setResponseStatus(event, guardada.status)
  if (!monitorAutorizado(getRequestHeader(event, 'x-monitor-token'))) {
    return {
      ok: guardada.corpo.ok,
      verificadoEm: guardada.corpo.verificadoEm,
      detalhes: 'Diagnóstico só com o cabeçalho x-monitor-token (MONITOR_TOKEN do ambiente).',
    }
  }
  return guardada.corpo
})

export async function medir(): Promise<{ status: number; corpo: any }> {
  const config = conferirConfiguracao()
  const problemas = config.problemas.map((p) => ({ item: p.item, critico: p.critico, frase: p.frase }))

  // ------------------------------------------------------------------ banco
  const inicio = Date.now()
  let bancoOk = true
  try {
    await q1('SELECT 1')
  } catch {
    bancoOk = false
  }
  const banco = { ok: bancoOk, ms: Date.now() - inicio }
  if (!bancoOk) {
    // Sem banco não há o que medir — e a frase não repete o erro do driver,
    // que costuma trazer host e usuário.
    return {
      status: 503,
      corpo: {
        ok: false, verificadoEm: new Date().toISOString(), banco,
        config: config.itens, assinaQrCom: config.assinaQrCom, proxy: config.proxy,
        problemas: [{ item: 'banco', critico: true, frase: 'O banco de dados não responde.' }, ...problemas],
      },
    }
  }

  // ------------------------------------------------------- webhook do Asaas
  const wh = await q1<any>(
    `SELECT EXTRACT(epoch FROM now() - max(created_at))::int AS ultimo_ha,
            count(*) FILTER (WHERE processed_at IS NULL
                               AND created_at < now() - interval '5 minutes'
                               -- a devolução do MP em processamento não é aviso sem baixa: tem
                               -- régua própria logo abaixo
                               AND event_name <> 'MP_DEVOLUCAO_A_CONFIRMAR')::int AS sem_baixa
       FROM payment_events`)
  const webhook = {
    ultimoRecebidoHaSegundos: wh?.ultimo_ha ?? null,
    ultimoRecebidoHa: wh?.ultimo_ha != null ? emPortugues(Number(wh.ultimo_ha)) : 'nunca',
    semBaixaHaMaisDe5min: Number(wh?.sem_baixa ?? 0),
  }
  if (webhook.semBaixaHaMaisDe5min > 0) {
    problemas.push({ item: 'webhook', critico: false,
      // conta os dois gateways: o Pix do Mercado Pago (28/09) pendura na mesma tabela
      frase: `${webhook.semBaixaHaMaisDe5min} aviso(s) de pagamento (Asaas ou Mercado Pago) sem baixa há mais de 5 min `
        + '(o reprocessador tenta de novo; olhe a reconciliação se não baixar).' })
  }

  // ------------------------------------------------ o Pix do Mercado Pago
  // O checkout cai pro Asaas quando o MP não gera o Pix: o comprador não sente, e é por isso que
  // precisa aparecer aqui — sem esta linha, MP falhando é tarifa do Asaas paga em silêncio.
  const mp = await q1<any>(
    `SELECT (SELECT count(*) FROM audit_log
              WHERE action = 'pix_mp_falhou' AND created_at > now() - interval '1 hour')::int AS falhou_1h,
            (SELECT count(*) FROM payment_events
              WHERE provider = 'mercadopago' AND event_name = 'MP_DEVOLUCAO_A_CONFIRMAR'
                AND processed_at IS NULL AND created_at < now() - interval '1 hour')::int AS devolucao_presa`)
  const mercadoPago = {
    pixQueFalharamNaUltimaHora: Number(mp?.falhou_1h ?? 0),
    devolucoesSemConfirmacaoHaMaisDe1h: Number(mp?.devolucao_presa ?? 0),
  }
  if (mercadoPago.pixQueFalharamNaUltimaHora > 0) {
    problemas.push({ item: 'mercado_pago', critico: false,
      frase: `${mercadoPago.pixQueFalharamNaUltimaHora} Pix não saíram pelo Mercado Pago na última hora — `
        + 'o checkout usou o Asaas (ou recusou a venda, sem Asaas). Confira o token em Configurações → Dados e cobrança.' })
  }
  if (mercadoPago.devolucoesSemConfirmacaoHaMaisDe1h > 0) {
    problemas.push({ item: 'mercado_pago', critico: false,
      frase: `${mercadoPago.devolucoesSemConfirmacaoHaMaisDe1h} devolução(ões) pelo Mercado Pago sem confirmação há mais `
        + 'de 1 h — o motivo está em Financeiro → entregas.' })
  }

  // ------------------------------------------------------- fila de e-mail
  // Global (todas as organizações): o monitor pergunta pelo servidor, não por loja.
  //
  // "Perdido" é quem AINDA tem ingresso pra receber: pedido vivo (a mesma régua da entrega,
  // PEDIDO_VIVO) com pelo menos um ingresso que o e-mail levaria — não cancelado e sem
  // transferência concluída (B02). O e-mail do pedido estornado antes de sair, ou do pedido
  // que passou tudo adiante, falha DE VEZ por desenho (envio.ts) — e contá-lo aqui deixava
  // a saúde em 503 PRA SEMPRE depois do primeiro estorno rápido (não há reenvio pra ele),
  // dizendo "quem pagou continua sem" de quem recebeu o dinheiro de volta.
  const n = await q1<any>(
    `WITH por_pedido AS (
       SELECT bool_or(es.status = 'enviado')               AS teve_saida,
              bool_or(es.status IN ('na_fila','enviando')) AS tem_pendente,
              bool_or(es.status = 'falhou')                AS teve_falha
         FROM email_sends es
         JOIN orders o ON o.id = es.order_id
        WHERE ${PEDIDO_VIVO('o.')}
          AND EXISTS (SELECT 1 FROM tickets t
                       WHERE t.order_id = o.id AND t.status <> 'cancelado'
                         AND NOT EXISTS (SELECT 1 FROM ticket_transfers tr
                                          WHERE tr.ticket_id = t.id AND tr.status = 'concluido'))
        GROUP BY es.order_id)
     SELECT count(*) FILTER (WHERE status = 'na_fila')::int                          AS na_fila,
            count(*) FILTER (WHERE status = 'na_fila' AND available_at <= now())::int AS maduros,
            COALESCE(EXTRACT(epoch FROM now() - min(available_at)
              FILTER (WHERE status = 'na_fila' AND available_at <= now())), 0)::int    AS mais_velho,
            (SELECT count(*) FROM por_pedido
              WHERE teve_falha AND NOT teve_saida AND NOT tem_pendente)::int          AS perdidos
       FROM email_sends`)
  const ponto = await q1<any>(
    `SELECT status, beat_ms, beats, EXTRACT(epoch FROM now() - beat_at)::int AS bateu_ha
       FROM worker_heartbeat_instances WHERE worker = $1
      ORDER BY beat_at DESC LIMIT 1`, [FILA_DE_ENVIO])
  const veredito = vereditoDaFila({
    status: ponto?.status ?? null,
    bateuHaSegundos: ponto ? Number(ponto.bateu_ha) : null,
    intervaloMs: ponto?.beat_ms != null ? Number(ponto.beat_ms) : null,
    carimba: ponto?.beats !== false,
    maduros: Number(n?.maduros ?? 0),
    maisVelhoSegundos: Number(n?.mais_velho ?? 0),
    perdidos: Number(n?.perdidos ?? 0),
  })
  const filaDeEnvio = {
    parada: veredito.parado,
    diagnostico: veredito.frase,
    naFila: Number(n?.na_fila ?? 0),
    maduros: Number(n?.maduros ?? 0),
    pedidosSemEmailDeVez: Number(n?.perdidos ?? 0),
  }
  if (veredito.parado) problemas.push({ item: 'fila de e-mail', critico: true, frase: veredito.frase })

  // ------------------------------------------------ pedidos que não andam
  const ped = await q1<any>(
    `SELECT count(*) FILTER (WHERE status = 'aguardando_pagamento'
                               AND expires_at < now() - make_interval(mins => $1))::int AS vencidas_presas,
            count(*) FILTER (WHERE status = 'em_analise'
                               AND created_at < now() - interval '48 hours')::int    AS em_analise_48h,
            -- pago há 10 min e sem ingresso NENHUM (nem cancelado): o dinheiro
            -- entrou e a emissão não aconteceu
            count(*) FILTER (WHERE status IN ('pago', 'estornado_parcial')
                               AND paid_at < now() - interval '10 minutes'
                               AND NOT EXISTS (SELECT 1 FROM tickets t WHERE t.order_id = orders.id)
                            )::int                                                    AS pagos_sem_ingresso
       FROM orders`, [TOLERANCIA_EXPIRADOS_MIN])
  const pedidos = {
    reservasVencidasAindaPresas: Number(ped?.vencidas_presas ?? 0),
    emAnaliseHaMaisDe48h: Number(ped?.em_analise_48h ?? 0),
    pagosSemIngresso: Number(ped?.pagos_sem_ingresso ?? 0),
  }
  if (pedidos.pagosSemIngresso > 0) {
    problemas.push({ item: 'emissão', critico: true,
      frase: `${pedidos.pagosSemIngresso} pedido(s) pago(s) há mais de 10 min sem nenhum ingresso emitido: `
        + 'o dinheiro entrou e o comprador não tem o que mostrar na portaria.' })
  }
  if (pedidos.reservasVencidasAindaPresas > 0) {
    problemas.push({ item: 'liberar-expirados', critico: true,
      frase: `${pedidos.reservasVencidasAindaPresas} reserva(s) vencida(s) há mais de `
        + `${TOLERANCIA_EXPIRADOS_MIN} min continuam segurando ingresso: a varredura de expirados `
        + '(tarefa liberar-expirados, a cada minuto) não está rodando.' })
  }
  if (pedidos.emAnaliseHaMaisDe48h > 0) {
    problemas.push({ item: 'em_analise', critico: false,
      frase: `${pedidos.emAnaliseHaMaisDe48h} pedido(s) de cartão em análise de risco há mais de 48 h `
        + 'segurando ingresso. A varredura consulta o Asaas antes de soltar; confira no painel dele.' })
  }

  // ------------------------------------------ o cofre da chave do Asaas
  // Chave no cofre que este servidor não abre = organização sem como cobrar (a venda fecha com
  // `cofre_fechado`): crítico. Chave em texto puro na produção = o risco que o cofre existe pra
  // fechar (backup vazado leva a chave que estorna e transfere): aviso, até alguém ligar.
  const cofre = await estadoDoCofre()
  if (cofre.ilegiveis > 0) {
    problemas.push({ item: 'cofre', critico: true,
      frase: `${cofre.ilegiveis} chave(s) do Asaas estão no cofre com uma chave que este servidor não tem `
        + '(COFRE_CHAVE / COFRE_CHAVES_ANTIGAS): essas organizações não conseguem cobrar.' })
  }
  if (config.producao && !cofre.ligado && cofre.emTextoPuro > 0) {
    problemas.push({ item: 'cofre', critico: false,
      frase: `${cofre.emTextoPuro} chave(s) do Asaas guardada(s) em texto puro no banco. Ligue o cofre: `
        + 'COFRE_CHAVE (openssl rand -base64 32) no servidor e reinicie — o boot cifra sozinho.' })
  }

  // ----------------------------------------------- venda online (PROD-06)
  const semPagamento = await eventosSemPagamentoOnline()
  for (const e of semPagamento) {
    problemas.push({ item: 'venda online', critico: true,
      frase: `O evento ${e.slug} está à venda e não tem como cobrar online (${e.motivo}).` })
  }

  const ok = !problemas.some((p) => p.critico)
  return {
    status: ok ? 200 : 503,
    corpo: {
      ok,
      verificadoEm: new Date().toISOString(),
      producao: config.producao,
      banco,
      webhook,
      mercadoPago,
      filaDeEnvio,
      pedidos,
      cofre,
      vendaOnline: { eventosSemPagamento: semPagamento },
      config: config.itens,
      assinaQrCom: config.assinaQrCom,
      proxy: config.proxy,
      problemas,
    },
  }
}
