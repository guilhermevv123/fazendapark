/**
 * evento.e2e.ts — as telas de DENTRO do evento no navegador de verdade, no computador (frota F3,
 * 28/09). Um caso por conserto visível da auditoria do evento, nas variações da matriz: A e depois
 * B, F5 no meio, voltar, duplo clique, cada papel. O que é portaria e balcão no celular mora em
 * `evento.celular.e2e.ts`.
 *
 *   E2E_BASE=http://127.0.0.1:3123 npx playwright test e2e/evento.e2e.ts e2e/evento.celular.e2e.ts
 *
 * O terreno nasce pela API que a tela chamaria (ver `evento-apoio.ts`); os números que a tela
 * mostra são comparados com a MESMA rota que ela chamou, ou com a outra tela que tem de bater.
 */
import { expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { BASE, centavos, sessao, travaDeBase, unico, vigiar } from './apoio'
import {
  abrir, abrirBalcao, apiComo, esconderEventosDaRodada, codigoDeCupom, corpo, cpfDeTeste, criarEvento, diaNaBahia, limpo,
  textoDoDownload, venderNoBalcao, type EventoDeTeste,
} from './evento-apoio'

test.beforeAll(() => travaDeBase(BASE))

let master: APIRequestContext
/** o evento com venda: 2 inteiras no débito + 1 no dinheiro, tudo no balcão */
let ev: EventoDeTeste
let balcao: { pontoId: string; turnoId: string }
let vendaDebito: Awaited<ReturnType<typeof venderNoBalcao>>
let vendaDinheiro: Awaited<ReturnType<typeof venderNoBalcao>>
/** um evento sem venda nenhuma */
let vazio: EventoDeTeste

test.beforeAll(async () => {
  master = await apiComo('master')
  ev = await criarEvento(master)
  balcao = await abrirBalcao(master, ev.id)
  vendaDebito = await venderNoBalcao(master, ev.id, balcao.turnoId,
    [{ lotId: ev.lote.id, ticketTypeId: ev.inteira, quantidade: 2 }], 'debito')
  vendaDinheiro = await venderNoBalcao(master, ev.id, balcao.turnoId,
    [{ lotId: ev.lote.id, ticketTypeId: ev.inteira, quantidade: 1 }], 'dinheiro',
    { recebidoCents: 5000, comprador: { nome: '=1+1' } })
  vazio = await criarEvento(master, { nome: unico('ZZE2E F3 VAZIO') })
})
test.afterAll(async () => {
  if (master) await esconderEventosDaRodada(master)
  await master?.dispose()
})

const painel = (id: string, resto = '') => `/admin/evento/${id}/dashboard${resto}`

/* ============================================================== dashboard */

test.describe('dashboard (master)', () => {
  test.use({ storageState: sessao('master') })

  test('#13 evento sem venda: R$ 0,00, "Nenhuma venda paga neste período" e nenhum NaN', async ({ page }) => {
    const problemas = vigiar(page)
    await abrir(page, painel(vazio.id))
    await expect(page.locator('[data-parte="kpi-vendas"] .numero-kpi')).toHaveText('R$ 0,00')
    await expect(page.locator('[data-parte="liquido"]')).toHaveText('R$ 0,00')
    await expect(page.locator('[data-parte="ingressos-vendidos"]')).toHaveText('0')
    await expect(page.locator('[data-parte="dias-vazio"]')).toContainText('Nenhuma venda paga neste período')
    const texto = await page.locator('main, #__nuxt').first().innerText()
    expect(texto).not.toMatch(/NaN|Infinity|undefined/)
    expect(problemas).toEqual([])
  })

  test('#10 #11 #12 período A → B, F5 e link, aba Público e volta (ADM-31)', async ({ page }) => {
    await abrir(page, painel(ev.id))
    const chip = (nome: string) => page.locator('[data-parte="periodo"] button', { hasText: nome })
    await expect(chip('Todo o período')).toHaveClass(/chip-ativo/)
    await chip('7 dias').click()
    await expect(page).toHaveURL(/periodo=7d/)
    await expect(chip('7 dias')).toHaveClass(/chip-ativo/)
    // F5: o período continua o escolhido
    await page.reload()
    await expect(chip('7 dias')).toHaveClass(/chip-ativo/)
    // A → B: Hoje
    await chip('Hoje').click()
    await expect(page).toHaveURL(/periodo=hoje/)
    // a aba Público: o período some (não filtra aquela aba) e a URL guarda a aba
    await page.getByRole('button', { name: 'Público' }).click()
    await expect(page).toHaveURL(/aba=publico/)
    await expect(page.locator('[data-parte="periodo"]')).toHaveCount(0)
    // o link com a aba abre direto nela
    await abrir(page, painel(ev.id, '?aba=publico'))
    await expect(page.locator('[data-parte="periodo"]')).toHaveCount(0)
    await page.getByRole('button', { name: 'Visão geral' }).click()
    await expect(page.locator('[data-parte="periodo"]')).toBeVisible()
    await chip('Todo o período').click()
    await expect(page).not.toHaveURL(/periodo=/)
  })

  test('#17 #138 #141 o líquido do painel é o do Financeiro e o do Borderô (e o recebido direto aparece nomeado)', async ({ page }) => {
    // 3 inteiras de R$ 30 no balcão, taxa de 10% absorvida: R$ 90 cobrados, R$ 81 de líquido
    await abrir(page, painel(ev.id))
    const liquidoPainel = centavos(await page.locator('[data-parte="liquido"]').innerText())
    expect(liquidoPainel).toBe(8100)
    await expect(page.locator('[data-parte="kpi-vendas"] .numero-kpi')).toHaveText('R$ 90,00')
    await expect(page.locator('[data-parte="liquido-partes"]')).toContainText('R$ 81,00 recebido direto')

    await abrir(page, `/admin/evento/${ev.id}/financeiro`)
    const cartao = page.locator('.card', { has: page.locator('.rotulo-kpi', { hasText: 'Total líquido' }) })
    expect(centavos(await cartao.locator('.numero-kpi').innerText())).toBe(liquidoPainel)
    await expect(page.locator('[data-parte="recebido-direto"]')).toContainText('R$ 81,00')

    await abrir(page, `/admin/evento/${ev.id}/financeiro/bordero`)
    const linhaFinal = page.locator('[data-parte="resultado"] > div').last()
    expect(centavos(await linhaFinal.locator('dd').innerText())).toBe(liquidoPainel)
    await expect(page.locator('[data-parte="conta-nao-fecha"]')).toHaveCount(0)
    await expect(page.locator('[data-parte="recebido-direto"]')).toContainText('R$ 81,00')
  })

  test('#15 #16 cortesia não mexe no ticket médio nem nos pedidos pagos (ADM-12)', async ({ page }) => {
    const antes = await corpo(await master.get(`/api/admin/evento/${ev.id}/dashboard`))
    await corpo(await master.post(`/api/admin/evento/${ev.id}/cortesias`, {
      data: { loteId: ev.lote.id, tipoId: ev.inteira, motivo: 'Imprensa E2E', responsavel: 'Diretoria',
              pessoas: [{ nome: 'Convidado Um' }, { nome: 'Convidado Dois' }, { nome: 'Convidado Três' }] },
    }))
    await abrir(page, painel(ev.id))
    const ticket = page.locator('[data-parte="kpi-ticket"] .numero-kpi')
    await expect(ticket).toHaveText('R$ 45,00') // R$ 90 em 2 pedidos pagos
    await expect(page.locator('[data-parte="pedidos-pagos"]')).toHaveText('2')
    await expect(page.locator('[data-parte="ingressos-vendidos"]')).toHaveText('3')
    await expect(page.locator('[data-parte="kpi-ingressos"]')).toContainText(`+ ${antes.totais.cortesiasEmitidas + 3} de cortesia`)
  })
})

test.describe('dashboard por papel (#24)', () => {
  test.describe('financeiro', () => {
    test.use({ storageState: sessao('financeiro') })
    test('financeiro abre o painel com os números', async ({ page }) => {
      await abrir(page, painel(ev.id))
      await expect(page.locator('[data-parte="kpi-vendas"] .numero-kpi')).toHaveText('R$ 90,00')
    })
  })
  for (const papel of ['operacao', 'portaria'] as const) {
    test.describe(papel, () => {
      test.use({ storageState: sessao(papel) })
      test(`${papel}: o painel não abre, e a tela diz por quê (nunca em branco)`, async ({ page }) => {
        await abrir(page, painel(ev.id))
        await expect(page.locator('[data-parte="kpi-vendas"]')).toHaveCount(0)
        // o bloco de falha com o recado do papel — o 403 tratado, nunca a tela em branco
        await expect(page.locator('[data-parte="falha-painel"]')).toContainText('Seu acesso')
        await expect(page.locator('[data-parte="falha-painel"]').getByRole('button', { name: 'Tentar de novo' })).toBeVisible()
      })
    })
  }
})

/* ================================================================= vendas */

test.describe('vendas › pedidos', () => {
  test.use({ storageState: sessao('master') })

  test('#43 #46 busca e situação na URL: A → B, F5 mantém o recorte (ADM-31)', async ({ page }) => {
    await abrir(page, `/admin/evento/${ev.id}/vendas`)
    const busca = page.getByPlaceholder('Código do pedido, nome, e-mail, CPF ou telefone')
    await busca.fill(vendaDebito.codigoPedido)
    await expect(page).toHaveURL(new RegExp(`busca=${vendaDebito.codigoPedido}`))
    await expect(page.locator('tbody tr')).toHaveCount(1)
    await expect(page.locator('tbody tr').first()).toContainText(vendaDebito.codigoPedido)
    // B: a situação por cima da busca
    await page.locator('select').first().selectOption('pago')
    await expect(page).toHaveURL(/situacao=pago/)
    await page.reload()
    await expect(busca).toHaveValue(vendaDebito.codigoPedido)
    await expect(page.locator('select').first()).toHaveValue('pago')
    await expect(page.locator('tbody tr')).toHaveCount(1)
    // situação que o pedido não tem: a lista diz que não achou, a URL guarda
    await page.locator('select').first().selectOption('cancelado')
    await expect(page.locator('tbody')).toContainText('Nenhum pedido com esses filtros.')
    await expect(page).toHaveURL(/situacao=cancelado/)
  })

  test('#44 o filtro acha pedido contestado: chargeback e disputa são opções (ADM-64)', async ({ page }) => {
    await abrir(page, `/admin/evento/${ev.id}/vendas`)
    const opcoes = await page.locator('select').first().locator('option').allInnerTexts()
    expect(opcoes).toEqual(expect.arrayContaining(['CHARGEBACK', 'EM DISPUTA', 'ESTORNADO EM PARTE']))
  })

  test('#47 link ?pedido= abre a ficha; fechar tira o parâmetro e o F5 não reabre', async ({ page }) => {
    await abrir(page, `/admin/evento/${ev.id}/vendas?pedido=${vendaDinheiro.pedidoId}`)
    const ficha = page.locator('aside h2', { hasText: vendaDinheiro.codigoPedido })
    await expect(ficha).toBeVisible()
    await page.getByRole('button', { name: 'Fechar' }).click()
    await expect(ficha).toHaveCount(0)
    await expect(page).not.toHaveURL(/pedido=/)
    await page.reload()
    await expect(page.locator('aside h2', { hasText: vendaDinheiro.codigoPedido })).toHaveCount(0)
  })

  test('#14 os cards da lista usam os nomes e as réguas do painel (ADM-29)', async ({ page }) => {
    await abrir(page, `/admin/evento/${ev.id}/vendas`)
    await expect(page.locator('[data-parte="total-vendas"] .numero-kpi')).toHaveText('R$ 90,00')
    await expect(page.locator('[data-parte="total-vendas"]')).toContainText('líquido do produtor R$ 81,00')
    // "Ingressos vendidos" sem cortesia — as cortesias vão na linha de baixo
    await expect(page.locator('[data-parte="ingressos-vendidos"] .numero-kpi')).toHaveText('3')
  })
})

test.describe('vendas › cancelar pedido por papel (#50 #179, ADM-64)', () => {
  test.describe('master', () => {
    test.use({ storageState: sessao('master') })
    test('master vê "Cancelar pedido" na ficha paga', async ({ page }) => {
      await abrir(page, `/admin/evento/${ev.id}/vendas?pedido=${vendaDebito.pedidoId}`)
      await expect(page.locator('[data-parte="cancelar-pedido"]')).toBeVisible()
    })
  })
  test.describe('operação', () => {
    test.use({ storageState: sessao('operacao') })
    test('operação abre a ficha e NÃO tem o botão que só dá 403', async ({ page }) => {
      await abrir(page, `/admin/evento/${ev.id}/vendas?pedido=${vendaDebito.pedidoId}`)
      await expect(page.locator('aside h2', { hasText: vendaDebito.codigoPedido })).toBeVisible()
      await expect(page.locator('[data-parte="cancelar-pedido"]')).toHaveCount(0)
    })
  })
})

/* =========================================================== participantes */

test.describe('vendas › participantes', () => {
  test.use({ storageState: sessao('master') })

  test('#52 filtros na URL: status e busca sobrevivem ao F5, e o link abre já filtrado', async ({ page }) => {
    await abrir(page, `/admin/evento/${ev.id}/vendas/participantes`)
    await page.locator('#st').selectOption('valido')
    await expect(page).toHaveURL(/status=valido/)
    await page.locator('#q').fill(vendaDinheiro.ingressos[0].codigo)
    await expect(page).toHaveURL(new RegExp(`busca=${vendaDinheiro.ingressos[0].codigo}`))
    await page.reload()
    await expect(page.locator('#st')).toHaveValue('valido')
    await expect(page.locator('#q')).toHaveValue(vendaDinheiro.ingressos[0].codigo)
    await expect(page.locator('tbody tr')).toHaveCount(1)
    // o link com ?setor= abre com o setor escolhido no primeiro desenho
    await abrir(page, `/admin/evento/${ev.id}/vendas/participantes?setor=${ev.setorId}`)
    await expect(page.locator('#se')).toHaveValue(ev.setorId)
  })

  test('#55 exportar: nome com fórmula sai neutralizado no CSV (ADM-14)', async ({ page }) => {
    // o comprador do balcão "=1+1" vira titular dos ingressos da venda em dinheiro
    await abrir(page, `/admin/evento/${ev.id}/vendas/participantes?busca=${vendaDinheiro.ingressos[0].codigo}`)
    await expect(page.locator('tbody tr')).toHaveCount(1)
    const [baixado] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: /Exportar página/ }).click(),
    ])
    const csv = await textoDoDownload(baixado)
    expect(csv).toContain(`"'=1+1"`)
    expect(csv).not.toMatch(/(^|;)"=1\+1"/m)
  })

  test('#53 transferência concluída aparece no filtro "Transferido" (ADM-45)', async ({ page }) => {
    const t = await venderNoBalcao(master, ev.id, balcao.turnoId,
      [{ lotId: ev.lote.id, ticketTypeId: ev.inteira, quantidade: 1 }], 'pix')
    await corpo(await master.patch(`/api/admin/evento/${ev.id}/transferencias`, { data: { permitir: true } }))
    const nome = unico('Recebe Transferência')
    const criada = await corpo(await master.post(`/api/admin/evento/${ev.id}/transferencias`, {
      data: { codigo: t.ingressos[0].codigo, paraNome: nome, paraEmail: 'recebe.f3@teste.invalido' },
    }))
    const codigoDaTroca = String(criada.transferencia.link).split('/').pop()
    // quem recebe aceita pela página pública (a mesma rota que a página chama)
    await corpo(await master.post(`/api/transferencia/${codigoDaTroca}`, { data: { nome } }))
    await abrir(page, `/admin/evento/${ev.id}/vendas/participantes`)
    await page.locator('#st').selectOption('transferido')
    await expect(page.locator('tbody')).toContainText(nome)
  })
})

