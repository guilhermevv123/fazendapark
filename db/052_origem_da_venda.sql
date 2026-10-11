-- ============================================================================
-- 052 · de onde veio a venda (dono, 11/10: "a gente está com o tráfego pago ativo e eu não consigo
-- saber de onde está vindo a pessoa"). Até aqui a UTM do link morria na chegada ao site: o pedido
-- nascia sem origem e a visita não deixava rastro nenhum (sem log de acesso no servidor).
--
-- · `orders.origem` — a origem que o navegador guardou quando a pessoa CHEGOU (último toque com
--   UTM/clique de anúncio, e o primeiro toque), gravada junto com o pedido do site.
-- · `site_visits` — uma linha por visita (aba aberta) ao site: é o "quem está vendo" por campanha,
--   e o denominador da conversão. Sem IP, sem nome: um id aleatório do navegador e a origem.
-- ============================================================================

BEGIN;

ALTER TABLE orders ADD COLUMN IF NOT EXISTS origem jsonb;

CREATE TABLE IF NOT EXISTS site_visits (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- id aleatório que mora no navegador (não identifica ninguém) + id da aba: a mesma aba conta 1
  visitante   text NOT NULL CHECK (length(visitante) BETWEEN 8 AND 64),
  aba         text NOT NULL CHECK (length(aba) BETWEEN 8 AND 64),
  caminho     text NOT NULL,
  evento_slug text,
  tipo        text NOT NULL CHECK (tipo IN ('pago', 'robo', 'meta_sem_utm', 'organico', 'direto')),
  fonte       text,
  meio        text,
  campanha    text,
  conteudo    text,
  termo       text,
  clique      text CHECK (clique IN ('fbclid', 'gclid', 'ttclid')),
  referencia  text,
  criado_em   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (visitante, aba)
);

CREATE INDEX IF NOT EXISTS site_visits_quando_idx ON site_visits (criado_em);
CREATE INDEX IF NOT EXISTS orders_origem_tipo_idx ON orders ((origem->'ultimo'->>'tipo')) WHERE origem IS NOT NULL;

COMMIT;
