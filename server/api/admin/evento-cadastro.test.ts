/**
 * evento-cadastro.test.ts — o que o assistente de criação, o modal de lote e
 * as Configurações do evento deixavam passar, e agora recusam com frase.
 *
 * Cada caso aqui reproduz um defeito que o QA achou antes da produção:
 *
 *   · lote a R$ 0,00 sem a marca de gratuito vendia de graça no site;
 *   · lote criado pelo painel nascia só `online` e o balcão recusava;
 *   · a capacidade do setor só valia no POST — o PATCH estourava à vontade;
 *   · sessão 22h–02h no assistente morria em "Server Error";
 *   · dava pra publicar evento sem lote nenhum;
 *   · "Situação = Cancelado" era só rótulo (a catraca seguia abrindo) e dava
 *     pra voltar de cancelado pra ativo;
 *   · a data mudava com venda feita, sem avisar ninguém;
 *   · campo numérico apagado voltava "Dados inválidos" sem dizer qual;
 *   · o cupom editado não conferia datas nem lote de outro evento.
 *
 * Toda gravação é conferida LENDO O BANCO depois, não pelo 200 da rota.
 *
 * Fixture: eventos `zzqa-…` da organização do dono no banco de TESTE,
 * apagados no `afterAll`. Sem o servidor de teste (3101) no ar, PULA.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { anunciarPulo, BASE_DE_TESTE, seForaDoArPula, sondarServidor, type Sonda } from '../../../scripts/test-setup'
import { comSessao, entrar } from '../../../scripts/teste-sessao'
import { db, q, q1 } from '../../utils/db'

const MARCA = `zzqa-${randomUUID().slice(0, 8)}`
let sonda: Sonda = { noAr: false, porque: 'o beforeAll não chegou a rodar' }
let http: ReturnType<typeof comSessao>
let orgId = ''

async function chamar(metodo: string, rota: string, body?: unknown) {
  const r = await http(rota, { method: metodo, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: r.status, corpo: await r.json().catch(() => ({})) as any }
}

/** o corpo mínimo que o assistente manda, com um setor e um lote */
function evento(extra: Record<string, unknown> = {}, lote: Record<string, unknown> = {}) {
  return {
    orgId,
    nome: `${MARCA} evento ${randomUUID().slice(0, 4)}`,
    inicio: '2031-03-10T20:00:00.000Z',
    fim: '2031-03-11T04:00:00.000Z',
    local: { cidade: 'Ubatã', estado: 'BA' },
    setores: [{
      nome: 'Pista', capacidade: 100,
      lotes: [{ nome: '1º lote', faceCents: 5000, quantidade: 60, ...lote }],
    }],
    ...extra,
  }
}

async function criar(extra: Record<string, unknown> = {}, lote: Record<string, unknown> = {}) {
  const r = await chamar('POST', '/api/admin/evento', evento(extra, lote))
  expect(r.status, JSON.stringify(r.corpo)).toBe(200)
  return r.corpo as { id: string; slug: string; status: string; slugPedido: string | null }
}

const lotesDo = (eventoId: string) => q<any>(
  `SELECT l.id, l.price_cents, l.quantity, l.channels, l.sector_id
     FROM lots l JOIN sectors s ON s.id = l.sector_id WHERE s.event_id = $1 ORDER BY l.sort_order`, [eventoId])

const eventosComNome = async (nome: string) =>
  Number((await q1<any>(`SELECT count(*)::int AS n FROM events WHERE name = $1`, [nome]))!.n)

beforeAll(async () => {
  sonda = await sondarServidor('/api/auth/eu')
  anunciarPulo('server/api/admin/evento-cadastro.test.ts', sonda)
  if (!sonda.noAr) return
  http = comSessao(await entrar('master'))
  const eu = await (await http('/api/auth/eu')).json()
  orgId = eu?.usuario?.orgId ?? eu?.usuario?.org_id ?? eu?.orgId
    ?? (await q1<any>(`SELECT org_id FROM users WHERE email = 'dono@fazendapark.com.br'`))!.org_id
}, 60_000)

afterAll(async () => {
  if (sonda.noAr) {
    const ids = `SELECT id FROM events WHERE name LIKE '${MARCA}%'`
    await q(`DELETE FROM orders WHERE event_id IN (${ids})`)
    await q(`DELETE FROM events WHERE id IN (${ids})`)
  }
  await db().end()
})

