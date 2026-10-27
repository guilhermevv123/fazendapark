-- 054 — mudar a data no painel com ingresso vendido avisa quem comprou (dono, 27/10/2026)
--
-- A 9ª edição foi publicada com a data errada (29/10 em vez de 30/10) e a tela
-- travava "Começa em" / "Termina em" assim que entrava a primeira venda. Agora
-- a data muda por ali mesmo, e cada comprador recebe a data nova por WhatsApp e
-- e-mail — pelas MESMAS filas do ingresso, pra não se perder num reinício.
--
-- O aviso é montado na hora em que a data muda (o texto fala de "de X para Y",
-- e isso é daquele instante) e vai gravado na linha; o trabalhador só entrega.

-- e-mail: um tipo novo na fila (o CHECK da 018 só conhecia a confirmação)
ALTER TABLE email_sends DROP CONSTRAINT IF EXISTS email_sends_kind_check;
ALTER TABLE email_sends
  ADD CONSTRAINT email_sends_kind_check CHECK (kind IN ('confirmacao_pedido', 'aviso_nova_data'));

-- WhatsApp: a fila da 038 não tinha tipo — toda linha era o ingresso
ALTER TABLE whatsapp_sends
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'ingresso';
ALTER TABLE whatsapp_sends DROP CONSTRAINT IF EXISTS whatsapp_sends_kind_check;
ALTER TABLE whatsapp_sends
  ADD CONSTRAINT whatsapp_sends_kind_check CHECK (kind IN ('ingresso', 'aviso_nova_data'));

COMMENT ON COLUMN whatsapp_sends.kind IS
  'ingresso = o link do QR (montado na hora do envio); aviso_nova_data = texto pronto em body_text, gravado quando a data do evento mudou.';
