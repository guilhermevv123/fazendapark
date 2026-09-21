-- ============================================================================
-- 020 · Evento cancelado e evento adiado — e o dinheiro voltando
--
-- Os status 'cancelado' e 'adiado' existem no CHECK de events desde a migração
-- 001 e nenhum fluxo usava nenhum dos dois. Chove forte no parque, o show não
-- acontece, e a plataforma não tinha o que fazer: o operador mudava o status
-- na mão, o ingresso continuava válido no leitor da portaria e o dinheiro
-- continuava parado. É por causa deste dia que o dinheiro fica retido até 2
-- dias depois do evento (ver utils/retencao.ts) — só que o "devolver" nunca
-- tinha sido escrito.
--
-- Três decisões que valem mais que o código:
--
-- 1. **O estorno é FILA, não laço dentro do handler.** Um evento de parque tem
--    milhares de pedidos pagos. Um laço que chama o gateway pedido a pedido
--    dentro da requisição estoura qualquer prazo de proxy, e o que acontece
--    quando ele morre no meio é pior que não ter começado: ninguém sabe onde
--    parou. Aqui o cancelamento grava a INTENÇÃO (uma linha por pedido, num
--    INSERT ... SELECT só) e devolve. Quem conversa com o banco do cliente é
--    o trabalhador de fundo, uma linha por vez, com nova tentativa e espera.
--
-- 2. **Estornar duas vezes o mesmo pedido não pode devolver em dobro.** São
--    três camadas, porque nenhuma sozinha basta:
--      • UNIQUE (order_id) nesta fila — o mesmo pedido não entra duas vezes,
--        nem quando o cancelamento é disparado duas vezes;
--      • a reserva atômica do trabalhador (UPDATE ... FOR UPDATE SKIP LOCKED
--        RETURNING) — dois trabalhadores não pegam a mesma linha;
--      • o UPDATE condicional em orders (WHERE status IN ('pago',
--        'estornado_parcial')) — o webhook do Asaas grava o MESMO estorno
--        quando ele volta como PAYMENT_REFUNDED, e sem a condição os dois
--        caminhos somariam em refunded_cents o mesmo dinheiro duas vezes.
--
-- 3. **O pedido só vira 'estornado' quando o dinheiro SAI.** Enquanto a linha
--    está na fila o pedido segue 'pago', porque é a verdade: o dinheiro ainda
--    está na plataforma. O ingresso, esse sim, morre na hora — quem não pode
--    entrar não pode entrar enquanto o estorno anda. Marcar o pedido como
--    estornado antes faria o líquido do produtor cair por um dinheiro que
--    ainda não voltou pra ninguém.
-- ============================================================================

-- ------------------------------------------------------------------- evento
-- O que aconteceu com ESTE evento, pra tela não precisar caçar na trilha.
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS canceled_at     timestamptz,
  ADD COLUMN IF NOT EXISTS cancel_reason   text,
  -- a data que o evento TINHA antes do adiamento. Guardada porque o comprador
  -- precisa ler "era dia 11, passou pra dia 25" — sem ela a página do evento
  -- mostra a data nova como se sempre tivesse sido aquela.
  ADD COLUMN IF NOT EXISTS postponed_from  timestamptz,
  -- até quando o comprador de um evento ADIADO pode escolher entre ficar com
  -- o ingresso na data nova e receber o dinheiro de volta. Passou o prazo sem
  -- escolher, fica com o ingresso — e é isso que a tela precisa dizer ANTES.
  ADD COLUMN IF NOT EXISTS choice_deadline timestamptz;

-- ---------------------------------------------------------------- o ato
-- Uma linha por ato de cancelar ou adiar. O status em events conta o que
-- sobrou; esta tabela conta o que aconteceu: quem, quando, por quê, quantos
-- pedidos foram varridos e quanto dinheiro isso significa.
--
-- Sem ela, "por que meu evento está cancelado" não tem resposta, e adiar duas
-- vezes apaga a data original do primeiro adiamento.
CREATE TABLE IF NOT EXISTS event_cancellations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  event_id    uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,

  kind        text NOT NULL CHECK (kind IN ('cancelado','adiado')),

  -- obrigatório: cancelamento sem motivo transforma auditoria em adivinhação,
  -- e aqui o motivo ainda vira texto que o comprador lê.
  reason      text NOT NULL CHECK (length(btrim(reason)) >= 3),

  -- de onde saiu e pra onde foi. No cancelamento só o "de onde".
  previous_status    text,
  previous_starts_at timestamptz,
  previous_ends_at   timestamptz,
  new_starts_at      timestamptz,
  new_ends_at        timestamptz,

  -- adiamento: prazo da escolha do comprador (cópia do que foi para events)
  choice_deadline    timestamptz,

  -- o tamanho do estrago, congelado no momento do ato: quantos pedidos vivos
  -- foram varridos, quanto dinheiro eles somam, quantos ingressos morreram.
  orders_swept    int    NOT NULL DEFAULT 0 CHECK (orders_swept >= 0),
  refund_cents    bigint NOT NULL DEFAULT 0 CHECK (refund_cents >= 0),
  tickets_killed  int    NOT NULL DEFAULT 0 CHECK (tickets_killed >= 0),

  at          timestamptz NOT NULL DEFAULT now(),
  by_user     uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS evento_cancelamento_idx
  ON event_cancellations (event_id, at DESC);

