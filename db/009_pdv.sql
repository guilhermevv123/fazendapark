-- Bilheteria física: ponto de venda, turno de caixa e o dinheiro em espécie.
--
-- Até aqui todo dinheiro do sistema entrava pelo gateway — alguém pagava de
-- casa e o Asaas avisava. Na portaria não existe webhook: o dinheiro chega na
-- mão do operador, e o registro é a única prova de que chegou.
--
-- Isso muda o que precisa ser guardado. Online, a pergunta é "o pagamento
-- caiu?". No balcão, a pergunta é **"o que estava na gaveta bate com o que o
-- sistema diz que foi vendido?"** — e essa pergunta só tem resposta se o
-- sistema souber com quanto o turno abriu, o que saiu de sangria, o que
-- entrou de troco, e quanto o operador contou no fim.
--
-- Três entidades, cada uma resolvendo uma pergunta diferente:
--   pos_terminals      → ONDE se vende (Guichê 1, Portaria, maquininha da Ana)
--   pos_shifts         → QUEM estava no caixa, de quando a quando, com quanto
--   pos_cash_movements → o que entrou e saiu da gaveta fora das vendas

-- ------------------------------------------------------------------ ponto
CREATE TABLE IF NOT EXISTS pos_terminals (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  event_id    uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,

  name        text NOT NULL,
  -- onde fica de verdade: "Portão A", "Bilheteria da rua". Aparece no
  -- relatório e é o que o produtor usa pra achar o caixa que não fecha.
  location    text,

  kind        text NOT NULL DEFAULT 'bilheteria'
              CHECK (kind IN ('bilheteria','pdv_produtor','pdv_ticketeira')),

  -- formas que ESTE ponto aceita. Um guichê sem maquininha não deve nem
  -- mostrar "crédito" na tela — o operador escolhe errado com fila na frente.
  payment_methods text[] NOT NULL DEFAULT '{dinheiro,debito,credito,pix}',

  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,

  CONSTRAINT nome_do_ponto_unico UNIQUE (event_id, name)
);
CREATE INDEX IF NOT EXISTS pos_terminals_evento ON pos_terminals (event_id) WHERE active;

-- ------------------------------------------------------------------ turno
CREATE TABLE IF NOT EXISTS pos_shifts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  event_id    uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  terminal_id uuid NOT NULL REFERENCES pos_terminals(id) ON DELETE CASCADE,
  operator_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,

  status      text NOT NULL DEFAULT 'aberto' CHECK (status IN ('aberto','fechado')),

  -- fundo de troco: o dinheiro que já estava na gaveta antes de vender nada.
  -- Sem ele toda conferência acusa sobra.
  opening_float_cents bigint NOT NULL DEFAULT 0 CHECK (opening_float_cents >= 0),

  -- o que o operador CONTOU ao fechar. Fica separado do que o sistema
  -- calcula de propósito: a diferença entre os dois é a informação.
  closing_counted_cents bigint CHECK (closing_counted_cents >= 0),
  -- congelado no fechamento. Recalcular depois daria outro número quando um
  -- pedido antigo fosse estornado, e o relatório do dia mudaria sozinho.
  closing_expected_cents bigint,

  opened_at   timestamptz NOT NULL DEFAULT now(),
  closed_at   timestamptz,
  closed_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  note        text
);

-- Um caixa aberto por ponto. É o que impede dois operadores venderem na mesma
-- gaveta sem ninguém saber de quem é a diferença no fim da noite.
CREATE UNIQUE INDEX IF NOT EXISTS turno_aberto_unico
  ON pos_shifts (terminal_id) WHERE status = 'aberto';
CREATE INDEX IF NOT EXISTS pos_shifts_evento ON pos_shifts (event_id, opened_at DESC);

-- ------------------------------------------------------- gaveta (não-venda)
-- Sangria = dinheiro que SAI (o gerente recolhe pra não deixar 8 mil reais
-- num guichê). Suprimento = dinheiro que ENTRA (mais troco).
CREATE TABLE IF NOT EXISTS pos_cash_movements (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  shift_id    uuid NOT NULL REFERENCES pos_shifts(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('sangria','suprimento')),
  -- sempre POSITIVO; o sinal mora no `kind`. Guardar negativo em sangria
  -- garante que um dia alguém soma tudo e acha que o caixa está vazio.
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  reason      text,
  at          timestamptz NOT NULL DEFAULT now(),
  by_user     uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS pos_cash_shift ON pos_cash_movements (shift_id, at);

-- ------------------------------------------------------------ pedido no PDV
ALTER TABLE orders ADD COLUMN IF NOT EXISTS pos_terminal_id uuid
  REFERENCES pos_terminals(id) ON DELETE SET NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS pos_shift_id uuid
  REFERENCES pos_shifts(id) ON DELETE SET NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS sold_by uuid
  REFERENCES users(id) ON DELETE SET NULL;
-- dinheiro entregue e troco devolvido. Guardados porque é o que a pessoa do
-- outro lado do balcão confere em voz alta, e o que o operador precisa
-- mostrar quando o cliente diz que deu uma nota maior.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cash_received_cents bigint;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS change_cents bigint;

CREATE INDEX IF NOT EXISTS orders_turno ON orders (pos_shift_id) WHERE pos_shift_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS orders_ponto ON orders (pos_terminal_id, paid_at DESC)
  WHERE pos_terminal_id IS NOT NULL;
