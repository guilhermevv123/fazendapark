/**
 * Auditoria: o registro responde quem, o que mudou e quando — ou não é
 * auditoria.
 *
 * O estado que este arquivo existe pra impedir de voltar foi medido no banco:
 * 912 linhas em `audit_log`, **zero** com `user_id`, zero com `ip`, 179 sem
 * `org_id`. Vinte arquivos escrevendo cada um o seu `INSERT`, metade
 * enfiando o autor dentro do payload com nome de campo diferente. O produtor
 * perguntava "quem cancelou este ingresso?" e a resposta possível era
 * "alguém, às 21h47".
 *
 * Cada caso abaixo foi conferido por mutação — arrancada a trava, ele fica
 * VERMELHO. Teste de invariante que continua verde sem a invariante dá uma
 * garantia que ele não tem:
 *
 * | trava                                     | arrancando ela                           |
 * |-------------------------------------------|------------------------------------------|
 * | sem autor não grava                       | tirar a checagem do helper               |
 * | e-mail do autor carimbado na linha        | gravar `actor_email` nulo                |
 * | nome de entidade/ato num formato só       | tirar `NOME_VALIDO`                      |
 * | a linha guarda o estado inteiro           | reduzir antes/depois à diferença         |
 * | salvar sem mudar nada não vira ato        | tirar a checagem de `diferenca`          |
 * | a auditoria anda junto com o ato          | ignorar o `executor` e usar o pool       |
 * | linha é só leitura                        | `DROP TRIGGER audit_log_somente_leitura` |
 * | a consulta não cruza organização          | tirar `a.org_id = $1` do WHERE           |
 * | `LEFT JOIN users`, não `JOIN`             | trocar por `JOIN`                        |
 * | a rota tem tranca própria                 | tirar o `podeFazer` da rota              |
 * | data torta responde em português          | tirar o `dia()` da rota                  |
 * | uma pessoa = uma opção no filtro          | pôr `actor_email` de volta no GROUP BY   |
 * | o cabeçalho conta o recorte               | contar `opcoes.pessoas.length`           |
 *
 * ⚠ A linha do `podeFazer` já foi um teste DECORATIVO, e só ficou vermelha
 * depois de reescrita. O caso que existia — "a portaria toma 403" — é
 * verdadeiro, mas quem recusa a portaria é o `middleware/03.papel.ts`, que
 * roda ANTES do handler: `/api/admin/auditoria` não está classificada em
 * `AREA_DA_RAIZ` de `utils/papeis.ts`, então a grade tranca a rota inteira
 * em "só master" e o handler não executa uma linha. Arrancado o `podeFazer`
 * da rota, os 16 casos continuavam VERDES. O que exercita a tranca da rota é
 * o caso do papel DESENCONTRADO, lá embaixo.
 *
 * Os testes de consulta precisam do servidor de dev no ar. Sem ele, PULAM em
 * vez de falhar.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { db, q, q1, tx } from './db'
import { diferenca, registrarAuditoria, type Autor } from './auditoria'
import { comSessao } from '../../scripts/teste-sessao'

const BASE = process.env.BASE_TESTE ?? 'http://localhost:3100'
const SLUG = 'conquista-park-4-edicao'

/**
 * Entidade só deste teste: a limpeza do fim apaga exatamente `entity = ...`,
 * nunca "por data" nem "por organização" — as linhas reais do evento semeado
 * moram na mesma tabela.
 */
const ENTIDADE = 'zz_auditoria_teste'

/** ids fixos próprios */
const ORG_VIZINHA = '00000000-0000-4000-8000-0000000019b1'
const USUARIO_VIZINHO = '00000000-0000-4000-8000-0000000019b2'
const USUARIO_DEMITIDO = '00000000-0000-4000-8000-0000000019b3'
const ALVO = '00000000-0000-4000-8000-0000000019b4'

/**
 * Pessoa cujas DUAS colunas de papel se desencontram: `users.papel = master`
 * (é o que o `middleware/03.papel.ts` lê) e `users.role = portaria` (é o que
 * viaja na sessão até o handler). Ela passa pelo portão e é recusada pela
 * tranca da própria rota — o único caminho que exercita essa tranca hoje.
 */
const USUARIO_DESENCONTRADO = '00000000-0000-4000-8000-0000000019b5'
const EMAIL_DESENCONTRADO = 'desencontrado.auditoria@teste.invalido'

