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
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { db, q, q1, tx } from './db'
import { emitirNaTransacao } from './emissao'
import { reservar } from './estoque'
import {
  assuntoCodificado, enderecoValido, entregarPorSmtp, montarConfirmacao, montarMime,
} from './email'
import {
  SQL_RESERVA, adiamentoSegundos, enfileirar, garantirWorker, montarMensagemDoPedido,
  pararWorker, processarUm, reservarProximo, usarTransporte,
} from './envio'

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
