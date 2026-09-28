-- Fixture da bateria E2E: dois eventos JÁ ENCERRADOS com dinheiro de verdade dentro — venda no site
-- e no balcão, saque concluído, saques pendentes e um estorno DEPOIS do saque (saldo devedor) — e
-- quem comprou: clientes com CPF, com telefone de celular (11 dígitos) e de fixo (10), um sem
-- documento nem telefone que preste, e um que só tentou (pedido expirado), com os ingressos emitidos
-- e lidos na entrada. Rodando um arquivo sozinho, a tela de Clientes tinha zero pessoas: os casos da
-- ficha, da paginação e da exportação só passavam quando a compra.e2e.ts rodava antes.
--
-- Por que existe: o seed só cria o evento de exemplo, à venda e sem nenhum pedido. Sem isto, os
-- casos de Eventos (filtro "Encerrados", selo ENCERRADO, busca), de Relatórios (filtro por evento)
-- e do Financeiro (saque, saldo negativo) não têm o que mostrar — e passavam só na máquina de quem
-- tinha criado esses dados à mão (a frota F2, 28/09).
--
-- As datas são RELATIVAS ao dia em que o banco nasce: o último sábado que passou e o domingo do fim
-- de semana anterior a ele. O período padrão dos painéis é "30 dias", e com data fixa a bateria de
-- daqui a um mês compararia a tela com a API em cima de zeros — passaria sem provar nada.
--
-- Aplicado por scripts/e2e-banco.mjs logo depois do seed, e SÓ em banco *_e2e (a trava do script).
-- Nunca rodar no banco real: é dado inventado.
DO $$
DECLARE
  org uuid := (SELECT id FROM organizations WHERE slug = 'fazenda-park');
  dono uuid := (SELECT id FROM users WHERE email = 'dono@fazendapark.com.br');
  ev_a uuid; ev_b uuid; setor uuid; lote uuid; setor_b uuid; lote_b uuid;
  ana uuid; bruno uuid; carla uuid; diego uuid;
  -- o último sábado ANTES de hoje (hoje sábado → o da semana passada) e o domingo 6 dias antes dele;
  -- as horas vão com `AT TIME ZONE 'America/Bahia'` (a sessão do script pode estar em UTC; o parque não)
  hoje_iso int := extract(isodow from current_date)::int;
  sabado date := current_date - COALESCE(NULLIF((hoje_iso - 6 + 7) % 7, 0), 7);
  domingo date := sabado - 6;
