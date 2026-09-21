/**
 * envio.test.ts — o comprador paga e RECEBE.
 *
 * Até aqui o sistema cobrava e não mandava nada: nenhum e-mail, nenhuma fila,
 * nenhum registro. O que este arquivo trava, em ordem de quanto custa errar:
 *
 *  1. **Pagamento confirmado vira linha na fila sem ninguém chamar** — quem
 *     enfileira é o gatilho do banco, dentro da transação do pagamento. Não
 *     existe caminho de código que possa esquecer.
 *  2. **Reentrega do gateway não vira segundo e-mail** — o Asaas manda
 *     PAYMENT_CONFIRMED e depois PAYMENT_RECEIVED pra mesma cobrança.
 *  3. **A reserva da fila é atômica** — dois trabalhadores nunca pegam a
 *     mesma linha. Provado com DUAS CONEXÕES e ordem forçada na mão, porque
 *     `Promise.all` com dois `fetch` ficaria verde até sem trava nenhuma.
 *  4. **Ingresso estornado não é entregue** — mandar "confirmado" depois do
 *     estorno põe gente no portão com QR morto.
 *  5. **Falha fica escrita, em português, tentativa por tentativa** — é o que
 *     o guichê lê quando o cliente diz que não chegou.
 *  6. **O QR vai ANEXADO** — imagem remota é bloqueada por padrão no Gmail e
 *     no Outlook, e o ingresso apareceria como um retângulo vazio.
 *
 * Fixture própria, ids próprios, apagada no fim. O evento semeado não é
 * tocado. Os casos de rota precisam do servidor de dev no ar; sem ele, PULAM.
 */
import net from 'node:net'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { db, q, q1, tx } from './db'
import { emitirNaTransacao } from './emissao'
import { reservar } from './estoque'
import {
  assuntoCodificado, enderecoValido, entregarPorSmtp, montarConfirmacao, montarMime,
} from './email'
import {
  FILA_DE_ENVIO, FILA_DE_ESTORNO, SQL_RESERVA, adiamentoSegundos, anunciarWorker,
  baterPonto, emPortugues, encerrarPonto,
  enfileirar, garantirWorker, instanciaDoProcesso, montarMensagemDoPedido, pararWorker,
  processarUm, reservarProximo, usarTransporte, vereditoDaFila,
} from './envio'
// O formatador único da casa, o MESMO que a tela usa por auto-import do Nuxt.
// Importar uma cópia aqui faria o teste de sinal julgar um `reais()` que não é
// o que roda na auditoria — e passaria verde com a tela errada.
import { reais } from '~/composables/formato'

const BASE = process.env.BASE_TESTE ?? 'http://localhost:3100'

/**
 * Endereço PRÓPRIO DE CADA RODADA, e não uma constante.
 *
 * `users` só é único por `(org_id, email)`, e o login faz
 * `WHERE lower(email) = $1` sem dizer de qual organização. Com e-mail fixo,
 * basta existir uma segunda linha com ele — outra rodada em paralelo (é o
 * normal aqui, vários agentes rodando a suíte ao mesmo tempo) ou uma rodada
 * anterior morta antes do `afterAll` — pro login abrir sessão na organização
 * ERRADA. Aí a cerca de tenant recusa o evento desta rodada e os casos de
 * rota falham com 404 "Evento não encontrado", apontando pro reenvio, que não
 * tem culpa nenhuma. Pior: `não reenvia pedido de OUTRO evento` fica VERDE por
 * acidente, porque ele espera 404 e é 404 que chega — a trava que ele promete
 * proteger deixa de ser exercitada sem ninguém perceber.
 */
const EMAIL_DONO = `dono.envio.${randomUUID().slice(0, 8)}@teste.invalido`

let orgId: string, eventId: string, sectorId: string, customerId: string, lotId: string
let outroEventoId: string
let noAr = false
let cookie = ''

const comSessao = (rota: string, init: RequestInit = {}) =>
  fetch(`${BASE}${rota}`, {
    ...init,
    headers: { 'content-type': 'application/json', cookie, origin: BASE, ...(init.headers ?? {}) },
  })

beforeAll(async () => {
  // A varredura de fundo sobe junto com o módulo; aqui quem decide quando a
  // fila anda é o teste, senão o laço rouba a linha no meio da asserção.
  pararWorker()
  process.env.NUXT_SESSION_SECRET ||= 'segredo-de-teste-comprido-o-bastante'

  orgId = (await q1<any>(`INSERT INTO organizations (name, slug)
    VALUES ('ZZ ENVIO', 'zz-envio-' || gen_random_uuid()) RETURNING id`))!.id
  eventId = (await q1<any>(
    `INSERT INTO events (org_id, name, slug, status, starts_at, ends_at, fee_bps, venue_name, city, state)
     VALUES ($1,'ZZ Parque Aquático','zz-envio-' || gen_random_uuid(),'ativo',
             now() + interval '10 days', now() + interval '11 days', 1000,
             'Fazenda Park','Vitória da Conquista','BA') RETURNING id`, [orgId]))!.id
  outroEventoId = (await q1<any>(
    `INSERT INTO events (org_id, name, slug, status, starts_at, ends_at)
     VALUES ($1,'ZZ Outro','zz-outro-' || gen_random_uuid(),'ativo',
             now() + interval '10 days', now() + interval '11 days') RETURNING id`, [orgId]))!.id
  sectorId = (await q1<any>(`INSERT INTO sectors (event_id, name)
    VALUES ($1,'Entrada') RETURNING id`, [eventId]))!.id
  customerId = (await q1<any>(`INSERT INTO customers (org_id, name, email, document)
    VALUES ($1,'João Coração','joao.envio@teste.invalido','39053344705') RETURNING id`, [orgId]))!.id

  await q(`INSERT INTO users (org_id, name, email, password_hash, role)
           SELECT $1, 'Dono Envio', $2, password_hash, 'master'
             FROM users WHERE email = 'dono@fazendapark.com.br'
           ON CONFLICT (org_id, email) DO NOTHING`, [orgId, EMAIL_DONO])

  try {
    noAr = (await fetch(`${BASE}/api/auth/eu`, { signal: AbortSignal.timeout(2500) })).status < 500
  } catch { noAr = false }
  // Duas tentativas: o servidor de dev recompila sozinho quando qualquer
  // arquivo é salvo, e a requisição que cai bem no meio da recarga volta
  // vazia. Sem o repique, o arquivo inteiro de rota falha por um motivo que
  // não tem nada a ver com o que está sendo testado.
  for (let tentativa = 0; noAr && !cookie && tentativa < 2; tentativa++) {
    const r = await fetch(`${BASE}/api/auth/entrar`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: EMAIL_DONO, senha: 'diamond123' }),
    }).catch(() => null)
    cookie = (r?.headers.getSetCookie?.() ?? [])
      .map((c) => c.split(';')[0]).find((c) => c.startsWith('dt_sessao=')) ?? ''
  }

  // Sessão aberta na organização errada é a única forma de a fixture mentir
  // sem ninguém ver — ver a nota do EMAIL_DONO. Custa uma requisição e troca
  // sete 404 misteriosos por uma frase que diz onde está o problema.
  if (cookie) {
    const eu = await comSessao('/api/auth/eu').then((r) => r.json()).catch(() => null)
    expect(eu?.usuario?.orgId,
      'o login abriu sessão em OUTRA organização: sobrou um usuário com este e-mail no banco')
      .toBe(orgId)
  }
}, 30_000)

afterAll(async () => {
  usarTransporte(null)
  pararWorker()
  await q(`DELETE FROM organizations WHERE id = $1`, [orgId])
  await db().end()
})

/* ------------------------------------------------------------- fixture */

async function pedidoPendente(qtd = 2, precoCents = 4500, evento = eventId) {
  const setor = evento === eventId
    ? sectorId
    : (await q1<any>(`INSERT INTO sectors (event_id, name) VALUES ($1,'Entrada')
                      ON CONFLICT DO NOTHING RETURNING id`, [evento]))?.id
      ?? (await q1<any>(`SELECT id FROM sectors WHERE event_id = $1 LIMIT 1`, [evento]))!.id
  lotId = (await q1<any>(
    `INSERT INTO lots (sector_id, name, price_cents, quantity, max_per_order)
     VALUES ($1, 'Lote ' || gen_random_uuid(), $2, 100, 50) RETURNING id`,
    [setor, precoCents]))!.id
  const face = precoCents * qtd
  const taxa = Math.round(precoCents * 0.1) * qtd
  const pedido = (await q1<any>(
    `INSERT INTO orders (org_id, event_id, customer_id, code, status,
                         face_cents, fee_cents, platform_cents, discount_cents, total_cents,
                         payment_method, asaas_payment_id, expires_at)
     VALUES ($1,$2,$3,'ZZE-'||substr(gen_random_uuid()::text,1,8),'aguardando_pagamento',
             $4,$5,$5,0,$6,'pix','pay_zz_'||substr(gen_random_uuid()::text,1,8),
             now() + interval '20 minutes')
     RETURNING id, code`, [orgId, evento, customerId, face, taxa, face + taxa]))!
  await q(`INSERT INTO order_items (order_id, lot_id, quantity,
             unit_face_cents, unit_fee_cents, unit_total_cents)
           VALUES ($1,$2,$3,$4,$5,$6)`,
    [pedido.id, lotId, qtd, precoCents, Math.round(precoCents * 0.1),
     precoCents + Math.round(precoCents * 0.1)])
  await tx((c) => reservar(c, [{ lotId, quantidade: qtd }]))
  return pedido as { id: string; code: string }
}

/**
 * Paga pelo caminho de verdade (a mesma emissão que o webhook chama) e, no
 * MESMO commit, estaciona a linha da fila no futuro.
 *
 * O estacionamento não é frescura: o servidor de dev tem o trabalhador de
 * fundo rodando contra este mesmo banco. Sem isso ele varre a fila entre o
 * `INSERT` e a asserção, envia a linha do teste, e o caso falha apontando pro
 * lugar errado. Estacionada, só sai quando o teste pede por id.
 */
async function pagar(pedidoId: string) {
  return tx(async (c) => {
    const r = await emitirNaTransacao(c, pedidoId)
    await c.query(
      `UPDATE email_sends SET available_at = now() + interval '1 hour' WHERE order_id = $1`,
      [pedidoId])
    return r
  })
}

