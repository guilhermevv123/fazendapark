-- Mapa de assentos.
--
-- Setor com lugar marcado deixa de vender "quantidade" e passa a vender
-- LUGAR: a unidade de estoque some do contador do lote e vira uma linha
-- aqui. Por isso o assento carrega o ticket: é a ligação que responde
-- "quem está na fila 12, poltrona 4" — a pergunta que a portaria faz quando
-- duas pessoas sentam no mesmo lugar.
--
-- `label` é o que a pessoa lê ("A12"), `row_label` e `number` são o que o
-- sistema ordena. Guardar só o rótulo faria "A10" vir antes de "A9".

CREATE TABLE IF NOT EXISTS seats (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    uuid NOT NULL REFERENCES events(id)  ON DELETE CASCADE,
  sector_id   uuid NOT NULL REFERENCES sectors(id) ON DELETE CASCADE,
  row_label   text NOT NULL,
  number      int  NOT NULL CHECK (number >= 1),
  label       text NOT NULL,
  -- posição no desenho; permite corredor (buraco) sem inventar assento
  pos_x       int  NOT NULL DEFAULT 0,
  pos_y       int  NOT NULL DEFAULT 0,
  status      text NOT NULL DEFAULT 'livre'
              CHECK (status IN ('livre','reservado','vendido','bloqueado')),
  ticket_id   uuid REFERENCES tickets(id) ON DELETE SET NULL,
  hold_until  timestamptz,
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Dois assentos com o mesmo nome no mesmo setor é o bug que coloca duas
-- pessoas na mesma poltrona. O banco recusa antes de a tela conseguir criar.
CREATE UNIQUE INDEX IF NOT EXISTS seats_setor_rotulo_unico
  ON seats (sector_id, row_label, number);

CREATE INDEX IF NOT EXISTS seats_event_idx  ON seats (event_id, sector_id);
CREATE INDEX IF NOT EXISTS seats_ticket_idx ON seats (ticket_id);

-- Um ingresso ocupa no máximo um assento. Sem isto, um erro de gravação
-- espalharia o mesmo ingresso por vários lugares e o mapa mostraria lotação
-- maior que a venda.
CREATE UNIQUE INDEX IF NOT EXISTS seats_ticket_unico
  ON seats (ticket_id) WHERE ticket_id IS NOT NULL;

-- O setor passa a saber que é numerado. A coluna vive aqui e não numa tabela
-- à parte porque toda consulta de venda já carrega o setor.
ALTER TABLE sectors
  ADD COLUMN IF NOT EXISTS seated boolean NOT NULL DEFAULT false;
