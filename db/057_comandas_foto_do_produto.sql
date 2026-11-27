-- 057 — Comandas: foto real do produto (dono, 27/11/2026)
--
-- `comanda_itens.foto`:
--   NULL            = automática: o tablet usa a foto pronta pelo nome do produto
--                     (`public/comandas/fotos`, `app/composables/comandaFotos.ts`), senão o ícone;
--   'nenhuma'       = sem foto, só o ícone;
--   '/api/cardapio-foto/<id>.webp' = a foto que o dono enviou pelo painel.
--
-- `comanda_fotos`: as fotos enviadas, já reduzidas (webp ~600px, dezenas de KB), no próprio
-- banco: funciona igual no servidor e no PC de teste, sem depender do R2.
-- Só coisa nova: coluna com NULL e tabela nova.
ALTER TABLE comanda_itens ADD COLUMN IF NOT EXISTS foto text CHECK (foto IS NULL OR length(foto) <= 300);

CREATE TABLE IF NOT EXISTS comanda_fotos (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  bytes       bytea NOT NULL,
  criado_em   timestamptz NOT NULL DEFAULT now(),
  criado_por  uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS comanda_fotos_org ON comanda_fotos (org_id);
