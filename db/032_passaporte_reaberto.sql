-- 032 — passaporte de vários dias queimado no 1º dia (ADM-04, 27/09/2026)
--
-- Até esta data a porta marcava `usado` na PRIMEIRA leitura de qualquer ingresso, inclusive do
-- passaporte de N dias (`sectors.sessions_covered > 1`): quem pagou três dias era barrado no
-- segundo com "JÁ USADO". A porta nova (`passarPassaporte`, server/utils/catraca.ts) deixa o
-- passaporte `valido` até o último dia de uso — e este passo reabre os que a porta velha
-- queimou e AINDA têm dia a usar.
--
-- Só reabre o que foi queimado por PASSAGEM (tem linha no livro `entries`) e usou menos dias
-- do que cobre, contados com a mesma chave de dia da porta (`SQL_DIA_DA_PASSAGEM`: a sessão da
-- passagem, ou o dia do calendário no fuso do evento). O `checked_in_at` fica: é a primeira
-- entrada, e é o que as travas de cancelamento leem (passaporte que já entrou um dia não se
-- devolve como se nunca tivesse entrado).
--
-- Idempotente: numa segunda rodada nada mais casa (os reabertos já estão `valido`).
UPDATE tickets t
   SET status = 'valido'
  FROM sectors s, events ev
 WHERE s.id = t.sector_id
   AND ev.id = t.event_id
   AND COALESCE(s.sessions_covered, 1) > 1
   AND t.status = 'usado'
   AND EXISTS (SELECT 1 FROM entries e WHERE e.ticket_id = t.id)
   AND (SELECT count(DISTINCT COALESCE(e.session_id::text,
                                       to_char(e.entered_at AT TIME ZONE COALESCE(ev.timezone, 'America/Bahia'),
                                               'YYYY-MM-DD')))
          FROM entries e WHERE e.ticket_id = t.id) < s.sessions_covered;
