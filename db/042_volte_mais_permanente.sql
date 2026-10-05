-- 042 — "Volte Mais" permanente + cupom de consumação com carimbo (dono, 05/10/2026)
--
-- O pedido: "quando ela comprar pela primeira vez, ganha desconto nas demais vezes de forma
-- PERMANENTE — 50% na entrada e 10% na consumação". E a consumação não passa pelo nosso sistema
-- (o bar é da Zig): a moça do caixa precisa de algo pra conferir "está válido?" e dar baixa.
--
-- 1. Permanente:
--    · `retornos` NULL = sem limite (todas as próximas visitas). Número continua possível.
--    · `vigencia_fim` NULL = por tempo indeterminado. Ligar passa a exigir só o INÍCIO: programa de
--      fidelidade sem data de fim é o padrão do mercado (passaporte de cliente); o regulamento diz
--      que o parque pode encerrar avisando com 30 dias e que compra já feita mantém o desconto.
--
-- 2. Cupom de consumação (`loyalty_vouchers`): UM por pedido do retorno (= uma visita), nasce
--    quando alguém pede (página do ingresso, e-mail) — não depende de qual caminho pagou o pedido.
--    · `token`  — o QR/link (/consumo/<token>): a atendente abre com a câmera do celular dela;
--    · `codigo` — 6 caracteres pra digitar quando a câmera não ajuda;
--    · o percentual e o dia ficam CONGELADOS no cupom: mudar o programa amanhã não muda o cupom
--      que o cliente já tem no e-mail.
--    O resgate é linha em `loyalty_voucher_usos` (quem, quando) — "quantas vezes já usou" é a
--    contagem, sem saldo pra desandar. Print reaproveitado volta como "já usado" porque quem
--    decide é o servidor, lido no celular da ATENDENTE, não a tela do cliente.

ALTER TABLE loyalty_programs ALTER COLUMN retornos DROP NOT NULL;
ALTER TABLE loyalty_programs DROP CONSTRAINT IF EXISTS loyalty_programs_retornos_check;
DO $$ BEGIN
  ALTER TABLE loyalty_programs ADD CONSTRAINT loyalty_programs_retornos_faixa
    CHECK (retornos IS NULL OR retornos BETWEEN 1 AND 50);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE loyalty_programs DROP CONSTRAINT IF EXISTS loyalty_programs_vigencia_pra_ligar;
DO $$ BEGIN
  ALTER TABLE loyalty_programs ADD CONSTRAINT loyalty_programs_inicio_pra_ligar
    CHECK (NOT ativo OR vigencia_inicio IS NOT NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- quantas vezes o cupom pode ser carimbado na visita (1 = a moça dá os 10% uma vez) ou vale o dia todo
ALTER TABLE loyalty_programs
  ADD COLUMN IF NOT EXISTS consumacao_usos int NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS consumacao_dia_todo boolean NOT NULL DEFAULT false;
DO $$ BEGIN
  ALTER TABLE loyalty_programs ADD CONSTRAINT loyalty_programs_consumacao_usos_faixa
    CHECK (consumacao_usos BETWEEN 1 AND 20);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS loyalty_vouchers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  order_id        uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  program_id      uuid NOT NULL REFERENCES loyalty_programs(id) ON DELETE RESTRICT,
  token           text NOT NULL CHECK (length(token) BETWEEN 20 AND 64),
  codigo          text NOT NULL CHECK (codigo ~ '^[A-HJ-NP-Z2-9]{6}$'),
  consumacao_bps  int  NOT NULL CHECK (consumacao_bps BETWEEN 1 AND 10000),
  usos_max        int  NOT NULL CHECK (usos_max BETWEEN 1 AND 20),
  dia_todo        boolean NOT NULL DEFAULT false,
  dia             date NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS loyalty_vouchers_order_uq  ON loyalty_vouchers (order_id);
CREATE UNIQUE INDEX IF NOT EXISTS loyalty_vouchers_token_uq  ON loyalty_vouchers (token);
CREATE UNIQUE INDEX IF NOT EXISTS loyalty_vouchers_codigo_uq ON loyalty_vouchers (org_id, codigo);

CREATE TABLE IF NOT EXISTS loyalty_voucher_usos (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  voucher_id  uuid NOT NULL REFERENCES loyalty_vouchers(id) ON DELETE CASCADE,
  usado_em    timestamptz NOT NULL DEFAULT now(),
  usado_por   text,
  -- a atendente liberou sem a entrada do dia registrada (conferiu o documento na mão)
  sem_entrada boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS loyalty_voucher_usos_voucher_idx ON loyalty_voucher_usos (voucher_id, usado_em);

ALTER TABLE loyalty_vouchers ENABLE ROW LEVEL SECURITY;
ALTER TABLE loyalty_voucher_usos ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE loyalty_vouchers IS
  'Cupom de consumação do Volte Mais (042): 1 por pedido do retorno; QR/código que o caixa do bar confere e carimba.';
COMMENT ON TABLE loyalty_voucher_usos IS
  'Cada carimbo do cupom de consumação no caixa (042). Usos = contagem.';
