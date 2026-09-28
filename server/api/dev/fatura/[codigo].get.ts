/**
 * GET /api/dev/fatura/:código — a "fatura do cartão" do gateway SIMULADO.
 *
 * No Asaas de verdade, a cobrança no cartão devolve um `invoiceUrl`: a página
 * onde o comprador digita o cartão. O simulado devolvia `null`, e aí o caminho
 * do cartão não tinha como ser exercitado na máquina — a tela de pagamento e a
 * página do pedido caíam sempre no "o link do cartão não veio" (B08). Agora o
 * simulado aponta pra cá: uma página de mentira com um botão que confirma o
 * pagamento pela MESMA emissão do webhook (`POST` desta rota).
 *
 * Mesma trava do `/api/dev/pagar`: só existe com o gateway simulado ligado,
 * que nunca liga em produção — lá a rota responde 404.
 */
import { q1 } from '../../../utils/db'
import { ligado } from '../../../utils/gateway-simulado'
import { centavosParaReais } from '../../../utils/asaas'

export const escaparHtml = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))

export function paginaDaFatura(corpo: string, titulo = 'Fatura simulada'): string {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${escaparHtml(titulo)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:28rem;margin:3rem auto;padding:0 1rem;color:#1e1a2e}
.card{border:1px solid #e2e0ea;border-radius:16px;padding:1.5rem}button{font:inherit;font-weight:600;
min-height:44px;width:100%;border:0;border-radius:12px;background:#146f83;color:#fff;cursor:pointer}
.aviso{font-size:.85rem;color:#5a5570}</style></head><body><div class="card">${corpo}</div></body></html>`
}

export default defineEventHandler(async (event) => {
  if (!ligado()) throw createError({ statusCode: 404, statusMessage: 'Not Found' })
  const codigo = String(getRouterParam(event, 'codigo') ?? '')
  const o = await q1<any>(
    `SELECT code, status, total_cents, installments, asaas_payment_id FROM orders WHERE upper(code) = upper($1)`,
    [codigo])
  if (!o || !String(o.asaas_payment_id ?? '').startsWith('sim_')) {
    throw createError({ statusCode: 404, statusMessage: 'Fatura simulada não encontrada' })
  }
  setResponseHeader(event, 'content-type', 'text/html; charset=utf-8')
  setResponseHeader(event, 'cache-control', 'no-store')
  const valor = centavosParaReais(Number(o.total_cents)).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
  if (o.status !== 'aguardando_pagamento') {
    return paginaDaFatura(`<h1>Pedido ${escaparHtml(o.code)}</h1><p>Esta fatura não está mais em aberto
      (situação: ${escaparHtml(o.status)}).</p>`)
  }
  return paginaDaFatura(`<h1>Fatura simulada</h1>
    <p>Pedido <strong>${escaparHtml(o.code)}</strong> — ${escaparHtml(valor)}${
      Number(o.installments) > 1 ? ` em ${Number(o.installments)}×` : ''}</p>
    <p class="aviso">Gateway de mentira da máquina de desenvolvimento: nenhum cartão é cobrado.</p>
    <form method="post"><button type="submit">Pagar com cartão (simulado)</button></form>`)
})
