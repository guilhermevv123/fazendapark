-- 015 — meia-entrada: espécie do tipo, cota legal por lote, e o que a portaria pede.
--
-- Meia-entrada não é desconto comercial: é obrigação legal (Lei 12.933/2013 e
-- Decreto 8.537/2015, mais o Estatuto do Idoso e o Estatuto da Juventude). Ela
-- vem com três coisas que o schema não tinha:
--
--   1. uma ESPÉCIE — o ingresso é inteira, meia ou gratuidade;
--   2. uma COTA — o benefício vale para até 40% dos ingressos colocados à
--      venda (art. 1º, §9º do Decreto 8.537/2015). Acima disso o produtor não
--      é obrigado, e vender sem teto é dar 50% de desconto para o evento
--      inteiro sem ninguém ter decidido isso;
--   3. uma COMPROVAÇÃO — quem compra meia declara POR QUE tem direito, e a
--      portaria confere o documento daquele motivo na entrada. Ingresso de
--      meia que não diz o motivo transforma o portão em discussão: o operador
--      não sabe se pede carteira de estudante, RG de 60+ ou ID Jovem.
--
-- ---------------------------------------------------------------- 1. espécie
--
-- `kind` é COLUNA GERADA, e não um campo novo que alguém preenche. O motivo é
-- prático: a rota que cria e edita tipo de ingresso
-- (server/api/admin/evento/:id/ingressos) não conhece esta coluna, e um campo
-- que nenhuma tela preenche nasce sempre no default — ou seja, TODO tipo seria
-- 'inteira' e a cota nunca valeria para ninguém. Limite que não recusa é pior
-- que limite nenhum.
--
-- A regra usa os dois campos que a tela JÁ salva e que o produtor JÁ entende:
--
--   desconto de 100%                      -> gratuito
--   desconto > 0 E exige documento        -> meia
--   qualquer outra coisa                  -> inteira
--
-- "Exige documento" é o que separa meia-entrada de promoção. Uma promoção de
-- 50% para todo mundo não pede documento na portaria e não consome cota legal;
-- uma meia-entrada pede, sempre. Sem esse segundo campo na regra, "Black
-- Friday 50%" viraria meia-entrada sozinha, passaria a exigir motivo do
-- comprador e ficaria presa em 40% do lote — um limite que ninguém pediu.
-- Por ser gerada, a coluna não tem como divergir: não existe UPDATE que a
-- escreva por fora.

ALTER TABLE ticket_types
  ADD COLUMN IF NOT EXISTS kind text NOT NULL
  GENERATED ALWAYS AS (
    CASE WHEN discount_bps >= 10000                     THEN 'gratuito'
         WHEN discount_bps > 0 AND requires_document     THEN 'meia'
         ELSE                                                'inteira'
    END) STORED;

-- Rede: a CASE acima só produz três valores, mas o CHECK deixa escrito qual é
-- o vocabulário. Quem for mexer na expressão esbarra nele.
ALTER TABLE ticket_types DROP CONSTRAINT IF EXISTS ticket_types_kind_check;
ALTER TABLE ticket_types ADD  CONSTRAINT ticket_types_kind_check
  CHECK (kind IN ('inteira','meia','gratuito'));

-- ------------------------------------------------------------------ 2. cota
--
-- A cota mora no LOTE e não no evento porque é do lote que ela é uma fração:
-- "40% dos ingressos colocados à venda". Cada lote tem o seu `quantity`, e
-- 40% de 500 não é 40% de 5000. O default é o teto legal; um produtor que
-- queira oferecer MAIS meia do que a lei exige baixa/sobe este número no lote
-- (ainda não há tela para isso — ver o relato da entrega).
ALTER TABLE lots ADD COLUMN IF NOT EXISTS half_quota_bps int NOT NULL DEFAULT 4000;
ALTER TABLE lots DROP CONSTRAINT IF EXISTS lots_half_quota_bps_check;
ALTER TABLE lots ADD  CONSTRAINT lots_half_quota_bps_check
  CHECK (half_quota_bps BETWEEN 0 AND 10000);

