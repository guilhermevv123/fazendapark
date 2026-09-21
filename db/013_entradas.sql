-- 013_entradas.sql — o livro-caixa da porta: uma linha por PESSOA que entrou.
--
-- POR QUE UMA TABELA NOVA, SE JÁ EXISTE `checkins`
--
-- `checkins` é o log do LEITOR: toda leitura vira linha, inclusive a recusada,
-- inclusive o código digitado errado, inclusive o print de ingresso alheio.
-- Serve pra auditar a porta. Não serve pra contar gente:
--
--   • 250 das 266 linhas de hoje são `invalido`, sem ingresso nenhum atrás;
--   • a linha nasce com id do SERVIDOR, então a mesma leitura reenviada por um
--     tablet que perdeu a resposta vira duas linhas;
--   • ela conta LEITURA, não PESSOA — e uma mesa de 4 (`sectors.admits = 4`)
--     bota quatro pessoas dentro do parque com uma leitura só. Contar linhas
--     lotava o parque com o painel marcando um quarto.
--
-- `entries` responde outra pergunta, e é a pergunta do portão: **quem entrou,
-- quando, por onde, liberado por quem, e quantas pessoas isso representa.**
-- Dela saem o relatório de público, o passaporte/reentrada (que precisa saber
-- em qual sessão a pessoa já esteve) e a recusa útil do QR repetido — hoje a
-- porta diz "já entrou" e não diz ONDE, e a fila para com o cliente jurando
-- que não entrou.
--
-- ---------------------------------------------------------------------------
-- O DESENHO É DITADO PELO OFFLINE, E ISSO NÃO É DETALHE
--
-- O parque fica na Bahia e o 4G cai. Quando cai, o portão não pode parar: o
-- tablet valida contra a lista baixada e guarda a entrada localmente. Ou seja,
-- **a entrada nasce num lugar onde o banco não existe**. Três consequências,
-- todas aqui no schema:
--
-- 1. **O `id` nasce no DISPOSITIVO e é a chave primária.** A sincronização é
--    um `INSERT ... ON CONFLICT (id) DO NOTHING`: mandar a mesma fila duas
--    vezes (rede oscilando, operador cutucando o botão, aba reaberta) não
--    conta a pessoa duas vezes. Sem isso a alternativa seria "deduplicar por
--    ingresso+minuto", que erra nos dois sentidos — funde duas passagens
--    legítimas de passaporte e deixa passar a mesma entrada reenviada 61
--    segundos depois.
--
-- 2. **`id` NÃO tem `DEFAULT gen_random_uuid()`, de propósito.** Um padrão
--    aqui seria a armadilha perfeita: o dia em que um caminho de código
--    esquecer de mandar o id, o banco inventa um novo a cada reenvio, o
--    `ON CONFLICT` nunca dispara e a contagem infla em silêncio — sem erro,
--    sem log, sem teste vermelho. Sem padrão, esse esquecimento é um
--    `NOT NULL` estourando na primeira execução.
--
-- 3. **Nada impede duas entradas do mesmo ingresso, e isso é a decisão
--    central.** Duas catracas offline não se enxergam: as duas têm o ingresso
--    como válido na lista baixada, e as duas deixam entrar. Isso é um fato do
--    mundo — a pessoa passou pela roleta duas vezes. Um `UNIQUE (ticket_id)`
--    faria a segunda linha sumir na sincronização, o parque contaria uma
--    pessoa a menos do que tem dentro, e o operador nunca saberia que houve
--    fraude. As duas linhas entram; `device_id` e `offline` dizem de onde cada
--    uma veio; a consulta de conflito (server/utils/catraca.ts) mostra o par.
--    Esconder o conflito é pior que ter o conflito.
--
-- A trava contra entrada dupla continua sendo o `UPDATE ... WHERE status =
-- 'valido'` em `tickets` (utils/catraca.ts) — essa é a que funciona ONLINE,
-- quando os dois leitores falam com o mesmo banco. `entries` não substitui a
-- trava: ela registra o que a trava não teve como impedir.

BEGIN;

