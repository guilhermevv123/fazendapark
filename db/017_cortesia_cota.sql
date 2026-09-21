-- 017 — cortesia com cota e com rastro.
--
-- Cortesia é o único lugar onde o evento sangra sem aparecer: ela ocupa um
-- lugar (baixa estoque igual a uma venda) e não entra em nenhuma linha de
-- receita. Um borderô que soma cortesia no faturamento fecha bonito e errado;
-- um que não conta a cortesia como ocupação faz o produtor achar que ainda tem
-- 400 lugares que ele já deu.
--
-- O borderô já separa as duas coisas certo (coluna própria, fora da receita).
-- O que faltava é o outro lado, e ele estava completamente aberto. Medido
-- antes desta migração:
--
--   * **teto**: nenhum. `POST /cortesias` emitia enquanto houvesse estoque de
--     lote. Cortesia não tem preço, então nada além do estoque a segurava —
--     dá pra dar o evento inteiro de graça sem passar por nenhuma conferência.
--   * **motivo**: opcional (`motivo: z.string().nullish()`), e quando vinha ia
--     pro `after` de uma linha de `audit_log`. As 3 cortesias que existem no
--     banco hoje têm motivo nulo.
--   * **quem pediu**: não existia campo. A pessoa que PEDIU a cortesia (o
--     diretor, o patrocinador, o vereador) nunca foi registrada em lugar
--     nenhum — só quem clicou no botão, e mesmo esse ia dentro do JSON como
--     `emitidoPor`, que não dá pra filtrar nem cruzar com a equipe.
--
-- Três coisas aqui:
--
--   1. COTA por evento e por lote (`courtesy_quota`, NULL = sem cota). NULL é
--      o padrão de propósito: ligar um teto em cima de evento que já está
--      rodando quebraria a emissão no meio da operação. Quem quer teto
--      define.
--
--   2. RASTRO em `courtesy_grants` — uma linha por emissão, com motivo, quem
--      pediu e quem autorizou. Tabela própria em vez de coluna em `orders`
--      porque `orders` é a tabela do dinheiro: campo que só existe pra um
--      canal fica nulo em 99% das linhas e polui toda consulta de receita.
--
--   3. GATILHO que recusa cortesia acima da cota, na hora do INSERT do
--      ingresso. Ver o limite dele logo abaixo — ele NÃO substitui a trava da
--      rota.
--
-- ## O que o gatilho pega e o que ele não pega
--
-- Ele pega o caminho que esqueceu de conferir: uma rota nova, um script de
-- importação, um INSERT na mão às 23h. É a mesma rede que o CHECK
-- `nao_vender_mais_que_tem` é pro estoque.
--
-- Ele NÃO pega corrida. `count(*)` não enxerga linha de transação que ainda
-- não confirmou, então duas emissões simultâneas contam a mesma coisa e as
-- duas passam. Isso é diferente do CHECK do estoque, que compara colunas da
-- PRÓPRIA linha travada e por isso é à prova de corrida. Quem serializa
-- cortesia é a trava do evento em `cortesias.post.ts`
-- (`SELECT ... FROM events ... FOR UPDATE`), e o teste de concorrência prova
-- essa trava, não este gatilho.
--
-- ## `is_courtesy` NÃO quer dizer cortesia
--
-- Esta é a correção que a primeira versão desta migração não tinha, e ela
-- derrubava venda de verdade. `server/utils/emissao.ts` carimba
-- `is_courtesy := (pedido.total_cents = 0)`: TODO ingresso de pedido que
-- fechou em zero nasce com a marca — lote de R$ 0, evento gratuito, cupom de
-- 100%. Isso é VENDA, com comprador, CPF e pedido no canal `online`.
--
-- Com a cota contando pela marca, o estrago era dos dois lados:
--
--   * o comprador de um ingresso gratuito levava **HTTP 500** na cara
--     ("Cota de cortesia do evento esgotada"), com o pedido pendurado em
--     `aguardando_pagamento` e o estoque preso em `reserved` até a tarefa de
--     expiração — medido com `courtesy_quota = 0` e um lote de R$ 0;
--   * e, com cota sobrando, cada venda gratuita comia em silêncio uma vaga
--     do teto que o produtor reservou pra imprensa e patrocinador.
--
-- A régua certa é o PEDIDO, não a marca: cortesia é o que a rota de cortesia
-- emitiu, e ela grava `orders.channel = 'cortesia'` — o mesmo recorte que o
-- borderô já usa pra manter cortesia fora da receita. Ingresso sem pedido
-- (INSERT na mão, importação) continua contando: é exatamente o caminho que
-- este gatilho existe pra pegar.

