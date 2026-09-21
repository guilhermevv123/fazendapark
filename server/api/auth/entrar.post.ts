/**
 * POST /api/auth/entrar — login.
 *
 * A resposta é a MESMA para e-mail inexistente, senha errada e conta
 * desativada: "E-mail ou senha não confere". Mensagem específica ("este
 * e-mail não existe") é um oráculo — deixa qualquer um descobrir quem tem
 * conta no sistema testando endereços.
 *
 * A comparação bcrypt roda mesmo quando o e-mail não existe, contra um hash
 * descartável. Sem isso, a resposta para e-mail inexistente volta em ~1ms e a
 * de senha errada em ~80ms, e o tempo entrega o que a mensagem escondeu.
 *
 * ## O e-mail é único POR ORGANIZAÇÃO no banco, e o login não pergunta a loja
 *
 * O índice do banco é `UNIQUE (org_id, email)`: o mesmo endereço pode existir
 * em duas organizações. A tela de equipe recusa isso desde a rodada passada,
 * mas a recusa é de APLICAÇÃO — o banco continua aceitando as duas linhas por
 * `INSERT` direto, restore parcial ou importação, e foi assim que o defeito
 * foi reproduzido.
 *
 * Esta rota procurava `WHERE lower(email) = $1` e ficava com **a primeira
 * linha que o Postgres devolvesse**, sem `ORDER BY` — ou seja, a ordem física
 * da tabela. E ela MUDA: `abrirSessao` grava `last_login_at`, o que reescreve
 * a linha e a joga pro fim. Medido no servidor no ar, com as duas senhas
 * CERTAS na mão, roteiro `[A,A,B,B,A,A]`:
 *
 *     A:200  A:401  B:200  B:401  A:200  A:401
 *
 * Metade das entradas com a senha certa era recusada com "E-mail ou senha não
 * confere" — a MESMA frase de senha errada. Não tem como o suporte adivinhar
 * isso, e a pessoa do guichê conclui que o sistema comeu o acesso dela.
 *
 * ## A escolha: quem decide é a SENHA, não a ordem da tabela
 *
 * "Ensinar a organização ao login" seria pedir "qual é a sua loja?" na tela de
 * entrada — informação que quem trabalha no guichê não tem, e que o índice
 * global do banco também não daria sem uma migração que apagasse linha (e
 * apagar acesso de gente é o que este projeto não faz por conta própria).
 *
 * Então o login passa a conferir a senha contra TODAS as linhas daquele
 * e-mail, em ordem fixa, e entra na que casar. Três consequências, todas de
 * propósito:
 *
 * 1. **acabou o sorteio**: cada pessoa entra sempre na conta dela, em qualquer
 *    ordem de tentativa — o roteiro acima vira `200 200 200 200 200 200`, cada
 *    um na SUA organização;
 * 2. **nada de atravessar loja**: se as duas linhas tiverem a MESMA senha, não
 *    existe como saber qual é a pessoa, e aí a rota RECUSA dizendo o que fazer.
 *    Chutar a mais antiga colocaria alguém dentro do painel de outra
 *    produtora, que é o pior desfecho possível num sistema que move dinheiro;
 * 3. **o estado atual fica visível**: e-mail com mais de uma linha vira aviso
 *    no log a cada entrada, com a contagem. Nenhuma linha é apagada por conta
 *    própria.
 */
import bcrypt from 'bcryptjs'
import { z } from 'zod'
import { q } from '../../utils/db'
import { abrirSessao, ipDaRequisicao, registrarTentativa, travadoPorTentativas } from '../../utils/sessao'

const Entrada = z.object({
  email: z.string().email().max(200),
  senha: z.string().min(1).max(200),
})

// hash de uma senha aleatória, só pra gastar o mesmo tempo quando o e-mail
// não existe. Calculado uma vez no boot.
const HASH_FALSO = bcrypt.hashSync('nao-existe-' + Math.random(), 10)

