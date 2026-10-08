-- 048 — quantas PESSOAS um ingresso do TIPO leva (dono, 08/10: "o combo é um ingresso que conta como 10, 15…
-- preciso colocar que é combo, o valor, e quantos ingressos conta, pra contagem ficar certa").
--
-- "Pessoas por unidade" existia só no SETOR (`sectors.admits`, mesa de 4). No parque o combo de 10 mora
-- no MESMO setor "Geral" da entrada individual, então entrava na catraca contando 1 pessoa e o painel
-- dizia 1 ingresso vendido. Agora o tipo diz quantas pessoas cada ingresso dele leva.
--
-- NULL = usa o do setor (o de sempre): nada muda pra entrada individual, mesa ou passaporte.
ALTER TABLE ticket_types ADD COLUMN IF NOT EXISTS admits int;
DO $$ BEGIN
  ALTER TABLE ticket_types ADD CONSTRAINT ticket_types_admits_faixa CHECK (admits IS NULL OR admits BETWEEN 1 AND 100);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMENT ON COLUMN ticket_types.admits IS
  'Pessoas por ingresso deste tipo (combo de 10 = 10). NULL = o do setor (sectors.admits).';
