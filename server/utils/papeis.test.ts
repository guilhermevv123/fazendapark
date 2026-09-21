/**
 * A grade de papéis — provada onde ela vale: na ROTA, com o cookie do papel
 * errado.
 *
 * ## Por que não basta testar a tabela
 *
 * A armadilha deste projeto é achar que esconder o item do menu resolveu.
 * Esconder não protege rota: o `fetch` continua lá, o endereço é público, e
 * quem abre o DevTools chega igual. Por isso quase todo caso aqui embaixo
 * **faz login de verdade** com um usuário daquele papel e bate na rota
 * exigindo 403 — os casos de unidade em cima só guardam a tabela de não
 * mudar por engano.
 *
 * ## O que foi MEDIDO antes desta grade existir (servidor no ar, cookie real)
 *
 * | rota                                  | operacional | portaria |
 * |---------------------------------------|-------------|----------|
 * | GET  /evento/:id/financeiro (saldo)   | **200**     | 403      |
 * | POST /evento/:id/financeiro (saque)   | **200**     | 403      |
 * | GET  /evento/:id/bordero              | **200**     | 403      |
 * | GET  /admin/organizacao (chave Asaas) | **200**     | **200**  |
 * | GET  /admin/pedido/:id (CPF, e-mail)  | **200**     | **200**  |
 *
 * Cada linha dessa virou um caso abaixo. Um teste que só confirmasse os 403
 * que o porteiro antigo já dava ficaria verde com esta grade INTEIRA
 * arrancada — e teste assim é pior que não ter teste.
 *
 * ## Fixture
 *
 * Cinco logins próprios — um por papel, mais a portaria com `role` largo que
 * mede esta grade sem a ajuda do porteiro antigo — ids fixos, apagados no
 * `afterAll`.
 * O evento semeado é só LIDO. As únicas linhas que estes casos escrevem nele
 * são as leituras de portaria — que a catraca registra mesmo quando recusa —
 * e elas são apagadas uma a uma no fim, pelo código lido.
 *
 * Servidor fora do ar: PULA em vez de falhar.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { comSessao } from '../../scripts/teste-sessao'
import { db, q, q1 } from './db'
import { podeFazer } from './sessao'
import {
  areaDaRota, decidirAcesso, papelPode, roleLegado, rotaGateada, CATALOGO, PAPEIS,
} from './papeis'

const BASE = process.env.BASE_TESTE ?? 'http://localhost:3100'
const EVENTO = '3cd875a0-e230-448a-892b-d4cc840b1948'
const SENHA = 'diamond123'

/**
 * Prazo dos casos que batem na rota. Os cinco segundos padrão do vitest são
 * curtos aqui e o vermelho que eles dão é MENTIROSO: o servidor de
 * desenvolvimento compila cada handler na primeira chamada, e um caso que
 * visita oito rotas ainda frias gasta o prazo inteiro compilando. Medido
 * depois de aquecidas, as mesmas oito respondem em ~10 ms cada. Prazo curto
 * aqui ensina a suíte a ficar vermelha por motivo que não é permissão — e
 * vermelho que não é o defeito vira vermelho que ninguém olha.
 */
const PRAZO = 20_000

/**
 * ids fixos: o teste apaga exatamente o que criou.
 *
 * **Um login por papel, com e-mail só deste arquivo — inclusive o master.**
 * Usar `dono@fazendapark.com.br` como o master destes casos amarra esta prova
 * a um e-mail que OUTRO arquivo da suíte erra a senha de propósito: o freio de
 * força bruta conta oito erros por e-mail em quinze minutos e, passando disso,
 * o login do dono responde 429 pra suíte inteira. Foi exatamente o que
 * aconteceu — esta grade ficou VERMELHA sem nenhuma permissão ter mudado.
 * Trava de outro teste não pode ser o veredito deste.
 */
const USUARIOS = {
  master:     { id: '00000000-0000-4000-8000-0000000012a0', email: 'master.papeis@teste.local' },
  financeiro: { id: '00000000-0000-4000-8000-0000000012a1', email: 'financeiro.papeis@teste.local' },
  operacao:   { id: '00000000-0000-4000-8000-0000000012a2', email: 'operacao.papeis@teste.local' },
  portaria:   { id: '00000000-0000-4000-8000-0000000012a3', email: 'portaria.papeis@teste.local' },
} as const

