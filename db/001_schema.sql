-- ============================================================================
-- diamond-tickets · esquema base
--
-- Regras que valem pro arquivo inteiro:
--   1. DINHEIRO É INTEIRO EM CENTAVOS. Nunca float, nunca numeric com casa
--      decimal solta. Toda coluna de valor termina em _cents e é BIGINT.
--   2. Toda tabela de negócio tem org_id — o isolamento é por organização e é
--      checado no servidor, não no front.
--   3. Estoque vive em lots.quantity/sold/reserved e SÓ muda dentro de
--      transação com lock de linha (ver server/utils/estoque.ts). Venda
--      duplicada é o bug mais caro de uma bilheteria.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------- organização
CREATE TABLE organizations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  slug          text NOT NULL UNIQUE,
  document      text,                       -- CNPJ/CPF do produtor
  asaas_api_key text,                       -- cifrada em repouso (ver recifra)
  asaas_env     text NOT NULL DEFAULT 'sandbox' CHECK (asaas_env IN ('sandbox','production')),
  asaas_wallet  text,                       -- carteira p/ split, se houver
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email         text NOT NULL,
  name          text NOT NULL,
  password_hash text NOT NULL,
  role          text NOT NULL DEFAULT 'operacional'
                CHECK (role IN ('master','admin','financeiro','marketing','operacional','portaria','leitura')),
  active        boolean NOT NULL DEFAULT true,
  last_login_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, email)
);

-- -------------------------------------------------------------------- evento
CREATE TABLE events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name            text NOT NULL,
  slug            text NOT NULL UNIQUE,
  description     text,
  status          text NOT NULL DEFAULT 'rascunho'
                  CHECK (status IN ('rascunho','ativo','encerrado','cancelado','adiado','oculto')),

  starts_at       timestamptz NOT NULL,
  ends_at         timestamptz NOT NULL,
  sales_end_at    timestamptz,              -- encerramento das vendas
  timezone        text NOT NULL DEFAULT 'America/Bahia',
  hide_end_date   boolean NOT NULL DEFAULT false,

  age_rating      int NOT NULL DEFAULT 0,   -- 0 = livre
  currency        text NOT NULL DEFAULT 'BRL',
  ticket_noun     text NOT NULL DEFAULT 'Ingressos',

  -- local
  is_online       boolean NOT NULL DEFAULT false,
  stream_url      text,
  venue_name      text,
  zip_code        text,
  address         text,
  address_number  text,
  neighborhood    text,
  city            text,
  state           text,
  complement      text,
  lat             double precision,
  lng             double precision,

  banner_url      text,
  thumb_url       text,
  category        text,
  subcategories   text[] NOT NULL DEFAULT '{}',
  tags            text[] NOT NULL DEFAULT '{}',

  support_kind    text CHECK (support_kind IN ('telefone','whatsapp','email')),
  support_value   text,

  -- ---- política de taxa -------------------------------------------------
  -- fee_percent é a taxa de conveniência em BASIS POINTS (1000 = 10,00%).
  -- Inteiro de propósito: 10% em float vira 0.1 e erra centavo no arredondar.
  fee_bps         int NOT NULL DEFAULT 1000 CHECK (fee_bps >= 0 AND fee_bps <= 5000),
  fee_mode_online text NOT NULL DEFAULT 'repassar' CHECK (fee_mode_online IN ('repassar','absorver')),
  fee_mode_pos    text NOT NULL DEFAULT 'absorver' CHECK (fee_mode_pos IN ('repassar','absorver')),

  group_by_sector boolean NOT NULL DEFAULT true,
  autofill_holder boolean NOT NULL DEFAULT true,
  max_per_customer int,                     -- teto geral do evento (NULL = sem teto)

  -- janela em que um pedido pendente segura estoque antes de devolver
  hold_minutes    int NOT NULL DEFAULT 20 CHECK (hold_minutes BETWEEN 5 AND 120),

  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON events (org_id, status);
CREATE INDEX ON events (starts_at);

-- sessão = uma data/horário vendável dentro do evento
CREATE TABLE event_sessions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  starts_at   timestamptz NOT NULL,
  ends_at     timestamptz NOT NULL,
  title       text,
  description text,
  banner_url  text,
  capacity    int,
  sort_order  int NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sessao_dura_15min CHECK (ends_at >= starts_at + interval '15 minutes')
);
CREATE INDEX ON event_sessions (event_id, starts_at);

-- ------------------------------------------------- setor → lote → tipo
-- kind separa ingresso avulso de passaporte/combo (o combo é um produto
-- paralelo com a mesma árvore, foi assim que a Zig resolveu e funciona bem).
CREATE TABLE sectors (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id           uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  session_id         uuid REFERENCES event_sessions(id) ON DELETE CASCADE,
  name               text NOT NULL,
  kind               text NOT NULL DEFAULT 'ingresso' CHECK (kind IN ('ingresso','passaporte')),
  category           text,
  max_per_customer   int,                   -- teto do setor; tipo pode sobrepor
  sort_order         int NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, session_id, name)
);
CREATE INDEX ON sectors (event_id, sort_order);