/* =========================================================== transferências */

/** o formulário "Transferir pelo balcão" (a página tem outro campo de e-mail no topo) */
const formTransferencia = (page: Page) => page.locator('form', { has: page.getByPlaceholder('Código do ingresso') })

test.describe('vendas › transferências', () => {
  test.use({ storageState: sessao('master') })

  test('#59 duplo clique em Enviar: uma transferência, nunca 500 (ADM-55)', async ({ page }) => {
    const t = await venderNoBalcao(master, ev.id, balcao.turnoId,
      [{ lotId: ev.lote.id, ticketTypeId: ev.inteira, quantidade: 2 }], 'pix')
    await corpo(await master.patch(`/api/admin/evento/${ev.id}/transferencias`, { data: { permitir: true } }))
    const respostas: number[] = []
    page.on('response', (r) => {
      if (r.request().method() === 'POST' && new URL(r.url()).pathname.endsWith('/transferencias')) respostas.push(r.status())
    })
    await abrir(page, `/admin/evento/${ev.id}/vendas/transferencias`)
    const nome = unico('Duplo Clique')
    await formTransferencia(page).getByPlaceholder('Código do ingresso').fill(t.ingressos[0].codigo)
    await formTransferencia(page).getByPlaceholder('Nome de quem recebe').fill(nome)
    await formTransferencia(page).getByPlaceholder('E-mail', { exact: true }).fill('duplo.f3@teste.invalido')
    // 1) na tela: dois cliques rápidos no botão (o segundo cai no botão já travado)
    await formTransferencia(page).locator('button.btn-primario').dblclick()
    await expect(page.locator('.faixa-aviso')).toContainText(`Transferência criada. Mande o link para ${nome}.`)
    await page.waitForLoadState('networkidle').catch(() => {})
    expect(respostas.filter((s) => s >= 500), `respostas: ${respostas.join(',')}`).toEqual([])
    expect(respostas.filter((s) => s === 200).length, `respostas: ${respostas.join(',')}`).toBe(1)
    const lista = await corpo(await master.get(`/api/admin/evento/${ev.id}/transferencias`))
    expect(lista.transferencias.filter((x: any) => JSON.stringify(x).includes(nome))).toHaveLength(1)

    // 2) o que passa por baixo da tela (rede que repete, duas abas): dois POST do MESMO ingresso
    //    ao mesmo tempo, pela rota que a tela chama — um grava, o outro é 409 com frase, nunca 500
    const duas = await page.evaluate(async ([id, codigo]) => {
      const um = () => fetch(`/api/admin/evento/${id}/transferencias`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ codigo, paraNome: 'Duas Abas', paraEmail: 'duas.f3@teste.invalido' }),
      }).then(async (r) => ({ status: r.status, texto: await r.text() }))
      return Promise.all([um(), um()])
    }, [ev.id, t.ingressos[1].codigo])
    expect(duas.map((d) => d.status).sort(), JSON.stringify(duas)).toEqual([200, 409])
    expect(duas.find((d) => d.status === 409)!.texto).toMatch(/transfer/i)
  })

  test('#61 "copiar link": sem área de transferência a tela diz a verdade e mostra o link (ADM-55)', async ({ page }) => {
    const t = await venderNoBalcao(master, ev.id, balcao.turnoId,
      [{ lotId: ev.lote.id, ticketTypeId: ev.inteira, quantidade: 1 }], 'pix')
    await corpo(await master.patch(`/api/admin/evento/${ev.id}/transferencias`, { data: { permitir: true } }))
    // o tablet em http na LAN: navigator.clipboard não existe
    await page.addInitScript(() => { Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true }) })
    await abrir(page, `/admin/evento/${ev.id}/vendas/transferencias`)
    await formTransferencia(page).getByPlaceholder('Código do ingresso').fill(t.ingressos[0].codigo)
    await formTransferencia(page).getByPlaceholder('Nome de quem recebe').fill(unico('Sem Clipboard'))
    await formTransferencia(page).getByPlaceholder('E-mail', { exact: true }).fill('clip.f3@teste.invalido')
    await formTransferencia(page).locator('button.btn-primario').click()
    await page.getByRole('button', { name: 'copiar link' }).click()
    await expect(page.locator('.faixa-aviso')).toContainText('Não deu pra copiar sozinho. Copie o link:')
    await expect(page.locator('.faixa-aviso')).toContainText(`${BASE}/transferencia/`)
    await expect(page.locator('.faixa-aviso')).not.toContainText('Link copiado')
  })

  test('#61 com área de transferência: "Link copiado" e o link está mesmo lá', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE })
    const t = await venderNoBalcao(master, ev.id, balcao.turnoId,
      [{ lotId: ev.lote.id, ticketTypeId: ev.inteira, quantidade: 1 }], 'pix')
    await corpo(await master.patch(`/api/admin/evento/${ev.id}/transferencias`, { data: { permitir: true } }))
    await abrir(page, `/admin/evento/${ev.id}/vendas/transferencias`)
    await formTransferencia(page).getByPlaceholder('Código do ingresso').fill(t.ingressos[0].codigo)
    await formTransferencia(page).getByPlaceholder('Nome de quem recebe').fill(unico('Com Clipboard'))
    await formTransferencia(page).getByPlaceholder('E-mail', { exact: true }).fill('clip2.f3@teste.invalido')
    await formTransferencia(page).locator('button.btn-primario').click()
    await page.getByRole('button', { name: 'copiar link' }).click()
    await expect(page.locator('.faixa-aviso')).toContainText('Link copiado.')
    await expect(page.locator('.faixa-aviso')).not.toContainText('Não deu pra copiar')
    expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(new RegExp(`^${BASE}/transferencia/`))
  })

  test('#62 chips e busca na URL: F5 mantém (ADM-31)', async ({ page }) => {
    await abrir(page, `/admin/evento/${ev.id}/vendas/transferencias`)
    await page.getByRole('button', { name: 'Aguardando', exact: true }).click()
    await expect(page).toHaveURL(/status=aguardando/)
    await page.locator('input.campo.max-w-sm').fill('Clipboard')
    await expect(page).toHaveURL(/busca=Clipboard/)
    await page.reload()
    await expect(page.getByRole('button', { name: 'Aguardando', exact: true })).toHaveClass(/chip-ativo/)
    await expect(page.locator('input.campo.max-w-sm')).toHaveValue('Clipboard')
  })
})

