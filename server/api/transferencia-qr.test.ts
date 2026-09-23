/**
 * Transferência e QR — os dois defeitos P1 de 22/09.
 *
 *  1. **Os dois entravam.** O aceite só trocava o titular. O QR é
 *     HMAC(evento:código) e o código não mudava: depois do aceite o QR antigo
 *     (print, e-mail, tela do pedido de quem mandou) seguia dando "Liberado"
 *     na /api/checkin. Agora o aceite dá código novo ao ingresso.
 *  2. **Quem recebia não tinha QR.** A página da transferência mostrava só o
 *     código legível. Agora, depois do aceite, o próprio link da transferência
 *     é a credencial do QR — sem passar pelo pedido de quem mandou.
 *
 * E o P2 que anda junto: `/api/pedido/:code` devolvia QR de ingresso
 * cancelado/transferido. Agora manda `qr: null` e o status certo.
 *
 * Fixture própria (ZZQA), com usuário master próprio pra portaria poder
 * conferir o evento dele. Apagada no fim.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  anunciarPulo, BASE_DE_TESTE, seForaDoArPula, sondarServidor, type Sonda,
} from '../../scripts/test-setup'

const BASE = BASE_DE_TESTE

const ORG = '0000f0a2-0000-4000-8000-000000000001'
const USUARIO = '0000f0a2-0000-4000-8000-000000000002'
const EVENTO = '0000f0a2-0000-4000-8000-000000000003'
const SETOR = '0000f0a2-0000-4000-8000-000000000004'
const LOTE = '0000f0a2-0000-4000-8000-000000000005'
const PEDIDO = '0000f0a2-0000-4000-8000-000000000006'
const EMAIL = 'dono.zzqa.qr@teste.invalido'

let sonda: Sonda = { noAr: false, porque: 'o beforeAll não chegou a rodar' }
let cookie = ''

async function sql(texto: string, par: any[] = []) {
  const { q } = await import('../utils/db')
  return q<any>(texto, par)
}

const comSessao = (rota: string, init: RequestInit = {}) =>
  fetch(`${BASE}${rota}`, {
    ...init,
    headers: { 'content-type': 'application/json', cookie, origin: BASE, ...(init.headers ?? {}) },
  })
const aberto = (rota: string, init: RequestInit = {}) =>
  fetch(`${BASE}${rota}`, { ...init, headers: { 'content-type': 'application/json' } })

/** ingresso pago dentro do pedido ZZQA, titular conhecido */
async function novoIngresso(sufixo: string) {
  const code = `ZZQA-${sufixo}-QR`
  const [t] = await sql(
    `INSERT INTO tickets (org_id, event_id, sector_id, lot_id, order_id, code, qr_secret, status,
                          holder_name, holder_email)
     VALUES ($1,$2,$3,$4,$5,$6,'teste','valido','Quem Comprou','comprou@teste.invalido')
     RETURNING id`, [ORG, EVENTO, SETOR, LOTE, PEDIDO, code])
  return { id: t.id as string, code }
}

async function enviarEAceitar(ingressoId: string, para: string) {
  const env = await comSessao(`/api/admin/evento/${EVENTO}/transferencias`, {
    method: 'POST',
    body: JSON.stringify({ ingressoId, paraNome: 'Quem Recebeu', paraEmail: para }),
  }).then((r) => r.json())
  const token = String(env.transferencia.link).split('/').pop()!
  const aceite = await aberto(`/api/transferencia/${token}`, { method: 'POST', body: '{}' })
  return { token, transferenciaId: env.transferencia.id as string, aceite }
}

async function checkin(qr: string) {
  return comSessao('/api/checkin', {
    method: 'POST', body: JSON.stringify({ eventId: EVENTO, qr, apenasConsultar: true }),
  }).then((r) => r.json())
}

async function limpar() {
  await sql(`DELETE FROM checkins WHERE event_id = $1`, [EVENTO])
  await sql(`DELETE FROM tickets WHERE event_id = $1`, [EVENTO])
  await sql(`DELETE FROM orders WHERE event_id = $1`, [EVENTO])
  await sql(`DELETE FROM organizations WHERE id = $1`, [ORG])
}