CREATE TABLE lots (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sector_id        uuid NOT NULL REFERENCES sectors(id) ON DELETE CASCADE,
  name             text NOT NULL,
  description      text,

  -- price_cents é o VALOR DE FACE (o que o produtor recebe antes de custo).
  -- O que o comprador paga sai de precificar() em server/utils/dinheiro.ts.
  price_cents      bigint NOT NULL CHECK (price_cents >= 0),

  quantity         int NOT NULL CHECK (quantity >= 0),
  sold             int NOT NULL DEFAULT 0 CHECK (sold >= 0),
  reserved         int NOT NULL DEFAULT 0 CHECK (reserved >= 0),

  expires_at       timestamptz,
  starts_at        timestamptz,             -- lote agendado
  min_per_order    int NOT NULL DEFAULT 1 CHECK (min_per_order >= 1),
  max_per_order    int NOT NULL DEFAULT 6 CHECK (max_per_order >= 1),
  limit_by_document boolean NOT NULL DEFAULT false,
  max_per_document int,

  channels         text[] NOT NULL DEFAULT '{online}',
  visible          boolean NOT NULL DEFAULT true,
  sort_order       int NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT nao_vender_mais_que_tem CHECK (sold + reserved <= quantity),
  CONSTRAINT min_menor_que_max       CHECK (min_per_order <= max_per_order),
  UNIQUE (sector_id, name)
);
CREATE INDEX ON lots (sector_id, sort_order);

-- tipo de ingresso = variação de preço dentro do lote (inteira, meia, promo).
-- discount_bps desconta sobre o price_cents do lote.
CREATE TABLE ticket_types (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lot_id           uuid NOT NULL REFERENCES lots(id) ON DELETE CASCADE,
  name             text NOT NULL,
  quantity         int NOT NULL CHECK (quantity >= 0),
  sold             int NOT NULL DEFAULT 0,
  discount_bps     int NOT NULL DEFAULT 0 CHECK (discount_bps BETWEEN 0 AND 10000),
  max_per_customer int,
  requires_document boolean NOT NULL DEFAULT false,  -- meia exige documento
  sort_order       int NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (lot_id, name)
);

-- ------------------------------------------------------------------ comprador
CREATE TABLE customers (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name       text NOT NULL,
  email      text NOT NULL,
  document   text,                          -- CPF só dígitos
  phone      text,
  asaas_customer_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, email)
);
CREATE INDEX ON customers (org_id, document);

-- --------------------------------------------------------------- promoção
CREATE TABLE promo_codes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id      uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  code          text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('percentual','fixo')),
  value         bigint NOT NULL CHECK (value > 0),  -- bps se percentual, centavos se fixo
  max_uses      int,
  uses          int NOT NULL DEFAULT 0,
  max_per_customer int NOT NULL DEFAULT 1,
  starts_at     timestamptz,
  ends_at       timestamptz,
  active        boolean NOT NULL DEFAULT true,
  lot_ids       uuid[] NOT NULL DEFAULT '{}',       -- vazio = vale pro evento todo
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, code)
);

CREATE TABLE promoters (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id          uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name              text NOT NULL,
  email             text,
  phone             text,
  code              text NOT NULL,                  -- entra na URL: ?p=<code>
  commission_bps    int NOT NULL DEFAULT 0 CHECK (commission_bps BETWEEN 0 AND 10000),
  active            boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, code)
);

-- ------------------------------------------------------------------- pedido
-- status segue a realidade de gateway, não o otimismo:
--   rascunho → aguardando_pagamento → pago → (estornado|estornado_parcial)
--                                  ↘ expirado | cancelado | falhou | chargeback
CREATE TABLE orders (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  event_id        uuid NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
  customer_id     uuid REFERENCES customers(id) ON DELETE SET NULL,
  code            text NOT NULL UNIQUE,            -- localizador legível

  status          text NOT NULL DEFAULT 'rascunho' CHECK (status IN (
                    'rascunho','aguardando_pagamento','em_analise','pago',
                    'expirado','cancelado','falhou',
                    'estornado','estornado_parcial','chargeback','disputa')),
  channel         text NOT NULL DEFAULT 'online'
                  CHECK (channel IN ('online','bilheteria','pdv_produtor','pdv_ticketeira','cortesia')),

  -- Decomposição do dinheiro. Três números diferentes que sempre confundem:
  --   face_cents     = soma do valor de face dos ingressos
  --   fee_cents      = taxa COBRADA DO COMPRADOR (zero quando absorvida)
  --   platform_cents = receita da plataforma (existe nos dois modos)
  --   total_cents    = o que o comprador paga  = face + fee − desconto
  -- Líquido do produtor = face − (absorvida ? platform_cents : 0).
  face_cents      bigint NOT NULL DEFAULT 0,
  fee_cents       bigint NOT NULL DEFAULT 0,
  platform_cents  bigint NOT NULL DEFAULT 0,
  discount_cents  bigint NOT NULL DEFAULT 0,
  total_cents     bigint NOT NULL DEFAULT 0,

  payment_method  text CHECK (payment_method IN ('pix','credito','debito','dinheiro','cortesia')),
  installments    int NOT NULL DEFAULT 1 CHECK (installments >= 1),

  promo_code_id   uuid REFERENCES promo_codes(id) ON DELETE SET NULL,
  promoter_id     uuid REFERENCES promoters(id) ON DELETE SET NULL,

  asaas_payment_id text,
  pix_payload     text,
  pix_qr_base64   text,

  -- as duas datas que todo relatório precisa distinguir. A régua do relatório
  -- é escolhida explicitamente na consulta; nunca implícita (foi a confusão
  -- que a Zig precisou de uma tela inteira pra explicar).
  created_at      timestamptz NOT NULL DEFAULT now(),
  paid_at         timestamptz,
  expires_at      timestamptz,
  canceled_at     timestamptz,
  refunded_at     timestamptz,
  refunded_cents  bigint NOT NULL DEFAULT 0,

  CONSTRAINT total_fecha CHECK (total_cents = face_cents + fee_cents - discount_cents)
);
CREATE INDEX ON orders (event_id, status);
CREATE INDEX ON orders (org_id, created_at DESC);
CREATE INDEX ON orders (org_id, paid_at DESC) WHERE paid_at IS NOT NULL;
CREATE INDEX ON orders (asaas_payment_id) WHERE asaas_payment_id IS NOT NULL;
CREATE INDEX ON orders (status, expires_at) WHERE status = 'aguardando_pagamento';

