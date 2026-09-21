-- 005 — lotes que viram sozinhos.
--
-- Com `auto_rotate_lots` ligado, quando um lote esgota o próximo do mesmo
-- setor abre automaticamente. É o comportamento que o produtor espera de
-- "1º lote / 2º lote": ninguém quer acordar às 3h da manhã porque o primeiro
-- lote esgotou e a página ficou sem nada à venda.
--
-- Desligado, o produtor controla lote a lote pela coluna `visible` — que é o
-- que se quer quando o 2º lote só pode abrir numa data combinada com o
-- patrocinador.

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS auto_rotate_lots boolean NOT NULL DEFAULT true;
