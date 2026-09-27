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

/**
 * O fuso de TODA sessão do banco. Relatório, financeiro e dashboard cortam dia e mês no SQL
 * (`date_trunc('day', paid_at)`, `::date`), e esse corte usa o fuso da SESSÃO, não o do Node.
 * O Postgres desta máquina nasce em America/Bahia; o do EasyPanel (imagem oficial) nasce em UTC —
 * lá a venda das 21h caía no dia seguinte e cada barra saía com o rótulo trocado, enquanto aqui
 * tudo passava (auditoria de 27/09, REL-01/FIN-01). Fixar na conexão vale nos dois lugares.
 */
export const FUSO_DO_BANCO = process.env.FUSO_BANCO || 'America/Bahia'

export function opcoesDaConexao(fuso = FUSO_DO_BANCO): string {
  if (!/^[A-Za-z_]+(\/[A-Za-z_]+)*$/.test(fuso)) throw new Error(`FUSO_BANCO inválido: ${fuso}`)
  return `-c TimeZone=${fuso}`
}

export function db(): pg.Pool {
  if (pool) return pool
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) throw new Error('DATABASE_URL não configurada')
  pool = new pg.Pool({
    connectionString,
    options: opcoesDaConexao(),
    max: Number(process.env.PG_POOL_MAX || 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    // Banco local e o Postgres interno do EasyPanel (rede do Docker, sem TLS)
    // conectam sem SSL — esse segundo avisa com `sslmode=disable` na URL; sem
    // isso o pool exigia SSL e o servidor recusava a conexão no primeiro boot.
    ssl: connectionString.includes('localhost') || connectionString.includes('sslmode=disable')
      ? undefined : { rejectUnauthorized: false },
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