/* ================================================================ ingressos */

test.describe('ingressos › setores e lotes', () => {
  test.use({ storageState: sessao('master') })

  test('#72 preço redondo: R$ 10,06 com 10% repassada não existe — a tela diz os vizinhos e aplica o que o checkout cobra (ADM-23)', async ({ page }) => {
    const e = await criarEvento(master)
    await abrir(page, `/admin/evento/${e.id}/ingressos`)
    const linha = page.locator('tr', { hasText: 'Lote redondo' }).first()
    await linha.locator('button[title="Preço redondo"]').click()
    await page.getByLabel('Comprador paga').or(page.locator('tr.bg-acao-fraco input')).first().fill('1006')
    await expect(page.locator('[data-parte="previa-redondo"]')).toHaveText(/face R\$ 9,14\s*\+ taxa R\$ 0,91\s*= R\$ 10,05/)
    await expect(page.locator('[data-parte="redondo-nao-existe"]')).toContainText('R$ 10,07')
    await page.getByRole('button', { name: 'Aplicar' }).click()
    await expect(page.locator('[data-parte="previa-redondo"]')).toHaveCount(0)
    // o que o checkout cobra agora: a conta do servidor, não a da tela
    const ing = await corpo(await master.get(`/api/admin/evento/${e.id}/ingressos`))
    const lote = ing.setores[0].lotes.find((l: any) => l.nome === 'Lote redondo')
    expect([lote.faceCents, lote.totalCents]).toEqual([914, 1005])
    await expect(page.locator('tr', { hasText: 'Lote redondo' }).first()).toContainText('R$ 10,05')
  })
})