const envioDoPedido = (pedidoId: string) =>
  q1<any>(`SELECT * FROM email_sends WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [pedidoId])

/**
 * Servidor fora do ar: PULA. Servidor no ar e sessão vazia: FALHA, aqui.
 *
 * Os dois casos parecem o mesmo e não são. Sem sessão, toda rota responde 401
 * e o caso segue adiante lendo `corpo.envio` indefinido — o erro que aparece é
 * do driver do Postgres, três chamadas depois, apontando pro lugar errado.
 * (Foi o que aconteceu quando o freio de força bruta do login, que conta por
 * IP, travou o localhost inteiro no meio de uma rodada.)
 */
function semRota(): boolean {
  if (!noAr) {
    console.warn('  (pulado: servidor fora do ar)')
    return true
  }
  expect(cookie,
    'sem sessão os casos de rota testariam o 401 do porteiro, não o reenvio').toBeTruthy()
  return false
}

/* ===================================================== 1. o gatilho */

describe('o pagamento enfileira o e-mail sozinho', () => {
  it('pedido pago vira linha na fila, sem handler nenhum chamar envio', async () => {
    const p = await pedidoPendente(2)
    expect(await envioDoPedido(p.id), 'enfileirou antes de o pedido ser pago').toBeNull()

    await pagar(p.id)

    const envio = await envioDoPedido(p.id)
    expect(envio, 'o comprador pagou e nada foi enfileirado — ele não recebe nada').toBeTruthy()
    expect(envio.to_email).toBe('joao.envio@teste.invalido')
    expect(envio.kind).toBe('confirmacao_pedido')
    expect(envio.origin).toBe('automatico')
    expect(envio.status).toBe('na_fila')
  })

  it('reentrega do gateway NÃO vira segundo e-mail', async () => {
    const p = await pedidoPendente(1)
    await pagar(p.id)

    // O Asaas manda CONFIRMED e depois RECEIVED, e repete quando não recebe
    // 200. Aqui o pior caso: o status sai de 'pago' e volta, então o gatilho
    // dispara de novo de verdade — quem segura é o índice único parcial.
    await tx(async (c) => {
      await c.query(`UPDATE orders SET status = 'em_analise' WHERE id = $1`, [p.id])
      await c.query(`UPDATE orders SET status = 'pago' WHERE id = $1`, [p.id])
      await c.query(`UPDATE orders SET status = 'pago' WHERE id = $1`, [p.id])
      await c.query(
        `UPDATE email_sends SET available_at = now() + interval '1 hour' WHERE order_id = $1`,
        [p.id])
    })

    const n = await q1<any>(
      `SELECT count(*)::int AS n FROM email_sends WHERE order_id = $1`, [p.id])
    expect(n.n, 'cada reentrega do gateway virou um e-mail a mais na caixa do comprador').toBe(1)
  })

  it('carga de histórico NÃO vira e-mail pra base inteira', async () => {
    // O seed e a importação da planilha gravam venda antiga já paga. Sem a
    // trava do paid_at, o dia da importação vira "ingressos confirmados" na
    // caixa de todo mundo que comprou nos últimos dois anos.
    const antigo = await q1<any>(
      `INSERT INTO orders (org_id, event_id, customer_id, code, status, payment_method,
                           face_cents, fee_cents, platform_cents, discount_cents,
                           total_cents, paid_at)
       VALUES ($1,$2,$3,'ZZE-HIST-'||substr(gen_random_uuid()::text,1,6),'pago','pix',
               1000,100,100,0,1100, now() - interval '200 days')
       RETURNING id`, [orgId, eventId, customerId])
    expect(await envioDoPedido(antigo.id),
      'importar o histórico disparou e-mail de compra antiga').toBeNull()

    // e a venda de AGORA, no mesmo formato, continua saindo
    const hoje = await q1<any>(
      `INSERT INTO orders (org_id, event_id, customer_id, code, status, payment_method,
                           face_cents, fee_cents, platform_cents, discount_cents,
                           total_cents, paid_at)
       VALUES ($1,$2,$3,'ZZE-HOJE-'||substr(gen_random_uuid()::text,1,6),'pago','pix',
               1000,100,100,0,1100, now())
       RETURNING id`, [orgId, eventId, customerId])
    expect(await envioDoPedido(hoje.id),
      'a trava do histórico comeu a venda de hoje junto').toBeTruthy()
    await q(`UPDATE email_sends SET available_at = now() + interval '1 hour' WHERE order_id = $1`,
      [hoje.id])
  })

  it('pedido pago sem e-mail de comprador não vira falha garantida na fila', async () => {
    const pedido = await q1<any>(
      `INSERT INTO orders (org_id, event_id, code, status, channel, payment_method,
                           face_cents, fee_cents, platform_cents, discount_cents,
                           total_cents, paid_at)
       VALUES ($1,$2,'ZZE-SM-'||substr(gen_random_uuid()::text,1,8),
               'pago','cortesia','cortesia',0,0,0,0,0,now())
       RETURNING id`, [orgId, eventId])
    expect((await envioDoPedido(pedido.id)),
      'enfileirou um envio sem destinatário — isso só produz alarme falso').toBeNull()
  })
})

/* ============================================== 2. a reserva atômica */

describe('a reserva da fila', () => {
  it('não entrega a mesma linha a dois trabalhadores', async () => {
    const p = await pedidoPendente(1)
    await pagar(p.id)
    const envio = await envioDoPedido(p.id)

    const c1 = await db().connect()
    const c2 = await db().connect()
    try {
      await c1.query('BEGIN')
      await c2.query('BEGIN')
      // Teto curto em B. Sem ele, a reserva errada não devolve linha
      // duplicada: ela FICA PENDURADA esperando a trava de A, e o caso morre
      // de timeout do vitest 20 s depois, apontando pro lugar errado. Com o
      // teto, "ficou esperando" vira uma falha rápida e com nome.
      await c2.query(`SET LOCAL statement_timeout = '1500ms'`)

      const a = await reservarProximo(c1, 'trabalhador-A', envio.id)
      expect(a?.id, 'o primeiro trabalhador não conseguiu reservar').toBe(envio.id)
      expect(a!.attempts).toBe(1)

      // B corre EXATAMENTE o mesmo comando enquanto A ainda não confirmou.
      // Com a reserva atômica ele PULA a linha travada e volta de mãos
      // vazias, na hora. Trocado por SELECT + UPDATE, ou ele leva a mesma
      // linha (e o comprador recebe o ingresso duas vezes) ou trava na fila
      // de espera do Postgres.
      const b = await reservarProximo(c2, 'trabalhador-B', envio.id)
        .catch((e: any) => {
          throw new Error('o segundo trabalhador ficou PRESO esperando a linha do ' +
            `primeiro em vez de pular pra próxima: ${e?.message}`)
        })
      expect(b, 'dois trabalhadores reservaram a MESMA linha — e-mail duplicado').toBeNull()

      await c1.query('COMMIT')

      // Depois do commit de A a linha existe, mas já não está 'na_fila'.
      const c = await reservarProximo(c2, 'trabalhador-B', envio.id)
      expect(c, 'reservou de novo uma linha que já estava em envio').toBeNull()
      await c2.query('ROLLBACK')
    } finally {
      // ROLLBACK antes de devolver ao pool, sempre: `release()` não desfaz
      // transação aberta, e a trava presa derrubaria o caso seguinte.
      await c1.query('ROLLBACK').catch(() => {})
      await c2.query('ROLLBACK').catch(() => {})
      c1.release()
      c2.release()
    }
  }, 20_000)

  it('resgata a linha presa em envio por um processo que morreu', async () => {
    const p = await pedidoPendente(1)
    await pagar(p.id)
    const envio = await envioDoPedido(p.id)

    // kill -9 no meio do envio: ficou 'enviando' e ninguém devolveu.
    await q(`UPDATE email_sends SET status = 'enviando', claimed_by = 'morto',
                    claimed_at = now() - interval '30 minutes' WHERE id = $1`, [envio.id])

    const resgatada = await reservarProximo(db(), 'vivo', envio.id)
    expect(resgatada?.id,
      'a linha ficou presa em "enviando" pra sempre e o ingresso nunca sai').toBe(envio.id)

    // e a que acabou de ser reservada por alguém vivo NÃO é resgatada
    const denovo = await reservarProximo(db(), 'outro', envio.id)
    expect(denovo, 'roubou uma linha que outro trabalhador acabou de reservar').toBeNull()
  })

  it('a espera depois da falha cresce em vez de brigar com o servidor', () => {
    expect(adiamentoSegundos(1)).toBe(30)
    expect(adiamentoSegundos(2)).toBe(60)
    expect(adiamentoSegundos(3)).toBe(120)
    expect(adiamentoSegundos(20), 'sem teto, a espera viraria dias').toBe(3600)
  })
})

/* ============================================ 3. o e-mail que sai */

describe('o e-mail de confirmação', () => {
  it('leva o QR ANEXADO, não um link de imagem que o Gmail bloqueia', async () => {
    const p = await pedidoPendente(2)
    await pagar(p.id)

    const m = await montarMensagemDoPedido(p.id, 'joao.envio@teste.invalido', 'João Coração')

    expect(m.imagens?.length, 'o e-mail saiu sem QR nenhum').toBe(2)
    expect(m.imagens![0].conteudo.subarray(0, 4).toString('hex'),
      'o anexo não é um PNG').toBe('89504e47')
    expect(m.html).toContain(`cid:${m.imagens![0].cid}`)
    expect(m.html, 'o QR virou imagem remota — chega como retângulo vazio')
      .not.toMatch(/<img[^>]+src="https?:/i)

    const { bruto } = montarMime(m)
    expect(bruto).toContain(`Content-ID: <${m.imagens![0].cid}>`)
    expect(bruto).toContain('Content-Type: multipart/related')
    expect(bruto, 'o PNG não foi pro corpo da mensagem')
      .toContain(m.imagens![0].conteudo.toString('base64').slice(0, 60))
  })

  it('traz o código do ingresso, o valor e o link — inclusive em texto puro', async () => {
    const p = await pedidoPendente(2, 4500)
    await pagar(p.id)
    const codigos = (await q<any>(
      `SELECT code FROM tickets WHERE order_id = $1 ORDER BY code`, [p.id])).map((t) => t.code)

    const m = await montarMensagemDoPedido(p.id, 'joao.envio@teste.invalido', 'João Coração')

    for (const c of codigos) {
      expect(m.html, `o ingresso ${c} não está no e-mail`).toContain(c)
      expect(m.texto, `o ingresso ${c} sumiu da versão em texto`).toContain(c)
    }
    expect(m.assunto).toContain('ZZ Parque Aquático')
    expect(m.assunto).toContain(p.code)
    // `toLocaleString` separa o R$ com espaço FINO (U+00A0): comparar sem
    // normalizar falha com as duas strings idênticas na tela. Escrito como
    //   de propósito — o caractere cru é invisível na revisão do diff.
    expect(m.html.replace(/ /g, ' '), 'o total pago não aparece').toContain('R$ 99,00')
    expect(m.texto).toContain(`/ingressos/${p.code}`)
    expect(m.html).toContain(`/ingressos/${p.code}`)
  })

  it('assunto com acento vai codificado, senão chega como "Ã§Ã£o"', () => {
    expect(assuntoCodificado('Ingressos confirmados')).toBe('Ingressos confirmados')
    const codificado = assuntoCodificado('Ingressos do Parque Aquático')
    expect(codificado).toMatch(/^=\?UTF-8\?B\?/)
    expect(Buffer.from(codificado.slice(10, -2), 'base64').toString('utf8'))
      .toBe('Ingressos do Parque Aquático')
  })

  it('recusa endereço que o guichê digitou torto', () => {
    expect(enderecoValido('joao@fazendapark.com.br')).toBe(true)
    expect(enderecoValido('joao @fazendapark.com.br')).toBe(false)
    expect(enderecoValido('joao@fazendapark')).toBe(false)
    expect(enderecoValido('joao@,fazendapark.com')).toBe(false)
    expect(enderecoValido('')).toBe(false)
    expect(enderecoValido(null)).toBe(false)
  })

  it('NÃO monta e-mail de pedido estornado — QR morto no portão é pior', async () => {
    const p = await pedidoPendente(1)
    await pagar(p.id)
    await q(`UPDATE orders SET status = 'estornado', refunded_cents = total_cents,
                    refunded_at = now() WHERE id = $1`, [p.id])

    await expect(montarMensagemDoPedido(p.id, 'joao.envio@teste.invalido'))
      .rejects.toThrow(/saiu de pago/)
  })

  it('estorno PARCIAL continua valendo ingresso', async () => {
    const p = await pedidoPendente(1)
    await pagar(p.id)
    await q(`UPDATE orders SET status = 'estornado_parcial', refunded_cents = 1000,
                    refunded_at = now() WHERE id = $1`, [p.id])

    const m = await montarMensagemDoPedido(p.id, 'joao.envio@teste.invalido')
    expect(m.imagens?.length, 'sumiu com o ingresso de quem teve estorno de R$ 10').toBe(1)
  })
})

/* ====================================== 4. entrega, falha e registro */

describe('a entrega', () => {
  it('sai, grava o corpo e deixa o .eml em disco no modo simulado', async () => {
    usarTransporte(null)
    const p = await pedidoPendente(2)
    await pagar(p.id)
    const envio = await envioDoPedido(p.id)

    const r = await processarUm('teste', envio.id)
    expect(r?.ok, `não entregou: ${r?.erro}`).toBe(true)
    expect(r!.via).toBe('simulado')

    const depois = await envioDoPedido(p.id)
    expect(depois.status).toBe('enviado')
    expect(depois.sent_via, 'marcou como enviado de verdade sem servidor de e-mail nenhum')
      .toBe('simulado')
    expect(depois.sent_at).toBeTruthy()
    expect(depois.subject, 'não guardou o que foi enviado').toContain(p.code)
    expect(depois.body_html).toContain('cid:')
    expect(depois.message_id).toMatch(/^<.+@diamond-tickets>$/)

    const eml = await readFile(depois.file_path, 'utf8')
    expect(eml, 'o arquivo simulado não é a mesma mensagem').toContain('Content-ID:')
    expect(eml).toContain(depois.message_id)
  })

  it('a falha volta pra fila com o erro escrito em português', async () => {
    const p = await pedidoPendente(1)
    await pagar(p.id)
    const envio = await envioDoPedido(p.id)

    usarTransporte(async () => { throw new Error('connect ECONNREFUSED 10.0.0.9:587') })
    const r = await processarUm('teste', envio.id)
    usarTransporte(null)

    expect(r?.ok).toBe(false)
    expect(r!.status, 'desistiu na primeira falha de rede').toBe('na_fila')

    const depois = await envioDoPedido(p.id)
    expect(depois.status).toBe('na_fila')
    expect(depois.attempts).toBe(1)
    expect(depois.last_error, 'guardou o erro sem dizer pra quem era')
      .toContain('joao.envio@teste.invalido')
    expect(depois.last_error).toContain('servidor de e-mail')
    expect(new Date(depois.available_at).getTime(),
      'voltou pra fila sem espera nenhuma e vai girar em brasa').toBeGreaterThan(Date.now())
    expect(depois.claimed_at, 'ficou marcada como reservada depois de falhar').toBeNull()
  })

  it('cada tentativa vira uma linha, com o erro daquela tentativa', async () => {
    const p = await pedidoPendente(1)
    await pagar(p.id)
    const envio = await envioDoPedido(p.id)

    usarTransporte(async () => { throw new Error('caixa de entrada cheia') })
    await processarUm('teste', envio.id)
    usarTransporte(null)
    await processarUm('teste', envio.id)

    const tentativas = await q<any>(
      `SELECT attempt, ok, error, transport FROM email_send_attempts
        WHERE send_id = $1 ORDER BY attempt`, [envio.id])
    expect(tentativas.length, 'só guardou a última tentativa — o primeiro erro é o que explica')
      .toBe(2)
    expect(tentativas[0].ok).toBe(false)
    expect(tentativas[0].error).toContain('caixa de entrada cheia')
    expect(tentativas[1].ok).toBe(true)
    expect(tentativas[1].transport).toBe('simulado')
  })

  it('depois do teto de tentativas, para de tentar', async () => {
    const p = await pedidoPendente(1)
    await pagar(p.id)
    const envio = await envioDoPedido(p.id)
    await q(`UPDATE email_sends SET max_attempts = 2 WHERE id = $1`, [envio.id])

    usarTransporte(async () => { throw new Error('domínio não existe') })
    const primeira = await processarUm('teste', envio.id)
    const segunda = await processarUm('teste', envio.id)
    usarTransporte(null)

    expect(primeira!.status).toBe('na_fila')
    expect(segunda!.status, 'ficou tentando pra sempre contra um domínio que não existe')
      .toBe('falhou')
    expect((await envioDoPedido(p.id)).last_error).toContain('domínio não existe')
  })

  it('pedido estornado no meio do caminho falha DE VEZ, sem retentar', async () => {
    const p = await pedidoPendente(1)
    await pagar(p.id)
    const envio = await envioDoPedido(p.id)
    await q(`UPDATE orders SET status = 'estornado' WHERE id = $1`, [p.id])

    const r = await processarUm('teste', envio.id)
    expect(r!.status, 'vai insistir cinco vezes em entregar um ingresso que não vale mais')
      .toBe('falhou')
    expect(r!.erro).toContain('saiu de pago')
  })
})

/* ========================================== 5. SMTP de verdade */

/** Servidor de SMTP de mentira, no 127.0.0.1. Nenhum e-mail sai da máquina. */
function smtpDeMentira(opcoes: { recusarRcpt?: boolean } = {}) {
  const recebido = { auth: '', de: '', para: '', mensagem: '' }
  const servidor = net.createServer((s) => {
    let buffer = ''
    let corpo = ''
    let emDados = false
    s.setEncoding('utf8')
    s.write('220 mentira.local ESMTP\r\n')
    s.on('error', () => { /* cliente desligou */ })
    s.on('data', (d: any) => {
      buffer += String(d)
      let i: number
      while ((i = buffer.indexOf('\r\n')) >= 0) {
        const linha = buffer.slice(0, i)
        buffer = buffer.slice(i + 2)
        if (emDados) {
          if (linha === '.') {
            emDados = false
            recebido.mensagem = corpo
            s.write('250 2.0.0 aceito\r\n')
          } else {
            // desfaz o "dot stuffing" do cliente
            corpo += (linha.startsWith('..') ? linha.slice(1) : linha) + '\n'
          }
          continue
        }
        const cmd = linha.toUpperCase()
        if (cmd.startsWith('EHLO') || cmd.startsWith('HELO')) {
          s.write('250-mentira.local\r\n250-AUTH PLAIN LOGIN\r\n250 SIZE 10485760\r\n')
        } else if (cmd.startsWith('AUTH')) {
          recebido.auth = linha
          s.write('235 2.7.0 autenticado\r\n')
        } else if (cmd.startsWith('MAIL FROM')) {
          recebido.de = linha
          s.write('250 2.1.0 ok\r\n')
        } else if (cmd.startsWith('RCPT TO')) {
          recebido.para = linha
          s.write(opcoes.recusarRcpt
            ? '550 5.1.1 caixa postal nao existe\r\n'
            : '250 2.1.5 ok\r\n')
        } else if (cmd === 'DATA') {
          emDados = true
          corpo = ''
          s.write('354 manda que eu escuto\r\n')
        } else if (cmd === 'QUIT') {
          s.write('221 2.0.0 tchau\r\n')
          s.end()
        } else {
          s.write('250 2.0.0 ok\r\n')
        }
      }
    })
  })
  const pronto = new Promise<number>((res) => {
    servidor.listen(0, '127.0.0.1', () => res((servidor.address() as net.AddressInfo).port))
  })
  return { recebido, pronto, fechar: () => new Promise((r) => servidor.close(() => r(null))) }
}

describe('ligar o envio de verdade', () => {
  it('com SMTP_URL, a mensagem sai pelo protocolo — autenticada e completa', async () => {
    const falso = smtpDeMentira()
    const porta = await falso.pronto
    const p = await pedidoPendente(1)
    await pagar(p.id)
    const envio = await envioDoPedido(p.id)

    const anterior = process.env.SMTP_URL
    process.env.SMTP_URL = `smtp://guiche:senha-de-mentira@127.0.0.1:${porta}`
    try {
      const r = await processarUm('teste-smtp', envio.id)
      expect(r?.ok, `não entregou pelo SMTP: ${r?.erro}`).toBe(true)
      expect(r!.via, 'com servidor configurado, continuou só simulando').toBe('smtp')
    } finally {
      if (anterior === undefined) delete process.env.SMTP_URL
      else process.env.SMTP_URL = anterior
      await falso.fechar()
    }

    expect(falso.recebido.auth, 'mandou sem autenticar').toMatch(/^AUTH PLAIN /i)
    expect(Buffer.from(falso.recebido.auth.split(' ')[2], 'base64').toString('utf8'))
      .toBe('\0guiche\0senha-de-mentira')
    expect(falso.recebido.para).toContain('joao.envio@teste.invalido')
    expect(falso.recebido.mensagem, 'o servidor recebeu uma mensagem sem assunto')
      .toContain('Subject: ')
    expect(falso.recebido.mensagem, 'o QR não chegou no que foi entregue')
      .toContain('Content-ID: <qr-')
    expect((await envioDoPedido(p.id)).sent_via).toBe('smtp')
  }, 20_000)

  it('recusa do servidor vira mensagem que o guichê entende', async () => {
    const falso = smtpDeMentira({ recusarRcpt: true })
    const porta = await falso.pronto
    const p = await pedidoPendente(1)
    await pagar(p.id)
    const envio = await envioDoPedido(p.id)

    const anterior = process.env.SMTP_URL
    process.env.SMTP_URL = `smtp://127.0.0.1:${porta}`
    try {
      const r = await processarUm('teste-smtp', envio.id)
      expect(r!.ok).toBe(false)
      expect(r!.erro).toContain('joao.envio@teste.invalido')
      expect(r!.erro, 'o operador precisa ver o motivo do servidor, não só um número')
        .toContain('caixa postal nao existe')
    } finally {
      if (anterior === undefined) delete process.env.SMTP_URL
      else process.env.SMTP_URL = anterior
      await falso.fechar()
    }
  }, 20_000)

  it('servidor fora do ar não derruba a fila — vira espera', async () => {
    const p = await pedidoPendente(1)
    await pagar(p.id)
    const envio = await envioDoPedido(p.id)

    const anterior = process.env.SMTP_URL
    // porta fechada de propósito
    process.env.SMTP_URL = 'smtp://127.0.0.1:9'
    try {
      const m = await montarMensagemDoPedido(p.id, 'joao.envio@teste.invalido')
      await expect(entregarPorSmtp(m)).rejects.toThrow()
      const r = await processarUm('teste-smtp', envio.id)
      expect(r!.status).toBe('na_fila')
      expect(r!.erro).toContain('servidor de e-mail')
    } finally {
      if (anterior === undefined) delete process.env.SMTP_URL
      else process.env.SMTP_URL = anterior
    }
  }, 20_000)
})