/* ======================================================= 1. preço zero === */
describe('lote a R$ 0,00 só existe de propósito', () => {
  it('o assistente recusa face 0 sem "gratuito" — e não grava NADA', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const corpo = evento({}, { faceCents: 0 })
    const r = await chamar('POST', '/api/admin/evento', corpo)
    expect(r.status).toBe(422)
    expect(r.corpo.statusMessage).toMatch(/R\$ 0,00/)
    expect(r.corpo.statusMessage).toMatch(/Pista · 1º lote/)
    expect(await eventosComNome(corpo.nome)).toBe(0)
  })

  it('com "gratuito: true" o assistente grava o lote a zero', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const ev = await criar({}, { faceCents: 0, gratuito: true })
    expect(Number((await lotesDo(ev.id))[0].price_cents)).toBe(0)
  })

  it('o modal (POST e PATCH de lote) recusa face 0 sem a marca', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const ev = await criar()
    const [lote] = await lotesDo(ev.id)
    const rota = `/api/admin/evento/${ev.id}/ingressos`

    const novo = await chamar('POST', rota, { o: 'lote', setorId: lote.sector_id, nome: 'grátis?', faceCents: 0, quantidade: 5 })
    expect(novo.status).toBe(422)
    expect(novo.corpo.statusMessage).toMatch(/Ingresso gratuito/)

    const zerar = await chamar('PATCH', rota, { o: 'lote', id: lote.id, campos: { faceCents: 0 } })
    expect(zerar.status).toBe(422)
    expect(Number((await lotesDo(ev.id))[0].price_cents)).toBe(5000) // intacto

    const deProposito = await chamar('PATCH', rota, { o: 'lote', id: lote.id, campos: { faceCents: 0, gratuito: true } })
    expect(deProposito.status, JSON.stringify(deProposito.corpo)).toBe(200)
    expect(Number((await lotesDo(ev.id))[0].price_cents)).toBe(0)
  })
})

/* ================================================ 2. canais de venda ==== */
describe('lote criado pelo painel vende no site E no balcão', () => {
  it('assistente sem `canais` grava {online,bilheteria}', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const ev = await criar()
    expect([...(await lotesDo(ev.id))[0].channels].sort()).toEqual(['bilheteria', 'online'])
  })

  it('assistente respeita `canais` quando vem', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const ev = await criar({}, { canais: ['bilheteria'] })
    expect((await lotesDo(ev.id))[0].channels).toEqual(['bilheteria'])
  })

  it('modal sem `canais` grava {online,bilheteria}', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const ev = await criar()
    const [lote] = await lotesDo(ev.id)
    const r = await chamar('POST', `/api/admin/evento/${ev.id}/ingressos`,
      { o: 'lote', setorId: lote.sector_id, nome: '2º lote', faceCents: 7000, quantidade: 10 })
    expect(r.status, JSON.stringify(r.corpo)).toBe(200)
    const gravado = (await lotesDo(ev.id)).find((l) => l.id === r.corpo.id)
    expect([...gravado.channels].sort()).toEqual(['bilheteria', 'online'])
  })
})