-- ------------------------------------------------------------ fila de estorno
-- Uma linha por PEDIDO a devolver. É a lista de quem tem dinheiro a receber —
-- e ela existe justamente pra sobreviver à queda no meio do caminho.
CREATE TABLE IF NOT EXISTS refund_jobs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  event_id      uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  order_id      uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  cancellation_id uuid REFERENCES event_cancellations(id) ON DELETE SET NULL,

  -- por que este dinheiro volta. Não é enfeite: 'arrependimento' é direito do
  -- consumidor com janela própria (CDC art. 49) e o relatório do Procon
  -- pergunta exatamente por esse recorte.
  reason        text NOT NULL CHECK (reason IN
                  ('evento_cancelado','evento_adiado','arrependimento')),

  -- quanto ainda falta devolver: total − o que já tinha voltado. Num pedido
  -- com estorno parcial de R$ 20, devolver o total de novo mandaria R$ 20 a
  -- mais do que entrou.
  amount_cents  bigint NOT NULL CHECK (amount_cents >= 0),

  -- a régua do "dá pra devolver por aqui" é esta coluna, e não o canal nem a
  -- forma de pagamento: venda em espécie no guichê nunca passou pela
  -- plataforma, e o dinheiro está na gaveta do produtor (ver utils/liquido.ts).
  asaas_payment_id text,

  -- 'na_mao' é o fim da linha das vendas sem cobrança na plataforma: não tem
  -- o que estornar por aqui, quem devolve é o produtor no balcão. Fica na
  -- lista com esse nome em vez de sumir — some, e o comprador é quem cobra.
  status        text NOT NULL DEFAULT 'na_fila' CHECK (status IN
                  ('na_fila','estornando','estornado','na_mao','falhou')),

  attempts      int  NOT NULL DEFAULT 0,
  max_attempts  int  NOT NULL DEFAULT 5 CHECK (max_attempts >= 1),
  last_error    text,

  -- espera do próximo ataque: gateway fora do ar volta pra fila com adiamento
  -- em vez de girar em brasa contra quem já não está respondendo.
  available_at  timestamptz NOT NULL DEFAULT now(),
  claimed_at    timestamptz,
  claimed_by    text,

  refunded_cents bigint NOT NULL DEFAULT 0 CHECK (refunded_cents >= 0),
  gateway_refund_id text,

  requested_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  done_at       timestamptz,

  -- A TRAVA. Um pedido tem no máximo um estorno em andamento, e cancelar o
  -- evento duas vezes (ou cancelar o evento depois de o comprador já ter
  -- desistido) não cria a segunda linha. Sem ela, o segundo disparo devolve
  -- o dinheiro de novo — e o dinheiro já saiu da conta da plataforma.
  CONSTRAINT estorno_unico_por_pedido UNIQUE (order_id)
);

-- Índice da fila: o trabalhador só enxerga o que está pronto pra sair.
CREATE INDEX IF NOT EXISTS estorno_fila_idx
  ON refund_jobs (available_at)
  WHERE status IN ('na_fila','estornando');
CREATE INDEX IF NOT EXISTS estorno_evento_idx
  ON refund_jobs (event_id, created_at DESC);

-- --------------------------------------------------- escolha do comprador
-- Evento adiado não vira estorno automático: quem comprou escolhe entre ficar
-- com o ingresso na data nova e receber o dinheiro de volta. Estornar todo
-- mundo de saída é devolver dinheiro pra quem ia no dia novo assim mesmo, e
-- não estornar ninguém é obrigar a pessoa a uma data que ela não comprou.
CREATE TABLE IF NOT EXISTS event_postpone_choices (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cancellation_id uuid NOT NULL REFERENCES event_cancellations(id) ON DELETE CASCADE,
  order_id        uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  choice          text NOT NULL CHECK (choice IN ('remarcar','reembolso')),
  at              timestamptz NOT NULL DEFAULT now(),
  by_user         uuid REFERENCES users(id) ON DELETE SET NULL,

  -- uma escolha por pedido POR ADIAMENTO: o evento pode ser adiado de novo, e
  -- aí a pessoa escolhe outra vez. Chavear só por pedido travaria a segunda
  -- escolha na primeira resposta.
  CONSTRAINT escolha_unica_por_adiamento UNIQUE (cancellation_id, order_id)
);
CREATE INDEX IF NOT EXISTS escolha_adiamento_idx
  ON event_postpone_choices (cancellation_id, choice);
