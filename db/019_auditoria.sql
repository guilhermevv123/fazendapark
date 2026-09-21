-- 019 — auditoria consultável
--
-- A tabela `audit_log` existe desde o 001 e já tem 900 linhas. O problema não
-- é falta de registro: é que o registro **não responde quem**. Medido no banco
-- antes desta migração:
--
--     total 912 | com user_id 0 | com ip 0 | sem org_id 179
--
-- Zero. Nenhuma das 912 linhas diz quem fez. Quando o produtor pergunta "quem
-- cancelou este ingresso?", a resposta que o banco tem hoje é "alguém, em tal
-- hora". Parte dos atos escreveu o autor DENTRO do payload (`after->>'por'`),
-- às vezes como nome, às vezes como e-mail — bom o suficiente pra recuperar
-- história, ruim o suficiente pra não dar pra filtrar por pessoa.
--
-- E 179 linhas nasceram sem `org_id`. Numa consulta cercada por organização —
-- que é a única forma segura de expor esta tabela numa tela — linha sem
-- `org_id` é linha invisível: o registro existe e ninguém nunca vai ler.
--
-- Esta migração faz quatro coisas, nesta ordem (a ordem importa: o gatilho do
-- passo 4 bloqueia UPDATE, então todo preenchimento retroativo precisa
-- acontecer ANTES dele existir):
--
--   1. carimba o autor na própria linha (`actor_email`);
--   2. recupera `org_id` de quem dá pra recuperar;
--   3. recupera o autor de quem deixou rastro no payload;
--   4. tranca a linha: auditoria que dá pra reescrever não é prova.
--
-- Nada aqui é NOT NULL nem CHECK. Os ~20 arquivos que hoje fazem
-- `INSERT INTO audit_log` continuam válidos sem tocar em nenhum deles — uma
-- restrição nova aqui derrubaria checkout, venda de balcão e fechamento de
-- caixa no primeiro INSERT antigo. O aperto vem pelo helper de gravação
-- (`server/utils/auditoria.ts`), que é onde dá pra apertar sem quebrar o que
-- já roda.

-- ------------------------------------------------------- 0. destrava, se já rodou
--
-- O gatilho do passo 4 bloqueia UPDATE em `audit_log`, inclusive o
-- preenchimento retroativo dos passos 2 e 3. Numa segunda execução deste
-- arquivo — um banco novo montado aplicando `db/*.sql` em ordem, ou um
-- operador conferindo — o gatilho já existiria e a migração morreria no
-- primeiro UPDATE. Soltar aqui e recriar no fim faz o arquivo poder rodar
-- quantas vezes for: todos os UPDATE abaixo são `WHERE ... IS NULL`, então a
-- segunda passada não mexe em nada.
DROP TRIGGER IF EXISTS audit_log_somente_leitura ON audit_log;

-- ------------------------------------------------------------------ 1. quem
--
-- O e-mail vai CARIMBADO na linha, além do `user_id`. Não é redundância: o
-- `user_id` só vira nome com um JOIN em `users`, e quem foi demitido some da
-- tabela. Auditoria é fotografia do momento — se o autor sumir, a linha tem
-- que continuar dizendo quem era. É por isso também que `user_id` aqui não
-- tem FOREIGN KEY: um ON DELETE SET NULL apagaria a evidência junto com a
-- pessoa, que é exatamente o que um funcionário demitido ia querer.
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS actor_email text;

-- -------------------------------------------------- 2. de quem é cada linha
--
-- Todo UPDATE abaixo compara `id::text = entity_id` em vez de
-- `entity_id::uuid = id`. O motivo é que `entity_id` é `text` livre e nem
-- toda linha guarda um UUID lá dentro; um cast no lado do `entity_id`
-- derruba a migração inteira com "invalid input syntax for type uuid" na
-- primeira linha torta, e o Postgres não garante que o filtro que protegeria
-- o cast seja avaliado antes dele.

UPDATE audit_log a SET org_id = e.org_id
  FROM events e
 WHERE a.org_id IS NULL AND a.entity IN ('evento', 'event') AND e.id::text = a.entity_id;

UPDATE audit_log a SET org_id = o.org_id
  FROM orders o
 WHERE a.org_id IS NULL AND a.entity IN ('order', 'pedido') AND o.id::text = a.entity_id;

UPDATE audit_log a SET org_id = t.org_id
  FROM tickets t
 WHERE a.org_id IS NULL AND a.entity IN ('ticket', 'ingresso') AND t.id::text = a.entity_id;

UPDATE audit_log a SET org_id = e.org_id
  FROM sectors s JOIN events e ON e.id = s.event_id
 WHERE a.org_id IS NULL AND a.entity IN ('sector', 'setor') AND s.id::text = a.entity_id;

UPDATE audit_log a SET org_id = e.org_id
  FROM lots l
  JOIN sectors s ON s.id = l.sector_id
  JOIN events e ON e.id = s.event_id
 WHERE a.org_id IS NULL AND a.entity = 'lote' AND l.id::text = a.entity_id;

UPDATE audit_log a SET org_id = e.org_id
  FROM ticket_types tt
  JOIN lots l ON l.id = tt.lot_id
  JOIN sectors s ON s.id = l.sector_id
  JOIN events e ON e.id = s.event_id
 WHERE a.org_id IS NULL AND a.entity = 'tipo' AND tt.id::text = a.entity_id;

