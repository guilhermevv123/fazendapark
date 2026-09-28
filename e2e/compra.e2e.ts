/**
 * A compra do cliente, de ponta a ponta, com as variações que uma pessoa faz de verdade:
 * escolhe e desiste, passa do teto, é meia-entrada, erra a data, erra o cupom, aperta F5 com o
 * PIX na tela, clica duas vezes em pagar, volta e avança no navegador.
 *
 * Tudo pelo navegador, contra a instância de E2E (gateway simulado — `PAGAMENTO_SIMULADO=1`).
 * O CEP é o único serviço de fora que a tela chama (ViaCEP); aqui ele é respondido pelo próprio
 * teste, pra o caso não depender da internet nem ficar vermelho por causa dela.
 */
import { expect, test } from '@playwright/test'
import { hidratada, travaDeBase, vigiar } from './apoio'
import {
  SLUG, abrirVitrine, botaoIrPagar, botaoPagar, cpfDeTeste, irParaPagamento, mais, menos, preencherDados,
} from './compra-apoio'

travaDeBase()

test.describe('vitrine: escolher os ingressos', () => {
  test('o "−" começa travado, o "+" soma e o total é o que sai do bolso (taxa dentro)', async ({ page }) => {
    const problemas = vigiar(page)
    await abrirVitrine(page)
    await expect(menos(page, 'Inteira')).toBeDisabled()
    await mais(page, 'Inteira').click()
    await mais(page, 'Inteira').click()
    await expect(menos(page, 'Inteira')).toBeEnabled()
    // 2 inteiras de sábado: R$ 33,00 cada (face 30 + taxa 3) — o seed garante esses números
    await expect(page.getByText('R$ 66,00').first()).toBeVisible()
    await menos(page, 'Inteira').click()
    await expect(page.getByText('R$ 33,00').first()).toBeVisible()
    await menos(page, 'Inteira').click()
    await expect(menos(page, 'Inteira')).toBeDisabled()
    await expect(botaoIrPagar(page)).toBeDisabled()
    expect(problemas).toEqual([])
  })

  test('o teto da linha trava o "+" no 10º ingresso', async ({ page }) => {
    await abrirVitrine(page)
    for (let i = 0; i < 10; i++) await mais(page, 'Inteira').click()
    await expect(mais(page, 'Inteira')).toBeDisabled()
  })

  test('passar do teto do PEDIDO avisa antes do formulário e trava o botão', async ({ page }) => {
    await abrirVitrine(page)
    // 10 inteiras de sábado + 10 de domingo + 1 combo = 21 > 20 (events.max_per_order do seed)
    for (let i = 0; i < 10; i++) await mais(page, 'Inteira', 0).click()
    for (let i = 0; i < 10; i++) await mais(page, 'Inteira', 1).click()
    await page.getByRole('button', { name: /Adicionar um COMBO/ }).first().click()
    await expect(page.getByText(/no máximo 20 ingressos e você escolheu 21/).first()).toBeVisible()
    await expect(botaoIrPagar(page)).toBeDisabled()
    // tirou um: volta a poder pagar
    await page.getByRole('button', { name: /Remover um COMBO/ }).first().click()
    await expect(botaoIrPagar(page)).toBeEnabled()
  })

  test('meia-entrada pede o motivo; estudante pede o número, idoso não', async ({ page }) => {
    await abrirVitrine(page)
    await mais(page, 'Meia-entrada').click()
    await expect(page.getByText('Meia-entrada: quem tem direito?').first()).toBeVisible()
    await expect(botaoIrPagar(page)).toBeDisabled()

    const motivo = page.locator('select[id^="motivo-"]').first()
    await motivo.selectOption('estudante')
    const numero = page.locator('input[id^="doc-"]').first()
    await expect(numero).toBeVisible()
    await expect(page.getByText(/Leve na entrada: Carteira de Identificação Estudantil/)).toBeVisible()
    await expect(botaoIrPagar(page)).toBeDisabled()
    await numero.fill('CIE-2026-000123')
    await expect(botaoIrPagar(page)).toBeEnabled()

    // troca de ideia: idoso não tem número pra digitar
    await motivo.selectOption('idoso')
    await expect(page.locator('input[id^="doc-"]')).toHaveCount(0)
    await expect(botaoIrPagar(page)).toBeEnabled()

    // tirou a meia: o bloco some junto (e não sobra declaração velha no carrinho)
    await menos(page, 'Meia-entrada').click()
    await expect(page.getByText('Meia-entrada: quem tem direito?')).toHaveCount(0)
  })

  test('F5 na vitrine não quebra nada: a página volta limpa e deixa escolher de novo', async ({ page }) => {
    const problemas = vigiar(page)
    await abrirVitrine(page)
    await mais(page, 'Inteira').click()
    await page.reload()
    await hidratada(page)
    await expect(menos(page, 'Inteira')).toBeDisabled()
    await mais(page, 'Inteira').click()
    await expect(botaoIrPagar(page)).toBeEnabled()
    expect(problemas).toEqual([])
  })

  test('evento que não existe responde com página de "não encontrado", não com erro 500', async ({ page }) => {
    const r = await page.goto('/e/evento-que-nao-existe-e2e')
    expect(r?.status()).toBe(404)
  })
})

