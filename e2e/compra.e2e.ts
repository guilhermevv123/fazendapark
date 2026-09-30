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
  SLUG, SENHA_DE_TESTE, abrirVitrine, botaoIrPagar, botaoPagar, cpfDeTeste, criarConta, irParaPagamento, mais, menos,
  pagar, preencherDados,
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

  // B19 (frota F1, 28/09): o F5 GUARDA a escolha (antes voltava limpa e a pessoa perdia o carrinho).
  // Aqui o que se confere é mexer DEPOIS do F5: tirar até zerar trava o pagamento, pôr de novo solta.
  test('F5 na vitrine mantém a escolha e deixa mexer de novo: tirar zera e trava, pôr solta', async ({ page }) => {
    const problemas = vigiar(page)
    await abrirVitrine(page)
    await mais(page, 'Inteira').click()
    await page.reload()
    await hidratada(page)
    await expect(menos(page, 'Inteira')).toBeEnabled()
    await expect(botaoIrPagar(page)).toBeEnabled()
    await menos(page, 'Inteira').click()
    await expect(menos(page, 'Inteira')).toBeDisabled()
    await expect(botaoIrPagar(page)).toBeDisabled()
    await mais(page, 'Inteira').click()
    await expect(botaoIrPagar(page)).toBeEnabled()
    expect(problemas).toEqual([])
  })

  test('evento que não existe responde com página de "não encontrado", não com erro 500', async ({ page }) => {
    const r = await page.goto('/e/evento-que-nao-existe-e2e')
    expect(r?.status()).toBe(404)
  })
})

test.describe('pagamento: quem compra é a conta (034)', () => {
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
    await expect(page.locator('[data-parte="avancar"]')).toBeVisible()
    await expect(page.getByText('R$ 33,00').first()).toBeVisible()
  })

  test('sem conta: a janela de entrar abre sozinha, o checkout não pede dados e nenhuma cobrança nasce', async ({ page }) => {
    let checkouts = 0
    page.on('request', (r) => { if (r.url().endsWith('/api/checkout') && r.method() === 'POST') checkouts++ })
    await abrirVitrine(page)
    await mais(page, 'Inteira').click()
    await irParaPagamento(page)
    await expect(page.getByRole('dialog')).toBeVisible()
    await expect(page.getByRole('dialog')).toContainText('Pra comprar, entre na sua conta')
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    for (const id of ['nome', 'email', 'cpf', 'tel', 'nascimento', 'cidade']) {
      await expect(page.locator(`#${id}`), `o checkout voltou a pedir #${id}`).toHaveCount(0)
    }
    await expect(page.locator('[data-parte="avancar"]')).toBeDisabled()
    await page.waitForTimeout(300)
    expect(checkouts).toBe(0)
  })

  test('criar conta pela janela: máscaras no CPF e celular, e a compra segue com os dados da conta', async ({ page }) => {
    await abrirVitrine(page)
    await mais(page, 'Inteira').click()
    await irParaPagamento(page)
    const janela = page.getByRole('dialog')
    await janela.getByRole('tab', { name: 'Criar conta' }).click()
    await janela.locator('#conta-nome').fill('Cliente da Janela Teste')
    await janela.locator('#conta-cpf').pressSequentially(cpfDeTeste())
    await expect(janela.locator('#conta-cpf')).toHaveValue(/^\d{3}\.\d{3}\.\d{3}-\d{2}$/)
    await janela.locator('#conta-telefone').pressSequentially('73998260963')
    await expect(janela.locator('#conta-telefone')).toHaveValue('(73) 99826-0963')
    await janela.locator('#conta-email').fill(`janela.${Date.now()}@teste.invalido`)
    await janela.locator('#conta-senha-nova').fill(SENHA_DE_TESTE)
    await janela.getByRole('button', { name: 'Criar conta e continuar' }).click()
    await expect(janela).toHaveCount(0)
    await expect(page.locator('[data-parte="seus-dados"]')).toContainText('Cliente da Janela Teste')
    await expect(page.getByRole('button', { name: 'Entrar' })).toHaveCount(0)
  })

  test('CPF com dígito errado: a janela avisa na hora, no campo, e não envia (sem 500)', async ({ page }) => {
    const problemas = vigiar(page)
    await abrirVitrine(page)
    await mais(page, 'Inteira').click()
    await irParaPagamento(page)
    const janela = page.getByRole('dialog')
    await janela.getByRole('tab', { name: 'Criar conta' }).click()
    await janela.locator('#conta-nome').fill('Cliente do CPF Torto')
    await janela.locator('#conta-cpf').fill('52998224724')
    await janela.locator('#conta-telefone').fill('73998260963')
    await janela.locator('#conta-email').fill(`torto.${Date.now()}@teste.invalido`)
    await janela.locator('#conta-senha-nova').fill(SENHA_DE_TESTE)
    // avisa já no campo, antes de enviar (a mesma conta do servidor)
    await expect(janela.locator('[data-parte="cpf-invalido"]')).toHaveText('CPF inválido. Confira os 11 números.')
    await expect(janela.locator('#conta-cpf')).toHaveAttribute('aria-invalid', 'true')
    let foiAoServidor = false
    page.on('request', (q) => { if (q.url().includes('/api/conta/criar')) foiAoServidor = true })
    await janela.getByRole('button', { name: 'Criar conta e continuar' }).click()
    await expect(janela.getByRole('alert')).toContainText(/CPF/)
    await expect(janela.locator('#conta-cpf')).toHaveAttribute('aria-invalid', 'true')
    expect(foiAoServidor, 'mandou ao servidor um CPF que a tela já sabia torto').toBe(false)
    expect(problemas.filter((p) => !p.startsWith('console') && !p.includes('400'))).toEqual([])
  })

  test('entrar com CPF e senha de uma conta que já existe', async ({ page }) => {
    const { corpo } = await criarConta(page)
    await page.request.post('/api/conta/sair', { data: {} })
    await abrirVitrine(page)
    await mais(page, 'Inteira').click()
    await irParaPagamento(page)
    const janela = page.getByRole('dialog')
    await janela.locator('#conta-login').fill(corpo.cpf)
    await janela.locator('#conta-senha').fill(SENHA_DE_TESTE)
    await janela.getByRole('button', { name: 'Entrar', exact: true }).click()
    await expect(janela).toHaveCount(0)
    await expect(page.locator('[data-parte="seus-dados"]')).toContainText(corpo.nome)
  })

  test('F5 no pagamento com a conta aberta: carrinho e conta continuam', async ({ page }) => {
    await abrirVitrine(page)
    await mais(page, 'Inteira').click()
    await irParaPagamento(page)
    await preencherDados(page)
    await page.reload()
    await hidratada(page)
    await expect(page.locator('[data-parte="seus-dados"]')).toBeVisible()
    await expect(page.getByText('R$ 33,00').first()).toBeVisible()
  })
})

