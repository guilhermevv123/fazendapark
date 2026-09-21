/**
 * Teste do porteiro.
 *
 * O que ele guarda não é a tela de login — é a promessa de que **rota
 * administrativa nova nasce trancada**. O middleware tranca por prefixo, e o
 * teste abaixo percorre TODAS as rotas sob /api/admin que existem no
 * repositório: se alguém criar uma rota nova e ela responder sem sessão, este
 * teste fica vermelho sozinho, sem ninguém precisar lembrar de adicionar caso.
 *
 * Precisa do servidor de dev no ar. Sem ele, PULA em vez de falhar.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { comSessao, CONTAS, entrar } from '../../scripts/teste-sessao'

const BASE = process.env.BASE_TESTE ?? 'http://localhost:3100'
const SLUG = 'conquista-park-4-edicao'

/**
 * A CONTA DE FIXTURA QUE LEVA A SENHA ERRADA — e por que ela existe.
 *
 * O freio de força bruta (`utils/sessao.ts`, `travadoPorTentativas`) conta
 * falha POR E-MAIL: oito em quinze minutos e aquele e-mail para de logar com
 * 429. A versão anterior deste arquivo errava a senha de
 * `dono@fazendapark.com.br` DE PROPÓSITO — o e-mail com que a suíte inteira
 * faz login.
 *
 * Medido: cada corrida da suíte grava UMA falha no balde do dono (duas, com
 * duas trilhas rodando ao mesmo tempo). Na oitava corrida dentro da mesma
 * janela de 15 minutos o `entrar('master')` do `scripts/teste-sessao.ts`
 * recebe 429, joga `login de teste falhou (429)`, e arquivo que não tem nada
 * a ver com autenticação reprova no `beforeAll`. Aconteceu três vezes
 * durante a frota, e três arquivos (`papeis`, `auditoria`, `relatorios`) já
 * carregam comentário explicando que criaram e-mail próprio pra fugir deste
 * arquivo aqui. O balde era destravado na mão com
 * `DELETE FROM login_attempts`.
 *
 * O conserto não é "não errar senha": o caso PRECISA de uma conta que
 * EXISTE, senão os dois lados da comparação viram "e-mail inexistente" e o
 * teste fica verde sem provar nada. Então a senha errada vai numa conta de
 * fixtura, com balde próprio, apagada no fim.
 *
 * ## POR QUE O NOME DA FIXTURA MUDA A CADA CORRIDA
 *
 * A primeira versão desta fixtura tinha id e e-mail FIXOS, e o `afterAll`
 * apagava por esse id. Duas corridas deste arquivo ao mesmo tempo no mesmo
 * banco — que é o dia a dia aqui, com várias trilhas rodando `npx vitest run`
 * contra o mesmo Postgres — e o `afterAll` de uma apaga a fixtura que a outra
 * está usando no meio do caso.
 *
 * Reproduzido: uma corrida com a varredura das rotas demorando (servidor
 * ocupado) e outra corrida entrando e saindo no meio dela. A primeira reprova
 * com `a fixtura da senha errada não entrou no banco: expected undefined to
 * be true` — vermelho que não tem nada a ver com autenticação, exatamente a
 * doença que este arquivo estava consertando, só que um nível abaixo.
 *
 * Com a marca de corrida (relógio + pid) cada corrida tem a SUA linha, o SEU
 * balde de tentativas e apaga só o que criou. Sobra de corrida que morreu no
 * meio é varrida por idade, nunca por nome — varrer por nome é o bug de cima.
 */
const MARCA_DA_CORRIDA =
  (Date.now().toString(16).slice(-8) + process.pid.toString(16).padStart(4, '0')).slice(-12)
const USUARIO_SENHA_ERRADA = `00000000-0000-4000-8000-${MARCA_DA_CORRIDA}`
const EMAIL_SENHA_ERRADA = `senha-errada.autenticacao.${MARCA_DA_CORRIDA}@teste.invalido`
const PADRAO_FIXTURA = 'senha-errada.autenticacao%@teste.invalido'