-- O que sobrar sem `org_id` é, na maior parte, registro de coisa APAGADA
-- (setor removido, lote removido): o dono não existe mais pra ser consultado.
-- Essas linhas continuam no banco e ficam FORA DA TELA, porque toda consulta
-- da tela é cercada por `org_id = $1` — e não há como cercar o que não tem
-- organização sem chutar de quem é.
--
-- ATENÇÃO, e isto NÃO se resolve aqui: o buraco não é só histórico. Os 26
-- arquivos que fazem `INSERT INTO audit_log` por conta própria continuam
-- gravando linha sem `org_id` (`checkout.post.ts`, `evento/index.post.ts`,
-- `ingressos.patch.ts`, `ingressos.delete.ts`, `utils/emissao.ts`), então a
-- pilha de registro invisível CRESCE a cada operação. Medido depois desta
-- migração: 665 linhas sem `org_id`, das quais ~300 nasceram na última meia
-- hora. Enquanto esses arquivos não passarem pelo helper
-- (`server/utils/auditoria.ts`), "quem apagou este setor?" segue sem
-- resposta — e sem nem aparecer como lacuna, porque a tela não tem como
-- contar o que está fora da cerca dela.

-- ------------------------------------------- 3. o autor que ficou no payload
--
-- Parte dos atos gravou quem fez dentro do JSON, em `por` ou `emitidoPor`.
-- Onde o valor é um e-mail de usuário, a correspondência é exata e segura.
UPDATE audit_log a SET user_id = u.id, actor_email = u.email
  FROM users u
 WHERE a.user_id IS NULL
   AND lower(u.email) = lower(COALESCE(a.after->>'por', a.after->>'emitidoPor'));

-- Onde o valor é um NOME, só vale se o nome for único dentro da organização.
-- Dois "João Silva" na mesma produtora e a linha ficaria atribuída ao errado
-- — e atribuir o ato errado a uma pessoa é pior que não atribuir nenhum.
UPDATE audit_log a SET user_id = u.id, actor_email = u.email
  FROM users u
 WHERE a.user_id IS NULL
   AND a.org_id IS NOT NULL
   AND u.org_id = a.org_id
   AND u.name = COALESCE(a.after->>'por', a.after->>'emitidoPor')
   AND (SELECT count(*) FROM users u2
         WHERE u2.org_id = a.org_id
           AND u2.name = COALESCE(a.after->>'por', a.after->>'emitidoPor')) = 1;

-- ------------------------------------------------------- 4. linha é só leitura
--
-- Auditoria que dá pra alterar não é auditoria: é um rascunho que o
-- interessado corrige depois. O gatilho abaixo não tenta resistir a um DBA —
-- quem tem a senha do banco sempre pode `DISABLE TRIGGER`. Ele resiste ao que
-- de fato apaga evidência na prática: um script de limpeza que passa por
-- cima, um `DELETE` sem `WHERE` num terminal às 23h, uma rota nova com bug,
-- um "corrige o typo no before".
--
-- UPDATE é bloqueado SEM exceção: não existe motivo legítimo pra reescrever
-- um ato que já aconteceu. DELETE tem uma porta, e ela é explícita —
-- expurgo por retenção (LGPD, tamanho de tabela) é necessidade real, e sem
-- uma porta nomeada o que acontece é alguém desligar o gatilho inteiro numa
-- terça e esquecer de religar. A porta é uma transação que declara o que está
-- fazendo:
--
--     BEGIN;
--     SET LOCAL auditoria.expurgo = 'liberado';
--     DELETE FROM audit_log WHERE created_at < now() - interval '5 years';
--     COMMIT;
--
-- `SET LOCAL` morre no fim da transação, então a liberação não vaza pra
-- próxima query da mesma conexão do pool.
CREATE OR REPLACE FUNCTION auditoria_somente_leitura() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION
      'Linha de auditoria não pode ser alterada (id %): o registro do que já aconteceu é definitivo.',
      OLD.id;
  END IF;

  IF current_setting('auditoria.expurgo', true) IS DISTINCT FROM 'liberado' THEN
    RAISE EXCEPTION
      'Linha de auditoria não pode ser apagada (id %): expurgo por retenção precisa de SET LOCAL auditoria.expurgo = ''liberado''.',
      OLD.id;
  END IF;

  RETURN OLD;
END;
$$;

-- (o DROP já aconteceu no passo 0, antes do preenchimento retroativo)
CREATE TRIGGER audit_log_somente_leitura
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION auditoria_somente_leitura();

-- ------------------------------------------------------------------ índices
--
-- A tela filtra por período, por pessoa, por ato e por entidade, sempre
-- dentro de uma organização. O índice que já existia (`org_id, created_at`)
-- cobre só o primeiro. Os três abaixo cobrem o resto sem varrer a tabela
-- inteira quando ela tiver um ano de operação de parque em cima.
CREATE INDEX IF NOT EXISTS audit_log_org_action_idx
  ON audit_log (org_id, action, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_org_entity_idx
  ON audit_log (org_id, entity, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_org_user_idx
  ON audit_log (org_id, user_id, created_at DESC);
