-- ============================================================================
-- 024 · A fila dá sinal de vida, e a auditoria não pode ser esvaziada
--
-- Duas coisas que o sistema não sabia responder, e as duas só aparecem quando
-- já é tarde.
--
-- ## 1. "A fila está andando?"
--
-- O trabalhador que entrega o ingresso roda dentro do processo do servidor.
-- Quando ele não sobe — e ele NÃO subia no build de produção, porque nascia
-- de um `import` de topo que o empacotador jogou dentro do pedaço de UMA rota
-- lenta — nada quebra, nada aparece no log e nenhum teste fica vermelho. A
-- fila simplesmente enche. Quem descobre é o comprador que pagou e não
-- recebeu, no dia do evento, no portão.
--
-- Medido no build antes do conserto: linha madura na fila, servidor no ar há
-- 67 s (quatro varreduras deviam ter acontecido), `attempts = 0`, nenhum .eml
-- em disco, stdout mudo.
--
-- Contar a fila sozinho NÃO responde a pergunta. Fila vazia com o trabalhador
-- morto é idêntica a fila vazia com o trabalhador vivo — até a primeira
-- venda. Por isso o trabalhador CARIMBA a batida do ponto aqui, a cada
-- varredura, mesmo quando não achou nada pra fazer. "Não bate há 4 minutos"
-- é a única frase que distingue os dois casos antes de o dinheiro entrar.
--
-- A tabela é de INFRAESTRUTURA, não de cliente: uma linha por trabalhador,
-- não por organização. Quem pergunta "o processo está vivo?" está perguntando
-- do processo, que é um só para todas as organizações.
--
-- ## 2. `TRUNCATE audit_log`
--
-- A 019 trancou a auditoria com um gatilho `FOR EACH ROW` — e `FOR EACH ROW`
-- não enxerga `TRUNCATE`, que é um comando de tabela inteira e não passa
-- linha por linha. Ou seja: a linha estava protegida e a TABELA não. Um
-- `TRUNCATE audit_log` apagava as 912 linhas sem disparar nada, que é
-- exatamente o comando que alguém com pressa digita quando quer "limpar" o
-- banco — e o único que apaga a evidência inteira de uma vez.
-- ============================================================================

-- ---------------------------------------------------------- 1. o ponto batido
--
-- `worker` é a chave: 'envio' (confirmação do ingresso) e 'estorno' (devolução
-- do dinheiro). Uma linha por fila, reescrita a cada batida — o histórico de
-- quem bateu quando não interessa; o que interessa é a última batida.
--
-- `instance` guarda host:pid. Com duas instâncias no ar, "o trabalhador não
-- bate" muda de significado: pode ser que UMA morreu. Sem saber qual processo
-- carimbou, a investigação começa adivinhando.
--
-- `beat_ms` é o intervalo que AQUELE processo está usando. Sem ele, quem lê
-- não tem régua: 40 s sem bater é silêncio demais para um laço de 15 s e
-- normal para um de 60 s. Guardar a régua junto com a medida é o que deixa a
-- tela dizer "parou" sem chutar.
CREATE TABLE IF NOT EXISTS worker_heartbeats (
  worker      text PRIMARY KEY,

  -- 'desligado' é estado legítimo (DT_ENVIO_WORKER=off numa instância que só
  -- serve tela). Sem registrar isso, desligado e morto ficam iguais na tela.
  status      text NOT NULL DEFAULT 'ligado' CHECK (status IN ('ligado','desligado')),

  instance    text,
  beat_ms     int,

  -- Este trabalhador CARIMBA cada varredura, ou a linha é só o registro do
  -- boot? A diferença muda o que a tela pode afirmar. Quem carimba pode ser
  -- acusado de silêncio; quem não carimba, não — e acusar de silêncio um
  -- trabalhador que está trabalhando é alarme falso todo dia até ninguém
  -- mais olhar a tela, que é pior do que não ter tela.
  beats       boolean NOT NULL DEFAULT true,

  booted_at   timestamptz NOT NULL DEFAULT now(),
  beat_at     timestamptz NOT NULL DEFAULT now(),

  -- Última varredura que ACHOU o que fazer. Diferente de `beat_at` de
  -- propósito: um trabalhador vivo numa fila vazia bate sem trabalhar, e
  -- confundir as duas coisas faz "trabalhou há 2 h" parecer defeito numa
  -- terça de manhã sem venda nenhuma.
  worked_at   timestamptz,

  done        bigint NOT NULL DEFAULT 0,
  failed      bigint NOT NULL DEFAULT 0,
  last_error  text
);

-- `CREATE TABLE IF NOT EXISTS` não acrescenta coluna em tabela que já existe:
-- num banco onde esta migração já rodou, ela passa muda e a coluna nova
-- simplesmente não aparece. A tela então lê `beats` como `undefined`, decide
-- "carimba", e acusa de silêncio a fila que não carimba — o defeito de volta,
-- e sem nada vermelho pra denunciar.
ALTER TABLE worker_heartbeats ADD COLUMN IF NOT EXISTS beats boolean NOT NULL DEFAULT true;

-- ------------------------------------------------- 2. a auditoria por inteiro
--
-- Gatilho de ENUNCIADO (`FOR EACH STATEMENT`), que é o único nível em que
-- `TRUNCATE` dispara. O `FOR EACH ROW` da 019 continua valendo para UPDATE e
-- DELETE; este cobre o buraco que sobrou.
--
-- A porta é a MESMA do DELETE, e isso é decisão: quem faz expurgo por
-- retenção já aprendeu a declarar o que está fazendo, e inventar uma segunda
-- senha só faria alguém desligar o gatilho inteiro numa terça e esquecer de
-- religar.
--
--     BEGIN;
--     SET LOCAL auditoria.expurgo = 'liberado';
--     TRUNCATE audit_log;
--     COMMIT;
--
-- `TRUNCATE` é transacional no Postgres: sem a porta, a exceção derruba a
-- transação e a tabela fica inteira.
CREATE OR REPLACE FUNCTION auditoria_sem_esvaziar() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('auditoria.expurgo', true) IS DISTINCT FROM 'liberado' THEN
    RAISE EXCEPTION
      'A auditoria não pode ser esvaziada: TRUNCATE apagaria o registro inteiro do que já aconteceu. Expurgo por retenção precisa de SET LOCAL auditoria.expurgo = ''liberado''.';
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS audit_log_sem_esvaziar ON audit_log;
CREATE TRIGGER audit_log_sem_esvaziar
  BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION auditoria_sem_esvaziar();