-- ------------------------------------------------------------------ 1. cota
--
-- NULL = sem cota. Zero = cota de zero (nenhuma cortesia), que é diferente e
-- é um pedido legítimo: "este evento não dá cortesia".
ALTER TABLE events ADD COLUMN IF NOT EXISTS courtesy_quota int;
ALTER TABLE lots   ADD COLUMN IF NOT EXISTS courtesy_quota int;

DO $cota$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cota_cortesia_evento_valida') THEN
    ALTER TABLE events ADD CONSTRAINT cota_cortesia_evento_valida
      CHECK (courtesy_quota IS NULL OR courtesy_quota >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cota_cortesia_lote_valida') THEN
    ALTER TABLE lots ADD CONSTRAINT cota_cortesia_lote_valida
      CHECK (courtesy_quota IS NULL OR courtesy_quota >= 0);
  END IF;
END
$cota$;

-- ---------------------------------------------------------------- 2. rastro
--
-- Uma linha por EMISSÃO (= um pedido de cortesia), não por ingresso: motivo e
-- quem pediu são os mesmos para as 40 cortesias da imprensa. "Pra quem foi"
-- continua no ingresso (`tickets.holder_name`), e o caminho entre os dois é
-- `tickets.order_id`.
--
-- `authorized_by` não tem FOREIGN KEY, e `authorized_email`/`authorized_name`
-- vão CARIMBADOS: é a mesma decisão de `audit_log` na 019. Quem autorizou 300
-- cortesias e foi demitido não pode sumir do registro junto com a linha em
-- `users` — um ON DELETE SET NULL aqui apagaria exatamente a evidência que o
-- interessado ia querer ver sumir.
--
-- `unit_face_cents` é o valor de face do lote NO INSTANTE da emissão. O que a
-- cortesia "custou" é o preço que ela tinha quando foi dada; ler
-- `lots.price_cents` na hora do relatório faz a conta inteira mudar sozinha na
-- virada de lote, meses depois, sem ninguém ter mexido em cortesia nenhuma.
CREATE TABLE IF NOT EXISTS courtesy_grants (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  event_id         uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  order_id         uuid NOT NULL UNIQUE REFERENCES orders(id) ON DELETE CASCADE,
  lot_id           uuid NOT NULL REFERENCES lots(id) ON DELETE RESTRICT,
  ticket_type_id   uuid REFERENCES ticket_types(id) ON DELETE RESTRICT,
  quantity         int NOT NULL CHECK (quantity > 0),

  -- por que saiu de graça, e a pedido de quem. Os dois são NOT NULL e com
  -- CHECK de conteúdo: coluna obrigatória que aceita string vazia é coluna
  -- opcional com um nome pior.
  reason           text NOT NULL CHECK (length(btrim(reason)) >= 3),
  requested_by     text NOT NULL CHECK (length(btrim(requested_by)) >= 2),

  -- quem autorizou = quem estava logado e apertou o botão
  authorized_by    uuid,
  authorized_email text NOT NULL,
  authorized_name  text,

  unit_face_cents  bigint NOT NULL CHECK (unit_face_cents >= 0),
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS courtesy_grants_evento_idx
  ON courtesy_grants (event_id, created_at DESC);
CREATE INDEX IF NOT EXISTS courtesy_grants_org_idx
  ON courtesy_grants (org_id, created_at DESC);

-- As cortesias que já existem NÃO ganham linha aqui, e isso é de propósito:
-- ninguém registrou o motivo nem quem pediu, e inventar uma linha
-- ("migrado", "desconhecido") faria o rastro parecer completo. A tela mostra
-- "não registrado" nessas, que é a verdade.

-- --------------------------------------------------------------- 3. gatilho
--
-- Índice primeiro: o gatilho conta cortesia do evento a cada emissão, e sem
-- índice isso varre `tickets` inteira — com a trava do lote na mão, numa
-- tabela que cresce o ano todo.
CREATE INDEX IF NOT EXISTS tickets_cortesia_idx
  ON tickets (event_id, lot_id) WHERE is_courtesy;

CREATE OR REPLACE FUNCTION cortesia_dentro_da_cota() RETURNS trigger
LANGUAGE plpgsql AS $gatilho$
DECLARE
  cota_evento int;
  cota_lote   int;
  ja          int;
BEGIN
  -- Venda que fechou em zero (lote de R$ 0, cupom de 100%) chega aqui com
  -- `is_courtesy` marcado por `utils/emissao.ts`, e ela NÃO é cortesia: tem
  -- comprador, tem pedido e não sai do teto que o produtor guardou pra
  -- imprensa. Recusar essa linha derrubava o checkout público inteiro.
  IF NEW.order_id IS NOT NULL AND EXISTS (
       SELECT 1 FROM orders o WHERE o.id = NEW.order_id AND o.channel <> 'cortesia') THEN
    RETURN NEW;
  END IF;

  SELECT e.courtesy_quota INTO cota_evento FROM events e WHERE e.id = NEW.event_id;
  SELECT l.courtesy_quota INTO cota_lote   FROM lots   l WHERE l.id = NEW.lot_id;

  -- Sem cota nenhuma não há o que conferir — e nem o que contar. É o caso de
  -- todo evento que existe hoje, então o caminho normal não paga nada.
  IF cota_evento IS NULL AND cota_lote IS NULL THEN
    RETURN NEW;
  END IF;

  -- Cancelada devolve o lugar (a rota de cancelamento devolve o estoque), então
  -- devolve a cota junto. Contar cancelada seria cobrar duas vezes pelo mesmo
  -- assento.
  IF cota_evento IS NOT NULL THEN
    SELECT count(*) INTO ja FROM tickets t
     WHERE t.event_id = NEW.event_id AND t.is_courtesy AND t.status <> 'cancelado'
       AND NOT EXISTS (SELECT 1 FROM orders o
                        WHERE o.id = t.order_id AND o.channel <> 'cortesia');
    IF ja + 1 > cota_evento THEN
      RAISE EXCEPTION
        'Cota de cortesia do evento esgotada: % de % já emitidas.', ja, cota_evento
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF cota_lote IS NOT NULL THEN
    SELECT count(*) INTO ja FROM tickets t
     WHERE t.lot_id = NEW.lot_id AND t.is_courtesy AND t.status <> 'cancelado'
       AND NOT EXISTS (SELECT 1 FROM orders o
                        WHERE o.id = t.order_id AND o.channel <> 'cortesia');
    IF ja + 1 > cota_lote THEN
      RAISE EXCEPTION
        'Cota de cortesia do lote esgotada: % de % já emitidas.', ja, cota_lote
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$gatilho$;

DROP TRIGGER IF EXISTS ticket_cortesia_dentro_da_cota ON tickets;
CREATE TRIGGER ticket_cortesia_dentro_da_cota
  BEFORE INSERT ON tickets
  FOR EACH ROW WHEN (NEW.is_courtesy) EXECUTE FUNCTION cortesia_dentro_da_cota();
