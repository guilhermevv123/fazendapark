-- 014 — os limites que faltavam no checkout, e a rede pro desconto.
--
-- O defeito: o checkout aceitava coisa que não devia. Um pedido só podia
-- estourar o `max_per_order` de CADA lote — nada segurava o pedido INTEIRO, e
-- vinte linhas de seis ingressos são cento e vinte ingressos num clique. O
-- cupom era conferido por um contador (`promo_codes.uses`) que anda pros dois
-- lados por caminhos diferentes, e o "um uso por pessoa" (`max_per_customer`,
-- que já existia na tabela desde o schema) não era lido por ninguém: dava pra
-- usar o mesmo cupom de 100% a noite toda.
--
-- Quatro coisas aqui:
--
-- 1. TETO DE DESCONTO (`promo_codes.max_discount_cents`) — o que separa
--    "20% de desconto" de "20% até R$ 30". Sem ele, o cupom desenhado pra um
--    ingresso de R$ 60 vira R$ 400 de abatimento na hora em que alguém
--    comprar dez camarotes, e o desconto sai inteiro do bolso do produtor.
--    NULL = sem teto, que é o comportamento de hoje pros cupons já criados.
--
-- 2. TETO POR PEDIDO (`events.max_per_order`) — quantos ingressos cabem num
--    pedido só, somando todos os lotes. NULL = vale o padrão do código
--    (server/api/checkout.post.ts), que nunca é infinito.
--
-- 3. ÍNDICE em `orders (promo_code_id, status)` — a partir de agora a
--    contagem de uso do cupom é LIDA DE `orders`, e ela roda com a linha do
--    cupom travada, no caminho quente da compra. Sem índice, cada resgate
--    varreria a tabela de pedidos inteira segurando a trava: trocaria um
--    problema de cupom por uma fila parada.
--
-- 4. REDE do desconto — dois CHECKs em `orders`. A conta que impede desconto
--    maior que a face mora em utils/dinheiro.ts, e a política do teto em
--    utils/cupom.ts; estes CHECKs são a terceira camada, do mesmo jeito que
--    `nao_vender_mais_que_tem` é a terceira camada do estoque. Se um caminho
--    novo esquecer as duas de cima, o banco recusa em vez de gravar um pedido
--    em que a plataforma deve dinheiro pra quem comprou.
--    Conferido antes de criar: 201 pedidos no banco, zero fora da faixa.

-- ------------------------------------------------- 1. teto de desconto
ALTER TABLE promo_codes
  ADD COLUMN IF NOT EXISTS max_discount_cents bigint;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'promo_codes_teto_positivo') THEN
    ALTER TABLE promo_codes
      ADD CONSTRAINT promo_codes_teto_positivo
      CHECK (max_discount_cents IS NULL OR max_discount_cents > 0);
  END IF;
END $$;

COMMENT ON COLUMN promo_codes.max_discount_cents IS
  'teto do desconto em centavos; NULL = sem teto. "20% até R$ 30" = value 2000, teto 3000.';

-- ------------------------------------------------- 2. teto por pedido
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS max_per_order int;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'events_max_per_order_positivo') THEN
    ALTER TABLE events
      ADD CONSTRAINT events_max_per_order_positivo
      CHECK (max_per_order IS NULL OR max_per_order > 0);
  END IF;
END $$;

COMMENT ON COLUMN events.max_per_order IS
  'quantos ingressos cabem num pedido só, somando os lotes; NULL = padrão do checkout';

-- ------------------------------------------------- 3. índice da contagem
CREATE INDEX IF NOT EXISTS orders_promo_code_idx
  ON orders (promo_code_id, status)
  WHERE promo_code_id IS NOT NULL;

-- ------------------------------------------------- 4. a rede do desconto
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_desconto_cabe_na_face') THEN
    ALTER TABLE orders
      ADD CONSTRAINT orders_desconto_cabe_na_face
      CHECK (discount_cents >= 0 AND discount_cents <= face_cents);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_total_nao_negativo') THEN
    ALTER TABLE orders
      ADD CONSTRAINT orders_total_nao_negativo
      CHECK (total_cents >= 0);
  END IF;
END $$;
