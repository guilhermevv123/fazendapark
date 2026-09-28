/**
 * organizacao-dados.test.ts — PROD-08 e CFG-02/03/04: os dados da empresa que o site mostra.
 *
 * O master preenche razão social, CNPJ, endereço, atendimento e o encarregado de dados em "Dados e
 * cobrança"; o rodapé público e as páginas de Termos, Privacidade e Cancelamento leem de
 * `GET /api/organizacao-publica`. O que este arquivo trava, pela rota de verdade:
 *
 *   · a rota pública devolve SÓ o que é público (nunca chave, carteira, contagem ou equipe), omite
 *     o que está vazio (nada de valor padrão) e trata o CNPJ de exemplo do seed como ausente;
 *   · sem canal da empresa, os contatos que a equipe pôs nos eventos publicados servem de reserva;
 *   · o PATCH normaliza (UF maiúscula, CEP e telefone só dígitos, documento sem pontuação) e recusa
 *     com FRASE o que está errado — CNPJ com dígito errado (CFG-02), UF/CEP/telefone fora do
 *     formato, e-mail inválido dizendo QUAL campo (CFG-04);
 *   · só o master muda o cadastro — o financeiro, que tem o `role` legado 'admin', não (CFG-03).
 *
 * Fixture própria (organização `zz-org-dados-*`), apagada no `afterAll` — a auditoria é só-escrita
 * por gatilho, então a limpeza usa a licença na mesma transação.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { anunciarPulo, BASE_DE_TESTE, seForaDoArPula, sondarServidor, type Sonda } from '../../../scripts/test-setup'
import { db, q, q1 } from '../../utils/db'

const BASE = BASE_DE_TESTE
const ORG = randomUUID()
const SLUG = `zz-org-dados-${ORG.slice(0, 8)}`
const EVENTO_SLUG = `${SLUG}-evento`
const CHAVE = '$aact_hmlg_000000000000000000000000DADOS'
const EMAILS = { master: 'organizacao.dados.master@teste.invalido', financeiro: 'organizacao.dados.financeiro@teste.invalido' }
// CNPJ válido de exemplo da Receita (formato alfanumérico, julho/2026) e um com dígito errado
const CNPJ_VALIDO = '12.ABC.345/01DE-35'
const CNPJ_ERRADO = '12.ABC.345/01DE-36'

let sonda: Sonda = { noAr: false, porque: 'o beforeAll não chegou a rodar' }
const cookies: Record<string, string> = {}

async function entrar(email: string) {
  const r = await fetch(`${BASE}/api/auth/entrar`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, senha: 'diamond123' }),
  })
  return (r.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).find((c) => c.startsWith('dt_sessao=')) ?? ''
}
async function patch(corpo: Record<string, unknown>, quem: 'master' | 'financeiro' = 'master') {
  const r = await fetch(`${BASE}/api/admin/organizacao`, {
    method: 'PATCH', headers: { cookie: cookies[quem] ?? '', 'content-type': 'application/json', origin: BASE },
    body: JSON.stringify(corpo),
  })
  return { status: r.status, corpo: await r.json().catch(() => ({})) }
}
async function publica(consulta = `?evento=${EVENTO_SLUG}`) {
  // SEM cookie: é o que o comprador anônimo lê
  const r = await fetch(`${BASE}/api/organizacao-publica${consulta}`)
  return { status: r.status, corpo: await r.json().catch(() => ({})), texto: '' }
}

async function apagar() {
  const c = await db().connect()
  try {
    await c.query('BEGIN')
    await c.query(`SET LOCAL auditoria.expurgo = 'liberado'`)
    await c.query(`DELETE FROM audit_log WHERE org_id IN (SELECT id FROM organizations WHERE slug LIKE 'zz-org-dados-%')`)
    await c.query(`DELETE FROM organizations WHERE slug LIKE 'zz-org-dados-%'`)
    await c.query('COMMIT')
  } finally {
    try { await c.query('ROLLBACK') } catch { /* já fechou */ }
    c.release()
  }
}

beforeAll(async () => {
  sonda = await sondarServidor('/api/auth/eu')
  anunciarPulo('server/api/admin/organizacao-dados.test.ts', sonda)
  if (!sonda.noAr) return
  await apagar()
  // a organização nasce com o CNPJ de EXEMPLO do seed, uma chave e uma carteira (que nunca podem vazar)
  await q(`INSERT INTO organizations (id, name, slug, document, asaas_api_key, asaas_wallet)
           VALUES ($1, 'ZZ Parque Dados', $2, '00000000000191', $3, 'carteira-zz-secreta')`, [ORG, SLUG, CHAVE])
  await q(`INSERT INTO events (org_id, name, slug, starts_at, ends_at, status, support_kind, support_value)
           VALUES ($1, 'ZZ Evento Dados', $2, now() + interval '5 days', now() + interval '6 days', 'ativo', 'whatsapp', '73999990000')`,
    [ORG, EVENTO_SLUG])
  for (const [papel, email] of Object.entries(EMAILS)) {
    await q(`INSERT INTO users (org_id, name, email, password_hash, papel, role)
             SELECT $1, $2, $3, password_hash, $4, $5 FROM users WHERE email = 'dono@fazendapark.com.br'`,
      [ORG, `Teste ${papel}`, email, papel, papel === 'master' ? 'master' : 'admin'])
    cookies[papel] = await entrar(email)
  }
}, 60_000)

