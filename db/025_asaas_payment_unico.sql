-- ============================================================================
-- 025 — uma cobrança do Asaas pertence a UM pedido.
--
-- `orders.asaas_payment_id` nasceu com índice comum (001) e nada impedia dois
-- pedidos de apontarem para a mesma cobrança. O estrago não é de tela:
--
--   1. **O dinheiro é contado duas vezes.** A cobrança entrou uma vez no
--      extrato; o nosso lado soma `total_cents` de cada pedido. Relatório,
--      borderô e teto do saque ficam maiores que o caixa de verdade — e o
--      saque tira a diferença do caixa da plataforma.
--
--   2. **O webhook escolhe no escuro.** `api/webhooks/asaas.post.ts` procura
--      o pedido com `WHERE asaas_payment_id = $1 FOR UPDATE` e pega
--      `rows[0]`: com dois donos, quem recebe o ingresso é quem o Postgres
--      devolver primeiro, que não é uma regra — é sorte.
--
--   3. **A reconciliação se contradiz.** O segundo pedido caía no ramo que
--      diz "a cobrança existe e NÃO tem dinheiro" e saía como GRAVE com a
--      frase impossível: o Asaas diz "RECEIVED" e a linha afirma que o
--      dinheiro não entrou.
--
-- O índice é PARCIAL (`WHERE asaas_payment_id IS NOT NULL`) porque venda em
-- dinheiro no guichê não tem cobrança nenhuma e são centenas de `NULL` — que
-- num índice único comum do Postgres nem colidiriam, mas ficariam ocupando
-- espaço à toa.
--
-- Conferido antes de criar: 409 pedidos com cobrança, 409 ids distintos.
-- Nenhuma duplicata para tratar. Se um dia esta migração falhar em outra
-- máquina, a duplicata NÃO se resolve apagando pedido — o de cima tem
-- ingresso emitido e comprador. Ache o dono real pelo `externalReference` da
-- cobrança no Asaas e corrija o id do outro pedido; enquanto isso a tela de
-- reconciliação nomeia o caso ("A mesma cobrança em mais de um pedido").
-- ============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS orders_asaas_payment_unico
  ON orders (asaas_payment_id)
  WHERE asaas_payment_id IS NOT NULL;

-- O índice comum de 001 cobria exatamente a mesma coluna com o mesmo recorte:
-- agora é peso morto em cada INSERT e UPDATE da maior tabela do sistema.
DROP INDEX IF EXISTS orders_asaas_payment_id_idx;

COMMENT ON INDEX orders_asaas_payment_unico IS
  'Uma cobranca do gateway pertence a um pedido so. Dois donos = dinheiro contado duas vezes no bordero e no teto do saque.';

-- ---------------------------------------------------------------------------
-- A memória da conferência precisa saber contar o caso novo.
--
-- `reconciliation_runs` guardava as três divergências com nome. A quarta — a
-- mesma cobrança em mais de um pedido — ficaria de fora da linha gravada, e o
-- cartão "última conferência: 0 divergência(s)" mentiria justamente no dia em
-- que a única divergência fosse essa.
-- ---------------------------------------------------------------------------
ALTER TABLE reconciliation_runs
  ADD COLUMN IF NOT EXISTS duplicate_charge int NOT NULL DEFAULT 0;

COMMENT ON COLUMN reconciliation_runs.duplicate_charge IS
  'Cobrancas do gateway reivindicadas por mais de um pedido nosso: o mesmo dinheiro somado duas vezes.';