/**
 * O quinto login não é um papel novo: é o MESMO papel de portaria com o `role`
 * largo de quem é de operação — a combinação que o porteiro antigo deixa
 * passar inteira pelo prefixo `/api/admin/evento/`.
 *
 * Sem ele, todo 403 de portaria dentro do evento pode estar vindo do porteiro
 * velho, e esta grade ficaria verde mesmo desligada (foi o que a mutação A
 * mostrou: `a portaria não chega no dinheiro` continuou passando com o
 * middleware fora). Com ele, o único que pode negar é o `03` — e o teste
 * confere a MENSAGEM pra não aceitar um 403 de outro dono.
 *
 * As rotas de equipe gravam `papel` e `role` juntos, então esta combinação não
 * nasce pela tela. Ela é o ensaio do dia em que o `01` for aposentado.
 */
const PORTARIA_SOLTA = {
  id: '00000000-0000-4000-8000-0000000012a4',
  email: 'portaria.solta@teste.local',
  papel: 'portaria',
  role: 'operacional', // largo de propósito: o porteiro antigo libera
} as const

/**
 * Organização à parte, com DOIS masters, só pra exercitar a tela de equipe.
 *
 * Não dá pra fazer isso na organização semeada: o caso do último master
 * precisa REBAIXAR master de verdade, e o único master de lá é o
 * `dono@fazendapark.com.br` — dado semeado, que teste nenhum mexe. Aqui a
 * organização inteira é fabricada e apagada no fim (o `DELETE` da
 * organização leva os usuários e as sessões junto, por cascata).
 */
const ORG_EQUIPE = '0000e012-0000-4000-8000-000000000001'
const MASTERS = {
  m1: { id: '0000e012-0000-4000-8000-000000000002', email: 'm1.equipe@teste.local' },
  m2: { id: '0000e012-0000-4000-8000-000000000003', email: 'm2.equipe@teste.local' },
} as const

/* ------------------------------------------------------------- a tabela */

