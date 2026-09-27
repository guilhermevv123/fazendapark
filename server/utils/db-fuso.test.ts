/**
 * O fuso da sessão do banco é o do parque em QUALQUER servidor (auditoria 27/09, REL-01/FIN-01).
 *
 * O Postgres desta máquina já nasce em America/Bahia, então conferir `SHOW timezone` pelo pool
 * normal seria teste oco: passa com ou sem a correção. Aqui a prova é outra — uma conexão NOVA
 * pedindo UTC como padrão (o que o Postgres do EasyPanel faz) e, por cima, as mesmas opções que o
 * pool usa. Se `opcoesDaConexao()` sumir do pool, o caso do meio fica vermelho.
 */
import pg from 'pg'
import { describe, expect, it } from 'vitest'
import { db, opcoesDaConexao } from './db'

describe('fuso da sessão do banco', () => {
  it('as opções levam o fuso do parque e recusam valor estranho', () => {
    expect(opcoesDaConexao()).toBe('-c TimeZone=America/Bahia')
    expect(opcoesDaConexao('UTC')).toBe('-c TimeZone=UTC')
    expect(() => opcoesDaConexao('Bahia; DROP TABLE x')).toThrow(/inválido/)
  })

  it('servidor que nasce em UTC: com as opções do pool a sessão vira America/Bahia e corta o dia certo', async () => {
    // a conexão pede UTC primeiro (como o padrão da imagem oficial do Postgres do EasyPanel) e as
    // opções do pool vêm depois — a última ganha, igual a um servidor em UTC recebendo o pool
    const c = new pg.Client({ connectionString: process.env.DATABASE_URL, options: `-c TimeZone=UTC ${opcoesDaConexao()}` })
    await c.connect()
    try {
      const { rows: [r] } = await c.query(
        `SELECT current_setting('TimeZone') AS fuso,
                ('2026-09-27 23:30:00+00'::timestamptz)::date::text AS dia`)
      expect(r.fuso).toBe('America/Bahia')
      // 23h30 UTC do dia 27 são 20h30 na Bahia: continua sendo dia 27, não 28
      expect(r.dia).toBe('2026-09-27')
    } finally { await c.end() }
  })

  it('o pool de verdade sai com o fuso do parque', async () => {
    const { rows: [r] } = await db().query(`SELECT current_setting('TimeZone') AS fuso`)
    expect(r.fuso).toBe('America/Bahia')
    expect((db() as any).options?.options).toBe(opcoesDaConexao())
  })
})