/* ============================================ 4. capacidade no PATCH ==== */
describe('as contas de estoque valem também na edição', () => {
  it('setor 100 com 3 vendidos: lote pra 1000, capacidade pra 1, tipo de 5000 — tudo recusado', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const ev = await criar()
    const [lote] = await lotesDo(ev.id)
    const rota = `/api/admin/evento/${ev.id}/ingressos`
    await q(`UPDATE lots SET sold = 3 WHERE id = $1`, [lote.id])

    const loteGrande = await chamar('PATCH', rota, { o: 'lote', id: lote.id, campos: { quantidade: 1000 } })
    expect(loteGrande.status).toBe(422)
    expect(loteGrande.corpo.statusMessage).toMatch(/capacidade do setor/i)

    const capUm = await chamar('PATCH', rota, { o: 'setor', id: lote.sector_id, campos: { capacidade: 1 } })
    expect(capUm.status).toBe(409)
    expect(capUm.corpo.statusMessage).toMatch(/Já saíram 3/)

    // abaixo da soma dos lotes (60), acima do vendido
    const capCinquenta = await chamar('PATCH', rota, { o: 'setor', id: lote.sector_id, campos: { capacidade: 50 } })
    expect(capCinquenta.status).toBe(422)
    expect(capCinquenta.corpo.statusMessage).toMatch(/somam 60/)

    const tipo = await chamar('POST', rota, { o: 'tipo', loteId: lote.id, nome: 'Inteira', quantidade: 10 })
    expect(tipo.status, JSON.stringify(tipo.corpo)).toBe(200)
    const tipoGrande = await chamar('PATCH', rota, { o: 'tipo', id: tipo.corpo.id, campos: { quantidade: 5000 } })
    expect(tipoGrande.status).toBe(422)
    expect(tipoGrande.corpo.statusMessage).toMatch(/mais que o lote \(60\)/)

    // nada disso mexeu no banco
    const depois = (await lotesDo(ev.id))[0]
    expect(Number(depois.quantity)).toBe(60)
    const setor = await q1<any>(`SELECT capacity FROM sectors WHERE id = $1`, [lote.sector_id])
    expect(Number(setor!.capacity)).toBe(100)
    const t = await q1<any>(`SELECT quantity FROM ticket_types WHERE id = $1`, [tipo.corpo.id])
    expect(Number(t!.quantity)).toBe(10)

    // e o que cabe continua passando
    const cabe = await chamar('PATCH', rota, { o: 'lote', id: lote.id, campos: { quantidade: 100 } })
    expect(cabe.status, JSON.stringify(cabe.corpo)).toBe(200)
  })

  it('tipos compartilham o lote: o que acompanhava o lote acompanha a mudança; teto próprio fica', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const ev = await criar()
    const [lote] = await lotesDo(ev.id) // 60
    const rota = `/api/admin/evento/${ev.id}/ingressos`
    const junto = await chamar('POST', rota, { o: 'tipo', loteId: lote.id, nome: 'Inteira', quantidade: 60 })
    const proprio = await chamar('POST', rota, { o: 'tipo', loteId: lote.id, nome: 'Criança', quantidade: 20 })
    expect([junto.status, proprio.status]).toEqual([200, 200])

    // lote sobe pra 80: a Inteira (que era o lote inteiro) sobe junto; a Criança fica em 20
    expect((await chamar('PATCH', rota, { o: 'lote', id: lote.id, campos: { quantidade: 80 } })).status).toBe(200)
    const qtd = async (id: string) => Number((await q1<any>(`SELECT quantity FROM ticket_types WHERE id = $1`, [id]))!.quantity)
    expect(await qtd(junto.corpo.id)).toBe(80)
    expect(await qtd(proprio.corpo.id)).toBe(20)

    // lote desce pra 50: tipo "maior" que o lote não trava nada (o lote segura o total)
    expect((await chamar('PATCH', rota, { o: 'lote', id: lote.id, campos: { quantidade: 50 } })).status).toBe(200)
    expect(await qtd(junto.corpo.id)).toBe(50)
  })

  it('o assistente manda a data de expiração do lote e ela é gravada', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const expira = '2031-03-09T21:00:00.000Z'
    const ev = await criar({}, { expiraEm: expira })
    const [lote] = await lotesDo(ev.id)
    const gravado = await q1<any>(`SELECT expires_at FROM lots WHERE id = $1`, [lote.id])
    expect(new Date(gravado!.expires_at).toISOString()).toBe(expira)
  })

  it('evento novo nasce SEM taxa de serviço (0%): o site cobra o valor digitado', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const ev = await criar()
    const gravado = await q1<any>(`SELECT fee_bps FROM events WHERE id = $1`, [ev.id])
    expect(Number(gravado!.fee_bps)).toBe(0)
  })

  it('lote que fecha antes de abrir é recusado no PATCH (comparando com a data gravada)', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const ev = await criar()
    const [lote] = await lotesDo(ev.id)
    const rota = `/api/admin/evento/${ev.id}/ingressos`
    const ok = await chamar('PATCH', rota, { o: 'lote', id: lote.id, campos: { expiraEm: '2031-03-01T00:00:00.000Z' } })
    expect(ok.status, JSON.stringify(ok.corpo)).toBe(200)
    const invertido = await chamar('PATCH', rota, { o: 'lote', id: lote.id, campos: { abreEm: '2031-03-05T00:00:00.000Z' } })
    expect(invertido.status).toBe(422)
    expect(invertido.corpo.statusMessage).toMatch(/fechar antes de abrir/)
  })
})

