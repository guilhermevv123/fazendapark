-- 027 — o cadastro do cliente
--
-- Até aqui `customers` era o que o PEDIDO precisava pra emitir ingresso: nome,
-- e-mail, CPF, telefone. Serve pra vender, não pra conhecer quem compra — e o
-- parque quer a base de clientes pra falar com eles depois (follow-up,
-- remarketing): onde moram, que idade têm, como chamar no WhatsApp e no
-- Instagram.
--
-- Tudo é ADITIVO e nulo por padrão: os 900+ clientes que já existem (balcão,
-- compras antigas) continuam válidos, só "sem cadastro". Quem preencheu o
-- formulário do site tem `registered_at`; quem só passou pelo balcão não.
--
-- ## Duas decisões que valem mais que as colunas
--
-- 1. **`password_hash` é definida sem verificar o e-mail.** Quem compra digita
--    o e-mail e cria a senha no mesmo formulário, e nada prova que o e-mail é
--    dele. Hoje isso é inofensivo porque NÃO existe login de cliente. No dia em
--    que existir, a senha só vale depois de o dono do e-mail confirmar por um
--    link — senão quem cadastrar primeiro o e-mail (e o CPF) de outra pessoa
--    fica com a conta dela.
--
-- 2. **`marketing_opt_in` é consentimento, não conveniência.** Começa `false`
--    e só vira `true` por marcação explícita do cliente (LGPD). O carimbo
--    guarda QUANDO ele disse sim; sem isso não há como provar o consentimento.

ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS birth_date          date,
  ADD COLUMN IF NOT EXISTS instagram           text,
  ADD COLUMN IF NOT EXISTS zip_code            text,
  ADD COLUMN IF NOT EXISTS street              text,
  ADD COLUMN IF NOT EXISTS address_number      text,
  ADD COLUMN IF NOT EXISTS neighborhood        text,
  ADD COLUMN IF NOT EXISTS city                text,
  ADD COLUMN IF NOT EXISTS state               text,
  ADD COLUMN IF NOT EXISTS address_complement  text,
  ADD COLUMN IF NOT EXISTS password_hash       text,
  ADD COLUMN IF NOT EXISTS marketing_opt_in    boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS marketing_opt_in_at timestamptz,
  ADD COLUMN IF NOT EXISTS registered_at       timestamptz;

-- UF sempre em maiúsculas e com duas letras: o relatório por estado agrupa por
-- este texto, e "ba", "Ba" e "BA" viram três linhas.
ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_state_uf;
ALTER TABLE customers ADD CONSTRAINT customers_state_uf
  CHECK (state IS NULL OR state ~ '^[A-Z]{2}$');

-- Só o piso: o teto "não nasceu no futuro" muda todo dia e não cabe em CHECK
-- (a API confere). O piso pega o erro de digitação clássico, ano com dois
-- dígitos virando 0026.
ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_birth_piso;
ALTER TABLE customers ADD CONSTRAINT customers_birth_piso
  CHECK (birth_date IS NULL OR birth_date >= DATE '1900-01-01');

-- A lista de clientes filtra por cidade e pelo recorte "aceita novidades".
CREATE INDEX IF NOT EXISTS customers_org_city_idx ON customers (org_id, city);
CREATE INDEX IF NOT EXISTS customers_org_optin_idx ON customers (org_id) WHERE marketing_opt_in;

COMMENT ON COLUMN customers.password_hash IS
  'bcrypt da senha criada no cadastro do checkout. NÃO há login de cliente ainda; '
  'quando houver, exigir confirmação do e-mail antes de honrar esta senha.';
COMMENT ON COLUMN customers.registered_at IS
  'Quando o cliente preencheu o cadastro completo no site. NULL = só passou pelo balcão ou comprou sem cadastro.';
COMMENT ON COLUMN customers.marketing_opt_in_at IS
  'Quando o cliente marcou (ou desmarcou) "quero receber novidades". É a prova do consentimento.';