/* =================================== 6. o reenvio pedido no balcão */

describe('reenvio pelo painel', () => {
  const reenviar = (evento: string, corpo: any) =>
    comSessao(`/api/admin/evento/${evento}/reenviar`, {
      method: 'POST', body: JSON.stringify(corpo),
    })

  /**
   * O caso real do reenvio começa DEPOIS que a confirmação automática já
   * saiu — "não chegou" é reclamação sobre um e-mail que o sistema mandou.
   * Sem isto aqui, o teste estaria exercitando a fila entalada, que é outro
   * caso (e tem o dele mais abaixo).
   */
  async function jaEntregouAutomatico(pedidoId: string) {
    const automatico = await envioDoPedido(pedidoId)
    const r = await processarUm('confirmacao', automatico.id)
    expect(r?.ok, `a confirmação automática não saiu: ${r?.erro}`).toBe(true)
  }

  // A PRIMEIRA requisição deste arquivo à rota de reenvio paga a compilação
  // dela no servidor de dev, que recompila a cada arquivo salvo. Medido: com
  // outra trilha salvando arquivo no meio da suíte, essa primeira chamada
  // estourou os 30 s e o vermelho apontou pro reenvio, que não tinha culpa —
  // vermelho que mente sobre o culpado é o que ensina todo mundo a ignorar
  // vermelho. O caso lá embaixo já aquecia por conta própria; aqui vale pro
  // bloco inteiro.
  beforeAll(async () => {
    if (semRota()) return
    await reenviar(eventId, { pedido: 'ZZE-AQUECE' }).catch(() => null)
  }, 120_000)

  it('manda de novo e diz pra onde foi', async () => {
    if (semRota()) return
    const p = await pedidoPendente(2)
    await pagar(p.id)
    await jaEntregouAutomatico(p.id)

    const r = await reenviar(eventId, { pedido: p.code })
    const corpo = await r.json()
    expect(r.status, `recusou o reenvio — ${corpo.statusMessage ?? corpo.message}`).toBe(200)
    expect(corpo.para).toBe('joao.envio@teste.invalido')
    expect(corpo.simulado, 'disse que mandou sem ter servidor de e-mail configurado').toBe(true)
    expect(corpo.mensagem, 'a resposta não avisa que o e-mail não saiu da máquina')
      .toMatch(/simulado/i)

    const linha = await q1<any>(
      `SELECT * FROM email_sends WHERE id = $1`, [corpo.envio])
    expect(linha.origin).toBe('reenvio')
    expect(linha.status).toBe('enviado')
    expect(linha.requested_by, 'não guardou quem mandou reenviar').toBeTruthy()

    const registro = await q1<any>(
      `SELECT after FROM audit_log
        WHERE entity = 'order' AND entity_id = $1 AND action = 'reenvio_email'`, [p.id])
    expect(registro, 'reenviou ingresso pago sem deixar rastro de quem foi').toBeTruthy()
  }, 30_000)

  it('manda pro endereço corrigido quando o cadastro está errado', async () => {
    if (semRota()) return
    const p = await pedidoPendente(1)
    await pagar(p.id)
    await jaEntregouAutomatico(p.id)

    const r = await reenviar(eventId, { pedido: p.code, email: 'certo@teste.invalido' })
    const corpo = await r.json()
    expect(r.status, corpo.statusMessage).toBe(200)
    expect(corpo.para).toBe('certo@teste.invalido')

    // o cadastro do comprador NÃO muda por conta própria
    const c = await q1<any>(`SELECT email FROM customers WHERE id = $1`, [customerId])
    expect(c.email, 'trocou o e-mail do cadastro do cliente em silêncio')
      .toBe('joao.envio@teste.invalido')

    const registro = await q1<any>(
      `SELECT after FROM audit_log WHERE entity_id = $1 AND action = 'reenvio_email'`, [p.id])
    expect(registro.after.trocouDestino,
      'mandou ingresso pago pra outro endereço sem marcar que trocou').toBe(true)
  }, 30_000)

  it('não reenvia pedido de OUTRO evento', async () => {
    if (semRota()) return
    const p = await pedidoPendente(1, 4500, outroEventoId)
    await pagar(p.id)
    // tira do caminho tudo que poderia recusar por outro motivo: o que tem
    // que barrar aqui é o recorte por evento, e mais nada
    await jaEntregouAutomatico(p.id)

    const r = await reenviar(eventId, { pedido: p.code })
    expect(r.status, 'reenviou o ingresso de um evento pedindo por outro').toBe(404)
  }, 30_000)

  it('não reenvia ingresso de pedido estornado', async () => {
    if (semRota()) return
    const p = await pedidoPendente(1)
    await pagar(p.id)
    await q(`UPDATE orders SET status = 'estornado', refunded_at = now() WHERE id = $1`, [p.id])

    const r = await reenviar(eventId, { pedido: p.code })
    const corpo = await r.json()
    expect(r.status, 'entregou ingresso de pedido estornado').toBe(409)
    expect(corpo.statusMessage, 'recusou sem dizer o porquê pro operador')
      .toMatch(/estornado/)
  }, 30_000)

  it('recusa e-mail torto antes de virar falha na fila', async () => {
    if (semRota()) return
    const p = await pedidoPendente(1)
    await pagar(p.id)
    await jaEntregouAutomatico(p.id)

    const r = await reenviar(eventId, { pedido: p.code, email: 'joao@teste' })
    expect(r.status).toBe(422)
    const n = await q1<any>(
      `SELECT count(*)::int AS n FROM email_sends WHERE order_id = $1 AND origin = 'reenvio'`,
      [p.id])
    expect(n.n, 'enfileirou um envio que nunca teria como chegar').toBe(0)
  }, 30_000)

  it('botão apertado duas vezes não manda dois e-mails', async () => {
    if (semRota()) return
    const p = await pedidoPendente(1)
    await pagar(p.id)
    await jaEntregouAutomatico(p.id)

    // um reenvio já a caminho (estacionado pra ninguém entregar no meio)
    const idPendente = await enfileirar({
      orgId, eventId, orderId: p.id, paraEmail: 'joao.envio@teste.invalido', origem: 'reenvio',
    })
    await q(`UPDATE email_sends SET available_at = now() + interval '1 hour' WHERE id = $1`,
      [idPendente])

    const r = await reenviar(eventId, { pedido: p.code })
    const corpo = await r.json()
    expect(r.status, 'dois cliques viraram dois e-mails na caixa do comprador').toBe(409)
    expect(corpo.statusMessage).toMatch(/a caminho/i)

    const n = await q1<any>(
      `SELECT count(*)::int AS n FROM email_sends WHERE order_id = $1`, [p.id])
    expect(n.n, 'o clique repetido virou uma segunda linha na fila').toBe(2)
  }, 30_000)

  /**
   * O caso acima é SEQUENCIAL: a linha pendente já existe quando a rota é
   * chamada. Ele fica verde mesmo se a rota olhar numa consulta e gravar na
   * seguinte, sem nada entre as duas — que era exatamente o que ela fazia.
   * Medido contra a rota sem trava: dois cliques ao mesmo tempo viraram DOIS
   * e-mails, 2 de 2 vezes; seis viraram quatro.
   *
   * Aqui a ordem é forçada na mão, como manda a casa: uma segunda conexão faz
   * o papel do primeiro clique — segura a linha do pedido, grava o envio dele
   * e só então solta.
   *
   * O que separa o certo do errado é ONDE o segundo clique lê a fila. Com a
   * trava, ele só lê depois de o primeiro ter gravado, e recusa. Sem ela, ele
   * lê antes ("não tem nada pendente"), fica preso só na hora de gravar — a
   * chave estrangeira de `email_sends.order_id` também espera a linha do
   * pedido — e, quando destrava, grava assim mesmo, com uma leitura velha na
   * mão. Cronometrar "ele esperou?" NÃO distingue os dois casos: os dois
   * esperam. Distinguir é olhar o que ele faz depois de esperar.
   */
  it('o segundo clique lê a fila DEPOIS da trava, não antes', async () => {
    if (semRota()) return
    const p = await pedidoPendente(1)
    await pagar(p.id)
    await jaEntregouAutomatico(p.id)

    // AQUECE a rota. Sem isto, rodando sozinho (`-t`), a primeira requisição
    // paga a recompilação do servidor de dev e o caso mede o compilador.
    await reenviar(eventId, { pedido: 'ZZE-AQUECE' })

    const c = await db().connect()
    try {
      await c.query('BEGIN')
      // O primeiro clique, travando o pedido enquanto decide.
      await c.query(`SELECT id FROM orders WHERE id = $1 FOR UPDATE`, [p.id])

      // O segundo clique chega agora, com o primeiro ainda decidindo.
      const emVoo = reenviar(eventId, { pedido: p.code })
        .then(async (r) => ({ status: r.status, corpo: await r.json() }))
      await new Promise((r) => setTimeout(r, 600))

      // O primeiro termina: grava o envio dele e solta a trava. Estacionado no
      // futuro pra varredura de fundo do servidor não entregar no meio.
      await c.query(
        `INSERT INTO email_sends (org_id, event_id, order_id, kind, origin, to_email,
                                  available_at)
         VALUES ($1,$2,$3,'confirmacao_pedido','reenvio',$4, now() + interval '1 hour')`,
        [orgId, eventId, p.id, 'joao.envio@teste.invalido'])
      await c.query('COMMIT')

      const r = await emVoo
      expect(r.status,
        'o segundo clique decidiu antes da trava, com leitura velha: gravou um ' +
        'SEGUNDO envio e o comprador recebe o ingresso duas vezes').toBe(409)
      expect(r.corpo?.statusMessage).toMatch(/a caminho/i)
    } finally {
      await c.query('ROLLBACK').catch(() => {})
      c.release()
    }

    const n = await q1<any>(
      `SELECT count(*)::int AS n FROM email_sends
        WHERE order_id = $1 AND origin = 'reenvio'`, [p.id])
    expect(n.n, 'dois cliques viraram dois e-mails na caixa do comprador').toBe(1)
  }, 30_000)

  /**
   * A fila entalada é o outro lado do mesmo botão. Se o envio pendente é
   * velho, recusar por "já tem um a caminho" tranca o operador pra sempre:
   * é justamente o e-mail preso que o cliente está reclamando que não chegou.
   */
  it('envio parado na fila é empurrado, não vira um segundo e-mail', async () => {
    if (semRota()) return
    const p = await pedidoPendente(1)
    await pagar(p.id)
    const automatico = await envioDoPedido(p.id)

    // a confirmação automática travada há meia hora (trabalhador fora do ar)
    await q(`UPDATE email_sends SET created_at = now() - interval '30 minutes',
                    available_at = now() + interval '1 hour' WHERE id = $1`, [automatico.id])

    const r = await reenviar(eventId, { pedido: p.code, email: 'outro@teste.invalido' })
    const corpo = await r.json()
    expect(r.status, `não desentalou a fila — ${corpo.statusMessage}`).toBe(200)
    expect(corpo.assumiuEnvioParado, 'criou uma segunda linha em vez de assumir a parada').toBe(true)
    expect(corpo.envio).toBe(automatico.id)

    const n = await q1<any>(
      `SELECT count(*)::int AS n FROM email_sends WHERE order_id = $1`, [p.id])
    expect(n.n, 'agora são dois e-mails pro mesmo pedido').toBe(1)

    const linha = await q1<any>(`SELECT * FROM email_sends WHERE id = $1`, [automatico.id])
    expect(linha.status).toBe('enviado')
    expect(linha.to_email, 'saiu para o endereço errado de novo').toBe('outro@teste.invalido')
  }, 30_000)

  it('pedido que não existe não vira 500 nem mensagem de banco', async () => {
    if (semRota()) return
    const r = await reenviar(eventId, { pedido: 'ZZE-NAOEXISTE' })
    const corpo = await r.json()
    expect(r.status).toBe(404)
    expect(corpo.statusMessage).toMatch(/Confira o código/i)
  }, 30_000)
})