/** Autor com atos dos DOIS jeitos: pelo helper (carimba e-mail) e por fora (não carimba). */
const USUARIO_SEM_CARIMBO = '00000000-0000-4000-8000-0000000019b6'
const EMAIL_SEM_CARIMBO = 'duplo.auditoria@teste.invalido'

/**
 * As duas contas que ESTE arquivo usa pra bater na rota — e o motivo de elas
 * existirem em vez de `entrar('master')`.
 *
 * O freio de força bruta conta as falhas POR E-MAIL: oito senhas erradas em
 * 15 minutos e aquele e-mail para de logar. `autenticacao.test.ts` erra a
 * senha de `dono@fazendapark.com.br` DE PROPÓSITO (é o caso dele), e os
 * outros arquivos da suíte logam com esse mesmo e-mail. Resultado medido: na
 * corrida da suíte inteira o login do dono volta 429, o `beforeAll` daqui
 * desiste, e os NOVE casos de consulta pulam — antes, pulavam contados como
 * ✓, então a suíte afirmava que a cerca de organização, o `LEFT JOIN` e a
 * tranca de papel estavam provados sem ter batido na rota uma única vez.
 *
 * Com e-mail próprio, o balde do freio é só deste arquivo: ninguém queima e
 * os casos rodam de verdade na suíte inteira.
 */
const USUARIO_AUDITOR = '00000000-0000-4000-8000-0000000019b7'
const EMAIL_AUDITOR = 'auditor.auditoria@teste.invalido'
const USUARIO_PORTEIRO = '00000000-0000-4000-8000-0000000019b8'
const EMAIL_PORTEIRO = 'porteiro.auditoria@teste.invalido'

/** todas as pessoas de fixture deste arquivo, pra criar e pra limpar */
const FIXTURAS = [
  USUARIO_DEMITIDO, USUARIO_DESENCONTRADO, USUARIO_SEM_CARIMBO,
  USUARIO_AUDITOR, USUARIO_PORTEIRO,
]
const EMAILS_FIXTURA = [EMAIL_DESENCONTRADO, EMAIL_SEM_CARIMBO, EMAIL_AUDITOR, EMAIL_PORTEIRO]

let noAr = false
let porQuePulou = 'servidor fora do ar'
let dono: Autor
let cookieDono = ''
/** hoje segundo o BANCO: é ele quem resolve o `::date` do filtro de período */
let hoje = ''
let ontem = ''

const vizinho: Autor = {
  usuarioId: USUARIO_VIZINHO, orgId: ORG_VIZINHA,
  email: 'vizinho.auditoria@teste.invalido', ip: '10.0.0.9',
}

/**
 * Apaga linha de auditoria pela única porta que o gatilho do 019 aceita.
 * `SET LOCAL` morre no COMMIT, então a liberação não vaza pra próxima query
 * da mesma conexão do pool.
 */
async function expurgar(onde: string, par: any[] = []) {
  const c = await db().connect()
  try {
    await c.query('BEGIN')
    await c.query(`SET LOCAL auditoria.expurgo = 'liberado'`)
    await c.query(`DELETE FROM audit_log WHERE ${onde}`, par)
    await c.query('COMMIT')
  } finally {
    // ROLLBACK no finally: falha de asserção no meio deixaria a transação
    // aberta presa na conexão devolvida, e o caso seguinte travaria até o
    // timeout. Depois do COMMIT ele é inócuo.
    try { await c.query('ROLLBACK') } catch { /* já fechou */ }
    c.release()
  }
}

const linha = (id: number) =>
  q1<any>(`SELECT * FROM audit_log WHERE id = $1`, [id])

/**
 * Login de um usuário de fixture. O `entrar()` compartilhado só conhece as
 * duas contas do seed, e o caso do papel desencontrado precisa de uma
 * terceira — feita aqui, com a senha do dono copiada junto com o hash.
 */
async function entrarComo(email: string, senha = 'diamond123'): Promise<string> {
  const r = await fetch(`${BASE}/api/auth/entrar`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, senha }),
  })
  if (!r.ok) throw new Error(`login de ${email} falhou (${r.status})`)
  const sessao = (r.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(';')[0]).find((c) => c.startsWith('dt_sessao='))
  if (!sessao) throw new Error(`login de ${email} não devolveu o cookie de sessão`)
  return sessao
}

