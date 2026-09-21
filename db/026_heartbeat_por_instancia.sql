-- ============================================================================
-- 026 · O ponto é batido POR INSTÂNCIA, e uma instância morta não se esconde
--       atrás de uma viva
--
-- ## O defeito, medido
--
-- A 024 criou `worker_heartbeats` com `PRIMARY KEY (worker)` — UMA linha por
-- fila, para TODOS os processos. O comentário dela promete o contrário: diz
-- que `instance` existe porque, com duas instâncias no ar, "o trabalhador não
-- bate" pode ser só UMA morta. Com a chave por `worker`, as duas escrevem a
-- mesma linha e quem bate por último apaga o rastro da outra.
--
-- Reproduzido no banco, com o INSERT literal de `anunciarWorker`/`baterPonto`:
--
--     maquinaA:111 sobe e morre (última batida há 10 min)
--     maquinaB:222 sobe e continua batendo
--     SELECT count(*) ... WHERE worker='zz-repro-frota'  ->  1
--     SELECT instance, now()-beat_at ...  ->  maquinaB:222 | 0 s
--
-- Uma linha. `bateu_ha = 0`. `vereditoDaFila()` lê isso e responde "Andando" —
-- com METADE da frota parada e a fila daquela metade sem sair do lugar. O
-- painel fica verde exatamente no cenário que a tabela foi criada pra acusar.
--
-- ## A forma do conserto
--
-- A tabela passa a ser por `(worker, instance)`: cada processo tem a SUA
-- linha, e ninguém sobrescreve ninguém. Só que a tela de saúde
-- (`server/api/admin/filas.get.ts`) pergunta ao banco `WHERE worker = $1` e
-- usa a PRIMEIRA linha — com várias, ela passaria a ler uma instância
-- sorteada, que é um defeito pior que o de origem, porque varia a cada
-- consulta.
--
-- Por isso são DUAS coisas:
--
--   `worker_heartbeat_instances`  a tabela física, uma linha por processo
--   `worker_heartbeats`           a VISÃO, uma linha por fila, que é o que
--                                 quem pergunta "esta fila está andando?"
--                                 precisa ler
--
-- A visão mantém, com os mesmos nomes e tipos, todas as colunas que a rota já
-- lê — ela não muda de arquivo e passa a receber resposta melhor — e responde
-- pela frota inteira, com a régua invertida de propósito:
--
--   * `beat_at` é o da instância LIGADA que está calada há MAIS tempo.
--     A pergunta "a fila está andando?" só tem resposta "sim" quando TODAS
--     estão. A instância viva não empresta o carimbo dela pra morta.
--   * `instance` e `booted_at` saem da MESMA linha — "quem subiu" e "quando
--     subiu" são um fato só, e misturar os dois já mandou investigação pro log
--     do processo errado (ver o comentário de `baterPonto`).
--   * `done`/`failed` somam a frota: a pergunta de quem abre a tela às 21h é
--     quanto já saiu, não quanto saiu por processo.
--   * `instances`, `instances_on`, `instances_live`, `instances_silent` e
--     `fleet` são as colunas novas: quantas existem, quantas estão ligadas,
--     quantas estão em dia, quantas estão mudas, e o detalhe de cada uma com
--     há quantos segundos ela não aparece.
--
-- ## A linha velha do processo que reiniciou NÃO é uma instância morta
--
-- Chave por processo cria um lixo novo: cada `npm run dev`, cada deploy, cada
-- reinício é um pid diferente, e a linha do pid anterior fica lá, calada pra
-- sempre. Tratar isso como morte acende alarme vermelho depois de todo deploy
-- — e alarme que mente todo dia treina o operador a não olhar a tela, que é um
-- estrago maior do que o da tela não existir.
--
-- A régua que separa as duas coisas é a MÁQUINA: uma linha está SUBSTITUÍDA
-- quando existe outra linha, da mesma fila e da mesma máquina, que subiu
-- DEPOIS da última batida dela — isto é, o processo saiu e outro tomou o
-- lugar. Se as duas bateram no mesmo período, nenhuma substitui a outra e o
-- silêncio de qualquer uma continua sendo morte de verdade, que é o caso que
-- esta migração existe pra enxergar.
--
-- Máquina que sai da frota de propósito (redução de escala) fica acusando até
-- alguém apagar a linha — `DELETE FROM worker_heartbeat_instances WHERE
-- instance = 'host:pid'`. É a direção segura: some da frota por decisão de
-- gente, nunca por esquecimento do banco.
-- ============================================================================

