-- 028 — o site de quem compra (auditoria do público, 27/09)
--
-- Duas colunas em `orders` e um gatilho. Tudo aditivo e nulo por padrão: pedido
-- antigo continua exatamente como estava.
--
-- ## `invoice_url` (B08)
--
-- O link da fatura do cartão que o Asaas devolve ao criar a cobrança. Ficava só
-- na memória da aba que pagou: quem fechava a aba, ou abria o link do pedido no
-- celular, não achava como pagar — a página do pedido só sabia mostrar PIX — e
-- a reserva ficava presa até vencer. Guardado, a tela do pedido oferece a
-- fatura de qualquer aparelho.
--
-- ## `cadastro_pendente` (B14) e o gatilho que o aplica
--
-- O checkout gravava o cadastro ANTES do pagamento. Duas consequências:
--
--   1. quem soubesse o e-mail e o CPF de alguém reescrevia nome, telefone,
--      nascimento, Instagram, endereço e o CONSENTIMENTO de marketing dessa
--      pessoa sem pagar nada;
--   2. qualquer um criava o cliente de um e-mail alheio com consentimento
--      marcado — consentimento que o dono do e-mail nunca deu (LGPD).
--
-- Agora o que chega no formulário vai pro PEDIDO (`cadastro_pendente`) e só
-- passa pro cadastro quando o pedido vira 'pago'. O pagamento não prova que o
-- e-mail é de quem digitou, mas custa dinheiro no nome de alguém — é a mesma
-- régua que a auditoria pediu ("cadastro só consolidado após pagamento").
--
-- As regras do checkout continuam as mesmas, só mudam de hora:
--   · o que a pessoa não mandou NÃO apaga o que já tinha (COALESCE);
--   · o endereço é UM bloco: veio cidade, vem o endereço inteiro;
--   · o consentimento só muda quando a pessoa se manifestou, e o carimbo só
--     anda quando o valor MUDA;
--   · o documento nunca é reescrito aqui: se o cadastro já tem outro CPF, nada
--     é aplicado (o checkout já recusou esse caso; isto é a rede).
--
-- O gatilho NUNCA derruba o pagamento. Um cadastro pendente torto (que não
-- deveria existir — o checkout valida antes) vira AVISO no log e fica sem
-- aplicar; a transação que confirmou o dinheiro segue.
--
-- Nome do gatilho escolhido pela ordem: o Postgres dispara gatilhos do mesmo
-- evento em ordem alfabética, e `pedido_pago_aplica_cadastro` vem antes de
-- `pedido_pago_enfileira_email` (db/018) — o e-mail de confirmação sai com o
-- nome já atualizado.

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS invoice_url       text,
  ADD COLUMN IF NOT EXISTS cadastro_pendente jsonb;

CREATE OR REPLACE FUNCTION aplicar_cadastro_do_pedido_pago() RETURNS trigger AS $gatilho$
DECLARE
  p   jsonb := NEW.cadastro_pendente;
  e   jsonb;
  opt boolean;
BEGIN
  IF p IS NULL OR NEW.customer_id IS NULL OR NEW.status <> 'pago' OR OLD.status = 'pago' THEN
    RETURN NEW;
  END IF;

  BEGIN
    e := CASE WHEN jsonb_typeof(p -> 'endereco') = 'object'
                   AND NULLIF(p -> 'endereco' ->> 'cidade', '') IS NOT NULL
              THEN p -> 'endereco' END;
    opt := CASE WHEN jsonb_typeof(p -> 'aceitaNovidades') = 'boolean'
                THEN (p ->> 'aceitaNovidades')::boolean END;

    UPDATE customers c SET
      name           = COALESCE(NULLIF(p ->> 'nome', ''), c.name),
      phone          = COALESCE(NULLIF(p ->> 'telefone', ''), c.phone),
      birth_date     = COALESCE(NULLIF(p ->> 'nascimento', '')::date, c.birth_date),
      instagram      = COALESCE(NULLIF(p ->> 'instagram', ''), c.instagram),
      zip_code           = CASE WHEN e IS NOT NULL THEN NULLIF(e ->> 'cep', '')         ELSE c.zip_code END,
      street             = CASE WHEN e IS NOT NULL THEN NULLIF(e ->> 'rua', '')         ELSE c.street END,
      address_number     = CASE WHEN e IS NOT NULL THEN NULLIF(e ->> 'numero', '')      ELSE c.address_number END,
      neighborhood       = CASE WHEN e IS NOT NULL THEN NULLIF(e ->> 'bairro', '')      ELSE c.neighborhood END,
      address_complement = CASE WHEN e IS NOT NULL THEN NULLIF(e ->> 'complemento', '') ELSE c.address_complement END,
      state              = CASE WHEN e IS NOT NULL THEN NULLIF(e ->> 'estado', '')      ELSE c.state END,
      city               = CASE WHEN e IS NOT NULL THEN e ->> 'cidade'                  ELSE c.city END,
      registered_at  = COALESCE(c.registered_at,
                                CASE WHEN (p ->> 'cadastroDoSite') = 'true' THEN now() END),
      marketing_opt_in    = COALESCE(opt, c.marketing_opt_in),
      marketing_opt_in_at = CASE WHEN opt IS NOT NULL AND opt IS DISTINCT FROM c.marketing_opt_in
                                 THEN now() ELSE c.marketing_opt_in_at END
    WHERE c.id = NEW.customer_id
      AND (c.document IS NULL OR c.document = p ->> 'documento');
  EXCEPTION WHEN others THEN
    RAISE WARNING 'cadastro pendente do pedido % não foi aplicado: %', NEW.id, SQLERRM;
  END;

  -- aplicado (ou recusado pela rede do documento): o dado pessoal não fica
  -- duplicado no pedido
  UPDATE orders SET cadastro_pendente = NULL WHERE id = NEW.id;
  RETURN NEW;
END;
$gatilho$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS pedido_pago_aplica_cadastro ON orders;
CREATE TRIGGER pedido_pago_aplica_cadastro
  AFTER UPDATE OF status ON orders
  FOR EACH ROW EXECUTE FUNCTION aplicar_cadastro_do_pedido_pago();
