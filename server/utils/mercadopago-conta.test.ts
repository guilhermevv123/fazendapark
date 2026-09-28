/**
 * Pix pelo Mercado Pago (28/09) — a parte pura: assinatura do aviso, a TRADUÇÃO do estado do
 * pagamento em fatos, o corpo do Pix e a régua de "este Pix sai pelo MP?". Sem rede e sem banco.
 *
 * O caso que mais importa é o da sequência (`fatosDoPagamento`): o MP responde o estado de AGORA.
 * Aplicar só o último fato ("aprovado com estorno parcial") levaria um pedido que esperava
 * pagamento direto pra `estornado_parcial` sem ingresso emitido. Todo estado que pressupõe
 * pagamento começa pelo fato "pago".
 */
import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  assinaturaConfere, baseDaApi, corpoDoPix, dataDoMP, devolvidoNoMp, fatosDoPagamento, pixPeloMercadoPago,
  tarifaELiquido, urlDoAviso,
} from './mercadopago-conta'

const SEGREDO = 'segredo-do-painel-do-mp-0123456789'
const assinar = (manifesto: string, segredo = SEGREDO) =>
  createHmac('sha256', segredo).update(manifesto).digest('hex')

describe('assinatura do aviso (x-signature)', () => {
  it('confere com o manifesto exato da doc: id;request-id;ts', () => {
    const v1 = assinar('id:123456;request-id:req-1;ts:1742505638683;')
    expect(assinaturaConfere({ assinatura: `ts=1742505638683,v1=${v1}`, requestId: 'req-1',
      dataId: '123456', segredo: SEGREDO })).toBe(true)
  })

  it('segredo errado, v1 adulterado ou ts trocado: não confere', () => {
    const v1 = assinar('id:123456;request-id:req-1;ts:1;')
    const base = { requestId: 'req-1', dataId: '123456' }
    expect(assinaturaConfere({ ...base, assinatura: `ts=1,v1=${v1}`, segredo: 'outro-segredo-qualquer' })).toBe(false)
    const adulterado = v1.slice(0, -1) + (v1.endsWith('0') ? '1' : '0')
    expect(assinaturaConfere({ ...base, assinatura: `ts=1,v1=${v1}`, segredo: SEGREDO })).toBe(true)
    expect(assinaturaConfere({ ...base, assinatura: `ts=1,v1=${adulterado}`, segredo: SEGREDO })).toBe(false)
    expect(assinaturaConfere({ ...base, assinatura: `ts=2,v1=${v1}`, segredo: SEGREDO })).toBe(false)
  })

  it('data.id com maiúscula vai em minúscula; parte que não veio sai do manifesto', () => {
    const v1 = assinar('id:ord01abc;ts:9;')
    expect(assinaturaConfere({ assinatura: `ts=9,v1=${v1}`, requestId: null, dataId: 'ORD01ABC', segredo: SEGREDO })).toBe(true)
  })

  it('sem ts ou sem v1, ou sem segredo: nunca confere', () => {
    expect(assinaturaConfere({ assinatura: 'v1=abc', dataId: '1', requestId: 'r', segredo: SEGREDO })).toBe(false)
    expect(assinaturaConfere({ assinatura: 'ts=1', dataId: '1', requestId: 'r', segredo: SEGREDO })).toBe(false)
    expect(assinaturaConfere({ assinatura: null, dataId: '1', requestId: 'r', segredo: SEGREDO })).toBe(false)
    const v1 = assinar('id:1;request-id:r;ts:1;', '')
    expect(assinaturaConfere({ assinatura: `ts=1,v1=${v1}`, dataId: '1', requestId: 'r', segredo: '' })).toBe(false)
  })
})