CREATE TABLE order_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id        uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  lot_id          uuid NOT NULL REFERENCES lots(id) ON DELETE RESTRICT,
  ticket_type_id  uuid REFERENCES ticket_types(id) ON DELETE RESTRICT,
  quantity        int NOT NULL CHECK (quantity > 0),
  -- congelados no momento da compra: preço de lote muda, pedido antigo não.
  unit_face_cents bigint NOT NULL,
  unit_fee_cents  bigint NOT NULL,
  unit_total_cents bigint NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON order_items (order_id);

-- ---------------------------------------------------------------- ingresso
CREATE TABLE tickets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  event_id        uuid NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
  session_id      uuid REFERENCES event_sessions(id) ON DELETE SET NULL,
  order_id        uuid REFERENCES orders(id) ON DELETE SET NULL,
  order_item_id   uuid REFERENCES order_items(id) ON DELETE SET NULL,
  sector_id       uuid NOT NULL REFERENCES sectors(id) ON DELETE RESTRICT,
  lot_id          uuid NOT NULL REFERENCES lots(id) ON DELETE RESTRICT,
  ticket_type_id  uuid REFERENCES ticket_types(id) ON DELETE RESTRICT,

  code            text NOT NULL UNIQUE,            -- legível, vai no ingresso
  qr_secret       text NOT NULL,                   -- assinado; não é o code

  status          text NOT NULL DEFAULT 'valido'
                  CHECK (status IN ('valido','usado','cancelado','transferido')),
  is_courtesy     boolean NOT NULL DEFAULT false,

  holder_name     text,
  holder_document text,
  holder_email    text,

  issued_at       timestamptz NOT NULL DEFAULT now(),
  checked_in_at   timestamptz,
  checked_in_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  canceled_at     timestamptz
);
CREATE INDEX ON tickets (event_id, status);
CREATE INDEX ON tickets (order_id);
CREATE INDEX ON tickets (event_id, holder_document);

-- toda leitura de portaria vira linha, inclusive a recusada. Sem isso não se
-- audita fila, catraca nem ingresso repetido.
CREATE TABLE checkins (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  ticket_id   uuid REFERENCES tickets(id) ON DELETE SET NULL,
  code_lido   text NOT NULL,
  resultado   text NOT NULL CHECK (resultado IN (
                'ok','ja_usado','invalido','cancelado','fora_da_sessao','evento_errado')),
  gate        text,
  operator_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON checkins (event_id, created_at DESC);
CREATE INDEX ON checkins (ticket_id);

-- --------------------------------------------------- trilha de pagamento
-- todo webhook vira linha ANTES de virar efeito. Se o efeito falhar, o
-- evento continua aqui pra reprocessar.
CREATE TABLE payment_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider      text NOT NULL DEFAULT 'asaas',
  external_id   text,
  event_name    text NOT NULL,
  order_id      uuid REFERENCES orders(id) ON DELETE SET NULL,
  payload       jsonb NOT NULL,
  processed_at  timestamptz,
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON payment_events (external_id);
CREATE INDEX ON payment_events (processed_at) WHERE processed_at IS NULL;

-- log de tudo que muda dado sensível de venda
CREATE TABLE audit_log (
  id          bigserial PRIMARY KEY,
  org_id      uuid,
  user_id     uuid,
  entity      text NOT NULL,
  entity_id   text,
  action      text NOT NULL,
  before      jsonb,
  after       jsonb,
  ip          text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON audit_log (org_id, created_at DESC);
CREATE INDEX ON audit_log (entity, entity_id);
