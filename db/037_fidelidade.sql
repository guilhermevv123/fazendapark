-- 037 — programa de fidelidade "Volte Mais" (dono, 05/10/2026)
--
-- O pedido do dono: o cliente compra o 1º ingresso a preço cheio; nas próximas visitas paga
-- METADE, por um número limitado de vezes (ex.: as 2 próximas), e ganha 10% na consumação.
-- Tudo o que o dono pode querer mudar depois é coluna aqui — nada cravado no código:
--
--   desconto_bps          quanto sai no ingresso do retorno (5000 = 50%)
--   retornos              quantas compras com desconto cada CPF ganha (2)
--   prazo_dias            em quantos dias depois da 1ª visita o retorno tem que ACONTECER (NULL = até o fim da vigência)
--   ingressos_por_compra  quantos ingressos com desconto numa compra (1 = só o titular; 4 = a família)
--   conta_visita          o que é "visitou": 'entrada' (passou na portaria) ou 'compra' (pagou)
--   dias_semana/vale_feriado/eventos_fora   onde NÃO vale (encher dia fraco, segurar alta temporada)
--   vale_visita_anterior  quem visitou ANTES da vigência começar já ganha? (padrão: não)
--   consumacao_bps        o desconto na consumação — informativo: o bar é da Zig, o selo sai no ingresso
--   vigencia_inicio/fim   obrigatórias pra ligar: promoção sem prazo deixa de ser promoção (Senacon, NT 3/2019)
--
-- Uso: o pedido com desconto carrega `loyalty_program_id` e a parte do desconto que é do programa.
-- "Quantos retornos este CPF já usou" é a CONTAGEM desses pedidos em pé — pedido expirado,
-- cancelado ou estornado devolve o retorno sozinho, sem tabela de saldo pra desandar.
-- O desconto mora em `discount_cents` como qualquer outro (o CHECK do total segue valendo); a
-- coluna nova só diz quanto dele veio do programa.

CREATE TABLE IF NOT EXISTS loyalty_programs (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  nome                 text NOT NULL DEFAULT 'Volte Mais' CHECK (length(nome) BETWEEN 2 AND 60),
  ativo                boolean NOT NULL DEFAULT false,
  desconto_bps         int NOT NULL DEFAULT 5000 CHECK (desconto_bps BETWEEN 100 AND 10000),
  retornos             int NOT NULL DEFAULT 2 CHECK (retornos BETWEEN 1 AND 50),
  prazo_dias           int CHECK (prazo_dias IS NULL OR prazo_dias BETWEEN 1 AND 730),
  ingressos_por_compra int NOT NULL DEFAULT 1 CHECK (ingressos_por_compra BETWEEN 1 AND 20),
  conta_visita         text NOT NULL DEFAULT 'entrada' CHECK (conta_visita IN ('entrada', 'compra')),
  dias_semana          int[] NOT NULL DEFAULT ARRAY[0,1,2,3,4,5,6]
                         CHECK (dias_semana <@ ARRAY[0,1,2,3,4,5,6] AND cardinality(dias_semana) > 0),
  vale_feriado         boolean NOT NULL DEFAULT true,
  eventos_fora         uuid[] NOT NULL DEFAULT '{}',
  vale_visita_anterior boolean NOT NULL DEFAULT false,
  consumacao_bps       int NOT NULL DEFAULT 1000 CHECK (consumacao_bps BETWEEN 0 AND 10000),
  vigencia_inicio      date,
  vigencia_fim         date,
  regulamento          text CHECK (regulamento IS NULL OR length(regulamento) <= 6000),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  updated_by           text,
  CONSTRAINT loyalty_programs_vigencia_pra_ligar CHECK (NOT ativo OR (vigencia_inicio IS NOT NULL AND vigencia_fim IS NOT NULL)),
  CONSTRAINT loyalty_programs_vigencia_ordem CHECK (vigencia_fim IS NULL OR vigencia_inicio IS NULL OR vigencia_fim >= vigencia_inicio)
);

-- um programa por organização (por ora): a tela edita "o" programa, não uma lista
CREATE UNIQUE INDEX IF NOT EXISTS loyalty_programs_org_uq ON loyalty_programs (org_id);

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS loyalty_program_id uuid REFERENCES loyalty_programs(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS loyalty_discount_cents int NOT NULL DEFAULT 0;

DO $$ BEGIN
  ALTER TABLE orders ADD CONSTRAINT orders_loyalty_discount_faixa
    CHECK (loyalty_discount_cents >= 0 AND loyalty_discount_cents <= discount_cents);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS orders_loyalty_program_idx
  ON orders (loyalty_program_id) WHERE loyalty_program_id IS NOT NULL;

ALTER TABLE loyalty_programs ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE loyalty_programs IS
  'Programa de fidelidade da organização (037): 1ª visita cheia, os próximos retornos com desconto. Uso = pedidos em pé com loyalty_program_id.';
COMMENT ON COLUMN orders.loyalty_discount_cents IS
  'Quanto de discount_cents veio do programa de fidelidade (037). 0 = pedido sem fidelidade.';
