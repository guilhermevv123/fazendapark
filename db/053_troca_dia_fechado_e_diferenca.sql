-- 053 — reagendar quando o PARQUE fecha o dia, e troca com diferença a pagar (dono, 24/10/2026)
--
-- Domingo 25/10 (eleição) o parque não abriu com ingresso já vendido. Quem comprou
-- pode remarcar pro próximo evento — mas o próximo evento ainda nem existe, e a
-- regra de sempre ("antes de o dia começar") travaria a troca no dia 26.
--
-- reschedulable_until: o parque fechou o dia deste ingresso e ele segue
-- reagendável pelo site ATÉ esta data, mesmo com o dia já passado. Nulo = regra
-- de sempre. Quem preenche é a operação do parque, por ingresso.
ALTER TABLE tickets
  ADD COLUMN IF NOT EXISTS reschedulable_until timestamptz;

COMMENT ON COLUMN tickets.reschedulable_until IS
  'O parque fechou o dia deste ingresso: reagendável pelo site até aqui, mesmo com o dia já passado. Nulo = antes de o dia começar.';

-- swap_from_ticket_id: pedido de troca COM diferença ("pagou 30, quer o de 50,
-- paga mais 20"). É um pedido normal, cobrado pelo checkout, com o que a pessoa
-- pagou no ingresso antigo como desconto. O ingresso antigo só é cancelado na
-- emissão, quando a diferença é paga — Pix que vence não pode ter matado o
-- ingresso. Aí a emissão passa o id pra `rescheduled_from_ticket_id` (036), e o
-- resto do sistema enxerga uma troca como qualquer outra.
--
-- Sem UNIQUE aqui (diferente da 036): um Pix que venceu deixa a pessoa tentar de
-- novo. Duas trocas abertas pro mesmo ingresso são barradas no checkout, com o
-- ingresso travado; a UNIQUE da 036 continua sendo a trava do pedido PAGO.
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS swap_from_ticket_id uuid REFERENCES tickets(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS orders_swap_from_ticket_idx
  ON orders (swap_from_ticket_id) WHERE swap_from_ticket_id IS NOT NULL;

COMMENT ON COLUMN orders.swap_from_ticket_id IS
  'Troca com diferença paga: o ingresso que este pedido substitui. Cancelado só quando o pedido é pago (emissão).';
