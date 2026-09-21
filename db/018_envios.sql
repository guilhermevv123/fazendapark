-- ============================================================================
-- 018 · Entrega do ingresso — fila de e-mail
--
-- O comprador pagava e não recebia nada. Não era falta de recurso: era o
-- produto não funcionando. Quem compra online espera o ingresso na caixa de
-- entrada em segundos, e quando não chega o telefone da bilheteria toca.
--
-- Três decisões que valem mais que o código:
--
-- 1. **O envio é uma LINHA, não uma chamada dentro do webhook.** Gateway e
--    servidor de SMTP são lentos e caem; um `await` de 30 s dentro do handler
--    do Asaas faz o webhook estourar o prazo, o Asaas reentregar e a
--    confirmação do pagamento virar trabalho repetido. Aqui o pagamento só
--    grava a intenção e devolve 200; quem entrega é o trabalhador de fundo.
--
-- 2. **Quem enfileira é o BANCO, não o handler.** O gatilho abaixo mora na
--    mesma transação que marca o pedido como pago — se o pedido virou venda,
--    o envio existe; não tem caminho de código que "esqueça de chamar". E
--    vale pros quatro jeitos de pagar que o sistema tem hoje (webhook do
--    Asaas, gateway simulado, PDV e bilheteria), sem depender de cada um
--    lembrar da linha.
--
-- 3. **Uma confirmação automática por pedido, garantida por índice.** O Asaas
--    manda PAYMENT_CONFIRMED e depois PAYMENT_RECEIVED pra mesma cobrança, e
--    repete quando não recebe 200. Sem o índice único parcial, cada
--    reentrega vira um e-mail a mais na caixa de quem comprou. O reenvio
--    pedido pelo balcão é outra origem, de propósito: esse PODE repetir.
-- ============================================================================

CREATE TABLE IF NOT EXISTS email_sends (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  event_id      uuid REFERENCES events(id) ON DELETE CASCADE,
  order_id      uuid REFERENCES orders(id) ON DELETE CASCADE,

  -- Que e-mail é este. Acrescentar um tipo é migração, de propósito: tipo
  -- novo precisa de um montador correspondente em server/utils/email.ts.
  kind          text NOT NULL CHECK (kind IN ('confirmacao_pedido')),

  -- 'automatico' = nasceu do pagamento (no máximo um por pedido).
  -- 'reenvio'    = alguém no balcão apertou "mandar de novo" (pode repetir).
  origin        text NOT NULL DEFAULT 'automatico'
                CHECK (origin IN ('automatico','reenvio')),

  to_email      text NOT NULL,
  to_name       text,

  -- O e-mail montado fica gravado. Sem isso, "não chegou" não tem resposta:
  -- ninguém consegue dizer o que foi mandado, pra onde, nem quando. O corpo
  -- é montado na hora do envio (não aqui), porque o ingresso só existe depois
  -- que a emissão termina.
  subject       text,
  body_text     text,
  body_html     text,
  message_id    text,

  status        text NOT NULL DEFAULT 'na_fila'
                CHECK (status IN ('na_fila','enviando','enviado','falhou')),

  attempts      int  NOT NULL DEFAULT 0,
  max_attempts  int  NOT NULL DEFAULT 5 CHECK (max_attempts >= 1),
  last_error    text,

  -- 'simulado' enquanto não existe credencial de SMTP no ambiente; 'smtp'
  -- quando existe. É o que separa "mandei" de "fiz de conta que mandei" na
  -- hora de responder ao cliente.
  sent_via      text,
  file_path     text,                    -- .eml gravado em disco no modo simulado

  -- Espera do próximo ataque: falha de rede volta pra fila com adiamento em
  -- vez de girar em brasa contra um servidor que está fora.
  available_at  timestamptz NOT NULL DEFAULT now(),
  claimed_at    timestamptz,
  claimed_by    text,

  requested_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  sent_at       timestamptz
);