beforeAll(async () => {
  const [{ hoje: h, ontem: o }] = await q<any>(
    `SELECT current_date::text AS hoje, (current_date - 1)::text AS ontem`)
  hoje = h; ontem = o

  const u = await q1<any>(
    `SELECT id, org_id, email FROM users WHERE email = 'dono@fazendapark.com.br'`)
  if (!u) throw new Error('o usuário do seed não está no banco — rodou o seed?')
  dono = { usuarioId: u.id, orgId: u.org_id, email: u.email, ip: '200.1.2.3' }

  // vizinho: organização e pessoa próprias, pra provar que a consulta não
  // atravessa a cerca
  await q(`INSERT INTO organizations (id, name, slug)
           VALUES ($1,'ZZ AUDITORIA TESTE','zz-auditoria-teste')
           ON CONFLICT (id) DO NOTHING`, [ORG_VIZINHA])
  await q(`INSERT INTO users (id, org_id, name, email, password_hash, role)
           SELECT $1, $2, 'Vizinho Auditoria', $3, password_hash, 'master'
             FROM users WHERE email = 'dono@fazendapark.com.br'
           ON CONFLICT (id) DO NOTHING`, [USUARIO_VIZINHO, ORG_VIZINHA, vizinho.email])

  // Pessoa com as duas colunas de papel em desacordo. `papel` vai EXPLÍCITO
  // porque o gatilho `users_papel_quando_omitido` deriva o papel do `role` —
  // e derivado ele nasceria 'portaria', barrado já no portão, que é
  // justamente o caminho que este par não pode tomar.
  //
  // O DELETE por e-mail antes do INSERT é por causa do UNIQUE (org_id,
  // email): rodada anterior interrompida deixaria a linha com outro id e o
  // `ON CONFLICT (id)` não alcançaria.
  await q(`DELETE FROM users WHERE email = ANY($1::text[])`, [EMAILS_FIXTURA])
  await q(`INSERT INTO users (id, org_id, name, email, password_hash, role, papel)
           SELECT $1, $2, 'Papel Desencontrado', $3, password_hash, 'portaria', 'master'
             FROM users WHERE email = 'dono@fazendapark.com.br'`,
    [USUARIO_DESENCONTRADO, dono.orgId, EMAIL_DESENCONTRADO])
  await q(`INSERT INTO users (id, org_id, name, email, password_hash, role)
           SELECT $1, $2, 'Autor Sem Carimbo', $3, password_hash, 'operacional'
             FROM users WHERE email = 'dono@fazendapark.com.br'`,
    [USUARIO_SEM_CARIMBO, dono.orgId, EMAIL_SEM_CARIMBO])
  // as duas contas que batem na rota, com balde de freio só deste arquivo
  await q(`INSERT INTO users (id, org_id, name, email, password_hash, role, papel)
           SELECT $1, $2, 'Auditor Teste', $3, password_hash, 'master', 'master'
             FROM users WHERE email = 'dono@fazendapark.com.br'`,
    [USUARIO_AUDITOR, dono.orgId, EMAIL_AUDITOR])
  await q(`INSERT INTO users (id, org_id, name, email, password_hash, role, papel)
           SELECT $1, $2, 'Porteiro Teste', $3, password_hash, 'portaria', 'portaria'
             FROM users WHERE email = 'dono@fazendapark.com.br'`,
    [USUARIO_PORTEIRO, dono.orgId, EMAIL_PORTEIRO])

  // começa limpo: rodada anterior interrompida não pode fazer contagem mentir
  await expurgar(`entity = $1`, [ENTIDADE])

  // Três tentativas, não uma. Com 2500 ms e uma chance só, QUALQUER lentidão
  // do servidor compartilhado — um HMR no meio da corrida, outro agente
  // batendo na mesma porta — fazia esta sonda falhar e os nove casos de
  // consulta virarem verdes sem ter rodado. Aconteceu de verdade: a suíte
  // dizia "20 passed" com a rota inteira nunca exercitada.
  for (let tentativa = 1; tentativa <= 3 && !noAr; tentativa++) {
    try {
      noAr = (await fetch(`${BASE}/api/e/${SLUG}`, { signal: AbortSignal.timeout(8000) })).ok
    } catch (e: any) {
      porQuePulou = `servidor fora do ar — ${e?.message ?? e}`
      if (tentativa < 3) await new Promise((r) => setTimeout(r, 1500))
    }
  }

  if (noAr) {
    // Mesmo com e-mail próprio o login pode falhar por motivo que não é deste
    // teste (servidor recompilando no meio). Os casos de banco não dependem de
    // sessão nenhuma e continuam rodando; o motivo vai pro aviso do pulo em
    // vez de virar silêncio.
    try {
      cookieDono = await entrarComo(EMAIL_AUDITOR)
    } catch (e: any) {
      noAr = false
      porQuePulou = `sem sessão de teste — ${e?.message ?? e}`
    }
  }
}, 30_000)