describe('fatosDoPagamento — o estado atual vira a sequência de fatos', () => {
  const pag = (extra: Record<string, any>) => ({
    id: 555, status: 'approved', status_detail: 'accredited', transaction_amount: 30,
    transaction_amount_refunded: 0, external_reference: 'pedido-x', payment_type_id: 'bank_transfer',
    transaction_details: { net_received_amount: 29.7 }, ...extra,
  })
  const nomes = (f: ReturnType<typeof fatosDoPagamento>) => f.map((x) => `${x.chave}=${x.nomeEvento}`)

  it('esperando o Pix: nenhum fato', () => {
    for (const status of ['pending', 'in_process', 'authorized']) {
      expect(fatosDoPagamento(pag({ status }), 'aguardando_pagamento'), status).toEqual([])
    }
  })

  it('aprovado: um fato "pago", no formato que a máquina do Asaas lê', () => {
    const [f, ...resto] = fatosDoPagamento(pag({}), 'aguardando_pagamento')
    expect(resto).toEqual([])
    expect(f.chave).toBe('mp:555:pago')
    expect(f.nomeEvento).toBe('PAYMENT_RECEIVED')
    expect(f.pagamento).toMatchObject({ id: '555', status: 'RECEIVED', value: 30, billingType: 'PIX',
      externalReference: 'pedido-x', gateway: 'mercadopago' })
  })

  it('aprovado com estorno parcial: PRIMEIRO o pago, depois o estorno — e o acumulado na chave', () => {
    const f = fatosDoPagamento(pag({ transaction_amount_refunded: 10 }), 'aguardando_pagamento')
    expect(nomes(f)).toEqual(['mp:555:pago=PAYMENT_RECEIVED', 'mp:555:estorno-1000=PAYMENT_PARTIALLY_REFUNDED'])
    expect(f[1].pagamento.refundedValue).toBe(10)
    // outro estorno (acumulado maior) é outro fato; o mesmo, repetido, é a mesma chave
    expect(fatosDoPagamento(pag({ transaction_amount_refunded: 15 }), 'pago')[1].chave).toBe('mp:555:estorno-1500')
    expect(fatosDoPagamento(pag({ transaction_amount_refunded: 10 }), 'pago')[1].chave).toBe('mp:555:estorno-1000')
  })

  it('devolvido por inteiro (aprovado com tudo devolvido, ou refunded): pago + estorno total', () => {
    expect(nomes(fatosDoPagamento(pag({ transaction_amount_refunded: 30 }), 'pago')))
      .toEqual(['mp:555:pago=PAYMENT_RECEIVED', 'mp:555:estorno-total=PAYMENT_REFUNDED'])
    const r = fatosDoPagamento(pag({ status: 'refunded', status_detail: 'refunded', transaction_amount_refunded: 30 }), 'pago')
    expect(nomes(r)).toEqual(['mp:555:pago=PAYMENT_RECEIVED', 'mp:555:estorno-total=PAYMENT_REFUNDED'])
    expect(r[1].pagamento.refundedValue).toBe(30)
  })

  it('cancelado (vencido/por nós) e recusado: um fato "cancelado", sem pago antes', () => {
    for (const status of ['cancelled', 'rejected']) {
      expect(nomes(fatosDoPagamento(pag({ status }), 'aguardando_pagamento')), status)
        .toEqual(['mp:555:cancelado=PAYMENT_DELETED'])
    }
  })

  it('chargeback e Pix contestado (MED): pago + desfaz', () => {
    expect(nomes(fatosDoPagamento(pag({ status: 'charged_back' }), 'pago')))
      .toEqual(['mp:555:pago=PAYMENT_RECEIVED', 'mp:555:chargeback=PAYMENT_CHARGEBACK_REQUESTED'])
    expect(nomes(fatosDoPagamento(pag({ status: 'in_mediation' }), 'pago')))
      .toEqual(['mp:555:pago=PAYMENT_RECEIVED', 'mp:555:disputa-aberta=PAYMENT_CHARGEBACK_DISPUTE'])
  })

  it('aprovado DEPOIS da disputa: a ordem do Asaas pra devolver o pedido à conta', () => {
    for (const s of ['chargeback', 'disputa']) {
      expect(nomes(fatosDoPagamento(pag({}), s)), s).toEqual([
        'mp:555:reversao=PAYMENT_AWAITING_CHARGEBACK_REVERSAL',
        'mp:555:pago-apos-disputa=PAYMENT_RECEIVED',
      ])
    }
  })

  it('pedido que NUNCA foi pago aqui e o MP já diz devolvido/contestado: sem o "pago" na frente', () => {
    // o "pago" antes emitiria ingresso (com e-mail pro comprador) pra desfazer no mesmo segundo
    for (const s of ['aguardando_pagamento', 'expirado']) {
      expect(nomes(fatosDoPagamento(pag({ status: 'refunded', transaction_amount_refunded: 30 }), s)), s)
        .toEqual(['mp:555:estorno-total=PAYMENT_REFUNDED'])
      expect(nomes(fatosDoPagamento(pag({ status: 'charged_back' }), s)), s)
        .toEqual(['mp:555:chargeback=PAYMENT_CHARGEBACK_REQUESTED'])
      expect(nomes(fatosDoPagamento(pag({ status: 'in_mediation' }), s)), s)
        .toEqual(['mp:555:disputa-aberta=PAYMENT_CHARGEBACK_DISPUTE'])
    }
    // aprovado com estorno parcial é dinheiro que FICOU: emite mesmo nunca tendo sido pago aqui
    expect(nomes(fatosDoPagamento(pag({ transaction_amount_refunded: 10 }), 'expirado')))
      .toEqual(['mp:555:pago=PAYMENT_RECEIVED', 'mp:555:estorno-1000=PAYMENT_PARTIALLY_REFUNDED'])
  })

  it('disputa ganha num pedido que já tinha devolução parcial: o devolvido vai junto', () => {
    const f = fatosDoPagamento(pag({ transaction_amount_refunded: 10 }), 'chargeback')
    expect(nomes(f)).toEqual([
      'mp:555:reversao=PAYMENT_AWAITING_CHARGEBACK_REVERSAL', 'mp:555:pago-apos-disputa=PAYMENT_RECEIVED',
    ])
    expect(f[1].pagamento.refundedValue, 'sem ele o pedido voltava como pago cheio').toBe(10)
    expect('refundedValue' in fatosDoPagamento(pag({}), 'chargeback')[1].pagamento).toBe(false)
  })

  it('status que o MP inventar depois, ou pagamento sem id: nenhum fato', () => {
    expect(fatosDoPagamento(pag({ status: 'algo_novo' }), 'pago')).toEqual([])
    expect(fatosDoPagamento({ status: 'approved' }, 'pago')).toEqual([])
  })
})