test.describe('conta: recuperar a senha e confirmar o e-mail (035)', () => {
  /** o link que o servidor de teste gravou no e-mail simulado (transporte sem SMTP) */
  async function linkDoEmail(email: string, caminho: string) {
    const { readdir, readFile } = await import('node:fs/promises')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const pasta = process.env.EMAIL_PASTA_SIMULADO || join(tmpdir(), 'diamond-tickets-envios')
    const chave = email.replace(/[^a-zA-Z0-9]/g, '_')
    for (let i = 0; i < 20; i++) {
      const nomes = (await readdir(pasta).catch(() => [] as string[])).filter((n) => n.includes(chave)).sort().reverse()
      for (const n of nomes) {
        const bruto = await readFile(join(pasta, n), 'utf8')
        const b64 = /Content-Type: text\/plain; charset=UTF-8\r?\nContent-Transfer-Encoding: base64\r?\n\r?\n([A-Za-z0-9+/=\r\n]+?)\r?\n--/.exec(bruto)?.[1] ?? ''
        const texto = Buffer.from(b64.replace(/\s/g, ''), 'base64').toString('utf8')
        const m = new RegExp(`(https?://[^\\s]*${caminho}\\?t=[A-Za-z0-9_%-]+)`).exec(texto)
        if (m) return new URL(m[1]!).pathname + new URL(m[1]!).search
      }
      await new Promise((r) => setTimeout(r, 250))
    }
    throw new Error(`nenhum e-mail com ${caminho} para ${email}`)
  }

  test('esqueci a senha pela janela: o link do e-mail cria a senha nova e já entra', async ({ page }) => {
    const { corpo } = await criarConta(page)
    await page.request.post('/api/conta/sair', { data: {} })
    await abrirVitrine(page)
    await mais(page, 'Inteira').click()
    await irParaPagamento(page)
    const janela = page.getByRole('dialog')
    await janela.locator('[data-parte="abrir-esqueci"]').click()
    await janela.locator('#conta-login').fill(corpo.cpf)
    await janela.getByRole('button', { name: 'Enviar o link' }).click()
    await expect(janela.locator('[data-parte="esqueci-enviado"]')).toContainText('Se existir uma conta')

    await page.goto(await linkDoEmail(corpo.email, '/conta/redefinir'))
    await hidratada(page)
    await expect(page.locator('[data-parte="nova-senha"]')).toBeVisible()
    await page.locator('#senha-nova').fill('senha-nova-do-e2e-7')
    await page.locator('#senha-repetir').fill('senha-nova-do-e2e-7')
    await page.getByRole('button', { name: 'Salvar a senha nova' }).click()
    await expect(page.locator('[data-parte="senha-trocada"]')).toBeVisible()
    // o mesmo link de novo: vencido
    await page.reload()
    await hidratada(page)
    await expect(page.locator('[data-parte="link-vencido"]')).toBeVisible()
    // e a senha nova entra
    await page.request.post('/api/conta/sair', { data: {} })
    const r = await page.request.post('/api/conta/entrar', { data: { login: corpo.cpf, senha: 'senha-nova-do-e2e-7', evento: SLUG } })
    expect(r.status()).toBe(200)
  })

  test('confirmar o e-mail: "Minha conta" pede, o link confirma e o aviso some', async ({ page }) => {
    const { corpo } = await criarConta(page)
    await page.goto('/conta')
    await hidratada(page)
    await expect(page.locator('[data-parte="confirmar-email"]')).toContainText(corpo.email)
    await page.goto(await linkDoEmail(corpo.email, '/conta/confirmar-email'))
    await hidratada(page)
    await expect(page.locator('[data-parte="email-confirmado"]')).toContainText(corpo.email)
    await page.goto('/conta')
    await hidratada(page)
    await expect(page.getByText('Olá,')).toBeVisible()
    await expect(page.locator('[data-parte="confirmar-email"]')).toHaveCount(0)
  })
})