afterAll(async () => {
  await expurgar(`entity = $1`, [ENTIDADE])
  await q(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [[USUARIO_VIZINHO, ...FIXTURAS]])
  await q(`DELETE FROM organizations WHERE id = $1`, [ORG_VIZINHA])
})

/* ======================================================= gravação: quem */

describe('o registro diz quem fez', () => {
  it('grava quem, o que mudou e quando, de uma vez', async () => {
    const id = await registrarAuditoria({
      autor: dono, entidade: ENTIDADE, entidadeId: ALVO, acao: 'editado',
      antes: { faceCents: 8500, visivel: true },
      depois: { faceCents: 9000, visivel: true },
    })
    expect(id).toBeTruthy()

    const l = await linha(id!)
    // quem
    expect(l.user_id).toBe(dono.usuarioId)
    expect(l.actor_email).toBe(dono.email)
    expect(l.ip).toBe('200.1.2.3')
    expect(l.org_id).toBe(dono.orgId)
    // o que mudou
    expect(l.before).toEqual({ faceCents: 8500, visivel: true })
    expect(l.after).toEqual({ faceCents: 9000, visivel: true })
    // quando
    expect(new Date(l.created_at).getTime()).toBeGreaterThan(Date.now() - 60_000)
  })

  it('ato sem autor não vira linha', async () => {
    const antes = await contar()
    const anonimo = { usuarioId: '', orgId: dono.orgId, email: '', ip: null } as Autor

    await expect(registrarAuditoria({
      autor: anonimo, entidade: ENTIDADE, entidadeId: ALVO, acao: 'apagado',
      antes: { nome: 'Lote Promocional' },
    })).rejects.toThrow(/sem autor/i)

    // ← a asserção que importa: não é só o erro, é que NADA foi gravado.
    //   Uma linha anônima ocupa a tela parecendo resposta e não é.
    expect(await contar()).toBe(antes)
  })

  it('nome de entidade e de ato fora do formato não entram', async () => {
    // O filtro da tela é um <select> alimentado pelos valores distintos da
    // coluna. `Ingresso`, `ingresso` e `INGRESSO ` viram três opções pro
    // mesmo ato, e escolher uma esconde dois terços dos registros.
    for (const torto of ['Ingresso', 'venda balcao', '']) {
      await expect(registrarAuditoria({
        autor: dono, entidade: torto, entidadeId: ALVO, acao: 'editado',
        depois: { x: 1 },
      })).rejects.toThrow(/fora do formato|entidade/i)

      await expect(registrarAuditoria({
        autor: dono, entidade: ENTIDADE, entidadeId: ALVO, acao: torto,
        depois: { x: 1 },
      })).rejects.toThrow(/fora do formato|ato/i)
    }
  })
})

/* ================================================ gravação: o que mudou */

describe('o registro diz o que mudou', () => {
  it('o campo que NÃO mudou continua na linha — é por ele que se procura', async () => {
    const id = await registrarAuditoria({
      autor: dono, entidade: ENTIDADE, entidadeId: ALVO, acao: 'cortesia_cancelada',
      antes: { codigo: 'DT-NAOSOME', status: 'valido' },
      depois: { codigo: 'DT-NAOSOME', status: 'cancelado' },
    })
    const l = await linha(id!)

    // ← a primeira versão deste helper reduzia a linha ao que mudou, e o
    //   `codigo` — idêntico dos dois lados — evaporava. Quem pergunta "quem
    //   cancelou o ingresso DT-NAOSOME?" procura pelo campo que ficou igual.
    expect(l.before.codigo).toBe('DT-NAOSOME')
    expect(l.after.codigo).toBe('DT-NAOSOME')
    expect(l.before.status).toBe('valido')
    expect(l.after.status).toBe('cancelado')
  })

  it('salvar sem mexer em nada não vira ato', async () => {
    const antes = await contar()
    const id = await registrarAuditoria({
      autor: dono, entidade: ENTIDADE, entidadeId: ALVO, acao: 'editado',
      antes: { faceCents: 8500 }, depois: { faceCents: 8500 },
    })
    expect(id).toBeNull()
    expect(await contar()).toBe(antes)
  })

  it('criação e remoção guardam o estado inteiro', async () => {
    const criou = await registrarAuditoria({
      autor: dono, entidade: ENTIDADE, entidadeId: ALVO, acao: 'criado',
      depois: { nome: 'Lote 2', faceCents: 12000 },
    })
    expect((await linha(criou!)).after).toEqual({ nome: 'Lote 2', faceCents: 12000 })

    const apagou = await registrarAuditoria({
      autor: dono, entidade: ENTIDADE, entidadeId: ALVO, acao: 'apagado',
      antes: { nome: 'Lote 2', faceCents: 12000, vendidos: 0 },
    })
    expect((await linha(apagou!)).before)
      .toEqual({ nome: 'Lote 2', faceCents: 12000, vendidos: 0 })
  })

  it('diferenca compara pelo conteúdo, não pela referência', () => {
    expect(diferenca({ a: { x: 1 } }, { a: { x: 1 } })).toBeNull()
    expect(diferenca({ a: { x: 1 } }, { a: { x: 2 } }))
      .toEqual({ antes: { a: { x: 1 } }, depois: { a: { x: 2 } } })
    // campo que só existe de um lado conta como mudança
    expect(diferenca({}, { motivo: 'cliente desistiu' }))
      .toEqual({ antes: { motivo: null }, depois: { motivo: 'cliente desistiu' } })
  })
})