type Candidato = {
  id: string; name: string; org_id: string
  password_hash: string; role: string; active: boolean
}

export default defineEventHandler(async (event) => {
  const p = Entrada.safeParse(await readBody(event))
  if (!p.success) throw createError({ statusCode: 400, statusMessage: 'Informe e-mail e senha' })

  const email = p.data.email.trim().toLowerCase()
  const ip = ipDaRequisicao(event)

  const travado = await travadoPorTentativas(email, ip)
  if (travado) throw createError({ statusCode: 429, statusMessage: travado })

  /*
   * TODAS as linhas daquele e-mail, em ordem fixa.
   *
   * O `ORDER BY` não escolhe quem entra — quem escolhe é a senha, logo abaixo.
   * Ele existe pra que a mensagem e o log sejam sempre os mesmos pra mesma
   * entrada: sem ele, duas chamadas iguais podem ler as linhas em ordens
   * diferentes e contar histórias diferentes sobre o mesmo banco.
   */
  const candidatos = await q<Candidato>(
    `SELECT id, name, org_id, password_hash, role, active
       FROM users WHERE lower(email) = $1
      ORDER BY created_at, id`, [email])

  if (candidatos.length > 1) {
    // Nada é apagado aqui: quem some com linha de acesso é gente, de propósito
    // e com a tela de equipe na frente. O log é pra essa conversa existir.
    console.warn(`[entrar] o e-mail ${email} tem ${candidatos.length} acessos em organizações `
      + 'diferentes; quem entra é decidido pela senha. Unifique pela tela de equipe.')
  }

  /*
   * Compara contra cada linha — e contra o hash descartável quando não há
   * nenhuma, pra que "e-mail que não existe" custe o mesmo que "senha errada".
   * Sem parar no primeiro acerto: é justamente o SEGUNDO acerto que diz que
   * ninguém pode entrar por este caminho.
   */
  const paraConferir = candidatos.length
    ? candidatos
    : [{ password_hash: HASH_FALSO, active: false } as Candidato]

  const casaram: Candidato[] = []
  for (const u of paraConferir) {
    if (await bcrypt.compare(p.data.senha, u.password_hash ?? HASH_FALSO)) casaram.push(u)
  }

  const ativos = casaram.filter((u) => u.active)

  if (!ativos.length) {
    await registrarTentativa(email, ip, false)
    throw createError({ statusCode: 401, statusMessage: 'E-mail ou senha não confere' })
  }

  if (ativos.length > 1) {
    // Duas contas de organizações diferentes com o MESMO e-mail e a MESMA
    // senha: entrar em qualquer uma é entrar no painel de alguém que não é
    // quem está digitando. A recusa é a saída segura, e ela diz o que fazer.
    //
    // E ela NÃO entra no freio de força bruta. A senha estava CERTA: o que
    // falta aqui é saber de qual organização a pessoa é, o que nenhuma
    // tentativa dela resolve. Contando como falha, quem cai neste caso leva
    // 429 por cima da recusa depois de oito tentativas — trancado por tentar
    // entrar com a própria senha, sem nada que possa fazer a respeito — e o
    // freio passa a contar coisa que não é ataque, embaçando o sinal de quem
    // está de fato chutando senha.
    console.warn(`[entrar] ${email}: ${ativos.length} acessos ativos com a mesma senha — `
      + 'entrada recusada pra não abrir o painel da organização errada.')
    throw createError({
      statusCode: 409,
      statusMessage: 'Este e-mail tem acesso em mais de uma organização com a mesma senha, '
        + 'e não dá pra saber qual é o seu. Peça a um master da sua organização para trocar '
        + 'a sua senha ou o seu e-mail.',
    })
  }

  const u = ativos[0]!
  await registrarTentativa(email, ip, true)
  await abrirSessao(event, u.id)

  return { ok: true, usuario: { nome: u.name, email, papel: u.role } }
})
