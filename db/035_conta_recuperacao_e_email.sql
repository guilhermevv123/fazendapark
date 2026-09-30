-- ============================================================================
-- 035 · recuperar a senha e confirmar o e-mail da conta do cliente (30/09)
--
-- A proposta do parque promete (itens 4.2 e 4.4): confirmação de e-mail e
-- redefinição de senha "com link de uso único e prazo de validade".
--
-- 1. **Um token por pedido, guardado só o HASH.** O link leva o segredo; o
--    banco guarda sha256 dele. Quem lê o banco (backup, suporte) não consegue
--    redefinir a senha de ninguém.
-- 2. **Uso único e prazo no próprio banco.** `used_at` marcado no MESMO UPDATE
--    que confere o prazo: dois cliques no link (ou o link aberto em dois
--    aparelhos) redefinem uma vez só.
-- 3. **O e-mail pra onde o link foi.** Confirmar vale só enquanto a conta ainda
--    tem ESSE e-mail — trocou o e-mail em "Meus dados", o link antigo morre.
-- 4. **`email_confirmed_at` não trava a compra.** É informação (e a porta pra,
--    no futuro, só herdar pedido antigo de e-mail provado). A conta segue
--    comprando antes de confirmar.
-- ============================================================================

BEGIN;

ALTER TABLE customer_accounts
  ADD COLUMN IF NOT EXISTS email_confirmed_at timestamptz;

CREATE TABLE IF NOT EXISTS customer_account_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES customer_accounts(id) ON DELETE CASCADE,
  purpose     text NOT NULL CHECK (purpose IN ('redefinir_senha', 'confirmar_email')),
  token_hash  text NOT NULL UNIQUE,
  email       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  ip          text
);
CREATE INDEX IF NOT EXISTS customer_account_tokens_vivos_idx
  ON customer_account_tokens (account_id, purpose, created_at DESC) WHERE used_at IS NULL;

-- a API pública do Supabase não enxerga (o app entra como dono; sem política = ninguém mais)
ALTER TABLE customer_account_tokens ENABLE ROW LEVEL SECURITY;

COMMENT ON COLUMN customer_accounts.email_confirmed_at IS
  'Quando o dono do e-mail clicou no link de confirmação (ou o Google/Apple provou o e-mail). Não trava a compra.';
COMMENT ON TABLE customer_account_tokens IS
  'Links de uso único da conta do cliente (035): redefinir senha (30 min) e confirmar e-mail (3 dias). Só o sha256 do segredo.';

COMMIT;
