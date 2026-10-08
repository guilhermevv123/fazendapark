-- 049 — TROCA DE DIA NA PORTARIA (dono, 08/10: "e se aparecer alguém com ingresso de sábado pra entrar
-- domingo? ... bloquear, mas se a pessoa quiser entrar, ela faz o pagamento lá na hora, o valor da
-- diferença, e aí ela entra"; "lembrando que é Android" e "a internet pode cair").
--
-- O ingresso de outro dia segue BARRADO pela régua de 047. O que esta tabela guarda é a exceção paga:
-- o porteiro cobra a diferença entre o tipo de HOJE e o que a pessoa pagou, e libera. Uma linha por
-- troca, com o dinheiro, a forma, quem cobrou, o aparelho e se foi sem rede.
--
-- `id` nasce no APARELHO e é o MESMO id da passagem em `entries`: reenviar a fila do tablet (rede
-- voltando, botão cutucado) não cobra duas vezes nem conta a pessoa duas vezes — o `ON CONFLICT (id)`
-- dos dois INSERTs segura os dois lados.
--
-- `cobrado_cents` é o que o porteiro DISSE que recebeu (o dinheiro na mão dele); `esperado_cents` é o
-- que o servidor calcula com os preços de agora. Sem rede o tablet decide com a lista baixada, e se o
-- preço mudou no meio-tempo os dois divergem — a linha fica marcada, nunca apagada nem corrigida.
CREATE TABLE IF NOT EXISTS day_changes (
  id              uuid PRIMARY KEY,
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  event_id        uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  ticket_id       uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  -- o tipo que a pessoa comprou e o de hoje, com o nome congelado (o tipo pode ser renomeado depois)
  from_type_id    uuid REFERENCES ticket_types(id) ON DELETE SET NULL,
  to_type_id      uuid REFERENCES ticket_types(id) ON DELETE SET NULL,
  from_type_name  text,
  to_type_name    text,
  -- o dia em que a pessoa entrou (calendário do fuso do evento)
  day             date NOT NULL,
  pago_cents      bigint NOT NULL CHECK (pago_cents >= 0),
  preco_cents     bigint NOT NULL CHECK (preco_cents >= 0),
  cobrado_cents   bigint NOT NULL CHECK (cobrado_cents >= 0),
  esperado_cents  bigint NOT NULL CHECK (esperado_cents >= 0),
  forma           text NOT NULL CHECK (forma IN ('dinheiro','pix','credito','debito','sem_diferenca')),
  people          int NOT NULL DEFAULT 1 CHECK (people BETWEEN 1 AND 100),
  gate            text,
  device_id       text,
  operator_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  offline         boolean NOT NULL DEFAULT false,
  -- a hora em que a pessoa passou (do aparelho, conferida) e a hora em que chegou ao servidor
  created_at      timestamptz NOT NULL DEFAULT now(),
  synced_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS day_changes_event_idx ON day_changes (event_id, created_at DESC);
CREATE INDEX IF NOT EXISTS day_changes_ticket_idx ON day_changes (ticket_id);

COMMENT ON TABLE day_changes IS
  'Troca de dia na portaria: ingresso de outro dia que entrou pagando a diferença (049).';
