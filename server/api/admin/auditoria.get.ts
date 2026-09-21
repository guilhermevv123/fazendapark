/**
 * GET /api/admin/auditoria — quem fez o quê, consultável.
 *
 * A tabela `audit_log` existe desde o primeiro dia e ninguém nunca leu: não
 * havia tela, não havia rota. Auditoria que só existe no banco não é
 * auditoria — é um arquivo morto que o produtor não tem como abrir quando
 * pergunta "quem cancelou este ingresso?".
 *
 * Quatro decisões desta rota:
 *
 * - **A cerca de organização é a primeira linha do WHERE, não a última.**
 *   Esta tabela guarda valor de venda, nome de operador, motivo de estorno e
 *   o antes/depois de configuração de preço. Um vazamento aqui entrega a
 *   operação inteira de um produtor pro vizinho.
 *
 * - **`LEFT JOIN users`, nunca `JOIN`.** O autor pode ter sido removido da
 *   equipe depois do ato — e é justamente o ato dele que alguém vai procurar.
 *   Com `JOIN`, a linha sumiria em silêncio; com `LEFT JOIN`, ela aparece
 *   marcada como autor removido, com o e-mail que ficou carimbado na hora.
 *
 * - **A tela diz quantos registros do recorte não sabem quem fez.** São 900
 *   linhas antigas, gravadas antes do helper existir. Esconder isso faria a
 *   tela parecer completa e mandar o produtor concluir que "ninguém mexeu".
 *
 * - **Busca livre entra no antes/depois.** Quem pergunta "quem cancelou este
 *   ingresso" tem o CÓDIGO do ingresso na mão, não o UUID — e o código está
 *   dentro do payload. Sem isso a tela responde uma pergunta que ninguém faz.
 */
import { q, q1 } from '../../utils/db'
import { podeFazer } from '../../utils/sessao'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** valor especial do filtro de pessoa: as linhas antigas, sem autor */
const SEM_AUTOR = 'sem-autor'

/**
 * O recorte mora na URL de propósito — é assim que quem achou o ato manda o
 * link pro sócio. O preço disso é que a data chega como TEXTO QUALQUER: link
 * cortado no WhatsApp, `?de=2026-09` colado pela metade, ou o navegador que
 * não tem `<input type="date">` e manda `20/09/2026`.
 *
 * Sem esta conferência, o texto torto ia direto pro `$1::date` e o Postgres
 * derrubava a consulta com `invalid input syntax for type date: "abc"` — HTTP
 * 500, e a tela mostrando "Server Error" pro operador de guichê às 21h. Aqui
 * o erro vira 400 com frase de gente, dizendo o que fazer.
 *
 * A ida e volta (`toISOString` de novo pra `YYYY-MM-DD`) é o que pega
 * `2026-02-30`: o formato passa no regex, o `Date` aceita e rola pra 2 de
 * março, e só a comparação com o texto original denuncia. `Z` no meio porque
 * o que se compara aqui é o formato, não o fuso — a conta de fuso é do banco,
 * lá embaixo.
 */
const FORMATO_DIA = /^\d{4}-\d{2}-\d{2}$/
function dia(valor: string, qual: string): string {
  if (!valor) return ''
  const d = new Date(`${valor}T00:00:00Z`)
  if (!FORMATO_DIA.test(valor) || Number.isNaN(d.getTime())
      || d.toISOString().slice(0, 10) !== valor) {
    throw createError({
      statusCode: 400,
      statusMessage: `A data "${qual}" do filtro veio escrita como "${valor}", `
        + `que não é uma data. Escolha o período de novo na tela `
        + `(ou escreva no formato 2026-09-20).`,
    })
  }
  return valor
}

const LIMITE_PADRAO = 200
const LIMITE_MAXIMO = 1000