/* ============================================== a auditoria anda junto */

describe('a auditoria anda junto com o ato', () => {
  it('ato que dá rollback não deixa registro dizendo que aconteceu', async () => {
    let id: number | null = null

    await expect(tx(async (c) => {
      id = await registrarAuditoria({
        autor: dono, entidade: ENTIDADE, entidadeId: ALVO, acao: 'venda_balcao',
        depois: { totalCents: 25000, forma: 'dinheiro' },
      }, c)
      expect(id).toBeTruthy()
      // o ato falha DEPOIS de auditar — a ordem real de um handler
      throw new Error('estoque acabou no meio')
    })).rejects.toThrow('estoque acabou no meio')

    // ← o teste inteiro é esta linha. Com o helper ignorando o `executor` e
    //   escrevendo pelo pool, a auditoria sobrevive ao rollback e o sistema
    //   passa a afirmar uma venda que nunca existiu.
    expect(await linha(id!)).toBeNull()
  })

  it('ato que confirma deixa o registro junto', async () => {
    const id = await tx(async (c) => registrarAuditoria({
      autor: dono, entidade: ENTIDADE, entidadeId: ALVO, acao: 'venda_balcao',
      depois: { totalCents: 25000, forma: 'dinheiro' },
    }, c))
    // ← sem esta, o teste acima ficaria verde com a gravação quebrada de vez
    expect(await linha(id!)).toBeTruthy()
  })
})

/* ========================================================= linha travada */

describe('a linha de auditoria é definitiva', () => {
  it('não dá pra alterar nem apagar o que já foi registrado', async () => {
    const id = await registrarAuditoria({
      autor: dono, entidade: ENTIDADE, entidadeId: ALVO, acao: 'solicitada',
      depois: { valorCents: 900000, beneficiario: 'Fazenda Park' },
    })

    await expect(q(`UPDATE audit_log SET after = '{}'::jsonb WHERE id = $1`, [id]))
      .rejects.toThrow(/não pode ser alterada/i)
    await expect(q(`DELETE FROM audit_log WHERE id = $1`, [id]))
      .rejects.toThrow(/não pode ser apagada/i)

    // e continua lá, inteira
    const l = await linha(id!)
    expect(l.after).toEqual({ valorCents: 900000, beneficiario: 'Fazenda Park' })
  })

  it('a evidência sobrevive à saída de quem fez', async () => {
    await q(`INSERT INTO users (id, org_id, name, email, password_hash, role)
             SELECT $1, $2, 'Demitido Teste', 'demitido.auditoria@teste.invalido',
                    password_hash, 'operacional'
               FROM users WHERE email = 'dono@fazendapark.com.br'
             ON CONFLICT (id) DO NOTHING`, [USUARIO_DEMITIDO, dono.orgId])

    const id = await registrarAuditoria({
      autor: { usuarioId: USUARIO_DEMITIDO, orgId: dono.orgId,
               email: 'demitido.auditoria@teste.invalido', ip: '10.1.1.1' },
      entidade: ENTIDADE, entidadeId: ALVO, acao: 'apagado',
      antes: { codigo: 'DT-TESTE1' },
    })

    await q(`DELETE FROM users WHERE id = $1`, [USUARIO_DEMITIDO])

    // ← um ON DELETE SET NULL em `user_id` apagaria a autoria junto com a
    //   pessoa, que é exatamente o que quem saiu brigado ia querer.
    const l = await linha(id!)
    expect(l.user_id).toBe(USUARIO_DEMITIDO)
    expect(l.actor_email).toBe('demitido.auditoria@teste.invalido')
  })
})

