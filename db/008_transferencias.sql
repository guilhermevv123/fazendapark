-- Transferência nominal de ingresso.
--
-- O problema que isso resolve existe com ou sem o sistema: alguém compra
-- quatro, dois não podem ir, e o ingresso vai parar no WhatsApp. Sem uma via
-- oficial, a portaria recebe uma pessoa com o nome de outra no ingresso e não
-- tem como saber se foi repasse honesto ou golpe — e quem comprou de terceiro
-- descobre na fila que o QR já entrou.
--
-- Por isso a transferência é uma LINHA, não uma edição do titular: guarda de
-- quem saiu, pra quem foi, quando, e quem no time apertou o botão. Trocar
-- `tickets.holder_name` direto resolveria a tela e apagaria a história.

CREATE TABLE IF NOT EXISTS ticket_transfers (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  event_id     uuid NOT NULL REFERENCES events(id)  ON DELETE CASCADE,
  ticket_id    uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,

  -- quem era o titular quando a transferência saiu. É a cópia que permite
  -- desfazer: cancelar devolve o ingresso pro último titular, e o último
  -- titular tem que estar guardado em algum lugar que a edição não apagou.
  de_nome      text,
  de_email     text,
  de_documento text,

  para_nome      text NOT NULL,
  para_email     text NOT NULL,
  para_documento text,
  para_telefone  text,

  status     text NOT NULL DEFAULT 'aguardando'
             CHECK (status IN ('aguardando','concluido','cancelado','expirado')),
  -- token do link que a pessoa abre pra aceitar; opaco e único
  code       text NOT NULL UNIQUE,

  criado_por uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz,
  accepted_at  timestamptz,
  canceled_at  timestamptz
);

-- UMA transferência pendente por ingresso. Sem esta trava dá pra mandar o
-- mesmo ingresso pra duas pessoas, as duas aceitam, e a segunda ganha o
-- lugar da primeira sem ninguém saber — as duas já pagaram a quem vendeu.
CREATE UNIQUE INDEX IF NOT EXISTS transferencia_pendente_unica
  ON ticket_transfers (ticket_id) WHERE status = 'aguardando';

CREATE INDEX IF NOT EXISTS transferencias_evento_idx
  ON ticket_transfers (event_id, created_at DESC);
CREATE INDEX IF NOT EXISTS transferencias_ingresso_idx
  ON ticket_transfers (ticket_id);

-- A casa decide se permite. Nasce DESLIGADO: ligar transferência sem querer
-- num evento com lugar marcado é abrir a porta pra cambista organizar a
-- revenda dentro do próprio sistema.
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS allow_transfer boolean NOT NULL DEFAULT false;
