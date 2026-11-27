/**
 * POST /api/comandas/gestao/links — cria, troca ou desliga o link de um funcionário (gerente).
 *
 * `{ acao: 'criar', nome }` → `{ id, segredo, pin }` (só aparecem agora; o banco guarda os hashes)
 * `{ acao: 'novo_segredo', id }` → `{ id, segredo, pin }`: link e PIN antigos param de funcionar na hora
 * `{ acao: 'desligar', id }` / `{ acao: 'religar', id }`
 */
import { randomBytes, randomInt } from 'node:crypto'
import bcrypt from 'bcryptjs'
import { exigirNivel, hashDoLink, recusa, registrar, texto } from '../../../utils/comandas'
import { q1 } from '../../../utils/db'

const novoSegredo = () => randomBytes(24).toString('base64url')
/** PIN de 4 números, sem sequência óbvia (1234, 1111…) */
function novoPin(): string {
  for (;;) {
    const p = String(randomInt(0, 10_000)).padStart(4, '0')
    if (!/^(\d)\1{3}$/.test(p) && !'0123456789 9876543210'.includes(p)) return p
  }
}

export default defineEventHandler(async (event) => {
  const c = exigirNivel(event, 'gerente')
  const b = (await readBody<Record<string, any>>(event)) ?? {}

  if (b.acao === 'criar') {
    const nome = texto(b.nome, 60)
    if (!nome || nome.length < 2) recusa('Escreva o nome do funcionário.', 'nome')
    const segredo = novoSegredo()
    const pin = novoPin()
    const r = await q1<any>(`INSERT INTO comanda_links (org_id, nome, token_hash, criado_por, pin_hash) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [c.orgId, nome, hashDoLink(segredo), c.usuarioId, await bcrypt.hash(pin, 10)])
    await registrar(null, c, { acao: 'link', descricao: `Criou o link de atendimento de ${nome}` })
    return { id: r.id, segredo, pin }
  }

  const k = await q1<any>(`SELECT id, nome FROM comanda_links WHERE org_id = $1 AND id::text = $2`, [c.orgId, String(b.id ?? '')])
  if (!k) recusa('Link não encontrado.', 'link')

  if (b.acao === 'novo_segredo') {
    const segredo = novoSegredo()
    const pin = novoPin()
    await q1(`UPDATE comanda_links SET token_hash = $2, pin_hash = $3, erros_pin = 0, erros_total = 0, travado_ate = NULL, desativado_em = NULL, desativado_por = NULL
               WHERE id = $1 RETURNING id`, [k.id, hashDoLink(segredo), await bcrypt.hash(pin, 10)])
    await registrar(null, c, { acao: 'link', descricao: `Gerou link e PIN novos para ${k.nome} (os antigos pararam de funcionar)` })
    return { id: k.id, segredo, pin }
  }
  if (b.acao === 'desligar') {
    await q1(`UPDATE comanda_links SET desativado_em = now(), desativado_por = $2 WHERE id = $1 RETURNING id`, [k.id, c.usuarioId])
    await registrar(null, c, { acao: 'link', descricao: `Desligou o link de atendimento de ${k.nome}` })
    return { ok: true }
  }
  if (b.acao === 'religar') {
    await q1(`UPDATE comanda_links SET desativado_em = NULL, desativado_por = NULL WHERE id = $1 RETURNING id`, [k.id])
    await registrar(null, c, { acao: 'link', descricao: `Religou o link de atendimento de ${k.nome}` })
    return { ok: true }
  }
  recusa('Ação desconhecida.', 'acao')
})
