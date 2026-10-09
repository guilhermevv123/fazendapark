-- ============================================================================
-- 051 · "esqueci a senha" da EQUIPE (dono, 09/10: "coloca o esqueci a senha em tudo, mesmo na
-- portaria e no admin ... pra evitar dor de cabeça").
--
-- Mesma mecânica da conta do cliente (035): o link leva o segredo, o banco guarda só o sha256;
-- uso único e prazo conferidos no MESMO UPDATE; pedir um link novo aposenta os anteriores; o link
-- vale só enquanto o acesso tiver o e-mail pra onde ele foi.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS user_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose     text NOT NULL CHECK (purpose IN ('redefinir_senha')),
  token_hash  text NOT NULL UNIQUE,
  email       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  ip          text
);
CREATE INDEX IF NOT EXISTS user_tokens_vivos_idx
  ON user_tokens (user_id, purpose, created_at DESC) WHERE used_at IS NULL;

-- a API pública do Supabase não enxerga (o app entra como dono; sem política = ninguém mais)
ALTER TABLE user_tokens ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE user_tokens IS
  'Links de uso único da EQUIPE (051): redefinir a senha (30 min). Só o sha256 do segredo.';

COMMIT;
