/**
 * Teste do porteiro.
 *
 * O que ele guarda não é a tela de login — é a promessa de que **rota
 * administrativa nova nasce trancada**. O middleware tranca por prefixo, e o
 * teste abaixo percorre TODAS as rotas sob /api/admin que existem no
 * repositório: se alguém criar uma rota nova e ela responder sem sessão, este
 * teste fica vermelho sozinho, sem ninguém precisar lembrar de adicionar caso.
 *
 * Precisa do servidor de dev no ar. Sem ele, PULA — com `ctx.skip()`, que sai
 * CONTADO como pulado. O `return` seco que estava aqui saía como ✓: medido com
 * a porta fechada, este arquivo imprimia `8 passed` tendo conferido uma rota.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  anunciarPulo, BASE_DE_TESTE, seForaDoArPula, sondarServidor, type Sonda,
} from '../../scripts/test-setup'
import { comSessao, CONTAS, entrar } from '../../scripts/teste-sessao'

const BASE = BASE_DE_TESTE
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

let sonda: Sonda = { noAr: false, porque: 'o beforeAll não chegou a rodar' }
beforeAll(async () => {
  // 2,5 s de paciência transformava "servidor ocupado" em "servidor fora do
  // ar", e o arquivo inteiro PULAVA em silêncio. A sonda com prazo crescente
  // e o motivo do pulo moram em `scripts/test-setup.ts`, pra suíte inteira
  // decidir isso de um jeito só.
  sonda = await sondarServidor(`/api/e/${SLUG}`)
  anunciarPulo('server/api/autenticacao.test.ts', sonda)
  if (!sonda.noAr) return

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
  if (!sonda.noAr) return
  const { q } = await import('../utils/db')
  await q(`DELETE FROM users WHERE id = $1`, [USUARIO_SENHA_ERRADA])
  await q(`DELETE FROM login_attempts WHERE email = $1`, [EMAIL_SENHA_ERRADA])
}, 30_000)

const RAIZ_ADMIN = join(process.cwd(), 'server/api/admin')
const SUFIXO_DE_METODO = /\.(get|post|patch|delete|put)\.ts$/

/** Varre server/api/admin e devolve a URL de cada rota, com id de exemplo. */
function rotasAdmin(dir = RAIZ_ADMIN, prefixo = '/api/admin') {
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

/**
 * A MESMA contagem, por outro caminho — quem desce a árvore aqui é o Node.
 *
 * `rotasAdmin()` é a coisa SOB TESTE: recursão escrita à mão, com
 * `readdirSync` + `statSync` + `continue`. Ela já quebrou, e quando quebra
 * devolve lista CURTA em silêncio. Comparar com uma lista feita por um
 * mecanismo diferente é o que transforma "quebrou" em vermelho — um piso
 * numérico sozinho não faz isso (ver o caso abaixo).
 */
function arquivosDeRota(): string[] {
  return (readdirSync(RAIZ_ADMIN, { recursive: true, encoding: 'utf8' }) as string[])
    .filter((caminho) => SUFIXO_DE_METODO.test(caminho) && !caminho.includes('.test.'))
}

/**
 * Arquivo de rota SEM sufixo de método — o ponto cego da varredura.
 *
 * `server/api/admin/foo.ts` (sem `.get`/`.post`) é rota válida no Nitro e
 * atende QUALQUER método. A varredura faz `if (!m) continue` e pula ele
 * caladinha: a rota existiria, responderia, e o porteiro nunca teria sido
 * perguntado sobre ela. Hoje não tem nenhum; esta lista é a armadilha pro dia
 * em que alguém criar o primeiro.
 */
function rotasSemMetodo(): string[] {
  return (readdirSync(RAIZ_ADMIN, { recursive: true, encoding: 'utf8' }) as string[])
    .filter((c) => c.endsWith('.ts') && !c.includes('.test.') && !SUFIXO_DE_METODO.test(c))
}

describe('porteiro das rotas administrativas', () => {
  it('nenhuma rota sob /api/admin responde sem sessão', async (ctx) => {
    seForaDoArPula(ctx, sonda)

    /*
     * O PISO DA VARREDURA — a trava deste caso, não um detalhe.
     *
     * Este teste só vale o que a varredura enxerga: ele prova "nenhuma das
     * rotas que eu achei responde sem sessão". Se a varredura quebrar — a
     * pasta muda de lugar, a convenção de nome do arquivo muda, a recursão
     * para de descer — ela devolve uma lista curta, TODA aquela lista passa, e
     * o caso fica VERDE tendo conferido quase nada.
     *
     * Já foi `> 3` (uma varredura que achasse 4 rotas de 68 passava). Virou
     * `> 40`, e AINDA passava: medido, com um `continue` na pasta `pdv` — dez
     * rotas, a superfície do caixa — a varredura devolvia 58 e o caso fechava
     * `8 passed`. Piso solto não pega quebra parcial, e quebra parcial é a
     * que acontece.
     *
     * Agora são três perguntas, e as três têm que passar:
     *
     *  1. a contagem BATE com uma varredura feita por outro mecanismo (o
     *     `readdirSync` recursivo do Node). Qualquer rota que a recursão à mão
     *     deixe de enxergar aparece aqui como diferença, seja 1 ou 50;
     *  2. o número absoluto não desabou (piso 60 pras 68 de hoje — folga pra
     *     apagar rota sem vermelho de mentira, e trava pro caso das duas
     *     varreduras quebrarem juntas);
     *  3. não existe arquivo de rota sem sufixo de método, que é o formato
     *     que a varredura ignora em silêncio.
     */
    const rotas = rotasAdmin()
    const arquivos = arquivosDeRota()

    expect(arquivos.length,
      'a pasta de rotas administrativas encolheu demais — ou a convenção mudou, '
      + 'e um caso verde aqui não quer dizer que elas estão trancadas')
      .toBeGreaterThanOrEqual(60)

    expect(rotas.length,
      `a varredura à mão achou ${rotas.length} rotas e o Node achou ${arquivos.length}: `
      + 'ela parou de enxergar parte da árvore, e o que ela não enxerga não é conferido')
      .toBe(arquivos.length)

    expect(rotasSemMetodo(),
      'rota sem sufixo de método: o Nitro atende TODOS os verbos nela e a '
      + 'varredura pula o arquivo — confira o login dela na mão ou renomeie')
      .toEqual([])

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
    const mudas: string[] = []
    for (let i = 0; i < rotas.length; i += LEVA) {
      const respostas = await Promise.all(rotas.slice(i, i + LEVA).map(
        async ({ url, metodo }) => {
          try {
            /*
             * Prazo POR ROTA, não só pelo caso.
             *
             * O teto do caso inteiro era 60 s e estourou de verdade, com três
             * trilhas batendo no mesmo `nuxt dev`: a mensagem foi
             * `Test timed out in 60000ms`, que não diz QUAL rota travou nem
             * se travou alguma. Com prazo por rota, uma rota pendurada sai
             * nomeada na lista `mudas` e as outras 67 continuam sendo
             * perguntadas — que é a diferença entre um relatório e um susto.
             */
            const r = await fetch(`${BASE}${url}`, {
              method: metodo,
              headers: { 'content-type': 'application/json' },
              body: metodo === 'GET' ? undefined : '{}',
              signal: AbortSignal.timeout(20_000),
            })
            return { url, metodo, status: r.status as number | null }
          } catch {
            return { url, metodo, status: null }
          }
        }))
      // 401 é o esperado. Qualquer outra coisa significa que a rota respondeu
      // (ou validou o corpo) ANTES de exigir login.
      for (const r of respostas) {
        if (r.status === null) mudas.push(`${r.metodo} ${r.url}`)
        else if (r.status !== 401) abertas.push(`${r.metodo} ${r.url} → ${r.status}`)
      }
    }
    expect(abertas, 'rota administrativa acessível sem login').toEqual([])
    expect(mudas,
      'rota administrativa que não respondeu em 20 s: ou ela trava, ou o '
      + 'servidor de dev está afogado — e nos dois casos o login dela NÃO foi conferido')
      .toEqual([])
  /*
   * 180 s, e não 60.
   *
   * São 68 perguntas em levas de 8. Com a máquina só pra ela o caso fecha em
   * menos de 2 s; com outras suítes no mesmo `nuxt dev` já passou de 60 e
   * reprovou por LENTIDÃO DO VIZINHO — vermelho que não é o defeito é
   * vermelho que ninguém olha, e some no meio dos de verdade. O que segura
   * rota pendurada agora é o prazo de 20 s por rota lá em cima, que sai
   * nomeando a culpada; este teto aqui é só a rede da rede.
   */
  }, 180_000)

  it('rota pública continua pública', async (ctx) => {
    seForaDoArPula(ctx, sonda)
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

  it('senha errada e e-mail inexistente dão a MESMA resposta', async (ctx) => {
    seForaDoArPula(ctx, sonda)
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

  it('portaria não entra em rota de evento, mas entra na portaria', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const http = comSessao(await entrar('portaria'))

    const evento = await http('/api/admin/eventos')
    expect(evento.status).toBe(403)

    // no check-in ela passa do porteiro; o 400 é a validação do corpo vazio,
    // ou seja, chegou no handler.
    const portaria = await http('/api/checkin', { method: 'POST', body: '{}' })
    expect(portaria.status).toBe(400)
  }, TETO_HTTP)

  it('o segredo da sessão não fica em claro no banco', async (ctx) => {
    seForaDoArPula(ctx, sonda)
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

  it('sair revoga a sessão de verdade', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const cookie = await entrar('master')
    const http = comSessao(cookie)

    expect((await http('/api/admin/eventos')).status).toBe(200)
    await http('/api/auth/sair', { method: 'POST' })
    // o cookie continua na mão do cliente; o que morreu foi a sessão no banco
    expect((await http('/api/admin/eventos')).status).toBe(401)
  }, TETO_HTTP)

  it('recusa POST vindo de outra origem', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const cookie = await entrar('master')
    const r = await fetch(`${BASE}/api/admin/evento/id-exemplo/ingressos`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, origin: 'https://site-malicioso.com' },
      body: '{}',
    })
    expect(r.status).toBe(403)
  }, TETO_HTTP)
})
