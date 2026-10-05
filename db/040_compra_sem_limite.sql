-- ============================================================================
-- 040 · compra sem limite por pedido — quem limita é o estoque (dono, 05/10)
--
-- "Se o cara quiser comprar um milhão, ele compra, de acordo com o tanto de
-- ingresso disponível." O máximo por compra de cada lote (padrão 6 desde o
-- 001) e o teto do evento (`events.max_per_order`, padrão 20 no código) saem do
-- caminho. Fica só o teto TÉCNICO de 500 por compra (`server/utils/
-- limite-de-compra.ts`): cada ingresso é um QR anexado no e-mail do pedido.
--
-- Os lotes e eventos que já existem passam pro mesmo padrão — a ordem é geral,
-- não "só dos próximos". Quem quiser segurar um lote promocional (ex.: 2 por
-- compra) volta a pôr o número no painel, em Ingressos → lote.
-- ============================================================================

BEGIN;

ALTER TABLE lots ALTER COLUMN max_per_order SET DEFAULT 500;
UPDATE lots SET max_per_order = 500 WHERE max_per_order < 500;

-- sem teto próprio: vale o padrão do código (o teto técnico)
UPDATE events SET max_per_order = NULL WHERE max_per_order IS NOT NULL;

COMMIT;
