-- 011 — a reserva passa a ter prazo, sempre, e o prazo passa a ser achável.
--
-- O defeito: o pedido segura o lote enquanto espera o pagamento, e quem
-- devolve o lugar é a varredura, que só enxerga pedido com `expires_at`
-- preenchido. Pedido pendente nascido SEM prazo (qualquer rota que esqueça a
-- coluna, e são cinco rotas que inserem em `orders`) nunca é varrido: o
-- ingresso fica preso pra sempre e o evento mostra "esgotado" com a casa
-- vazia. Não é hipótese — é o modo de falha mais caro de uma bilheteria,
-- porque não dá erro em lugar nenhum: some do estoque e aparece no
-- faturamento que não veio.
--
-- Três coisas aqui:
--
-- 1. GATILHO — pedido que entra (ou vira) 'aguardando_pagamento' sem prazo
--    recebe o prazo do evento (`events.hold_minutes`). Carimbar no banco em
--    vez de confiar em cada rota é o que faz "esquecer a coluna" deixar de
--    ser possível. Ele PREENCHE em vez de recusar de propósito: uma venda de
--    balcão não pode morrer com fila na frente por causa de uma coluna.
--
-- 2. FAXINA — os pendentes que já estão sem prazo hoje ganham um, contado do
--    `created_at`. Quem já venceu entra na próxima varredura e o lugar volta
--    pra prateleira; ninguém fica preso porque nasceu antes desta migração.
--
-- 3. ÍNDICE em `order_items (lot_id)` — a reserva agora, ao ver o lote
--    cheio, procura carrinho vencido DAQUELE lote pra devolver na hora, com
--    a trava do lote na mão (server/utils/estoque.ts). Essa consulta roda no
--    caminho quente da virada de lote e, sem índice, varreria order_items
--    inteira segurando a trava — trocaria um problema de estoque por uma
--    fila parada.

-- ------------------------------------------------------------------ 1. gatilho
CREATE OR REPLACE FUNCTION reserva_sempre_tem_prazo() RETURNS trigger AS $gatilho$
BEGIN
  IF NEW.status = 'aguardando_pagamento' AND NEW.expires_at IS NULL THEN
    SELECT now() + make_interval(mins => e.hold_minutes)
      INTO NEW.expires_at
      FROM events e
     WHERE e.id = NEW.event_id;

    -- Cinto de segurança: se o evento sumiu no meio (não deveria, tem FK),
    -- o pedido ainda assim nasce com prazo. Reserva sem prazo é justamente
    -- o que esta migração existe pra impedir.
    IF NEW.expires_at IS NULL THEN
      NEW.expires_at := now() + interval '20 minutes';
    END IF;
  END IF;
  RETURN NEW;
END;
$gatilho$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS pedido_pendente_tem_prazo ON orders;
CREATE TRIGGER pedido_pendente_tem_prazo
  BEFORE INSERT OR UPDATE OF status, expires_at ON orders
  FOR EACH ROW EXECUTE FUNCTION reserva_sempre_tem_prazo();

-- ------------------------------------------------------------------- 2. faxina
UPDATE orders o
   SET expires_at = o.created_at + make_interval(mins => e.hold_minutes)
  FROM events e
 WHERE e.id = o.event_id
   AND o.status = 'aguardando_pagamento'
   AND o.expires_at IS NULL;

-- ------------------------------------------------------------------- 3. índice
-- Mesmo nome que a 016 usa pro mesmo índice, de propósito: com dois nomes
-- diferentes pra `order_items (lot_id)` o banco cria os DOIS, e cada item de
-- pedido vendido passa a manter duas árvores idênticas no caminho quente da
-- venda. `IF NOT EXISTS` + nome igual = quem rodar primeiro cria, o outro
-- passa reto.
DROP INDEX IF EXISTS order_items_lot_id_idx;
CREATE INDEX IF NOT EXISTS order_items_lot_idx ON order_items (lot_id);