test.describe('ingressos › cupons', () => {
  test.use({ storageState: sessao('master') })
  const janela = (page: Page) => page.getByRole('dialog')

  test('#86 código de 2 letras: a recusa diz o campo, dentro da janela (ADM-36)', async ({ page }) => {
    await abrir(page, `/admin/evento/${ev.id}/ingressos/cupons`)
    await page.getByRole('button', { name: 'Criar código' }).click()
    await janela(page).getByPlaceholder('VERAO10').fill('AB')
    await janela(page).locator('#cupom-valor').fill('10')
    await janela(page).locator('[data-parte="salvar-cupom"]').click()
    await expect(janela(page).locator('[data-parte="erro-cupom"]')).toContainText('Código')
  })

  test('cupom de 100% sem limite: a tela avisa, só grava confirmado, e o limite resolve sem confirmar', async ({ page }) => {
    await abrir(page, `/admin/evento/${ev.id}/ingressos/cupons`)
    await page.getByRole('button', { name: 'Criar código' }).click()
    const codigo = codigoDeCupom('GRATIS')
    await janela(page).getByPlaceholder('VERAO10').fill(codigo)
    await janela(page).locator('#cupom-valor').fill('100')
    const salvar = janela(page).locator('[data-parte="salvar-cupom"]')
    await expect(janela(page).locator('[data-parte="aviso-gratis-ilimitado"]')).toBeVisible()
    await expect(salvar).toBeDisabled()
    // B: com limite de usos o aviso some sem precisar confirmar nada
    await janela(page).getByPlaceholder('sem limite').fill('20')
    await expect(janela(page).locator('[data-parte="aviso-gratis-ilimitado"]')).toHaveCount(0)
    await expect(salvar).toBeEnabled()
    // A de novo: sem limite, confirmado de propósito
    await janela(page).getByPlaceholder('sem limite').fill('')
    await expect(salvar).toBeDisabled()
    await janela(page).locator('[data-parte="confirmar-ilimitado"]').check()
    await expect(salvar).toBeEnabled()
    await salvar.click()
    await expect(janela(page)).toHaveCount(0)
    await expect(page.locator('tr', { hasText: codigo })).toContainText('100%')
  })

  test('#88 cupom de valor fixo pelo campo de dinheiro: R$ 10,50 grava 1050 centavos (ADM-50)', async ({ page }) => {
    await abrir(page, `/admin/evento/${ev.id}/ingressos/cupons`)
    await page.getByRole('button', { name: 'Criar código' }).click()
    const codigo = codigoDeCupom('FIXO')
    await janela(page).getByPlaceholder('VERAO10').fill(codigo)
    await janela(page).locator('select').first().selectOption('fixo')
    await janela(page).locator('#cupom-valor').fill('1050')
    await expect(janela(page).locator('#cupom-valor')).toHaveValue('10,50')
    await janela(page).getByPlaceholder('sem limite').fill('5')
    await janela(page).locator('[data-parte="salvar-cupom"]').click()
    await expect(page.locator('tr', { hasText: codigo })).toContainText('R$ 10,50')
    const lista = await corpo(await master.get(`/api/admin/evento/${ev.id}/cupons`))
    expect(lista.cupons.find((c: any) => c.codigo === codigo)?.valor).toBe(1050)
  })

  test('#92 ligar/desligar com dois cliques: uma gravação, estado final previsível (ADM-51)', async ({ page }) => {
    const codigo = codigoDeCupom('DUPLO')
    await corpo(await master.post(`/api/admin/evento/${ev.id}/cupons`, {
      data: { codigo, tipo: 'percentual', valor: 1000, maxUsos: 10, maxPorCliente: 1, ativo: true, loteIds: [] },
    }))
    let patches = 0
    page.on('request', (r) => { if (r.method() === 'PATCH' && r.url().endsWith('/cupons')) patches++ })
    await abrir(page, `/admin/evento/${ev.id}/ingressos/cupons`)
    const linha = page.locator('tr', { hasText: codigo })
    await linha.locator('[data-parte="alternar"]').dblclick()
    await expect(linha).toContainText('DESATIVADO')
    await page.waitForLoadState('networkidle').catch(() => {})
    expect(patches, 'o duplo clique gravou duas vezes (e o cupom voltaria a ligar)').toBe(1)
    await page.reload()
    await expect(page.locator('tr', { hasText: codigo })).toContainText('DESATIVADO')
  })

  test('#93 apagar: cupom usado fica travado com o motivo; o não usado apaga em dois cliques', async ({ page }) => {
    const usado = codigoDeCupom('USADO')
    const livre = codigoDeCupom('LIVRE')
    for (const codigo of [usado, livre]) {
      await corpo(await master.post(`/api/admin/evento/${ev.id}/cupons`, {
        data: { codigo, tipo: 'percentual', valor: 1000, maxUsos: 10, maxPorCliente: 1, ativo: true, loteIds: [] },
      }))
    }
    // o balcão usa o cupom (com CPF: a régua de "1 por pessoa" é a do site)
    await venderNoBalcao(master, ev.id, balcao.turnoId,
      [{ lotId: ev.lote.id, ticketTypeId: ev.inteira, quantidade: 1 }], 'pix',
      { cupom: usado, comprador: { nome: 'Cliente Cupom', documento: cpfDeTeste() } })
    await abrir(page, `/admin/evento/${ev.id}/ingressos/cupons`)
    const lixoUsado = page.locator('tr', { hasText: usado }).locator('button[title^="Cupom já usado"]')
    await expect(lixoUsado).toBeDisabled()
    const lixoLivre = page.locator('tr', { hasText: livre }).locator('button[title="Apagar"]')
    await lixoLivre.click()
    await expect(page.locator('tr', { hasText: livre }).locator('button[title="Clique de novo para confirmar"]')).toBeVisible()
    await page.locator('tr', { hasText: livre }).locator('button[title="Clique de novo para confirmar"]').click()
    await expect(page.locator('tr', { hasText: livre })).toHaveCount(0)
    await expect(page.locator('tr', { hasText: usado })).toHaveCount(1)
  })
})

