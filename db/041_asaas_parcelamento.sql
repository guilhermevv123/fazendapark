-- ============================================================================
-- 041 · Asaas: o PARCELAMENTO do cartão e a varredura das cobranças (05/10)
--
-- (Era pra ser a 040; a 040 foi ocupada por outra frente minutos antes. O
-- migrador anda pelo nome inteiro do arquivo, então o número só ordena.)
--
-- 1. `orders.asaas_installment_id` — o id do PARCELAMENTO no Asaas.
--
--    Compra no cartão em 3x vira, no Asaas, UM parcelamento (`ins_…`) com TRÊS
--    cobranças (`pay_…`), uma por parcela. O checkout guardava só o id da 1ª
--    parcela e jogava fora o `installment` que vem na resposta. Daí tudo que
--    age "no pedido" agia numa parcela só:
--      · estorno `POST /payments/{1ª}/refund` devolvia 1/3 do dinheiro e o
--        sistema dava o pedido por devolvido;
--      · cancelar `DELETE /payments/{1ª}` deixava as parcelas 2 e 3 vivas
--        (a doc: "excluir uma parcela não cancela o parcelamento");
--      · a conferência "o estorno já saiu?" olhava só a 1ª parcela.
--    Com o id do parcelamento: `POST /installments/{id}/refund` (sem valor =
--    tudo; com valor = parcial) e `DELETE /installments/{id}`. Pedido antigo
--    sem a coluna preenchida busca o `installment` em `GET /payments/{id}`
--    antes de agir (e grava aqui).
--
-- 2. `orders.asaas_checked_at` — a última vez que a varredura perguntou ao
--    Asaas por este pedido (rede de baixo do webhook, `varrerCobrancasDoAsaas`).
--    É o que espaça as perguntas: sem ela, um pedido expirado seria perguntado
--    a cada minuto por três dias, gastando a cota de 25.000 chamadas/12h.
-- ============================================================================

BEGIN;

ALTER TABLE orders ADD COLUMN IF NOT EXISTS asaas_installment_id text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS asaas_checked_at timestamptz;

-- o webhook da parcela 2 em diante pode chegar sem `externalReference` útil: o
-- pedido é achado pelo parcelamento
CREATE INDEX IF NOT EXISTS orders_asaas_installment_idx
  ON orders (asaas_installment_id) WHERE asaas_installment_id IS NOT NULL;

COMMIT;
