/**
 * PATCH /api/admin/equipe — muda papel, ativa/desativa, ou sorteia nova senha.
 *
 * Três travas que existem porque a alternativa é a organização ficar sem dono:
 *
 * 1. **Ninguém rebaixa nem desativa a si mesmo.** É o clique que tranca a
 *    pessoa pra fora da própria conta e não tem desfazer pela tela.
 * 2. **Não dá pra tirar o último master.** Organização sem master é
 *    organização que ninguém consegue mais administrar — e, desde a grade de
 *    papéis, é também organização onde NINGUÉM mais mexe em equipe nem em
 *    credencial de cobrança. A contagem é por `papel`, que é a coluna que
 *    decide de verdade; contar por `role` deixaria passar o caso em que as
 *    duas discordam.
 *
 *    **Essa contagem vive DENTRO da transação, depois do `FOR UPDATE`, e não
 *    é capricho.** Num pedido sozinho ela nunca reprova nada: quem manda o
 *    PATCH já é master, a trava 1 impede que ele seja o próprio alvo, e a
 *    conta é de masters ativos com `id <> alvo` — ele mesmo sempre entra.
 *    O único caso em que ela decide algo é o de dois pedidos ao mesmo tempo,
 *    cada um tirando um dos dois últimos masters. Contando ANTES da trava,
 *    os dois liam "sobra o outro", os dois gravavam, e a organização acordava
 *    sem master nenhum — sem erro, sem log, sem caminho de volta pela tela.
 *    Medido: `papeis.test.ts › dois masters se rebaixando ao mesmo tempo`
 *    devolvia zero master ativo. A trava pega as linhas de TODOS os masters
 *    ativos da organização (`ORDER BY id`, pra ordem de lock igual nos dois
 *    lados), e o segundo pedido só decide depois de enxergar o que o
 *    primeiro gravou.
 * 3. **Desativar derruba as sessões abertas.** Desativar sem revogar deixa a
 *    pessoa navegando com o cookie que já tinha até ele vencer — o acesso
 *    "cortado" continua de pé por dias.
 *
 * 4. **"Nova senha" não vale pra si mesmo.** Sortear a própria senha revogava
 *    TODAS as sessões do alvo — inclusive a de quem clicou —, o `refresh()`
 *    seguinte voltava 401 e a senha sorteada sumia da tela junto com a página:
 *    o master ficava trancado fora com uma senha que ninguém viu. A própria
 *    senha se troca em `POST /api/auth/senha` (menu da conta), que pede a
 *    atual e mantém a sessão de quem troca.
 *
 * Mudar de papel também derruba as sessões: não porque a sessão carregue
 * permissão (o `middleware/03.papel.ts` relê o papel do banco a cada
 * requisição), mas porque quem foi rebaixado fica com a tela anterior aberta,
 * clicando em menu que agora responde 403. Entrar de novo mostra o painel que
 * ele realmente tem.
 */
import { z } from 'zod'
import bcrypt from 'bcryptjs'
import { randomInt } from 'node:crypto'
import { q1, tx } from '../../../utils/db'
import { autorDaRequisicao, registrarAuditoria } from '../../../utils/auditoria'
import { PAPEIS, ehPapel, papelDoRoleLegado, roleLegado } from '../../../utils/papeis'

const Entrada = z.object({
  id: z.string().uuid(),
  // trim ANTES do min: "   " passava no min(2) e gravava nome vazio
  nome: z.string().trim().min(2).max(120).optional(),
  papel: z.enum(PAPEIS as [string, ...string[]]).optional(),
  ativo: z.boolean().optional(),
  novaSenha: z.literal(true).optional(),
})

const ALFABETO = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'
const sortearSenha = (n = 14) =>
  Array.from({ length: n }, () => ALFABETO[randomInt(ALFABETO.length)]).join('')

