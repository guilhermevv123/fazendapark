-- ============================================================================
-- 022 — reconciliação: o registro de cada vez que alguém bateu o extrato.
--
-- Hoje ninguém consegue responder "o que a plataforma diz que recebeu bate
-- com o extrato do Asaas?". Um webhook perdido vira dinheiro que existe no
-- banco do Asaas e não existe no nosso — ou o contrário — e a descoberta
-- acontece pelo pior caminho possível: o produtor ligando.
--
-- A conferência em si é leitura pura (nossos pedidos de um lado, o extrato do
-- gateway do outro). O que ela NÃO tem sozinha, e que esta tabela dá, é
-- MEMÓRIA:
--
--   1. **"Quando foi a última vez que isso bateu?"** Sem linha gravada, a
--      resposta é sempre "não sei". Uma tela de conferência que não guarda o
--      resultado obriga a refazer a conferência pra saber se já foi feita —
--      e, na prática, ninguém refaz.
--
--   2. **Divergência que aparece e some.** O webhook atrasado de 40 minutos
--      produz divergência às 21h e nenhuma às 22h. Sem histórico, os dois
--      instantes são indistinguíveis de "nunca houve problema" — e o padrão
--      (todo sábado de pico o gateway atrasa) fica invisível.
--
--   3. **Quem conferiu.** É dinheiro: a conferência é um ato, e ato de
--      dinheiro tem autor. Mesmo motivo do `actor_email` da migração 019 — o
--      e-mail vai CARIMBADO na linha, sem FOREIGN KEY: quem sai da empresa
--      some de `users`, e a linha tem que continuar dizendo quem era.
--
-- A tabela é só registro: nada no caminho do dinheiro lê ela pra decidir
-- coisa nenhuma. Por isso não tem restrição que possa derrubar a conferência
-- — uma conferência que falha porque o log dela falhou é o pior dos dois
-- mundos.
-- ============================================================================

CREATE TABLE IF NOT EXISTS reconciliation_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- conferência de um evento só; nulo quando foi a organização inteira
  event_id      uuid REFERENCES events(id) ON DELETE SET NULL,

  -- O período conferido, em DIA DE CALENDÁRIO (date, não timestamptz): é o
  -- que o operador escolheu na tela. Guardar o instante UTC faria "01/09 a
  -- 30/09" voltar como "31/08 21:00 a 30/09 21:00" na releitura — o mesmo
  -- deslize de um dia que o `toISOString()` produz no resto do sistema.
  period_start  date NOT NULL,
  period_end    date NOT NULL,

  -- de onde veio o extrato: 'asaas' (credencial de verdade), 'simulado'
  -- (sem credencial: o que o gateway simulado sabe) ou 'indisponivel'
  -- (nem credencial nem simulador — a conferência não aconteceu).
  source        text NOT NULL,
  -- 'production' | 'sandbox' | NULL. Conferir contra o sandbox e achar tudo
  -- divergente é o erro de leitura mais fácil de cometer aqui.
  environment   text,

  ran_by        uuid,   -- users.id, sem FK: ver a nota do actor_email acima
  ran_by_email  text,

  -- os dois lados, em centavos inteiros
  orders_count  int    NOT NULL DEFAULT 0,
  orders_cents  bigint NOT NULL DEFAULT 0,
  gateway_count int    NOT NULL DEFAULT 0,
  gateway_cents bigint NOT NULL DEFAULT 0,

  -- as três divergências com nome, contadas
  webhook_missing int NOT NULL DEFAULT 0,  -- pago lá, não pago aqui
  charge_missing  int NOT NULL DEFAULT 0,  -- pago aqui, sem pagamento lá
  amount_mismatch int NOT NULL DEFAULT 0,  -- valor diferente
  -- pedidos que a conferência NÃO conseguiu conferir (extrato parcial,
  -- período truncado, gateway fora). Contar separado é o que impede a tela
  -- de dizer "está tudo certo" quando o certo é "não olhei".
  unchecked       int NOT NULL DEFAULT 0,

  error       text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Período invertido não é conferência: é filtro digitado errado que devolve
-- zero divergência e passa por "tudo certo".
ALTER TABLE reconciliation_runs DROP CONSTRAINT IF EXISTS reconciliation_periodo_valido;
ALTER TABLE reconciliation_runs ADD CONSTRAINT reconciliation_periodo_valido
  CHECK (period_end >= period_start);

ALTER TABLE reconciliation_runs DROP CONSTRAINT IF EXISTS reconciliation_fonte_valida;
ALTER TABLE reconciliation_runs ADD CONSTRAINT reconciliation_fonte_valida
  CHECK (source IN ('asaas', 'simulado', 'indisponivel'));

-- A tela lê "a última conferência desta organização" a cada abertura.
CREATE INDEX IF NOT EXISTS reconciliation_runs_org_idx
  ON reconciliation_runs (org_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- O lado NOSSO da conferência é sempre o mesmo recorte: pedidos de uma
-- organização, COM cobrança no gateway, num intervalo de datas. Sem este
-- índice a varredura passa na tabela inteira de pedidos a cada abertura da
-- tela — e ela é a maior tabela do sistema.
--
-- `COALESCE(paid_at, created_at)` porque o pedido que NÃO foi pago não tem
-- `paid_at`, e é justamente ele que aparece como "o Asaas recebeu e aqui não
-- consta". Filtrar só por `paid_at` esconderia a divergência que a tela
-- existe pra achar.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS orders_reconciliacao_idx
  ON orders (org_id, (COALESCE(paid_at, created_at)))
  WHERE asaas_payment_id IS NOT NULL;

COMMENT ON TABLE reconciliation_runs IS
  'Uma linha por conferencia de extrato. E memoria, nao fonte de verdade: nada no caminho do dinheiro le esta tabela.';
COMMENT ON COLUMN reconciliation_runs.source IS
  'asaas = extrato de verdade; simulado = so o que o gateway simulado conhece; indisponivel = nao deu pra conferir.';
COMMENT ON COLUMN reconciliation_runs.unchecked IS
  'Pedidos que a conferencia nao conseguiu conferir. Sem este numero a tela diz "tudo certo" quando o certo e "nao olhei".';
COMMENT ON COLUMN reconciliation_runs.ran_by_email IS
  'E-mail carimbado no momento do ato: quem sai da empresa some de users, a linha continua dizendo quem era.';
