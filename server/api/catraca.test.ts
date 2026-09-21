/**
 * Teste da catraca — a porta do evento, por HTTP, do jeito que o leitor usa.
 *
 * O resto da suíte prova o UPDATE condicional no SQL. Isso não é a mesma
 * coisa: entre o SQL e a porta existem o porteiro de sessão, a leitura da
 * assinatura, a janela da sessão e a ordem das decisões. Um erro em qualquer
 * um deles deixa o mesmo QR entrar duas vezes com o banco intacto.
 *
 * As quatro coisas que este teste existe pra impedir:
 *
 *  1. o mesmo ingresso entrar duas vezes (dois portões lendo junto);
 *  2. o segundo carimbo apagar a hora do primeiro — a pergunta "que horas ele
 *     entrou?" só tem resposta se o carimbo for do primeiro;
 *  3. QR fabricado passar;
 *  4. **a portaria de uma produtora queimar ingresso de outra.** A busca do
 *     código é por `code`, sem organização: quem tem login em qualquer casa
 *     e o código de um ingresso alheio derruba a entrada de outra empresa.
 *
 * Fixture própria, de ponta a ponta: duas organizações criadas por id fixo e
 * apagadas no fim. Nenhum ingresso do seed é queimado — um teste que gasta
 * dado de verdade só pode rodar uma vez.
 *
 * Precisa do servidor de dev no ar. Sem ele, PULA — com `ctx.skip()`, que sai
 * CONTADO como pulado. Antes o caso saía com um `return` seco, que o vitest
 * conta como ✓: medido com a porta fechada, este arquivo imprimia
 * `Tests 12 passed (12)` sem ter lido um QR.
 *
 * ## A fixtura é DESTA corrida
 *
 * Os ids eram fixos no repositório, e duas corridas ao mesmo tempo no mesmo
 * banco — o dia a dia aqui, com várias trilhas rodando `npx vitest run` — se
 * atropelavam. Reproduzido com dois `npx vitest run server/api/catraca.test.ts`
 * simultâneos:
 *
 *   A: insert or update on table "tickets" violates foreign key constraint
 *      "tickets_org_id_fkey"        ← o `afterAll` da vizinha apagou a
 *                                     organização no meio deste `beforeAll`
 *   B: duplicate key value violates unique constraint
 *      "organizations_slug_key"     ← o slug também era fixo
 *
 * As duas terminaram `Test Files 1 failed` com `Tests 12 skipped (12)`. Agora
 * id, e-mail, slug e código de ingresso carregam a marca da corrida
 * (`scripts/test-setup.ts`), e o `afterAll` apaga só o que ESTA corrida criou.
 */
import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  anunciarPulo, BASE_DE_TESTE, MARCA_MAIUSCULA, seForaDoArPula, sondarServidor,
  uuidDaCorrida, type Sonda,
} from '../../scripts/test-setup'
import { montarQr } from '../utils/ingresso'

const BASE = BASE_DE_TESTE

/** ids DESTA corrida: o teste limpa exatamente o que criou, e só isso */
const id = (n: number) => uuidDaCorrida('api/catraca', n)
const ORG_CASA = id(1)
const USER_PORTEIRO = id(2)
const EVENTO_CASA = id(3)
const SESSAO_ABERTA = id(4)
const SESSAO_PASSADA = id(5)
const SETOR_CASA = id(6)
const LOTE_CASA = id(7)

const ORG_VIZINHA = id(11)
const EVENTO_VIZINHO = id(13)
const SESSAO_VIZINHA = id(14)
const SETOR_VIZINHO = id(16)
const LOTE_VIZINHO = id(17)

const MARCA_MINUSCULA = MARCA_MAIUSCULA.toLowerCase()
const EMAIL_PORTEIRO = `porteiro.${MARCA_MINUSCULA}@catraca.invalido`
const SENHA = 'diamond123'

/**
 * `code` é UNIQUE na tabela `tickets` INTEIRA — não por evento.
 *
 * Esta é a armadilha que sobreviveu à primeira rodada do conserto: os quatro
 * códigos do topo viraram marcados, e os cinco que moram DENTRO dos casos
 * ficaram fixos. Com duas corridas simultâneas, o
 * `ON CONFLICT (code) DO NOTHING` da segunda não insere nada — calado — e ela
 * passa a ler o ingresso da PRIMEIRA, que é de outra organização e de outro
 * evento. A porta responde `invalido` e a mensagem fala de assinatura, não de
 * fixtura. Medido: 4 casos vermelhos numa corrida e 1 na outra, todos
 * `expected 'invalido' to be 'ok'`.
 *
 * Todo código deste arquivo passa por aqui. Nenhum literal solto.
 */
