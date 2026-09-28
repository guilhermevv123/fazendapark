-- 033 — Pix pelo Mercado Pago (28/09).
--
-- O cartão (crédito e débito) continua no Asaas. O Pix passa a ser gerado no Mercado Pago quando a
-- organização tem o token dele salvo em Dados e cobrança; sem token, nada muda e o Pix segue no
-- Asaas. Tudo aqui é ADITIVO: coluna nova nula, índice parcial, nenhum dado reescrito.
--
-- ## Por que uma coluna própria e não `asaas_payment_id`
--
-- `asaas_payment_id IS NOT NULL` é a régua de "o dinheiro está na conta do Asaas" (utils/liquido.ts):
-- é o teto do saque, a população da conciliação e a fila de cancelar cobrança vencida. O Pix do
-- Mercado Pago cai na conta do MP. Se o id dele morasse naquela coluna, o saque pelo Asaas contaria
-- dinheiro que não está lá e a conciliação acusaria "cobrança sumida" em todo Pix. Com a coluna
-- separada, todo caminho do Asaas continua enxergando só o que é dele, sem um `AND NOT LIKE 'mp%'`
-- esquecido em algum canto.
BEGIN;

ALTER TABLE organizations
  -- as duas credenciais entram pelo cofre (utils/cofre.ts), como a chave do Asaas
  ADD COLUMN IF NOT EXISTS mp_access_token   text,
  ADD COLUMN IF NOT EXISTS mp_webhook_secret text,
  -- quem é a conta no MP (GET /users/me na hora de salvar) e se é conta de TESTE: token de teste
  -- em produção não gera Pix de verdade, e aí o Pix volta pro Asaas sozinho
  ADD COLUMN IF NOT EXISTS mp_user_id        text,
  ADD COLUMN IF NOT EXISTS mp_test           boolean NOT NULL DEFAULT false;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS mp_payment_id     text,
  -- o que o gateway cobrou e o que sobrou, na palavra DELE (MP: fee_details / net_received_amount,
  -- só existem com o pagamento aprovado). Informativo: o líquido do produtor segue sendo
  -- `total − platform − refunded` (utils/liquido.ts).
  ADD COLUMN IF NOT EXISTS gateway_fee_cents integer,
  ADD COLUMN IF NOT EXISTS gateway_net_cents integer;

-- um pagamento do MP é de UM pedido só — a mesma lição da 025 pro Asaas
CREATE UNIQUE INDEX IF NOT EXISTS orders_mp_payment_id_unico
  ON orders (mp_payment_id)
  WHERE mp_payment_id IS NOT NULL;

-- um pedido tem UM gateway: os dois ids juntos seriam duas cobranças vivas pro mesmo ingresso
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_um_gateway_so') THEN
    ALTER TABLE orders ADD CONSTRAINT orders_um_gateway_so
      CHECK (asaas_payment_id IS NULL OR mp_payment_id IS NULL);
  END IF;
END $$;

COMMENT ON COLUMN orders.mp_payment_id IS
  'id do pagamento Pix no Mercado Pago. Nulo = não passou pelo MP. Nunca junto de asaas_payment_id.';

COMMIT;
