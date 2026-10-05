-- ============================================================================
-- 038 · Ingresso também pelo WhatsApp (dono, 05/10/2026)
--
-- Quem compra recebe, além do e-mail, uma mensagem no WhatsApp com o link da
-- página do ingresso (/ingressos/<pedido>), onde está o QR. Sai pela UAZAPI,
-- do número do parque (o mesmo da Sofia).
--
-- Mesmo desenho da 018 (e-mail), pelos mesmos motivos:
--   · o envio é uma LINHA, não uma chamada dentro do webhook do pagamento;
--   · quem enfileira é o BANCO, na mesma transação que marca o pedido pago;
--   · UMA mensagem automática por pedido, garantida por índice (o gateway
--     reentrega o aviso de pagamento e isso não pode virar mensagem repetida).
--
-- O telefone vem da conta do cliente (obrigatório no cadastro) e, se não
-- houver conta, do cadastro do pedido. Sem telefone, o gatilho sai calado.
-- Enquanto o ambiente não tiver UAZAPI_URL/UAZAPI_TOKEN, as linhas ficam
-- 'desligado' (o trabalhador não tenta) — nada sai sem a chave ligada.
-- ============================================================================

CREATE TABLE IF NOT EXISTS whatsapp_sends (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  event_id      uuid REFERENCES events(id) ON DELETE CASCADE,
  order_id      uuid REFERENCES orders(id) ON DELETE CASCADE,
  origin        text NOT NULL DEFAULT 'automatico' CHECK (origin IN ('automatico','reenvio')),
  to_phone      text NOT NULL,                 -- só dígitos, com 55
  to_name       text,
  body_text     text,                          -- a mensagem que saiu, gravada na hora do envio
  status        text NOT NULL DEFAULT 'na_fila'
                CHECK (status IN ('na_fila','enviando','enviado','falhou','desligado')),
  attempts      int  NOT NULL DEFAULT 0,
  max_attempts  int  NOT NULL DEFAULT 4 CHECK (max_attempts >= 1),
  last_error    text,
  message_id    text,
  available_at  timestamptz NOT NULL DEFAULT now(),
  claimed_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  sent_at       timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_automatico_unico
  ON whatsapp_sends (order_id) WHERE origin = 'automatico';
CREATE INDEX IF NOT EXISTS whatsapp_fila_idx
  ON whatsapp_sends (available_at) WHERE status IN ('na_fila','enviando');
CREATE INDEX IF NOT EXISTS whatsapp_pedido_idx ON whatsapp_sends (order_id, created_at DESC);

CREATE OR REPLACE FUNCTION enfileirar_whatsapp_de_pedido() RETURNS trigger AS $gatilho$
DECLARE
  fone text;
  nome text;
BEGIN
  IF NEW.status <> 'pago' THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'pago' THEN RETURN NEW; END IF;
  -- carga de histórico (paid_at antigo) não é pagamento de agora: não manda nada
  IF NEW.paid_at IS NOT NULL AND NEW.paid_at < now() - interval '1 day' THEN RETURN NEW; END IF;
  -- cortesia é emitida pela equipe, não comprada: segue só no e-mail
  IF NEW.channel = 'cortesia' THEN RETURN NEW; END IF;

  SELECT regexp_replace(COALESCE(NULLIF(a.phone, ''), c.phone, ''), '\D', '', 'g'),
         COALESCE(a.name, c.name)
    INTO fone, nome
    FROM orders o
    LEFT JOIN customer_accounts a ON a.id = o.customer_account_id
    LEFT JOIN customers c ON c.id = o.customer_id
   WHERE o.id = NEW.id;

  IF fone IS NULL OR length(fone) < 10 THEN RETURN NEW; END IF;
  -- celular brasileiro sem o 55 na frente: põe o 55 (o cadastro guarda DDD + número)
  IF length(fone) IN (10, 11) THEN fone := '55' || fone; END IF;

  INSERT INTO whatsapp_sends (org_id, event_id, order_id, origin, to_phone, to_name)
  VALUES (NEW.org_id, NEW.event_id, NEW.id, 'automatico', fone, nome)
  ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$gatilho$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS pedido_pago_enfileira_whatsapp ON orders;
CREATE TRIGGER pedido_pago_enfileira_whatsapp
  AFTER INSERT OR UPDATE OF status ON orders
  FOR EACH ROW EXECUTE FUNCTION enfileirar_whatsapp_de_pedido();