-- A trava que impede webhook repetido de virar e-mail repetido. Parcial de
-- propósito: só pega a confirmação automática, nunca o reenvio pedido.
CREATE UNIQUE INDEX IF NOT EXISTS envio_confirmacao_automatica_unica
  ON email_sends (order_id)
  WHERE kind = 'confirmacao_pedido' AND origin = 'automatico';

-- Índice da fila: o trabalhador só enxerga o que está pronto pra sair.
CREATE INDEX IF NOT EXISTS envio_fila_idx
  ON email_sends (available_at)
  WHERE status IN ('na_fila','enviando');

CREATE INDEX IF NOT EXISTS envio_pedido_idx ON email_sends (order_id, created_at DESC);
CREATE INDEX IF NOT EXISTS envio_evento_idx ON email_sends (event_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Uma linha por TENTATIVA. A contagem em email_sends.attempts responde
-- "quantas vezes", esta tabela responde "o que aconteceu em cada uma" — que é
-- a pergunta de quem atende o cliente dizendo que não chegou. Erro guardado
-- só na última tentativa apaga justamente o primeiro, que costuma ser o que
-- explica o resto (caixa cheia, domínio que não existe, recusa do servidor).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_send_attempts (
  id          bigserial PRIMARY KEY,
  send_id     uuid NOT NULL REFERENCES email_sends(id) ON DELETE CASCADE,
  attempt     int  NOT NULL,
  worker      text,
  transport   text,
  ok          boolean NOT NULL,
  error       text,
  ms          int,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS envio_tentativa_idx ON email_send_attempts (send_id, attempt);

-- ---------------------------------------------------------------------------
-- O gatilho. Pedido que vira 'pago' enfileira a confirmação.
--
-- Roda em AFTER INSERT OR UPDATE OF status porque o dinheiro entra por
-- caminhos diferentes: online o pedido nasce pendente e é atualizado pelo
-- webhook; cortesia e algumas vendas de balcão já nascem pagas.
--
-- Sai calado quando não há pra quem mandar (cortesia sem cadastro, venda de
-- guichê em que ninguém deu e-mail). Enfileirar um envio sem destinatário só
-- produziria uma falha garantida na fila e um alarme falso na operação.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION enfileirar_confirmacao_de_pedido() RETURNS trigger AS $gatilho$
DECLARE
  destino text;
  nome    text;
BEGIN
  IF NEW.status <> 'pago' THEN
    RETURN NEW;
  END IF;
  -- UPDATE que mexe no status sem sair de 'pago' (reprocessamento, correção
  -- manual) não é pagamento novo e não manda e-mail de novo.
  IF TG_OP = 'UPDATE' AND OLD.status = 'pago' THEN
    RETURN NEW;
  END IF;

  -- Pagamento ANTIGO entrando agora não é pagamento: é carga de histórico —
  -- `npm run seed`, importação da planilha da Zig, correção em massa. Webhook
  -- de verdade sempre chega com paid_at de agora. Sem esta linha, o dia em
  -- que alguém importar a base inteira o sistema dispara um e-mail de
  -- "ingressos confirmados" pra cada compra dos últimos dois anos.
  IF NEW.paid_at IS NOT NULL AND NEW.paid_at < now() - interval '1 day' THEN
    RETURN NEW;
  END IF;

  SELECT c.email, c.name INTO destino, nome
    FROM customers c WHERE c.id = NEW.customer_id;

  IF destino IS NULL OR position('@' in destino) = 0 THEN
    RETURN NEW;
  END IF;

  INSERT INTO email_sends (org_id, event_id, order_id, kind, origin, to_email, to_name)
  VALUES (NEW.org_id, NEW.event_id, NEW.id, 'confirmacao_pedido', 'automatico',
          destino, nome)
  ON CONFLICT DO NOTHING;   -- reentrega do gateway não vira segundo e-mail

  RETURN NEW;
END;
$gatilho$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS pedido_pago_enfileira_email ON orders;
CREATE TRIGGER pedido_pago_enfileira_email
  AFTER INSERT OR UPDATE OF status ON orders
  FOR EACH ROW EXECUTE FUNCTION enfileirar_confirmacao_de_pedido();