export default defineEventHandler(async (event) => {
  const sessao = (event.context as any).sessao
  if (!sessao?.orgId) throw createError({ statusCode: 401, statusMessage: 'Sessão sem organização' })

  // O porteiro de `/api/admin` casa por prefixo e esta rota não cai em
  // nenhuma área da lista dele — então a área se declara aqui, senão a
  // portaria leria o histórico financeiro inteiro da produtora.
  if (!podeFazer(sessao.papel, 'financeiro')) {
    throw createError({
      statusCode: 403,
      statusMessage: `Seu acesso (${sessao.papel}) não inclui a auditoria.`,
    })
  }

  const p = getQuery(event)
  const texto = (v: unknown) => {
    const s = String(v ?? '').trim()
    return s ? s : ''
  }
  const de = dia(texto(p.de), 'De')
  const ate = dia(texto(p.ate), 'Até')
  const pessoa = texto(p.pessoa)
  const ato = texto(p.ato)
  const entidade = texto(p.entidade)
  const busca = texto(p.busca)
  const limite = Math.min(Math.max(Number(p.limite) || LIMITE_PADRAO, 1), LIMITE_MAXIMO)

  const cond: string[] = ['a.org_id = $1']
  const par: any[] = [sessao.orgId]
  const põe = (sql: string, v: any) => { par.push(v); cond.push(sql.replaceAll('$?', `$${par.length}`)) }

  // `::date` é resolvido no fuso da sessão do banco (America/Bahia), que é o
  // fuso do parque. Converter no servidor com `toISOString` traria o dia
  // seguinte a partir das 21h, justamente no horário em que a bilheteria
  // trabalha — e o operador veria "nada aconteceu hoje" com fila na porta.
  if (de) põe(`a.created_at >= $?::date`, de)
  // `< dia + 1` em vez de `<= dia`: com `<=`, tudo que aconteceu depois da
  // meia-noite do último dia fica de fora e o período fecha faltando um dia.
  if (ate) põe(`a.created_at < ($?::date + interval '1 day')`, ate)

  if (pessoa === SEM_AUTOR) cond.push('a.user_id IS NULL')
  else if (pessoa && UUID.test(pessoa)) põe(`a.user_id = $?::uuid`, pessoa)
  else if (pessoa) põe(`lower(a.actor_email) = lower($?)`, pessoa)

  if (ato) põe(`a.action = $?`, ato)
  if (entidade) põe(`a.entity = $?`, entidade)
  // O id exato casa direto; o resto procura dentro do antes/depois, que é
  // onde moram código do ingresso, código do pedido e nome do comprador.
  if (busca) põe(
    `(a.entity_id = $?
      OR a.before::text ILIKE '%' || $? || '%'
      OR a.after::text  ILIKE '%' || $? || '%')`, busca)

  const onde = cond.join(' AND ')

  const [linhas, resumo, pessoas, atos, entidades] = await Promise.all([
    q<any>(
      `SELECT a.id, a.created_at, a.entity, a.entity_id, a.action,
              a.before, a.after, a.ip,
              a.user_id, a.actor_email, u.name AS autor_nome,
              (a.user_id IS NOT NULL AND u.id IS NULL) AS autor_removido
         FROM audit_log a
         LEFT JOIN users u ON u.id = a.user_id
        WHERE ${onde}
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT ${limite + 1}`, par),

    q1<any>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE a.user_id IS NULL)::int AS sem_autor,
              -- quantas PESSOAS neste recorte. Fica junto do total de propósito:
              -- é o número que o cabeçalho mostra ao lado dele, e um cabeçalho
              -- com um número do recorte ao lado de um número da organização
              -- inteira é a tela dizendo duas verdades diferentes na mesma linha.
              count(DISTINCT a.user_id)::int AS pessoas,
              min(a.created_at) AS mais_antigo
         FROM audit_log a
        WHERE ${onde}`, par),

    // As opções do filtro saem da organização inteira, não do recorte: uma
    // lista que encolhe conforme o filtro impede justamente o movimento de
    // trocar de pessoa sem limpar o resto.
    //
    // O agrupamento é por PESSOA (`a.user_id`) e só. Agrupar também por
    // `actor_email` parece inofensivo e não é: os atos gravados fora do helper
    // preenchem `user_id` e deixam `actor_email` nulo, então a MESMA pessoa
    // virava duas linhas — medido no banco, "Dono (17)" e "Dono (3)" um em
    // cima do outro no `<select>`, escolher qualquer um dá a mesma lista, e o
    // `:key` repetido ainda quebra a renderização. O e-mail é carimbo da
    // linha, não identidade da pessoa: entra como representante (`max`), não
    // como chave.
    q<any>(
      `SELECT a.user_id,
              max(a.actor_email) AS actor_email,
              COALESCE(max(u.name), max(a.actor_email)) AS nome,
              count(*)::int AS atos
         FROM audit_log a
         LEFT JOIN users u ON u.id = a.user_id
        WHERE a.org_id = $1 AND a.user_id IS NOT NULL
        GROUP BY a.user_id
        ORDER BY 4 DESC
        LIMIT 100`, [sessao.orgId]),

    q<any>(
      `SELECT action AS valor, count(*)::int AS atos
         FROM audit_log WHERE org_id = $1 GROUP BY 1 ORDER BY 1`, [sessao.orgId]),

    q<any>(
      `SELECT entity AS valor, count(*)::int AS atos
         FROM audit_log WHERE org_id = $1 GROUP BY 1 ORDER BY 1`, [sessao.orgId]),
  ])

  const truncado = linhas.length > limite
  if (truncado) linhas.pop()

  return {
    filtros: { de, ate, pessoa, ato, entidade, busca, limite },
    opcoes: {
      pessoas: pessoas.map((x) => ({
        id: x.user_id, nome: x.nome ?? x.actor_email ?? 'sem nome',
        email: x.actor_email, atos: x.atos,
      })),
      atos: atos.map((x) => ({ valor: x.valor, atos: x.atos })),
      entidades: entidades.map((x) => ({ valor: x.valor, atos: x.atos })),
    },
    total: Number(resumo?.total ?? 0),
    /**
     * Quantos, dentro do recorte, não dizem quem fez. É o tamanho do buraco
     * que o helper novo fecha daqui pra frente — e o número que impede a tela
     * de responder "ninguém mexeu" quando a verdade é "não foi anotado".
     */
    semAutor: Number(resumo?.sem_autor ?? 0),
    /**
     * Quantas pessoas diferentes agiram DENTRO do recorte. O `opcoes.pessoas`
     * ao lado é outra coisa — é a lista do `<select>`, que cobre a
     * organização inteira de propósito pra não encolher enquanto se troca de
     * filtro. Usar o tamanho daquela lista como número de cabeçalho fazia a
     * tela responder "3 pessoas" num período em que não aconteceu nada.
     */
    pessoas: Number(resumo?.pessoas ?? 0),
    maisAntigo: resumo?.mais_antigo ?? null,
    truncado,
    linhas: linhas.map((l) => ({
      id: Number(l.id),
      quando: l.created_at,
      entidade: l.entity,
      entidadeId: l.entity_id,
      acao: l.action,
      antes: l.before,
      depois: l.after,
      ip: l.ip,
      autor: l.user_id
        ? {
            id: l.user_id,
            // o nome atual quando a pessoa ainda está na equipe; o e-mail
            // carimbado na hora do ato quando ela saiu
            nome: l.autor_nome ?? l.actor_email ?? 'usuário removido',
            email: l.actor_email,
            removido: !!l.autor_removido,
          }
        : null,
    })),
  }
})