/* ============================================ 7. o trabalhador */

describe('o trabalhador de fundo', () => {
  it('sobe uma vez só, por mais que peçam', () => {
    pararWorker()
    expect(garantirWorker(), 'não subiu').toBe(true)
    expect(garantirWorker(), 'subiu um segundo laço varrendo a mesma fila').toBe(false)
    pararWorker()
  })

  it('a reserva exportada é a que o teste de concorrência exercita', () => {
    // Se alguém trocar a reserva por SELECT + UPDATE, isto aqui cai junto —
    // e o caso das duas conexões acima deixa de provar o que promete.
    expect(SQL_RESERVA).toContain('FOR UPDATE SKIP LOCKED')
    expect(SQL_RESERVA).toMatch(/UPDATE email_sends SET[\s\S]*status = 'enviando'/)
  })
})

/* ======================= 8. o laço nasce no BOOT, não numa tela */

/**
 * O defeito que esta seção tranca não aparece em dev, não lança exceção e não
 * suja o console: o trabalhador da fila subia por efeito colateral de
 * `import`, e o empacotador do `npm run build` enfia esse `import` DENTRO do
 * pedaço da única rota que o usava — que é `lazy: true`. Medido no build
 * anterior:
 *
 *   nitro.mjs: { route: '/api/admin/evento/:id/reenviar', lazy: true }
 *   chunks/routes/api/admin/evento/_id/reenviar.post.mjs:597  garantirWorker();
 *
 * Em produção o laço só nascia se alguém abrisse a tela de reenvio. Ninguém
 * abre — a tela de reenvio é justamente pra quando o e-mail não chegou. O
 * comprador pagava e não recebia nada.
 *
 * Servidor de produção no ar por 67 s com linha madura na fila: `attempts=0`,
 * nenhum .eml em disco, stdout mudo. Depois do plugin, 13 s: `enviado`.
 */
const AQUI = dirname(fileURLToPath(import.meta.url))
const PLUGIN_DAS_FILAS = resolve(AQUI, '../plugins/00.filas.ts')

/**
 * Os módulos que o Node carrega SEM ninguém pedir, partindo da entrada do
 * build: `import ... from` e `export ... from`, recursivamente.
 *
 * O `() => import('...')` que o Nitro usa pra rota preguiçosa fica de fora de
 * propósito — é exatamente ele que não roda enquanto ninguém abre a tela, e
 * incluí-lo faria este teste ficar verde justamente no defeito que ele existe
 * pra pegar.
 */
async function carregadosNoBoot(entrada: string): Promise<Map<string, string>> {
  const vistos = new Map<string, string>()
  const pendentes = [entrada]
  while (pendentes.length) {
    const arquivo = pendentes.pop()!
    if (vistos.has(arquivo)) continue
    let fonte: string
    try { fonte = await readFile(arquivo, 'utf8') } catch { continue }
    vistos.set(arquivo, fonte)
    // O `(?:^|;)` é porque o empacotador cola várias declarações na mesma
    // linha; `>` antes de `import` (o `() => import(...)`) nunca casa.
    const estaticos = [
      /(?:^|;)\s*(?:import|export)\b[^'"\n]*?\bfrom\s*['"]([^'"]+)['"]/gm,
      /(?:^|;)\s*import\s*['"]([^'"]+)['"]/gm,
    ]
    for (const regra of estaticos) {
      for (const m of fonte.matchAll(regra)) {
        if (m[1].startsWith('.')) pendentes.push(resolve(dirname(arquivo), m[1]))
      }
    }
  }
  return vistos
}

/**
 * A fonte SEM os comentários.
 *
 * Existe por um vermelho que não veio. A primeira versão do caso abaixo
 * afirmava `expect(plugin).toMatch(/garantirWorker\(\)/)` — e continuou VERDE
 * com a chamada arrancada do plugin, porque o próprio comentário do arquivo
 * cita `garantirWorker()` ao explicar o defeito. O teste estava medindo a
 * documentação. Só a mutação mostrou; lendo, ele parecia certo.
 *
 * Varre caractere a caractere porque regex não sabe onde uma string acaba: o
 * `//` de `'http://localhost:3100'` viraria "o resto da linha é comentário" e
 * apagaria código de verdade da comparação.
 */
function semComentarios(fonte: string): string {
  let fora = ''
  let i = 0
  let aspas: string | null = null
  while (i < fonte.length) {
    const c = fonte[i]
    const d = fonte[i + 1]
    if (aspas) {
      fora += c
      if (c === '\\') { fora += d ?? ''; i += 2; continue }
      if (c === aspas) aspas = null
      i++
      continue
    }
    if (c === '"' || c === "'" || c === '`') { aspas = c; fora += c; i++; continue }
    if (c === '/' && d === '/') { while (i < fonte.length && fonte[i] !== '\n') i++; continue }
    if (c === '/' && d === '*') {
      i += 2
      while (i < fonte.length && !(fonte[i] === '*' && fonte[i + 1] === '/')) i++
      i += 2
      continue
    }
    fora += c
    i++
  }
  return fora
}

describe('a fila sobe no boot do processo', () => {
  it('quem liga o laço é o plugin de servidor, e o módulo não liga nada sozinho', async () => {
    const plugin = semComentarios(await readFile(PLUGIN_DAS_FILAS, 'utf8'))
    const modulo = semComentarios(await readFile(resolve(AQUI, 'envio.ts'), 'utf8'))

    // Autoconferência do cortador: se ele comesse código junto com o
    // comentário, o `not.toMatch` lá embaixo ficaria verde por arquivo vazio.
    expect(plugin, 'o cortador de comentários comeu o plugin inteiro')
      .toMatch(/defineNitroPlugin/)
    expect(modulo, 'o cortador de comentários comeu o módulo inteiro')
      .toMatch(/export async function processarFila/)

    expect(plugin, 'o plugin não liga a fila de e-mail — em produção ela não anda')
      .toMatch(/^\s*garantirWorker\(\)/m)
    expect(plugin, 'o plugin não liga a fila de estorno — o dinheiro não volta sozinho')
      .toMatch(/^\s*garantirWorkerDeEstorno\(\)/m)

    // O contrário disto é o defeito: chamada solta no fim do módulo, que só
    // roda se alguém importar o módulo — e em produção "alguém" é uma rota
    // que ninguém abre.
    //
    // O `;?` não é enfeite. A primeira versão exigia que a linha ACABASSE no
    // `()`, e por isso ficava VERDE com `garantirWorker();` no fim do arquivo
    // — que é o mesmo defeito, com o ponto e vírgula que um formatador ou
    // alguém vindo de outro projeto escreve sem pensar. Medido: mutação
    // aplicada, caso verde, fila morta no build do mesmo jeito.
    const CHAMADA_SOLTA = /^[ \t]*garantirWorker\(\)[ \t]*;?[ \t]*$/m

    // Autoconferência do que este caso mede: as DUAS grafias são o defeito, e
    // a declaração da função não é. Sem isto, apertar a expressão acima até
    // ela não casar com nada deixaria o caso verde e vazio.
    expect(CHAMADA_SOLTA.test('garantirWorker()')).toBe(true)
    expect(CHAMADA_SOLTA.test('garantirWorker();')).toBe(true)
    expect(CHAMADA_SOLTA.test('export function garantirWorker(): boolean {')).toBe(false)

    expect(modulo, 'a fila voltou a subir por efeito colateral de import: em produção '
      + 'isso só acontece se alguém abrir a rota que importa este arquivo')
      .not.toMatch(CHAMADA_SOLTA)
  })

  it('no BUILD, o laço é alcançável a partir da entrada sem abrir rota nenhuma', async () => {
    const entrada = resolve(AQUI, '../../.output/server/index.mjs')
    const carregados = await carregadosNoBoot(entrada)

    // Sem build, PULA — igual ao servidor fora do ar. O teste que falha por
    // falta de artefato treina todo mundo a ignorar o vermelho.
    if (carregados.size <= 1) {
      console.warn('  (pulado: sem .output — rode npm run build)')
      return
    }

    // Autoconferência: se a varredura acima estivesse seguindo import
    // preguiçoso, ela alcançaria os pedaços de rota — e aí o caso ficaria
    // verde sem provar nada.
    const rotas = [...carregados.keys()].filter((a) => a.includes('/chunks/routes/api/'))
    expect(rotas, 'a varredura seguiu import preguiçoso de rota; ela deixaria de provar '
      + `que o laço sobe sozinho: ${rotas[0]}`).toHaveLength(0)

    // CHAMADA, não declaração.
    //
    // A primeira versão deste caso procurava `garantirWorker()` solto — e
    // ficava VERDE num build com a correção arrancada, porque o empacotador
    // deixa `function garantirWorker() {` no pedaço compartilhado mesmo
    // quando ninguém chama. Medido: nitro.mjs:5456 tinha a declaração,
    // nenhuma linha chamava, e a fila estava morta do mesmo jeito. O que
    // separa os dois é o que vem depois do `()`: chamada termina em `;` (ou
    // `,` numa sequência), declaração abre `{`.
    const CHAMA = /(?<!function\s)garantirWorker\(\)\s*[;,]/

    // Autoconferência: a distinção acima é a única coisa que este caso mede.
    expect(CHAMA.test('function garantirWorker() {\n  return 1\n}'),
      'o teste confunde declarar com chamar — foi assim que ele ficou verde '
      + 'num build com a fila morta').toBe(false)
    expect(CHAMA.test('  garantirWorker();')).toBe(true)

    const comLaco = [...carregados].filter(([, fonte]) => CHAMA.test(fonte))
    expect(comLaco.length, 'no build, nenhum módulo carregado no boot CHAMA '
      + 'garantirWorker(): o trabalhador só nasce se alguém abrir a tela de reenvio, '
      + 'e ninguém abre — o comprador paga e não recebe o ingresso').toBeGreaterThan(0)

    // O estorno também. Ele sobe hoje por efeito colateral do import de
    // `cancelamento.ts` — o mesmo mecanismo que falhou no envio, e que falha
    // de novo no dia em que alguém tirar o import. O plugin chama na mão.
    const comEstorno = [...carregados].filter(([, fonte]) =>
      /(?<!function\s)garantirWorkerDeEstorno\(\)\s*[;,]/.test(fonte))
    expect(comEstorno.length, 'no build, ninguém chama garantirWorkerDeEstorno() no boot: '
      + 'cancelamento pedido vira dinheiro que não volta').toBeGreaterThan(0)
  })
})

