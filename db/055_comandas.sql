-- 055 — Comandas: consumo com pulseira NFC, pago no fim do dia (dono, 11/11/2026)
--
-- Substitui a Zig no bar. Modelo PÓS-PAGO: a pulseira é só uma chave (o número que o
-- leitor digita); ela não guarda saldo nem pedido. Tudo mora aqui:
--
--   pulseira ──(vínculo)── comanda ──── lançamentos (pedido) ──── itens
--                              └─────── pagamentos
--
-- Quando a conta é paga, o vínculo pulseira↔comanda termina e a pulseira volta a ficar
-- LIVRE: a próxima leitura não mostra nada do cliente anterior. A comanda paga continua
-- inteira no histórico, com data e hora de cada coisa.
--
-- ISOLAMENTO: só tabelas NOVAS, todas `comanda_*`. Nenhuma tabela existente é alterada;
-- as referências a ingresso, pedido, cliente e equipe são `ON DELETE SET NULL` e a comanda
-- guarda uma CÓPIA do nome/telefone de quem responde por ela (o cadastro pode mudar depois;
-- a cobrança não pode perder o contato). A chave `comanda_config.ativo` nasce DESLIGADA.
--
-- Dinheiro em centavos inteiros (bigint), como no resto do sistema. Nada é apagado: item
-- errado vira `cancelado` com quem/quando/motivo, e cada ato entra em `comanda_historico`.
--
-- Idempotente (IF NOT EXISTS): o deploy roda as migrações em todo boot.

-- ------------------------------------------------------------------ configuração
CREATE TABLE IF NOT EXISTS comanda_config (
  org_id                    uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  -- a chave geral: desligada, nada da comanda responde (só o master configura)
  ativo                     boolean NOT NULL DEFAULT false,
  -- limite de consumo de cada conta nova; passar dele pede o PIN do gerente
  limite_padrao_cents       bigint  NOT NULL DEFAULT 0 CHECK (limite_padrao_cents >= 0),
  -- atendente pode fechar conta no tablet (maquininha na mesa)? começa NÃO: só o caixa
  atendente_fecha_conta     boolean NOT NULL DEFAULT true,
  -- quantos minutos o atendente tem pra desfazer o próprio pedido sem chamar o gerente
  minutos_para_desfazer     integer NOT NULL DEFAULT 5 CHECK (minutos_para_desfazer BETWEEN 0 AND 60),
  -- conta acima disto pede uma conferência a mais antes de fechar
  aviso_conta_alta_cents    bigint  NOT NULL DEFAULT 50000 CHECK (aviso_conta_alta_cents >= 0),
  -- conta aberta à mão exige o código de 4 números enviado ao WhatsApp
  exige_codigo_whatsapp     boolean NOT NULL DEFAULT true,
  -- a hora em que o parque fecha (horário da Bahia). Depois dela, o resumo do dia conta
  -- quem ainda tem conta aberta como "saiu sem pagar"; quem pagar depois sai da lista sozinho.
  hora_fechamento           text    NOT NULL DEFAULT '18:00' CHECK (hora_fechamento ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  atualizado_em             timestamptz NOT NULL DEFAULT now(),
  atualizado_por            uuid REFERENCES users(id) ON DELETE SET NULL
);

-- ------------------------------------------------------------------ quem usa o quê
-- Nível na comanda, separado do papel do painel (que não muda): o atendente do bar entra
-- com um acesso de PORTARIA no painel — a porta mais estreita que existe — e ganha aqui o
-- nível dele. O master da organização é gerente sem precisar de linha.
CREATE TABLE IF NOT EXISTS comanda_acessos (
  user_id     uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  nivel       text NOT NULL CHECK (nivel IN ('atendente', 'caixa', 'gerente')),
  -- PIN de 4 a 6 números (bcrypt) que o gerente digita no tablet pra liberar correção/limite
  pin_hash    text,
  criado_em   timestamptz NOT NULL DEFAULT now(),
  criado_por  uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS comanda_acessos_org ON comanda_acessos (org_id);

-- pontos de venda (Bar da Piscina, Lanchonete...): o tablet diz de onde lançou
CREATE TABLE IF NOT EXISTS comanda_pontos (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  nome       text NOT NULL CHECK (length(trim(nome)) BETWEEN 1 AND 60),
  ativo      boolean NOT NULL DEFAULT true,
  ordem      integer NOT NULL DEFAULT 0,
  -- as categorias do cardápio que ESTE local vende (o tablet dele só mostra essas).
  -- NULL = vende tudo.
  categorias uuid[],
  criado_em  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, nome)
);

-- ------------------------------------------------------------------ cardápio
CREATE TABLE IF NOT EXISTS comanda_categorias (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  nome       text NOT NULL CHECK (length(trim(nome)) BETWEEN 1 AND 40),
  -- emoji que aparece no tablet (🍺, 🍟…); vazio = o tablet escolhe pelo nome
  icone      text CHECK (length(icone) <= 16),
  ordem      integer NOT NULL DEFAULT 0,
  ativo      boolean NOT NULL DEFAULT true,
  criado_em  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, nome)
);