describe('a grade de papéis (tabela)', () => {
  it('classifica dinheiro e configuração de evento como coisas DIFERENTES', () => {
    // é exatamente o que o porteiro antigo não consegue: os dois moram no
    // mesmo prefixo /api/admin/evento/
    expect(areaDaRota(`/api/admin/evento/${EVENTO}/financeiro`)).toBe('dinheiro')
    expect(areaDaRota(`/api/admin/evento/${EVENTO}/bordero`)).toBe('dinheiro')
    expect(areaDaRota(`/api/admin/evento/${EVENTO}/extrato`)).toBe('dinheiro')
    expect(areaDaRota(`/api/admin/evento/${EVENTO}/dashboard`)).toBe('dinheiro')
    expect(areaDaRota(`/api/admin/evento/${EVENTO}/ingressos`)).toBe('evento')
    expect(areaDaRota(`/api/admin/evento/${EVENTO}/cupons`)).toBe('evento')
    expect(areaDaRota(`/api/admin/evento/${EVENTO}/pdv/venda`)).toBe('pdv')
    // o LEITOR e o HISTÓRICO são áreas diferentes: a portaria tem o primeiro
    expect(areaDaRota(`/api/admin/evento/${EVENTO}/checkins`)).toBe('portaria_historico')
    expect(areaDaRota('/api/admin/organizacao')).toBe('organizacao')
    expect(areaDaRota('/api/admin/equipe')).toBe('equipe')
    expect(areaDaRota('/api/checkin')).toBe('portaria')
  })

  it('rota que ninguém classificou é rota só do master', () => {
    const nova = '/api/admin/tela-que-alguem-vai-criar-amanha'
    expect(areaDaRota(nova)).toBe(null)
    expect(decidirAcesso('master', nova).liberado).toBe(true)
    for (const papel of ['financeiro', 'operacao', 'portaria'] as const) {
      expect(decidirAcesso(papel, nova).liberado, papel).toBe(false)
    }
  })

  it('operação não tem dinheiro e portaria não tem nada além da porta', () => {
    expect(papelPode('operacao', 'dinheiro')).toBe(false)
    expect(papelPode('operacao', 'equipe')).toBe(false)
    expect(papelPode('operacao', 'organizacao')).toBe(false)
    expect(papelPode('operacao', 'pdv')).toBe(true)

    for (const area of ['dinheiro', 'evento', 'venda', 'pdv', 'equipe', 'organizacao'] as const) {
      expect(papelPode('portaria', area), area).toBe(false)
    }
    expect(papelPode('portaria', 'portaria')).toBe(true)
  })

  /**
   * Esta grade existe pra SUBSTITUIR o porteiro antigo, não pra depender dele.
   * Enquanto `checkins` era área `portaria`, esta grade liberava a portaria no
   * histórico do evento e quem negava, de fato, era só o `01` — medido:
   * `403 Seu acesso (portaria) não inclui evento`. Aposentar o `01` teria
   * aberto aquela porta sem nenhum teste ficar vermelho.
   */
  it('a portaria não herda o histórico do evento junto com o leitor', () => {
    expect(papelPode('portaria', 'portaria')).toBe(true)
    expect(papelPode('portaria', 'portaria_historico')).toBe(false)
    // quem trabalha no evento continua lendo quem já entrou
    expect(papelPode('operacao', 'portaria_historico')).toBe(true)
    expect(papelPode('master', 'portaria_historico')).toBe(true)
    // e o financeiro não passa a ver o fluxo de gente por tabela nova
    expect(papelPode('financeiro', 'portaria_historico')).toBe(false)

    // a grade fina nega SOZINHA, sem depender do porteiro antigo
    const d = decidirAcesso('portaria', `/api/admin/evento/${EVENTO}/checkins`)
    expect(d.liberado).toBe(false)
    expect(d.motivo).toContain('quem já entrou')
  })

  it('a recusa diz o que a pessoa é e o que fazer, sem código', () => {
    const d = decidirAcesso('portaria', `/api/admin/evento/${EVENTO}/financeiro`)
    expect(d.liberado).toBe(false)
    expect(d.motivo).toContain('Portaria')
    expect(d.motivo).toContain('master')
    expect(d.motivo).not.toMatch(/40[13]|forbidden|invalid/i)
  })

  it('tranca /api/admin e a catraca, e não opina sobre o resto', () => {
    expect(rotaGateada('/api/admin/equipe')).toBe(true)
    expect(rotaGateada('/api/checkin')).toBe(true)
    expect(rotaGateada('/api/e/conquista-park-4-edicao')).toBe(false)
    expect(rotaGateada('/api/auth/eu')).toBe(false)
  })

  it('o catálogo que a tela mostra é a MESMA grade que tranca', () => {
    expect(CATALOGO.map((c) => c.valor)).toEqual(PAPEIS)
    for (const c of CATALOGO) {
      for (const area of c.areas) expect(papelPode(c.valor, area as any)).toBe(true)
    }
  })

  /**
   * A grade fina só decide DEPOIS da grossa. Se o `role` derivado de um papel
   * não passar pelo porteiro antigo, aquele papel fica trancado do lado de
   * fora de algo que esta grade jura que ele pode — e a tela responde 403 sem
   * ninguém entender por quê.
   */
  it('o role derivado deixa cada papel chegar onde a grade fina libera', () => {
    // financeiro precisa de DUAS áreas antigas: o evento (onde mora o saldo
    // e o saque, no mesmo prefixo) e o financeiro global
    expect(podeFazer(roleLegado('financeiro') as any, 'evento')).toBe(true)
    expect(podeFazer(roleLegado('financeiro') as any, 'financeiro')).toBe(true)

    expect(podeFazer(roleLegado('operacao') as any, 'evento')).toBe(true)
    expect(podeFazer(roleLegado('operacao') as any, 'portaria')).toBe(true)

    expect(podeFazer(roleLegado('portaria') as any, 'portaria')).toBe(true)
    // e continua estreita lá também: negação em dois lugares
    expect(podeFazer(roleLegado('portaria') as any, 'evento')).toBe(false)
  })
})

/* -------------------------------------------------------------- na rota */

let noAr = false
let pedidoId = ''
let codigoReal = ''
let inicio = new Date()
/** Por que o login SEMEADO da portaria não entrou, quando não entrou. */
let semPortariaSemeada = ''
const codigosLidos: string[] = []
const http: Record<string, ReturnType<typeof comSessao>> = {}

async function entrarCom(email: string) {
  const r = await fetch(`${BASE}/api/auth/entrar`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, senha: SENHA }),
  })
  if (!r.ok) throw new Error(`login de ${email} falhou (${r.status})`)
  const cookie = (r.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(';')[0]).find((c) => c.startsWith('dt_sessao='))
  if (!cookie) throw new Error(`login de ${email} não devolveu cookie`)
  return cookie
}

