-- 016 — catálogo de sessões: o mesmo ingresso em vários dias, com teto por dia.
--
-- Um parque aquático não vende "um show". Vende sábado, domingo e o feriado
-- que vem — o MESMO ingresso, em dias diferentes, e cada dia comporta um
-- número de gente que a piscina aguenta.
--
-- O schema até aqui só sabia amarrar um SETOR a uma sessão
-- (sectors.session_id), então "entrada individual" de sábado e de domingo
-- viram dois setores clonados, cada um com estoque próprio — é exatamente o
-- que está no banco hoje (ENTRADA INDIVIDUAL SÁBADO + ENTRADA INDIVIDUAL
-- DOMINGO, 5.000 cada). Dois dias viram dois clones; um ano de fins de semana
-- vira 104, e mudar o preço passa a ser 104 edições.
--
-- Três peças entram aqui:
--
--   1. lot_sessions — o lote passa a valer em VÁRIAS sessões. É a peça que
--      mata o clone: um lote "Entrada individual", válido em todos os sábados.
--
--   2. order_items.session_id — o dia que o comprador escolheu fica gravado no
--      item. Sem ele, "quantas pessoas vêm no sábado" não tem resposta, e o
--      ingresso do dia 11 entra no dia 12 sem ninguém perceber.
--
--   3. a trava de capacidade. `event_sessions.capacity` existe desde o 001 e
--      NUNCA foi lida por ninguém. Capacidade que não é conferida é decoração:
--      o parque lota, e quem descobre é a fila no portão.
--
-- ## Por que a ocupação é SOMADA na hora, e não guardada num contador
--
-- `lots.sold/reserved` são contadores, e contador desencaixa: todo caminho
-- novo que esquece de somar (ou de subtrair no estorno) mente em silêncio, e
-- o erro só aparece quando falta ingresso na portaria. A ocupação do dia aqui
-- é somada dos pedidos vivos toda vez que alguém pergunta. Pedido que expira,
-- que é cancelado ou estornado sai da conta sozinho — ninguém precisa lembrar
-- de decrementar nada, porque não há nada pra decrementar.
--
-- ## Por que a trava mora no banco, e não numa função TypeScript
--
-- Dois compradores na última vaga é o caso NORMAL de uma virada de lote. Quem
-- confere a vaga tem que segurar a linha da sessão ANTES de contar, e isso
-- precisa valer pra todo caminho que grava venda: checkout, balcão, cortesia,
-- importação de planilha e o script de correção que alguém roda às 23h com o
-- parque cheio. Uma função em TypeScript protege só quem lembra de chamá-la;
-- o gatilho protege inclusive quem não sabe que ele existe.

-- ---------------------------------------------------------------- 1. sessão
-- Data não nasce duas vezes. Além de ser verdade de negócio (não existem duas
-- aberturas do parque no mesmo instante), é o que deixa a criação em lote ser
-- reexecutada sem medo: rodar de novo o mesmo intervalo não duplica nada.
ALTER TABLE event_sessions DROP CONSTRAINT IF EXISTS sessao_unica_por_inicio;
ALTER TABLE event_sessions
  ADD CONSTRAINT sessao_unica_por_inicio UNIQUE (event_id, starts_at);

ALTER TABLE event_sessions DROP CONSTRAINT IF EXISTS sessao_capacidade_positiva;
ALTER TABLE event_sessions
  ADD CONSTRAINT sessao_capacidade_positiva CHECK (capacity IS NULL OR capacity > 0);

COMMENT ON COLUMN event_sessions.capacity IS
  'Quantas PESSOAS cabem neste dia/horário. NULL = sem teto. Conferida pelo gatilho sessao_confere_vaga em toda venda.';

