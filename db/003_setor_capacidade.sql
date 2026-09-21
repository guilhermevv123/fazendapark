-- 003 — o setor ganha teto e descrição, e passa a aceitar mesa e camarote.
--
-- Três coisas que a tela de configuração precisa e o schema 001 não tinha:
--
-- 1. `capacity` — o teto do espaço físico. Sem ele, nada impede dois lotes de
--    500 num setor que comporta 600: o sistema vende 1000 ingressos para um
--    lugar de 600 pessoas e o erro só aparece na portaria, no dia.
--
-- 2. `description` — a linha que o comprador lê embaixo do nome do setor
--    ("inclui acesso ao toboágua"). Sem ela a informação vira nome gigante.
--
-- 3. `kind` com mesa e camarote. O CHECK antigo só admitia ingresso e
--    passaporte, e uma mesa de camarote é vendida como unidade com várias
--    pessoas dentro — comportamento diferente na hora de emitir.

ALTER TABLE sectors
  ADD COLUMN IF NOT EXISTS capacity int,
  ADD COLUMN IF NOT EXISTS description text;

ALTER TABLE sectors
  DROP CONSTRAINT IF EXISTS sectors_kind_check;

ALTER TABLE sectors
  ADD CONSTRAINT sectors_kind_check
  CHECK (kind IN ('ingresso', 'passaporte', 'mesa', 'camarote'));

-- Capacidade, quando existir, tem que ser um número de pessoas de verdade.
ALTER TABLE sectors
  ADD CONSTRAINT capacidade_positiva CHECK (capacity IS NULL OR capacity > 0);