beforeAll(async () => {
  try {
    noAr = (await fetch(`${BASE}/api/auth/eu`, { signal: AbortSignal.timeout(2500) })).ok
  } catch { noAr = false }
  if (!noAr) return

  inicio = new Date()

  // A senha é a mesma do dono porque o hash é copiado dele — nenhuma senha
  // nova entra no banco por causa de teste.
  for (const [papel, u] of Object.entries(USUARIOS)) {
    await q(
      `INSERT INTO users (id, org_id, name, email, password_hash, papel, role)
       SELECT $1, org_id, $2, $3, password_hash, $4, $5
         FROM users WHERE email = 'dono@fazendapark.com.br'
       ON CONFLICT (id) DO UPDATE SET papel = EXCLUDED.papel, role = EXCLUDED.role, active = true`,
      [u.id, `Teste ${papel}`, u.email, papel, roleLegado(papel as any)])
    http[papel] = comSessao(await entrarCom(u.email))
  }

  // papel de portaria com `role` de operação — ver PORTARIA_SOLTA lá em cima
  await q(
    `INSERT INTO users (id, org_id, name, email, password_hash, papel, role)
     SELECT $1, org_id, 'Teste portaria solta', $2, password_hash, $3, $4
       FROM users WHERE email = 'dono@fazendapark.com.br'
     ON CONFLICT (id) DO UPDATE SET papel = EXCLUDED.papel, role = EXCLUDED.role, active = true`,
    [PORTARIA_SOLTA.id, PORTARIA_SOLTA.email, PORTARIA_SOLTA.papel, PORTARIA_SOLTA.role])
  http.portariaSolta = comSessao(await entrarCom(PORTARIA_SOLTA.email))

  // O único login que este arquivo NÃO fabrica: o da portaria que já existe no
  // parque. Ele tem que continuar entrando — é metade do item. Se o freio de
  // força bruta o travar por causa de outra rodada, os dois casos dele param
  // dizendo POR QUÊ, em vez de acusar uma permissão que não mudou.
  try {
    http.portariaSemeada = comSessao(await entrarCom('portaria@fazendapark.com.br'))
  } catch (e: any) {
    semPortariaSemeada = e?.message ?? String(e)
  }

  // a organização de dois masters, à parte da semeada — ver MASTERS lá em cima
  await q(`INSERT INTO organizations (id, name, slug)
           VALUES ($1,'ZZ EQUIPE PAPEIS','zz-equipe-papeis')
           ON CONFLICT (id) DO NOTHING`, [ORG_EQUIPE])
  for (const [nome, u] of Object.entries(MASTERS)) {
    await q(
      `INSERT INTO users (id, org_id, name, email, password_hash, papel, role)
       SELECT $1, $2, $3, $4, password_hash, 'master', 'master'
         FROM users WHERE email = 'dono@fazendapark.com.br'
       ON CONFLICT (id) DO UPDATE SET papel = 'master', role = 'master', active = true`,
      [u.id, ORG_EQUIPE, `Master equipe ${nome}`, u.email])
    http[nome] = comSessao(await entrarCom(u.email))
  }

  pedidoId = (await q1<any>(`SELECT id FROM orders WHERE event_id = $1 LIMIT 1`, [EVENTO]))?.id ?? ''
  codigoReal = (await q1<any>(
    `SELECT code FROM tickets WHERE event_id = $1 AND status = 'valido' LIMIT 1`, [EVENTO]))?.code ?? ''
})

afterAll(async () => {
  await q(`DELETE FROM organizations WHERE id = $1`, [ORG_EQUIPE])
  // as leituras que a catraca registrou por causa deste teste, uma a uma
  if (codigosLidos.length) {
    await q(
      `DELETE FROM checkins
        WHERE event_id = $1 AND created_at >= $2 AND code_lido = ANY($3::text[])`,
      [EVENTO, inicio, codigosLidos])
  }
  await q(`DELETE FROM users WHERE id = ANY($1::uuid[])`,
    [[...Object.values(USUARIOS).map((u) => u.id), PORTARIA_SOLTA.id]])
})

/** status da rota, com o cookie daquele papel */
const bater = async (papel: string, rota: string, metodo = 'GET', corpo?: unknown) => {
  const r = await http[papel](rota, {
    method: metodo,
    body: metodo === 'GET' ? undefined : JSON.stringify(corpo ?? {}),
  })
  return { status: r.status, corpo: await r.json().catch(() => ({})) }
}