test.describe('ingressos › cortesias', () => {
  test.describe('master', () => {
    test.use({ storageState: sessao('master') })

    test('#80 #81 cota: 30 grava; abaixo das emitidas é recusada DENTRO da janela; vazio volta a "sem teto" (ADM-05)', async ({ page }) => {
      const e = await criarEvento(master)
      await corpo(await master.post(`/api/admin/evento/${e.id}/cortesias`, {
        data: { loteId: e.lote.id, motivo: 'Imprensa E2E', responsavel: 'Diretoria',
                pessoas: [{ nome: 'Um Convidado' }, { nome: 'Dois Convidado' }, { nome: 'Três Convidado' }] },
      }))
      await abrir(page, `/admin/evento/${e.id}/ingressos/cortesias`)
      const emitidas = page.locator('.card', { has: page.locator('.rotulo-kpi', { hasText: 'Emitidas' }) })
      await expect(emitidas).toContainText('sem cota definida')

      await page.getByRole('button', { name: 'Definir cota' }).click()
      await page.getByRole('dialog').getByPlaceholder('sem teto').first().fill('30')
      await page.getByRole('dialog').getByRole('button', { name: 'Salvar cota' }).click()
      await expect(page.getByRole('dialog')).toHaveCount(0)
      await expect(emitidas.locator('.numero-kpi')).toHaveText(/3\s*de 30/)
      await expect(emitidas).toContainText('ainda cabem 27')

      // abaixo do que já saiu: a recusa aparece na janela, que continua aberta
      await page.getByRole('button', { name: 'Definir cota' }).click()
      await page.getByRole('dialog').getByPlaceholder('sem teto').first().fill('2')
      await page.getByRole('dialog').getByRole('button', { name: 'Salvar cota' }).click()
      await expect(page.getByRole('dialog').locator('[data-parte="erro-na-janela"]')).toContainText(/cancel/i)

      // vazio = sem teto
      await page.getByRole('dialog').getByPlaceholder('sem teto').first().fill('')
      await page.getByRole('dialog').getByRole('button', { name: 'Salvar cota' }).click()
      await expect(page.getByRole('dialog')).toHaveCount(0)
      await expect(emitidas).toContainText('sem cota definida')
    })

    test('#80 zero é teto de verdade: "a cota acabou"', async ({ page }) => {
      const e = await criarEvento(master)
      await abrir(page, `/admin/evento/${e.id}/ingressos/cortesias`)
      await page.getByRole('button', { name: 'Definir cota' }).click()
      await page.getByRole('dialog').getByPlaceholder('sem teto').first().fill('0')
      await page.getByRole('dialog').getByRole('button', { name: 'Salvar cota' }).click()
      const emitidas = page.locator('.card', { has: page.locator('.rotulo-kpi', { hasText: 'Emitidas' }) })
      await expect(emitidas).toContainText('a cota acabou')
    })

    test('#79 evento cancelado: emitir é recusado, e a recusa aparece na janela (ADM-22)', async ({ page }) => {
      const e = await criarEvento(master)
      await corpo(await master.post(`/api/admin/evento/${e.id}/cancelar`, { data: { escopo: 'evento', motivo: 'Teste E2E da frota' } }))
      await abrir(page, `/admin/evento/${e.id}/ingressos/cortesias`)
      await page.getByRole('button', { name: 'Emitir cortesia' }).click()
      const j = page.getByRole('dialog')
      await j.getByPlaceholder('Imprensa, patrocinador, equipe…').fill('Imprensa')
      await j.getByPlaceholder('Nome de quem solicitou').fill('Diretoria')
      await j.getByPlaceholder('Nome', { exact: true }).fill('Convidada Cancelada')
      await j.getByRole('button', { name: /Emitir .*cortesia/ }).click()
      await expect(j.locator('[data-parte="erro-na-janela"]')).toContainText(/cancelad/i)
      const lista = await corpo(await master.get(`/api/admin/evento/${e.id}/cortesias`))
      expect(lista.resumo.total).toBe(0)
    })
  })

  test.describe('operação', () => {
    test.use({ storageState: sessao('operacao') })
    test('#82 #181 Operação: "Definir cota" travado com o porquê; emitir continua liberado', async ({ page }) => {
      await abrir(page, `/admin/evento/${ev.id}/ingressos/cortesias`)
      const cota = page.getByRole('button', { name: 'Definir cota' })
      await expect(cota).toBeDisabled()
      await expect(cota).toHaveAttribute('title', /Só um acesso Master/)
      await expect(page.getByRole('button', { name: 'Emitir cortesia' })).toBeEnabled()
    })
  })
})

