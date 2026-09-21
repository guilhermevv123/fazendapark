/**
 * Sair do painel — provado onde "saiu" quer dizer alguma coisa: no BANCO, na
 * rota que a tela pergunta (`/api/auth/eu`) e numa página de `/admin`.
 *
 * ## O que foi MEDIDO antes deste conserto (servidor no ar, cookie real)
 *
 * | passo                                   | resposta            |
 * |-----------------------------------------|---------------------|
 * | `POST /api/auth/sair`                   | **200 `{ok:true}`** |
 * | `GET /api/auth/eu` com o cookie bom     | **"Dono" (master)** |
 * | `GET /admin` com o cookie bom           | **200, painel inteiro** |
 * | `sessions.revoked_at` do token bom      | **NULL**            |
 *
 * A rota dizia que tinha saído e a sessão continuava de pé — viva pelos 30
 * dias da renovação deslizante, no computador do guichê, pra quem sentasse
 * depois.
 *
 * ## Por que o cookie vem DUPLICADO nos casos daqui
 *
 * Não é malícia: é o que o navegador faz quando existem dois cookies de mesmo
 * nome e caminhos diferentes (resto de build antigo). O de caminho mais
 * específico vai na FRENTE (RFC 6265 §5.4), e `getCookie` fica com o primeiro.
 * O `UPDATE ... WHERE token_hash = <hash do primeiro>` então casava zero linha
 * e não levantava erro nenhum — a falha muda que este projeto já conhece.
 *
 * Arrancar a correção (voltar a revogar só `getCookie(event, COOKIE)`, ou
 * apagar a conferência de `sair.post.ts`) deixa os dois primeiros casos
 * VERMELHOS. Medido por mutação, não por esperança.
 *
 * Fixtura própria, id fixo, apagada no fim. Servidor fora do ar: PULA.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { q, q1 } from './db'

const BASE = process.env.BASE_TESTE ?? 'http://localhost:3100'
const SENHA = 'diamond123'
const PRAZO = 20_000

/**
 * Login só deste arquivo — e-mail próprio, como nos outros.
 *
 * Usar `dono@fazendapark.com.br` amarraria estes casos ao e-mail que a suíte
 * inteira usa: o freio de força bruta conta oito falhas por e-mail em quinze
 * minutos, e revogar sessão do dono no meio de outra trilha derrubaria o
 * login dela. Aqui a sessão que morre é sempre uma que este arquivo abriu.
 */
const EU = {
  id: '00000000-0000-4000-8000-0000000013b0',
  email: 'saida.sessao@teste.local',
}

let noAr = false

/**
 * Login de verdade; devolve o segredo do cookie (o valor, sem o nome).
 *
 * Insiste APENAS quando o servidor não respondeu ou devolveu 5xx: o `nuxt dev`
 * reinicia a cada arquivo salvo e, com mais gente mexendo no repositório, essa
 * janela cai no meio da medição — `login ... falhou (500)` derruba o caso por
 * um motivo que não é o que ele mede. Recusa de verdade (401, 409) e freio de
 * força bruta (429) estouram na primeira: essas SÃO a resposta do sistema.
 */
async function entrar(): Promise<string> {
  let ultimo = ''
  for (let tentativa = 1; tentativa <= 3; tentativa++) {
    let r: Response
    try {
      r = await fetch(`${BASE}/api/auth/entrar`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: EU.email, senha: SENHA }),
      })
    } catch (e: any) {
      ultimo = `o servidor não respondeu (${e?.message ?? e})`
      await new Promise((espera) => setTimeout(espera, 500 * tentativa))
      continue
    }
    if (!r.ok) {
      ultimo = `login de ${EU.email} falhou (${r.status})`
      if (r.status < 500) throw new Error(ultimo)
      await new Promise((espera) => setTimeout(espera, 500 * tentativa))
      continue
    }
    const cru = (r.headers.getSetCookie?.() ?? [])
      .map((c) => c.split(';')[0]).find((c) => c.startsWith('dt_sessao='))
    if (!cru) throw new Error('login não devolveu cookie de sessão')
    return cru.slice('dt_sessao='.length)
  }
  throw new Error(`${ultimo} — três vezes seguidas`)
}