afterAll(async () => {
  if (sonda.noAr) await apagar()
  await db().end()
})

describe('a rota pública: só o que é público, e nada inventado', () => {
  it('antes de preencher: o nome, e os contatos dos eventos como reserva — sem CNPJ de exemplo', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const { status, corpo } = await publica()
    expect(status).toBe(200)
    expect(corpo).toEqual({
      nome: 'ZZ Parque Dados',
      contatosDosEventos: [{ tipo: 'whatsapp', valor: '73999990000' }],
    })
  })

  it('nunca manda chave, carteira nem nada de dentro', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await fetch(`${BASE}/api/organizacao-publica?evento=${EVENTO_SLUG}`)
    const cru = await r.text()
    expect(cru).not.toContain('aact')
    expect(cru).not.toContain('carteira-zz-secreta')
    expect(cru).not.toMatch(/asaas|wallet|clientes|pessoas|cents/i)
  })

  it('evento que não é slug é recusado; slug que não existe é 404', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    expect((await publica('?evento=../../etc')).status).toBe(400)
    expect((await publica('?evento=zz-nao-existe-mesmo')).status).toBe(404)
  })
})

describe('o master preenche (PATCH) e o site mostra', () => {
  it('grava normalizado e a rota pública devolve formatável', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await patch({
      razaoSocial: '  ZZ Parque Aquático LTDA ', documento: CNPJ_VALIDO,
      enderecoLinha: 'Rodovia BA-120, km 5', enderecoBairro: 'Zona Rural', enderecoCidade: 'Ubatã',
      enderecoUf: 'ba', enderecoCep: '45.550-000', emailAtendimento: 'atendimento@zz.teste.invalido',
      telefoneAtendimento: '(73) 3281-0000', encarregadoDados: 'Fulana — privacidade@zz.teste.invalido',
    })
    expect(r.status, JSON.stringify(r.corpo)).toBe(200)
    const banco = await q1<any>(
      `SELECT legal_name, document, address_state, address_zip, support_phone FROM organizations WHERE id = $1`, [ORG])
    expect(banco).toEqual({ legal_name: 'ZZ Parque Aquático LTDA', document: '12ABC34501DE35', address_state: 'BA', address_zip: '45550000', support_phone: '7332810000' })

    const { corpo } = await publica()
    expect(corpo).toEqual({
      nome: 'ZZ Parque Dados', razaoSocial: 'ZZ Parque Aquático LTDA', documento: '12ABC34501DE35',
      endereco: { linha: 'Rodovia BA-120, km 5', bairro: 'Zona Rural', cidade: 'Ubatã', uf: 'BA', cep: '45550000' },
      email: 'atendimento@zz.teste.invalido', telefone: '7332810000',
      encarregado: 'Fulana — privacidade@zz.teste.invalido',
      // com canal da empresa preenchido, a reserva dos eventos não vem
    })
  })

  it('apagar um campo (texto vazio) tira a linha do site', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    expect((await patch({ enderecoBairro: '', encarregadoDados: '   ' })).status).toBe(200)
    const { corpo } = await publica()
    expect(corpo.endereco).not.toHaveProperty('bairro')
    expect(corpo).not.toHaveProperty('encarregado')
    expect(await q1<any>(`SELECT address_district, privacy_contact FROM organizations WHERE id = $1`, [ORG]))
      .toEqual({ address_district: null, privacy_contact: null })
  })
})

describe('recusas com frase (CFG-02, CFG-04)', () => {
  it('CNPJ com dígito errado não grava', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await patch({ documento: CNPJ_ERRADO })
    expect(r.status).toBe(422)
    expect(r.corpo.statusMessage).toContain('dígito verificador')
    expect((await q1<any>(`SELECT document FROM organizations WHERE id = $1`, [ORG]))!.document).toBe('12ABC34501DE35')
  })

  it('UF, CEP e telefone fora do formato dizem o que fazer', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    expect((await patch({ enderecoUf: 'B4' })).corpo.statusMessage).toMatch(/^UF: /)
    expect((await patch({ enderecoCep: '4555' })).corpo.statusMessage).toMatch(/^CEP: são 8 números/)
    expect((await patch({ telefoneAtendimento: '9999-0000' })).corpo.statusMessage).toMatch(/^Telefone de atendimento: /)
  })

  it('e-mail inválido diz QUAL campo — não "Dados inválidos"', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await patch({ emailAtendimento: 'isto-nao-e-email' })
    expect(r.status).toBe(400)
    expect(r.corpo.statusMessage).toContain('E-mail de atendimento')
    expect(r.corpo.statusMessage).not.toBe('Dados inválidos')
  })
})

describe('quem muda (CFG-03)', () => {
  it('o financeiro (role legado admin) recebe 403 e nada muda', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await patch({ razaoSocial: 'Tentativa do financeiro' }, 'financeiro')
    expect(r.status).toBe(403)
    expect((await q1<any>(`SELECT legal_name FROM organizations WHERE id = $1`, [ORG]))!.legal_name).toBe('ZZ Parque Aquático LTDA')
  })
})