describe('o papel decide na ROTA, não no menu', () => {
  it('operação não vê o saldo nem pede transferência', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')

    const saldo = await bater('operacao', `/api/admin/evento/${EVENTO}/financeiro`)
    expect(saldo.status, JSON.stringify(saldo.corpo)).toBe(403)

    // o pedido de saque, com corpo VÁLIDO: tem que morrer no porteiro, antes
    // de qualquer linha em payouts
    const antes = await q1<any>(`SELECT count(*)::int AS n FROM payouts WHERE event_id = $1`, [EVENTO])
    const saque = await bater('operacao', `/api/admin/evento/${EVENTO}/financeiro`, 'POST', {
      beneficiario: 'Teste Papéis', destinoTipo: 'pix',
      destino: 'teste@papeis.local', valorCents: 1000,
    })
    expect(saque.status, JSON.stringify(saque.corpo)).toBe(403)
    const depois = await q1<any>(`SELECT count(*)::int AS n FROM payouts WHERE event_id = $1`, [EVENTO])
    expect(depois.n, 'o saque recusado deixou linha em payouts').toBe(antes.n)
  }, PRAZO)

  it('operação não vê borderô, extrato nem painel de faturamento', async () => {
    if (!noAr) return void console.warn('  (pulado)')
    for (const tela of ['bordero', 'extrato', 'dashboard', 'relatorios']) {
      const r = await bater('operacao', `/api/admin/evento/${EVENTO}/${tela}`)
      expect(r.status, `${tela}: ${JSON.stringify(r.corpo)}`).toBe(403)
    }
  }, PRAZO)

  it('operação continua fazendo o trabalho dela', async () => {
    if (!noAr) return void console.warn('  (pulado)')
    for (const tela of ['ingressos', 'cupons', 'vendas', 'pdv', 'checkins']) {
      const r = await bater('operacao', `/api/admin/evento/${EVENTO}/${tela}`)
      expect(r.status, `${tela}: ${JSON.stringify(r.corpo)}`).toBe(200)
    }
  }, PRAZO)

  it('portaria não lê o cadastro da organização nem a ficha do comprador', async () => {
    if (!noAr) return void console.warn('  (pulado)')

    // as duas rotas que respondiam 200 pra QUALQUER login, porque nenhum
    // prefixo do porteiro antigo cobria elas
    const org = await bater('portaria', '/api/admin/organizacao')
    expect(org.status, JSON.stringify(org.corpo)).toBe(403)

    const pedido = await bater('portaria', `/api/admin/pedido/${pedidoId}`)
    expect(pedido.status, JSON.stringify(pedido.corpo)).toBe(403)
  }, PRAZO)

  /**
   * O caso que mede ESTA grade sozinha. Todos os outros 403 de portaria dentro
   * do evento poderiam ser do porteiro antigo — `role = 'portaria'` já não tem
   * a área "evento" lá. Aqui o `role` é o largo de operação, o `01` libera, e
   * quem sobra pra negar é o `03`. Por isso o caso confere a MENSAGEM: um 403
   * com o texto do porteiro velho seria a prova errada.
   */
  it('com o porteiro antigo liberando, a grade fina segura a portaria sozinha', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')

    const hist = await bater('portariaSolta', `/api/admin/evento/${EVENTO}/checkins`)
    expect(hist.status, JSON.stringify(hist.corpo)).toBe(403)
    const motivo = hist.corpo.statusMessage ?? hist.corpo.message ?? ''
    expect(motivo, 'quem negou foi o porteiro antigo, não esta grade')
      .toContain('quem já entrou')

    // e o resto do evento continua fechado pra ela pelo mesmo caminho
    for (const tela of ['financeiro', 'bordero', 'ingressos', 'pdv']) {
      const r = await bater('portariaSolta', `/api/admin/evento/${EVENTO}/${tela}`)
      expect(r.status, `${tela}: ${JSON.stringify(r.corpo)}`).toBe(403)
    }

    // o leitor de entrada, que é o trabalho dela, continua de pé
    const codigo = `PAPEIS-SOLTA-${Date.now()}`
    codigosLidos.push(codigo)
    const leitura = await bater('portariaSolta', '/api/checkin', 'POST',
      { qr: codigo, eventId: EVENTO, gate: 'teste-papeis' })
    expect(leitura.status, JSON.stringify(leitura.corpo)).toBe(200)
  }, PRAZO)

  it('operação também não lê o cadastro e as credenciais de cobrança', async () => {
    if (!noAr) return void console.warn('  (pulado)')
    const org = await bater('operacao', '/api/admin/organizacao')
    expect(org.status, JSON.stringify(org.corpo)).toBe(403)
    // e não troca a chave do Asaas
    const troca = await bater('operacao', '/api/admin/organizacao', 'PATCH', { nome: 'Nome Roubado' })
    expect(troca.status).toBe(403)
  }, PRAZO)

  it('só master mexe em equipe — nem o financeiro', async () => {
    if (!noAr) return void console.warn('  (pulado)')
    for (const papel of ['financeiro', 'operacao', 'portaria']) {
      const ler = await bater(papel, '/api/admin/equipe')
      expect(ler.status, `${papel} leu a equipe`).toBe(403)
      const criar = await bater(papel, '/api/admin/equipe', 'POST',
        { nome: 'Intruso', email: `intruso.${papel}@teste.local`, papel: 'master' })
      expect(criar.status, `${papel} criou acesso`).toBe(403)
    }
    const meu = await q1<any>(
      `SELECT count(*)::int AS n FROM users WHERE email LIKE 'intruso.%@teste.local'`)
    expect(meu.n, 'a criação recusada gravou usuário').toBe(0)
  }, PRAZO)

  it('o financeiro CHEGA no dinheiro — e só nele', async () => {
    if (!noAr) return void console.warn('  (pulado)')

    // antes desta grade, quem era `financeiro` levava 403 aqui: o prefixo do
    // evento não estava na grade grossa dele
    for (const tela of ['financeiro', 'bordero', 'extrato', 'relatorios']) {
      const r = await bater('financeiro', `/api/admin/evento/${EVENTO}/${tela}`)
      expect(r.status, `${tela}: ${JSON.stringify(r.corpo)}`).toBe(200)
    }
    expect((await bater('financeiro', '/api/admin/financeiro')).status).toBe(200)

    // e não configura evento nem vende no balcão
    expect((await bater('financeiro', `/api/admin/evento/${EVENTO}/ingressos`)).status).toBe(403)
    expect((await bater('financeiro', `/api/admin/evento/${EVENTO}/pdv`)).status).toBe(403)
    expect((await bater('financeiro', `/api/admin/evento/${EVENTO}/checkins`)).status).toBe(403)
  }, PRAZO)

  it('rota nova nasce trancada pra quem não é master', async () => {
    if (!noAr) return void console.warn('  (pulado)')
    const nova = '/api/admin/tela-que-alguem-vai-criar-amanha'
    for (const papel of ['financeiro', 'operacao', 'portaria']) {
      expect((await bater(papel, nova)).status, papel).toBe(403)
    }
    // pro master ela simplesmente não existe ainda — 404, que é a resposta do
    // roteador, não do porteiro
    expect((await bater('master', nova)).status).toBe(404)
    // o prazo é folgado de propósito: o 404 de rota inexistente faz o servidor
    // de desenvolvimento montar a página de erro, e isso leva mais de um
    // segundo sozinho
  }, 20_000)
})

