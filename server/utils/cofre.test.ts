/**
 * cofre.test.ts — a chave do Asaas cifrada em repouso (auditoria 28/09).
 *
 * O esquema prometia "cifrada em repouso" desde o primeiro dia e a chave ia em texto puro pro
 * banco. Aqui: a cifra (ida e volta, adulteração, chave errada, rotação), o texto puro de antes
 * continuando a funcionar, a chave aberta indo no cabeçalho do Asaas (e não o cifrado), o
 * ambiente lido de DENTRO da chave cifrada, e o banco — o boot cifra o que está solto, recifra
 * o que está em chave antiga, não mexe no que já está certo, e a saúde acusa o que não abre.
 *
 * Mutações conferidas: `guardarSegredo` devolvendo o texto (sem cifrar) → vermelho em "cifra e
 * abre"; `chamar` mandando `cfg.apiKey` cru → vermelho no cabeçalho; `ambienteDaChave` sem abrir
 * o cofre → vermelho no ambiente; `arrumarCofre` sem conferir o `kid` → vermelho na rotação.
 */
import { randomBytes } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  abrirSegredo, CofreFechado, estaNoCofre, finalDoSegredo, guardarSegredo, kidAtual, kidDoGuardado,
} from './cofre'
import { ambienteDaChave, pagamentoOnline, testarConexao } from './asaas'
import { arrumarCofre, estadoDoCofre } from './cofre-banco'
import { q, q1, tx } from './db'

const K1 = randomBytes(32).toString('base64')
const K2 = randomBytes(32).toString('base64')
const CHAVE_SANDBOX = '$aact_hmlg_000MzkwODA2MWY2OGM3MWRlMDU2NWM3MzJlNzZmNGZhZGY6OmZha2U6OiRhYWNoXzAwMDA='
const CHAVE_PRODUCAO = '$aact_prod_000MzkwODA2MWY2OGM3MWRlMDU2NWM3MzJlNzZmNGZhZGY6OmZha2U6OiRhYWNoXzAwMDA='

