/**
 * O cofre no banco (a chave do Asaas de cada organização — ver utils/cofre.ts).
 *
 * `arrumarCofre` roda no BOOT (server/plugins/00.filas.ts): com COFRE_CHAVE no servidor, cifra
 * as chaves que ainda estão em texto puro (gravadas antes do cofre existir) e recifra com a chave
 * atual as que foram cifradas com uma antiga (a rotação: chave nova em COFRE_CHAVE, a velha em
 * COFRE_CHAVES_ANTIGAS, reinicia — no boot seguinte a velha já pode sair). Ligar o cofre em
 * produção é UMA variável e um reinício; nenhum script pra rodar à mão dentro do contêiner.
 *
 * Idempotente e cuidadosa: uma transação só, trava pra duas instâncias subindo juntas não
 * fazerem ao mesmo tempo, e cada valor novo é ABERTO de volta e comparado antes de gravar — se
 * a ida e volta não bater, nada é gravado. A Auditoria ganha uma linha por organização, sem o
 * valor (o fato, nunca o segredo).
 */
import { q, tx } from './db'
import { abrirSegredo, cofreLigado, CofreFechado, estaNoCofre, guardarSegredo, kidAtual, kidDoGuardado } from './cofre'

export interface ArrumacaoDoCofre { cifradas: number; recifradas: number; jaEstavam: number; ilegiveis: number }

/** `soDaOrganizacao`: só pro teste não mexer nas organizações dos outros arquivos. O boot não passa. */
export async function arrumarCofre(soDaOrganizacao?: string): Promise<ArrumacaoDoCofre | null> {
  if (!cofreLigado()) return null
  const atual = kidAtual()
  return tx(async (c) => {
    const { rows: [trava] } = await c.query(`SELECT pg_try_advisory_xact_lock(hashtext('dt:cofre-arrumar')) AS ok`)
    const r: ArrumacaoDoCofre = { cifradas: 0, recifradas: 0, jaEstavam: 0, ilegiveis: 0 }
    if (!trava?.ok) return r // outra instância está arrumando agora
    const { rows } = await c.query(
      `SELECT id, asaas_api_key FROM organizations
        WHERE asaas_api_key IS NOT NULL AND ($1::uuid IS NULL OR id = $1)
          FOR UPDATE`, [soDaOrganizacao ?? null])
    for (const org of rows) {
      let aberta: string | null
      try {
        aberta = abrirSegredo(org.asaas_api_key)
      } catch (e) {
        if (e instanceof CofreFechado) { r.ilegiveis++; continue }
        throw e
      }
      const estava = estaNoCofre(org.asaas_api_key)
      if (estava && kidDoGuardado(org.asaas_api_key) === atual) { r.jaEstavam++; continue }
      const nova = guardarSegredo(aberta)
      if (!estaNoCofre(nova) || abrirSegredo(nova) !== aberta) {
        throw new Error('cofre: a chave cifrada não abriu de volta igual — nada foi gravado')
      }
      await c.query(`UPDATE organizations SET asaas_api_key = $2 WHERE id = $1`, [org.id, nova])
      await c.query(
        `INSERT INTO audit_log (org_id, entity, entity_id, action, after)
         VALUES ($1::uuid, 'organization', $1::text, $2, $3::jsonb)`,
        [org.id, estava ? 'chave_asaas_recifrada' : 'chave_asaas_cifrada', JSON.stringify({ cofre: atual })])
      if (estava) r.recifradas++
      else r.cifradas++
    }
    return r
  })
}

/** Pra /api/saude: quantas chaves estão em texto puro e quantas o cofre deste servidor não abre. */
export async function estadoDoCofre(soDaOrganizacao?: string): Promise<{ ligado: boolean; emTextoPuro: number; ilegiveis: number }> {
  const linhas = await q<{ asaas_api_key: string }>(
    `SELECT asaas_api_key FROM organizations
      WHERE asaas_api_key IS NOT NULL AND ($1::uuid IS NULL OR id = $1)`, [soDaOrganizacao ?? null])
  let emTextoPuro = 0
  let ilegiveis = 0
  for (const { asaas_api_key: v } of linhas) {
    if (!estaNoCofre(v)) { emTextoPuro++; continue }
    try { abrirSegredo(v) } catch (e) { if (e instanceof CofreFechado) ilegiveis++; else throw e }
  }
  return { ligado: cofreLigado(), emTextoPuro, ilegiveis }
}
