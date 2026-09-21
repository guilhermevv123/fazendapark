/**
 * Auditoria — o registro de quem fez o quê, num lugar só.
 *
 * A tabela `audit_log` nasceu no 001 e vinte arquivos escrevem nela, cada um
 * montando o próprio `INSERT`. O resultado medido no banco, antes deste
 * arquivo existir:
 *
 *     912 linhas | 0 com user_id | 0 com ip | 179 sem org_id
 *
 * Nenhuma das 912 linhas dizia **quem**. Metade dos atos resolveu o problema
 * por fora, enfiando o autor dentro do payload — `{"por": "Dono PDV Teste"}`
 * num, `{"emitidoPor": "..."}` noutro, nada no terceiro. Registro assim não
 * é consultável: não dá pra filtrar por pessoa, não dá pra cruzar com a
 * equipe, e quando o produtor pergunta "quem cancelou este ingresso?" a
 * resposta é "alguém, às 21h47".
 *
 * Auditoria precisa responder TRÊS perguntas, e um registro que responde duas
 * não serve pra nada:
 *
 *   - **quem** — usuário, e-mail carimbado e IP;
 *   - **o que mudou** — antes e depois, reduzidos ao que de fato mudou;
 *   - **quando** — `created_at`, que o banco põe sozinho.
 *
 * Três decisões que este arquivo toma, e que só um lugar único consegue
 * tomar:
 *
 * 1. **Sem autor, não grava.** Chamada sem sessão explode em vez de gravar
 *    uma linha anônima. Linha anônima é pior que linha nenhuma: ela ocupa a
 *    tela, parece resposta e não é.
 *
 * 2. **A auditoria anda junto com o ato.** Quando o ato roda numa transação,
 *    o registro entra na MESMA transação (parâmetro `executor`). Gravar por
 *    fora produz os dois desencontros clássicos: o ato deu rollback e a
 *    auditoria ficou dizendo que aconteceu, ou o ato passou e a auditoria
 *    falhou sozinha e ninguém soube.
 *
 * 3. **A linha guarda o estado inteiro; quem reduz é a tela.** A primeira
 *    versão deste arquivo gravava só os campos que mudaram — e o teste pegou
 *    o estrago na hora: num cancelamento de `{codigo, status}` para
 *    `{codigo, status}`, o `codigo` era idêntico, então sumia dos dois lados.
 *    O ingresso ficava sem o código dentro do registro, e a pergunta que
 *    originou esta tela — "quem cancelou o ingresso DT-4K9XQ2?" — deixava de
 *    ter resposta, porque o que se procura é justamente o campo que NÃO
 *    mudou. Reduzir na gravação perde dado pra sempre; reduzir na leitura é
 *    de graça. `diferenca()` continua aqui, mas só pra decidir se houve ato.
 */
import type { H3Event } from 'h3'
import type { PoolClient } from 'pg'
import { q1 } from './db'
import { ipDaRequisicao } from './sessao'

/** Quem fez. Vem da sessão assinada, nunca do corpo da requisição. */
export type Autor = {
  usuarioId: string
  orgId: string
  /** carimbado na linha: o usuário pode ser removido, a evidência não */
  email: string
  ip: string | null
}

export type AtoAuditado = {
  autor: Autor
  /** o que foi mexido: `order`, `ingresso`, `lote`, `payout`, `turno`… */
  entidade: string
  /** o id do que foi mexido; `null` só quando o ato não tem alvo único */
  entidadeId: string | null
  /** o que foi feito: `cancelado`, `estornado`, `venda_balcao`, `editado`… */
  acao: string
  /** estado anterior — obrigatório em edição e remoção, senão "o que mudou" fica sem metade */
  antes?: Record<string, unknown> | null
  /** estado novo */
  depois?: Record<string, unknown> | null
}

/**
 * Nome de entidade e de ato entram no filtro da tela como valor de
 * `<select>`. Aceitar texto livre faz a lista virar `Ingresso`, `ingresso`,
 * `INGRESSO ` — três opções pro mesmo ato, e o filtro deixando de fora dois
 * terços do que devia trazer. O formato abaixo é o que as 912 linhas antigas
 * já usam; a regra só impede a próxima de divergir.
 */
const NOME_VALIDO = /^[a-z][a-z0-9_]*$/

