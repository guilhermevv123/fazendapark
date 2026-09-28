/**
 * A trava de produção do seed (PROD-02, 27/09).
 *
 * `scripts/seed.mjs` apaga a organização `fazenda-park` e grava `dono@` e
 * `portaria@` com a senha `diamond123`, que está num repositório público. Ele
 * tem que recusar ANTES de conectar quando o alvo não é esta máquina ou quando
 * o ambiente é de produção.
 *
 * Roda o script de verdade, num processo filho, com um ambiente mínimo montado
 * aqui — sem `SEED_TESTE` (que trocaria o banco pelo do `.env.test`) e com um
 * banco que NÃO existe no caso que passa pela trava: nenhum caso deste arquivo
 * chega a escrever em banco nenhum.
 *
 * O código de saída 9 é da trava; qualquer outro é o script tentando conectar.
 * É isso que separa "recusou" de "tentou e caiu" — sem a trava, os casos de
 * produção também terminam com erro, só que DEPOIS de abrir a conexão.
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SEED = fileURLToPath(new URL('./seed.mjs', import.meta.url))
const BANCO_LOCAL_QUE_NAO_EXISTE = 'postgresql://ninguem@localhost:5432/zz_seed_trava_nao_existe'

function rodar(env: Record<string, string>) {
  const r = spawnSync(process.execPath, [SEED], {
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
    encoding: 'utf8',
    timeout: 60_000,
  })
  return { codigo: r.status, saida: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

describe('seed · a trava de produção', () => {
  it('NODE_ENV=production recusa antes de conectar, mesmo com banco local', () => {
    const r = rodar({ NODE_ENV: 'production', DATABASE_URL: BANCO_LOCAL_QUE_NAO_EXISTE })
    expect(r.codigo, `o seed tentou rodar em produção:\n${r.saida}`).toBe(9)
    expect(r.saida).toMatch(/recuso rodar.*NODE_ENV=production/)
    expect(r.saida).toMatch(/diamond123/)
  })

  it('banco fora desta máquina recusa, e diz qual', () => {
    const r = rodar({ DATABASE_URL: 'postgresql://postgres:x@bilheteria_postgres:5432/bilheteria' })
    expect(r.codigo, `o seed tentou apagar e semear um banco remoto:\n${r.saida}`).toBe(9)
    expect(r.saida).toContain('bilheteria_postgres')
  })

  it('o servidor escolhido por ?host= também conta', () => {
    const r = rodar({ DATABASE_URL: 'postgresql:///bilheteria?host=db.exemplo.com.br' })
    expect(r.codigo).toBe(9)
    expect(r.saida).toContain('db.exemplo.com.br')
  })

  it('banco local passa pela trava (e aqui cai só porque o banco não existe)', () => {
    const r = rodar({ DATABASE_URL: BANCO_LOCAL_QUE_NAO_EXISTE })
    expect(r.saida, 'a trava recusou o banco local que a suíte e o E2E usam').not.toMatch(/recuso rodar/)
    expect(r.codigo).not.toBe(9)
    expect(r.codigo).not.toBe(0)
  })
})
