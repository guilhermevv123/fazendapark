-- ============================================================================
-- 034 · conta do cliente (28/09)
--
-- Pedido do dono: pra comprar, o cliente ENTRA. Cadastro uma vez (nome completo,
-- CPF, e-mail e celular; Instagram e endereço opcionais), e o checkout deixa de
-- pedir esses dados — vêm da conta. Entrar com CPF (ou e-mail) e senha, ou pelo
-- Google/Apple quando a organização configurar as chaves.
--
-- Três decisões:
--
-- 1. **Tabela própria, e não `customers`.** `customers` é o cadastro que o
--    checkout e o balcão vêm gravando por e-mail desde o começo, sem prova de
--    que o e-mail é de quem digitou. Pendurar senha ali era o B17: a primeira
--    pessoa a "criar a conta" de um e-mail herdaria os pedidos antigos dele — e
--    o QR de cada ingresso. A conta nasce vazia e só enxerga o que foi comprado
--    COM ela (`orders.customer_account_id`).
-- 2. **Sessão no banco, como a da equipe.** O cookie leva um segredo opaco; a
--    linha leva o hash. Sair derruba a sessão de verdade, e trocar a senha
--    derruba as outras.
-- 3. **`customer_account_required` por organização.** A página sempre pede a
--    conta; o servidor recusa o checkout sem ela onde a organização exige. Quem
--    existe hoje passa a exigir; organização nova nasce sem exigir.
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS customer_accounts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name                text NOT NULL CHECK (length(btrim(name)) >= 3),
  email               text NOT NULL CHECK (email = lower(btrim(email)) AND position('@' IN email) > 1),
  document            text NOT NULL CHECK (document ~ '^[0-9]{11}$'),
  phone               text NOT NULL CHECK (phone ~ '^[0-9]{10,11}$'),
  password_hash       text,
  google_sub          text,
  apple_sub           text,
  instagram           text,
  zip_code            text,
  street              text,
  address_number      text,
  neighborhood        text,
  city                text,
  state               text CHECK (state IS NULL OR state ~ '^[A-Z]{2}$'),
  address_complement  text,
  marketing_opt_in    boolean NOT NULL DEFAULT false,
  marketing_opt_in_at timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  last_login_at       timestamptz,
  -- conta sem jeito nenhum de entrar não é conta
  CONSTRAINT customer_accounts_tem_entrada
    CHECK (password_hash IS NOT NULL OR google_sub IS NOT NULL OR apple_sub IS NOT NULL)
);

-- Um CPF, um e-mail, uma conta — por organização (o cadastro é do parque).
CREATE UNIQUE INDEX IF NOT EXISTS customer_accounts_org_email_uk ON customer_accounts (org_id, email);
CREATE UNIQUE INDEX IF NOT EXISTS customer_accounts_org_document_uk ON customer_accounts (org_id, document);
CREATE UNIQUE INDEX IF NOT EXISTS customer_accounts_org_google_uk
  ON customer_accounts (org_id, google_sub) WHERE google_sub IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS customer_accounts_org_apple_uk
  ON customer_accounts (org_id, apple_sub) WHERE apple_sub IS NOT NULL;

CREATE TABLE IF NOT EXISTS customer_sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL REFERENCES customer_accounts(id) ON DELETE CASCADE,
  token_hash   text NOT NULL UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz,
  user_agent   text,
  ip           text
);
CREATE INDEX IF NOT EXISTS customer_sessions_account_idx
  ON customer_sessions (account_id) WHERE revoked_at IS NULL;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS customer_account_id uuid REFERENCES customer_accounts(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS orders_customer_account_idx
  ON orders (customer_account_id, created_at DESC) WHERE customer_account_id IS NOT NULL;

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS customer_account_required boolean NOT NULL DEFAULT false;
UPDATE organizations SET customer_account_required = true WHERE NOT customer_account_required;

-- O banco de produção é o Supabase (28/09): a API pública dele (anon/authenticated) não pode ler
-- conta nem sessão. RLS ligado e sem política = nada sai por ela; o sistema entra como dono.
ALTER TABLE customer_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_sessions ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE customer_accounts IS
  'Conta do cliente no site (034). Só enxerga pedidos feitos com ela (orders.customer_account_id): '
  'o e-mail NÃO é verificado, então pedido antigo do mesmo e-mail não é herdado.';
COMMENT ON COLUMN organizations.customer_account_required IS
  'O checkout do site recusa comprar sem entrar na conta. A página sempre pede; aqui é a porta do servidor.';

COMMIT;
