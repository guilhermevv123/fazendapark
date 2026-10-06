-- ============================================================================
-- 043 · preço próprio do TIPO de ingresso (dono, 05/10)
--
-- "O primeiro lote com Normal, VIP e Black, cada um com preço diferente." Até aqui o tipo só tinha
-- `discount_bps` (desconto sobre o preço do lote): a meia cabia, o VIP mais caro que o lote não.
--
-- `price_cents` NULL = vale o desconto, como sempre. Preenchido = é a face do tipo (mesma natureza
-- do `lots.price_cents`: no modo "repassar" a taxa entra por cima). Quem calcula é UMA função só,
-- `faceDoTipo` (server/utils/dinheiro.ts) — vitrine, checkout, cupom, bilheteria e painel.
-- Zero não entra aqui: ingresso de graça é o lote gratuito (de propósito) ou 100% de desconto.
-- ============================================================================

BEGIN;

ALTER TABLE ticket_types ADD COLUMN IF NOT EXISTS price_cents int;

DO $$ BEGIN
  ALTER TABLE ticket_types ADD CONSTRAINT ticket_types_price_cents_positivo
    CHECK (price_cents IS NULL OR (price_cents > 0 AND price_cents <= 10000000));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMIT;
