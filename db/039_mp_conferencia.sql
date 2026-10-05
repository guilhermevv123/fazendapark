-- 039 — conferência dos Pix do Mercado Pago JÁ PAGOS (auditoria de pagamento, 05/10/2026)
--
-- O aviso do MP é a única porta por onde chegava o que acontece DEPOIS do pago: estorno feito
-- direto no painel do MP, devolução por MED (contestação do Pix no Banco Central), chargeback.
-- A doc não garante entrega (só retentativa a cada 15 min); com o aviso perdido — URL fora, deploy
-- no meio, assinatura trocada —, o pedido seguia `pago` e o ingresso valia com o dinheiro de volta
-- no bolso do comprador. A varredura `conferirPixPagos` pergunta ao MP por esses pedidos, um pouco
-- por minuto; esta coluna diz quando cada um foi conferido pela última vez, pra a fila andar em
-- vez de perguntar sempre pelos mesmos.

ALTER TABLE orders ADD COLUMN IF NOT EXISTS mp_checked_at timestamptz;

CREATE INDEX IF NOT EXISTS orders_mp_conferir_idx
  ON orders (mp_checked_at NULLS FIRST)
  WHERE mp_payment_id IS NOT NULL AND status IN ('pago', 'estornado_parcial');

COMMENT ON COLUMN orders.mp_checked_at IS
  'Última vez que a varredura perguntou ao Mercado Pago por este Pix já pago (039). NULL = nunca.';