describe('quanto o MP devolveu (a pergunta "já mandei?" da fila)', () => {
  it('conta o estorno em processamento; não conta o recusado nem o cancelado', () => {
    expect(devolvidoNoMp({ transaction_amount_refunded: 0, refunds: [{ amount: 30, status: 'in_process' }] })).toBe(3000)
    expect(devolvidoNoMp({ transaction_amount_refunded: 0, refunds: [
      { amount: 30, status: 'rejected' }, { amount: 5, status: 'cancelled' }] })).toBe(0)
    expect(devolvidoNoMp({ transaction_amount_refunded: 10, refunds: [
      { amount: 10, status: 'approved' }, { amount: 5, status: 'in_process' }] })).toBe(1500)
    // o acumulado do MP vale quando a lista não veio
    expect(devolvidoNoMp({ transaction_amount_refunded: 12.5 })).toBe(1250)
    expect(devolvidoNoMp(null)).toBe(0)
  })
})

describe('corpo do Pix', () => {
  const agora = new Date('2026-09-28T15:00:00.000Z')
  const base = {
    valorCents: 3300, descricao: 'Conquista Park — pedido PED-1', pedidoId: '0000e033-0000-4000-8000-000000000001',
    expiraEm: new Date(agora.getTime() + 60 * 60_000), urlDeAviso: 'https://site/api/webhooks/mercadopago/x?source_news=webhooks',
    comprador: { email: 'ana@exemplo.com', nome: 'Ana Maria  Souza', cpf: '529.982.247-25' },
  }

  it('valor em reais, referência = nosso pedido, pagador com CPF só números', () => {
    const c = corpoDoPix(base, agora)
    expect(c).toMatchObject({
      transaction_amount: 33, payment_method_id: 'pix', external_reference: base.pedidoId,
      notification_url: base.urlDeAviso,
      payer: { email: 'ana@exemplo.com', first_name: 'Ana', last_name: 'Maria Souza',
        identification: { type: 'CPF', number: '52998224725' } },
    })
  })

  it('validade: a da reserva, com o piso de 30 min do MP e o teto de 30 dias', () => {
    expect(corpoDoPix(base, agora).date_of_expiration).toBe('2026-09-28T13:00:00.000-03:00')
    const curta = corpoDoPix({ ...base, expiraEm: new Date(agora.getTime() + 10 * 60_000) }, agora)
    expect(curta.date_of_expiration).toBe('2026-09-28T12:31:00.000-03:00')
    const longa = corpoDoPix({ ...base, expiraEm: new Date(agora.getTime() + 90 * 24 * 3600_000) }, agora)
    expect(longa.date_of_expiration).toBe('2026-10-28T12:00:00.000-03:00')
  })

  it('sem endereço de aviso, o corpo não leva notification_url', () => {
    expect('notification_url' in corpoDoPix({ ...base, urlDeAviso: null }, agora)).toBe(false)
  })

  it('a data no formato da doc (qualquer outro é o erro 23)', () => {
    expect(dataDoMP(new Date('2026-01-02T03:04:05.678Z'))).toBe('2026-01-02T00:04:05.678-03:00')
  })
})

