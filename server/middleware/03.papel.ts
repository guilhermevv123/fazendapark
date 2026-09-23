/**
 * Terceiro porteiro: o PAPEL. Deny-by-default, rota a rota.
 *
 * Os dois anteriores já perguntaram "tem sessão?" (01) e "este id é seu?"
 * (02). Faltava a pergunta que separa as pessoas de dentro da MESMA
 * organização: **o porteiro do portão pode pedir transferência?**
 *
 * Até aqui podia — não ele, que o 01 barra por outro motivo, mas quem é de
 * operação sim: o prefixo `/api/admin/evento/` cobre tanto o cadastro de lote
 * quanto o saldo e o pedido de saque, e o porteiro antigo enxerga os três
 * como a mesma área. A grade fina está em `utils/papeis.ts`; aqui é só onde
 * ela é aplicada.
 *
 * Por que middleware e não uma linha em cada handler: handler que precisa
 * LEMBRAR de conferir é handler que um dia nasce sem a linha — e a tela
 * continua bonita enquanto o dado sai. Aqui, rota nova nasce trancada pra
 * todo mundo menos o master, até alguém classificá-la de propósito em
 * `papeis.ts`. Isso aparece no diff; esquecer, não.
 *
 * O papel vem do BANCO a cada requisição, e não do cookie. Sessão dura 30
 * dias com renovação deslizante: se o papel viajasse no cookie, rebaixar
 * alguém na tela de equipe só teria efeito um mês depois, e "tirei o acesso
 * dele" seria mentira até lá. É uma leitura por chave primária — a mesma
 * linha que o 01 acabou de ler pra montar a sessão.
 */
import { caminhoDaRota } from '../utils/caminho'
import { q1 } from '../utils/db'
import { decidirAcesso, ehPapel, papelDoRoleLegado, rotaGateada } from '../utils/papeis'

export default defineEventHandler(async (event) => {
  const caminho = caminhoDaRota(event)
  if (!rotaGateada(caminho)) return

  const sessao = (event.context as any).sessao
  // Sem sessão, o 01 já derrubou. Chegar aqui sem ela significa que a ordem
  // dos middlewares mudou — e o certo nesse caso é fechar, não deixar passar.
  if (!sessao?.usuarioId) {
    throw createError({ statusCode: 401, statusMessage: 'Faça login para continuar' })
  }

  const linha = await q1<{ papel: string | null; role: string | null }>(
    `SELECT papel, role FROM users WHERE id = $1`, [sessao.usuarioId])

  // Linha antiga que a migração 012 não alcançou (banco de cópia, restore
  // parcial): cai no papel derivado do `role`, nunca em "libera".
  const gravado = linha?.papel
  const papel = ehPapel(gravado) ? gravado : papelDoRoleLegado(linha?.role)

  const decisao = decidirAcesso(papel, caminho)
  if (!decisao.liberado) {
    throw createError({ statusCode: 403, statusMessage: decisao.motivo })
  }

  // Quem precisar do papel no handler pega daqui, sem repetir a consulta.
  ;(event.context as any).papel = papel
})
