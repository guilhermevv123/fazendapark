/**
 * migrar.mjs — aplica as migrações de `db/` que ainda não rodaram neste banco.
 *
 * Roda ANTES do servidor no container (ver Dockerfile) e também à mão:
 * `npm run db:push`. Até aqui as migrações eram aplicadas uma a uma com
 * `psql -f`, e o script citado no package.json nem existia — em produção isso
 * vira "esqueci a 028" e a tela quebra no primeiro SELECT da coluna nova.
 *
 * Regras:
 *   · cada arquivo roda UMA vez; o nome vai pra `schema_migrations` depois que
 *     ele termina sem erro. Falhou → para tudo e o container não sobe (melhor
 *     que um servidor no ar com metade do esquema);
 *   · o arquivo roda inteiro como veio: alguns já têm BEGIN/COMMIT próprios,
 *     então aqui não se abre transação por fora;
 *   · banco que JÁ tem o esquema (restaurado de um dump, ou montado à mão com
 *     psql antes deste script existir) e ainda não tem a tabela de controle:
 *     os arquivos existentes são marcados como aplicados sem rodar de novo.
 *     Nem todas as migrações antigas são idempotentes, e rodar a 001 por cima
 *     de um banco vivo derrubaria dados;
 *   · trava consultiva: duas réplicas subindo juntas não aplicam a mesma
 *     migração duas vezes.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const PASTA = fileURLToPath(new URL('../db/', import.meta.url))
const TRAVA = 727_001 // número fixo e qualquer: identifica a trava deste script

if (!process.env.DATABASE_URL) {
  console.error('[migrar] DATABASE_URL não definido')
  process.exit(1)
}

const arquivos = readdirSync(PASTA).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort()
const c = new pg.Client({ connectionString: process.env.DATABASE_URL })
await c.connect()
try {
  await c.query('SELECT pg_advisory_lock($1)', [TRAVA])

  const { rows: [controle] } = await c.query(`SELECT to_regclass('public.schema_migrations') AS t`)
  if (!controle.t) {
    await c.query(`CREATE TABLE schema_migrations (
      arquivo text PRIMARY KEY, aplicada_em timestamptz NOT NULL DEFAULT now())`)
    const { rows: [velho] } = await c.query(`SELECT to_regclass('public.events') AS t`)
    if (velho.t) {
      for (const f of arquivos) {
        await c.query('INSERT INTO schema_migrations (arquivo) VALUES ($1) ON CONFLICT DO NOTHING', [f])
      }
      console.log(`[migrar] banco já tinha o esquema: ${arquivos.length} migrações marcadas como aplicadas`)
    }
  }

  const { rows } = await c.query('SELECT arquivo FROM schema_migrations')
  const feitas = new Set(rows.map((r) => r.arquivo))
  const faltam = arquivos.filter((f) => !feitas.has(f))
  for (const f of faltam) {
    console.log(`[migrar] aplicando ${f}`)
    await c.query(readFileSync(PASTA + f, 'utf8'))
    await c.query('INSERT INTO schema_migrations (arquivo) VALUES ($1)', [f])
  }
  console.log(faltam.length ? `[migrar] ${faltam.length} aplicada(s)` : '[migrar] nada pendente')

  // Carga inicial (opcional): a organização e o primeiro acesso de um banco
  // novo em produção, sem abrir a porta do Postgres pra internet. O SQL vem em
  // base64 numa variável do painel de deploy (nunca no repositório) e só roda
  // com o banco SEM organização nenhuma — reiniciar o container depois não
  // duplica nada. Aplicou → apague a variável.
  if (process.env.CARGA_INICIAL_SQL_B64) {
    const { rows: [n] } = await c.query('SELECT count(*)::int AS n FROM organizations')
    if (n.n > 0) {
      console.log('[migrar] carga inicial ignorada: o banco já tem organização (pode apagar a variável)')
    } else {
      const sql = Buffer.from(process.env.CARGA_INICIAL_SQL_B64, 'base64').toString('utf8')
      await c.query('BEGIN')
      try {
        await c.query(sql)
        await c.query('COMMIT')
      } catch (e) {
        await c.query('ROLLBACK')
        throw e
      }
      console.log('[migrar] carga inicial aplicada')
    }
  }
} catch (e) {
  console.error('[migrar] falhou:', e.message)
  process.exitCode = 1
} finally {
  await c.query('SELECT pg_advisory_unlock($1)', [TRAVA]).catch(() => {})
  await c.end()
}