-- ------------------------------------------------------------ 2. lote × dia
-- A tabela que mata o clone. Lote sem linha aqui continua se comportando como
-- antes (dia do setor, ou nenhum): a migração não muda venda nenhuma que já
-- existe.
CREATE TABLE IF NOT EXISTS lot_sessions (
  lot_id     uuid NOT NULL REFERENCES lots(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES event_sessions(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (lot_id, session_id)
);
CREATE INDEX IF NOT EXISTS lot_sessions_session_idx ON lot_sessions (session_id);

COMMENT ON TABLE lot_sessions IS
  'Em quais sessões este lote é vendido. Vazio = o lote segue o dia do setor (modelo antigo) ou não tem dia.';

-- Ligar um lote a uma sessão de OUTRO evento cruzaria o estoque de dois
-- produtores. O id vem do corpo do pedido, que é o que o cliente controla —
-- então a conferência não pode morar só na rota.
CREATE OR REPLACE FUNCTION lote_sessao_mesmo_evento() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM lots l
      JOIN sectors s        ON s.id = l.sector_id
      JOIN event_sessions e ON e.id = NEW.session_id
     WHERE l.id = NEW.lot_id AND e.event_id = s.event_id
  ) THEN
    RAISE EXCEPTION 'Este lote e esta sessão são de eventos diferentes.'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS lote_sessao_mesmo_evento ON lot_sessions;
CREATE TRIGGER lote_sessao_mesmo_evento
  BEFORE INSERT OR UPDATE ON lot_sessions
  FOR EACH ROW EXECUTE FUNCTION lote_sessao_mesmo_evento();

-- --------------------------------------------------- 3. o dia no item vendido
ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS session_id uuid REFERENCES event_sessions(id) ON DELETE RESTRICT;

COMMENT ON COLUMN order_items.session_id IS
  'O dia/horário que o comprador escolheu. Preenchido sozinho quando o lote vende um dia só.';

CREATE INDEX IF NOT EXISTS order_items_session_idx ON order_items (session_id)
  WHERE session_id IS NOT NULL;
-- A contagem do dia entra pelos dois lados (item → sessão, e setor → sessão no
-- modelo antigo); sem estes dois índices ela vira varredura de order_items a
-- cada venda.
CREATE INDEX IF NOT EXISTS order_items_lot_idx ON order_items (lot_id);
CREATE INDEX IF NOT EXISTS sectors_session_idx ON sectors (session_id)
  WHERE session_id IS NOT NULL;

-- ------------------------------------------------------ qual dia o lote vende
-- Só responde quando NÃO HÁ ESCOLHA A FAZER:
--   - lote ligado a exatamente uma sessão  → é ela;
--   - lote ligado a várias                 → NULL, quem escolhe é o comprador;
--   - lote sem ligação                     → o dia do setor (modelo antigo),
--                                            que também pode ser NULL.
CREATE OR REPLACE FUNCTION sessao_unica_do_lote(p_lote uuid) RETURNS uuid
LANGUAGE plpgsql STABLE AS $$
DECLARE v_n int; v_sessao uuid;
BEGIN
  -- count + SELECT separados porque min(uuid) não existe no Postgres 16.
  SELECT count(*) INTO v_n FROM lot_sessions WHERE lot_id = p_lote;
  IF v_n > 1 THEN RETURN NULL; END IF;
  IF v_n = 1 THEN
    SELECT session_id INTO v_sessao FROM lot_sessions WHERE lot_id = p_lote;
    RETURN v_sessao;
  END IF;

  SELECT s.session_id INTO v_sessao
    FROM lots l JOIN sectors s ON s.id = l.sector_id
   WHERE l.id = p_lote;
  RETURN v_sessao;
END $$;

-- ------------------------------------------------------- ocupação do dia
-- Quantas PESSOAS já estão de pé para esta sessão.
--
-- Pessoas, não unidades vendidas: uma mesa de 10 é uma linha de pedido e dez
-- corpos na piscina (`sectors.admits`, do 006). Contar unidades faria o parque
-- lotar com o painel mostrando 10% — que é a mesma cicatriz que fez a coluna
-- `admits` existir.
--
-- Os status são os mesmos de `PEDIDO_VIVO` mais os que ainda não viraram
-- ingresso: pendente e em análise SEGURAM vaga (é o mesmo motivo de
-- `lots.reserved` existir), e estorno parcial continua com gente vindo. Quem
-- sai da conta é o pedido morto — expirado, cancelado, estornado inteiro,
-- chargeback —, e sai sozinho, porque a conta é feita na hora.
--
-- Três formas de um item ocupar um dia, e o OR conta o item UMA vez mesmo
-- quando mais de uma vale:
--
--   1. o comprador escolheu aquele dia;
--   2. modelo antigo — o item não tem dia, mas o SETOR dele é de um dia só.
--      Sem isto a tela mostraria zero ocupação num sábado com 3.000 vendidos;
--   3. passaporte — vale em vários dias e ocupa TODOS eles. Quem compra o
--      passe de 3 dias está no parque nos 3.
--
-- ESTA FUNÇÃO PRECISA SER CHAMADA NUMA INSTRUÇÃO SEPARADA, DEPOIS DA QUE
-- TRAVA — nunca dentro do próprio SELECT ... FOR UPDATE.
--
-- Isso foi medido, não deduzido: juntando a contagem na mesma instrução do
-- FOR UPDATE, o teste das duas conexões vende a última vaga DUAS VEZES. Em
-- READ COMMITTED aquela instrução já tinha o snapshot dela quando ficou
-- pendurada na trava; ao ser liberada, o Postgres revalida a LINHA travada,
-- mas a soma dos outros pedidos continua sendo lida com os olhos de antes —
-- um mundo onde o primeiro comprador ainda não tinha comprado. Em instrução
-- nova, dentro do gatilho, o snapshot é novo e o primeiro já está lá.
--
-- (Marcar STABLE em vez de VOLATILE não muda esse resultado — foi testado
-- também. O que protege é a ordem das instruções, não a categoria.)
CREATE OR REPLACE FUNCTION sessao_ocupacao(p_sessao uuid, p_ignorar_item uuid DEFAULT NULL)
RETURNS int LANGUAGE sql VOLATILE AS $$
  SELECT COALESCE(SUM(oi.quantity * COALESCE(s.admits, 1)), 0)::int
    FROM order_items oi
    JOIN orders o  ON o.id = oi.order_id
    JOIN lots   l  ON l.id = oi.lot_id
    JOIN sectors s ON s.id = l.sector_id
   WHERE o.status IN ('aguardando_pagamento','em_analise','pago','estornado_parcial')
     AND (p_ignorar_item IS NULL OR oi.id <> p_ignorar_item)
     AND (oi.session_id = p_sessao
          OR (oi.session_id IS NULL AND s.session_id = p_sessao)
          OR (s.kind = 'passaporte' AND EXISTS (
                SELECT 1 FROM lot_sessions ls
                 WHERE ls.lot_id = oi.lot_id AND ls.session_id = p_sessao)));
$$;

COMMENT ON FUNCTION sessao_ocupacao(uuid, uuid) IS
  'Pessoas (unidade x admits) ja vendidas/reservadas nesta sessao, somadas na hora dos pedidos vivos. p_ignorar_item exclui a propria linha num UPDATE.';

-- -------------------------------------------------- ingressos EMITIDOS no dia
-- Quantos ingressos já saíram para esta sessão.
--
-- `tickets.session_id` sozinho NÃO responde isso. Quem carimba o ingresso é
-- `utils/emissao.ts`, e ele copia o dia do SETOR (`sectors.session_id`) —
-- que é NULL em todo lote do modelo novo, o modelo que esta migração existe
-- para habilitar. Medido: lote ligado a um dia por `lot_sessions`, venda pelo
-- `/api/checkout`, dois ingressos emitidos → `order_items.session_id` com o
-- dia certo e `tickets.session_id` NULL nos dois. Contando só pela coluna do
-- ingresso, o painel mostrava "Pessoas confirmadas 2 / Ingressos emitidos 0"
-- no mesmo cartão, e a trava de "não apagar dia com ingresso" ficava morta.
--
-- Então o dia do ingresso é o dele QUANDO TEM, e o do item de pedido quando
-- não tem. `LEFT JOIN` de propósito: ingresso sem item (o FK é ON DELETE SET
-- NULL) continua contando pelo carimbo dele — `JOIN` comeria a linha órfã em
-- silêncio.
CREATE INDEX IF NOT EXISTS tickets_session_idx ON tickets (session_id)
  WHERE session_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS tickets_order_item_idx ON tickets (order_item_id)
  WHERE order_item_id IS NOT NULL;

CREATE OR REPLACE FUNCTION sessao_ingressos(p_sessao uuid) RETURNS int
LANGUAGE sql STABLE AS $$
  SELECT count(*)::int
    FROM tickets t
    LEFT JOIN order_items oi ON oi.id = t.order_item_id
   WHERE t.status <> 'cancelado'
     AND (t.session_id = p_sessao
          OR (t.session_id IS NULL AND oi.session_id = p_sessao));
$$;

COMMENT ON FUNCTION sessao_ingressos(uuid) IS
  'Ingressos validos emitidos para esta sessao: pelo carimbo do ingresso, ou pelo dia do item quando o carimbo ficou vazio.';

-- ------------------------------------------------------- a trava da vaga
-- Roda em TODA gravação de item de pedido — checkout, balcão, cortesia,
-- importação. Faz três coisas, nesta ordem:
--
--   1. carimba o dia quando não há escolha a fazer (lote de um dia só);
--   2. recusa um dia que este lote não vende;
--   3. SEGURA a linha da sessão e só então conta.
--
-- A ordem do passo 3 é o ponto do arquivo inteiro. Ler a capacidade antes do
-- FOR UPDATE resolveria o caso enfileirado — dois compradores que chegam em
-- momentos diferentes — e esconderia a ausência da trava do próprio teste, que
-- é a armadilha que já pegou quatro vezes neste projeto. Aqui a capacidade é
-- lida NA MESMA instrução que trava.
CREATE OR REPLACE FUNCTION sessao_confere_vaga() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_sessao      uuid;
  v_setor_dia   uuid;
  v_evento_lote uuid;
  v_tipo_setor  text;
  v_admite      int;
  v_pessoas     int;
  v_passaporte  boolean;
  v_dia         record;
  v_ocupadas    int;
  v_livres      int;
BEGIN
  SELECT s.session_id, s.event_id, s.kind, COALESCE(s.admits, 1)
    INTO v_setor_dia, v_evento_lote, v_tipo_setor, v_admite
    FROM lots l JOIN sectors s ON s.id = l.sector_id
   WHERE l.id = NEW.lot_id;

  IF NEW.session_id IS NULL THEN
    NEW.session_id := sessao_unica_do_lote(NEW.lot_id);
  END IF;
  v_sessao := NEW.session_id;

  -- Passaporte não escolhe dia: ele COBRE todos os dias em que vale, e ocupa
  -- vaga em cada um. Quem compra o passe de 3 dias está no parque nos 3.
  v_passaporte := v_tipo_setor = 'passaporte'
                  AND EXISTS (SELECT 1 FROM lot_sessions WHERE lot_id = NEW.lot_id);

  -- Lote sem dia nenhum (ou com vários e ninguém escolheu) segue como sempre
  -- foi: item sem data. É o estado de quem ainda não usa sessão, e ele não
  -- pode parar de vender por causa desta migração.
  IF v_sessao IS NULL AND NOT v_passaporte THEN RETURN NEW; END IF;

  IF v_sessao IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM lot_sessions WHERE lot_id = NEW.lot_id) THEN
      IF NOT EXISTS (
        SELECT 1 FROM lot_sessions WHERE lot_id = NEW.lot_id AND session_id = v_sessao
      ) THEN
        RAISE EXCEPTION 'Este ingresso não é vendido no dia escolhido. Escolha um dos dias do lote.'
          USING ERRCODE = '23514';
      END IF;
    ELSIF v_setor_dia IS NOT NULL AND v_setor_dia <> v_sessao THEN
      RAISE EXCEPTION 'Este ingresso é de outro dia. Escolha o dia do próprio ingresso.'
        USING ERRCODE = '23514';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM event_sessions
                    WHERE id = v_sessao AND event_id = v_evento_lote) THEN
      RAISE EXCEPTION 'Este ingresso e este dia são de eventos diferentes.'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  v_pessoas := NEW.quantity * v_admite;

  -- Um dia no caso normal; todos os dias cobertos quando é passaporte. A
  -- ordem por data é o que impede duas vendas de passaporte de travarem uma na
  -- outra pegando os mesmos dias em ordens opostas.
  --
  -- A TRAVA E A CAPACIDADE SAEM DA MESMA INSTRUÇÃO, de propósito. Ler a
  -- capacidade antes do FOR UPDATE resolveria o caso enfileirado, o teste
  -- sequencial passaria, e a serialização nunca seria exercida — a armadilha
  -- que já pegou quatro vezes neste projeto.
  FOR v_dia IN
    SELECT es.id, es.starts_at, es.capacity, e.timezone
      FROM event_sessions es JOIN events e ON e.id = es.event_id
     WHERE es.event_id = v_evento_lote
       AND (es.id = v_sessao
            OR (v_passaporte AND EXISTS (
                  SELECT 1 FROM lot_sessions ls
                   WHERE ls.lot_id = NEW.lot_id AND ls.session_id = es.id)))
     ORDER BY es.starts_at
     FOR UPDATE OF es
  LOOP
    CONTINUE WHEN v_dia.capacity IS NULL;

    v_ocupadas := sessao_ocupacao(v_dia.id, NEW.id);
    v_livres   := v_dia.capacity - v_ocupadas;

    IF v_pessoas > v_livres THEN
      -- Mensagem pra quem está no guichê com fila na frente: o dia, quanto
      -- sobrou e o que fazer. Nada de código nem de "constraint violation".
      RAISE EXCEPTION 'O dia % não comporta mais % pessoa(s): restam % de % lugares. Ofereça outro dia ou outro horário.',
        to_char(v_dia.starts_at AT TIME ZONE COALESCE(v_dia.timezone, 'America/Bahia'), 'DD/MM HH24:MI'),
        v_pessoas, GREATEST(v_livres, 0), v_dia.capacity
        USING ERRCODE = '23514';
    END IF;
  END LOOP;

  RETURN NEW;
END $$;

COMMENT ON FUNCTION sessao_confere_vaga() IS
  'Carimba o dia do item, recusa dia que o lote nao vende e segura a linha da sessao antes de contar a vaga.';

DROP TRIGGER IF EXISTS sessao_confere_vaga ON order_items;
CREATE TRIGGER sessao_confere_vaga
  BEFORE INSERT OR UPDATE OF quantity, session_id, lot_id ON order_items
  FOR EACH ROW EXECUTE FUNCTION sessao_confere_vaga();