-- ------------------------------------------------- 1. a tabela vira por processo

-- `CREATE TABLE IF NOT EXISTS` da 024 num banco onde ela já existe passa mudo;
-- aqui o mesmo cuidado, pelo outro lado: só renomeia se `worker_heartbeats`
-- ainda for TABELA. Depois desta migração ela é VISÃO, e um `ALTER TABLE
-- ... RENAME` numa segunda passada renomearia a visão — deixando o banco sem
-- nenhuma das duas com o nome certo.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public' AND c.relname = 'worker_heartbeats'
                AND c.relkind = 'r')
     AND NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                      WHERE n.nspname = 'public' AND c.relname = 'worker_heartbeat_instances')
  THEN
    ALTER TABLE worker_heartbeats RENAME TO worker_heartbeat_instances;
  END IF;
END $$;

-- Rede de segurança pra um banco que nunca viu a 024 (o `IF NOT EXISTS` dela
-- deixa passar sem criar nada quando o nome já mudou aqui).
CREATE TABLE IF NOT EXISTS worker_heartbeat_instances (
  worker      text NOT NULL,
  status      text NOT NULL DEFAULT 'ligado' CHECK (status IN ('ligado','desligado')),
  instance    text NOT NULL,
  beat_ms     int,
  beats       boolean NOT NULL DEFAULT true,
  booted_at   timestamptz NOT NULL DEFAULT now(),
  beat_at     timestamptz NOT NULL DEFAULT now(),
  worked_at   timestamptz,
  done        bigint NOT NULL DEFAULT 0,
  failed      bigint NOT NULL DEFAULT 0,
  last_error  text
);

-- `instance` era anulável e agora é metade da chave. As linhas de antes desta
-- migração vieram de um processo que existiu — só não deixou o nome. Apagar
-- seria perder o carimbo de uma fila que está de pé; o rótulo diz o que se
-- sabe dela, que é nada.
UPDATE worker_heartbeat_instances SET instance = 'instância não registrada'
 WHERE instance IS NULL;
ALTER TABLE worker_heartbeat_instances ALTER COLUMN instance SET NOT NULL;

DO $$
BEGIN
  -- A chave velha (`worker`) é o defeito em si: ela é o que obriga duas
  -- instâncias a disputarem a mesma linha.
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conrelid = 'worker_heartbeat_instances'::regclass
                AND contype = 'p' AND array_length(conkey, 1) = 1) THEN
    EXECUTE 'ALTER TABLE worker_heartbeat_instances DROP CONSTRAINT '
          || (SELECT quote_ident(conname) FROM pg_constraint
               WHERE conrelid = 'worker_heartbeat_instances'::regclass AND contype = 'p');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'worker_heartbeat_instances'::regclass AND contype = 'p') THEN
    ALTER TABLE worker_heartbeat_instances
      ADD CONSTRAINT worker_heartbeat_instances_pkey PRIMARY KEY (worker, instance);
  END IF;
END $$;