const cod = (sufixo: string) => `ZZT-${MARCA_MAIUSCULA}-${sufixo}`
const COD_OK = cod('AAAA')
const COD_CANCELADO = cod('BBBB')
const COD_PASSADO = cod('CCCC')
const COD_VIZINHO = cod('DDDD')

let sonda: Sonda = { noAr: false, porque: 'o beforeAll não chegou a rodar' }
let cookie = ''

async function sql(texto: string, par: any[] = []) {
  const { q } = await import('../utils/db')
  return q<any>(texto, par)
}

/** lê o QR na porta, como o leitor faz */
async function ler(qr: string, eventId = EVENTO_CASA, gate = 'PORTAO-1') {
  const r = await fetch(`${BASE}/api/checkin`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie, origin: BASE },
    body: JSON.stringify({ qr, eventId, gate }),
  })
  return { status: r.status, corpo: await r.json().catch(() => ({})) }
}

async function ingresso(code: string) {
  const [t] = await sql(
    `SELECT status, checked_in_at, checked_in_by FROM tickets WHERE code = $1`, [code])
  return t
}

async function semearCasa(org: string, evento: string, setor: string, lote: string,
                          nome: string, slug: string) {
  await sql(`INSERT INTO organizations (id, name, slug) VALUES ($1,$2,$3)
             ON CONFLICT (id) DO NOTHING`, [org, nome, slug])
  await sql(
    `INSERT INTO events (id, org_id, name, slug, starts_at, ends_at, status)
     VALUES ($1,$2,$3,$4, now() + interval '1 hour', now() + interval '6 hours', 'ativo')
     ON CONFLICT (id) DO NOTHING`, [evento, org, nome + ' EVENTO', slug + '-evento'])
  await sql(`INSERT INTO sectors (id, event_id, name) VALUES ($1,$2,'ZZ SETOR TESTE')
             ON CONFLICT (id) DO NOTHING`, [setor, evento])
  await sql(
    `INSERT INTO lots (id, sector_id, name, price_cents, quantity)
     VALUES ($1,$2,'ZZ LOTE TESTE', 1000, 100) ON CONFLICT (id) DO NOTHING`, [lote, setor])
}

async function semearIngresso(code: string, org: string, evento: string, sessao: string | null,
                              setor: string, lote: string, status = 'valido') {
  await sql(
    `INSERT INTO tickets (org_id, event_id, session_id, sector_id, lot_id,
                          code, qr_secret, status, holder_name)
     VALUES ($1,$2,$3,$4,$5,$6,'teste',$7,'Fulano de Teste')
     ON CONFLICT (code) DO NOTHING`, [org, evento, sessao, setor, lote, code, status])
}

