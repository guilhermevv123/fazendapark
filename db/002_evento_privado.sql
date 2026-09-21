-- Dois campos que a plataforma de origem tem e o schema inicial não previa.
--
-- is_private: evento que não aparece em listagem nenhuma, só abre por link
-- direto. É o que sustenta pré-venda fechada e evento corporativo.
--
-- sales_end_minutes_after: no painel deles, o encerramento da venda pode ser
-- "X minutos APÓS o início" em vez de uma data fixa. Guardar o número e não a
-- data resolvida é o que permite remarcar o evento sem a venda continuar
-- presa ao horário velho — mesma razão de nunca gravar URL absoluta no banco.
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS is_private boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS sales_end_minutes_after int;

ALTER TABLE events
  ADD CONSTRAINT encerramento_por_data_ou_por_minutos
  CHECK (sales_end_at IS NULL OR sales_end_minutes_after IS NULL);

CREATE INDEX IF NOT EXISTS events_org_status_idx ON events (org_id, status);
CREATE INDEX IF NOT EXISTS events_slug_idx ON events (slug);