const ambienteOriginal = {
  COFRE_CHAVE: process.env.COFRE_CHAVE,
  COFRE_CHAVES_ANTIGAS: process.env.COFRE_CHAVES_ANTIGAS,
  PAGAMENTO_SIMULADO: process.env.PAGAMENTO_SIMULADO,
}
function comCofre(atual: string | undefined, antigas?: string) {
  if (atual === undefined) delete process.env.COFRE_CHAVE
  else process.env.COFRE_CHAVE = atual
  if (antigas === undefined) delete process.env.COFRE_CHAVES_ANTIGAS
  else process.env.COFRE_CHAVES_ANTIGAS = antigas
}
afterEach(() => {
  for (const [k, v] of Object.entries(ambienteOriginal)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  vi.unstubAllGlobals()
})

describe('a cifra', () => {
  it('cofre desligado: grava e lê em texto puro, como antes (o deploy não depende de configurar)', () => {
    comCofre(undefined)
    expect(guardarSegredo(CHAVE_SANDBOX)).toBe(CHAVE_SANDBOX)
    expect(abrirSegredo(CHAVE_SANDBOX)).toBe(CHAVE_SANDBOX)
    expect(guardarSegredo(null)).toBeNull()
    expect(guardarSegredo('')).toBeNull()
    expect(abrirSegredo(null)).toBeNull()
  })

  it('cifra e abre; o mesmo texto cifrado duas vezes sai diferente; guardar o cifrado não embrulha de novo', () => {
    comCofre(K1)
    const a = guardarSegredo(CHAVE_PRODUCAO)!
    const b = guardarSegredo(CHAVE_PRODUCAO)!
    expect(estaNoCofre(a)).toBe(true)
    expect(a).not.toContain('aact')
    expect(a).not.toBe(b)
    expect(abrirSegredo(a)).toBe(CHAVE_PRODUCAO)
    expect(abrirSegredo(b)).toBe(CHAVE_PRODUCAO)
    expect(guardarSegredo(a)).toBe(a)
    expect(kidDoGuardado(a)).toBe(kidAtual())
    expect(finalDoSegredo(a)).toBe(CHAVE_PRODUCAO.slice(-6))
  })

  it('texto puro gravado antes do cofre continua abrindo com o cofre ligado', () => {
    comCofre(K1)
    expect(abrirSegredo(CHAVE_SANDBOX)).toBe(CHAVE_SANDBOX)
  })

  it('um caractere trocado no cifrado, ou a chave errada: CofreFechado, nunca lixo', () => {
    comCofre(K1)
    const g = guardarSegredo(CHAVE_SANDBOX)!
    // troca um BYTE do cifrado (trocar a última letra do base64 pode cair só nos bits de enchimento)
    const partes = g.split(':')
    const cifrado = Buffer.from(partes.at(-1)!, 'base64url')
    cifrado[0] = cifrado[0]! ^ 0x01
    const adulterado = [...partes.slice(0, -1), cifrado.toString('base64url')].join(':')
    expect(adulterado).not.toBe(g)
    expect(() => abrirSegredo(adulterado)).toThrow(CofreFechado)
    comCofre(K2)
    expect(() => abrirSegredo(g)).toThrow(/não está no servidor/)
    expect(() => abrirSegredo('cofre:v1:quebrado')).toThrow(CofreFechado)
  })

  it('rotação: a chave nova em COFRE_CHAVE e a velha em COFRE_CHAVES_ANTIGAS — o antigo ainda abre', () => {
    comCofre(K1)
    const velho = guardarSegredo(CHAVE_SANDBOX)!
    const kidVelho = kidDoGuardado(velho)
    comCofre(K2, K1)
    expect(abrirSegredo(velho)).toBe(CHAVE_SANDBOX)
    expect(kidAtual()).not.toBe(kidVelho)
    expect(kidDoGuardado(guardarSegredo(CHAVE_SANDBOX))).toBe(kidAtual())
  })

  it('COFRE_CHAVE que não tem 32 bytes é recusada com o jeito de gerar uma certa', () => {
    comCofre('curta')
    expect(() => guardarSegredo(CHAVE_SANDBOX)).toThrow(/openssl rand -base64 32/)
  })
})

describe('o Asaas com a chave no cofre', () => {
  it('o ambiente sai de DENTRO da chave cifrada (o selo e a URL não viram "sandbox" por engano)', () => {
    comCofre(K1)
    expect(ambienteDaChave(guardarSegredo(CHAVE_PRODUCAO))).toBe('production')
    expect(ambienteDaChave(guardarSegredo(CHAVE_SANDBOX))).toBe('sandbox')
    // cofre que não abre: "não sei" (a vitrine não cai), quem cobra acusa
    const g = guardarSegredo(CHAVE_PRODUCAO)
    comCofre(K2)
    expect(ambienteDaChave(g)).toBeNull()
  })

  it('o cabeçalho leva a chave ABERTA, e a URL é a do ambiente dela', async () => {
    comCofre(K1)
    const chamadas: { url: string; token: string }[] = []
    vi.stubGlobal('fetch', async (url: string, init: any) => {
      chamadas.push({ url, token: init.headers.access_token })
      return new Response(JSON.stringify({ data: [] }), { status: 200 })
    })
    const r = await testarConexao({ apiKey: guardarSegredo(CHAVE_PRODUCAO)!, environment: 'sandbox' })
    expect(r.ok).toBe(true)
    expect(chamadas[0]!.token).toBe(CHAVE_PRODUCAO)
    expect(chamadas[0]!.url).toMatch(/^https:\/\/api\.asaas\.com\/v3\//)
  })

  it('chave no cofre sem a chave do cofre no servidor: a venda online fecha com motivo, sem 500', () => {
    process.env.PAGAMENTO_SIMULADO = '0'
    comCofre(K1)
    const g = guardarSegredo(CHAVE_SANDBOX)
    expect(pagamentoOnline({ asaas_api_key: g, asaas_env: 'sandbox' }).ok).toBe(true)
    comCofre(undefined)
    expect(pagamentoOnline({ asaas_api_key: g, asaas_env: 'sandbox' })).toMatchObject({ ok: false, motivo: 'cofre_fechado' })
  })
})

describe('o cofre no banco (o boot arruma)', () => {
  let orgId: string
  beforeAll(async () => {
    orgId = (await q1<any>(`INSERT INTO organizations (name, slug, asaas_api_key, asaas_env)
      VALUES ('ZZ Cofre', 'zz-cofre-' || gen_random_uuid(), $1, 'sandbox') RETURNING id`, [CHAVE_SANDBOX]))!.id
  })
  afterAll(async () => {
    // a auditoria só aceita apagar com o expurgo liberado na transação (db/019) — é teste
    await tx(async (c) => {
      await c.query(`SET LOCAL auditoria.expurgo = 'liberado'`)
      await c.query(`DELETE FROM audit_log WHERE org_id = $1`, [orgId])
      await c.query(`DELETE FROM organizations WHERE id = $1`, [orgId])
    })
  })
  const gravada = async () => (await q1<any>(`SELECT asaas_api_key FROM organizations WHERE id = $1`, [orgId]))!.asaas_api_key
  const linhasDaAuditoria = async () => (await q<any>(
    `SELECT action FROM audit_log WHERE org_id = $1 AND action LIKE 'chave_asaas_%' ORDER BY created_at`, [orgId]))
    .map((l) => l.action)

  it('desligado: não mexe; ligado: cifra a solta, uma vez, e deixa rastro sem o valor', async () => {
    comCofre(undefined)
    expect(await arrumarCofre(orgId)).toBeNull()
    expect(await gravada()).toBe(CHAVE_SANDBOX)
    expect(await estadoDoCofre(orgId)).toEqual({ ligado: false, emTextoPuro: 1, ilegiveis: 0 })

    comCofre(K1)
    expect(await arrumarCofre(orgId)).toEqual({ cifradas: 1, recifradas: 0, jaEstavam: 0, ilegiveis: 0 })
    const g = await gravada()
    expect(estaNoCofre(g)).toBe(true)
    expect(abrirSegredo(g)).toBe(CHAVE_SANDBOX)
    // de novo: nada muda (o boot roda a cada reinício)
    expect(await arrumarCofre(orgId)).toEqual({ cifradas: 0, recifradas: 0, jaEstavam: 1, ilegiveis: 0 })
    expect(await gravada()).toBe(g)
    expect(await linhasDaAuditoria()).toEqual(['chave_asaas_cifrada'])
    const rastro = await q1<any>(`SELECT after::text AS t FROM audit_log WHERE org_id = $1 AND action = 'chave_asaas_cifrada'`, [orgId])
    expect(rastro!.t).not.toContain('aact')
  })

  it('rotação: o que está na chave velha vai pra nova; a chave que não abre é contada e não é tocada', async () => {
    comCofre(K2, K1)
    expect(await arrumarCofre(orgId)).toEqual({ cifradas: 0, recifradas: 1, jaEstavam: 0, ilegiveis: 0 })
    const g = await gravada()
    expect(kidDoGuardado(g)).toBe(kidAtual())
    expect(await linhasDaAuditoria()).toEqual(['chave_asaas_cifrada', 'chave_asaas_recifrada'])

    // servidor com outra chave e sem a antiga: não abre — conta, avisa na saúde, não estraga
    comCofre(randomBytes(32).toString('base64'))
    expect(await arrumarCofre(orgId)).toEqual({ cifradas: 0, recifradas: 0, jaEstavam: 0, ilegiveis: 1 })
    expect(await gravada()).toBe(g)
    expect(await estadoDoCofre(orgId)).toMatchObject({ ligado: true, emTextoPuro: 0, ilegiveis: 1 })
  })
})