/**
 * Teto de tempo dos casos que falam HTTP.
 *
 * O padrão do vitest é 5 s, e `sair revoga a sessão de verdade` (login + três
 * idas ao servidor) estourou em 5003 ms com outras suítes batendo no mesmo
 * servidor de dev. Vermelho por LENTIDÃO do vizinho é vermelho que ninguém
 * olha, e some no meio dos de verdade. Vinte segundos continua curto pra
 * pegar rota travada — o caminho feliz custa menos de 1,5 s medido — e larga
 * o suficiente pra não depender de quem mais está usando a máquina.
 */
const TETO_HTTP = 20_000

let noAr = false
beforeAll(async () => {
  // 2,5 s de paciência transformava "servidor ocupado" em "servidor fora do
  // ar", e o arquivo inteiro PULAVA em silêncio — sete casos verdes que não
  // testaram nada. Duas tentativas, a segunda mais longa.
  for (const paciencia of [4000, 10_000]) {
    try {
      noAr = (await fetch(`${BASE}/api/e/${SLUG}`, { signal: AbortSignal.timeout(paciencia) })).ok
      if (noAr) break
    } catch { noAr = false }
  }
  if (!noAr) return

  const { q } = await import('../utils/db')

  // sobra de corrida que morreu no meio: some por IDADE. Nunca por nome — o
  // `DELETE` por nome é que apagava a fixtura da corrida vizinha.
  await q(
    `DELETE FROM users WHERE email LIKE $1 AND created_at < now() - interval '30 minutes'`,
    [PADRAO_FIXTURA])
  await q(
    `DELETE FROM login_attempts WHERE email LIKE $1 AND at < now() - interval '30 minutes'`,
    [PADRAO_FIXTURA])

  // a fixtura copia o hash do dono: assim o teste não conhece nem gera senha,
  // e a senha CERTA dela é a mesma `diamond123` do seed.
  await q(
    `INSERT INTO users (id, org_id, name, email, password_hash, role, papel)
     SELECT $1, org_id, 'Alvo de Senha Errada', $2, password_hash, 'leitura', 'portaria'
       FROM users WHERE email = $3`,
    [USUARIO_SENHA_ERRADA, EMAIL_SENHA_ERRADA, CONTAS.master.email])
}, 30_000)

afterAll(async () => {
  if (!noAr) return
  const { q } = await import('../utils/db')
  await q(`DELETE FROM users WHERE id = $1`, [USUARIO_SENHA_ERRADA])
  await q(`DELETE FROM login_attempts WHERE email = $1`, [EMAIL_SENHA_ERRADA])
}, 30_000)

/** Varre server/api/admin e devolve a URL de cada rota, com id de exemplo. */
function rotasAdmin(dir = join(process.cwd(), 'server/api/admin'), prefixo = '/api/admin') {
  const achados: { url: string; metodo: string }[] = []
  for (const nome of readdirSync(dir)) {
    const caminho = join(dir, nome)
    if (statSync(caminho).isDirectory()) {
      achados.push(...rotasAdmin(caminho, `${prefixo}/${nome.replace(/^\[.+\]$/, 'id-exemplo')}`))
      continue
    }
    if (!nome.endsWith('.ts') || nome.includes('.test.')) continue
    const m = nome.match(/^(.+?)\.(get|post|patch|delete|put)\.ts$/)
    if (!m) continue
    const arquivo = m[1] === 'index' ? '' : `/${m[1]}`
    achados.push({ url: prefixo + arquivo, metodo: m[2].toUpperCase() })
  }
  return achados
}

