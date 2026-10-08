-- 050 — o combo vira N ingressos, um por pessoa (dono, 08/10: "os combos, quando o cara compra, não é pra
-- aparecer o ingresso só ... tem que aparecer os 10, porque ele vai invalidando ingresso por ingresso ...
-- saber esse combo aqui, 9 pessoas foram, 1 não foi").
--
-- Até a 049 cada UNIDADE de combo era UM ingresso que levava 10 pessoas (`ticket_types.admits`, 048).
-- Agora cada unidade emite `admits` ingressos com `people = 1`, irmãos pelo `combo_group`, numerados
-- `combo_seq` de 1 a `combo_size`. O estoque e os contadores (lots.sold, ticket_types.sold,
-- order_items.quantity) seguem por UNIDADE: nada de estoque muda.
--
-- `people` NULL = a regra de antes (o do tipo, senão o do setor): o combo antigo que ainda é um
-- ingresso só continua contando 10, e mesa/passaporte não mudam.
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS people int;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS combo_group uuid;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS combo_seq int;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS combo_size int;
DO $$ BEGIN
  ALTER TABLE tickets ADD CONSTRAINT tickets_people_faixa CHECK (people IS NULL OR people BETWEEN 1 AND 100);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE tickets ADD CONSTRAINT tickets_combo_coerente CHECK (
    (combo_group IS NULL AND combo_seq IS NULL AND combo_size IS NULL)
    OR (combo_group IS NOT NULL AND combo_size BETWEEN 2 AND 100 AND combo_seq BETWEEN 1 AND combo_size));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE UNIQUE INDEX IF NOT EXISTS tickets_combo_parte ON tickets (combo_group, combo_seq) WHERE combo_group IS NOT NULL;

COMMENT ON COLUMN tickets.people IS
  'Pessoas que ESTE ingresso leva. NULL = o do tipo (ticket_types.admits), senão o do setor. Parte de combo = 1.';
COMMENT ON COLUMN tickets.combo_group IS
  'Os ingressos de UMA unidade de combo (050): mesmo grupo, combo_seq de 1 a combo_size.';