/* ============================================================== consulta */

describe('a consulta responde a pergunta do produtor', () => {
  it('quem cancelou este ingresso: acha pelo código, com nome e horário', async (ctx) => {
    seForaDoArPula(ctx)

    await registrarAuditoria({
      autor: dono, entidade: ENTIDADE, entidadeId: ALVO, acao: 'cortesia_cancelada',
      antes: { codigo: 'DT-ZZTESTE', status: 'valido' },
      depois: { codigo: 'DT-ZZTESTE', status: 'cancelado' },
    })

    const r = await comSessao(cookieDono)('/api/admin/auditoria?busca=DT-ZZTESTE')
    expect(r.status).toBe(200)
    const d = await r.json()

    const achado = d.linhas.find((l: any) => l.acao === 'cortesia_cancelada')
    expect(achado, 'não achei o ato pelo código do ingresso').toBeTruthy()
    expect(achado.autor.nome).toBeTruthy()          // quem
    expect(achado.autor.email).toBe(dono.email)     // quem, carimbado
    expect(achado.antes.status).toBe('valido')      // o que mudou
    expect(achado.depois.status).toBe('cancelado')
    expect(new Date(achado.quando).getTime())       // quando
      .toBeGreaterThan(Date.now() - 60_000)
  }, 20_000)

  it('filtra por período, por pessoa, por ato e por entidade', async (ctx) => {
    seForaDoArPula(ctx)

    await registrarAuditoria({
      autor: dono, entidade: ENTIDADE, entidadeId: ALVO, acao: 'sangria',
      depois: { valorCents: 50000, motivo: 'retirada do cofre' },
    })
    const http = comSessao(cookieDono)
    const linhasDe = async (qs: string) =>
      (await http(`/api/admin/auditoria?${qs}`).then((x) => x.json())).linhas
        .filter((l: any) => l.entidade === ENTIDADE)

    // entidade
    expect((await linhasDe(`entidade=${ENTIDADE}`)).length).toBeGreaterThan(0)
    // ato
    const sangrias = await linhasDe(`entidade=${ENTIDADE}&ato=sangria`)
    expect(sangrias.length).toBe(1)
    expect(sangrias[0].depois.valorCents).toBe(50000)
    // pessoa
    expect((await linhasDe(`entidade=${ENTIDADE}&pessoa=${dono.usuarioId}`)).length)
      .toBeGreaterThan(0)
    expect((await linhasDe(`entidade=${ENTIDADE}&pessoa=sem-autor`)).length).toBe(0)
    // período — hoje traz, ontem-a-ontem não
    expect((await linhasDe(`entidade=${ENTIDADE}&de=${hoje}&ate=${hoje}`)).length)
      .toBeGreaterThan(0)
    expect((await linhasDe(`entidade=${ENTIDADE}&de=${ontem}&ate=${ontem}`)).length).toBe(0)
  }, 30_000)

  it('não mostra o que aconteceu na organização do vizinho', async (ctx) => {
    seForaDoArPula(ctx)

    const id = await registrarAuditoria({
      autor: vizinho, entidade: ENTIDADE, entidadeId: ALVO, acao: 'venda_balcao',
      depois: { totalCents: 777777, observacao: 'SEGREDO DO VIZINHO' },
    })
    expect(await linha(id!), 'a linha do vizinho precisa existir de verdade').toBeTruthy()

    const d = await comSessao(cookieDono)('/api/admin/auditoria?limite=1000')
      .then((r) => r.json())

    // ← esta tabela guarda valor de venda, motivo de estorno e o antes/depois
    //   do preço. Um vazamento aqui entrega a operação inteira do vizinho.
    expect(d.linhas.some((l: any) => l.id === id)).toBe(false)
    expect(JSON.stringify(d).includes('SEGREDO DO VIZINHO')).toBe(false)
    expect(d.opcoes.pessoas.some((p: any) => p.email === vizinho.email)).toBe(false)
  }, 20_000)

  it('o ato de quem saiu da equipe continua aparecendo, marcado', async (ctx) => {
    seForaDoArPula(ctx)

    // autor que não existe mais em `users`: é o estado de quem foi removido
    const id = await registrarAuditoria({
      autor: { usuarioId: USUARIO_DEMITIDO, orgId: dono.orgId,
               email: 'demitido.auditoria@teste.invalido', ip: null },
      entidade: ENTIDADE, entidadeId: ALVO, acao: 'apagado',
      antes: { codigo: 'DT-SUMIU' },
    })

    const d = await comSessao(cookieDono)(`/api/admin/auditoria?busca=DT-SUMIU`)
      .then((r) => r.json())

    // ← com `JOIN users` em vez de `LEFT JOIN`, a linha some em silêncio:
    //   some justamente o ato de quem já não está mais aqui pra explicar.
    const achado = d.linhas.find((l: any) => l.id === id)
    expect(achado, 'a linha do autor removido sumiu da consulta').toBeTruthy()
    expect(achado.autor.removido).toBe(true)
    expect(achado.autor.email).toBe('demitido.auditoria@teste.invalido')
  }, 20_000)

  it('quem não cuida do dinheiro não lê a auditoria', async (ctx) => {
    seForaDoArPula(ctx)

    const r = await comSessao(await entrarComo(EMAIL_PORTEIRO))('/api/admin/auditoria')
    expect(r.status).toBe(403)
    // Mensagem pra humano: diz o papel e o que fazer, não "Forbidden". Esta
    // tabela tem valor de venda, motivo de estorno e e-mail de operador — não
    // é leitura de quem só abre catraca.
    const msg = (await r.json()).statusMessage ?? ''
    expect(msg).toMatch(/portaria/i)
    expect(msg).not.toMatch(/forbidden|invalid|unauthorized/i)

    // ← sem esta, a trava poderia estar barrando TODO MUNDO e o caso acima
    //   ficaria verde com a tela morta pra todos.
    expect((await comSessao(cookieDono)('/api/admin/auditoria')).status).toBe(200)

    // AVISO pra quem mexer aqui: este caso NÃO prova a checagem da rota. Quem
    // recusa a portaria é o `middleware/03.papel.ts`, pela grade de
    // `utils/papeis.ts`, e ele responde antes de o handler rodar. O caso
    // seguinte é o que exercita a tranca da própria rota.
  }, 20_000)

  it('a rota tem tranca própria: não terceiriza a permissão pro middleware', async (ctx) => {
    seForaDoArPula(ctx)

    // Duas colunas dizem o papel da mesma pessoa, e elas PODEM desencontrar:
    // o middleware lê `users.papel` (a grade nova, de `utils/papeis.ts`) e a
    // sessão que chega no handler carrega `users.role` (a grade velha, de
    // `utils/sessao.ts`). Quem tem `papel = master` e `role = portaria` passa
    // pelo portão e chega no handler como portaria — e a tabela que ele está
    // abrindo tem valor de venda, motivo de estorno e e-mail de operador.
    const r = await comSessao(await entrarComo(EMAIL_DESENCONTRADO))('/api/admin/auditoria')

    expect(r.status,
      'o portão liberou e a rota não conferiu nada: a auditoria abriu pra quem é portaria')
      .toBe(403)

    const msg = (await r.json()).statusMessage ?? ''
    // A recusa é DA ROTA. A do portão fala outra frase ("liberada para nenhum
    // acesso além do master") — se for ela que aparecer aqui, o teste está
    // medindo o middleware de novo e a tranca da rota voltou a ser decorativa.
    expect(msg).toMatch(/auditoria/i)
    expect(msg).not.toMatch(/além do master/i)
  }, 20_000)

  it('data torta no link vira recado de gente, não "Server Error"', async (ctx) => {
    seForaDoArPula(ctx)
    const http = comSessao(cookieDono)

    // O recorte mora na URL de propósito, então a data chega como texto
    // qualquer: link cortado, colado pela metade, ou navegador sem
    // `<input type="date">` mandando `20/09/2026`.
    for (const torto of ['abc', '2026-13-45', '2026-02-30', '20/09/2026', '2026-09']) {
      const r = await http(`/api/admin/auditoria?de=${encodeURIComponent(torto)}`)
      expect(r.status, `?de=${torto} devia ser recusa de entrada, não erro de servidor`)
        .toBe(400)
      const msg = (await r.json()).statusMessage ?? ''
      // ← sem o `dia()` na rota, isto era 500 e a tela mostrava "Server
      //   Error" pro operador de guichê às 21h. `2026-02-30` é o que só a ida
      //   e volta pega: passa no formato e o `Date` rola pra 2 de março.
      expect(msg).toMatch(/data/i)
      expect(msg).not.toMatch(/invalid input syntax|Server Error|date\/time field/i)
    }

    // e a data boa continua entrando
    expect((await http(`/api/admin/auditoria?de=${hoje}&ate=${hoje}`)).status).toBe(200)
  }, 30_000)

  it('a mesma pessoa não vira duas opções no filtro', async (ctx) => {
    seForaDoArPula(ctx)

    // um ato pelo helper — carimba `actor_email`…
    await registrarAuditoria({
      autor: { usuarioId: USUARIO_SEM_CARIMBO, orgId: dono.orgId,
               email: EMAIL_SEM_CARIMBO, ip: null },
      entidade: ENTIDADE, entidadeId: ALVO, acao: 'editado', depois: { faceCents: 1000 },
    })
    // …e dois como os 26 arquivos que gravam por fora: `user_id` sim,
    // `actor_email` não. É o estado real do banco hoje, não hipótese.
    await q(
      `INSERT INTO audit_log (org_id, user_id, entity, entity_id, action, after)
       VALUES ($1,$2,$3,$4,'venda_balcao','{}'::jsonb), ($1,$2,$3,$4,'sangria','{}'::jsonb)`,
      [dono.orgId, USUARIO_SEM_CARIMBO, ENTIDADE, ALVO])

    const d = await comSessao(cookieDono)('/api/admin/auditoria?limite=1').then((x) => x.json())
    const dela = d.opcoes.pessoas.filter((p: any) => p.id === USUARIO_SEM_CARIMBO)

    // ← com `actor_email` no GROUP BY, a mesma pessoa virava DUAS opções no
    //   `<select>` com o mesmo nome e contagens diferentes ("Dono (17)" e
    //   "Dono (3)", medido no banco), escolher qualquer uma dava a mesma
    //   lista, e o `:key` repetido ainda quebrava a renderização.
    expect(dela.length, 'a mesma pessoa apareceu mais de uma vez no filtro').toBe(1)
    expect(dela[0].atos, 'a contagem da pessoa perdeu os atos sem e-mail carimbado').toBe(3)
    expect(dela[0].email).toBe(EMAIL_SEM_CARIMBO)
    expect(dela[0].nome).toBe('Autor Sem Carimbo')
  }, 30_000)

  it('o cabeçalho conta as pessoas DO RECORTE, não as da organização', async (ctx) => {
    seForaDoArPula(ctx)
    const http = comSessao(cookieDono)

    const vazio = await http('/api/admin/auditoria?de=2020-01-01&ate=2020-01-02&limite=1')
      .then((x) => x.json())
    expect(vazio.total).toBe(0)
    // ← a tela já mostrou "0 atos" e "3 pessoas" um ao lado do outro: o
    //   cabeçalho usava o tamanho de `opcoes.pessoas`, que é a lista do
    //   filtro e cobre a organização inteira.
    expect(vazio.pessoas, 'período sem nenhum ato veio com gente dentro').toBe(0)
    // e a lista do filtro NÃO encolhe junto — é o que deixa trocar de pessoa
    // sem limpar o resto do recorte
    expect(vazio.opcoes.pessoas.length).toBeGreaterThan(0)

    const hojeTem = await http(`/api/admin/auditoria?de=${hoje}&ate=${hoje}&limite=1`)
      .then((x) => x.json())
    expect(hojeTem.pessoas).toBeGreaterThan(0)
  }, 30_000)
})

/**
 * Pula o caso quando o servidor de dev não está no ar — e pula de VERDADE.
 *
 * Antes isto era `if (!noAr) return void console.warn(...)`, e o vitest
 * contava o caso como ✓. Um `console.warn` no stderr some no meio da saída, e
 * a suíte passava a afirmar que nove casos de consulta estavam verdes sem ter
 * batido na rota uma vez — inclusive numa corrida de MUTAÇÃO, onde verde
 * silencioso é a pior resposta possível: dá a invariante por provada
 * justamente quando ela foi arrancada. `ctx.skip()` sai amarelo e contado
 * como pulado, que é o que se pode ler de longe.
 */
function seForaDoArPula(ctx: { skip: (motivo?: string) => void }) {
  if (!noAr) ctx.skip(porQuePulou)
}

/** quantas linhas o teste já deixou na tabela */
async function contar(): Promise<number> {
  const r = await q1<any>(
    `SELECT count(*)::int AS n FROM audit_log WHERE entity = $1`, [ENTIDADE])
  return Number(r.n)
}
