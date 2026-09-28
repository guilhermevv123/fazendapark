-- 030 — os dados da empresa que o site de vendas tem que mostrar
--
-- O site vendia sem razão social, CNPJ, endereço e canal de atendimento, e sem termos, política
-- de privacidade e direito de arrependimento (auditoria PROD-08). O Decreto 7.962/2013 (comércio
-- eletrônico) pede nome empresarial, CPF/CNPJ, endereço físico e eletrônico e um canal de
-- atendimento; o CDC (art. 49) dá 7 dias de arrependimento na compra fora do estabelecimento; e a
-- LGPD pede que o titular saiba QUEM trata os dados dele e como falar com essa pessoa.
--
-- Tudo aqui é ADITIVO e nulo por padrão: nenhum dado é inventado. O master preenche em
-- Configurações; campo vazio aparece como "a preencher" só pra ele, e o site omite a linha. O
-- `document` (CNPJ/CPF) já existia desde o 001 e continua sendo a coluna do documento.
--
-- Nada disto é segredo — é o que vai no rodapé público. A chave do Asaas continua noutra coluna,
-- que nenhuma rota pública lê.

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS legal_name          text,  -- razão social (nome empresarial)
  ADD COLUMN IF NOT EXISTS address_line        text,  -- logradouro, número e complemento
  ADD COLUMN IF NOT EXISTS address_district    text,  -- bairro
  ADD COLUMN IF NOT EXISTS address_city        text,
  ADD COLUMN IF NOT EXISTS address_state       text,  -- UF
  ADD COLUMN IF NOT EXISTS address_zip         text,  -- CEP, só dígitos
  ADD COLUMN IF NOT EXISTS support_email       text,  -- atendimento ao comprador
  ADD COLUMN IF NOT EXISTS support_phone       text,  -- atendimento ao comprador (só dígitos, com DDD)
  ADD COLUMN IF NOT EXISTS privacy_contact     text;  -- encarregado de dados (LGPD); vazio = o atendimento acima

-- UF em maiúsculas e duas letras, CEP com oito dígitos, telefone com DDD: o rodapé público mostra
-- exatamente o que está aqui, então o formato é conferido no banco (a rota também confere, com
-- frase; o CHECK é a rede pro INSERT feito à mão).
ALTER TABLE organizations DROP CONSTRAINT IF EXISTS organizations_address_state_uf;
ALTER TABLE organizations ADD CONSTRAINT organizations_address_state_uf
  CHECK (address_state IS NULL OR address_state ~ '^[A-Z]{2}$');

ALTER TABLE organizations DROP CONSTRAINT IF EXISTS organizations_address_zip_cep;
ALTER TABLE organizations ADD CONSTRAINT organizations_address_zip_cep
  CHECK (address_zip IS NULL OR address_zip ~ '^[0-9]{8}$');

ALTER TABLE organizations DROP CONSTRAINT IF EXISTS organizations_support_phone_ddd;
ALTER TABLE organizations ADD CONSTRAINT organizations_support_phone_ddd
  CHECK (support_phone IS NULL OR support_phone ~ '^[0-9]{10,11}$');
