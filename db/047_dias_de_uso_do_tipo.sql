-- 047 — dias de uso do TIPO de ingresso (dono, 07/10: "o ingresso que o cara tem de sexta, ele
-- tenta passar domingo").
--
-- O tipo diz em QUAIS dias do evento ele passa na catraca: "ENTRADA INDIVIDUAL SEXTA" só na sexta.
-- É do tipo e não do lote: o tipo de mesmo nome em outro lote recebe os mesmos dias (quem aplica
-- é a rota do painel, `ingressos.patch.ts`). As datas são DIAS do calendário no fuso do evento
-- (`events.timezone`) — a catraca compara com o dia de hoje nesse fuso.
--
-- NULL (ou vazio) = vale em qualquer dia do evento, que é como tudo funcionava até aqui: nada do
-- que já foi vendido muda de comportamento até alguém marcar os dias no painel.
ALTER TABLE ticket_types ADD COLUMN IF NOT EXISTS valid_dates date[];

COMMENT ON COLUMN ticket_types.valid_dates IS
  'Dias (no fuso do evento) em que o ingresso deste tipo passa na catraca. NULL/vazio = qualquer dia do evento.';
