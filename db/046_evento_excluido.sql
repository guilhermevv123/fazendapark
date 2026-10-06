-- 046 — excluir evento da lista (dono, 06/10: "eu quero poder excluir também isso aqui", no menu ⋮).
--
-- "Excluir" TIRA o evento da lista e do link público, mas NÃO apaga linha: pedidos, ingressos,
-- estornos e o caixa do evento continuam existindo (o contador, o extrato do Asaas e quem comprou
-- dependem deles). Só vale pra evento fora de venda — `ativo`/`adiado` ainda têm gente com
-- ingresso válido; esses se cancelam antes. Desfazer é zerar a coluna (fica na auditoria quem fez).
ALTER TABLE events ADD COLUMN IF NOT EXISTS excluido_em  timestamptz;
ALTER TABLE events ADD COLUMN IF NOT EXISTS excluido_por uuid;