test.describe('pagamento: dados do comprador', () => {
  test('entrar no pagamento sem carrinho (link direto) devolve pra vitrine', async ({ page }) => {
    await page.goto(`/e/${SLUG}/pagamento`)
    await expect(page).toHaveURL(new RegExp(`/e/${SLUG}$`))
  })

  test('o resumo chega com o mesmo total da vitrine', async ({ page }) => {
    await abrirVitrine(page)
    await mais(page, 'Inteira').click()
    await mais(page, 'Inteira', 1).click()
    await irParaPagamento(page)
    // 33,00 (sábado) + 30,00 (domingo)
    await expect(page.getByText('R$ 63,00').first()).toBeVisible()
  })

  test('voltar e avançar no navegador: o carrinho continua lá', async ({ page }) => {
    await abrirVitrine(page)
    await mais(page, 'Inteira').click()
    await irParaPagamento(page)
    await page.goBack()
    await expect(page).toHaveURL(new RegExp(`/e/${SLUG}$`))
    await page.goForward()
    await hidratada(page)
    await expect(page.locator('#nome')).toBeVisible()
    await expect(page.getByText('R$ 33,00').first()).toBeVisible()
  })

  test('formulário vazio: o navegador segura e nenhuma cobrança é criada', async ({ page }) => {
    let checkouts = 0
    page.on('request', (r) => { if (r.url().endsWith('/api/checkout') && r.method() === 'POST') checkouts++ })
    await abrirVitrine(page)
    await mais(page, 'Inteira').click()
    await irParaPagamento(page)
    await botaoPagar(page).click()
    await page.waitForTimeout(600)
    expect(checkouts).toBe(0)
    await expect(page.locator('#nome')).toBeFocused()
  })

  test('as máscaras formatam CPF, celular e data enquanto digita', async ({ page }) => {
    await abrirVitrine(page)
    await mais(page, 'Inteira').click()
    await irParaPagamento(page)
    await page.locator('#cpf').pressSequentially('52998224725')
    await expect(page.locator('#cpf')).toHaveValue('529.982.247-25')
    await page.locator('#tel').pressSequentially('73998260963')
    await expect(page.locator('#tel')).toHaveValue('(73) 99826-0963')
    await page.locator('#nascimento').pressSequentially('25121990')
    await expect(page.locator('#nascimento')).toHaveValue('25/12/1990')
  })

  test('data de nascimento incompleta: recado no campo, sem chamar o servidor', async ({ page }) => {
    let checkouts = 0
    page.on('request', (r) => { if (r.url().endsWith('/api/checkout') && r.method() === 'POST') checkouts++ })
    await abrirVitrine(page)
    await mais(page, 'Inteira').click()
    await irParaPagamento(page)
    await preencherDados(page, { nascimento: '25/12' })
    await botaoPagar(page).click()
    await expect(page.getByText(/Confira a data de nascimento/)).toBeVisible()
    await expect(page.locator('#nascimento')).toBeFocused()
    expect(checkouts).toBe(0)
  })

  test('data que não existe (31/02) é recusada pelo servidor e o foco vai pro campo', async ({ page }) => {
    const problemas = vigiar(page)
    await abrirVitrine(page)
    await mais(page, 'Inteira').click()
    await irParaPagamento(page)
    await preencherDados(page, { nascimento: '31/02/1990' })
    await botaoPagar(page).click()
    await expect(page.locator('.faixa-erro').first()).toBeVisible()
    await expect(page.locator('#nascimento')).toBeFocused()
    await expect(page.getByText('Pague com PIX')).toHaveCount(0)
    expect(problemas.filter((p) => !p.startsWith('console'))).toEqual([])
  })

  test('CPF com dígito errado é recusado com recado na tela (sem 500)', async ({ page }) => {
    const problemas = vigiar(page)
    await abrirVitrine(page)
    await mais(page, 'Inteira').click()
    await irParaPagamento(page)
    await preencherDados(page, { cpf: '52998224724' })
    await botaoPagar(page).click()
    await expect(page.getByText(/CPF inválido/i)).toBeVisible()
    expect(problemas.filter((p) => !p.startsWith('console'))).toEqual([])
  })

  test('CEP: achou preenche o endereço; não existe avisa; serviço fora avisa — nenhum trava a compra', async ({ page }) => {
    await abrirVitrine(page)
    await mais(page, 'Inteira').click()
    await irParaPagamento(page)

    let resposta: 'achou' | 'nao_existe' | 'fora' = 'achou'
    await page.route('https://viacep.com.br/**', (rota) => {
      if (resposta === 'fora') return rota.abort()
      return rota.fulfill({
        contentType: 'application/json',
        body: JSON.stringify(resposta === 'achou'
          ? { cep: '45550-000', localidade: 'Ubatã', uf: 'BA', logradouro: 'Rua do Parque', bairro: 'Centro' }
          : { erro: true }),
      })
    })

    await page.locator('#cep').pressSequentially('45550000')
    await expect(page.locator('#cidade')).toHaveValue('Ubatã')
    await expect(page.locator('#estado')).toHaveValue('BA')
    await expect(page.locator('#rua')).toHaveValue('Rua do Parque')

    resposta = 'nao_existe'
    await page.locator('#cep').fill('')
    await page.locator('#cep').pressSequentially('99999999')
    await expect(page.getByText(/Não achamos esse CEP/)).toBeVisible()

    resposta = 'fora'
    await page.locator('#cep').fill('')
    await page.locator('#cep').pressSequentially('45550001')
    await expect(page.getByText(/Não deu pra buscar o CEP agora/)).toBeVisible()
  })

  test('F5 com os dados meio preenchidos: o carrinho fica (os dados digitados não — sem cobrança criada)', async ({ page }) => {
    await abrirVitrine(page)
    await mais(page, 'Inteira').click()
    await irParaPagamento(page)
    await page.locator('#nome').fill('Pessoa que Apertou F5')
    await page.reload()
    await hidratada(page)
    await expect(page.locator('#nome')).toBeVisible()
    await expect(page.getByText('R$ 33,00').first()).toBeVisible()
    // registro do comportamento atual: o formulário não é guardado antes da cobrança existir
    test.info().annotations.push({ type: 'observação', description: `nome depois do F5: "${await page.locator('#nome').inputValue()}"` })
  })
})