beforeAll(async () => {
  sonda = await sondarServidor()
  anunciarPulo('server/api/catraca.test.ts', sonda)
  if (!sonda.noAr) return

  // nome e slug também levam a marca: `organizations_slug_key` é UNIQUE, e
  // `ON CONFLICT (id)` não cobre conflito num OUTRO índice único — foi esse o
  // erro da corrida B lá em cima.
  await semearCasa(ORG_CASA, EVENTO_CASA, SETOR_CASA, LOTE_CASA,
                   `ZZ CATRACA CASA ${MARCA_MAIUSCULA}`, `zz-catraca-casa-${MARCA_MINUSCULA}`)
  await semearCasa(ORG_VIZINHA, EVENTO_VIZINHO, SETOR_VIZINHO, LOTE_VIZINHO,
                   `ZZ CATRACA VIZINHA ${MARCA_MAIUSCULA}`, `zz-catraca-vizinha-${MARCA_MINUSCULA}`)

  // Sessão ABERTA agora: sem isso o evento inteiro cai em "fora do horário" e
  // o teste ficaria verde sem nunca chegar na trava.
  await sql(
    `INSERT INTO event_sessions (id, event_id, starts_at, ends_at, title)
     VALUES ($1,$2, now() - interval '30 minutes', now() + interval '4 hours', 'Aberta')
     ON CONFLICT (id) DO NOTHING`, [SESSAO_ABERTA, EVENTO_CASA])
  await sql(
    `INSERT INTO event_sessions (id, event_id, starts_at, ends_at, title)
     VALUES ($1,$2, now() - interval '30 days', now() - interval '29 days', 'Passada')
     ON CONFLICT (id) DO NOTHING`, [SESSAO_PASSADA, EVENTO_CASA])
  await sql(
    `INSERT INTO event_sessions (id, event_id, starts_at, ends_at, title)
     VALUES ($1,$2, now() - interval '30 minutes', now() + interval '4 hours', 'Aberta')
     ON CONFLICT (id) DO NOTHING`, [SESSAO_VIZINHA, EVENTO_VIZINHO])

  await semearIngresso(COD_OK, ORG_CASA, EVENTO_CASA, SESSAO_ABERTA, SETOR_CASA, LOTE_CASA)
  await semearIngresso(COD_CANCELADO, ORG_CASA, EVENTO_CASA, SESSAO_ABERTA, SETOR_CASA,
                       LOTE_CASA, 'cancelado')
  await semearIngresso(COD_PASSADO, ORG_CASA, EVENTO_CASA, SESSAO_PASSADA, SETOR_CASA, LOTE_CASA)
  await semearIngresso(COD_VIZINHO, ORG_VIZINHA, EVENTO_VIZINHO, SESSAO_VIZINHA,
                       SETOR_VIZINHO, LOTE_VIZINHO)

  // Porteiro de verdade, com o papel de portaria — o mesmo caminho do tablet
  // na porta. A senha vem do hash já semeado, pra o teste não gerar hash.
  await sql(
    `INSERT INTO users (id, org_id, name, email, password_hash, role)
     SELECT $1, $2, 'Porteiro Teste', $3, password_hash, 'portaria'
       FROM users WHERE email = 'dono@fazendapark.com.br'
     ON CONFLICT (id) DO NOTHING`, [USER_PORTEIRO, ORG_CASA, EMAIL_PORTEIRO])

  const r = await fetch(`${BASE}/api/auth/entrar`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL_PORTEIRO, senha: SENHA }),
  })
  const bruto = r.headers.getSetCookie?.() ?? []
  cookie = bruto.map((c) => c.split(';')[0]).find((c) => c.startsWith('dt_sessao=')) ?? ''
}, 40_000)

afterAll(async () => {
  if (!sonda.noAr) return
  // por id DESTA corrida. Apagar por nome ou por slug alcançaria a fixtura da
  // corrida vizinha — que é exatamente o defeito consertado aqui.
  await sql(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [[ORG_CASA, ORG_VIZINHA]])
})

