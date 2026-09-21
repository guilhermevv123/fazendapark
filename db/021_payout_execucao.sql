-- 021 — o que a EXECUÇÃO da fila de saque precisa gravar.
--
-- A rota POST /api/admin/evento/:id/financeiro grava o pedido de transferência
-- com status 'solicitada' e para ali, de propósito (o gateway não pode ficar
-- pendurado no clique do operador). Quem move o dinheiro é o executor
-- (POST /api/admin/payout/executar), e ele precisa de quatro colunas que a
-- tabela não tinha — todas sobre o MESMO risco: transferir duas vezes.
--
-- 1. idempotency_key — a chave que vai ao gateway como "externalReference".
--    É o que permite perguntar ao Asaas "esta transferência já existe?" ANTES
--    de criar outra. Sem ela, um timeout na resposta (transferência feita,
--    resposta perdida) vira uma segunda transferência na retentativa: o
--    produtor recebe duas vezes e o dinheiro sai da plataforma, que é o pior
--    defeito possível neste caminho. UNICA porque duas linhas com a mesma
--    chave seriam um payout pago e outro dado como pago sem nunca ter sido.
--    Gravada no momento da reivindicação e NUNCA reescrita (ver o COALESCE em
--    SQL_REIVINDICAR_PAYOUT): chave que muda entre tentativas não é chave de
--    idempotência, é um pagamento novo a cada retentativa.
--
-- 2. attempts — quantas vezes o executor já tentou. Chave PIX errada é
--    recusada pelo gateway para sempre; sem contador, a fila tenta de novo a
--    cada execução, sem fim, e enterra as transferências boas no relatório.
--    Depois do teto a linha vira 'falhou' com o erro escrito — nunca some.
--
-- 3. claimed_at — quando a linha foi PEGA pela execução. É o que separa
--    "transferência em voo no banco" de "o executor morreu no meio": a segunda
--    é reconciliável depois de um tempo de carência, a primeira não pode ser
--    tocada.
--
-- 4. gateway_status — o status cru do Asaas (PENDING, BANK_PROCESSING, DONE,
--    FAILED, CANCELLED). O nosso `status` é a tradução; quando os dois
--    discordam, quem atende a ligação do produtor precisa ver o que o banco
--    respondeu, e não só a nossa interpretação dele.

ALTER TABLE payouts
  ADD COLUMN IF NOT EXISTS idempotency_key text,
  ADD COLUMN IF NOT EXISTS attempts        int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS claimed_at      timestamptz,
  ADD COLUMN IF NOT EXISTS gateway_status  text;

ALTER TABLE payouts DROP CONSTRAINT IF EXISTS attempts_nao_negativo;
ALTER TABLE payouts ADD CONSTRAINT attempts_nao_negativo CHECK (attempts >= 0);

-- Parcial porque linha antiga (e linha ainda não executada) tem a chave nula, e
-- NULL não colide com NULL em índice único — mas duas linhas com a MESMA chave
-- preenchida seriam dinheiro pago uma vez e baixado duas.
CREATE UNIQUE INDEX IF NOT EXISTS payouts_idempotency_key_uidx
  ON payouts (idempotency_key) WHERE idempotency_key IS NOT NULL;

-- A fila é lida por organização, na ordem do pedido. Sem isto a varredura passa
-- na tabela inteira a cada execução.
CREATE INDEX IF NOT EXISTS payouts_fila_idx
  ON payouts (org_id, requested_at)
  WHERE status IN ('solicitada', 'processando');

COMMENT ON COLUMN payouts.idempotency_key IS
  'Chave mandada ao gateway como externalReference. Fixada na reivindicação e nunca reescrita: é ela que impede a retentativa de virar uma segunda transferência.';
COMMENT ON COLUMN payouts.attempts IS
  'Quantas execuções já pegaram esta linha. Passou do teto, vira falhou com o erro escrito.';
COMMENT ON COLUMN payouts.claimed_at IS
  'Quando a execução pegou a linha. Linha processando com claimed_at velho e sem asaas_transfer_id é execução interrompida — reconciliável pela chave.';
COMMENT ON COLUMN payouts.gateway_status IS
  'Status cru do Asaas: PENDING, BANK_PROCESSING, DONE, FAILED, CANCELLED.';