BEGIN
  IF EXISTS (SELECT 1 FROM events WHERE slug = 'demo-e2e-domingo') THEN RETURN; END IF;
  INSERT INTO events (org_id, name, slug, starts_at, ends_at, fee_bps, status)
  VALUES (org, 'DEMO E2E · Domingo', 'demo-e2e-domingo',
          (domingo + time '09:00') AT TIME ZONE 'America/Bahia', (domingo + time '18:00') AT TIME ZONE 'America/Bahia',
          1000, 'encerrado')
  RETURNING id INTO ev_a;
  INSERT INTO events (org_id, name, slug, starts_at, ends_at, fee_bps, status)
  VALUES (org, 'DEMO E2E · Sábado', 'demo-e2e-sabado',
          (sabado + time '09:00') AT TIME ZONE 'America/Bahia', (sabado + time '18:00') AT TIME ZONE 'America/Bahia',
          1000, 'encerrado')
  RETURNING id INTO ev_b;

  -- quem comprou (e-mail no domínio reservado pra exemplo; CPF de teste com dígito certo)
  INSERT INTO customers (org_id, name, email, document, phone, birth_date, city, state, instagram, marketing_opt_in, registered_at)
  VALUES (org, 'Ana Demo E2E', 'ana.demo.e2e@example.com', '10000000108', '73988887777', '1990-05-10', 'Ubatã', 'BA', '@ana.demo.e2e', true, now() - interval '20 days')
  RETURNING id INTO ana;
  INSERT INTO customers (org_id, name, email, document, phone, birth_date, city, state, registered_at)
  VALUES (org, 'Bruno Demo E2E', 'bruno.demo.e2e@example.com', '10000000280', '7332221111', (current_date - interval '17 years')::date, 'Itabuna', 'BA', now() - interval '19 days')
  RETURNING id INTO bruno;
  -- sem documento e com telefone torto: a ficha não pode inventar CPF nem link de WhatsApp
  INSERT INTO customers (org_id, name, email, phone)
  VALUES (org, 'Carla Demo E2E', 'carla.demo.e2e@example.com', '123')
  RETURNING id INTO carla;
  INSERT INTO customers (org_id, name, email, document, phone, birth_date, city, state, registered_at)
  VALUES (org, 'Diego Demo E2E', 'diego.demo.e2e@example.com', '10000000442', '71999990000', '1975-11-30', 'Salvador', 'BA', now() - interval '6 days')
  RETURNING id INTO diego;

  INSERT INTO sectors (event_id, name) VALUES (ev_a, 'Geral') RETURNING id INTO setor;
  INSERT INTO lots (sector_id, name, price_cents, quantity, channels) VALUES (setor, 'Único', 10000, 500, '{online,bilheteria}') RETURNING id INTO lote;

  -- evento A: 3 vendas no site nos dias de antes + 2 no balcão no dia (dinheiro, sem gateway)
  INSERT INTO orders (org_id, event_id, code, status, channel, face_cents, fee_cents, platform_cents, discount_cents, total_cents, refunded_cents, asaas_payment_id, paid_at, payment_method)
  VALUES
    (org, ev_a, 'DEMOE2E-A1', 'pago', 'online', 18182, 1818, 2000, 0, 20000, 0, 'pay_demo_e2e_a1', (domingo - 3 + time '10:00') AT TIME ZONE 'America/Bahia', 'pix'),
    (org, ev_a, 'DEMOE2E-A2', 'pago', 'online', 13636, 1364, 1500, 0, 15000, 0, 'pay_demo_e2e_a2', (domingo - 2 + time '15:30') AT TIME ZONE 'America/Bahia', 'credito'),
    -- 21:40 no parque já é o dia seguinte em UTC: o caso do fuso (a venda da noite não pula de dia)
    (org, ev_a, 'DEMOE2E-A3', 'pago', 'online', 27273, 2727, 3000, 0, 30000, 0, 'pay_demo_e2e_a3', (domingo - 1 + time '21:40') AT TIME ZONE 'America/Bahia', 'pix'),
    (org, ev_a, 'DEMOE2E-A4', 'pago', 'bilheteria', 8000, 0, 800, 0, 8000, 0, NULL, (domingo + time '10:15') AT TIME ZONE 'America/Bahia', 'dinheiro'),
    (org, ev_a, 'DEMOE2E-A5', 'pago', 'bilheteria', 5000, 0, 500, 0, 5000, 0, NULL, (domingo + time '13:05') AT TIME ZONE 'America/Bahia', 'dinheiro');
  INSERT INTO order_items (order_id, lot_id, quantity, unit_face_cents, unit_fee_cents, unit_total_cents)
  SELECT o.id, lote, GREATEST(1, o.total_cents / 10000), o.face_cents / GREATEST(1, o.total_cents / 10000),
         o.fee_cents / GREATEST(1, o.total_cents / 10000), o.total_cents / GREATEST(1, o.total_cents / 10000)
    FROM orders o WHERE o.code LIKE 'DEMOE2E-A%';
  -- a Ana comprou duas vezes (é quem mais comprou), o Bruno uma; o balcão vende sem cadastro
  UPDATE orders SET customer_id = ana WHERE code IN ('DEMOE2E-A1', 'DEMOE2E-A3');
  UPDATE orders SET customer_id = bruno WHERE code = 'DEMOE2E-A2';
  -- a Carla só tentou: o PIX venceu sem pagar (entra em "Só tentaram", fora de toda soma)
  INSERT INTO orders (org_id, event_id, customer_id, code, status, channel, face_cents, fee_cents, platform_cents, discount_cents, total_cents, refunded_cents, created_at, expires_at, payment_method)
  VALUES (org, ev_a, carla, 'DEMOE2E-A6', 'expirado', 'online', 9091, 909, 1000, 0, 10000, 0,
          (domingo - 4 + time '19:00') AT TIME ZONE 'America/Bahia', (domingo - 4 + time '19:30') AT TIME ZONE 'America/Bahia', 'pix');
  INSERT INTO order_items (order_id, lot_id, quantity, unit_face_cents, unit_fee_cents, unit_total_cents)
  SELECT o.id, lote, 1, 9091, 909, 10000 FROM orders o WHERE o.code = 'DEMOE2E-A6';

  -- evento B: uma venda, transferida inteira, e DEPOIS um estorno parcial → conta negativa
  INSERT INTO orders (org_id, event_id, code, status, channel, face_cents, fee_cents, platform_cents, discount_cents, total_cents, refunded_cents, asaas_payment_id, paid_at, payment_method)
  VALUES (org, ev_b, 'DEMOE2E-B1', 'estornado_parcial', 'online', 27273, 2727, 3000, 0, 30000, 4000, 'pay_demo_e2e_b1', (sabado - 2 + time '11:00') AT TIME ZONE 'America/Bahia', 'pix');
  -- o item do B no lote DO B (não no do A): relatório por evento soma pelo lote → setor → evento
  INSERT INTO sectors (event_id, name) VALUES (ev_b, 'Geral') RETURNING id INTO setor_b;
  INSERT INTO lots (sector_id, name, price_cents, quantity, channels) VALUES (setor_b, 'Único', 10000, 500, '{online,bilheteria}') RETURNING id INTO lote_b;
  INSERT INTO order_items (order_id, lot_id, quantity, unit_face_cents, unit_fee_cents, unit_total_cents)
  SELECT o.id, lote_b, 3, 9091, 909, 10000 FROM orders o WHERE o.code = 'DEMOE2E-B1';
  UPDATE orders SET customer_id = diego WHERE code = 'DEMOE2E-B1';

  -- os ingressos dos pedidos pagos, um por unidade: no Domingo todos lidos na entrada; no Sábado,
  -- dois lidos e o terceiro cancelado (é o do estorno parcial)
  INSERT INTO tickets (org_id, event_id, order_id, order_item_id, sector_id, lot_id, code, qr_secret, status, holder_name, issued_at, checked_in_at)
  SELECT o.org_id, o.event_id, o.id, oi.id, l.sector_id, l.id,
         'DEMOE2E-T-' || o.code || '-' || n, md5(o.code || '-' || n || '-demo-e2e'),
         CASE WHEN o.code = 'DEMOE2E-B1' AND n = 3 THEN 'cancelado' ELSE 'usado' END,
         cu.name, o.paid_at,
         CASE WHEN o.code = 'DEMOE2E-B1' AND n = 3 THEN NULL ELSE e.starts_at + (n * interval '7 minutes') END
    FROM orders o
    JOIN order_items oi ON oi.order_id = o.id
    JOIN lots l ON l.id = oi.lot_id
    JOIN events e ON e.id = o.event_id
    LEFT JOIN customers cu ON cu.id = o.customer_id
    CROSS JOIN LATERAL generate_series(1, oi.quantity) AS n
   WHERE o.code LIKE 'DEMOE2E-%' AND o.paid_at IS NOT NULL;

  INSERT INTO payouts (org_id, event_id, code, beneficiary_name, destination_kind, destination, amount_cents, status, requested_by, requested_at, processed_at)
  VALUES
    (org, ev_a, 'DEMOE2E-P1', 'Fazenda Park (conta PIX)', 'pix', 'chave-pix-demo', 30000, 'concluida', dono,
     (domingo + 1 + time '09:00') AT TIME ZONE 'America/Bahia', (domingo + 1 + time '09:05') AT TIME ZONE 'America/Bahia'),
    (org, ev_a, 'DEMOE2E-P2', 'Fazenda Park (conta PIX)', 'pix', 'chave-pix-demo', 10000, 'solicitada', dono,
     (current_date - 2 + time '16:00') AT TIME ZONE 'America/Bahia', NULL),
    (org, ev_a, 'DEMOE2E-P3', 'Fornecedor de gelo', 'conta', 'Banco 000 · ag 0000 · cc 00000-0 (demonstração)', 8000, 'solicitada', dono,
     (current_date - 1 + time '11:20') AT TIME ZONE 'America/Bahia', NULL),
    (org, ev_b, 'DEMOE2E-P4', 'Fazenda Park (conta PIX)', 'pix', 'chave-pix-demo', 27000, 'concluida', dono,
     (sabado + 1 + time '09:00') AT TIME ZONE 'America/Bahia', (sabado + 1 + time '09:02') AT TIME ZONE 'America/Bahia');
END $$;
