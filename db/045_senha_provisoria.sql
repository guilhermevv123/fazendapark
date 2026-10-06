-- 045 — senha provisória: quem recebe acesso pela Equipe cria a própria senha no 1º login.
--
-- Dono, 06/10: "eu quero que a pessoa possa colocar essa primeira senha e depois já resetar
-- automaticamente". A senha sorteada na Equipe (criar acesso ou "Nova senha") nasce marcada; o
-- login devolve `trocarSenha` e a tela pede a senha nova antes de abrir o painel. Trocar a senha
-- (`POST /api/auth/senha`) desmarca.
--
-- Quem já tem acesso hoje fica como está (DEFAULT false): ninguém é obrigado a trocar de surpresa.
ALTER TABLE users ADD COLUMN IF NOT EXISTS senha_provisoria boolean NOT NULL DEFAULT false;
