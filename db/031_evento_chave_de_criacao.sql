-- 031 — a chave de criação do evento (auditoria EVT-09)
--
-- O assistente de "Criar evento" manda tudo num POST só. Com a rede do parque instável, a resposta
-- se perdia DEPOIS de o evento gravar; a pessoa clicava "Publicar" de novo e nascia um segundo
-- evento, com endereço "-2", à venda em paralelo com o primeiro. Agora o assistente sorteia uma
-- chave por evento a criar (ela vai no rascunho do navegador) e o servidor devolve o evento que já
-- existe com essa chave, em vez de criar outro.
--
-- Aditivo e nulo: evento antigo (e o criado por outra porta) fica sem chave. O índice é parcial e
-- por organização — a chave só precisa ser única dentro da produtora, e é o índice que segura a
-- corrida de dois cliques simultâneos (o segundo cai no 23505 e lê o primeiro).

ALTER TABLE events ADD COLUMN IF NOT EXISTS creation_key uuid;

CREATE UNIQUE INDEX IF NOT EXISTS events_org_chave_de_criacao
  ON events (org_id, creation_key) WHERE creation_key IS NOT NULL;
