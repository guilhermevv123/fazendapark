/**
 * seed.mjs — popula o banco com os dados REAIS do Conquista Park, do jeito que
 * estão no painel da Zig hoje (lidos em 20/09/2026). Serve pra ver o sistema
 * cheio, não com "Evento Teste 1".
 *
 *   npm run seed            → recria do zero
 */
import pg from 'pg'
import { readFileSync } from 'node:fs'

for (const linha of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const m = linha.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
}

const c = new pg.Client({ connectionString: process.env.DATABASE_URL })
await c.connect()

const bcrypt = await import('bcryptjs')
const senha = bcrypt.default.hashSync('diamond123', 10)

await c.query('BEGIN')
try {
  await c.query(`DELETE FROM organizations WHERE slug IN ('fazenda-park','big-lobo')`)

  const org = (await c.query(
    `INSERT INTO organizations (name, slug, document, asaas_env)
     VALUES ('Fazenda Park Nova Conquista','fazenda-park','00000000000191','sandbox')
     RETURNING id`)).rows[0]

  await c.query(
    `INSERT INTO users (org_id, email, name, password_hash, role)
     VALUES ($1,'dono@fazendapark.com.br','Dono',$2,'master'),
            ($1,'portaria@fazendapark.com.br','Portaria',$2,'portaria')`,
    [org.id, senha])

  // --- evento: a 4ª edição, com data futura pra ficar vendável -------------
  const daquiADias = (d) => `now() + interval '${d} days'`
  const ev = (await c.query(
    `INSERT INTO events (org_id, name, slug, description, status,
       starts_at, ends_at, sales_end_at, timezone, age_rating, ticket_noun,
       venue_name, city, state, address, neighborhood,
       category, subcategories, fee_bps, fee_mode_online, fee_mode_pos,
       max_per_customer, hold_minutes, support_kind, support_value)
     VALUES ($1,'CONQUISTA PARK 4ª EDIÇÃO','conquista-park-4-edicao',
       'Vem aí uma nova experiência no Conquista Park! Atrações, diversão e momentos inesquecíveis para toda a família.',
       'ativo', ${daquiADias(21)}, ${daquiADias(22)}, ${daquiADias(22)},
       'America/Bahia', 14, 'Ingressos',
       'Fazenda Park Nova Conquista','Ubatã','BA','Zona Rural, 00','Conquista Park',
       'Parques, Passeios e Tours', ARRAY['Infantil','Gastronomia'],
       1000, 'repassar', 'absorver', 20, 20, 'telefone','(73) 99826-0963')
     RETURNING id`, [org.id])).rows[0]

  const sessaoSab = (await c.query(
    `INSERT INTO event_sessions (event_id, starts_at, ends_at, title, sort_order)
     VALUES ($1, ${daquiADias(21)}, ${daquiADias(21)} + interval '8 hours', 'Sábado', 1)
     RETURNING id`, [ev.id])).rows[0]
  const sessaoDom = (await c.query(
    `INSERT INTO event_sessions (event_id, starts_at, ends_at, title, sort_order)
     VALUES ($1, ${daquiADias(22)}, ${daquiADias(22)} + interval '8 hours', 'Domingo', 2)
     RETURNING id`, [ev.id])).rows[0]

  const setor = async (nome, kind, sessionId, ordem) => (await c.query(
    `INSERT INTO sectors (event_id, session_id, name, kind, sort_order)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [ev.id, sessionId, nome, kind, ordem])).rows[0].id

  const lote = async (sectorId, nome, precoCents, qtd, ordem) => (await c.query(
    `INSERT INTO lots (sector_id, name, price_cents, quantity, min_per_order,
                       max_per_order, channels, visible, sort_order)
     VALUES ($1,$2,$3,$4,1,10,ARRAY['online','bilheteria'],true,$5) RETURNING id`,
    [sectorId, nome, precoCents, qtd, ordem])).rows[0].id

  // Preços iguais aos que estão no ar hoje.
  const sSab = await setor('ENTRADA INDIVIDUAL SÁBADO', 'ingresso', sessaoSab.id, 1)
  const sDom = await setor('ENTRADA INDIVIDUAL DOMINGO', 'ingresso', sessaoDom.id, 2)
  const cSab = await setor('COMBO SÁBADO', 'passaporte', sessaoSab.id, 3)
  const cDom = await setor('COMBO DOMINGO', 'passaporte', sessaoDom.id, 4)

  const lSab = await lote(sSab, 'ENTRADA', 3000, 5000, 1)
  // 2727 é o número que o produtor calculou na mão lá (30 ÷ 1,10) pra o
  // comprador pagar R$ 30 redondo. Aqui a tela faz essa conta sozinha.
  const lDom = await lote(sDom, 'ENTRADA', 2727, 5000, 1)
  await lote(cSab, 'COMBO 10 PESSOAS', 16000, 5000, 1)
  await lote(cDom, 'COMBO 10 PESSOAS', 25000, 5000, 1)

  // meia-entrada como tipo, que é como a regra realmente funciona
  for (const l of [lSab, lDom]) {
    await c.query(
      `INSERT INTO ticket_types (lot_id, name, quantity, discount_bps, requires_document, sort_order)
       VALUES ($1,'Inteira',4000,0,false,1),
              ($1,'Meia-entrada',1000,5000,true,2)`, [l])
  }

  await c.query(
    `INSERT INTO promo_codes (event_id, code, kind, value, max_uses, active)
     VALUES ($1,'VIZINHO','percentual',1500,200,true),
            ($1,'IMPRENSA','percentual',10000,20,true)`, [ev.id])

  await c.query(
    `INSERT INTO promoters (event_id, name, code, commission_bps, active)
     VALUES ($1,'Equipe Ubatã','UBATA',500,true),
            ($1,'Equipe Ibirataia','IBIRA',500,true)`, [ev.id])

  await c.query('COMMIT')
  console.log(`
  Banco populado.

    organização  Fazenda Park Nova Conquista
    evento       CONQUISTA PARK 4ª EDIÇÃO  (ativo, começa em 21 dias)
    slug         conquista-park-4-edicao
    setores      2 de entrada + 2 de combo
    preços       sábado R$ 30,00 de face  → comprador paga R$ 33,00
                 domingo R$ 27,27 de face → comprador paga R$ 30,00 redondo
    cupons       VIZINHO (15%)  ·  IMPRENSA (100%)
    login        dono@fazendapark.com.br / diamond123

    página pública  http://localhost:3000/e/conquista-park-4-edicao
    painel          http://localhost:3000/admin
  `)
} catch (e) {
  await c.query('ROLLBACK')
  console.error('falhou:', e.message)
  process.exitCode = 1
} finally {
  await c.end()
}