test.describe('ingressos › sessões', () => {
  test.use({ storageState: sessao('master') })

  test('#109 #108 #112 nome como modelo em várias datas, rodar de novo não duplica, apagar em dois toques (ADM-39, ADM-40)', async ({ page }) => {
    const e = await criarEvento(master)
    let dialogos = 0
    page.on('dialog', async (d) => { dialogos++; await d.dismiss() })
    await abrir(page, `/admin/evento/${e.id}/ingressos/sessoes`)
    // uma semana inteira adiante: com Sáb e Dom (o padrão), duas datas
    await page.locator('#de').fill(diaNaBahia(10))
    await page.locator('#ate').fill(diaNaBahia(16))
    await page.locator('#tit').fill('Show')
    await page.getByRole('button', { name: 'Criar datas' }).click()
    await expect(page.getByText(/^2 dia\(s\) criado\(s\)\./)).toBeVisible()
    const titulos = await page.locator('section h2.titulo').allInnerTexts()
    const doShow = titulos.map((t) => t.trim()).filter((t) => /^SHOW · \d{2}\/\d{2}$/i.test(t))
    expect(doShow, `títulos: ${titulos.join(' | ')}`).toHaveLength(2)
    expect(new Set(doShow).size, 'o mesmo nome em todas as datas').toBe(2)

    // B: o mesmo período de novo — nada duplicado
    await page.getByRole('button', { name: 'Criar datas' }).click()
    await expect(page.getByText(/0 dia\(s\) criado\(s\), 2 que já existia\(m\) foram mantidos/)).toBeVisible()

    // apagar: o primeiro toque só pede confirmação (nada de confirm() do navegador)
    const primeiro = page.locator('[data-parte="apagar-dia"]').first()
    await primeiro.click()
    await expect(primeiro).toContainText('Confirmar')
    await primeiro.click()
    await expect(page.locator('[data-parte="apagar-dia"]')).toHaveCount(1)
    expect(dialogos, 'o navegador abriu confirm()/alert()').toBe(0)
  })
})

test.describe('ingressos › ordenar', () => {
  test.use({ storageState: sessao('master') })

  test('#97 #95 #96 sem mudança nada salva; mudou → UMA chamada com tudo, e a ordem fica (ADM-41)', async ({ page }) => {
    const e = await criarEvento(master)
    const patches: any[] = []
    page.on('request', (r) => { if (r.method() === 'PATCH' && r.url().endsWith('/ordenar')) patches.push(r.postDataJSON()) })
    await abrir(page, `/admin/evento/${e.id}/ingressos/ordenar`)
    await expect(page.getByRole('button', { name: 'Salvar ordem' })).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Desfazer' })).toBeDisabled()
    await page.getByRole('button', { name: 'Descer lote' }).first().click()
    await expect(page.getByRole('button', { name: 'Salvar ordem' })).toBeEnabled()
    await page.getByRole('button', { name: 'Salvar ordem' }).click()
    await expect(page.getByRole('button', { name: 'Salvar ordem' })).toBeDisabled()
    expect(patches).toHaveLength(1)
    expect(patches[0].o).toBe('tudo')
    const ing = await corpo(await master.get(`/api/admin/evento/${e.id}/ingressos`))
    expect(ing.setores[0].lotes.map((l: any) => l.nome)).toEqual(['Lote redondo', '1º lote'])
  })
})

test.describe('assentos', () => {
  test.use({ storageState: sessao('master') })
  test('#118 a tela diz que a venda ainda não usa o mapa (ADM-42)', async ({ page }) => {
    await abrir(page, `/admin/evento/${ev.id}/assentos`)
    await expect(page.locator('[data-parte="em-preparacao"]')).toBeVisible()
  })
})

/* =========================================================== configurações */

test.describe('configurações', () => {
  test.describe('master', () => {
    test.use({ storageState: sessao('master') })

    test('#124 taxa de serviço em texto: 2,5 → 250 bps; "abc" avisa; 51% recusado com o campo (ADM-09)', async ({ page }) => {
      const e = await criarEvento(master)
      await abrir(page, `/admin/evento/${e.id}/configuracoes`)
      const taxa = page.locator('#taxa')
      await taxa.fill('abc')
      await expect(page.locator('[data-parte="taxa-invalida"]')).toBeVisible()
      await taxa.fill('51')
      await page.getByRole('button', { name: 'Salvar', exact: true }).click()
      await expect(page.locator('p.border-erro').first()).toContainText('Taxa de serviço')
      await taxa.fill('2,5')
      await expect(page.getByText('(250 bps)')).toBeVisible()
      await page.getByRole('button', { name: 'Salvar', exact: true }).click()
      await expect(page.locator('p.border-ok').first()).toBeVisible()
      await page.reload()
      await expect(page.locator('#taxa')).toHaveValue('2,5')
      const cfg = await corpo(await master.get(`/api/admin/evento/${e.id}/configuracoes`))
      expect(cfg.taxaBps ?? cfg.evento?.taxaBps).toBe(250)
    })

    test('#130 master vê o bloco de cancelar o evento', async ({ page }) => {
      await abrir(page, `/admin/evento/${vazio.id}/configuracoes`)
      await expect(page.locator('#cancelamento')).toBeVisible()
      await expect(page.locator('[data-parte="cancelar-sem-acesso"]')).toHaveCount(0)
    })
  })

  test.describe('operação', () => {
    test.use({ storageState: sessao('operacao') })
    test('#131 Operação: cancelar escondido com o recado, adiar continua (ADM-43)', async ({ page }) => {
      await abrir(page, `/admin/evento/${vazio.id}/configuracoes`)
      await expect(page.locator('[data-parte="cancelar-sem-acesso"]')).toContainText('master ou o financeiro')
      await expect(page.locator('#cancelamento')).toContainText(/Adiar/i)
    })
  })
})

/* ================================================== filtros na URL (restantes) */

