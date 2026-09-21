-- 012_papeis.sql — o papel de cada pessoa da equipe, como DADO explícito.
--
-- POR QUE UMA COLUNA NOVA, E NÃO REAPROVEITAR `role`
--
-- `role` nasceu com sete valores (master, admin, financeiro, marketing,
-- operacional, portaria, leitura) e é lida pelo porteiro antigo
-- (server/middleware/01.autenticacao.ts) como uma grade GROSSA: ela decide se
-- a requisição chega na área "evento" — e a área "evento" inclui, no mesmo
-- prefixo, o saldo do produtor, o borderô e o pedido de transferência. Quem
-- é `operacional` passa por ali hoje: o mesmo login que cadastra lote pede
-- saque.
--
-- A grade FINA é `papel`, e ela tem quatro valores porque são quatro pessoas
-- de verdade no parque:
--
--   master      o dono. tudo.
--   financeiro  dinheiro: saldo, transferência, borderô, extrato, relatório.
--   operacao    evento, ingresso, bilheteria. Nada de caixa nem de saque.
--   portaria    só o leitor de entrada.
--
-- As duas colunas convivem com papéis diferentes e isso é de propósito:
-- `papel` é a VERDADE (server/utils/papeis.ts decide por ela, rota a rota) e
-- `role` continua sendo a grade grossa que o porteiro antigo lê. O mapa de
-- uma pra outra mora em `roleLegado()`, em papeis.ts, e é gravado pelas rotas
-- de equipe — as duas nunca são escolhidas separadamente por um humano.
--
-- O gatilho lá embaixo é o que mantém a promessa de "deny-by-default" viva
-- pra quem insere usuário sem saber que `papel` existe (o seed, os testes de
-- outras rotas): a linha nasce com o papel derivado do `role` que ela mesma
-- declarou, em vez de nascer com o papel mais poderoso ou de estourar a
-- restrição de NOT NULL.

BEGIN;

-- A tradução do mundo velho pro novo, em UM lugar só. O `UPDATE` de backfill
-- e o gatilho de INSERT usam esta função — duas cópias do mesmo CASE é como
-- um lado ganha um papel novo e o outro não.
CREATE OR REPLACE FUNCTION papel_do_role_legado(r text) RETURNS text AS $func$
  SELECT CASE r
    -- admin fazia tudo que o master faz menos mexer em master: vira master.
    WHEN 'master'     THEN 'master'
    WHEN 'admin'      THEN 'master'
    WHEN 'financeiro' THEN 'financeiro'
    WHEN 'portaria'   THEN 'portaria'
    -- marketing, operacional e leitura caem em operacao. Para `leitura` isso
    -- é um ALARGAMENTO (quem só olhava passa a poder editar evento), e é uma
    -- escolha consciente: os quatro papéis não têm um "só olha". O NOTICE
    -- abaixo denuncia quantas linhas foram alargadas — hoje, zero.
    ELSE 'operacao'
  END;
$func$ LANGUAGE sql IMMUTABLE;

ALTER TABLE users ADD COLUMN IF NOT EXISTS papel text;

DO $bloco$
DECLARE alargadas int;
BEGIN
  SELECT count(*) INTO alargadas FROM users WHERE papel IS NULL AND role IN ('leitura', 'marketing');
  IF alargadas > 0 THEN
    RAISE NOTICE '% usuário(s) de leitura/marketing viraram operacao — confira um a um.', alargadas;
  END IF;
END
$bloco$;

UPDATE users SET papel = papel_do_role_legado(role) WHERE papel IS NULL;

ALTER TABLE users ALTER COLUMN papel SET NOT NULL;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_papel_check;
ALTER TABLE users ADD CONSTRAINT users_papel_check
  CHECK (papel IN ('master', 'financeiro', 'operacao', 'portaria'));

COMMENT ON COLUMN users.papel IS
  'Grade fina de permissão, decidida em server/utils/papeis.ts rota a rota. '
  'É a verdade sobre o que a pessoa pode.';
COMMENT ON COLUMN users.role IS
  'Grade grossa legada, lida por server/middleware/01.autenticacao.ts. '
  'Derivada de papel por roleLegado() — não escolha as duas separadamente.';

-- Gatilho de INSERT: preenche `papel` quando quem insere não falou dele.
-- Só PREENCHE, nunca sobrescreve — senão as rotas de equipe, que gravam as
-- duas colunas de propósito, teriam o papel trocado por baixo.
CREATE OR REPLACE FUNCTION users_papel_quando_omitido() RETURNS trigger AS $func$
BEGIN
  IF NEW.papel IS NULL THEN
    NEW.papel := papel_do_role_legado(NEW.role);
  END IF;
  RETURN NEW;
END;
$func$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS users_papel_quando_omitido ON users;
CREATE TRIGGER users_papel_quando_omitido
  BEFORE INSERT ON users
  FOR EACH ROW EXECUTE FUNCTION users_papel_quando_omitido();

COMMIT;
