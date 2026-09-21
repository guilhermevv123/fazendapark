/**
 * db.ts — pool único de Postgres + helper de transação.
 *
 * `tx()` existe porque a parte mais cara do sistema (reservar estoque) só é
 * correta dentro de UMA transação com lock. Espalhar BEGIN/COMMIT manual pelo
 * código é como se perde o COMMIT num caminho de erro.
 */
import pg from 'pg'

// O driver devolve BIGINT como string pra não perder precisão em número acima
// de 2^53. Nossos valores são centavos e cabem com folga em Number, então
// convertemos de volta — mas explicitamente, num lugar só.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v))
// NUMERIC continua string de propósito: se aparecer um, é bug de schema.

let pool: pg.Pool | null = null

export function db(): pg.Pool {
  if (pool) return pool
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) throw new Error('DATABASE_URL não configurada')
  pool = new pg.Pool({
    connectionString,
    max: Number(process.env.PG_POOL_MAX || 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ssl: connectionString.includes('localhost') ? undefined : { rejectUnauthorized: false },
  })
  pool.on('error', (e) => console.error('[db] erro no cliente ocioso:', e.message))
  return pool
}

export async function q<T = any>(text: string, params: any[] = []): Promise<T[]> {
  const r = await db().query(text, params)
  return r.rows as T[]
}

export async function q1<T = any>(text: string, params: any[] = []): Promise<T | null> {
  const rows = await q<T>(text, params)
  return rows[0] ?? null
}

/**
 * Roda `fn` dentro de uma transação. Erro derruba tudo; sucesso confirma.
 * Nunca chame commit/rollback por fora disso.
 */
export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await db().connect()
  try {
    await c.query('BEGIN')
    const out = await fn(c)
    await c.query('COMMIT')
    return out
  } catch (e) {
    try { await c.query('ROLLBACK') } catch { /* conexão já morreu */ }
    throw e
  } finally {
    c.release()
  }
}