-- ------------------------------------------------------ 2. a máquina da instância
--
-- `instance` é `host:pid` (`instanciaDoProcesso()`, em `server/utils/envio.ts`).
-- A máquina é tudo menos o pid do fim — recortado pelo padrão, e não por
-- `split_part(x, ':', 1)`, porque hostname com dois-pontos existe e o corte
-- pelo primeiro separador devolveria meia máquina, fazendo dois processos da
-- MESMA máquina parecerem de máquinas diferentes. O efeito disso seria o
-- alarme falso de volta: o pid velho nunca seria dado como substituído.
CREATE OR REPLACE FUNCTION maquina_da_instancia(instancia text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT regexp_replace(COALESCE(instancia, ''), ':[0-9]+$', '')
$$;

-- ------------------------------------------------------------- 3. a leitura
--
-- Uma linha por fila, como a rota de saúde espera, mas com a frota inteira
-- por trás. Quem já lia continua lendo as mesmas colunas; o que muda é que
-- elas passam a contar a verdade quando existe mais de um processo.
CREATE OR REPLACE VIEW worker_heartbeats AS
WITH atual AS (
  SELECT i.*,
         -- a régua daquele processo: três batidas perdidas, nunca menos de 3 s
         GREATEST(3, (GREATEST(1000, COALESCE(i.beat_ms, 15000)) * 3) / 1000.0) AS tolerancia_s,
         EXTRACT(epoch FROM now() - i.beat_at)::int AS calada_ha
    FROM worker_heartbeat_instances i
   -- a vida anterior do mesmo lugar não é uma instância morta (ver o cabeçalho)
   WHERE NOT EXISTS (
     SELECT 1 FROM worker_heartbeat_instances v
      WHERE v.worker = i.worker
        AND v.instance <> i.instance
        AND maquina_da_instancia(v.instance) = maquina_da_instancia(i.instance)
        AND v.booted_at >= i.beat_at)
),
medida AS (
  -- MUDA é só quem prometeu falar: instância desligada de propósito
  -- (`DT_ENVIO_WORKER=off` numa máquina que só serve tela) e fila que não
  -- carimba varredura (`beats = false`, o caso do estorno) ficam de fora. Sem
  -- essa exclusão, as duas apareceriam paradas 45 s depois de todo boot.
  SELECT a.*,
         (a.status = 'ligado' AND a.beats AND a.calada_ha > a.tolerancia_s) AS muda
    FROM atual a
),
pior AS (
  SELECT DISTINCT ON (worker) *
    FROM medida
   ORDER BY worker,
            -- instância desligada nunca é a pior: o silêncio dela é legítimo e
            -- reportá-lo como falha da fila é o alarme falso de novo
            (status = 'ligado') DESC,
            beat_at ASC
),
frota AS (
  SELECT worker,
         count(*)::int                                            AS instances,
         count(*) FILTER (WHERE status = 'ligado')::int            AS instances_on,
         count(*) FILTER (WHERE status = 'ligado' AND NOT muda)::int AS instances_live,
         count(*) FILTER (WHERE muda)::int                         AS instances_silent,
         sum(done)::bigint                                         AS done,
         sum(failed)::bigint                                       AS failed,
         max(worked_at)                                            AS worked_at,
         -- O último erro é da FILA, não do processo: vale o mais recente de
         -- quem quer que seja. Escondê-lo porque veio da outra instância
         -- deixaria a tela contando a falha sem dizer o motivo dela.
         (array_agg(last_error ORDER BY beat_at DESC)
            FILTER (WHERE last_error IS NOT NULL))[1]              AS last_error,
         jsonb_agg(jsonb_build_object(
           'instance', instance, 'status', status, 'beats', beats,
           'booted_at', booted_at, 'beat_at', beat_at,
           'silent_seconds', calada_ha, 'silent', muda,
           'done', done, 'failed', failed, 'last_error', last_error)
           ORDER BY (status = 'ligado') DESC, beat_at)             AS fleet
    FROM medida GROUP BY worker
)
SELECT
  p.worker,
  -- 'ligado' quando ALGUMA instância trabalha: a fila anda. `pior` já ordena
  -- as ligadas na frente, então isto sai de graça.
  p.status,
  -- `instance` é o único campo de texto livre que a tela de saúde já lê, e é
  -- por ele que a frota chega em quem está olhando. Com UMA instância ele
  -- continua sendo exatamente `host:pid`, byte a byte como antes; com mais de
  -- uma ele nomeia a pior e diz o tamanho do problema. O detalhe instância a
  -- instância está em `fleet`, esperando uma coluna a mais no SELECT da rota.
  CASE
    WHEN f.instances = 1 THEN p.instance
    WHEN NOT p.beats THEN
      p.instance || ' · ' || f.instances || ' instâncias (esta fila não carimba varredura)'
    WHEN f.instances_silent > 0 THEN
      p.instance || ' · ' || f.instances_silent || ' de ' || f.instances
      || ' instâncias sem carimbar'
    ELSE p.instance || ' · ' || f.instances || ' instâncias, todas carimbando'
  END                                                              AS instance,
  p.beat_ms,
  p.beats,
  -- do MESMO processo de `instance`, sempre
  p.booted_at,
  -- a mais calada das ligadas: a viva não cobre a morta
  p.beat_at,
  f.worked_at,
  f.done,
  f.failed,
  f.last_error,
  f.instances,
  f.instances_on,
  f.instances_live,
  f.instances_silent,
  f.fleet
FROM pior p JOIN frota f ON f.worker = p.worker;

COMMENT ON VIEW worker_heartbeats IS
  'Uma linha por fila, medida sobre worker_heartbeat_instances: beat_at é o da '
  'instância ligada mais calada, para que uma instância viva não esconda uma morta.';