describe('porteiro das rotas administrativas', () => {
  it('nenhuma rota sob /api/admin responde sem sessão', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')

    /*
     * O PISO DA VARREDURA — a trava deste caso, não um detalhe.
     *
     * Este teste só vale o que a varredura enxerga: ele prova "nenhuma das
     * rotas que eu achei responde sem sessão". Se a varredura quebrar — a
     * pasta muda de lugar, a convenção de nome do arquivo muda, a recursão
     * para de descer — ela devolve uma lista curta, TODA aquela lista passa, e
     * o caso fica VERDE tendo conferido quase nada. Foi por isso que o piso
     * `> 3` saiu: com ele, uma varredura que achasse 4 rotas de 68 continuava
     * verde.
     *
     * 40 é bem abaixo das 68 de hoje (folga pra rota ser apagada sem vermelho
     * de mentira) e bem acima da faixa em que a varredura claramente quebrou.
     */
    const rotas = rotasAdmin()
    expect(rotas.length,
      'a varredura achou rota de menos — ela quebrou, e um caso verde aqui não '
      + 'quer dizer que as rotas administrativas estão trancadas')
      .toBeGreaterThan(40)

    /*
     * A varredura vai em LEVAS, não em fila única.
     *
     * São 64 rotas. Uma de cada vez leva ~700 ms com a máquina só pra ela —
     * e passou de 60 SEGUNDOS com outra suíte batendo no mesmo servidor de
     * dev, reprovando por LENTIDÃO em vez de por rota aberta. Vermelho por
     * motivo que não é o defeito é vermelho que ninguém olha.
     *
     * A leva é pequena (8) de propósito: o objetivo é tirar o tempo de ida e
     * volta do caminho crítico, não esganar o servidor que as outras suítes
     * também estão usando. Cada rota continua sendo uma pergunta
     * independente — não há estado compartilhado entre elas, então a ordem
     * não importa.
     */
    const LEVA = 8
    const abertas: string[] = []
    for (let i = 0; i < rotas.length; i += LEVA) {
      const respostas = await Promise.all(rotas.slice(i, i + LEVA).map(
        async ({ url, metodo }) => ({
          url, metodo,
          status: (await fetch(`${BASE}${url}`, {
            method: metodo,
            headers: { 'content-type': 'application/json' },
            body: metodo === 'GET' ? undefined : '{}',
          })).status,
        })))
      // 401 é o esperado. Qualquer outra coisa significa que a rota respondeu
      // (ou validou o corpo) ANTES de exigir login.
      for (const r of respostas) {
        if (r.status !== 401) abertas.push(`${r.metodo} ${r.url} → ${r.status}`)
      }
    }
    expect(abertas, 'rota administrativa acessível sem login').toEqual([])
  }, 60_000)

  it('rota pública continua pública', async () => {
    if (!noAr) return void console.warn('  (pulado)')
    for (const url of [`/api/e/${SLUG}`, '/api/eventos-publicos', '/api/auth/eu']) {
      expect((await fetch(`${BASE}${url}`)).status, url).toBe(200)
    }
  }, TETO_HTTP)

  /**
   * A fixtura é DESTA corrida — e este caso é o alarme disso.
   *
   * Ele não precisa do servidor: lê o próprio arquivo. A corrida simultânea
   * que expõe o defeito é, por definição, uma corrida de sorte; o que dá pra
   * travar de verdade é a REGRA que a evita. Duas partes:
   *
   * 1. o nome da fixtura carrega a marca da corrida — com nome fixo, as duas
   *    corridas disputam a MESMA linha;
   * 2. nenhum `DELETE` deste arquivo escolhe linha por um nome que outra
   *    corrida também usa. Ou é o id desta corrida, ou é por IDADE.
   *
   * Foi exatamente o `DELETE FROM users WHERE email = <nome fixo>` que, com
   * uma corrida lenta e outra rápida em cima, deixou a primeira reprovando
   * com `a fixtura da senha errada não entrou no banco`.
   */
  it('a fixtura é da corrida, não do repositório', () => {
    expect(EMAIL_SENHA_ERRADA).toContain(MARCA_DA_CORRIDA)
    expect(USUARIO_SENHA_ERRADA).toContain(MARCA_DA_CORRIDA)
    expect(MARCA_DA_CORRIDA.length).toBe(12)

    // sem comentário: os parágrafos acima citam o `DELETE` defeituoso pelo
    // nome, e a trava acusaria a própria explicação — que é a parte que
    // impede o defeito de voltar.
    const fonte = readFileSync(new URL(import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').map((linha) => {
        const barras = linha.search(/(^|[^:])\/\//)
        return barras >= 0 ? linha.slice(0, linha.indexOf('//', barras)) : linha
      }).join('\n')
    const deletes = fonte.match(/DELETE FROM [a-z_]+[^`]*/g) ?? []
    expect(deletes.length, 'a varredura de DELETE não achou nada — o formato mudou?')
      .toBeGreaterThan(2)

    const largos = deletes.filter((d) =>
      !/WHERE id = \$1/.test(d)
      && !/WHERE email = \$1/.test(d)
      && !/<\s*now\(\) - interval/.test(d))
    expect(largos, 'DELETE que alcança a fixtura de outra corrida do mesmo arquivo')
      .toEqual([])
  })

  it('senha errada e e-mail inexistente dão a MESMA resposta', async () => {
    if (!noAr) return void console.warn('  (pulado)')
    const { q, q1 } = await import('../utils/db')

    const tentar = (email: string, senha: string) =>
      fetch(`${BASE}/api/auth/entrar`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, senha }),
      }).then(async (r) => ({ status: r.status, msg: (await r.json()).statusMessage }))

    // A conta da senha errada precisa EXISTIR e estar ATIVA. Se não existir,
    // os dois lados viram "e-mail inexistente" e a comparação abaixo fica
    // verde comparando o mesmo caminho com ele mesmo — prova nenhuma.
    const alvo = await q1<any>(`SELECT id, active FROM users WHERE email = $1`,
      [EMAIL_SENHA_ERRADA])
    expect(alvo?.active, 'a fixtura da senha errada não entrou no banco').toBe(true)

    const marca = new Date()
    const a = await tentar(EMAIL_SENHA_ERRADA, 'senha-errada-' + Date.now())
    const b = await tentar(`nao-existe-${Date.now()}@teste.com`, 'x')

    expect(a.status).toBe(401)
    expect(b.status).toBe(401)
    expect(a.msg).toBe(b.msg) // ← senão a mensagem vira oráculo de quem tem conta

    // ------------------------------------------------------------------
    // A TRAVA DO BALDE. Se alguém devolver `CONTAS.master.email` na linha da
    // senha errada, a falha passa a ser gravada no balde do dono e estas duas
    // asserções ficam VERMELHAS na hora — que é o alarme que faltava quando a
    // suíte inteira caía de 429 oito corridas depois, em arquivo aleatório.
    const gravadas = (await q<any>(
      `SELECT email FROM login_attempts WHERE ok = false AND at >= $1`, [marca]))
      .map((l) => l.email)

    expect(gravadas, 'a falha tem que cair no balde da fixtura')
      .toContain(EMAIL_SENHA_ERRADA)
    expect(gravadas, 'errar a senha de uma conta do seed queima o login da suíte inteira')
      .not.toContain(CONTAS.master.email)
    expect(gravadas).not.toContain(CONTAS.portaria.email)
  }, TETO_HTTP)

  it('portaria não entra em rota de evento, mas entra na portaria', async () => {
    if (!noAr) return void console.warn('  (pulado)')
    const http = comSessao(await entrar('portaria'))

    const evento = await http('/api/admin/eventos')
    expect(evento.status).toBe(403)

    // no check-in ela passa do porteiro; o 400 é a validação do corpo vazio,
    // ou seja, chegou no handler.
    const portaria = await http('/api/checkin', { method: 'POST', body: '{}' })
    expect(portaria.status).toBe(400)
  }, TETO_HTTP)

  it('o segredo da sessão não fica em claro no banco', async () => {
    if (!noAr) return void console.warn('  (pulado)')
    const cookie = await entrar('master')
    const segredo = cookie.split('=')[1]

    const { q } = await import('../utils/db')
    const linhas = await q<any>(
      `SELECT token_hash FROM sessions WHERE revoked_at IS NULL
         AND created_at > now() - interval '1 minute'`)

    expect(linhas.length).toBeGreaterThan(0)
    for (const l of linhas) {
      expect(l.token_hash).not.toBe(segredo)
      expect(l.token_hash).toMatch(/^[0-9a-f]{64}$/) // sha-256 em hexadecimal
    }
  }, TETO_HTTP)

  it('sair revoga a sessão de verdade', async () => {
    if (!noAr) return void console.warn('  (pulado)')
    const cookie = await entrar('master')
    const http = comSessao(cookie)

    expect((await http('/api/admin/eventos')).status).toBe(200)
    await http('/api/auth/sair', { method: 'POST' })
    // o cookie continua na mão do cliente; o que morreu foi a sessão no banco
    expect((await http('/api/admin/eventos')).status).toBe(401)
  }, TETO_HTTP)

  it('recusa POST vindo de outra origem', async () => {
    if (!noAr) return void console.warn('  (pulado)')
    const cookie = await entrar('master')
    const r = await fetch(`${BASE}/api/admin/evento/id-exemplo/ingressos`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, origin: 'https://site-malicioso.com' },
      body: '{}',
    })
    expect(r.status).toBe(403)
  }, TETO_HTTP)
})
