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
import { createError, getRequestHeader, setResponseHeader, type H3Event } from 'h3'
import { q, q1, tx } from './db'
import { ehPapel, papelDoRoleLegado, RECADO_DA_PORTARIA, type Papel } from './papeis'

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
export async function travadoPorTentativas(
  email: string, ip: string | null,
  /**
   * `ipConfiavel: false` quando o IP é o do PROXY, não o de quem digitou (ver
   * `origemDaRequisicao`): aí os baldes por IP virariam baldes da casa inteira
   * — 8 erros de qualquer um trancariam o dono, 30 trancariam a equipe toda,
   * portaria incluída. Sem saber quem é quem, sobra o teto por e-mail (50),
   * que um script de oito linhas não usa como arma. A falta do `CONFIAR_PROXY`
   * grita no boot e em `/api/saude`; isto só impede que ela tranque o parque.
   */
  opcoes: { ipConfiavel?: boolean } = {},
) {
  const ipConfiavel = opcoes.ipConfiavel !== false
  // `IS NOT DISTINCT FROM`: sem IP conhecido, o balde é o dos "sem IP" — e
  // não o e-mail inteiro, que era o defeito.
  if (ipConfiavel) {
    const porPar = await q1<any>(
      `SELECT count(*)::int AS n FROM login_attempts
        WHERE email = $1 AND ip IS NOT DISTINCT FROM $2
          AND ok = false AND at > now() - interval '15 minutes'`, [email, ip])
    if (Number(porPar.n) >= FREIO.porEmailEIp) {
      return 'Muitas tentativas erradas para este e-mail a partir deste aparelho. '
        + 'Tente de novo em 15 minutos.'
    }
  }

  const porEmail = await q1<any>(
    `SELECT count(*)::int AS n FROM login_attempts
      WHERE email = $1 AND ok = false AND at > now() - interval '15 minutes'`, [email])
  if (Number(porEmail.n) >= FREIO.porEmail) {
    return 'Muitas tentativas erradas para este e-mail. Tente de novo em 15 minutos.'
  }

  if (ip && ipConfiavel) {
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
 * nunca encher balde nenhum. Então só se lê cabeçalho quando o dono DECLARA
 * qual proxy está na frente:
 *
 *   CONFIAR_PROXY=1           o proxy do EasyPanel (Traefik): vale o ÚLTIMO item
 *                             do `x-forwarded-for` — o que o NOSSO proxy
 *                             acrescentou; os da esquerda vieram do cliente.
 *   CONFIAR_PROXY=cloudflare  Cloudflare na frente: vale `cf-connecting-ip`
 *                             (e, sem ele, o último do `x-forwarded-for`).
 *
 * Até 27/09 o `=1` lia `cf-connecting-ip` primeiro (B05): sem Cloudflare de
 * verdade na frente, o cliente escrevia um IP novo nesse cabeçalho a cada
 * tentativa e o freio por IP sumia. Valor que não é IP cai no socket.
 */
export function ipDaRequisicao(event: H3Event): string | null {
  return origemDaRequisicao(event).ip
}

/** Rede interna: a conexão veio de um proxy nosso, não de alguém na internet. */
export function ipDeRedeInterna(ip: string | null | undefined): boolean {
  const s = String(ip ?? '').replace(/^::ffff:/i, '').toLowerCase()
  if (isIP(s) === 4) {
    const [a, b] = s.split('.').map(Number)
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127)
  }
  if (isIP(s) === 6) return s === '::1' || /^f[cd]/.test(s) || /^fe[89ab]/.test(s)
  return false
}

/** A própria máquina: servidor de teste, E2E, HEALTHCHECK do contêiner. */
export function ipLocal(ip: string | null | undefined): boolean {
  const s = String(ip ?? '').replace(/^::ffff:/i, '')
  return s === '::1' || s.startsWith('127.')
}

let avisouProxy = false

/**
 * O IP e se dá pra confiar nele como "uma pessoa".
 *
 * `proxySemConfianca` é o estado que o B05 descreve: a conexão chega de um
 * endereço de rede interna, trazendo `x-forwarded-for`, e `CONFIAR_PROXY` não
 * foi ligado — ou seja, há um proxy na frente e o socket é ELE, igual pra todo
 * mundo. Contar freio por esse IP tranca a casa inteira. Só a rede interna
 * conta aqui: de um socket da internet, `x-forwarded-for` é texto do cliente e
 * não rebaixa nada.
 */
export function origemDaRequisicao(event: H3Event): { ip: string | null; proxySemConfianca: boolean } {
  const socket = event.node?.req?.socket?.remoteAddress ?? null
  const modo = String(process.env.CONFIAR_PROXY ?? '').trim().toLowerCase()
  const xff = getRequestHeader(event, 'x-forwarded-for')

  if (modo !== '1' && modo !== 'cloudflare') {
    const semConfianca = !!xff && ipDeRedeInterna(socket)
    if (semConfianca && !avisouProxy) {
      avisouProxy = true
      console.error('[freio] a requisição chegou por um proxy (x-forwarded-for, de '
        + `${socket}) e CONFIAR_PROXY não está ligado: todo mundo aparece com o mesmo IP. `
        + 'O freio por IP fica desligado até configurar CONFIAR_PROXY=1 (Traefik) '
        + 'ou CONFIAR_PROXY=cloudflare.')
    }
    return { ip: socket, proxySemConfianca: semConfianca }
  }

  if (modo === 'cloudflare') {
    const cf = getRequestHeader(event, 'cf-connecting-ip')?.trim()
    if (cf && isIP(cf)) return { ip: cf, proxySemConfianca: false }
  }
  const ultimo = xff?.split(',').map((s) => s.trim()).filter(Boolean).pop()
  if (ultimo && isIP(ultimo)) return { ip: ultimo, proxySemConfianca: false }
  return { ip: socket, proxySemConfianca: false }
}

/* ------------------------------------------------- freio das portas públicas */

/**
 * O freio de quem COMPRA (B03, B04, B15 — auditoria de 27/09).
 *
 * `/api/checkout`, `/api/cupom/conferir` e `/api/pedido/:id` não exigem login
 * — é a natureza delas — e não tinham freio nenhum. Um script com CPF gerado
 * reservava o estoque inteiro por `hold_minutes` e renovava (o evento "esgotava"
 * com o parque vazio), testava dicionário de cupom e chutava código de pedido
 * sem ninguém perceber.
 *
 * Cinco baldes, por IP, em memória do processo (com duas instâncias, cada uma
 * conta o seu — freio de abuso, não trava de dinheiro):
 *
 *   checkout            pedidos tentados      20 a cada 10 min
 *   checkout_ingressos  ingressos reservados  1500 a cada 20 min (o que segura estoque)
 *   cupom               conferências de cupom 30 a cada 10 min
 *   cupom_errado        código que não existe 10 a cada 15 min  (dicionário)
 *   pedido_404          pedido que não existe 20 a cada 10 min  (enumeração)
 *
 * Os números cabem uma família numa rede de Wi-Fi compartilhada (o do parque,
 * o do celular com CGNAT) e barram o script no primeiro minuto. Cada um muda
 * por ambiente — `FREIO_CHECKOUT=20/600` (limite/segundos), `0` desliga.
 *
 * Duas isenções, as duas porque o IP ali não é de uma pessoa:
 *   • a própria máquina (127.0.0.1, ::1) — a suíte e o E2E compram centenas de
 *     vezes em sequência, e o HEALTHCHECK do contêiner bate daqui;
 *   • proxy na frente sem `CONFIAR_PROXY`: aí todo mundo tem o IP do proxy, e
 *     frear esse IP seria tirar o site do ar pro Brasil inteiro depois de 20
 *     compras. Fica desligado, e a falta grita no log e em `/api/saude`.
 */
export type NomeDoFreio = 'checkout' | 'checkout_ingressos' | 'cupom' | 'cupom_errado' | 'pedido_404'
  | 'conta_entrar' | 'conta_criar' | 'conta_link'

export const FREIO_PUBLICO_PADRAO: Record<NomeDoFreio, { limite: number; janelaSeg: number }> = {
  checkout: { limite: 20, janelaSeg: 600 },
  // 3 compras do tamanho máximo (05/10: quem limita a compra é o estoque — `limite-de-compra.ts`)
  checkout_ingressos: { limite: 1500, janelaSeg: 1200 },
  cupom: { limite: 30, janelaSeg: 600 },
  cupom_errado: { limite: 10, janelaSeg: 900 },
  pedido_404: { limite: 20, janelaSeg: 600 },
  // a conta do cliente (034): errar senha é humano; criar trinta contas do mesmo endereço, não
  conta_entrar: { limite: 30, janelaSeg: 900 },
  conta_criar: { limite: 10, janelaSeg: 3600 },
  // "esqueci a senha", reenviar confirmação e abrir os links (035): cada pedido pode virar e-mail
  conta_link: { limite: 10, janelaSeg: 900 },
}

const VARIAVEL_DO_FREIO: Record<NomeDoFreio, string> = {
  checkout: 'FREIO_CHECKOUT',
  checkout_ingressos: 'FREIO_CHECKOUT_INGRESSOS',
  cupom: 'FREIO_CUPOM',
  cupom_errado: 'FREIO_CUPOM_ERRADO',
  pedido_404: 'FREIO_PEDIDO_404',
  conta_entrar: 'FREIO_CONTA_ENTRAR',
  conta_criar: 'FREIO_CONTA_CRIAR',
  conta_link: 'FREIO_CONTA_LINK',
}

/** A regra valendo: a do ambiente (`20/600`, ou `0` pra desligar) ou a padrão. */
export function regraDoFreio(
  nome: NomeDoFreio, env: Record<string, string | undefined> = process.env,
): { limite: number; janelaSeg: number } | null {
  const cru = String(env[VARIAVEL_DO_FREIO[nome]] ?? '').trim()
  if (cru === '0') return null
  const m = cru.match(/^(\d+)\s*\/\s*(\d+)$/)
  if (m && Number(m[1]) > 0 && Number(m[2]) > 0) return { limite: Number(m[1]), janelaSeg: Number(m[2]) }
  if (cru) console.warn(`[freio] ${VARIAVEL_DO_FREIO[nome]}="${cru}" não é "limite/segundos"; usando o padrão`)
  return FREIO_PUBLICO_PADRAO[nome]
}

/**
 * A janela deslizante, pura: sem relógio embutido e sem IP embutido, pra o
 * teste provar a conta sem esperar dez minutos.
 */
export class JanelaDeFreio {
  private marcas = new Map<string, Array<{ t: number; peso: number }>>()
  private chamadas = 0

  private vivas(chave: string, janelaMs: number, agora: number) {
    const lista = (this.marcas.get(chave) ?? []).filter((m) => m.t > agora - janelaMs)
    if (lista.length) this.marcas.set(chave, lista)
    else this.marcas.delete(chave)
    return lista
  }

  /** Quanto já foi gasto na janela. */
  usado(chave: string, janelaMs: number, agora = Date.now()): number {
    return this.vivas(chave, janelaMs, agora).reduce((s, m) => s + m.peso, 0)
  }

  /** Cabe `peso` a mais sem passar do limite? Se não, em quantos segundos cabe. */
  cabe(chave: string, limite: number, janelaMs: number, peso = 1, agora = Date.now()):
    { ok: true } | { ok: false; esperarSeg: number } {
    const lista = this.vivas(chave, janelaMs, agora)
    let usado = lista.reduce((s, m) => s + m.peso, 0)
    if (usado + peso <= limite) return { ok: true }
    // espera até sair da janela o bastante pra caber
    for (const m of lista) {
      usado -= m.peso
      if (usado + peso <= limite) {
        return { ok: false, esperarSeg: Math.max(1, Math.ceil((m.t + janelaMs - agora) / 1000)) }
      }
    }
    return { ok: false, esperarSeg: Math.ceil(janelaMs / 1000) }
  }

  marcar(chave: string, peso = 1, agora = Date.now()) {
    const lista = this.marcas.get(chave) ?? []
    lista.push({ t: agora, peso })
    this.marcas.set(chave, lista)
    // Faxina de tempos em tempos: chave de IP que sumiu não fica na memória.
    if (++this.chamadas % 1000 === 0) {
      const maisLonga = Math.max(...Object.values(FREIO_PUBLICO_PADRAO).map((r) => r.janelaSeg)) * 2000
      for (const k of [...this.marcas.keys()]) this.vivas(k, maisLonga, agora)
    }
  }

  limpar() { this.marcas.clear() }
}

const janelaPublica = new JanelaDeFreio()

/** Esvazia os baldes do processo — só o teste chama. */
export function esvaziarFreioPublico() { janelaPublica.limpar() }

/**
 * A pergunta do freio pra uma requisição: quem é (IP), se conta, e a regra.
 * `null` = não freia (própria máquina, proxy sem confiança, balde desligado).
 */
function alvoDoFreio(event: H3Event, nome: NomeDoFreio) {
  const regra = regraDoFreio(nome)
  if (!regra) return null
  const { ip, proxySemConfianca } = origemDaRequisicao(event)
  if (!ip || proxySemConfianca || ipLocal(ip)) return null
  return { chave: `${nome}|${ip}`, ip, regra, janelaMs: regra.janelaSeg * 1000 }
}

function recusarPorFreio(event: H3Event, nome: NomeDoFreio, ip: string, esperarSeg: number): never {
  const minutos = Math.max(1, Math.ceil(esperarSeg / 60))
  // O alarme: um endereço batendo no teto é o sinal que a auditoria pediu.
  console.warn(`[freio] ${nome}: ${ip} passou do limite; recusando por ~${minutos} min`)
  setResponseHeader(event, 'Retry-After', String(esperarSeg))
  const recado: Record<NomeDoFreio, string> = {
    checkout: 'Muitas tentativas de compra deste endereço em pouco tempo.',
    checkout_ingressos: 'Muitos ingressos reservados a partir deste endereço em pouco tempo.',
    cupom: 'Muitas conferências de cupom deste endereço em pouco tempo.',
    cupom_errado: 'Muitos códigos de cupom que não existem, deste endereço.',
    pedido_404: 'Muitas consultas de pedido que não existem, deste endereço.',
    conta_entrar: 'Muitas tentativas de entrar deste endereço em pouco tempo.',
    conta_criar: 'Muitas contas criadas a partir deste endereço em pouco tempo.',
    conta_link: 'Muitos pedidos de link (senha ou confirmação) deste endereço em pouco tempo.',
  }
  throw createError({
    statusCode: 429,
    statusMessage: `${recado[nome]} Espere ${minutos} ${minutos === 1 ? 'minuto' : 'minutos'} e tente de novo.`,
    data: { tipo: 'freio', freio: nome, esperarSeg },
  })
}

/** Confere e já GASTA `peso` no balde. Estourado: 429 com `Retry-After`. */
export function frearPortaPublica(event: H3Event, nome: NomeDoFreio, peso = 1) {
  const alvo = alvoDoFreio(event, nome)
  if (!alvo) return
  const r = janelaPublica.cabe(alvo.chave, alvo.regra.limite, alvo.janelaMs, peso)
  if (!r.ok) recusarPorFreio(event, nome, alvo.ip, r.esperarSeg)
  janelaPublica.marcar(alvo.chave, peso)
}

/** Só confere (o gasto vem depois, com `marcarNoFreio`, se o caso acontecer). */
export function conferirFreio(event: H3Event, nome: NomeDoFreio, peso = 1) {
  const alvo = alvoDoFreio(event, nome)
  if (!alvo) return
  // `peso` 1 no mínimo: o balde cheio recusa a próxima, mesmo que ela não gaste
  const r = janelaPublica.cabe(alvo.chave, alvo.regra.limite, alvo.janelaMs, Math.max(1, peso))
  if (!r.ok) recusarPorFreio(event, nome, alvo.ip, r.esperarSeg)
}

/** Gasta sem conferir — o que aconteceu já aconteceu (o 404, o código errado). */
export function marcarNoFreio(event: H3Event, nome: NomeDoFreio, peso = 1) {
  const alvo = alvoDoFreio(event, nome)
  if (!alvo) return
  janelaPublica.marcar(alvo.chave, peso)
}

/** Como o freio está ligado — pra `/api/saude`, sem IP nenhum. */
export function estadoDoFreio(): {
  proxy: 'traefik' | 'cloudflare' | 'nenhum'
  /** já chegou requisição por proxy interno SEM `CONFIAR_PROXY` (o freio por IP está desligado) */
  proxySemConfiancaVisto: boolean
  baldes: Record<string, string>
} {
  const modo = String(process.env.CONFIAR_PROXY ?? '').trim().toLowerCase()
  const baldes: Record<string, string> = {}
  for (const nome of Object.keys(FREIO_PUBLICO_PADRAO) as NomeDoFreio[]) {
    const r = regraDoFreio(nome)
    baldes[nome] = r ? `${r.limite}/${r.janelaSeg}s` : 'desligado'
  }
  return {
    proxy: modo === '1' ? 'traefik' : modo === 'cloudflare' ? 'cloudflare' : 'nenhum',
    proxySemConfiancaVisto: avisouProxy,
    baldes,
  }
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

/**
 * A recusa do porteiro antigo escrita pra quem lê: "Seu acesso (portaria) não inclui evento." era o
 * nome interno do papel e da área, e a portaria — quem mais esbarra nela, de celular na mão, com
 * fila na frente — ficava sem saber pra onde ir (auditoria 28/09). A frase da portaria diz o
 * caminho; a dos outros, a quem pedir. A grade nova (`utils/papeis.ts`) fala do mesmo jeito.
 */
const PAPEL_LEGIVEL: Record<string, string> = {
  master: 'Master', admin: 'Administrador', financeiro: 'Financeiro', marketing: 'Marketing',
  operacional: 'Operação', portaria: 'Portaria', leitura: 'Leitura',
}
const AREA_LEGIVEL: Record<string, string> = {
  evento: 'os eventos e a configuração deles', ingresso: 'os ingressos e lotes',
  venda: 'os pedidos e participantes', cortesia: 'as cortesias', cupom: 'os cupons',
  promoter: 'os promoters', relatorio: 'os relatórios', financeiro: 'o dinheiro do evento',
  portaria: 'o leitor de entrada', equipe: 'a equipe', auditoria: 'a auditoria',
}
export function recusaDeArea(papel: string, area: string): string {
  const oQue = AREA_LEGIVEL[area] ?? area
  if (papel === 'portaria') {
    return `Seu acesso é de Portaria: ele abre só o leitor de entrada, não ${oQue}. ${RECADO_DA_PORTARIA}`
  }
  return `Seu acesso é de ${PAPEL_LEGIVEL[papel] ?? papel} e não inclui ${oQue}. `
    + 'Peça a um master da sua organização.'
}

/** Igual a `lerSessao`, mas explode com 401/403 em vez de devolver null. */
export async function exigir(event: H3Event, area?: string): Promise<Sessao> {
  const s = await lerSessao(event)
  if (!s) throw createError({ statusCode: 401, statusMessage: 'Faça login para continuar' })
  if (area && !podeFazer(s.papel, area)) {
    throw createError({ statusCode: 403, statusMessage: recusaDeArea(s.papel, area) })
  }
  return s
}

/** Comparação de segredo em tempo constante, pros casos fora do bcrypt. */
export function iguais(a: string, b: string) {
  const x = Buffer.from(a), y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}
