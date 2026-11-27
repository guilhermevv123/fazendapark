-- 056 — Comandas: funcionário só das comandas e preso ao(s) local(is) dele (dono, 27/11/2026)
--
-- O dono cria o login do funcionário dentro das Comandas (Configurações → Equipe e regras).
-- Esse login:
--   * `so_comandas`: entra SÓ nas comandas (app do tablet). O porteiro de `/api/admin`,
--     `/api/checkin` e `/api/portaria` recusa (`server/middleware/03b.so-comandas.ts`);
--   * `pontos`: os locais de venda em que ele atende. NULL = todos. Com locais marcados, o
--     tablet dele só mostra esses e o servidor recusa pedido de outro local. Só o dono muda.
--
-- Só colunas novas, com valor padrão que mantém tudo como estava.
ALTER TABLE comanda_acessos ADD COLUMN IF NOT EXISTS so_comandas boolean NOT NULL DEFAULT false;
ALTER TABLE comanda_acessos ADD COLUMN IF NOT EXISTS pontos uuid[];