/* ============================= 9. a fila visível */

describe('o veredito da fila', () => {
  const vivo = { status: 'ligado' as const, intervaloMs: 15_000 }

  it('fila VAZIA com o trabalhador morto não passa por "está tudo bem"', () => {
    // Este é o caso que nenhuma contagem pega: zero na fila é a mesma linha
    // no banco com o trabalhador vivo e com ele morto — até a primeira venda.
    const v = vereditoDaFila({ ...vivo, bateuHaSegundos: 600, maduros: 0 })
    expect(v.parado, 'fila vazia escondeu o trabalhador parado há 10 minutos').toBe(true)
    expect(v.frase).toMatch(/não dá sinal/)
  })

  it('fila que nunca carimbou é o trabalhador que NÃO SUBIU, e diz isso', () => {
    const v = vereditoDaFila({ status: null, bateuHaSegundos: null, maduros: 0 })
    expect(v.parado).toBe(true)
    expect(v.frase, 'não subiu e subiu-e-parou pedem respostas diferentes')
      .toMatch(/nunca deu sinal de vida/)
  })

  it('desligado de propósito diz "desligado", não "morreu"', () => {
    const v = vereditoDaFila({
      status: 'desligado', bateuHaSegundos: 2, intervaloMs: 15_000, maduros: 0,
    })
    expect(v.parado).toBe(true)
    expect(v.frase).toMatch(/DESLIGADA/)
  })

  it('uma batida atrasada não é alarme; três são', () => {
    // Alarme que dispara com uma varredura lenta (SMTP demorando) é alarme
    // que o operador aprende a ignorar — e aí não serve no dia de verdade.
    expect(vereditoDaFila({ ...vivo, bateuHaSegundos: 20, maduros: 0 }).parado).toBe(false)
    expect(vereditoDaFila({ ...vivo, bateuHaSegundos: 50, maduros: 0 }).parado).toBe(true)
  })

  it('fila que só registra o boot não é acusada de silêncio', () => {
    // A fila de estorno não carimba varredura: o laço dela mora em
    // `utils/cancelamento.ts`, que não é arquivo desta trilha. O "bateu há"
    // dela é a IDADE DO PROCESSO — acusar por isso condenaria todo servidor
    // que passou de 45 s no ar, com a fila trabalhando. Alarme falso diário é
    // como uma tela de saúde para de ser lida.
    const sinal = { status: 'ligado' as const, intervaloMs: 15_000, maduros: 0 }
    const so = vereditoDaFila({ ...sinal, bateuHaSegundos: 3600, carimba: false })
    expect(so.parado, 'acusou de morta uma fila que está trabalhando').toBe(false)
    expect(so.frase, 'a tela disse "andando" de uma fila que não prova que anda')
      .toMatch(/não carimba varredura/)

    // O MESMO sinal, numa fila que carimba, é fila morta. A diferença é só a
    // coluna `beats` — se ela não mudar nada, a distinção não existe.
    expect(vereditoDaFila({ ...sinal, bateuHaSegundos: 3600 }).parado).toBe(true)
  })

  it('fila vazia porque DESISTIU não passa por fila vazia porque entregou', () => {
    // O caso que a contagem de "o que está na fila" não pega de jeito nenhum:
    // `status = 'falhou'` é fim de linha (a reserva não pega a linha nem por
    // id, nenhum laço tenta de novo), então a fila fica VAZIA e o trabalhador
    // fica batendo o ponto em dia — com gente que pagou e nunca vai receber.
    // Medido no build antes deste ramo existir: dois e-mails perdidos de vez
    // e a resposta era `ok: true`, "Andando, e sem nada esperando".
    const v = vereditoDaFila({ ...vivo, bateuHaSegundos: 2, maduros: 0, perdidos: 2 })
    expect(v.parado, 'a fila vazia por desistência passou por fila em dia — '
      + 'o alarme externo lê `ok` e vai dormir com gente sem ingresso').toBe(true)
    expect(v.frase, 'disse que parou e não disse que ninguém tenta de novo sozinho')
      .toMatch(/ninguém tenta de novo/)
    expect(v.frase, 'contou LINHA de fila e chamou de pedido no plural errado')
      .toMatch(/2 pedidos pararam de vez/)

    // Singular, porque a frase é lida por quem vai procurar o cliente.
    expect(vereditoDaFila({ ...vivo, bateuHaSegundos: 2, maduros: 0, perdidos: 1 }).frase)
      .toMatch(/1 pedido parou de vez/)

    // E o contrário: sem desistência, a mesma fila vazia é fila em dia.
    expect(vereditoDaFila({ ...vivo, bateuHaSegundos: 2, maduros: 0, perdidos: 0 }).parado)
      .toBe(false)
  })

  it('atraso e desistência cabem na mesma frase — eles pedem coisas diferentes', () => {
    // Um sai sozinho quando destravar; o outro só sai se alguém mandar de
    // novo. Calar o segundo porque o primeiro chegou antes é como a resposta
    // passava a se contradizer: veredito de um lado, custo do outro.
    const v = vereditoDaFila({
      ...vivo, bateuHaSegundos: 2, maduros: 4, maisVelhoSegundos: 600, perdidos: 3,
    })
    expect(v.parado).toBe(true)
    expect(v.frase, 'o atraso engoliu a desistência').toMatch(/3 pedidos pararam de vez/)
    expect(v.frase, 'a desistência engoliu o atraso').toMatch(/4 item\(ns\) já podiam ter saído/)
  })

  it('mesmo sem carimbo, item parado continua sendo denúncia', () => {
    // O que sobra pra julgar uma fila muda é o resultado dela.
    const v = vereditoDaFila({
      status: 'ligado', intervaloMs: 15_000, carimba: false,
      bateuHaSegundos: 3600, maduros: 3, maisVelhoSegundos: 900,
    })
    expect(v.parado, 'sem carimbo, 3 estornos presos há 15 min passaram batidos').toBe(true)
    expect(v.frase, 'sem carimbo não dá pra afirmar que o trabalhador está vivo')
      .not.toMatch(/trabalhador está vivo/)
  })

  it('trabalhador vivo e engasgado também é fila parada', () => {
    const v = vereditoDaFila({
      ...vivo, bateuHaSegundos: 3, maduros: 7, maisVelhoSegundos: 900,
    })
    expect(v.parado, 'o carimbo em dia escondeu 7 ingressos que não saem').toBe(true)
    expect(v.frase).toMatch(/7 item/)
  })

  it('fila andando é fila andando', () => {
    expect(vereditoDaFila({ ...vivo, bateuHaSegundos: 3, maduros: 0 }).parado).toBe(false)
    expect(vereditoDaFila({
      ...vivo, bateuHaSegundos: 3, maduros: 2, maisVelhoSegundos: 5,
    }).parado, 'acusou entalo numa fila que acabou de receber trabalho').toBe(false)
  })

  it('o tempo sai em português, não em segundos crus', () => {
    expect(emPortugues(45)).toBe('45s')
    expect(emPortugues(600)).toBe('10 min')
    expect(emPortugues(7200)).toBe('2h')
    expect(emPortugues(7800)).toBe('2h 10 min')
  })
})