describe('endereço do aviso', () => {
  it('só https, com a organização no caminho e o formato novo pedido', () => {
    expect(urlDoAviso('https://parque.com.br/', 'org-1'))
      .toBe('https://parque.com.br/api/webhooks/mercadopago/org-1?source_news=webhooks')
    expect(urlDoAviso('http://127.0.0.1:3120', 'org-1')).toBeNull()
    expect(urlDoAviso(null, 'org-1')).toBeNull()
    expect(urlDoAviso(`https://${'a'.repeat(240)}.com`, 'org-1')).toBeNull()
  })
})

describe('este Pix sai pelo Mercado Pago?', () => {
  const prod = { NODE_ENV: 'production' }
  it('sem token: não', () => {
    expect(pixPeloMercadoPago({ mp_access_token: null }, prod)).toEqual({ ok: false, motivo: 'sem_token' })
  })
  it('token de TESTE em produção não liga (nem conta marcada de teste pelo /users/me)', () => {
    expect(pixPeloMercadoPago({ mp_access_token: 'TEST-123-abc' }, prod)).toEqual({ ok: false, motivo: 'token_de_teste' })
    expect(pixPeloMercadoPago({ mp_access_token: 'APP_USR-123-abc', mp_test: true }, prod))
      .toEqual({ ok: false, motivo: 'token_de_teste' })
  })
  it('token de produção em produção liga; fora de produção qualquer token liga', () => {
    expect(pixPeloMercadoPago({ mp_access_token: 'APP_USR-123-abc' }, prod)).toEqual({ ok: true })
    expect(pixPeloMercadoPago({ mp_access_token: 'TEST-123-abc', mp_test: true }, { NODE_ENV: 'development' }))
      .toEqual({ ok: true })
  })
  it('em produção a API é SEMPRE a do MP — o token nunca vai pra outro endereço', () => {
    expect(baseDaApi({ NODE_ENV: 'production', MERCADOPAGO_API_URL: 'http://ladrao.example' }))
      .toBe('https://api.mercadopago.com')
    expect(baseDaApi({ NODE_ENV: 'development', MERCADOPAGO_API_URL: 'http://127.0.0.1:3199/' }))
      .toBe('http://127.0.0.1:3199')
  })
})

describe('tarifa e líquido, na palavra do MP', () => {
  it('aprovado: soma as tarifas e pega o líquido (R$ 30 → R$ 29,70)', () => {
    expect(tarifaELiquido({ status: 'approved', transaction_details: { net_received_amount: 29.7 },
      fee_details: [{ type: 'mercadopago_fee', amount: 0.3 }] })).toEqual({ taxaCents: 30, liquidoCents: 2970 })
  })
  it('pendente vem com líquido 0 — isso não é líquido', () => {
    expect(tarifaELiquido({ status: 'pending', transaction_details: { net_received_amount: 0 } }))
      .toEqual({ taxaCents: null, liquidoCents: null })
  })
})
