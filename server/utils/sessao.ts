/**
 * Sessão de login: criar, ler, renovar, encerrar.
 *
 * Três decisões que valem mais que o código:
 *
 * 1. **O cookie carrega o segredo; o banco guarda o hash.** Dump, log de
 *    query e backup vazado não viram acesso. O segredo existe uma vez só, na
 *    resposta do login.
 *
 * 2. **30 dias com renovação deslizante.** Quem usa todo dia nunca é
 *    deslogado; quem some 30 dias precisa entrar de novo. A alternativa curta
 *    já foi testada na prática e o resultado foi a equipe caindo no meio do
 *    expediente — inclusive a portaria, às 2h da manhã, com fila na frente.
 *
 * 3. **SameSite=Lax em vez de token CSRF separado.** Um token CSRF com prazo
 *    próprio expira ANTES da sessão e devolve 403 em todo salvamento, com o
 *    usuário logado e sem entender o motivo. Lax já bloqueia POST vindo de
 *    outro site, e a checagem de origem abaixo fecha o resto — sem um segundo
 *    relógio pra desencontrar do primeiro.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { isIP } from 'node:net'
import { getRequestHeader, type H3Event } from 'h3'
import { q, q1, tx } from './db'
import { ehPapel, papelDoRoleLegado, type Papel } from './papeis'

export const COOKIE = 'dt_sessao'
const DIAS = 30
const RENOVA_APOS_MIN = 60 // só mexe no banco se a última visita foi há mais de 1h

/**
 * Duas colunas dizem o papel da MESMA pessoa, e elas não querem dizer a mesma
 * coisa. Enquanto a sessão carregava só uma, a tela mostrava um papel e o
 * servidor decidia por outro — medido: quem é `financeiro` aparecia como
 * "admin" no menu do canto, porque `roleLegado('financeiro') = 'admin'`.
 *
 * Agora as duas viajam juntas, com nome que diz qual é qual:
 *
 * - `papelFino` é `users.papel` — a MESMA coluna que o `middleware/03.papel.ts`
 *   lê pra decidir cada rota. É este que a tela mostra e o que qualquer código
 *   novo deve usar.
 * - `papel` é `users.role`, a grade GROSSA e legada, que só o porteiro antigo
 *   (`middleware/01.autenticacao.ts`) e o `exigir()` daqui de baixo entendem.
 *   O vocabulário dela é outro (`admin`, `operacional`) e as duas palavras que
 *   coincidem não significam o mesmo: `financeiro` fino chega no evento,
 *   `financeiro` legado não. Passar um no lugar do outro tranca gente pra fora
 *   sem erro nenhum aparecer.
 */
export type Sessao = {
  /** `sessions.id` desta sessão — é o que a troca de senha preserva ao derrubar as outras */
  sessaoId: string
  usuarioId: string
  orgId: string
  nome: string
  email: string
  /** `users.papel` — a grade fina, a mesma que tranca a rota. Use este. */
  papelFino: Papel
  /** `users.role` — legado. Só `podeFazer`/`exigir` e o porteiro 01 leem. */
  papel: PapelLegado
}

/**
 * O vocabulário de `users.role`, a grade GROSSA. **Não é o `Papel`** da grade
 * fina (`utils/papeis.ts`): as palavras que coincidem não querem dizer a
 * mesma coisa (`financeiro` fino chega no evento, `financeiro` legado não).
 *
 * O nome tem "Legado" porque este arquivo e o `papeis.ts` moram os dois em
 * `server/utils`, que o Nitro varre pra montar o auto-import — e dois arquivos
 * exportando `Papel` faziam o build avisar
 * `Duplicated imports "Papel", the one from papeis.ts has been ignored`.
 * Ninguém dependia do nome solto, mas o dia em que alguém escrevesse `Papel`
 * sem importar levaria o tipo LEGADO em silêncio, com sete valores onde a
 * grade fina tem quatro — e `papelPode(papel, 'dinheiro')` com um `admin`
 * dentro não é erro de compilação, é `false` em produção.
 */
export type PapelLegado =
  | 'master' | 'admin' | 'financeiro' | 'marketing' | 'operacional' | 'portaria' | 'leitura'

const hash = (t: string) => createHash('sha256').update(t).digest('hex')

