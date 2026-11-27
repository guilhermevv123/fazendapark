/**
 * GET /api/comandas/equipe — quem da equipe do painel tem acesso às comandas, e com que
 * nível. As pessoas são as MESMAS de Configurações → Equipe (lá se cria o login); aqui só se
 * dá o nível na comanda. Atendente de bar: crie lá com o papel Portaria e dê "Atendente" aqui.
 */
import { exigirNivel } from '../../utils/comandas'
import { q } from '../../utils/db'

export default defineEventHandler(async (event) => {
  setHeader(event, 'Cache-Control', 'no-store')
  const c = exigirNivel(event, 'gerente')
  const linhas = await q<any>(
    `SELECT u.id, u.name, u.email, u.papel, u.active, a.nivel, (a.pin_hash IS NOT NULL) AS tem_pin
       FROM users u LEFT JOIN comanda_acessos a ON a.user_id = u.id
      WHERE u.org_id = $1 ORDER BY u.active DESC, u.name`, [c.orgId])
  return {
    pessoas: linhas.map((u) => ({
      id: u.id, nome: u.name, email: u.email, papel: u.papel, ativo: u.active,
      nivel: u.papel === 'master' ? 'gerente' : u.nivel ?? null,
      master: u.papel === 'master', temPin: !!u.tem_pin, eu: u.id === c.usuarioId,
    })),
  }
})