/* ================================================= 5. meia-noite ======== */
describe('sessão que passa da meia-noite', () => {
  it('fim antes do início na mesma data vira 422 legível, não 500', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await chamar('POST', '/api/admin/evento', evento({
      sessoes: [{ titulo: 'Sábado', inicio: '2031-03-10T22:00:00-03:00', fim: '2031-03-10T02:00:00-03:00' }],
    }))
    expect(r.status).toBe(422)
    expect(r.corpo.statusMessage).toMatch(/Sábado/)
    expect(r.corpo.statusMessage).toMatch(/dia seguinte/)
  })

  it('com o fim no dia seguinte (o que o assistente manda agora) grava', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const ev = await criar({
      sessoes: [{ titulo: 'Sábado', inicio: '2031-03-10T22:00:00-03:00', fim: '2031-03-11T02:00:00-03:00' }],
    })
    const s = await q1<any>(`SELECT ends_at - starts_at AS d FROM event_sessions WHERE event_id = $1`, [ev.id])
    expect(s!.d.hours).toBe(4)
  })
})

/* ============================================ 6. publicar sem lote ====== */
describe('publicar exige ingresso', () => {
  it('assistente com publicar e sem setor: 422 e nada gravado', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const corpo = evento({ setores: [], publicar: true })
    const r = await chamar('POST', '/api/admin/evento', corpo)
    expect(r.status).toBe(422)
    expect(r.corpo.statusMessage).toMatch(/Cadastre pelo menos um ingresso antes de publicar/)
    expect(await eventosComNome(corpo.nome)).toBe(0)
  })

  it('assistente com publicar e lote: nasce ativo, numa transação só', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const ev = await criar({ publicar: true })
    expect((await q1<any>(`SELECT status FROM events WHERE id = $1`, [ev.id]))!.status).toBe('ativo')
  })

  it('Configurações não publica evento sem lote visível', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const ev = await criar({ setores: [] })
    const rota = `/api/admin/evento/${ev.id}/configuracoes`
    const r = await chamar('PATCH', rota, { status: 'ativo' })
    expect(r.status).toBe(422)
    expect(r.corpo.statusMessage).toMatch(/Cadastre pelo menos um ingresso antes de publicar/)
    expect((await q1<any>(`SELECT status FROM events WHERE id = $1`, [ev.id]))!.status).toBe('rascunho')
  })
})

/* ================================== 3. cancelado/adiado não é rótulo ==== */
describe('Situação: cancelar e adiar só pelos botões próprios', () => {
  it('PATCH recusa status cancelado e adiado, com a frase que manda pro botão', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const ev = await criar()
    const rota = `/api/admin/evento/${ev.id}/configuracoes`
    const cancelar = await chamar('PATCH', rota, { status: 'cancelado' })
    expect(cancelar.status).toBe(422)
    expect(cancelar.corpo.statusMessage).toMatch(/Cancelar evento e devolver/)
    const adiar = await chamar('PATCH', rota, { status: 'adiado' })
    expect(adiar.status).toBe(422)
    expect((await q1<any>(`SELECT status FROM events WHERE id = $1`, [ev.id]))!.status).toBe('rascunho')
  })

  it('evento cancelado não volta pra ativo', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const ev = await criar()
    await q(`UPDATE events SET status = 'cancelado' WHERE id = $1`, [ev.id])
    const r = await chamar('PATCH', `/api/admin/evento/${ev.id}/configuracoes`, { status: 'ativo' })
    expect(r.status).toBe(409)
    expect(r.corpo.statusMessage).toMatch(/não volta a vender/)
    expect((await q1<any>(`SELECT status FROM events WHERE id = $1`, [ev.id]))!.status).toBe('cancelado')
  })
})