describe('a batida do ponto', () => {
  const NOME = `zz-fila-teste-${randomUUID().slice(0, 8)}`

  // A limpeza mora AQUI, não no fim do último caso. Enquanto ela era a última
  // linha de um `it`, todo caso que falhava (e no meio de uma mutação eles
  // falham de propósito) deixava a linha no banco — encontrei 6 sobrando,
  // de rodadas antigas. Lixo de teste no banco de verdade é o tipo de coisa
  // que ninguém liga de deixar e todo mundo xinga de achar.
  afterAll(async () => {
    // A tabela FÍSICA: `worker_heartbeats` virou visão na 026 e visão com
    // agregação não aceita DELETE. Apagar pelo nome certo é o que garante que
    // a limpeza acontece de verdade em vez de estourar no `afterAll` e deixar
    // o lixo pra próxima rodada achar.
    await q(`DELETE FROM worker_heartbeat_instances WHERE worker LIKE $1`, [`${NOME}%`])
  })

  /** o que a TELA DE SAÚDE lê sobre a fila — uma linha por fila, não por processo */
  const comoATelaVe = (worker: string) => q1<any>(
    `SELECT status, instance, beats, booted_at, done, failed, last_error, worked_at,
            instances, instances_on, instances_live, instances_silent, fleet,
            EXTRACT(epoch FROM now() - beat_at)::int AS bateu_ha
       FROM worker_heartbeats WHERE worker = $1`, [worker])

  it('acumula o que já saiu desde o boot em vez de sobrescrever', async () => {
    await anunciarWorker(NOME, true, 15_000)
    await baterPonto(NOME, { feitos: 2, falhos: 1, erro: 'caixa cheia' })
    await baterPonto(NOME, { feitos: 3, falhos: 0 })

    const l = await comoATelaVe(NOME)
    expect(l, 'a batida não chegou ao banco — a tela de saúde fica cega').toBeTruthy()
    // Sobrescrever responderia "1" pra quem pergunta quanto já saiu hoje.
    expect(Number(l.done), 'a batida sobrescreveu em vez de somar').toBe(5)
    expect(Number(l.failed)).toBe(1)
    expect(l.last_error, 'a varredura seguinte apagou o erro que explica').toBe('caixa cheia')
  })

  it('varredura vazia bate o ponto, mas NÃO conta como trabalho', async () => {
    const vazio = `${NOME}-vazio`
    await baterPonto(vazio, {})
    const l = await comoATelaVe(vazio)
    expect(l.bateu_ha, 'trabalhador vivo numa fila vazia ficou parecendo morto')
      .toBeLessThan(60)
    expect(l.worked_at, '"não tinha nada pra fazer" virou "trabalhou agora"').toBeNull()
  })

  it('a batida não mistura o processo de um com a hora de subida de outro', async () => {
    // "Quem subiu" e "quando subiu" são o MESMO fato, escrito junto no boot.
    // Quando a batida reescrevia o `instance` da linha alheia, ela virava meio
    // de um processo e meio de outro — visto na tela: `subiuEm 06:29:50` com
    // `instancia :21600`, e o 21600 não tinha subido àquela hora. Quem está
    // investigando "o ingresso não saiu às 21h" vai ler o log do processo
    // errado por causa disso.
    //
    // Com a chave por `(worker, instance)` isso deixou de depender de cuidado
    // no SQL: a batida deste processo NÃO ALCANÇA a linha do outro. O caso
    // continua aqui porque o que ele protege é o par, não o `UPDATE`.
    const par = `${NOME}-par`
    await q(`INSERT INTO worker_heartbeat_instances
               (worker, status, instance, beat_ms, beats, booted_at, beat_at)
             VALUES ($1,'ligado','outra-maquina:1',15000,true,
                     timestamptz '2020-01-01 00:00Z', timestamptz '2020-01-01 00:00Z')`,
      [par])

    await baterPonto(par, { feitos: 1 })

    const dela = await q1<any>(
      `SELECT booted_at, done FROM worker_heartbeat_instances
        WHERE worker = $1 AND instance = 'outra-maquina:1'`, [par])
    expect(new Date(dela.booted_at).getUTCFullYear(),
      'a batida de um processo reescreveu a hora de subida do outro').toBe(2020)
    expect(Number(dela.done),
      'a batida de um processo foi somada no contador do outro').toBe(0)

    const minha = await q1<any>(
      `SELECT booted_at FROM worker_heartbeat_instances
        WHERE worker = $1 AND instance <> 'outra-maquina:1'`, [par])
    expect(minha, 'a batida não abriu linha própria: ela escreveu na de outro processo')
      .toBeTruthy()
    expect(new Date(minha.booted_at).getUTCFullYear()).toBeGreaterThan(2020)
  })

  it('quem não carimba varredura fica marcado como tal no banco', async () => {
    // Sem esta coluna a tela trata as duas filas igual e acusa de silêncio a
    // que nunca prometeu falar. O padrão é `true` de propósito: fila nova que
    // esquecer de dizer é cobrada, não perdoada.
    const mudo = `${NOME}-mudo`
    await anunciarWorker(mudo, true, 15_000, false)
    const l = await comoATelaVe(mudo)
    expect(l?.beats, 'a fila muda entrou no banco como se carimbasse').toBe(false)

    const l2 = await comoATelaVe(NOME)
    expect(l2?.beats, 'a fila que carimba entrou marcada como muda').toBe(true)
  })

  /* ------------------------------------------------- uma linha por processo */

  /** Sobe uma instância de mentira, com a idade que o caso precisa. */
  const instanciaFalsa = (
    worker: string, instance: string,
    o: { subiuHaMin: number; bateuHaMin: number; status?: string; carimba?: boolean },
  ) => q(
    `INSERT INTO worker_heartbeat_instances
       (worker, status, instance, beat_ms, beats, booted_at, beat_at)
     VALUES ($1, $2, $3, 15000, $4,
             now() - make_interval(mins => $5::int),
             now() - make_interval(mins => $6::int))`,
    [worker, o.status ?? 'ligado', instance, o.carimba ?? true, o.subiuHaMin, o.bateuHaMin])

  it('instância morta não se esconde atrás da instância viva', async () => {
    // ESTE é o defeito da 024, medido antes do conserto: com
    // `PRIMARY KEY (worker)`, as duas instâncias escreviam a MESMA linha e a
    // que batia por último apagava o rastro da outra —
    //   count(*) = 1, instance = maquinaB:222, bateu_ha = 0
    // com maquinaA parada havia dez minutos. `vereditoDaFila` lia isso e
    // respondia "Andando" com metade da frota fora do ar, que é o cenário
    // exato pra que a tabela foi criada.
    const frota = `${NOME}-frota`
    await instanciaFalsa(frota, 'maquinaA:111', { subiuHaMin: 20, bateuHaMin: 10 })
    await instanciaFalsa(frota, 'maquinaB:222', { subiuHaMin: 5, bateuHaMin: 0 })

    const fisicas = await q<any>(
      `SELECT instance FROM worker_heartbeat_instances WHERE worker = $1`, [frota])
    expect(fisicas.length, 'as duas instâncias voltaram a disputar uma linha só').toBe(2)

    const l = await comoATelaVe(frota)
    expect(Number(l.instances), 'a leitura não sabe quantas instâncias existem').toBe(2)
    expect(Number(l.instances_live), 'a leitura não sabe quantas estão vivas').toBe(1)
    expect(Number(l.instances_silent), 'a instância calada não foi contada').toBe(1)
    // A medida que a rota de saúde usa pra decidir "parado". Com a chave
    // velha isto era 0 — o carimbo da viva cobrindo a morta.
    expect(Number(l.bateu_ha),
      'a instância viva emprestou o carimbo dela pra morta: a tela diz "Andando" '
      + 'com metade da frota parada').toBeGreaterThan(500)
    expect(l.instance, 'a tela não sabe QUAL instância parou').toContain('maquinaA:111')

    // E o veredito, que é a frase que o operador lê, acusa.
    expect(vereditoDaFila({
      status: l.status, bateuHaSegundos: Number(l.bateu_ha),
      intervaloMs: 15_000, carimba: l.beats, maduros: 0,
    }).parado, 'o veredito passou "andando" com uma instância morta').toBe(true)

    // Cada uma com o seu tempo de silêncio — é o que a tela precisa pra dizer
    // onde ir olhar, e o que a linha única não tinha como guardar.
    const porInstancia = Object.fromEntries(
      (l.fleet as any[]).map((i) => [i.instance, i.silent_seconds]))
    expect(porInstancia['maquinaA:111']).toBeGreaterThan(500)
    expect(porInstancia['maquinaB:222']).toBeLessThan(60)
  })

  it('reinício na MESMA máquina não vira instância morta', async () => {
    // O lixo que a chave por processo cria: todo deploy e todo `npm run dev`
    // deixa a linha do pid anterior calada pra sempre. Contar isso como morte
    // acende vermelho depois de toda subida — e alarme que mente todo dia é
    // como se ensina o operador a não olhar mais a tela.
    const deploy = `${NOME}-deploy`
    await instanciaFalsa(deploy, 'maquinaA:111', { subiuHaMin: 180, bateuHaMin: 120 })
    await instanciaFalsa(deploy, 'maquinaA:999', { subiuHaMin: 110, bateuHaMin: 0 })

    const l = await comoATelaVe(deploy)
    expect(Number(l.instances),
      'o pid anterior da mesma máquina entrou na frota como se fosse outro servidor').toBe(1)
    expect(Number(l.instances_silent), 'todo deploy passou a acender alarme').toBe(0)
    expect(Number(l.bateu_ha)).toBeLessThan(60)
    expect(l.instance, 'a frota ficou com o processo que já saiu').toBe('maquinaA:999')
  })

  it('a vida anterior da própria máquina sai da frota no boot', async () => {
    // A limpeza é do `anunciarWorker`: ele apaga a linha calada da MESMA
    // máquina antes de começar. Sem ela a tabela cresce um pid por reinício e,
    // num banco de desenvolvimento, chega a centenas.
    const boot = `${NOME}-boot`
    const minhaMaquina = instanciaDoProcesso().replace(/:[0-9]+$/, '')
    await instanciaFalsa(boot, `${minhaMaquina}:404`, { subiuHaMin: 60, bateuHaMin: 30 })
    await instanciaFalsa(boot, 'outra-maquina:404', { subiuHaMin: 60, bateuHaMin: 30 })

    await anunciarWorker(boot, true, 15_000)

    const vivas = await q<any>(
      `SELECT instance FROM worker_heartbeat_instances WHERE worker = $1 ORDER BY instance`,
      [boot])
    const nomes = vivas.map((v) => v.instance)
    expect(nomes, 'o pid velho da minha própria máquina ficou acusando pra sempre')
      .not.toContain(`${minhaMaquina}:404`)
    expect(nomes, 'o boot daqui apagou a instância de OUTRA máquina — que calada é '
      + 'morte de verdade e tem que continuar aparecendo').toContain('outra-maquina:404')
    expect(nomes).toContain(instanciaDoProcesso())
  })

  it('saída limpa tira o processo da frota; queda seca, não', async () => {
    const saida = `${NOME}-saida`
    await anunciarWorker(saida, true, 15_000)
    await instanciaFalsa(saida, 'caiu-de-vez:7', { subiuHaMin: 60, bateuHaMin: 30 })

    await encerrarPonto(saida)

    const nomes = (await q<any>(
      `SELECT instance FROM worker_heartbeat_instances WHERE worker = $1`, [saida]))
      .map((v) => v.instance)
    expect(nomes, 'o processo que saiu de propósito continuou acusando na tela')
      .not.toContain(instanciaDoProcesso())
    expect(nomes, 'a instância que CAIU sumiu junto — é ela que alguém precisa ir ver')
      .toContain('caiu-de-vez:7')
  })

  it('a varredura que ainda estava em voo não ressuscita quem já bateu a saída', async () => {
    // O gancho `close` do Nitro NÃO para o laço: ele só apaga a linha. Uma
    // varredura que começou ANTES do SIGTERM continua rodando (SMTP leva
    // segundos) e termina chamando `baterPonto` — que é um
    // `INSERT ... ON CONFLICT` e, portanto, RECRIA a linha que o
    // `encerrarPonto` acabou de apagar.
    //
    // A linha que volta nasce com os PADRÕES da coluna: `status = 'ligado'`,
    // `beats = true`, `booted_at = now()`. Quarenta e cinco segundos depois o
    // processo já morreu e a tela de saúde acusa uma instância parada que não
    // existe mais. Em Docker, o contêiner novo tem outro hostname, então a
    // limpeza de mesma-máquina do `anunciarWorker` nunca alcança esse
    // fantasma: ele fica no painel PARA SEMPRE, um por deploy que pegou uma
    // varredura em voo.
    //
    // É o alarme falso diário que a 026 foi escrita pra evitar, entrando pela
    // porta dos fundos — e alarme que mente todo dia é como se ensina o
    // operador a não olhar mais a tela no dia em que ela está certa.
    const voo = `${NOME}-voo`
    await anunciarWorker(voo, true, 15_000)
    await encerrarPonto(voo)

    // a varredura em voo termina AGORA, depois da saída já registrada
    await baterPonto(voo, { feitos: 1 })

    const nomes = (await q<any>(
      `SELECT instance FROM worker_heartbeat_instances WHERE worker = $1`, [voo]))
      .map((v) => v.instance)
    expect(nomes, 'a varredura em voo recriou a linha do processo que já saiu: '
      + 'a tela ganha uma instância morta a cada deploy, e ninguém consegue apagá-la')
      .not.toContain(instanciaDoProcesso())
  })

  it('e quem sobe de novo volta a carimbar — o silêncio é da saída, não do processo',
    async () => {
      // A trava de cima não pode virar mordaça: um processo que anuncia de
      // novo (o `close` do dev que recarrega sem trocar de pid, um laço
      // religado na mão) está de volta ao trabalho e o painel precisa vê-lo.
      // Sem este caso, a forma mais fácil de passar no de cima seria calar o
      // `baterPonto` para sempre — e aí a fila viva ficaria invisível, que é
      // um estrago maior que o fantasma.
      const volta = `${NOME}-volta`
      await anunciarWorker(volta, true, 15_000)
      await encerrarPonto(volta)
      await anunciarWorker(volta, true, 15_000)
      await baterPonto(volta, { feitos: 2 })

      const l = await q1<any>(
        `SELECT done, EXTRACT(epoch FROM now() - beat_at)::int AS bateu_ha
           FROM worker_heartbeat_instances WHERE worker = $1 AND instance = $2`,
        [volta, instanciaDoProcesso()])
      expect(l, 'o processo voltou ao ar e o painel continuou sem enxergá-lo').toBeTruthy()
      expect(Number(l.done), 'quem voltou a trabalhar continuou mudo no painel').toBe(2)
      expect(Number(l.bateu_ha)).toBeLessThan(60)
    })

  it('instância desligada de propósito não é instância muda', async () => {
    // `DT_ENVIO_WORKER=off` numa máquina que só serve tela é estado legítimo.
    // Contar o silêncio dela como falha é o alarme falso de novo, e desta vez
    // um que ninguém consegue resolver.
    const off = `${NOME}-off`
    await instanciaFalsa(off, 'soTela:1',
      { subiuHaMin: 180, bateuHaMin: 180, status: 'desligado' })
    await instanciaFalsa(off, 'trabalha:2', { subiuHaMin: 180, bateuHaMin: 0 })

    const l = await comoATelaVe(off)
    expect(l.status, 'uma máquina desligada apagou a fila inteira da tela').toBe('ligado')
    expect(Number(l.instances_silent), 'a máquina desligada de propósito virou alarme').toBe(0)
    expect(Number(l.bateu_ha), 'o silêncio legítimo virou o silêncio da fila')
      .toBeLessThan(60)
  })

  it('fila que não carimba varredura não é acusada de silêncio nem com duas instâncias',
    async () => {
      // A fila de estorno registra o boot e nunca mais fala. Com duas
      // instâncias, as duas ficam caladas pra sempre — e sem esta regra a tela
      // acusaria as duas de morte 45 s depois de todo boot, com as duas
      // trabalhando.
      const muda = `${NOME}-muda`
      await instanciaFalsa(muda, 'maquinaA:1',
        { subiuHaMin: 180, bateuHaMin: 180, carimba: false })
      await instanciaFalsa(muda, 'maquinaB:2',
        { subiuHaMin: 120, bateuHaMin: 120, carimba: false })

      const l = await comoATelaVe(muda)
      expect(Number(l.instances)).toBe(2)
      expect(Number(l.instances_silent),
        'a fila que nunca prometeu carimbar foi acusada de não carimbar').toBe(0)
      expect(vereditoDaFila({
        status: l.status, bateuHaSegundos: Number(l.bateu_ha),
        intervaloMs: 15_000, carimba: l.beats, maduros: 0,
      }).parado, 'o veredito acusou uma fila que está trabalhando').toBe(false)
    })

  it('com uma instância só, a leitura continua exatamente host:pid', async () => {
    // A rota de saúde mostra este campo como "instância", e ela não é minha
    // pra mexer. Enfeitar o texto quando só existe um processo — que é o caso
    // de produção hoje — mudaria a tela sem que ninguém tenha pedido.
    const so = `${NOME}-sozinha`
    await anunciarWorker(so, true, 15_000)
    const l = await comoATelaVe(so)
    expect(l.instance).toBe(instanciaDoProcesso())
    expect(Number(l.instances)).toBe(1)
  })
})