CREATE TABLE IF NOT EXISTS comanda_itens (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  categoria_id  uuid NOT NULL REFERENCES comanda_categorias(id) ON DELETE RESTRICT,
  nome          text NOT NULL CHECK (length(trim(nome)) BETWEEN 1 AND 60),
  preco_cents   bigint NOT NULL CHECK (preco_cents >= 0),
  -- emoji do produto no tablet (🍟, 🥪, 💧…); vazio = o tablet escolhe pelo nome
  icone         text CHECK (length(icone) <= 16),
  -- bebida alcoólica: a pulseira marcada como de menor não consegue lançar
  maior_18      boolean NOT NULL DEFAULT false,
  -- esgotado some do tablet na hora, sem apagar o item
  esgotado      boolean NOT NULL DEFAULT false,
  ativo         boolean NOT NULL DEFAULT true,
  ordem         integer NOT NULL DEFAULT 0,
  criado_em     timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS comanda_itens_org ON comanda_itens (org_id, categoria_id, ordem);

-- ------------------------------------------------------------------ pulseiras
-- `uid` é o que o leitor digita (ex.: 0110264695). TEXTO, nunca número: o zero da frente
-- faz parte dele.
CREATE TABLE IF NOT EXISTS comanda_pulseiras (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  uid          text NOT NULL CHECK (uid ~ '^[0-9A-Za-z]{4,24}$'),
  -- número pintado/gravado na pulseira, pra achar uma perdida no balcão (opcional)
  rotulo       text,
  -- livre / em_uso derivam do vínculo; bloqueada e descartada são decisões de gente
  bloqueada    boolean NOT NULL DEFAULT false,
  descartada   boolean NOT NULL DEFAULT false,
  motivo       text,
  criado_em    timestamptz NOT NULL DEFAULT now(),
  criado_por   uuid REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (org_id, uid)
);

-- ------------------------------------------------------------------ comanda (a conta)
CREATE SEQUENCE IF NOT EXISTS comanda_numero_seq;

CREATE TABLE IF NOT EXISTS comandas (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- número curto pra falar no balcão ("conta 1043")
  numero           bigint NOT NULL DEFAULT nextval('comanda_numero_seq') UNIQUE,
  situacao         text NOT NULL DEFAULT 'aberta' CHECK (situacao IN (
                     'aberta',       -- consumindo
                     'paga',         -- fechada no caixa (ou no tablet, se liberado)
                     'nao_paga',     -- o dia encerrou e o gerente confirmou: saiu sem pagar
                     'cobrada',      -- a cobrança foi mandada pro responsável
                     'paga_depois',  -- pagou depois da cobrança
                     'perdoada',     -- o gerente decidiu não cobrar (com motivo)
                     'juntada')),    -- tudo passou pra outra conta (`juntada_em`)

  -- quem USA a pulseira (pode ser "Acompanhante 2 de João")
  nome             text NOT NULL CHECK (length(trim(nome)) BETWEEN 1 AND 120),
  -- quem RESPONDE pela conta: o comprador do ingresso, ou a própria pessoa confirmada
  -- pelo código do WhatsApp. Cópia do contato no momento da abertura.
  responsavel_nome      text NOT NULL,
  responsavel_telefone  text,
  responsavel_email     text,
  responsavel_documento text,
  -- de onde veio a confirmação do contato
  -- atendimento = aberta no tablet, na hora do primeiro pedido, só com o nome (contato não confirmado)
  origem           text NOT NULL CHECK (origem IN ('ingresso', 'whatsapp', 'gerente', 'atendimento')),
  dados_confirmados boolean NOT NULL DEFAULT false,

  -- ligação com a bilheteria (só leitura dela; nada lá é alterado)
  ticket_id        uuid REFERENCES tickets(id)   ON DELETE SET NULL,
  order_id         uuid REFERENCES orders(id)    ON DELETE SET NULL,
  customer_id      uuid REFERENCES customers(id) ON DELETE SET NULL,

  limite_cents     bigint NOT NULL CHECK (limite_cents >= 0),
  -- pulseira de criança: itens +18 recusados
  menor_de_idade   boolean NOT NULL DEFAULT false,
  observacao       text,

  aberta_em        timestamptz NOT NULL DEFAULT now(),
  aberta_por       uuid REFERENCES users(id) ON DELETE SET NULL,
  aberta_no_ponto  uuid REFERENCES comanda_pontos(id) ON DELETE SET NULL,

  fechada_em       timestamptz,
  fechada_por      uuid REFERENCES users(id) ON DELETE SET NULL,
  -- desconto na conta inteira (o de item fica no item)
  desconto_cents   bigint NOT NULL DEFAULT 0 CHECK (desconto_cents >= 0),
  desconto_motivo  text,
  juntada_em       uuid REFERENCES comandas(id) ON DELETE SET NULL,

  encerrada_em     timestamptz,   -- quando virou nao_paga / perdoada / paga_depois
  encerrada_por    uuid REFERENCES users(id) ON DELETE SET NULL,
  encerrada_motivo text,
  cobrada_em       timestamptz,
  cobrada_por      uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS comandas_org_situacao ON comandas (org_id, situacao, aberta_em DESC);
CREATE INDEX IF NOT EXISTS comandas_order ON comandas (order_id);
CREATE INDEX IF NOT EXISTS comandas_ticket ON comandas (ticket_id);

-- Pulseira ↔ comanda. Uma pulseira tem no MÁXIMO um vínculo ativo (índice único parcial):
-- é a trava que impede a mesma pulseira estar em duas contas. Uma comanda pode ter mais de
-- uma pulseira ao longo do dia (a perdida e a nova), e o histórico fica.
CREATE TABLE IF NOT EXISTS comanda_vinculos (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  comanda_id   uuid NOT NULL REFERENCES comandas(id) ON DELETE CASCADE,
  pulseira_id  uuid NOT NULL REFERENCES comanda_pulseiras(id) ON DELETE RESTRICT,
  inicio_em    timestamptz NOT NULL DEFAULT now(),
  inicio_por   uuid REFERENCES users(id) ON DELETE SET NULL,
  fim_em       timestamptz,
  fim_por      uuid REFERENCES users(id) ON DELETE SET NULL,
  fim_motivo   text CHECK (fim_motivo IN ('paga', 'perdida', 'trocada', 'encerrada', 'juntada'))
);
CREATE UNIQUE INDEX IF NOT EXISTS comanda_vinculo_ativo_pulseira
  ON comanda_vinculos (pulseira_id) WHERE fim_em IS NULL;
CREATE INDEX IF NOT EXISTS comanda_vinculos_comanda ON comanda_vinculos (comanda_id);

-- ------------------------------------------------------------------ pedidos
-- Um lançamento = um pedido feito no tablet (vários itens de uma vez). `id_local` nasce NO
-- TABLET: é o que deixa o pedido feito sem internet subir depois UMA vez só, por mais que
-- a conexão caia e o tablet reenvie.
CREATE TABLE IF NOT EXISTS comanda_lancamentos (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  comanda_id    uuid NOT NULL REFERENCES comandas(id) ON DELETE CASCADE,
  id_local      text NOT NULL UNIQUE CHECK (length(id_local) BETWEEN 8 AND 80),
  pulseira_uid  text,
  ponto_id      uuid REFERENCES comanda_pontos(id) ON DELETE SET NULL,
  atendente_id  uuid REFERENCES users(id) ON DELETE SET NULL,
  aparelho      text,
  mesa          text,
  -- o nome que o atendente digitou ao lançar ("João", "Ana da mesa 5") — pedido do dono, 11/11
  cliente_nome  text,
  observacao    text,
  -- hora em que o atendente confirmou (relógio do tablet) e hora em que chegou aqui
  feito_em      timestamptz NOT NULL,
  recebido_em   timestamptz NOT NULL DEFAULT now(),
  feito_sem_internet boolean NOT NULL DEFAULT false,
  -- chegou (de um tablet sem internet) depois de a conta já estar fechada: vai pra lista
  -- de pendências do gerente, nunca some
  chegou_depois_de_fechada boolean NOT NULL DEFAULT false,
  pendencia_resolvida_em  timestamptz,
  pendencia_resolvida_por uuid REFERENCES users(id) ON DELETE SET NULL,
  -- liberação do limite pelo gerente, quando houve
  limite_liberado_por uuid REFERENCES users(id) ON DELETE SET NULL,
  -- situação do PREPARO na tela do bar
  preparo       text NOT NULL DEFAULT 'novo' CHECK (preparo IN ('novo', 'pronto', 'entregue')),
  preparo_em    timestamptz
);
CREATE INDEX IF NOT EXISTS comanda_lancamentos_comanda ON comanda_lancamentos (comanda_id, feito_em);
CREATE INDEX IF NOT EXISTS comanda_lancamentos_org_dia ON comanda_lancamentos (org_id, feito_em DESC);

CREATE TABLE IF NOT EXISTS comanda_lancamento_itens (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  lancamento_id   uuid NOT NULL REFERENCES comanda_lancamentos(id) ON DELETE CASCADE,
  -- a conta em que o item ESTÁ (mover item pra outra conta muda isto e grava o histórico)
  comanda_id      uuid NOT NULL REFERENCES comandas(id) ON DELETE CASCADE,
  item_id         uuid REFERENCES comanda_itens(id) ON DELETE SET NULL,
  -- cópia do nome e do preço na hora do pedido: mudar o cardápio não muda conta antiga
  nome            text NOT NULL,
  preco_cents     bigint NOT NULL CHECK (preco_cents >= 0),
  quantidade      integer NOT NULL CHECK (quantidade BETWEEN 1 AND 999),
  desconto_cents  bigint NOT NULL DEFAULT 0 CHECK (desconto_cents >= 0),
  desconto_motivo text,
  cancelado       boolean NOT NULL DEFAULT false,
  cancelado_em    timestamptz,
  cancelado_por   uuid REFERENCES users(id) ON DELETE SET NULL,
  cancelado_motivo text,
  -- correção: o item novo aponta pro que ele substituiu (o velho fica cancelado)
  substitui_id    uuid REFERENCES comanda_lancamento_itens(id) ON DELETE SET NULL,
  CHECK (desconto_cents <= preco_cents * quantidade)
);
CREATE INDEX IF NOT EXISTS comanda_lancamento_itens_comanda ON comanda_lancamento_itens (comanda_id);
CREATE INDEX IF NOT EXISTS comanda_lancamento_itens_lanc ON comanda_lancamento_itens (lancamento_id);

-- ------------------------------------------------------------------ pagamento
-- O dinheiro passa na maquininha do parque; aqui fica só COMO foi pago, pra fechar o caixa.
CREATE TABLE IF NOT EXISTS comanda_pagamentos (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  comanda_id     uuid NOT NULL REFERENCES comandas(id) ON DELETE CASCADE,
  forma          text NOT NULL CHECK (forma IN ('dinheiro', 'pix', 'debito', 'credito')),
  valor_cents    bigint NOT NULL CHECK (valor_cents > 0),
  -- só no dinheiro: quanto o cliente entregou (o troco é a diferença)
  recebido_cents bigint CHECK (recebido_cents IS NULL OR recebido_cents >= valor_cents),
  feito_em       timestamptz NOT NULL DEFAULT now(),
  feito_por      uuid REFERENCES users(id) ON DELETE SET NULL,
  aparelho       text,
  -- pagamento lançado errado: anulado (com motivo), nunca apagado
  anulado        boolean NOT NULL DEFAULT false,
  anulado_em     timestamptz,
  anulado_por    uuid REFERENCES users(id) ON DELETE SET NULL,
  anulado_motivo text
);
CREATE INDEX IF NOT EXISTS comanda_pagamentos_comanda ON comanda_pagamentos (comanda_id);
CREATE INDEX IF NOT EXISTS comanda_pagamentos_org_dia ON comanda_pagamentos (org_id, feito_em DESC);

-- ------------------------------------------------------------------ fechamento do caixa
-- Fechamento às cegas: quem fecha digita quanto CONTOU na gaveta sem ver o esperado.
CREATE TABLE IF NOT EXISTS comanda_fechamentos (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id         uuid REFERENCES users(id) ON DELETE SET NULL,
  -- o período que este fechamento cobre (pagamentos registrados por esta pessoa)
  desde           timestamptz NOT NULL,
  ate             timestamptz NOT NULL DEFAULT now(),
  contado_cents   bigint NOT NULL CHECK (contado_cents >= 0),
  esperado_cents  bigint NOT NULL,
  pix_cents       bigint NOT NULL DEFAULT 0,
  debito_cents    bigint NOT NULL DEFAULT 0,
  credito_cents   bigint NOT NULL DEFAULT 0,
  observacao      text,
  criado_em       timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------------ verificação do contato
-- Código de 4 números mandado ao WhatsApp na abertura manual. Guardado em hash; vale 10 min.
CREATE TABLE IF NOT EXISTS comanda_codigos (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  telefone     text NOT NULL,
  codigo_hash  text NOT NULL,
  tentativas   integer NOT NULL DEFAULT 0,
  usado_em     timestamptz,
  expira_em    timestamptz NOT NULL,
  criado_em    timestamptz NOT NULL DEFAULT now(),
  criado_por   uuid REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS comanda_codigos_tel ON comanda_codigos (org_id, telefone, criado_em DESC);

-- ------------------------------------------------------------------ linha do tempo
-- Tudo que acontece numa conta (e fora dela: cardápio, pulseira, configuração), com quem,
-- quando e o antes/depois. Só cresce.
CREATE TABLE IF NOT EXISTS comanda_historico (
  id          bigserial PRIMARY KEY,
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  comanda_id  uuid REFERENCES comandas(id) ON DELETE CASCADE,
  quando      timestamptz NOT NULL DEFAULT now(),
  quem        uuid REFERENCES users(id) ON DELETE SET NULL,
  quem_nome   text,
  aparelho    text,
  acao        text NOT NULL,
  descricao   text NOT NULL,
  detalhes    jsonb
);
CREATE INDEX IF NOT EXISTS comanda_historico_comanda ON comanda_historico (comanda_id, quando);
CREATE INDEX IF NOT EXISTS comanda_historico_org ON comanda_historico (org_id, quando DESC);

/* ------------------------------------------------------------------ link do funcionário
 * Cada funcionário que atende no tablet recebe um link só dele. O link NÃO é usuário do
 * sistema: abre só Atender, Pagar e as contas de hoje, com o nível atendente. O gerente
 * desliga quando quiser. Guardamos só o hash do segredo do link. */
CREATE TABLE IF NOT EXISTS comanda_links (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  nome           text NOT NULL CHECK (length(nome) BETWEEN 2 AND 60),
  token_hash     text NOT NULL UNIQUE,
  criado_por     uuid NOT NULL REFERENCES users(id),
  criado_em      timestamptz NOT NULL DEFAULT now(),
  desativado_em  timestamptz,
  desativado_por uuid REFERENCES users(id),
  ultimo_uso_em  timestamptz
);
CREATE INDEX IF NOT EXISTS comanda_links_org ON comanda_links (org_id, criado_em DESC);
ALTER TABLE comanda_lancamentos ADD COLUMN IF NOT EXISTS link_id uuid REFERENCES comanda_links(id);
ALTER TABLE comanda_pagamentos  ADD COLUMN IF NOT EXISTS link_id uuid REFERENCES comanda_links(id);
-- o link sozinho não abre: o funcionário digita o PIN dele (4 dígitos). 5 erros travam 15 min.
ALTER TABLE comanda_links ADD COLUMN IF NOT EXISTS pin_hash text;
ALTER TABLE comanda_links ADD COLUMN IF NOT EXISTS erros_pin int NOT NULL DEFAULT 0;
ALTER TABLE comanda_links ADD COLUMN IF NOT EXISTS travado_ate timestamptz;
-- 20 erros no total desligam o link de vez
ALTER TABLE comanda_links ADD COLUMN IF NOT EXISTS erros_total int NOT NULL DEFAULT 0;