/** Extrai o autor da requisição. O porteiro já pôs a sessão no contexto. */
export function autorDaRequisicao(event: H3Event): Autor {
  const sessao = (event.context as any)?.sessao
  if (!sessao?.usuarioId || !sessao?.orgId) {
    // Chegar aqui significa rota administrativa fora do porteiro — bug de
    // roteamento, não erro de usuário. Explodir é o certo: o contrário é
    // gravar auditoria anônima e descobrir na investigação.
    throw new Error(
      'auditoria: requisição sem sessão. Toda rota que audita passa pelo porteiro de /api/admin.')
  }
  return {
    usuarioId: sessao.usuarioId,
    orgId: sessao.orgId,
    email: sessao.email,
    ip: ipDaRequisicao(event),
  }
}

/**
 * O que de fato mudou entre dois estados.
 *
 * Devolve `null` quando nada mudou — e aí o ato não vira linha de auditoria.
 * "Fulano editou o lote" numa tela em que ele só abriu e salvou sem mexer em
 * nada é ruído que empurra os atos de verdade pra segunda página.
 *
 * Serve pra DECIDIR se houve ato, não pra escolher o que a linha guarda: a
 * linha guarda tudo o que o chamador passou (ver decisão 3 no alto).
 */
export function diferenca(
  antes: Record<string, unknown>,
  depois: Record<string, unknown>,
): { antes: Record<string, unknown>; depois: Record<string, unknown> } | null {
  const chaves = new Set([...Object.keys(antes ?? {}), ...Object.keys(depois ?? {})])
  const a: Record<string, unknown> = {}
  const d: Record<string, unknown> = {}

  for (const k of chaves) {
    // Comparação por JSON: os valores vêm do banco e da requisição, então
    // data vira string dos dois lados e objeto aninhado compara pelo
    // conteúdo. `===` diria que dois `{a:1}` são diferentes.
    if (JSON.stringify(antes?.[k] ?? null) === JSON.stringify(depois?.[k] ?? null)) continue
    a[k] = antes?.[k] ?? null
    d[k] = depois?.[k] ?? null
  }

  return Object.keys(d).length ? { antes: a, depois: d } : null
}

/**
 * Grava o ato.
 *
 * `executor` é o cliente da transação do ato. Passe SEMPRE que o ato estiver
 * dentro de um `tx()` — é o que faz a auditoria nascer e morrer junto com o
 * que ela descreve.
 *
 * Devolve o id da linha, ou `null` quando não havia mudança nenhuma a
 * registrar.
 */
export async function registrarAuditoria(
  ato: AtoAuditado,
  executor?: PoolClient,
): Promise<number | null> {
  const { autor, entidade, entidadeId, acao } = ato

  if (!autor?.usuarioId || !autor?.orgId) {
    throw new Error(
      `auditoria: ato "${entidade}.${acao}" sem autor. Registro que não diz quem fez não é auditoria.`)
  }
  if (!NOME_VALIDO.test(entidade)) {
    throw new Error(`auditoria: entidade "${entidade}" fora do formato (minúsculas, sem espaço).`)
  }
  if (!NOME_VALIDO.test(acao)) {
    throw new Error(`auditoria: ato "${acao}" fora do formato (minúsculas, sem espaço).`)
  }

  const antes = ato.antes ?? null
  const depois = ato.depois ?? null

  // Com os dois lados na mão dá pra saber se houve ato. Sem mudança nenhuma
  // não há o que registrar — e a linha guarda os dois estados INTEIROS, não
  // só a diferença: o campo que não mudou costuma ser o que identifica a
  // coisa (o código do ingresso), e é por ele que alguém vai procurar.
  if (antes && depois && !diferenca(antes, depois)) return null

  const sql =
    `INSERT INTO audit_log (org_id, user_id, actor_email, entity, entity_id,
                            action, before, after, ip)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9)
     RETURNING id`
  const par = [
    autor.orgId, autor.usuarioId, autor.email ?? null,
    entidade, entidadeId ?? null, acao,
    antes ? JSON.stringify(antes) : null,
    depois ? JSON.stringify(depois) : null,
    autor.ip ?? null,
  ]

  // A transação do ato quando ela existe; o pool só quando o ato não tem
  // transação nenhuma. Trocar um pelo outro é o bug que faz a auditoria
  // sobreviver a um rollback.
  const linha = executor
    ? (await executor.query(sql, par)).rows[0]
    : await q1<{ id: number }>(sql, par)

  return Number(linha!.id)
}