-- -------------------------------------------------- 3. motivo e documento
--
-- O motivo é declarado no ITEM do pedido (é ali que o comprador escolhe "2
-- meias de estudante") e precisa chegar ao INGRESSO, que é o papel que a
-- portaria lê. As duas pontas guardam a mesma coisa de propósito: o item é
-- onde a venda foi decidida, o ingresso é o que circula — e ingresso
-- transferido, reenviado por e-mail ou impresso não carrega o pedido junto.
--
-- `half_document_required` é texto congelado no momento da compra, igual a
-- `unit_face_cents`: é a exigência que foi PROMETIDA àquele comprador. Se a
-- redação da exigência mudar amanhã, o ingresso vendido hoje continua valendo
-- com o que estava escrito nele.
ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS half_reason            text,
  ADD COLUMN IF NOT EXISTS half_document          text,
  ADD COLUMN IF NOT EXISTS half_document_required text;

ALTER TABLE tickets
  ADD COLUMN IF NOT EXISTS half_reason            text,
  ADD COLUMN IF NOT EXISTS half_document          text,
  ADD COLUMN IF NOT EXISTS half_document_required text;

-- O vocabulário dos motivos é fechado nas duas tabelas. Motivo livre vira
-- "estudante", "Estudante", "estud." e a portaria não consegue treinar
-- ninguém para conferir.
ALTER TABLE order_items DROP CONSTRAINT IF EXISTS order_items_half_reason_check;
ALTER TABLE order_items ADD  CONSTRAINT order_items_half_reason_check
  CHECK (half_reason IS NULL OR half_reason IN
         ('estudante','idoso','pcd','acompanhante','jovem_baixa_renda','professor'));

ALTER TABLE tickets DROP CONSTRAINT IF EXISTS tickets_half_reason_check;
ALTER TABLE tickets ADD  CONSTRAINT tickets_half_reason_check
  CHECK (half_reason IS NULL OR half_reason IN
         ('estudante','idoso','pcd','acompanhante','jovem_baixa_renda','professor'));

-- ------------------------------------------------------------- 4. o gatilho
--
-- Quem cria ingresso é server/utils/emissao.ts, e ele insere as colunas que
-- conhece. Carimbar aqui, no banco, em vez de pedir para cada rota lembrar, é
-- o que faz "esquecer a coluna" deixar de ser possível — mesma escolha da
-- migração 011 com o prazo da reserva.
--
-- O RAISE no fim é a rede, e ele é restrito ao canal ONLINE de propósito:
--   * online   — o comprador declara o motivo no checkout, então ingresso de
--                meia sem motivo é estado impossível, e é melhor a venda
--                morrer no rollback do que nascer um ingresso que a portaria
--                não sabe conferir;
--   * balcão   — o guichê já exige o documento do comprador (venda.post.ts),
--                mas ainda não pergunta o motivo; derrubar a venda com fila na
--                frente por causa disso seria trocar um problema por outro
--                pior;
--   * cortesia — não é meia-entrada, é convite.
CREATE OR REPLACE FUNCTION meia_carimbada_no_ingresso() RETURNS trigger AS $gatilho$
DECLARE
  item RECORD;
BEGIN
  IF NEW.order_item_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT oi.half_reason, oi.half_document, oi.half_document_required,
         o.channel, tt.kind
    INTO item
    FROM order_items oi
    JOIN orders o             ON o.id  = oi.order_id
    LEFT JOIN ticket_types tt ON tt.id = oi.ticket_type_id
   WHERE oi.id = NEW.order_item_id;
  -- LEFT JOIN no tipo porque lote sem variação vende com `ticket_type_id`
  -- nulo: com JOIN simples a linha sumiria e o ingresso nasceria sem carimbo
  -- nenhum, em silêncio.

  IF NOT FOUND THEN
    RETURN NEW;
  END IF;

  IF NEW.half_reason IS NULL THEN
    NEW.half_reason := item.half_reason;
  END IF;
  IF NEW.half_document IS NULL THEN
    NEW.half_document := item.half_document;
  END IF;
  IF NEW.half_document_required IS NULL THEN
    NEW.half_document_required := item.half_document_required;
  END IF;

  IF item.kind = 'meia' AND item.channel = 'online' AND NEW.half_reason IS NULL THEN
    RAISE EXCEPTION
      'ingresso de meia-entrada sem motivo declarado (item de pedido %)', NEW.order_item_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$gatilho$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ingresso_carimba_meia ON tickets;
CREATE TRIGGER ingresso_carimba_meia
  BEFORE INSERT ON tickets
  FOR EACH ROW EXECUTE FUNCTION meia_carimbada_no_ingresso();

-- ------------------------------------------------------------- 5. os antigos
--
-- Meia vendida antes desta migração não tem motivo — e nunca vai ter, porque
-- ninguém perguntou. O que dá para fazer é a portaria não ficar cega: o
-- ingresso antigo passa a dizer que existe uma exigência, mesmo sem dizer
-- qual. É dado de linha velha, não regra: a regra viva mora em
-- server/utils/meia-entrada.ts.
UPDATE tickets t
   SET half_document_required =
       'Documento que comprove o direito à meia-entrada '
       || '(carteira de estudante, 60+, PCD, ID Jovem ou carteira funcional de professor)'
  FROM ticket_types tt
 WHERE tt.id = t.ticket_type_id
   AND tt.kind = 'meia'
   AND t.half_document_required IS NULL;