beforeAll(async () => {
  sonda = await sondarServidor()
  anunciarPulo('server/api/transferencia-qr.test.ts', sonda)
  if (!sonda.noAr) return
  await limpar()

  await sql(`INSERT INTO organizations (id, name, slug) VALUES ($1,'ZZQA QR','zzqa-qr')`, [ORG])
  await sql(
    `INSERT INTO events (id, org_id, name, slug, starts_at, ends_at, status, allow_transfer)
     VALUES ($1,$2,'ZZQA EVENTO QR','zzqa-evento-qr',
             now() - interval '1 hour', now() + interval '1 day', 'ativo', true)`, [EVENTO, ORG])
  await sql(`INSERT INTO sectors (id, event_id, name) VALUES ($1,$2,'ZZQA SETOR')`, [SETOR, EVENTO])
  await sql(`INSERT INTO lots (id, sector_id, name, price_cents, quantity)
             VALUES ($1,$2,'ZZQA LOTE', 5000, 50)`, [LOTE, SETOR])
  await sql(
    `INSERT INTO orders (id, org_id, event_id, code, status, channel, face_cents, total_cents,
                         paid_at)
     VALUES ($1,$2,$3,'ZZQA-PED-QR','pago','online',10000,10000, now())`, [PEDIDO, ORG, EVENTO])
  await sql(
    `INSERT INTO users (id, org_id, name, email, password_hash, role)
     SELECT $1, $2, 'Dono ZZQA QR', $3, password_hash, 'master'
       FROM users WHERE email = 'dono@fazendapark.com.br'`, [USUARIO, ORG, EMAIL])

  const r = await fetch(`${BASE}/api/auth/entrar`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, senha: 'diamond123' }),
  })
  cookie = (r.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(';')[0]).find((c) => c.startsWith('dt_sessao=')) ?? ''
}, 60_000)

afterAll(async () => {
  if (!sonda.noAr) return
  await limpar()
})