// O campo de cupom está escondido no checkout por enquanto (pedido do dono, 28/09 — `MOSTRAR_CUPOM`
// em pagamento.vue). A régua do cupom segue coberta no servidor (checkout.test.ts, cupom.test.ts);
// estes voltam quando o campo voltar.
test.describe.skip('cupom (campo escondido por enquanto)', () => {
  test('cupom que não existe: recado colado no campo', async () => {})
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
      pagar(page),
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
    await page.locator('[data-parte="avancar"]').click()
    await botaoPagar(page).dblclick()
    await expect(page.getByRole('heading', { name: 'Pague com PIX' })).toBeVisible()
    expect(checkouts).toBe(1)
  })

  test('cartão: as parcelas respeitam o piso de R$ 5,00, débito é à vista e voltar pro Pix mantém a escolha', async ({ page }) => {
    await abrirVitrine(page)
    await mais(page, 'Inteira').click() // R$ 33,00 → no máximo 6× (33/5 = 6,6)
    await irParaPagamento(page)
    await preencherDados(page)
    await page.locator('[data-parte="avancar"]').click()
    await page.locator('[data-forma="credito"]').click()
    const parcelas = page.locator('#parcelas')
    await expect(parcelas).toBeVisible()
    await expect(parcelas.locator('option')).toHaveCount(6)
    await expect(parcelas.locator('option').first()).toHaveText(/À vista — R\$ 33,00/)
    await parcelas.selectOption('3')
    await expect(botaoPagar(page)).toHaveText('Pagar em 3× no crédito')
    await page.locator('[data-forma="debito"]').click()
    await expect(parcelas).toHaveCount(0)
    await expect(botaoPagar(page)).toHaveText('Pagar R$ 33,00 no débito')
    await page.locator('[data-forma="pix"]').click()
    await expect(botaoPagar(page)).toHaveText('Pagar R$ 33,00 com Pix')
    await page.locator('[data-forma="credito"]').click()
    await expect(page.locator('#parcelas')).toHaveValue('3')
  })

  test('cartão em 3×: a cobrança nasce, a tela explica o cartão e o pagamento simulado emite', async ({ page }) => {
    const problemas = vigiar(page)
    await abrirVitrine(page)
    await mais(page, 'Inteira').click()
    await mais(page, 'Inteira').click()
    await irParaPagamento(page)
    await preencherDados(page)
    await pagar(page, 'credito', '3')
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
    await pagar(page)
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
    // o nome com HTML vai na CONTA (é de lá que o pedido tira o comprador)
    const c = await criarConta(page, { nome: 'Ana <img src=x onerror=alert(1)> <script>alert(2)</script>' })
    let chegou = 'recusado'
    if (c.status === 200) {
      await page.reload()
      await hidratada(page)
      await pagar(page)
      chegou = await Promise.race([
        page.getByRole('heading', { name: 'Pague com PIX' }).waitFor().then(() => 'cobranca'),
        page.locator('.faixa-erro').first().waitFor().then(() => 'recusado'),
      ])
    }
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
