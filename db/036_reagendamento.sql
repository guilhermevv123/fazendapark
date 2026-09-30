-- 036 — reagendamento pelo próprio cliente (dono, 30/09/2026)
--
-- Na conta do cliente ("Meus ingressos"), o ingresso ganha "Reagendar": a
-- pessoa troca o ingresso por outro dia/ingresso que o parque tem à venda.
--
-- Como a troca fica registrada:
--   · o ingresso antigo vira 'cancelado' (o QR para de passar) e a vaga volta
--     pro lote dele;
--   · nasce um PEDIDO NOVO, zerado (o dinheiro já entrou no pedido original e
--     continua contado lá), no evento do dia escolhido, na mesma conta —
--     assim ele aparece em "Meus ingressos" com a data nova, a portaria do dia
--     novo o reconhece e o e-mail do ingresso sai pelo gatilho de sempre;
--   · esta coluna liga o pedido novo ao ingresso que ele substituiu.
--
-- UNIQUE: um ingresso só é substituído UMA vez. É a trava contra o clique
-- duplo e contra duas abas confirmando juntas — a segunda esbarra aqui e a
-- transação inteira volta.
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS rescheduled_from_ticket_id uuid REFERENCES tickets(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX IF NOT EXISTS orders_rescheduled_from_ticket_uq
  ON orders (rescheduled_from_ticket_id) WHERE rescheduled_from_ticket_id IS NOT NULL;

COMMENT ON COLUMN orders.rescheduled_from_ticket_id IS
  'Pedido nascido de reagendamento pelo cliente: o ingresso (cancelado) que ele substituiu. Valor zero — o dinheiro está no pedido original.';