test.describe('cupom', () => {
  test('cupom que não existe: recado colado no campo e "Continuar sem o cupom" segue a compra', async ({ page }) => {
    await abrirVitrine(page)
    await mais(page, 'Inteira').click()
    await irParaPagamento(page)
    await preencherDados(page)
    await page.locator('#cupom').fill('NAOEXISTE2026')
    await page.locator('#cupom').blur()
    const semCupom = page.getByRole('button', { name: 'Continuar sem o cupom' })
    await expect(semCupom).toBeVisible()
    await semCupom.click()
    await expect(page.getByText('Pague com PIX')).toBeVisible()
    await expect(page.getByText('R$ 33,00').first()).toBeVisible()
  })

  test('cupom VIZINHO (15%): a tela mostra o desconto antes e a cobrança sai com ele', async ({ page }) => {
    await abrirVitrine(page)
    await mais(page, 'Inteira').click()
    await irParaPagamento(page)
    await preencherDados(page)
    await page.locator('#cupom').fill('vizinho')
    await page.locator('#cupom').blur()
    await expect(page.getByText(/Desconto de/)).toBeVisible()
    await botaoPagar(page).click()
    await expect(page.getByText('Pague com PIX')).toBeVisible()
    await expect(page.getByText(/Cupom aplicado: −R\$/)).toBeVisible()
    // o desconto é sobre o valor de face (R$ 30,00 → R$ 4,50); a taxa não entra no desconto
    const cabecalho = await page.locator('section').filter({ hasText: 'Pedido' }).first().innerText()
    test.info().annotations.push({ type: 'cobrança com VIZINHO', description: cabecalho.split('\n').slice(0, 3).join(' | ') })
    await expect(page.getByText('Cupom aplicado')).toBeVisible()
  })

  test('cupom IMPRENSA (100%): cobre o ingresso inteiro, a taxa de serviço continua — e o pagamento emite', async ({ page }) => {
    // Regra do sistema (server/utils/cupom.ts): desconto nunca passa do valor de FACE. O evento do
    // seed repassa 10% de taxa, então o "100%" deixa R$ 3,00 pra pagar. Nos eventos criados pelo
    // painel a taxa padrão é 0% (ordem do dono, 23/09) e aí o pedido nasce pago, sem gateway.
    await abrirVitrine(page)
    await mais(page, 'Inteira').click()
    await irParaPagamento(page)
    await preencherDados(page)
    await page.locator('#cupom').fill('IMPRENSA')
    await page.locator('#cupom').blur()
    await expect(page.getByText(/Desconto de/)).toBeVisible()
    await botaoPagar(page).click()
    await expect(page.getByRole('heading', { name: 'Pague com PIX' })).toBeVisible()
    await expect(page.getByText('Cupom aplicado: −R$ 30,00')).toBeVisible()
    await expect(page.getByText(/Pedido\s+PED-\S+\s+·\s+R\$ 3,00/)).toBeVisible()
    await page.getByRole('button', { name: 'Simular pagamento recebido' }).click()
    await expect(page.getByRole('heading', { name: 'Ingressos emitidos' })).toBeVisible()
    // F5 depois de pago: vai pro ingresso, não pra vitrine
    await page.reload()
    await expect(page).toHaveURL(/\/ingressos\//)
  })
})

test.describe('pagar e receber o ingresso', () => {
  test('PIX: QR na tela, F5 não perde a cobrança, simular pagamento emite o ingresso', async ({ page, context }) => {
    const problemas = vigiar(page)
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await abrirVitrine(page)
    await mais(page, 'Inteira').click()
    await mais(page, 'Inteira').click()
    await irParaPagamento(page)
    await preencherDados(page)
    const [resposta] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith('/api/checkout') && r.request().method() === 'POST'),
      botaoPagar(page).click(),
    ])
    const codigo: string = (await resposta.json()).pedido
    expect(codigo, 'número do pedido na resposta do checkout').toMatch(/^PED-/)

    await expect(page.getByRole('heading', { name: 'Pague com PIX' })).toBeVisible()
    await expect(page.getByText(codigo).first()).toBeVisible()
    await expect(page.getByAltText('QR Code do PIX')).toBeVisible()
    await expect(page.getByText(/reservados por/)).toBeVisible()

    await page.getByRole('button', { name: 'Copiar código PIX' }).click()
    await expect(page.getByRole('button', { name: 'Copiado!' })).toBeVisible()
    const copiado = await page.evaluate(() => navigator.clipboard.readText())
    expect(copiado).toMatch(/^000201/) // BR Code começa assim


    // F5 com o PIX na tela: a mesma cobrança volta, não a vitrine
    await page.reload()
    await hidratada(page)
    await expect(page.getByRole('heading', { name: 'Pague com PIX' })).toBeVisible()
    await expect(page.getByText(codigo).first()).toBeVisible()

    await page.getByRole('button', { name: 'Simular pagamento recebido' }).click()
    await expect(page.getByRole('heading', { name: 'Ingressos emitidos' })).toBeVisible()
    const qrs = page.getByAltText(/QR do ingresso/)
    await expect(qrs).toHaveCount(2)
    // o QR carregou de verdade (não é quadrado vazio)
    await expect.poll(() => qrs.first().evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true)

    await page.getByRole('link', { name: 'Ver e guardar meus ingressos' }).click()
    await expect(page).toHaveURL(new RegExp(`/ingressos/${codigo}`))
    await hidratada(page)
    await expect(page.getByText(codigo).first()).toBeVisible()
    expect(problemas).toEqual([])
  })

  test('duplo clique em "Pagar com PIX" cria UMA cobrança só', async ({ page }) => {
    let checkouts = 0
    page.on('request', (r) => { if (r.url().endsWith('/api/checkout') && r.method() === 'POST') checkouts++ })
    await abrirVitrine(page)
    await mais(page, 'Inteira').click()
    await irParaPagamento(page)
    await preencherDados(page)
    await botaoPagar(page).dblclick()
    await expect(page.getByRole('heading', { name: 'Pague com PIX' })).toBeVisible()
    expect(checkouts).toBe(1)
  })

  test('cartão: as parcelas respeitam o piso de R$ 5,00 e trocar pra PIX e voltar mantém a escolha', async ({ page }) => {
    await abrirVitrine(page)
    await mais(page, 'Inteira').click() // R$ 33,00 → no máximo 6× (33/5 = 6,6)
    await irParaPagamento(page)
    await page.getByRole('button', { name: 'Cartão de crédito' }).click()
    const parcelas = page.locator('#parcelas')
    await expect(parcelas).toBeVisible()
    await expect(parcelas.locator('option')).toHaveCount(6)
    await expect(parcelas.locator('option').first()).toHaveText(/À vista — R\$ 33,00/)
    await parcelas.selectOption('3')
    await expect(botaoPagar(page)).toHaveText('Pagar com cartão')
    await page.getByRole('button', { name: 'PIX — na hora' }).click()
    await expect(parcelas).toHaveCount(0)
    await expect(botaoPagar(page)).toHaveText('Pagar com PIX')
    await page.getByRole('button', { name: 'Cartão de crédito' }).click()
    await expect(page.locator('#parcelas')).toHaveValue('3')
  })

  test('cartão em 3×: a cobrança nasce, a tela explica o cartão e o pagamento simulado emite', async ({ page }) => {
    const problemas = vigiar(page)
    await abrirVitrine(page)
    await mais(page, 'Inteira').click()
    await mais(page, 'Inteira').click()
    await irParaPagamento(page)
    await preencherDados(page)
    await page.getByRole('button', { name: 'Cartão de crédito' }).click()
    await page.locator('#parcelas').selectOption('3')
    await botaoPagar(page).click()
    await expect(page.getByRole('heading', { name: 'Pague com cartão' })).toBeVisible()
    await expect(page.getByText(/ambiente seguro do Asaas/)).toBeVisible()
    await page.getByRole('button', { name: 'Simular pagamento recebido' }).click()
    await expect(page.getByRole('heading', { name: 'Ingressos emitidos' })).toBeVisible()
    await expect(page.getByAltText(/QR do ingresso/)).toHaveCount(2)
    expect(problemas).toEqual([])
  })

  test('meia-entrada com estudante vai até o ingresso (a declaração atravessa o checkout)', async ({ page }) => {
    const problemas = vigiar(page)
    await abrirVitrine(page)
    await mais(page, 'Meia-entrada').click()
    await page.locator('select[id^="motivo-"]').first().selectOption('estudante')
    await page.locator('input[id^="doc-"]').first().fill('CIE-2026-777')
    await irParaPagamento(page)
    await expect(page.getByText(/Estudante/).first()).toBeVisible()
    await preencherDados(page)
    await botaoPagar(page).click()
    await expect(page.getByRole('heading', { name: 'Pague com PIX' })).toBeVisible()
    await expect(page.getByText('R$ 16,50').first()).toBeVisible()
    await page.getByRole('button', { name: 'Simular pagamento recebido' }).click()
    await expect(page.getByRole('heading', { name: 'Ingressos emitidos' })).toBeVisible()
    expect(problemas).toEqual([])
  })

  test('nome com HTML/script não executa nada em nenhuma tela da compra', async ({ page }) => {
    let dialogos = 0
    page.on('dialog', async (d) => { dialogos++; await d.dismiss() })
    await abrirVitrine(page)
    await mais(page, 'Inteira').click()
    await irParaPagamento(page)
    await preencherDados(page, { nome: 'Ana <img src=x onerror=alert(1)> <script>alert(2)</script>' })
    await botaoPagar(page).click()
    const chegou = await Promise.race([
      page.getByRole('heading', { name: 'Pague com PIX' }).waitFor().then(() => 'cobranca'),
      page.locator('.faixa-erro').first().waitFor().then(() => 'recusado'),
    ])
    test.info().annotations.push({ type: 'nome com HTML', description: chegou })
    if (chegou === 'cobranca') {
      await page.getByRole('button', { name: 'Simular pagamento recebido' }).click()
      await expect(page.getByRole('heading', { name: 'Ingressos emitidos' })).toBeVisible()
      await page.getByRole('link', { name: 'Ver e guardar meus ingressos' }).click()
      await hidratada(page)
    }
    await page.waitForTimeout(800)
    expect(dialogos).toBe(0)
  })
})