/** A linha daquele token, lida pelo mesmo hash que o servidor grava. */
const linhaDaSessao = (segredo: string) => q1<any>(
  `SELECT id, revoked_at FROM sessions WHERE token_hash = encode(sha256($1::bytea), 'hex')`,
  [segredo])

/**
 * Pula de VERDADE quando o servidor está fora do ar.
 *
 * Isto era `if (!noAr) return void console.warn(...)` em cada caso — e o
 * vitest conta `return` como ✓. É a mesma armadilha que `scripts/test-setup.ts`
 * documenta e que `pdv/venda.test.ts` já tinha fechado: numa corrida de
 * MUTAÇÃO, arrancar a trava e desligar o servidor imprimia "4 passed" sem uma
 * requisição ter saído. `ctx.skip()` sai contado como PULADO, que é o que se
 * lê de longe.
 */
const PORQUE_PULOU = 'servidor de dev fora do ar ou respondendo 500 (porta 3100)'
function seForaDoArPula(ctx: { skip: (motivo?: string) => void }) {
  if (!noAr) ctx.skip(PORQUE_PULOU)
}

beforeAll(async () => {
  try {
    noAr = (await fetch(`${BASE}/api/auth/eu`, { signal: AbortSignal.timeout(4000) })).ok
  } catch { noAr = false }
  if (!noAr) return

  // sobra de corrida anterior não pode travar o login destes casos
  await q(`DELETE FROM login_attempts WHERE email = $1`, [EU.email])
  // a senha é a mesma do dono porque o hash é COPIADO dele: nenhuma senha
  // nova entra no banco por causa de teste
  await q(
    `INSERT INTO users (id, org_id, name, email, password_hash, papel, role)
     SELECT $1, org_id, 'Teste saída de sessão', $2, password_hash, 'master', 'master'
       FROM users WHERE email = 'dono@fazendapark.com.br'
     ON CONFLICT (id) DO UPDATE SET active = true`, [EU.id, EU.email])
}, 30_000)

afterAll(async () => {
  if (!noAr) return
  // o DELETE do usuário leva as sessões dele junto, por cascata
  await q(`DELETE FROM users WHERE id = $1`, [EU.id])
  await q(`DELETE FROM login_attempts WHERE email = $1`, [EU.email])
})