describe('GET /api/admin/filas', () => {
  it('conta o que está parado e o que falhou, dentro da organização', async () => {
    if (semRota()) return

    // AQUECE a rota. O servidor de dev recompila a cada arquivo salvo, e a
    // primeira requisição depois disso paga a recompilação inteira — medido
    // em mais de 30 s com várias rodadas mexendo no mesmo projeto. Sem o
    // aquecimento, o caso mede o compilador e culpa a rota.
    await comSessao('/api/admin/filas').catch(() => null)

    // Estaciona TUDO desta organização: com linha madura, o trabalhador do
    // servidor de dev entrega no meio da medição e a diferença mente.
    //
    // `orgId` é a organização deste arquivo, criada no `beforeAll` e apagada
    // inteira no `afterAll` — estacionar aqui não alcança e-mail de nenhuma
    // outra trilha. Se um dia este caso passar a mexer na organização
    // semeada, o estacionamento vira sabotagem silenciosa do arquivo alheio,
    // e o vermelho nasce lá.
    await q(`UPDATE email_sends SET available_at = now() + interval '2 hours'
              WHERE org_id = $1 AND status = 'na_fila'`, [orgId])

    const antes = await comSessao('/api/admin/filas').then((r) => r.json())
    const daFila = (c: any) => c.filas.find((f: any) => f.nome === FILA_DE_ENVIO)
    expect(daFila(antes), 'a rota não fala da fila de e-mail').toBeTruthy()

    const p = await pedidoPendente(1)
    await pagar(p.id)                                   // +1 na fila (automático)

    // As duas linhas nascem JÁ estacionadas, num INSERT só. Criar madura e
    // estacionar na instrução seguinte abre uma janela em que o trabalhador
    // do servidor de dev entrega a linha, e o caso falha apontando pra rota,
    // que não tem culpa nenhuma.
    await q(`INSERT INTO email_sends (org_id, event_id, order_id, kind, origin, to_email,
                                      status, available_at)
             VALUES ($1,$2,$3,'confirmacao_pedido','reenvio',$4,'na_fila',
                     now() + interval '2 hours')`,      // +1 na fila
      [orgId, eventId, p.id, 'joao.envio@teste.invalido'])
    await q(`INSERT INTO email_sends (org_id, event_id, order_id, kind, origin, to_email,
                                      status, last_error)
             VALUES ($1,$2,$3,'confirmacao_pedido','reenvio',$4,'falhou',
                     'domínio zz não existe')`,         // +1 falhou
      [orgId, eventId, p.id, 'joao.envio@teste.invalido'])

    const depois = await comSessao('/api/admin/filas').then((r) => r.json())
    expect(daFila(depois).naFila - daFila(antes).naFila,
      'a tela não conta o que está esperando — fila invisível é fila que só se '
      + 'descobre quando o cliente liga').toBe(2)
    expect(daFila(depois).falharam - daFila(antes).falharam,
      'a tela não conta o que falhou de vez').toBe(1)
    expect(daFila(depois).ultimoErro,
      'contou a falha e escondeu o motivo dela').toContain('domínio zz não existe')
    expect(daFila(depois).custo,
      'disse o número e não disse o que ele custa em gente').toMatch(/sem o e-mail/)

    // A fila de estorno também é uma fila, e também não tinha tela.
    expect(depois.filas.map((f: any) => f.nome)).toContain('estorno')
  }, 60_000)

  it('diz há quanto tempo o trabalhador não varre — a pergunta que a contagem não responde',
    async () => {
      if (semRota()) return
      // Este caso bate o ponto na fila DE VERDADE, e desde a 026 cada processo
      // tem a SUA linha: a batida daqui cria uma instância `envio` com o pid
      // do vitest, que morre no fim da rodada e nunca mais carimba. Sem o
      // `encerrarPonto` do `finally`, cada `npx vitest run` deixava um
      // fantasma no banco — e 45 s depois a tela de saúde acusava a fila de
      // e-mail de parada, pra sempre, com o trabalhador do servidor de dev
      // trabalhando ao lado. Quem bate ponto tem que bater a saída também.
      try {
        await baterPonto(FILA_DE_ENVIO, {})

        const r = await comSessao('/api/admin/filas').then((x) => x.json())
        const envio = r.filas.find((f: any) => f.nome === FILA_DE_ENVIO)

        expect(envio.trabalhador,
          'a tela não sabe dizer se o trabalhador está vivo: fila vazia com laço morto '
          + 'fica idêntica a fila vazia com laço vivo').toBeTruthy()
        expect(envio.trabalhador.bateuHaSegundos).toBeLessThan(120)
        expect(envio.trabalhador.instancia,
          'com duas instâncias no ar, "não bate" pode ser só uma delas').toBeTruthy()
        expect(envio.diagnostico, 'a tela devolve número e não devolve veredito').toBeTruthy()
      } finally {
        await encerrarPonto(FILA_DE_ENVIO)
      }
    }, 30_000)

  it('e-mail que desistiu de vez derruba o ok, e duas tentativas do mesmo comprador são UMA pessoa',
    async () => {
      if (semRota()) return
      const daFila = (c: any) => c.filas.find((f: any) => f.nome === FILA_DE_ENVIO)

      // Estaciona o que esta organização tem na fila, como o caso de cima.
      // Sem isto, o trabalhador do servidor de dev entrega uma linha madura no
      // meio da medição e o `custo` muda entre duas leituras — o caso falharia
      // apontando pra rota, que não tem culpa. `orgId` é a organização deste
      // arquivo, apagada inteira no `afterAll`: não alcança trilha nenhuma.
      await q(`UPDATE email_sends SET available_at = now() + interval '2 hours'
                WHERE org_id = $1 AND status = 'na_fila'`, [orgId])

      const antes = await comSessao('/api/admin/filas').then((r) => r.json())

      const p = await pedidoPendente(1)
      await pagar(p.id)
      // A linha automática falha DE VEZ: o teto de tentativas estourou.
      // `SQL_RESERVA` não pega mais esta linha nem por id — não existe laço
      // que tente de novo. A fila fica VAZIA com o comprador sem ingresso, e
      // é exatamente esse estado que passava por "andando".
      await q(`UPDATE email_sends SET status = 'falhou', attempts = 5,
                      last_error = 'o domínio zz não existe'
                WHERE order_id = $1`, [p.id])

      const um = await comSessao('/api/admin/filas').then((r) => r.json())
      expect(daFila(um).perdidos - daFila(antes).perdidos,
        'a rota não viu o pedido que parou de vez').toBe(1)
      expect(um.ok, 'o alarme externo lê `ok` — ele disse "tudo bem" com um comprador '
        + 'que pagou e nunca vai receber o ingresso').toBe(false)
      expect(daFila(um).parado).toBe(true)
      expect(daFila(um).diagnostico, 'disse o número e não disse que ninguém tenta de novo')
        .toMatch(/ninguém tenta de novo/)

      // SEGUNDA tentativa do MESMO comprador, que também falha: duas linhas
      // na fila, UMA pessoa do outro lado do balcão. Medido antes disto, a
      // resposta dizia "2 ingresso(s) comprado(s) sem o e-mail na mão do
      // cliente" — e o operador ia procurar dois clientes que não existem.
      await q(`INSERT INTO email_sends (org_id, event_id, order_id, kind, origin, to_email,
                                        status, attempts, last_error)
               VALUES ($1,$2,$3,'confirmacao_pedido','reenvio',$4,'falhou',5,'caixa cheia')`,
        [orgId, eventId, p.id, 'joao.envio@teste.invalido'])

      const dois = await comSessao('/api/admin/filas').then((r) => r.json())
      expect(dois.filas.length, 'a rota perdeu uma fila no caminho').toBe(2)
      expect(daFila(dois).falharam - daFila(um).falharam,
        'a contagem de ITEM parou de contar a segunda tentativa').toBe(1)
      expect(daFila(dois).perdidos - daFila(um).perdidos,
        'duas tentativas do mesmo comprador viraram dois clientes perdidos').toBe(0)
      expect(daFila(dois).custo,
        'o custo em gente dobrou porque o mesmo comprador tentou duas vezes')
        .toBe(daFila(um).custo)

      // E o vermelho se apaga sozinho quando alguém manda de novo e chega —
      // senão um endereço digitado torto em maio deixa a tela vermelha pra
      // sempre, e tela sempre vermelha é tela que ninguém lê.
      await q(`UPDATE email_sends SET status = 'enviado', sent_at = now()
                WHERE order_id = $1 AND origin = 'reenvio'`, [p.id])
      const tres = await comSessao('/api/admin/filas').then((r) => r.json())
      expect(daFila(tres).perdidos - daFila(antes).perdidos,
        'o cliente recebeu e a tela continuou acusando').toBe(0)
      expect(daFila(tres).custo, 'o cliente recebeu e continuou na conta de quem não tem')
        .toBe(daFila(antes).custo)

      // Linha de fila SEM pedido (o schema permite): cada uma é um caso por
      // si. Agrupar por `order_id` sem tratar o nulo junta todas num grupo só
      // e duas pessoas viram uma — o jeito de errar que não aparece na tela,
      // porque o número fica MENOR do que a verdade.
      await q(`INSERT INTO email_sends (org_id, kind, origin, to_email, status,
                                        attempts, last_error)
               VALUES ($1,'confirmacao_pedido','reenvio',$2,'falhou',5,'sem pedido'),
                      ($1,'confirmacao_pedido','reenvio',$3,'falhou',5,'sem pedido')`,
        [orgId, 'orfa1.envio@teste.invalido', 'orfa2.envio@teste.invalido'])
      const quatro = await comSessao('/api/admin/filas').then((r) => r.json())
      expect(daFila(quatro).perdidos - daFila(tres).perdidos,
        'duas linhas órfãs viraram um caso só — o número mentiu pra menos').toBe(2)
    }, 60_000)

  it('estorno que desistiu de vez mostra o DINHEIRO que não voltou', async () => {
    if (semRota()) return
    const daFila = (c: any) => c.filas.find((f: any) => f.nome === FILA_DE_ESTORNO)

    // As DUAS filas desta organização ficam estacionadas: quem anda no meio da
    // medição muda o número entre duas leituras, e o vermelho nasce na rota,
    // que não tem culpa. O estorno tem laço próprio no servidor de dev.
    await q(`UPDATE email_sends SET available_at = now() + interval '2 hours'
              WHERE org_id = $1 AND status = 'na_fila'`, [orgId])
    await q(`UPDATE refund_jobs SET available_at = now() + interval '2 hours'
              WHERE org_id = $1 AND status = 'na_fila'`, [orgId])

    const antes = await comSessao('/api/admin/filas').then((r) => r.json())

    const p = await pedidoPendente(1)
    await pagar(p.id)
    await q(`INSERT INTO refund_jobs (org_id, event_id, order_id, reason, amount_cents,
                                      status, attempts, last_error)
             VALUES ($1,$2,$3,'arrependimento',85000,'falhou',5,
                     'o Asaas recusou a devolução')`, [orgId, eventId, p.id])

    const depois = await comSessao('/api/admin/filas').then((r) => r.json())
    expect(daFila(depois).perdidoCents - daFila(antes).perdidoCents,
      'R$ 850,00 que não voltaram pro cliente não aparecem em lugar nenhum da tela')
      .toBe(85_000)
    // `presoCents` é dinheiro que ainda anda sozinho; este não anda mais.
    // Somar os dois faria o mesmo estorno ser contado duas vezes, e a conta
    // de "quanto falta devolver" pararia de bater com a do financeiro.
    expect(daFila(depois).presoCents - daFila(antes).presoCents,
      'dinheiro que desistiu entrou como "preso", que é o que ainda vai sair sozinho')
      .toBe(0)
    expect(depois.ok, 'dinheiro que não voltou passou por "está tudo bem"').toBe(false)
  }, 60_000)

  it('sem sessão a tela de saúde não responde nada', async () => {
    if (semRota()) return
    const r = await fetch(`${BASE}/api/admin/filas`)
    expect(r.status, 'a fila do parque inteiro respondeu sem sessão nenhuma').toBe(401)
  }, 30_000)
})

/* ================== 10. a auditoria não pode ser esvaziada */

describe('a auditoria inteira', () => {
  it('TRUNCATE audit_log é recusado — o gatilho de linha não enxerga TRUNCATE', async () => {
    // Dentro de uma transação que SEMPRE desfaz. Se a trava tiver sido
    // arrancada (que é o ponto do teste de mutação), o TRUNCATE acontece DE
    // VERDADE: sem o ROLLBACK, conferir a trava apagaria as 37 mil linhas de
    // auditoria do banco de desenvolvimento junto.
    const c = await db().connect()
    try {
      await c.query('BEGIN')
      await expect(c.query('TRUNCATE audit_log'),
        'TRUNCATE apagou a auditoria inteira sem o gatilho reclamar — medido antes '
        + 'da 024: 37.448 linhas viraram 0')
        .rejects.toThrow(/não pode ser esvaziada/)
    } finally {
      await c.query('ROLLBACK').catch(() => {})
      c.release()
    }

    const n = await q1<any>(`SELECT count(*)::int AS n FROM audit_log`)
    expect(n.n, 'a conferência da trava levou a auditoria junto').toBeGreaterThan(0)
  })
})