/* ================================ 9. data com venda feita =============== */
describe('com venda feita a data só muda pelo adiamento', () => {
  it('pedido pago: mudar comecaEm dá 409 com a frase; sem pedido, passa', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const semVenda = await criar()
    const livre = await chamar('PATCH', `/api/admin/evento/${semVenda.id}/configuracoes`,
      { comecaEm: '2031-03-10T21:00:00.000Z' })
    expect(livre.status, JSON.stringify(livre.corpo)).toBe(200)

    const comVenda = await criar()
    await q(`INSERT INTO orders (org_id, event_id, code, status, channel, face_cents, fee_cents,
                                 platform_cents, discount_cents, total_cents, paid_at)
             VALUES ($1,$2,$3,'pago','online',5000,500,500,0,5500, now())`,
      [orgId, comVenda.id, `ZZQA-${randomUUID().slice(0, 8)}`])
    const rota = `/api/admin/evento/${comVenda.id}/configuracoes`
    const r = await chamar('PATCH', rota, { comecaEm: '2031-03-10T21:00:00.000Z' })
    expect(r.status).toBe(409)
    expect(r.corpo.statusMessage)
      .toBe('Com ingressos vendidos, mude a data por Adiar evento — os compradores são avisados.')
    const ev = await q1<any>(`SELECT starts_at FROM events WHERE id = $1`, [comVenda.id])
    expect(new Date(ev!.starts_at).toISOString()).toBe('2031-03-10T20:00:00.000Z')

    // a mesma data (outro formato) não é mudança
    const igual = await chamar('PATCH', rota, { comecaEm: '2031-03-10T17:00:00-03:00', nome: `${MARCA} renomeado` })
    expect(igual.status, JSON.stringify(igual.corpo)).toBe(200)
  })
})

/* ========================= 10. campo vazio e o nome do campo no erro ==== */
describe('erro de validação diz QUAL campo', () => {
  it('"" num número responde com o rótulo do campo; null limpa', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const ev = await criar()
    const rota = `/api/admin/evento/${ev.id}/configuracoes`
    const r = await chamar('PATCH', rota, { maxPorCliente: '' })
    expect(r.status).toBe(400)
    expect(r.corpo.statusMessage).toMatch(/Máximo por cliente/)
    expect(r.corpo.statusMessage).not.toMatch(/Dados inválidos/)

    await chamar('PATCH', rota, { maxPorCliente: 4 })
    const limpar = await chamar('PATCH', rota, { maxPorCliente: null })
    expect(limpar.status, JSON.stringify(limpar.corpo)).toBe(200)
    expect((await q1<any>(`SELECT max_per_customer FROM events WHERE id = $1`, [ev.id]))!.max_per_customer).toBeNull()
  })

  it('slug curto volta em português, dizendo o campo', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await chamar('POST', '/api/admin/evento', evento({ slug: 'ab' }))
    expect(r.status).toBe(400)
    expect(r.corpo.statusMessage).toMatch(/Endereço da página/)
    expect(r.corpo.statusMessage).toMatch(/pelo menos 3/)
  })
})

/* ========================================= 11. slug e cupom ============= */
describe('endereço renomeado e cupom editado', () => {
  it('slug repetido volta com o endereço REAL e o pedido', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const slug = `${MARCA}-slug`
    const a = await criar({ slug })
    const b = await criar({ slug })
    expect(a.slug).toBe(slug)
    expect(b.slug).not.toBe(slug)
    expect(b.slugPedido).toBe(slug)
  })

  it('PATCH de cupom confere datas invertidas e lote de outro evento', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const ev = await criar()
    const outro = await criar()
    const [loteDeFora] = await lotesDo(outro.id)
    const rota = `/api/admin/evento/${ev.id}/cupons`
    const c = await chamar('POST', rota, {
      codigo: `ZQ${randomUUID().slice(0, 6)}`, tipo: 'percentual', valor: 1000,
      comecaEm: '2031-01-10T00:00:00.000Z', terminaEm: '2031-02-10T00:00:00.000Z',
    })
    expect(c.status, JSON.stringify(c.corpo)).toBe(200)

    const invertido = await chamar('PATCH', rota, { id: c.corpo.id, campos: { terminaEm: '2031-01-01T00:00:00.000Z' } })
    expect(invertido.status).toBe(422)
    expect(invertido.corpo.statusMessage).toMatch(/terminar antes de começar/)

    const alheio = await chamar('PATCH', rota, { id: c.corpo.id, campos: { loteIds: [loteDeFora.id] } })
    expect(alheio.status).toBe(422)

    const cupom = await q1<any>(`SELECT ends_at, lot_ids FROM promo_codes WHERE id = $1`, [c.corpo.id])
    expect(new Date(cupom!.ends_at).toISOString()).toBe('2031-02-10T00:00:00.000Z')
    expect(cupom!.lot_ids ?? []).toEqual([])
  })
})

// BASE_DE_TESTE importado só pra falha de sonda dizer onde procurou
void BASE_DE_TESTE
