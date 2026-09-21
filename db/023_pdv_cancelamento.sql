-- Cancelamento de venda de balcão — o desfazer que faltava no guichê.
--
-- Até aqui o balcão só sabia vender. Operador digitou 3 em vez de 2, cliente
-- desistiu com a nota ainda na mão, passou no cartão errado: não existia
-- desfazer. Na prática o conserto virava papel — o operador devolvia o
-- dinheiro, rabiscava num caderno, e o caixa fechava com uma falta que
-- ninguém sabia explicar de manhã.
--
-- O cancelamento tem QUATRO efeitos que precisam acontecer juntos, e é por
-- isso que ele vira linha aqui em vez de virar só um UPDATE em orders:
--   1. o ingresso morre (senão a pessoa entra com um ingresso devolvido);
--   2. o estoque volta pra prateleira (senão o lote "esgota" sem ter vendido);
--   3. o dinheiro sai da conferência do turno (senão a sobra/falta mente);
--   4. o estorno é pedido ao gateway quando a venda passou por ele.
--
-- O RASTRO é o motivo desta tabela existir. O pedido cancelado sozinho conta
-- o que sobrou, não o que aconteceu: quem cancelou, por quê, quanto voltou
-- pra mão do cliente, e se o estorno no cartão saiu ou não. Sem isso o gerente
-- lê "venda sumiu" e a conversa vira acusação.

CREATE TABLE IF NOT EXISTS pos_sale_cancellations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  event_id    uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  order_id    uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,

  -- turno em que o dinheiro voltou. É o MESMO turno da venda de propósito:
  -- cancelar numa gaveta e tirar o dinheiro de outra é a diferença fantasma
  -- do fim da noite. A rota recusa cancelamento de venda em turno fechado.
  shift_id    uuid NOT NULL REFERENCES pos_shifts(id) ON DELETE CASCADE,

  -- quanto voltou pra mão do cliente (o total do pedido; o balcão não faz
  -- cancelamento parcial — meia venda desfeita é conversa de gerente).
  amount_cents bigint NOT NULL CHECK (amount_cents >= 0),
  payment_method text,

  -- true = saiu NOTA da gaveta. É o único caso em que o operador tem que
  -- contar dinheiro de volta; cartão e pix voltam pelo gateway, não pela mão.
  from_drawer boolean NOT NULL DEFAULT false,

  tickets_canceled int NOT NULL DEFAULT 0 CHECK (tickets_canceled >= 0),

  -- por que foi cancelada. Obrigatório: cancelamento sem motivo é o que
  -- transforma auditoria em adivinhação.
  reason      text NOT NULL CHECK (length(btrim(reason)) >= 3),

  -- o que aconteceu com o dinheiro do lado do gateway. 'falhou' não desfaz o
  -- cancelamento: o ingresso já morreu e a pessoa não pode entrar; o que
  -- falta é o financeiro reenviar o estorno — e é por isso que fica gravado
  -- em vez de virar exceção que ninguém lê.
  --
  -- 'pendente' é o estado real entre o commit do cancelamento e a resposta do
  -- Asaas: a chamada ao gateway acontece FORA da transação (rede de terceiro
  -- dentro de transação segura lock pelo tempo do timeout dele). Se o processo
  -- morrer no meio, a linha fica 'pendente' — que é a verdade, e dá pra achar.
  gateway_refund text NOT NULL DEFAULT 'nao_aplica'
                 CHECK (gateway_refund IN ('nao_aplica','pendente','solicitado','falhou','simulado')),
  gateway_error  text,

  at          timestamptz NOT NULL DEFAULT now(),
  by_user     uuid REFERENCES users(id) ON DELETE SET NULL,

  -- A rede do "não cancela duas vezes". A trava de verdade é o UPDATE
  -- condicional em SQL_CANCELA_VENDA_PDV (server/utils/caixa.ts); esta
  -- UNIQUE é o que recusa no banco se um caminho novo esquecer a trava —
  -- mesmo papel do índice de turno aberto único.
  CONSTRAINT cancelamento_unico_por_pedido UNIQUE (order_id)
);

CREATE INDEX IF NOT EXISTS pos_cancelamentos_turno
  ON pos_sale_cancellations (shift_id, at DESC);
CREATE INDEX IF NOT EXISTS pos_cancelamentos_evento
  ON pos_sale_cancellations (event_id, at DESC);