/* ================== 11. o sinal do dinheiro não troca de lado entre telas */

const RAIZ = resolve(AQUI, '../..')
const leiaTela = (rel: string) => readFile(resolve(RAIZ, rel), 'utf8')

const TELA_DA_AUDITORIA = 'app/pages/admin/auditoria.vue'
const TELA_DAS_FILAS = 'app/pages/admin/filas.vue'

/** Só o código da tela — bloco `/* *\/`, `//` e `<!-- -->` fora. */
const semComentario = (src: string) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/^\s*\/\/.*$/gm, '')

/**
 * A `dinheiro()` da auditoria, arrancada da tela e rodada de VERDADE.
 *
 * Olhar o texto da função provaria só que alguém escreveu alguma coisa; o que
 * custa dinheiro é o que sai na célula. Extrair e executar deixa o teste
 * julgar a saída — e, por vir do arquivo, ele morre junto com o conserto se
 * alguém devolver o `return reais(v)`.
 */
async function dinheiroDaAuditoria(): Promise<(cents: number) => string> {
  const fonte = await leiaTela(TELA_DA_AUDITORIA)
  const m = fonte.match(/function dinheiro\(cents: number\): string \{\n([\s\S]*?)\n\}/)
  expect(m, `${TELA_DA_AUDITORIA} perdeu a função dinheiro() — o sinal voltou pro lado errado`)
    .not.toBeNull()
  const corpo = m![1]
  const f = new Function('reais', `return (cents) => { ${corpo} }`) as
    (r: typeof reais) => (cents: number) => string
  return f(reais)
}

/**
 * O que o pt-BR faz com valor negativo, sem opinião de ninguém.
 *
 * É a régua da casa por tabela: as outras quatro telas de dinheiro
 * (`evento/[id]/financeiro/index.vue`, `.../financeiro/bordero.vue`,
 * `.../relatorios/extrato.vue`, `.../relatorios/lotes.vue`) entregam o número
 * COM sinal pro `toLocaleString('pt-BR', { style: 'currency' })`, então o
 * lado do sinal delas é o lado do padrão. Comparar com o padrão, e não com o
 * código delas, mantém este teste vermelho pelo motivo certo mesmo que alguém
 * reescreva aquelas telas amanhã.
 *
 * O espaço vira espaço normal: o `Intl` usa U+00A0 e a `reais()` da casa usa
 * espaço comum de propósito (o fino quebrava busca e colagem em planilha). O
 * que está em jogo aqui é o SINAL, não o espaço.
 */
const padraoPtBr = (cents: number) =>
  (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
    .replace(/ /g, ' ')

describe('o sinal do dinheiro na auditoria', () => {
  it('fica na FRENTE do R$, como nas outras quatro telas de dinheiro', async () => {
    const dinheiro = await dinheiroDaAuditoria()

    // Medido na tela antes do conserto, campo `diferencaCents` do fechamento
    // de caixa: "diferença: R$ -20,00" (codepoints 52 24 20 2d). As outras
    // quatro imprimem "-R$ 20,00" pro mesmo número. Sinal que troca de lado
    // entre telas do mesmo valor é o que faz quem confere desconfiar das duas.
    expect(dinheiro(-2000), 'o menos voltou pra trás do R$').toBe('-R$ 20,00')
    expect(dinheiro(-2000)).toBe(padraoPtBr(-2000))
    expect(padraoPtBr(-2000).startsWith('-'),
      'o próprio pt-BR mudou de ideia sobre onde fica o sinal').toBe(true)
  })

  it('e não estraga o positivo nem o zero no caminho', async () => {
    const dinheiro = await dinheiroDaAuditoria()
    expect(dinheiro(85_000)).toBe('R$ 850,00')
    expect(dinheiro(85_000)).toBe(padraoPtBr(85_000))
    expect(dinheiro(0)).toBe('R$ 0,00')
    // Menos de um centavo negativo continua sendo negativo: `-1` é o caso que
    // um `Math.abs` na hora errada transformaria em "R$ 0,01" positivo.
    expect(dinheiro(-1)).toBe('-R$ 0,01')
    expect(dinheiro(-1)).toBe(padraoPtBr(-1))
  })

  it('continua saindo de reais(): sem float e sem o espaço fino do Intl', async () => {
    const dinheiro = await dinheiroDaAuditoria()
    // 8,15 é o valor que estourava em float (`815 / 100 * 100 = 814.9999…`) e
    // 1.234.567,89 é onde o milhar aparece. O espaço aqui é o comum (U+0020);
    // se a tela remontar o R$ com `Intl`, este é o que fica vermelho.
    expect(dinheiro(-815)).toBe('-R$ 8,15')
    expect(dinheiro(-123_456_789)).toBe('-R$ 1.234.567,89')
    expect(dinheiro(-2000).includes(' '),
      'voltou o espaço fino (U+00A0): não dá pra buscar nem colar em planilha').toBe(false)
  })

  it('e TODO campo *Cents da auditoria passa por ela — não sobra atalho', async () => {
    const fonte = await leiaTela(TELA_DA_AUDITORIA)
    // O defeito não era a falta da função; era a linha do `valorLegivel` que
    // mandava o número cru pra `reais()`. É essa linha que este teste prende.
    expect(fonte, 'o roteamento de *Cents deixou de passar pelo sinal')
      .toMatch(/cents\$\/i\.test\(campo\)\)\s*return dinheiro\(v\)/)
    expect(/cents\$\/i\.test\(campo\)\)\s*return reais\(v\)/.test(fonte),
      'voltou o `return reais(v)` — negativo volta a sair "R$ -20,00"').toBe(false)
  })
})

/* ================== 12. a tela que mostra a fila */

describe('a tela /admin/filas', () => {
  it('existe, com código dentro e não só comentário', async () => {
    const fonte = await leiaTela(TELA_DAS_FILAS)
    expect(fonte.length, 'a tela de filas sumiu').toBeGreaterThan(2000)
    const codigo = semComentario(fonte)
    expect(codigo.replace(/\s/g, '').length, 'sobrou só o comentário')
      .toBeGreaterThan(fonte.replace(/\s/g, '').length / 3)
    expect(codigo).toContain('<template>')
  })

  it('lê a rota de saúde e não inventa consulta própria ao banco', async () => {
    const fonte = await leiaTela(TELA_DAS_FILAS)
    expect(fonte).toContain(`useFetch<any>('/api/admin/filas')`)
    // Tela que fala com o banco por fora da rota é tela que um dia discorda
    // do servidor sobre se o cliente recebeu.
    expect(/\bfrom '(~~\/server|\.\.\/)/.test(fonte),
      'a tela passou a importar coisa do servidor direto').toBe(false)
  })

  it('mostra as três coisas: quantos esperam, quantos pararam de vez, e há quanto tempo ninguém varre',
    async () => {
      const fonte = await leiaTela(TELA_DAS_FILAS)
      expect(fonte, 'sumiu "quantos estão esperando"').toMatch(/Esperando[\s\S]{0,200}f\.naFila/)
      expect(fonte, 'sumiu "quantos estouraram o teto de tentativas"')
        .toMatch(/Pararam de vez[\s\S]{0,400}f\.perdidos/)
      expect(fonte, 'sumiu "há quanto tempo esta instância não varre"')
        .toMatch(/Sem carimbar há[\s\S]{0,1200}bateuHaTexto/)
      expect(fonte, 'sumiu de qual instância é o silêncio').toContain('trabalhador.instancia')
    })

  it('e é SÓ o número de gente que aparece em vermelho', async () => {
    const fonte = await leiaTela(TELA_DAS_FILAS)
    // `perdidos` é quanta gente pagou e não vai receber nada até alguém
    // mandar de novo. Se ele deixar de ser o destacado, a tela vira uma
    // parede de números iguais e o único que custa cliente some no meio.
    expect(fonte, 'o NÚMERO de quem pagou e não recebeu perdeu o vermelho')
      .toMatch(/numero-kpi[^>]*:class="f\.perdidos \? 'text-erro'/)
    expect(fonte, 'o rótulo desse número perdeu o vermelho')
      .toMatch(/rotulo-kpi"\s*:class="f\.perdidos \? 'text-erro'/)
    expect(fonte, 'o dinheiro que não voltou pro cliente perdeu o destaque')
      .toMatch(/font-semibold text-erro[\s\S]{0,120}perdidoCents/)
    // E é SÓ ele: pintar todo KPI de vermelho é a outra forma de esconder o
    // número que custa cliente — a cor deixa de querer dizer alguma coisa.
    const kpisEmVermelho = [...fonte.matchAll(/class="numero-kpi[^"]*"[^>]*text-erro/g)]
    expect(kpisEmVermelho.length,
      'mais de um KPI em vermelho: a cor parou de separar o que custa cliente').toBe(1)
  })

  it('quem não prometeu carimbar varredura não é desenhado como silêncio', async () => {
    const fonte = await leiaTela(TELA_DAS_FILAS)
    // Medido na tela com a fila de estorno parada por dinheiro que não voltou:
    // `f.parado` sozinho punha `font-bold` na célula, e "não carimba
    // varredura" saía em NEGRITO (peso 700) — cinza, mas gritando, numa linha
    // cujo recado é "aqui não tem nada pra ver". É o alarme falso da 026 de
    // novo, só que desenhado em vez de contado.
    expect(fonte, 'o destaque de silêncio voltou a valer pra fila que não carimba varredura')
      .toMatch(/f\.parado && f\.trabalhador\.carimbaVarredura\s*\n?\s*\? 'font-semibold text-erro'/)
    // E a dica do comando de limpeza também: mandar apagar a linha de quem
    // nunca carimba é ensinar a apagar o registro de uma fila saudável.
    expect(fonte).toMatch(/f\.parado && f\.trabalhador\?\.carimbaVarredura"[\s\S]{0,400}DELETE FROM worker_heartbeat_instances/)
  })

  it('o botão de empurrão só existe para fila que TEM rota de empurrão', async () => {
    const fonte = await leiaTela(TELA_DAS_FILAS)
    const m = fonte.match(/const EMPURRAO: Record<[^>]+> = \{([\s\S]*?)\n\}/)
    expect(m, 'sumiu a tabela de empurrões').not.toBeNull()
    const rotas = [...m![1].matchAll(/rota: '([^']+)'/g)].map((x) => x[1])
    expect(rotas.length).toBeGreaterThan(0)
    // Botão que aponta pra rota inexistente é pior do que botão nenhum: ele
    // ensina o operador a achar que já tentou.
    for (const rota of rotas) {
      const arquivo = resolve(RAIZ, `server/api${rota.replace(/^\/api/, '')}.post.ts`)
      const existe = await readFile(arquivo, 'utf8').then(() => true).catch(() => false)
      expect(existe, `${rota} não existe no servidor — o botão seria um 404`).toBe(true)
    }
    // E a de e-mail continua FORA: não há rota de varredura global pra ela.
    expect(Object.keys(m![1].match(/^\s*(\w+):/gm) ?? []).length).toBeGreaterThan(0)
    expect(m![1].includes('email:'), 'apareceu botão de empurrão pra fila de e-mail, '
      + 'que não tem rota de varredura global').toBe(false)
  })

  it('usa só classe da casa que existe de verdade no base.css', async () => {
    const fonte = await leiaTela(TELA_DAS_FILAS)
    const css = await readFile(resolve(RAIZ, 'app/assets/base.css'), 'utf8')
    const declaradas = new Set([...css.matchAll(/^\s*\.([a-z][\w-]*)\s*[,{]/gm)].map((m) => m[1]))
    // Classe da casa inventada não quebra build nem teste: ela só não pinta
    // nada, e o destaque do número que custa cliente some em silêncio. Só as
    // da casa entram na conferência; utilitário do Tailwind é do Tailwind.
    const daCasa = /^(card|rotulo|numero-kpi|selo|faixa|btn|titulo)(-[\w-]+)?$/
    const usadas = new Set<string>()
    for (const m of fonte.matchAll(/class="([^"]*)"/g)) {
      for (const c of m[1].split(/\s+/)) if (daCasa.test(c)) usadas.add(c)
    }
    for (const m of fonte.matchAll(/'([a-z][\w-]*)'/g)) {
      if (daCasa.test(m[1])) usadas.add(m[1])
    }
    expect(usadas.size, 'a tela parou de usar as classes da casa').toBeGreaterThan(5)
    expect([...usadas].filter((c) => !declaradas.has(c)),
      'classe da casa que não existe no base.css: não pinta nada e ninguém vê').toEqual([])
  })

  it('e formata dinheiro e data pelo formatador único, sem cópia local', async () => {
    // Comentário fora: o que explica o conserto cita o defeito pelo nome, e a
    // varredura acusaria a própria explicação. Pra calar o alarme alguém
    // apagaria o comentário, que é a parte que impede o bug de voltar.
    const fonte = semComentario(await leiaTela(TELA_DAS_FILAS))
    expect(/style:\s*'currency'|Intl\.NumberFormat|toISOString/.test(fonte),
      'voltou a cópia local do R$/da data — é de lá que vem o espaço fino e o dia errado às 21h')
      .toBe(false)
    expect(fonte).toContain('reais(f.')
    expect(fonte).toContain('dataHora(')
  })
})