test.describe('filtros na URL nas outras listas (ADM-31)', () => {
  test.use({ storageState: sessao('master') })

  test('#135 financeiro › transferências: busca, status e destino — F5 mantém', async ({ page }) => {
    await abrir(page, `/admin/evento/${ev.id}/financeiro`)
    await page.locator('#q').fill('Fazenda')
    await page.locator('#st').selectOption('concluida')
    await page.locator('#dt').selectOption({ index: 1 })
    const destino = await page.locator('#dt').inputValue()
    await expect(page).toHaveURL(/busca=Fazenda/)
    await expect(page).toHaveURL(/status=concluida/)
    await expect(page).toHaveURL(new RegExp(`destino=${destino}`))
    await page.reload()
    await expect(page.locator('#q')).toHaveValue('Fazenda')
    await expect(page.locator('#st')).toHaveValue('concluida')
    await expect(page.locator('#dt')).toHaveValue(destino)
  })

  test('#85 cortesias: a busca ?q= volta do F5', async ({ page }) => {
    await abrir(page, `/admin/evento/${ev.id}/ingressos/cortesias`)
    await page.getByPlaceholder('Buscar por nome, motivo, quem pediu…').fill('Convidado')
    await expect(page).toHaveURL(/q=Convidado/)
    await page.reload()
    await expect(page.getByPlaceholder('Buscar por nome, motivo, quem pediu…')).toHaveValue('Convidado')
  })

  test('#113 sessões: "Mostrar dias passados" é ?passadas=1 e volta do F5', async ({ page }) => {
    await abrir(page, `/admin/evento/${vazio.id}/ingressos/sessoes`)
    await page.getByRole('button', { name: /Mostrar dias passados/ }).click()
    await expect(page).toHaveURL(/passadas=1/)
    await page.reload()
    await expect(page.getByRole('button', { name: 'Esconder dias passados' })).toBeVisible()
    await page.getByRole('button', { name: 'Esconder dias passados' }).click()
    await expect(page).not.toHaveURL(/passadas=/)
  })
})

/* ======================================================= financeiro › borderô */

test.describe('financeiro › borderô', () => {
  test.use({ storageState: sessao('master') })

  test('#139 imprimir leva só a folha: menu, topo e abas somem no papel e voltam depois (ADM-47)', async ({ page }) => {
    await abrir(page, `/admin/evento/${ev.id}/financeiro/bordero`)
    await page.evaluate(() => { (window as any).__impressoes = 0; window.print = () => { (window as any).__impressoes++ } })
    await page.getByRole('button', { name: 'Imprimir' }).click()
    expect(await page.evaluate(() => (window as any).__impressoes)).toBe(1)
    await page.emulateMedia({ media: 'print' })
    // no papel: tudo o que aparece ou é a folha, ou está dentro dela, ou é o caminho até ela
    const vazou = await page.evaluate(() => {
      const folha = document.querySelector('.folha-bordero')!
      const fora: string[] = []
      for (const el of Array.from(document.body.querySelectorAll('*'))) {
        if (folha.contains(el) || el.contains(folha)) continue
        const r = el.getBoundingClientRect()
        const st = getComputedStyle(el)
        if (r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none' && (el.textContent ?? '').trim()) {
          fora.push(`${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}: ${(el.textContent ?? '').trim().slice(0, 40)}`)
        }
      }
      return fora
    })
    expect(vazou, 'pedaço do painel indo pro papel').toEqual([])
    await expect(page.locator('[data-parte="resultado"]')).toBeVisible()
    // depois de imprimir, o painel volta inteiro
    await page.emulateMedia({ media: 'screen' })
    await page.evaluate(() => window.dispatchEvent(new Event('afterprint')))
    expect(await page.locator('.fora-da-impressao').count()).toBe(0)
  })

  test('#140 o CSV tem os mesmos números da linha Resultado da tela', async ({ page }) => {
    await abrir(page, `/admin/evento/${ev.id}/financeiro/bordero`)
    const naTela = await page.locator('[data-parte="resultado"] > div').evaluateAll((ls) =>
      ls.map((l) => (l.querySelector('dd')?.textContent ?? '').replace(/\s+/g, ' ').trim()))
    const [baixado] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /Exportar/ }).click()])
    const csv = await textoDoDownload(baixado)
    const bloco = csv.slice(csv.indexOf('"Resultado"'))
    for (const valor of naTela) {
      // o sinal vai no valor ("-R$ 3,00"); na tela ele fica na coluna do sinal
      expect(bloco, `o CSV não tem ${valor}`).toContain(valor.replace(/^−\s*/, ''))
    }
  })
})

/* ============================================================ relatórios */

test.describe('relatórios › extrato', () => {
  test.use({ storageState: sessao('master') })

  test('#38 #39 venda de balcão cancelada fica marcada e fora do total; o CSV neutraliza fórmula (ADM-61, ADM-35)', async ({ page }) => {
    const e = await criarEvento(master)
    const b = await abrirBalcao(master, e.id)
    await venderNoBalcao(master, e.id, b.turnoId, [{ lotId: e.lote.id, ticketTypeId: e.inteira, quantidade: 1 }],
      // o balcão só cria cadastro com e-mail (o envio é o simulado: sem SMTP_URL, vira .eml na pasta temporária)
      'dinheiro', { recebidoCents: 3000, comprador: { nome: '=1+1', email: 'extrato.f3@teste.invalido' } })
    const desfeita = await venderNoBalcao(master, e.id, b.turnoId,
      [{ lotId: e.lote.id, ticketTypeId: e.inteira, quantidade: 1 }], 'debito')
    await corpo(await master.post(`/api/admin/evento/${e.id}/pdv/cancelamento`, {
      data: { pedidoId: desfeita.pedidoId, motivo: 'Operador digitou 2 em vez de 1' },
    }))
    await abrir(page, `/admin/evento/${e.id}/relatorios/extrato`)
    await page.getByRole('button', { name: 'Tudo', exact: true }).click()
    const cobrado = page.locator('.card', { has: page.locator('.rotulo-kpi', { hasText: 'Cobrado do comprador' }) })
    await expect(cobrado.locator('.numero-kpi')).toHaveText('R$ 30,00')
    await expect(page.locator('[data-parte="fora-do-total"]')).toContainText('1 pedido com R$ 30,00')
    await expect(page.locator('tbody')).toContainText(desfeita.codigoPedido)

    const [baixado] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /Exportar/ }).click()])
    const csv = await textoDoDownload(baixado)
    expect(csv).toContain(`"'=1+1"`)
  })

  test('#35 #36 filtro de forma e canal: os totais seguem o filtro, e o F5 mantém (estão na URL)', async ({ page }) => {
    const e = await criarEvento(master)
    const b = await abrirBalcao(master, e.id)
    await venderNoBalcao(master, e.id, b.turnoId, [{ lotId: e.lote.id, ticketTypeId: e.inteira, quantidade: 1 }],
      'dinheiro', { recebidoCents: 3000 })
    await venderNoBalcao(master, e.id, b.turnoId, [{ lotId: e.lote.id, ticketTypeId: e.inteira, quantidade: 2 }], 'debito')
    await abrir(page, `/admin/evento/${e.id}/relatorios/extrato`)
    await page.getByRole('button', { name: 'Tudo', exact: true }).click()
    const cobrado = page.locator('.card', { has: page.locator('.rotulo-kpi', { hasText: 'Cobrado do comprador' }) }).locator('.numero-kpi')
    await expect(cobrado).toHaveText('R$ 90,00')
    const [, , formaSel] = await page.locator('select.campo').all()
    await formaSel.selectOption('dinheiro')
    await expect(page).toHaveURL(/forma=dinheiro/)
    await expect(cobrado).toHaveText('R$ 30,00')
    await page.locator('select.campo').first().selectOption('bilheteria')
    await expect(page).toHaveURL(/canal=bilheteria/)
    await page.reload()
    await expect(page.locator('select.campo').nth(2)).toHaveValue('dinheiro')
    await expect(page.locator('select.campo').first()).toHaveValue('bilheteria')
    await expect(cobrado).toHaveText('R$ 30,00')
  })

  test('#8 Operação abre o extrato pelo link: o recado do papel, nunca "confira a rede"', async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: sessao('operacao') })
    const page = await ctx.newPage()
    await abrir(page, `/admin/evento/${ev.id}/relatorios/extrato`)
    await expect(page.locator('[data-parte="falha-extrato"]')).toContainText('Seu acesso é de Operação')
    await ctx.close()
  })
})

