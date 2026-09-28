/**
 * e2e-banco.mjs — recria DO ZERO o banco da bateria E2E (Playwright).
 *
 * Por que do zero: a descoberta de 22/09 foi que dois testes só passavam porque o banco já tinha
 * pedido pago de rodada anterior. Banco que nasce vazio a cada bateria é o único jeito de o teste
 * provar o que diz — e o E2E cria, compra, cancela e estorna à vontade.
 *
 * Trava dura: só mexe em banco cujo nome termina em `_e2e` (ou `_e2e_<sufixo>`). `DROP DATABASE`
 * apontado pro real por engano não tem volta; aqui ele nem começa.
 *
 * O que sobra no fim: o esquema inteiro (db/*.sql em ordem), o seed de TESTE (organização, evento
 * de exemplo, dono e portaria) e mais dois logins que o seed não cria — financeiro e operação —
 * pra bateria exercitar os quatro papéis. Senha de todos: E2E_SENHA (padrão a do seed). Por fim,
 * os dados de e2e/dados/*.sql (eventos encerrados com venda, saque e estorno).
 *
 *   npm run e2e:banco
 */
import { readFileSync, readdirSync } from 'node:fs'
import pg from 'pg'

// `--env <arquivo>` e `--porta <n>`: mais de uma instância de E2E ao mesmo tempo (cada frota com o
// seu banco `*_e2e_<nome>` e a sua porta), sem uma recompilar ou apagar o banco da outra.
const args = process.argv.slice(2)
const opcao = (nome) => { const i = args.indexOf(`--${nome}`); return i >= 0 ? args[i + 1] : undefined }
if (opcao('env')) process.env.E2E_ENV_ARQUIVO = opcao('env')
if (opcao('porta')) process.env.E2E_PORTA = opcao('porta')

function carregar(arquivo, sobrescrever) {
  try {
    for (const linha of readFileSync(new URL(`../${arquivo}`, import.meta.url), 'utf8').split('\n')) {
      const m = linha.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
      if (m && (sobrescrever || !process.env[m[1]])) process.env[m[1]] = m[2]
    }
  } catch { /* sem arquivo: a trava abaixo acusa */ }
}
carregar('.env', false)
carregar(process.env.E2E_ENV_ARQUIVO ?? '.env.e2e', true)

const url = new URL(String(process.env.DATABASE_URL ?? ''))
const banco = url.pathname.replace(/^\//, '')
if (!/_e2e(_[a-z0-9]+)?$/.test(banco)) {
  console.error(`e2e-banco: recuso recriar "${banco}" — só banco com nome *_e2e (confira o .env.e2e)`)
  process.exit(9)
}

// 1. derruba e recria (conectado no banco `postgres` do mesmo servidor)
const admin = new URL(url); admin.pathname = '/postgres'
const a = new pg.Client({ connectionString: admin.toString() })
await a.connect()
await a.query(`DROP DATABASE IF EXISTS "${banco}" WITH (FORCE)`)
await a.query(`CREATE DATABASE "${banco}"`)
await a.end()

// 2. o esquema, arquivo por arquivo e em ordem — o mesmo que scripts/migrar.mjs aplica
const c = new pg.Client({ connectionString: url.toString() })
await c.connect()
const arquivos = readdirSync(new URL('../db/', import.meta.url)).filter((f) => /^\d+.*\.sql$/.test(f)).sort()
for (const f of arquivos) {
  try {
    await c.query(readFileSync(new URL(`../db/${f}`, import.meta.url), 'utf8'))
  } catch (e) {
    console.error(`e2e-banco: ${f} falhou: ${e.message}`)
    process.exit(1)
  }
}
await c.end()
console.log(`e2e-banco: ${banco} recriado com ${arquivos.length} migrações`)

// 3. o seed de teste (lê DATABASE_URL do ambiente, que já é o do e2e)
await import('./seed.mjs')

// 4. financeiro e operação, que o seed não cria
const bcrypt = (await import('bcryptjs')).default
const senha = process.env.E2E_SENHA ?? 'diamond123'
const hash = bcrypt.hashSync(senha, 10)
const d = new pg.Client({ connectionString: url.toString() })
await d.connect()
const { rows: [org] } = await d.query(`SELECT id FROM organizations ORDER BY created_at LIMIT 1`)
await d.query(
  `INSERT INTO users (org_id, email, name, password_hash, role, papel) VALUES
     ($1, 'financeiro@fazendapark.com.br', 'Financeiro E2E', $2, 'admin', 'financeiro'),
     ($1, 'operacao@fazendapark.com.br',   'Operação E2E',   $2, 'operacional', 'operacao')
   ON CONFLICT (org_id, email) DO NOTHING`, [org.id, hash])
if (process.env.E2E_SENHA) {
  // o seed grava a senha dele; a bateria precisa que os quatro entrem com a MESMA
  await d.query(`UPDATE users SET password_hash = $1 WHERE org_id = $2`, [hash, org.id])
}
console.log('e2e-banco: logins master, financeiro, operacao e portaria prontos')

// 5. os dados de que os casos dependem e o seed não tem (e2e/dados/*.sql, em ordem): eventos
// encerrados com venda, saque e estorno. Sem eles, o caso passava só no banco de quem os criou à mão.
const pastaDados = new URL('../e2e/dados/', import.meta.url)
const fixtures = readdirSync(pastaDados).filter((f) => f.endsWith('.sql')).sort()
for (const f of fixtures) {
  try {
    await d.query(readFileSync(new URL(f, pastaDados), 'utf8'))
  } catch (e) {
    console.error(`e2e-banco: e2e/dados/${f} falhou: ${e.message}`)
    process.exit(1)
  }
}
await d.end()
console.log(`e2e-banco: ${fixtures.length} arquivo(s) de dados da bateria aplicados`)
