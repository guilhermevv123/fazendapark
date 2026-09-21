-- 006 — transferências (saque do produtor) e o que define um passaporte.
--
-- Duas coisas que a tela pediu e o schema não tinha.

-- ---------------------------------------------------------------- passaporte
-- Um setor 'ingresso' admite uma pessoa numa sessão. Um PASSAPORTE admite a
-- mesma pessoa em várias (3 dias de parque). Uma MESA admite várias pessoas de
-- uma vez (mesa de 4). Sem estas duas colunas os três viram a mesma coisa, e a
-- portaria conta 1 entrada onde deveria contar 4 — o parque lota com o painel
-- mostrando metade.
ALTER TABLE sectors
  ADD COLUMN IF NOT EXISTS admits int NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS sessions_covered int;

ALTER TABLE sectors DROP CONSTRAINT IF EXISTS admits_positivo;
ALTER TABLE sectors ADD CONSTRAINT admits_positivo CHECK (admits >= 1 AND admits <= 100);

COMMENT ON COLUMN sectors.admits IS
  'Quantas PESSOAS entram por unidade vendida. Mesa de 4 = 4.';
COMMENT ON COLUMN sectors.sessions_covered IS
  'Quantas SESSÕES a unidade cobre. Passaporte de 3 dias = 3. NULL = uma só.';

-- -------------------------------------------------------------- transferência
-- O dinheiro do ingresso entra na conta da plataforma e precisa sair pra conta
-- do produtor. Esse trecho é o que mais gera ligação de produtor, então cada
-- transferência guarda: quem pediu, pra onde foi, quanto, e o que o gateway
-- respondeu — nessa ordem, porque é a ordem das perguntas.
CREATE TABLE IF NOT EXISTS payouts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- NULL = saque do saldo geral da organização, não amarrado a um evento.
  event_id         uuid REFERENCES events(id) ON DELETE SET NULL,
  code             text NOT NULL UNIQUE,

  beneficiary_name text NOT NULL,
  beneficiary_doc  text,
  -- 'pix' | 'conta' — como o dinheiro sai
  destination_kind text NOT NULL CHECK (destination_kind IN ('pix', 'conta')),
  -- chave pix, ou banco/agência/conta em texto. NUNCA guardamos senha nem
  -- token do banco aqui: isto é só o endereço do dinheiro.
  destination      text NOT NULL,

  amount_cents     bigint NOT NULL CHECK (amount_cents > 0),
  fee_cents        bigint NOT NULL DEFAULT 0,

  status           text NOT NULL DEFAULT 'solicitada'
                   CHECK (status IN ('solicitada','processando','concluida','falhou','cancelada')),
  -- quem clicou. Transferência sem autor é o pior campo pra faltar numa
  -- auditoria de dinheiro.
  requested_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  requested_at     timestamptz NOT NULL DEFAULT now(),
  processed_at     timestamptz,

  asaas_transfer_id text,
  error            text,
  notes            text
);

CREATE INDEX IF NOT EXISTS payouts_org_requested_idx ON payouts (org_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS payouts_event_idx ON payouts (event_id) WHERE event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS payouts_status_idx ON payouts (status)
  WHERE status IN ('solicitada','processando');