/** Cria a sessão e devolve o segredo que vai pro cookie (só existe aqui). */
export async function abrirSessao(event: H3Event, usuarioId: string) {
  const segredo = randomBytes(32).toString('base64url')
  const expira = new Date(Date.now() + DIAS * 86_400_000)

  await q1(
    `INSERT INTO sessions (user_id, token_hash, expires_at, user_agent, ip)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [usuarioId, hash(segredo), expira,
     getRequestHeader(event, 'user-agent')?.slice(0, 300) ?? null, ipDaRequisicao(event)])

  await q1(`UPDATE users SET last_login_at = now() WHERE id = $1 RETURNING id`, [usuarioId])

  /*
   * Entrar escreve UM `Set-Cookie`, e isso é decisão, não descuido.
   *
   * A tentação é varrer aqui o resíduo dos outros caminhos, como o `sair` faz.
   * Medido: com os `Max-Age=0` na frente, a resposta do login passa a começar
   * por `Set-Cookie: dt_sessao=; Max-Age=0; Path=/api` — e TODO helper de
   * login deste repositório (e o `/tmp/dt.sh`) pega o PRIMEIRO cabeçalho
   * `dt_sessao=` da lista, que vira string vazia. Navegador aplica os cinco e
   * não se importa; a suíte inteira entra sem cookie e responde 401.
   *
   * Quem varre resíduo é o `sair` (ver `CAMINHOS_DO_COOKIE`), e desde
   * `lerSessao` olhar a lista inteira o resíduo deixou de esconder sessão
   * viva — que era o estrago de verdade.
   */
  setCookie(event, COOKIE, segredo, {
    httpOnly: true,
    sameSite: 'lax',
    // Em desenvolvimento o dev server é http://localhost; marcar secure aqui
    // faria o navegador descartar o cookie em silêncio e o login "não
    // funcionaria" sem nenhuma mensagem de erro.
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    expires: expira,
  })
  return segredo
}

/**
 * Lê a sessão do cookie. Devolve null se não existe, expirou ou foi revogada.
 *
 * ## Por que ela olha TODOS os `dt_sessao`, e não o primeiro
 *
 * `encerrarSessao` já revogava por todos os valores do cabeçalho; esta aqui
 * continuava em `getCookie`, que devolve UM — o primeiro. A assimetria tinha
 * preço, e ele foi MEDIDO no servidor no ar, com a sessão viva no banco:
 *
 *     Cookie: dt_sessao=<resíduo>; dt_sessao=<bom>
 *     GET /api/auth/eu   -> {"usuario":null}
 *     GET /admin         -> 302 /entrar?de=/admin
 *     banco              -> sessions.revoked_at NULL (a sessão está DE PÉ)
 *
 * Ou seja: o login respondia 200, gravava a linha, escrevia o cookie em
 * `Path=/` — e o navegador continuava mandando o resíduo na frente (RFC 6265
 * §5.4: caminho mais específico primeiro), então a próxima página jogava a
 * pessoa de volta pro `/entrar`. Entrar de novo repete tudo: laço de login
 * sem nenhuma mensagem de erro, com o sistema achando que ninguém tentou.
 *
 * A ordem do cabeçalho é mantida de propósito: quando o primeiro cookie é uma
 * sessão boa, quem entra é exatamente quem `getCookie` escolheria. Isto aqui
 * só passa a enxergar o que antes ficava invisível — nada que já funcionava
 * muda de dono.
 */
export async function lerSessao(event: H3Event): Promise<Sessao | null> {
  const segredos = segredosDoCookie(event)
  if (!segredos.length) return null

  // hash -> segredo, na ordem em que vieram no cabeçalho
  const porHash = new Map(segredos.map((s) => [hash(s), s]))
  const hashes = [...porHash.keys()]

  const linhas = await q<any>(
    `SELECT s.id, s.token_hash, s.last_seen_at, u.id AS uid, u.org_id, u.name, u.email,
            u.papel, u.role, u.active
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ANY($1::text[])
        AND s.revoked_at IS NULL
        AND s.expires_at > now()`,
    [hashes])

  // Usuário desativado perde o acesso na hora, sem precisar revogar sessão a
  // sessão: a checagem é no `active` do usuário, na leitura.
  const posicao = new Map(hashes.map((h, i) => [h, i]))
  const linha = linhas
    .filter((l) => l.active)
    .sort((a, b) => (posicao.get(a.token_hash) ?? 0) - (posicao.get(b.token_hash) ?? 0))[0]
  if (!linha) return null
  const segredo = porHash.get(linha.token_hash)!

  // Renovação deslizante — mas só de hora em hora. Escrever no banco a cada
  // requisição transformaria a tabela de sessões no ponto mais quente do
  // sistema por nada.
  const minutos = (Date.now() - new Date(linha.last_seen_at).getTime()) / 60_000
  if (minutos > RENOVA_APOS_MIN) {
    const expira = new Date(Date.now() + DIAS * 86_400_000)
    await q1(
      `UPDATE sessions SET last_seen_at = now(), expires_at = $2 WHERE id = $1 RETURNING id`,
      [linha.id, expira])
    setCookie(event, COOKIE, segredo, {
      httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production',
      path: '/', expires: expira,
    })
  }

  return {
    sessaoId: linha.id,
    usuarioId: linha.uid, orgId: linha.org_id, nome: linha.name,
    email: linha.email,
    // Linha antiga que a migração 012 não alcançou (banco de cópia, restore
    // parcial) cai no papel derivado do `role` — a mesma regra do
    // `middleware/03.papel.ts`, pra sessão e porteiro nunca discordarem.
    papelFino: ehPapel(linha.papel) ? linha.papel : papelDoRoleLegado(linha.role),
    papel: linha.role as PapelLegado,
  }
}

/**
 * TODO valor de `dt_sessao` que veio no cabeçalho — não só o primeiro.
 *
 * `getCookie` devolve UM: o `Cookie:` é um cabeçalho de texto e o parser fica
 * com a primeira ocorrência do nome. O navegador manda mais de uma quando
 * existem cookies de mesmo nome com `Path` diferente (resto de build antigo,
 * por exemplo) e ordena o de caminho MAIS ESPECÍFICO na frente (RFC 6265 §5.4).
 * Resultado medido no servidor no ar, antes disto:
 *
 *     POST /api/auth/sair   Cookie: dt_sessao=<lixo>; dt_sessao=<real>  -> 200 {ok:true}
 *     GET  /api/auth/eu     Cookie: dt_sessao=<real>                    -> "Dono" (master)
 *     GET  /admin           Cookie: dt_sessao=<real>                    -> renderizou o painel
 *     banco: sessions.revoked_at do token real                          -> NULL
 *
 * Ou seja: a tela disse que saiu, e a sessão continuou de pé — o `UPDATE`
 * tinha casado o hash do LIXO e alterado zero linha, em silêncio.
 */
function segredosDoCookie(event: H3Event): string[] {
  const bruto = getRequestHeader(event, 'cookie') ?? ''
  const achados: string[] = []
  for (const pedaco of bruto.split(';')) {
    const p = pedaco.trim()
    if (!p.startsWith(COOKIE + '=')) continue
    const cru = p.slice(COOKIE.length + 1)
    if (!cru) continue
    // valor com `%` torto derruba o decode; o valor cru ainda pode ser o token
    try { achados.push(decodeURIComponent(cru)) } catch { achados.push(cru) }
    achados.push(cru)
  }
  const doH3 = getCookie(event, COOKIE)
  if (doH3) achados.push(doH3)
  return [...new Set(achados.filter(Boolean))]
}

/**
 * Caminhos em que o cookie de sessão é apagado no navegador.
 *
 * Apagar cookie é escrever OUTRO com `Max-Age=0`, e o navegador só considera
 * que é o mesmo quando nome + domínio + **caminho** batem. Limpar só `Path=/`
 * deixa em pé qualquer `dt_sessao` gravado com caminho mais específico — e é
 * justamente ele que o navegador manda no documento de `/admin` e não manda na
 * chamada de `/api`, que foi como "saiu" e "continua logado" conviveram na
 * mesma aba. O código de hoje grava só em `/`; os outros são resíduo de build
 * antigo, e resíduo que ninguém apaga é sessão que ninguém encerra.
 */
const CAMINHOS_DO_COOKIE = ['/', '/api', '/api/auth', '/admin', '/entrar']

export type SaidaDaSessao = {
  /** linhas de `sessions` que ESTE pedido revogou agora */
  revogadas: number
  /** quantos `dt_sessao` vieram no cabeçalho (mais de um = resíduo) */
  tokensNoCookie: number
  /** dono das linhas revogadas, quando deu pra saber */
  usuarioId: string | null
}

/**
 * Encerra a sessão deste navegador: revoga no BANCO e apaga o cookie.
 *
 * Duas garantias que a versão anterior não dava:
 *
 * 1. **Revoga toda linha que o pedido carrega**, não a do primeiro cookie que
 *    o parser achou. `token_hash = ANY(...)` com todos os valores de
 *    `dt_sessao` do cabeçalho.
 * 2. **Devolve quantas revogou.** Zero não é mais silêncio: `sair.post.ts` usa
 *    isso pra só responder "saiu" depois de conferir que ninguém mais entra.
 *
 * `todosOsAparelhos` fica DESLIGADO de propósito — ver `encerrarTodas`.
 */
export async function encerrarSessao(
  event: H3Event,
  opcoes: { todosOsAparelhos?: boolean } = {},
): Promise<SaidaDaSessao> {
  const segredos = segredosDoCookie(event)
  let revogadas = 0
  let usuarioId: string | null = null

  if (segredos.length) {
    const linhas = await q<{ id: string; user_id: string }>(
      `UPDATE sessions SET revoked_at = now()
        WHERE token_hash = ANY($1::text[]) AND revoked_at IS NULL
        RETURNING id, user_id`,
      [segredos.map(hash)])
    revogadas = linhas.length
    usuarioId = linhas[0]?.user_id ?? null
  }

  if (opcoes.todosOsAparelhos && usuarioId) revogadas += await encerrarTodas(usuarioId)

  for (const path of CAMINHOS_DO_COOKIE) deleteCookie(event, COOKIE, { path })

  return { revogadas, tokensNoCookie: segredos.length, usuarioId }
}

/**
 * Encerra TODAS as sessões do usuário (troca de senha, suspeita de vazamento).
 * Devolve quantas caíram.
 *
 * **Onde ligar**: na rota que troca a senha e na que desativa o acesso — ali
 * derrubar tudo é o ponto. No `sair` do dia a dia ela fica DESLIGADA: quem
 * sai do computador do guichê não espera perder a sessão do celular do portão,
 * e isso é decisão do dono, não da implementação. Pra ligar mesmo assim, o
 * caminho já está pronto e é uma linha:
 *
 *     await encerrarSessao(event, { todosOsAparelhos: true })   // em sair.post.ts
 */
export async function encerrarTodas(usuarioId: string): Promise<number> {
  const linhas = await q<{ id: string }>(
    `UPDATE sessions SET revoked_at = now()
      WHERE user_id = $1 AND revoked_at IS NULL RETURNING id`, [usuarioId])
  return linhas.length
}

/* ------------------------------------------------------------------ freio */

/** Janela do freio e os três tetos. Ver `travadoPorTentativas`. */
export const FREIO = {
  /** o mesmo e-mail, errando do MESMO endereço */
  porEmailEIp: 8,
  /** o mesmo e-mail, somando TODOS os endereços — só ataque distribuído chega aqui */
  porEmail: 50,
  /** o mesmo endereço, somando todos os e-mails */
  porIp: 30,
} as const

/**
 * Força bruta: conta as falhas recentes (15 min) em três baldes.
 *
 * O balde principal é **e-mail + IP**. Até 22/09 era o e-mail sozinho, com 8
 * falhas — e aí qualquer um, de qualquer lugar, trancava o DONO pra fora do
 * painel digitando oito senhas erradas no e-mail dele, e a senha certa passava
 * a receber 429 também. Freio que o atacante usa como arma é pior que freio
 * nenhum. Com o par, quem erra tranca só o próprio aparelho.
 *
 * Os outros dois cobrem o que o par sozinho deixaria passar:
 * - **por e-mail, teto alto (50)** — o mesmo alvo atacado de muitos IPs
 *   (botnet). Ainda dá pra trancar o dono assim, mas custa 50 endereços em 15
 *   minutos, não um script de oito linhas;
 * - **por IP (30)** — um endereço testando a mesma senha em mil contas.
 */
export async function travadoPorTentativas(email: string, ip: string | null) {
  // `IS NOT DISTINCT FROM`: sem IP conhecido, o balde é o dos "sem IP" — e
  // não o e-mail inteiro, que era o defeito.
  const porPar = await q1<any>(
    `SELECT count(*)::int AS n FROM login_attempts
      WHERE email = $1 AND ip IS NOT DISTINCT FROM $2
        AND ok = false AND at > now() - interval '15 minutes'`, [email, ip])
  if (Number(porPar.n) >= FREIO.porEmailEIp) {
    return 'Muitas tentativas erradas para este e-mail a partir deste aparelho. '
      + 'Tente de novo em 15 minutos.'
  }

  const porEmail = await q1<any>(
    `SELECT count(*)::int AS n FROM login_attempts
      WHERE email = $1 AND ok = false AND at > now() - interval '15 minutes'`, [email])
  if (Number(porEmail.n) >= FREIO.porEmail) {
    return 'Muitas tentativas erradas para este e-mail. Tente de novo em 15 minutos.'
  }

  if (ip) {
    const porIp = await q1<any>(
      `SELECT count(*)::int AS n FROM login_attempts
        WHERE ip = $1 AND ok = false AND at > now() - interval '15 minutes'`, [ip])
    if (Number(porIp.n) >= FREIO.porIp) return 'Muitas tentativas deste endereço. Tente de novo em 15 minutos.'
  }
  return null
}

export async function registrarTentativa(email: string, ip: string | null, ok: boolean) {
  await q1(`INSERT INTO login_attempts (email, ip, ok) VALUES ($1,$2,$3) RETURNING id`,
    [email, ip, ok])
}

/**
 * O IP de quem fez a requisição — o que o freio conta e a auditoria carimba.
 *
 * Cabeçalho de IP é texto que o CLIENTE escreve. Confiar em `cf-connecting-ip`
 * sempre (como era) deixava qualquer um mandar um IP novo a cada tentativa e
 * nunca encher balde nenhum. Então só se lê cabeçalho quando o dono DECLARA que
 * existe um proxy na frente que sobrescreve o valor: `CONFIAR_PROXY=1`.
 *
 * Com proxy declarado: `cf-connecting-ip` (Cloudflare) e, sem ele, o ÚLTIMO
 * item do `x-forwarded-for` — o que o nosso proxy acrescentou; os da esquerda
 * vieram do cliente. Valor que não é IP cai no socket.
 */
export function ipDaRequisicao(event: H3Event): string | null {
  const socket = event.node?.req?.socket?.remoteAddress ?? null
  if (process.env.CONFIAR_PROXY !== '1') return socket

  const cf = getRequestHeader(event, 'cf-connecting-ip')?.trim()
  if (cf && isIP(cf)) return cf

  const xff = getRequestHeader(event, 'x-forwarded-for')
  const ultimo = xff?.split(',').map((s) => s.trim()).filter(Boolean).pop()
  if (ultimo && isIP(ultimo)) return ultimo

  return socket
}

/* ------------------------------------------------------------------ papéis */

/** O que cada papel pode fazer. Deny-by-default: não listado = não pode. */
const PODE: Record<PapelLegado, string[]> = {
  master:      ['*'],
  admin:       ['evento', 'ingresso', 'venda', 'cortesia', 'cupom', 'promoter',
                'relatorio', 'financeiro', 'portaria', 'equipe'],
  financeiro:  ['relatorio', 'financeiro', 'venda'],
  marketing:   ['cupom', 'promoter', 'relatorio'],
  operacional: ['evento', 'ingresso', 'venda', 'cortesia', 'portaria'],
  portaria:    ['portaria'],
  leitura:     ['relatorio'],
}

export const podeFazer = (papel: PapelLegado, area: string) =>
  PODE[papel]?.includes('*') || PODE[papel]?.includes(area) || false

/** Igual a `lerSessao`, mas explode com 401/403 em vez de devolver null. */
export async function exigir(event: H3Event, area?: string): Promise<Sessao> {
  const s = await lerSessao(event)
  if (!s) throw createError({ statusCode: 401, statusMessage: 'Faça login para continuar' })
  if (area && !podeFazer(s.papel, area)) {
    throw createError({
      statusCode: 403,
      statusMessage: `Seu acesso (${s.papel}) não inclui ${area}.`,
    })
  }
  return s
}

/** Comparação de segredo em tempo constante, pros casos fora do bcrypt. */
export function iguais(a: string, b: string) {
  const x = Buffer.from(a), y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}