describe('a portaria continua entrando e validando', () => {
  /** Pula dizendo o motivo — nunca em silêncio, nunca passando por verde. */
  function semSessaoSemeada(): boolean {
    if (!noAr) { console.warn('  (pulado: servidor fora do ar)'); return true }
    if (semPortariaSemeada) { console.warn(`  (pulado: ${semPortariaSemeada})`); return true }
    return false
  }

  it('o login semeado da portaria entra e a catraca responde', async () => {
    if (semSessaoSemeada()) return

    const eu = await http.portariaSemeada('/api/auth/eu').then((r) => r.json())
    expect(eu.usuario?.email).toBe('portaria@fazendapark.com.br')

    const codigo = `PAPEIS-TESTE-${Date.now()}`
    codigosLidos.push(codigo)
    const r = await bater('portariaSemeada', '/api/checkin', 'POST',
      { qr: codigo, eventId: EVENTO, gate: 'teste-papeis' })
    // chegou no handler: quem responde 'invalido' é a catraca, não o porteiro
    expect(r.status, JSON.stringify(r.corpo)).toBe(200)
    expect(r.corpo.resultado).toBe('invalido')
  }, PRAZO)

  it('a portaria confere um ingresso de verdade sem queimá-lo', async () => {
    if (semSessaoSemeada()) return
    expect(codigoReal, 'o seed não tem ingresso válido').not.toBe('')
    codigosLidos.push(codigoReal)

    const r = await bater('portariaSemeada', '/api/checkin', 'POST',
      { qr: codigoReal, eventId: EVENTO, apenasConsultar: true })
    expect(r.status, JSON.stringify(r.corpo)).toBe(200)
    // O veredito depende da hora: fora da janela da sessão o seed responde
    // `fora_da_sessao`, e isso é a catraca funcionando. O que este caso
    // precisa provar é que ela ACHOU o ingresso — `invalido` é a resposta de
    // código que não existe, e seria também a resposta se a leitura tivesse
    // morrido antes de consultar o banco.
    expect(r.corpo.resultado, JSON.stringify(r.corpo)).not.toBe('invalido')

    // "só conferir" não pode ter gasto o ingresso do evento semeado
    const t = await q1<any>(`SELECT status FROM tickets WHERE code = $1`, [codigoReal])
    expect(t.status).toBe('valido')
  }, PRAZO)

  it('a portaria não chega no dinheiro por nenhum caminho', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    for (const rota of [
      `/api/admin/evento/${EVENTO}/financeiro`,
      `/api/admin/evento/${EVENTO}/bordero`,
      '/api/admin/financeiro',
    ]) {
      expect((await bater('portaria', rota)).status, rota).toBe(403)
      // o login que já existe no parque, além do fabricado aqui: é ele que
      // está no celular do portão hoje
      if (!semPortariaSemeada) {
        expect((await bater('portariaSemeada', rota)).status, rota).toBe(403)
      }
    }
    if (semPortariaSemeada) console.warn(`  (só o login fabricado: ${semPortariaSemeada})`)
  }, PRAZO)
})