describe('sair do painel é sair mesmo', () => {
  it('com resíduo de cookie na frente, sair revoga a sessão BOA no banco', async (ctx) => {
    seForaDoArPula(ctx)
    const segredo = await entrar()

    const antes = await linhaDaSessao(segredo)
    expect(antes?.revoked_at, 'a sessão nasceu revogada — a fixtura está errada').toBe(null)

    // o navegador manda o de caminho mais específico primeiro; aqui o
    // resíduo é um valor que não casa com linha nenhuma
    const r = await fetch(`${BASE}/api/auth/sair`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: BASE,
        cookie: `dt_sessao=residuo-de-build-antigo; dt_sessao=${segredo}`,
      },
    })
    const corpo = await r.json().catch(() => ({}))
    expect(r.status, JSON.stringify(corpo)).toBe(200)
    expect(corpo.saiu, 'a rota respondeu sem dizer que saiu').toBe(true)
    expect(corpo.sessoesEncerradas,
      'respondeu "saiu" tendo revogado ZERO linha: é a promessa vazia de antes')
      .toBeGreaterThanOrEqual(1)

    const depois = await linhaDaSessao(segredo)
    expect(depois?.revoked_at,
      'a linha da sessão continua sem revoked_at: a sessão segue de pé por 30 dias')
      .not.toBe(null)
  }, PRAZO)

  /**
   * As DUAS testemunhas do enunciado. Uma sozinha não bastava: foi exatamente
   * assim que o defeito passou — `/api/auth/eu` dizia `usuario: null` (o
   * cookie de `Path=/` tinha sido apagado) enquanto `/admin` continuava
   * renderizando o master com o outro cookie.
   */
  it('depois de sair, /api/auth/eu E uma página de /admin concordam que saiu', async (ctx) => {
    seForaDoArPula(ctx)
    const segredo = await entrar()
    const cookie = `dt_sessao=${segredo}`

    // as duas testemunhas ANTES: sem isto, um 302 de /admin por outro motivo
    // (rota que mudou de lugar) passaria por prova de logout
    const euAntes = await fetch(`${BASE}/api/auth/eu`, { headers: { cookie } }).then((x) => x.json())
    expect(euAntes.usuario?.email, 'a sessão nem chegou a abrir').toBe(EU.email)
    const painelAntes = await fetch(`${BASE}/admin`, { headers: { cookie }, redirect: 'manual' })
    expect(painelAntes.status, 'o painel não abriu nem com sessão boa').toBe(200)
    expect(await painelAntes.text(), 'o painel não trouxe o nome de quem está logado')
      .toContain('Teste saída de sessão')

    await fetch(`${BASE}/api/auth/sair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE, cookie },
    })

    const eu = await fetch(`${BASE}/api/auth/eu`, { headers: { cookie } }).then((x) => x.json())
    expect(eu.usuario, '/api/auth/eu ainda conhece quem saiu').toBe(null)

    const painel = await fetch(`${BASE}/admin`, { headers: { cookie }, redirect: 'manual' })
    const html = painel.status === 200 ? await painel.text() : ''
    expect(html,
      '/admin renderizou o painel com o cookie de quem saiu — foi ISTO que aconteceu no ar')
      .not.toContain('Teste saída de sessão')
    expect([302, 401, 403]).toContain(painel.status)
  }, PRAZO)

  /**
   * Apagar cookie é escrever outro com `Max-Age=0`, e o navegador só entende
   * que é o mesmo quando o CAMINHO bate. Limpando só `Path=/`, o `dt_sessao`
   * gravado com caminho mais específico sobrevive — e é ele que vai no
   * documento de `/admin` e não vai na chamada de `/api`.
   */
  it('o cookie é apagado em todos os caminhos plausíveis, não só em /', async (ctx) => {
    seForaDoArPula(ctx)
    const segredo = await entrar()

    const r = await fetch(`${BASE}/api/auth/sair`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json', origin: BASE, cookie: `dt_sessao=${segredo}`,
      },
    })
    const caminhos = (r.headers.getSetCookie?.() ?? [])
      .filter((c) => c.startsWith('dt_sessao='))
      .map((c) => (c.match(/;\s*Path=([^;]+)/i)?.[1] ?? '').trim())

    expect(caminhos, 'sem Path=/ o cookie da sessão de hoje nem é apagado').toContain('/')
    expect(caminhos,
      'o cookie de Path=/admin sobrevive ao logout: é o que o navegador manda no documento '
      + 'do painel e não manda em /api').toContain('/admin')
    for (const c of (r.headers.getSetCookie?.() ?? []).filter((x) => x.startsWith('dt_sessao='))) {
      expect(c, 'o cookie foi reescrito com valor em vez de apagado').toMatch(/Max-Age=0/i)
    }
  }, PRAZO)

  /**
   * A outra metade da decisão: sair NÃO derruba o celular do portão.
   *
   * Derrubar todo aparelho a cada logout é decisão do dono, não da
   * implementação — quem sai do computador do guichê não espera perder a
   * sessão que está lendo QR no portão. `encerrarTodas` fica pronta pra troca
   * de senha, e o caminho de ligar no logout é uma linha
   * (`encerrarSessao(event, { todosOsAparelhos: true })`).
   */
  it('sair no guichê não derruba a sessão do portão (e encerrarTodas está pronta)', async (ctx) => {
    seForaDoArPula(ctx)
    const guiche = await entrar()
    const portao = await entrar()
    expect(guiche, 'os dois logins vieram com o mesmo segredo').not.toBe(portao)

    await fetch(`${BASE}/api/auth/sair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE, cookie: `dt_sessao=${guiche}` },
    })

    expect((await linhaDaSessao(guiche))?.revoked_at, 'o guichê não saiu').not.toBe(null)
    expect((await linhaDaSessao(portao))?.revoked_at,
      'sair no guichê derrubou o aparelho do portão — isso é decisão do dono, não do logout')
      .toBe(null)

    const aindaLe = await fetch(`${BASE}/api/auth/eu`, { headers: { cookie: `dt_sessao=${portao}` } })
      .then((x) => x.json())
    expect(aindaLe.usuario?.email, 'a sessão do portão morreu junto').toBe(EU.email)

    // e a função de derrubar TUDO existe e funciona — é uma linha ligar
    const { encerrarTodas } = await import('./sessao')
    const caidas = await encerrarTodas(EU.id)
    expect(caidas, 'encerrarTodas não derrubou a sessão do portão').toBeGreaterThanOrEqual(1)
    expect((await linhaDaSessao(portao))?.revoked_at).not.toBe(null)
  }, PRAZO)

  /**
   * A OUTRA metade do mesmo defeito de cookie — a que ficou aberta.
   *
   * `encerrarSessao` passou a varrer todos os `dt_sessao` do cabeçalho;
   * `lerSessao` continuava em `getCookie`, que devolve só o primeiro. Com o
   * resíduo na frente, o estrago inverte de lado e fica pior que o do logout,
   * porque a pessoa não tem o que fazer. Medido no servidor no ar, com a
   * sessão ABERTA no banco (`revoked_at IS NULL`):
   *
   *     GET /api/auth/eu  Cookie: dt_sessao=<resíduo>; dt_sessao=<bom>
   *       -> {"usuario":null}
   *     GET /admin        (mesmo cabeçalho)
   *       -> 302 /entrar?de=/admin
   *
   * O login responde 200, grava a linha e escreve o cookie em `Path=/`; o
   * navegador continua mandando o resíduo de `/admin` na FRENTE, e a próxima
   * página devolve a pessoa pro `/entrar`. Laço de login sem erro nenhum na
   * tela, sem linha vermelha no log e sem pista pro suporte — e no guichê,
   * às 21h com fila, isso é "o sistema não deixa eu entrar".
   *
   * Arrancar a correção (voltar `lerSessao` pro `getCookie(event, COOKIE)`)
   * deixa este caso VERMELHO nas duas asserções.
   */
  it('com resíduo na frente, a sessão VIVA continua sendo enxergada (eu + /admin)', async (ctx) => {
    seForaDoArPula(ctx)
    const segredo = await entrar()
    const comResiduo = `dt_sessao=residuo-de-build-antigo; dt_sessao=${segredo}`

    // a testemunha da fixtura: a sessão está mesmo de pé no banco. Sem isto,
    // um 401 por sessão morta passaria por "o resíduo não atrapalha".
    expect((await linhaDaSessao(segredo))?.revoked_at,
      'a sessão nasceu revogada — a fixtura está errada').toBe(null)

    const eu = await fetch(`${BASE}/api/auth/eu`, { headers: { cookie: comResiduo } })
      .then((x) => x.json())
    expect(eu.usuario?.email,
      'com o resíduo na frente, /api/auth/eu diz que ninguém está logado — e a sessão '
      + 'está ABERTA no banco. É o laço de login: entra, é aceito, e volta pro /entrar.')
      .toBe(EU.email)

    const painel = await fetch(`${BASE}/admin`, { headers: { cookie: comResiduo }, redirect: 'manual' })
    expect(painel.status,
      '/admin mandou pro login quem tem sessão viva, por causa de um cookie de outro caminho')
      .toBe(200)
    expect(await painel.text(), 'o painel abriu sem o nome de quem está logado')
      .toContain('Teste saída de sessão')
  }, PRAZO)
})