describe('catraca', () => {
  /**
   * A TRAVA DA FIXTURA DESTA CORRIDA — e por que ela é um caso, não um comentário.
   *
   * Não precisa de servidor: lê o próprio arquivo. A corrida simultânea que
   * expõe o defeito é, por definição, corrida de sorte; o que dá pra travar é a
   * REGRA que a evita. Duas partes, e as duas já falharam de verdade aqui:
   *
   *  1. **nenhum id de fixtura é literal.** Com uuid fixo, duas corridas no
   *     mesmo banco disputam a MESMA linha, e o `afterAll` de uma apaga a
   *     organização que a outra está usando — medido:
   *     `insert or update on table "tickets" violates foreign key constraint
   *     "tickets_org_id_fkey"`, com os 12 casos saindo como "skipped";
   *
   *  2. **nenhum `code` de ingresso é literal.** `tickets.code` é UNIQUE na
   *     tabela inteira: o `ON CONFLICT (code) DO NOTHING` da segunda corrida não
   *     insere nada, calado, e ela passa a ler o ingresso da primeira — de outra
   *     organização, de outro evento. A porta responde `invalido` e a mensagem
   *     fala de assinatura. Este foi o defeito que sobreviveu à primeira rodada
   *     do conserto, justamente porque os literais estavam DENTRO dos casos e
   *     só os do topo tinham sido marcados.
   *
   * Comentário não é conferido: o corpo do arquivo é lido sem comentário pra
   * esta varredura não acusar os parágrafos que explicam o defeito.
   */
  it('a fixtura é da corrida, não do repositório', () => {
    const fonte = readFileSync(new URL(import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((linha) => {
        const barras = linha.search(/(^|[^:])\/\//)
        return barras >= 0 ? linha.slice(0, linha.indexOf('//', barras)) : linha
      })
      .join('\n')

    const uuidsFixos = fonte.match(/'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'/g) ?? []
    expect(uuidsFixos, 'id de fixtura literal: duas corridas disputam a mesma linha')
      .toEqual([])

    const codigosFixos = fonte.match(/'ZZ[A-Z]-[A-Z0-9]+-[A-Z0-9]+'/g) ?? []
    expect(codigosFixos, '`code` literal: `tickets.code` é UNIQUE e a segunda corrida lê o ingresso da primeira')
      .toEqual([])

    // A varredura achou ALGUMA coisa? Sem isto, um dia a regex para de casar e
    // as duas listas ficam vazias afirmando saúde que ninguém conferiu.
    expect(fonte, 'a fixtura parou de carregar a marca da corrida').toContain('MARCA_MAIUSCULA')
    expect(fonte.match(/uuidDaCorrida\(/g)?.length ?? 0,
      'nenhum id sai mais de `uuidDaCorrida` — a marca da corrida sumiu')
      .toBeGreaterThan(0)
  })

  it('o porteiro entrou (senão nada abaixo prova nada)', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    expect(cookie, 'login do porteiro falhou — o teste ficaria verde à toa').toBeTruthy()
  }, 20_000)

  /**
   * A validação de verdade, do começo ao fim, com o status HTTP conferido.
   *
   * Um verificador mediu esta rota devolvendo **500 "bind message supplies 8
   * parameters, but prepared statement requires 9"** durante edição ao vivo:
   * alguém tinha mexido no `SQL_GRAVA_ENTRADA` e a chamada ficou com um
   * parâmetro a menos. Nenhum teste da suíte olhava o STATUS — todos liam
   * `corpo.resultado`, que num 500 vem `undefined`, e `undefined !== 'ok'`
   * dava a mensagem de falha errada ("a porta respondeu undefined"), mandando
   * quem investigasse procurar na lógica em vez de na chamada.
   *
   * Este caso confere as três coisas na ordem em que quebram: HTTP 200, o
   * carimbo no ingresso, e a linha no livro de entradas (que é quem usa o SQL
   * de 8 parâmetros).
   */
  it('a porta responde 200 e grava as duas linhas — sem 500 de parâmetro', async (ctx) => {
    seForaDoArPula(ctx, sonda)

    const codigo = cod('HTTP')
    await semearIngresso(codigo, ORG_CASA, EVENTO_CASA, SESSAO_ABERTA, SETOR_CASA, LOTE_CASA)

    const { status, corpo } = await ler(montarQr(codigo, EVENTO_CASA), EVENTO_CASA, 'PORTAO-HTTP')
    expect(status, `a porta devolveu ${status}: ${JSON.stringify(corpo)}`).toBe(200)
    expect(corpo.resultado).toBe('ok')

    const t = await ingresso(codigo)
    expect(t.status).toBe('usado')

    // o livro de entradas é quem executa o SQL_GRAVA_ENTRADA: sem esta linha
    // um erro de parâmetro ali passaria com o carimbo já dado
    const [linha] = await sql(
      `SELECT e.gate, e.people FROM entries e JOIN tickets t ON t.id = e.ticket_id
        WHERE t.code = $1`, [codigo])
    expect(linha, 'a leitura não virou linha no livro de entradas').toBeTruthy()
    expect(linha.gate).toBe('PORTAO-HTTP')
  }, 20_000)

  /**
   * A porta devolve o retrato do público, e ele ANDA a cada leitura.
   *
   * Furo medido em 21/09 com o leitor aberto no navegador: os três KPIs do
   * topo ("Pessoas dentro", "Já entraram", "Comparecimento") só eram
   * preenchidos pela rota de sincronização, que com rede boa roda uma única
   * vez — na montagem da página. Lido um ingresso pelo campo, a tela respondeu
   * "PODE ENTRAR" e os três números ficaram em `0 / 0 / 0%` com o servidor já
   * dizendo `pessoas: 1`. Nada lança exceção: o painel só para, parecendo
   * atualizado.
   *
   * O teste é o do painel, não o do texto: lê DOIS ingressos e exige que o
   * retorno da segunda leitura conte mais gente que o da primeira, e que os
   * dois batam com o livro no banco naquele instante.
   */
  it('cada leitura devolve o retrato do público, e ele anda', async (ctx) => {
    seForaDoArPula(ctx, sonda)

    const um = cod('PUB1')
    const dois = cod('PUB2')
    await semearIngresso(um, ORG_CASA, EVENTO_CASA, SESSAO_ABERTA, SETOR_CASA, LOTE_CASA)
    await semearIngresso(dois, ORG_CASA, EVENTO_CASA, SESSAO_ABERTA, SETOR_CASA, LOTE_CASA)

    const livro = async () => {
      const [l] = await sql(
        `SELECT count(DISTINCT ticket_id)::int AS ingressos,
                COALESCE(sum(people),0)::int   AS pessoas
           FROM entries WHERE event_id = $1`, [EVENTO_CASA])
      return l
    }

    const r1 = await ler(montarQr(um, EVENTO_CASA), EVENTO_CASA, 'PORTAO-PUB')
    expect(r1.corpo.resultado, JSON.stringify(r1.corpo)).toBe('ok')
    expect(r1.corpo.publico,
      'a porta respondeu sem o retrato: os KPIs da tela congelam na abertura')
      .toBeTruthy()
    const b1 = await livro()
    expect(r1.corpo.publico.ingressos).toBe(b1.ingressos)
    expect(r1.corpo.publico.pessoas).toBe(b1.pessoas)

    const r2 = await ler(montarQr(dois, EVENTO_CASA), EVENTO_CASA, 'PORTAO-PUB')
    expect(r2.corpo.resultado, JSON.stringify(r2.corpo)).toBe('ok')
    expect(r2.corpo.publico.ingressos,
      'o retrato não andou entre duas leituras — é o painel parado de novo')
      .toBe(r1.corpo.publico.ingressos + 1)
    expect(r2.corpo.publico.aptos,
      'o denominador sumiu do retrato que a porta devolve').toBeGreaterThan(0)

    // A recusa também repinta: o portão vizinho continua contando gente, e é
    // olhando uma recusa que o operador levanta a cabeça pra tela.
    const r3 = await ler(montarQr(um, EVENTO_CASA), EVENTO_CASA, 'PORTAO-PUB')
    expect(r3.corpo.resultado).toBe('ja_usado')
    expect(r3.corpo.publico?.ingressos,
      'a leitura recusada devolveu a tela sem retrato')
      .toBe(r2.corpo.publico.ingressos)
  }, 30_000)

  it('QR assinado entra, e o carimbo diz quem liberou', async (ctx) => {
    seForaDoArPula(ctx, sonda)

    const { status, corpo } = await ler(montarQr(COD_OK, EVENTO_CASA))
    expect(status, `a porta devolveu ${status}: ${JSON.stringify(corpo)}`).toBe(200)
    expect(corpo.resultado, `a porta respondeu ${corpo.resultado}`).toBe('ok')

    // read-back: a resposta pode dizer ok e o banco não ter mudado nada.
    const t = await ingresso(COD_OK)
    expect(t.status).toBe('usado')
    expect(t.checked_in_at, 'entrou sem hora de entrada').toBeTruthy()
    expect(t.checked_in_by, 'leitura sem dono: ninguém sabe quem liberou').toBe(USER_PORTEIRO)
  }, 20_000)

  it('o mesmo QR não entra de novo — nem por outro portão', async (ctx) => {
    seForaDoArPula(ctx, sonda)

    const antes = await ingresso(COD_OK)
    const { corpo } = await ler(montarQr(COD_OK, EVENTO_CASA), EVENTO_CASA, 'PORTAO-2')
    expect(corpo.resultado).toBe('ja_usado')
    expect(corpo.ok).toBe(false)

    // A hora tem que continuar sendo a da PRIMEIRA entrada: se a segunda
    // leitura recarimbasse, a pergunta "que horas ele entrou?" perderia a
    // resposta bem no caso em que alguém precisa dela.
    const depois = await ingresso(COD_OK)
    expect(depois.checked_in_at?.toISOString?.() ?? depois.checked_in_at)
      .toBe(antes.checked_in_at?.toISOString?.() ?? antes.checked_in_at)
  }, 20_000)

  it('dois leitores que leram juntos: só um consegue marcar', async (ctx) => {
    seForaDoArPula(ctx, sonda)

    // A checagem prévia da rota ("já está usado?") esconde a trava quando os
    // pedidos chegam em fila — foi assim que a versão anterior deste teste
    // ficou verde com a trava arrancada. Aqui a ordem é forçada à mão: as
    // DUAS conexões leem o ingresso ainda válido e só depois tentam marcar,
    // que é exatamente o instante que a trava existe pra resolver.
    const codigo = cod('RACE')
    await semearIngresso(codigo, ORG_CASA, EVENTO_CASA, SESSAO_ABERTA, SETOR_CASA, LOTE_CASA)
    const [alvo] = await sql(`SELECT id FROM tickets WHERE code = $1`, [codigo])

    const { db } = await import('../utils/db')
    const { SQL_MARCA_ENTRADA } = await import('../utils/catraca')
    const c1 = await db().connect()
    const c2 = await db().connect()
    try {
      // os dois leram, os dois acham que o ingresso está livre
      const l1 = await c1.query(`SELECT status FROM tickets WHERE id = $1`, [alvo.id])
      const l2 = await c2.query(`SELECT status FROM tickets WHERE id = $1`, [alvo.id])
      expect(l1.rows[0].status).toBe('valido')
      expect(l2.rows[0].status).toBe('valido')

      const r1 = await c1.query(SQL_MARCA_ENTRADA, [alvo.id, USER_PORTEIRO])
      const r2 = await c2.query(SQL_MARCA_ENTRADA, [alvo.id, USER_PORTEIRO])
      expect(r1.rowCount + r2.rowCount,
        'os dois leitores marcaram entrada — o mesmo QR passa duas vezes').toBe(1)
    } finally {
      c1.release(); c2.release()
    }
  }, 20_000)

  it('24 leitores na mesma porta, um único ok', async (ctx) => {
    seForaDoArPula(ctx, sonda)

    // A prova de ponta a ponta, com o servidor no meio. Volume alto de
    // propósito: com poucos leitores os pedidos são atendidos em fila e o
    // caminho difícil nunca é exercitado (com a trava arrancada, 10 leitores
    // devolviam 1 ok e 20 devolviam 10).
    const codigo = cod('TROPA')
    await semearIngresso(codigo, ORG_CASA, EVENTO_CASA, SESSAO_ABERTA, SETOR_CASA, LOTE_CASA)
    const qr = montarQr(codigo, EVENTO_CASA)

    const rs = await Promise.all(
      Array.from({ length: 24 }, (_, i) => ler(qr, EVENTO_CASA, `PORTAO-${i}`)))
    const entraram = rs.filter((r) => r.corpo.resultado === 'ok').length
    expect(entraram, `${entraram} leitores deixaram a mesma pessoa entrar`).toBe(1)
  }, 30_000)

  it('QR fabricado não passa, e o ingresso continua intacto', async (ctx) => {
    seForaDoArPula(ctx, sonda)

    const forjado = `DT1:${EVENTO_CASA}:${COD_PASSADO}:AAAAAAAAAA`
    const { corpo } = await ler(forjado)
    expect(corpo.resultado).toBe('invalido')

    const t = await ingresso(COD_PASSADO)
    expect(t.status, 'o QR fabricado mexeu no ingresso').toBe('valido')
  }, 20_000)

  it('ingresso cancelado é barrado', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const { corpo } = await ler(montarQr(COD_CANCELADO, EVENTO_CASA))
    expect(corpo.resultado).toBe('cancelado')
  }, 20_000)

  it('ingresso de outro dia não entra hoje', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const { corpo } = await ler(montarQr(COD_PASSADO, EVENTO_CASA))
    expect(corpo.resultado).toBe('fora_da_sessao')
  }, 20_000)

  it('a portaria de uma produtora não queima ingresso de outra', async (ctx) => {
    seForaDoArPula(ctx, sonda)

    // O porteiro da CASA lê um ingresso legítimo da VIZINHA, com a assinatura
    // certa do evento dela. Se a porta aceitar, uma empresa derruba a entrada
    // de outra só com o código na mão.
    const { corpo } = await ler(montarQr(COD_VIZINHO, EVENTO_VIZINHO), EVENTO_VIZINHO)
    expect(corpo.resultado, 'a porta aceitou ingresso de outra organização').not.toBe('ok')

    const t = await ingresso(COD_VIZINHO)
    expect(t.status, 'o ingresso da vizinha foi queimado por quem não é dono').toBe('valido')
    expect(corpo.titular, 'o nome do comprador da vizinha vazou na resposta').toBeUndefined()
  }, 20_000)

  it('nem apontando o leitor para o próprio evento', async (ctx) => {
    seForaDoArPula(ctx, sonda)

    // A segunda forma do mesmo ataque: o porteiro digita o código alheio no
    // leitor do evento DELE. Passa pela cerca do evento (o evento é mesmo
    // dele) e vai morrer na busca do código, que é escopada por organização.
    const { corpo } = await ler(COD_VIZINHO, EVENTO_CASA)
    expect(corpo.resultado, 'o código de outra empresa foi encontrado').toBe('invalido')

    const t = await ingresso(COD_VIZINHO)
    expect(t.status).toBe('valido')
  }, 20_000)
})