/* --------------------------------------------- a organização não fica órfã */

/**
 * O outro lado da grade: quem ENTREGA o papel.
 *
 * A grade acima prova que só o master mexe em equipe. Falta provar que a tela
 * de equipe não consegue apagar o último master — porque, desde que esta
 * grade existe, organização sem master não é só "sem administrador": é
 * organização onde NINGUÉM mais abre equipe (área `equipe`) nem a credencial
 * de cobrança (área `organizacao`), e não existe caminho pela tela pra
 * desfazer. Não é um 422 de conforto; é a única coisa entre a operação e um
 * painel que ninguém mais administra.
 *
 * As três travas do `PATCH /api/admin/equipe` não tinham NENHUM teste. Medido
 * por mutação: arrancando as três de uma vez (a de não se rebaixar sozinho, a
 * do último master e a revogação de sessão) a suíte inteira continuava verde.
 *
 * O caso de concorrência não usa `Promise.all` com dois `fetch` — dois pedidos
 * não chegam juntos no servidor de desenvolvimento e o primeiro já gravou
 * quando o segundo lê. A ordem é forçada na mão: uma terceira conexão segura
 * as linhas dos masters, as duas rotas passam pela decisão e param na hora de
 * gravar, e só então a trava é solta.
 */
describe('a tela de equipe não deixa a organização sem master', () => {
  /** volta os dois pra master e renova os dois cookies (rebaixar revoga sessão) */
  async function doisMastersDePe() {
    await q(
      `UPDATE users SET papel = 'master', role = 'master', active = true
        WHERE id = ANY($1::uuid[])`, [[MASTERS.m1.id, MASTERS.m2.id]])
    for (const [nome, u] of Object.entries(MASTERS)) http[nome] = comSessao(await entrarCom(u.email))
  }

  const mastersAtivos = async () =>
    (await q1<any>(
      `SELECT count(*)::int AS n FROM users
        WHERE org_id = $1 AND papel = 'master' AND active`, [ORG_EQUIPE]))!.n

  it('ninguém se rebaixa nem se desativa sozinho', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    await doisMastersDePe()

    const rebaixar = await bater('m1', '/api/admin/equipe', 'PATCH',
      { id: MASTERS.m1.id, papel: 'operacao' })
    expect(rebaixar.status, JSON.stringify(rebaixar.corpo)).toBe(422)

    const desativar = await bater('m1', '/api/admin/equipe', 'PATCH',
      { id: MASTERS.m1.id, ativo: false })
    expect(desativar.status, JSON.stringify(desativar.corpo)).toBe(422)

    const eu = await q1<any>(`SELECT papel, active FROM users WHERE id = $1`, [MASTERS.m1.id])
    expect(eu.papel, 'ele se rebaixou e não tem como voltar pela tela').toBe('master')
    expect(eu.active, 'ele se trancou pra fora da própria conta').toBe(true)
  }, PRAZO)

  /**
   * A trava do último master, lida com atenção, **nunca dispara num pedido
   * sozinho**: quem manda o PATCH já precisa ser master (área `equipe`), a
   * trava de cima impede que ele seja o próprio alvo, e a contagem é de
   * masters ativos com `id <> alvo` — ou seja, ele mesmo sempre entra na
   * conta. Sequencialmente a resposta certa é 200 e o guarda é decoração.
   *
   * Ele só existe pra UM caso: dois pedidos ao mesmo tempo, cada um tirando
   * um dos dois últimos masters. É o caso do teste abaixo, e é onde a
   * contagem fora da transação não segura nada.
   */
  it('rebaixar um master com outro de pé é permitido — e sobra um', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    await doisMastersDePe()

    const r = await bater('m1', '/api/admin/equipe', 'PATCH',
      { id: MASTERS.m2.id, papel: 'operacao' })
    expect(r.status, JSON.stringify(r.corpo)).toBe(200)
    expect(await mastersAtivos(), 'a trava do último master barrou um caso legítimo').toBe(1)

    // e o rebaixado não se repromove: equipe é área de master
    expect((await bater('m2', '/api/admin/equipe', 'PATCH',
      { id: MASTERS.m2.id, papel: 'master' })).status,
      'um ex-master se repromoveu').not.toBe(200)
  }, PRAZO)

  it('rebaixar alguém derruba a sessão que ele já tinha aberta', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    await doisMastersDePe()

    // a sessão de m2 está de pé agora
    expect((await bater('m2', '/api/admin/equipe')).status).toBe(200)

    expect((await bater('m1', '/api/admin/equipe', 'PATCH',
      { id: MASTERS.m2.id, papel: 'operacao' })).status).toBe(200)

    // 401 (sessão revogada), não 403: 403 seria o papel novo barrando com o
    // cookie antigo ainda válido — que é exatamente o que não pode sobrar.
    const depois = await bater('m2', '/api/admin/equipe')
    expect(depois.status, 'o cookie de antes do rebaixamento continua valendo').toBe(401)
  }, PRAZO)

  /**
   * A trava tem que vir ANTES da decisão. Com a contagem de masters feita
   * fora da transação e sem `FOR UPDATE`, os dois pedidos leem "sobra outro"
   * e os dois gravam: a organização acorda sem master nenhum.
   */
  it('CONCORRÊNCIA — dois masters se rebaixando ao mesmo tempo não zeram a organização',
    async () => {
      if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
      await doisMastersDePe()

      const trava = await db().connect()
      let respostas: number[] = []
      let corpos: any[] = []
      try {
        await trava.query('BEGIN')
        // segura as linhas dos masters desta organização: as duas rotas
        // passam pela decisão e ficam paradas na hora de gravar
        await trava.query(
          `SELECT id FROM users
            WHERE org_id = $1 AND papel = 'master' AND active
            ORDER BY id FOR UPDATE`, [ORG_EQUIPE])

        const p1 = http.m1('/api/admin/equipe', {
          method: 'PATCH', body: JSON.stringify({ id: MASTERS.m2.id, papel: 'operacao' }),
        })
        await new Promise((r) => setTimeout(r, 400))
        const p2 = http.m2('/api/admin/equipe', {
          method: 'PATCH', body: JSON.stringify({ id: MASTERS.m1.id, papel: 'operacao' }),
        })
        await new Promise((r) => setTimeout(r, 400))

        // solta: agora os dois gravam (ou o segundo descobre que virou o último)
        await trava.query('ROLLBACK')
        const fim = await Promise.all([p1, p2])
        respostas = fim.map((r) => r.status)
        corpos = await Promise.all(fim.map((r) => r.json().catch(() => ({}))))
      } finally {
        // ROLLBACK antes de devolver ao pool, SEMPRE — `release()` não desfaz
        // transação aberta e a trava ficaria pendurada no caso seguinte.
        await trava.query('ROLLBACK').catch(() => {})
        trava.release()
      }

      expect(await mastersAtivos(),
        'os dois rebaixamentos passaram: a organização ficou sem nenhum master — '
        + 'ninguém mais abre equipe nem a credencial de cobrança, e não há tela pra desfazer')
        .toBeGreaterThanOrEqual(1)
      // exatamente um pedido pode ter vencido; o outro tem que ouvir a recusa
      expect(respostas.filter((s) => s === 200).length,
        `os dois pedidos foram aceitos (${respostas.join(', ')})`).toBe(1)

      // e a recusa é a MENSAGEM do último master, não um 500 de conflito de
      // banco: quem está na tela precisa saber o que fazer (promover alguém),
      // não ver "erro interno" depois de clicar.
      const i = respostas.findIndex((s) => s !== 200)
      expect(respostas[i], JSON.stringify(corpos[i])).toBe(422)
      expect(corpos[i].statusMessage ?? corpos[i].message ?? '').toContain('último master')
    }, 40_000)
})
