-- ============================================================================
-- 010 — webhook do Asaas: a idempotência vira RESTRIÇÃO DO BANCO.
--
-- O webhook é a única porta por onde a plataforma descobre que o dinheiro
-- entrou. O Asaas REENVIA a mesma entrega quando não recebe 200 — e reenvia
-- também depois de um 200 que demorou demais. Processar duas vezes o mesmo
-- PAYMENT_RECEIVED significa emitir o ingresso de novo (duas entradas válidas
-- pro mesmo pagamento) ou desfazer estoque duas vezes.
--
-- A trava NÃO pode ser um "if" no handler: entre o SELECT que procura o evento
-- e o INSERT que o grava cabe a segunda entrega inteira. Duas entregas
-- simultâneas passariam as duas pelo if. Quem serializa é o índice único:
-- as duas disputam a MESMA linha e só uma entra.
--
--   gateway_event_id = o id do EVENTO no gateway (payload->>'id', tipo
--   "evt_0a1b2c..."), que é diferente do id da COBRANÇA (payment.id, que se
--   repete de propósito: uma cobrança gera CONFIRMED, RECEIVED, REFUNDED...).
--   Guardar o id da cobrança como chave apagaria eventos legítimos.
--
-- Payload sem id de evento (entrega manual, gateway antigo) ganha uma chave
-- derivada do próprio corpo (sha256) — ver chaveDoEvento() em utils/asaas.ts.
-- Corpo byte a byte igual É a mesma entrega.
-- ============================================================================

ALTER TABLE payment_events
  ADD COLUMN IF NOT EXISTS gateway_event_id text,
  -- quantas vezes tentamos processar. Evento que voltou 3 vezes com erro é o
  -- que o operador precisa ver quando o cliente diz "paguei e não caiu".
  ADD COLUMN IF NOT EXISTS attempts int NOT NULL DEFAULT 0;

-- Linhas antigas (antes desta migração) nunca guardaram o id do evento. Cada
-- uma vira uma chave própria a partir do id da linha: assim elas convivem com
-- o índice único sem fingir que são duplicatas umas das outras.
UPDATE payment_events
   SET gateway_event_id = COALESCE(NULLIF(payload->>'id', ''), 'legado:' || id::text)
 WHERE gateway_event_id IS NULL;

ALTER TABLE payment_events ALTER COLUMN gateway_event_id SET NOT NULL;

-- ESTA é a idempotência. Sem este índice o handler não tem onde se apoiar
-- (o ON CONFLICT dele deixa de existir e a rota falha alto) — de propósito:
-- é melhor o webhook parar do que emitir ingresso repetido em silêncio.
CREATE UNIQUE INDEX IF NOT EXISTS payment_events_gateway_uk
  ON payment_events (provider, gateway_event_id);

COMMENT ON COLUMN payment_events.gateway_event_id IS
  'id do EVENTO no gateway (nao o da cobranca). Unico por provider: e a trava de idempotencia do webhook.';
COMMENT ON COLUMN payment_events.attempts IS
  'tentativas de processamento. processed_at NULL com attempts > 0 = falhou e esta na fila.';