/* ================================================== validação › histórico */

test.describe('validação › histórico', () => {
  test.use({ storageState: sessao('master') })

  test('#173 #174 #175 filtros e página na URL (F5 mantém); o código lido "=1+1" sai neutralizado (ADM-31, ADM-14)', async ({ page }) => {
    const e = await criarEvento(master)
    const b = await abrirBalcao(master, e.id)
    const venda = await venderNoBalcao(master, e.id, b.turnoId,
      [{ lotId: e.lote.id, ticketTypeId: e.inteira, quantidade: 1 }], 'pix')
    const ler = async (qr: string, gate: string) => corpo(await master.post('/api/checkin', { data: { qr, eventId: e.id, gate } }))
    await ler(venda.ingressos[0].qr, 'Norte')
    await ler(venda.ingressos[0].qr, 'Sul')
    await ler('=1+1', 'Sul')
    await abrir(page, `/admin/evento/${e.id}/validacao/historico`)
    await page.locator('#r').selectOption('ja_usado')
    await expect(page).toHaveURL(/resultado=ja_usado/)
    await page.locator('#g').selectOption('Sul')
    await expect(page).toHaveURL(/portao=Sul/)
    await page.reload()
    await expect(page.locator('#r')).toHaveValue('ja_usado')
    await expect(page.locator('#g')).toHaveValue('Sul')
    await expect(page.locator('tbody tr')).toHaveCount(1)

    await page.locator('#r').selectOption('invalido')
    await expect(page.locator('tbody tr')).toHaveCount(1)
    const [baixado] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /Exportar página/ }).click()])
    const csv = await textoDoDownload(baixado)
    expect(csv).toContain(`"'=1+1"`)
  })
})

/* ================================================================== papéis */

const TELAS_DO_EVENTO = [
  'dashboard', 'relatorios', 'relatorios/extrato', 'relatorios/lotes', 'vendas', 'vendas/participantes',
  'vendas/transferencias', 'ingressos', 'ingressos/cortesias', 'ingressos/cupons', 'ingressos/sessoes',
  'ingressos/ordenar', 'ingressos/passaportes', 'ingressos/promoters', 'assentos', 'configuracoes',
  'financeiro', 'financeiro/bordero', 'pdv', 'pdv/caixa', 'validacao', 'validacao/historico',
] as const

/** a tela abriu de verdade, ou mostrou o recado do papel? (nunca em branco, nunca 500) */
async function oQueAbriu(page: Page, tela: string) {
  const problemas = vigiar(page)
  await abrir(page, `/admin/evento/${ev.id}/${tela}`)
  const texto = limpo(await page.locator('main').first().innerText().catch(() => page.locator('body').innerText()))
  expect(texto.length, `${tela}: tela em branco`).toBeGreaterThan(30)
  expect(problemas.filter((p) => /^5\d\d |exceção/.test(p)), `${tela}: ${problemas.join(' | ')}`).toEqual([])
  return /Seu acesso/.test(texto) ? 'recado' : 'abriu'
}

test.describe('papéis', () => {
  test.describe('master', () => {
    test.use({ storageState: sessao('master') })
    test('#177 master: todas as telas do evento abrem, sem recado de acesso', async ({ page }) => {
      test.setTimeout(300_000)
      for (const tela of TELAS_DO_EVENTO) expect(await oQueAbriu(page, tela), tela).toBe('abriu')
    })
  })

  test.describe('financeiro', () => {
    test.use({ storageState: sessao('financeiro') })
    test('#178 financeiro: dinheiro e vendas abrem; ingressos, balcão, leitor e configurações dão o recado', async ({ page }) => {
      test.setTimeout(300_000)
      for (const tela of ['dashboard', 'relatorios', 'financeiro', 'financeiro/bordero', 'vendas']) {
        expect(await oQueAbriu(page, tela), tela).toBe('abriu')
      }
      for (const tela of ['ingressos', 'ingressos/cortesias', 'pdv', 'validacao', 'configuracoes']) {
        expect(await oQueAbriu(page, tela), tela).toBe('recado')
      }
    })
    test('o painel do Financeiro não tem atalho pra tela que ele não abre (achado do E2E)', async ({ page }) => {
      await abrir(page, `/admin/evento/${ev.id}/dashboard`)
      for (const resto of ['/ingressos/sessoes', '/validacao/historico', '/validacao']) {
        await expect(page.locator(`main a[href="/admin/evento/${ev.id}${resto}"]`), resto).toHaveCount(0)
      }
    })
  })

  test.describe('operação', () => {
    test.use({ storageState: sessao('operacao') })
    test('#179 operação: ingressos, configurações, vendas, balcão, leitor e histórico abrem; dinheiro dá o recado', async ({ page }) => {
      test.setTimeout(300_000)
      for (const tela of ['ingressos', 'configuracoes', 'vendas', 'pdv', 'validacao', 'validacao/historico']) {
        expect(await oQueAbriu(page, tela), tela).toBe('abriu')
      }
      for (const tela of ['dashboard', 'relatorios', 'financeiro']) {
        expect(await oQueAbriu(page, tela), tela).toBe('recado')
      }
    })
  })

  test.describe('portaria', () => {
    test.use({ storageState: sessao('portaria') })
    test('#180 #8 portaria: só o leitor; o resto dá o recado do papel (vendas incluída)', async ({ page }) => {
      test.setTimeout(300_000)
      expect(await oQueAbriu(page, 'validacao')).toBe('abriu')
      for (const tela of ['vendas', 'dashboard', 'ingressos', 'validacao/historico']) {
        expect(await oQueAbriu(page, tela), tela).toBe('recado')
      }
    })
  })
})