export default defineEventHandler(async (event) => {
  const sessao = (event.context as any).sessao
  const orgId = sessao?.orgId
  if (!orgId) throw createError({ statusCode: 401, statusMessage: 'Sessão sem organização' })
  if ((event.context as any).papel !== 'master') {
    throw createError({ statusCode: 403, statusMessage: 'Só um master muda o acesso de alguém.' })
  }

  const p = Entrada.safeParse(await readBody(event))
  if (!p.success) {
    throw createError({ statusCode: 400, statusMessage: 'Dados inválidos', data: p.error.flatten() })
  }
  const d = p.data
  const papelNovo = d.papel as (typeof PAPEIS)[number] | undefined

  const alvo = await q1<any>(
    `SELECT id, name, email, papel, role, active FROM users WHERE id = $1 AND org_id = $2`,
    [d.id, orgId])
  if (!alvo) throw createError({ statusCode: 404, statusMessage: 'Pessoa não encontrada' })

  // "Eu mesmo" não depende de corrida nenhuma: é comparação de id, e o papel
  // de quem manda o pedido é o que o middleware acabou de ler do banco.
  const papelLido = ehPapel(alvo.papel) ? alvo.papel : papelDoRoleLegado(alvo.role)
  const euMesmo = alvo.id === sessao.usuarioId
  if (euMesmo && (d.ativo === false || (papelNovo !== undefined && papelNovo !== papelLido))) {
    throw createError({
      statusCode: 422,
      statusMessage: 'Você não pode mudar o próprio papel nem se desativar. '
        + 'Peça a outro master.',
    })
  }

  if (euMesmo && d.novaSenha) {
    throw createError({
      statusCode: 422,
      statusMessage: "Pra trocar a sua senha, use 'Trocar senha' no menu da conta.",
    })
  }

  return await tx(async (c) => {
    // A TRAVA VEM ANTES DA DECISÃO. Pega as linhas de todos os masters ativos
    // da organização; dois pedidos concorrentes disputam as MESMAS linhas, na
    // mesma ordem, e o segundo só segue depois que o primeiro gravou.
    const { rows: masters } = await c.query(
      `SELECT id FROM users
        WHERE org_id = $1 AND papel = 'master' AND active
        ORDER BY id
          FOR UPDATE`, [orgId])

    // Relê o alvo já com a trava na mão: o papel que veio da leitura lá de
    // cima pode ter mudado enquanto este pedido esperava.
    const agora = (await c.query(
      `SELECT papel, role, active FROM users WHERE id = $1 AND org_id = $2`,
      [alvo.id, orgId])).rows[0]
    if (!agora) throw createError({ statusCode: 404, statusMessage: 'Pessoa não encontrada' })

    const papelAtual = ehPapel(agora.papel) ? agora.papel : papelDoRoleLegado(agora.role)
    const mudaDePapel = papelNovo !== undefined && papelNovo !== papelAtual

    // último master de pé
    if (papelAtual === 'master' && agora.active && (d.ativo === false || mudaDePapel)) {
      const outros = masters.filter((m: any) => m.id !== alvo.id).length
      if (outros === 0) {
        throw createError({
          statusCode: 422,
          statusMessage: 'Este é o último master ativo. Promova outra pessoa antes.',
        })
      }
    }

    const set: string[] = []
    const par: any[] = [alvo.id]
    // `email` nos dois lados: não muda, mas é por ele que alguém procura o ato
    const antes: Record<string, unknown> = { email: alvo.email }
    const depois: Record<string, unknown> = { email: alvo.email }

    if (d.nome !== undefined) {
      par.push(d.nome); set.push(`name = $${par.length}`)
      antes.nome = alvo.name; depois.nome = d.nome
    }
    if (papelNovo !== undefined) {
      antes.papel = papelAtual
      // as duas colunas andam juntas — ver o comentário do POST
      par.push(papelNovo); set.push(`papel = $${par.length}`)
      par.push(roleLegado(papelNovo)); set.push(`role = $${par.length}`)
      depois.papel = papelNovo
    }
    if (d.ativo !== undefined) {
      par.push(d.ativo); set.push(`active = $${par.length}`)
      antes.ativo = agora.active; depois.ativo = d.ativo
    }

    let senha: string | null = null
    if (d.novaSenha) {
      senha = sortearSenha()
      par.push(await bcrypt.hash(senha, 10))
      set.push(`password_hash = $${par.length}`)
      depois.senhaTrocada = true
    }

    if (!set.length) return { ok: true, semMudanca: true }

    await c.query(`UPDATE users SET ${set.join(', ')} WHERE id = $1`, par)

    // Desativar, trocar senha ou rebaixar tem que derrubar quem já está
    // dentro — senão o cookie antigo continua valendo e a tela aberta segue
    // prometendo o que o papel novo não entrega.
    if (d.ativo === false || d.novaSenha || mudaDePapel) {
      await c.query(
        `UPDATE sessions SET revoked_at = now()
          WHERE user_id = $1 AND revoked_at IS NULL`, [alvo.id])
      depois.sessoesRevogadas = true
    }

    // Na MESMA transação do ato, com autor (user_id, e-mail, IP) nas colunas
    // — o INSERT cru de antes gravava a linha sem dizer quem. A senha sorteada
    // não entra: só o fato de ter sido trocada.
    await registrarAuditoria({
      autor: autorDaRequisicao(event),
      entidade: 'usuario',
      entidadeId: alvo.id,
      acao: 'editado',
      antes,
      depois,
    }, c)

    return { ok: true, senhaProvisoria: senha }
  })
})
