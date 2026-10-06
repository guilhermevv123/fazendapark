-- 044 · ingresso SEM limite de quantidade (dono, 06/10: "não vai ter isso de quantidade, vai ser
-- infinito; o lote só fecha se a pessoa quiser"). "Sem limite" = 1.000.000, o teto que o sistema
-- já aceita (ver server/utils/estoque-sem-limite.ts): o motor de estoque segue igual.
--
-- Só o que AINDA VENDE vira sem limite. Lote/tipo esgotado continua esgotado: reabrir venda sem o
-- dono pedir seria pior que o limite. Capacidade de setor sai (era o teto da soma dos lotes).
-- Idempotente: rodar de novo não muda nada.
BEGIN;

UPDATE ticket_types tt
   SET quantity = 1000000
  FROM lots l
 WHERE l.id = tt.lot_id
   AND l.quantity < 1000000 AND l.sold + l.reserved < l.quantity
   AND tt.quantity < 1000000 AND tt.sold < tt.quantity;

UPDATE lots
   SET quantity = 1000000
 WHERE quantity < 1000000 AND sold + reserved < quantity;

UPDATE sectors SET capacity = NULL WHERE capacity IS NOT NULL;

COMMIT;