describe('transferência aceita invalida o QR de quem mandou', () => {
  it('a sessão do teste existe (senão nada abaixo prova nada)', (ctx) => {
    seForaDoArPula(ctx, sonda)
    expect(cookie, 'login falhou — o teste ficaria verde à toa').toBeTruthy()
  })

  it('o QR antigo deixa de liberar; o do destinatário libera', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const { montarQr } = await import('../utils/ingresso')
    const ing = await novoIngresso('ACEI')
    const qrAntigo = montarQr(ing.code, EVENTO)

    // antes: o QR do comprador entra
    expect((await checkin(qrAntigo)).resultado).toBe('ok')

    const { token, aceite } = await enviarEAceitar(ing.id, 'recebeu.acei@teste.invalido')
    expect(aceite.status).toBe(200)
    const corpo = await aceite.json()

    const [t] = await sql(`SELECT code, holder_email FROM tickets WHERE id = $1`, [ing.id])
    expect(t.code, 'o aceite não trocou o código — os dois entram').not.toBe(ing.code)
    expect(corpo.ingresso).toBe(t.code)
    expect(t.holder_email).toBe('recebeu.acei@teste.invalido')

    // o QR de quem mandou morreu
    const velho = await checkin(qrAntigo)
    expect(velho.resultado, `QR antigo ainda passa: ${JSON.stringify(velho)}`).not.toBe('ok')
    // o de quem recebeu passa
    expect((await checkin(montarQr(t.code, EVENTO))).resultado).toBe('ok')

    // a trilha guarda o código antigo (é por ele que a portaria vai perguntar)
    const [a] = await sql(
      `SELECT after FROM audit_log WHERE entity = 'ingresso' AND entity_id = $1
         AND action = 'transferencia_aceita' ORDER BY id DESC LIMIT 1`, [ing.id])
    expect(a.after.codigoAnterior).toBe(ing.code)

    // ---------------------- o destinatário tem QR na página da transferência
    const vista = await aberto(`/api/transferencia/${token}`).then((r) => r.json())
    expect(vista.status).toBe('concluido')
    expect(vista.ingresso.qrDisponivel).toBe(true)
    expect(vista.ingresso.codigo).toBe(t.code)
    const png = await fetch(
      `${BASE}/api/ingresso/${vista.ingresso.id}/qr.png?transferencia=${encodeURIComponent(token)}`)
    expect(png.status).toBe(200)
    expect(png.headers.get('content-type')).toBe('image/png')
    // token de outra transferência (ou inventado) não abre o QR
    const forjado = await fetch(
      `${BASE}/api/ingresso/${vista.ingresso.id}/qr.png?transferencia=tr_inventado`)
    expect(forjado.status).toBe(404)

    // ---------------------- o pedido de quem mandou não mostra mais o QR
    const ped = await aberto('/api/pedido/ZZQA-PED-QR').then((r) => r.json())
    const noPedido = ped.ingressos.find((x: any) => x.id === ing.id)
    expect(noPedido.status).toBe('transferido')
    expect(noPedido.qr, 'o pedido do remetente ainda entrega o QR novo').toBeNull()
    expect(noPedido.codigo, 'o código legível também entra na portaria').toBeNull()
    const pngDoRemetente = await fetch(
      `${BASE}/api/ingresso/${ing.id}/qr.png?pedido=ZZQA-PED-QR`)
    expect(pngDoRemetente.status).toBe(410)

    // ---------------------- e as TELAS (SSR) contam a mesma história
    const telaDoDestinatario = await fetch(`${BASE}/transferencia/${token}`).then((r) => r.text())
    expect(telaDoDestinatario, 'a página da transferência não mostra o QR de quem recebeu')
      .toContain(`qr.png?transferencia=${encodeURIComponent(token)}`)
    const telaDoRemetente = await fetch(`${BASE}/ingressos/ZZQA-PED-QR`).then((r) => r.text())
    expect(telaDoRemetente).toContain('Ingresso transferido para outra pessoa')
    expect(telaDoRemetente, 'a tela do pedido ainda pede o QR do transferido')
      .not.toContain(`/api/ingresso/${ing.id}/qr.png`)
  }, 40_000)

  it('desfazer a transferência aceita troca o código de novo e devolve o QR ao pedido', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const { montarQr } = await import('../utils/ingresso')
    const ing = await novoIngresso('DESF')
    const { token, transferenciaId } = await enviarEAceitar(ing.id, 'recebeu.desf@teste.invalido')
    const [depoisDoAceite] = await sql(`SELECT code FROM tickets WHERE id = $1`, [ing.id])

    const r = await comSessao(`/api/admin/evento/${EVENTO}/transferencias`, {
      method: 'PATCH', body: JSON.stringify({ transferenciaId, acao: 'cancelar' }),
    })
    expect(r.status).toBe(200)

    const [t] = await sql(`SELECT code, holder_email FROM tickets WHERE id = $1`, [ing.id])
    expect(t.holder_email).toBe('comprou@teste.invalido')
    expect(t.code, 'o destinatário seguiria entrando com o QR que viu').not.toBe(depoisDoAceite.code)
    expect((await checkin(montarQr(depoisDoAceite.code, EVENTO))).resultado).not.toBe('ok')

    // a página da transferência não mostra mais QR nenhum
    const vista = await aberto(`/api/transferencia/${token}`).then((x) => x.json())
    expect(vista.ingresso.qrDisponivel).toBe(false)
    expect(vista.ingresso.id).toBeNull()

    // e o pedido de quem comprou volta a ter o QR, com o código atual
    const ped = await aberto('/api/pedido/ZZQA-PED-QR').then((x) => x.json())
    const noPedido = ped.ingressos.find((x: any) => x.id === ing.id)
    expect(noPedido.status).toBe('valido')
    expect(noPedido.qr).toBe(montarQr(t.code, EVENTO))
  }, 40_000)
})

describe('/api/pedido/:code não entrega QR de ingresso que não entra', () => {
  it('cancelado sai com qr null e o PNG responde 410', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const ing = await novoIngresso('CANC')
    await sql(`UPDATE tickets SET status = 'cancelado', canceled_at = now() WHERE id = $1`, [ing.id])

    const ped = await aberto('/api/pedido/ZZQA-PED-QR').then((r) => r.json())
    const t = ped.ingressos.find((x: any) => x.id === ing.id)
    expect(t.status).toBe('cancelado')
    expect(t.qr).toBeNull()
    expect((await fetch(`${BASE}/api/ingresso/${ing.id}/qr.png?pedido=ZZQA-PED-QR`)).status)
      .toBe(410)
  }, 20_000)

  it('id que não é UUID dá 404, não 500', async (ctx) => {
    seForaDoArPula(ctx, sonda)
    const r = await fetch(`${BASE}/api/ingresso/nao-e-uuid/qr.png?pedido=ZZQA-PED-QR`)
    expect(r.status).toBe(404)
  }, 20_000)
})