CREATE TABLE IF NOT EXISTS entries (
  -- nasce no dispositivo; sem DEFAULT de propósito (ver nota 2 no topo)
  id          uuid PRIMARY KEY,

  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  event_id    uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  ticket_id   uuid NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  -- em qual sessão a pessoa entrou. É o que o passaporte de 3 dias vai
  -- perguntar ("já entrou HOJE?") sem ter que adivinhar por intervalo de hora.
  session_id  uuid REFERENCES event_sessions(id) ON DELETE SET NULL,

  -- Quantas PESSOAS esta entrada colocou dentro. Cópia de `sectors.admits` no
  -- instante da passagem, e não um JOIN na hora de contar: o setor pode ser
  -- reconfigurado de mesa-de-4 pra mesa-de-6 no meio do evento, e o relatório
  -- de público de ontem não pode mudar por causa disso. Quem grava é o
  -- SERVIDOR, lendo o setor do ingresso — nunca o número que o tablet mandou.
  people      int NOT NULL DEFAULT 1 CHECK (people >= 1 AND people <= 100),

  gate        text,
  -- qual tablet. Sem isto, duas entradas do mesmo ingresso são um mistério;
  -- com isto, são "portão Norte e portão Sul, os dois sem rede às 14h02".
  device_id   text,
  operator_id uuid REFERENCES users(id) ON DELETE SET NULL,
  -- validada contra a lista baixada, sem falar com o servidor
  offline     boolean NOT NULL DEFAULT false,

  -- A hora em que a PESSOA passou, medida no dispositivo. Numa entrada
  -- sincronizada quatro horas depois, `now()` seria mentira: o relatório de
  -- fila por hora mostraria um pico às 18h que aconteceu às 14h.
  entered_at  timestamptz NOT NULL DEFAULT now(),
  -- quando a linha chegou no servidor. A distância entre as duas é o tamanho
  -- do apagão de rede, e é a única forma de medir isso depois.
  synced_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS entries_event_entered_idx ON entries (event_id, entered_at DESC);
CREATE INDEX IF NOT EXISTS entries_ticket_idx ON entries (ticket_id);
CREATE INDEX IF NOT EXISTS entries_device_idx ON entries (event_id, device_id);
-- o relatório de público por sessão (passaporte) entra por aqui
CREATE INDEX IF NOT EXISTS entries_session_idx ON entries (session_id) WHERE session_id IS NOT NULL;

COMMENT ON TABLE entries IS
  'Uma linha por passagem de catraca. Conta PESSOAS (people), não leituras. '
  'O id nasce no dispositivo para a sincronização ser idempotente.';
COMMENT ON COLUMN entries.id IS
  'uuid gerado no dispositivo. Sem DEFAULT: reenvio da fila tem que colidir.';
COMMENT ON COLUMN entries.people IS
  'Pessoas admitidas por esta passagem (sectors.admits no momento). Mesa de 4 = 4.';
COMMENT ON COLUMN entries.offline IS
  'true = validada contra a lista baixada, sem servidor. Duas destas no mesmo '
  'ingresso é o conflito que a portaria precisa ver.';
COMMENT ON COLUMN entries.entered_at IS
  'Hora da passagem, medida no dispositivo — não a hora da sincronização.';

-- ---------------------------------------------------------------- retroativo
-- O log do leitor já tem as passagens que aconteceram antes desta tabela
-- existir. Sem trazê-las, o relatório de público nasce em zero enquanto o
-- gráfico de fila da mesma tela mostra movimento — dois números da mesma
-- coisa discordando na mesma tela é chamado aberto no dia seguinte.
--
-- O id é derivado do id do checkin (`md5` determinístico), e não sorteado:
-- assim reaplicar esta migração num banco de cópia não duplica ninguém.
-- `people` vem do setor, como em toda entrada.
INSERT INTO entries (id, org_id, event_id, ticket_id, session_id, people,
                     gate, device_id, operator_id, offline, entered_at, synced_at)
SELECT md5('entrada-do-checkin:' || ck.id::text)::uuid,
       t.org_id, t.event_id, t.id, t.session_id, s.admits,
       ck.gate, 'retroativo', ck.operator_id, false, ck.created_at, now()
  FROM checkins ck
  JOIN tickets t ON t.id = ck.ticket_id
  JOIN sectors s ON s.id = t.sector_id
 WHERE ck.resultado = 'ok'
   -- Ingresso que JÁ tem passagem no livro fica de fora. Daqui pra frente
   -- toda leitura aceita grava as duas linhas (checkin + entrada) com ids
   -- independentes; sem esta cláusula, reaplicar a migração num banco vivo
   -- traria de volta, com id derivado do checkin, uma passagem que já está
   -- registrada com o id do dispositivo — e o público dobraria em silêncio.
   AND NOT EXISTS (SELECT 1 FROM entries e2 WHERE e2.ticket_id = ck.ticket_id)
ON CONFLICT (id) DO NOTHING;

COMMIT;
