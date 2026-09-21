-- 004 — sessões de login.
--
-- O token da sessão é guardado AQUI EM HASH, nunca em claro. O que vai pro
-- cookie do navegador é o segredo; o que fica no banco é o SHA-256 dele. Um
-- dump do banco, um log de query ou um backup vazado não dão acesso a conta
-- nenhuma — que é o contrário do que acontece quando se grava o token cru.
--
-- Sobre o prazo: 30 dias, com renovação deslizante a cada uso. Isso é decisão
-- de produto tomada com cicatriz: no CRM o cookie durava 8 horas sem renovar,
-- e a equipe era jogada pra fora no meio do expediente todo dia. Portaria
-- trabalhando num evento das 20h às 4h da manhã não pode ser deslogada às 2h.

CREATE TABLE IF NOT EXISTS sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   text NOT NULL UNIQUE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  user_agent   text,
  ip           text,
  revoked_at   timestamptz
);

CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions (expires_at);

-- Tentativas de login, pra travar força bruta por e-mail e por IP.
-- Guardar a tentativa ERRADA é o ponto: sem histórico de falha, qualquer
-- limite de tentativas é chute.
CREATE TABLE IF NOT EXISTS login_attempts (
  id         bigserial PRIMARY KEY,
  email      text NOT NULL,
  ip         text,
  ok         boolean NOT NULL,
  at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS login_attempts_email_at_idx ON login_attempts (email, at DESC);
CREATE INDEX IF NOT EXISTS login_attempts_ip_at_idx ON login_attempts (ip, at DESC);
