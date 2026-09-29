/**
 * publico.e2e.ts — o site de quem COMPRA, no navegador de verdade (Chrome do sistema, 1366×860).
 *
 * É a trilha F1 da auditoria do público (27/09): a vitrine, o pagamento, a página dos ingressos, a
 * transferência, a página de erro e a home — e a API pública que elas chamam. Cada caso diz no
 * título o número da `matriz[]` de `auditoria-publico.json` (ou o defeito B/PROD) que ele exercita;
 * é esse título que `frota/f1/cobertura.json` cita.
 *
 * Regras da casa pra bateria (e2e/apoio.ts): só contra a instância de E2E; o que o caso usa, ele
 * cria — pela MESMA API que uma tela chamaria (checkout, painel de cupom/promoter/transferência,
 * catraca) —, e o gateway é o simulado da máquina (`/api/dev/pagar`, `/api/dev/fatura/…`). O único
 * atalho de fora do navegador é o aviso do Asaas (`/api/webhooks/asaas`), que na máquina aceita sem
 * token: é assim que o estorno parcial e o total chegam, igual em produção.
 *
 *   E2E_BASE=http://127.0.0.1:3121 npx playwright test e2e/publico.e2e.ts
 */
import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test'
import { BASE, EVENTO_SEED, LOGINS, SENHA, hidratada, sessao, travaDeBase } from './apoio'

const SLUG = EVENTO_SEED.slug
const EVENTO_ID = EVENTO_SEED.id

test.beforeAll(() => travaDeBase(BASE))

/* ------------------------------------------------------------------ apoio */

/**
 * A página terminou de hidratar DE VEZ. O `__vue_app__` (o `hidratada` da casa) existe assim que o
 * Vue monta, mas página com `await useFetch` hidrata depois, dentro do <Suspense> — e um clique num
 * NuxtLink antes disso é navegação de DOCUMENTO (quem responde é o servidor), não do navegador. Foi
 * o que derrubou a "bilheteria fora do ar" numa rodada (27/09): o clique virou SSR e a consulta que
 * o caso derruba nunca saiu do navegador. `$nuxt.isHydrating` só vira false quando a raiz resolve.
 */
async function pronta(page: Page, timeout = 120_000) {
  await hidratada(page, timeout)
  await page.waitForFunction(
    () => (document.querySelector('#__nuxt') as any)?.__vue_app__?.$nuxt?.isHydrating === false, null, { timeout })
}

/**
 * A resposta de uma rota MEXIDA no navegador — pra pôr na tela um estado que o banco semeado não
 * tem (vendas fechadas, lote que ainda vai abrir, variação esgotada, evento em cada situação) sem
 * mexer no evento que os outros casos compram. Só pega a consulta que sai do NAVEGADOR: por isso
 * esses casos chegam na tela clicando, nunca com `goto` (no SSR quem pergunta é o servidor). O que a
 * ROTA decide sobre esses estados é da suíte vitest (`eventos-publicos.test.ts`, `e/slug.test.ts`);
 * aqui é a TELA, com o CSS de verdade.
 */
async function comResposta(page: Page, padrao: string, mexer: (j: any) => any) {
  await page.route(padrao, async (rota) => {
    const r = await rota.fetch()
    await rota.fulfill({ response: r, json: mexer(await r.json()) })
  })
}

/** 375×812 com toque — o "celular 375px" da matriz. */
const celular = (browser: Browser) => browser.newContext({
  viewport: { width: 375, height: 812 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  locale: 'pt-BR', timezoneId: 'America/Bahia',
})
const larguraDaPagina = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth)

/** CPF sintético que passa no dígito verificador. */
function cpf(): string {
  const d = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10))
  const dig = (arr: number[], peso: number) => {
    const r = (arr.reduce((a, n, i) => a + n * (peso - i), 0) * 10) % 11
    return r === 10 ? 0 : r
  }
  d.push(dig(d, 10)); d.push(dig(d, 11))
  return d.join('')
}
const sufixo = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
const emailNovo = (p = 'publico') => `e2e.${p}.${sufixo()}@teste.invalido`

/**
 * Vigia de console: erro, exceção, 5xx e — ao contrário do `vigiar` da casa — AVISO DE
 * HIDRATAÇÃO. O B24 é justamente o SSR e o navegador escrevendo textos diferentes.
 */
function vigia(page: Page) {
  const problemas: string[] = []
  page.on('console', (m) => {
    const t = m.text()
    if (/favicon|DevTools|\[vite\]|Download the Vue Devtools/i.test(t)) return
    if (m.type() === 'error' || /hydration/i.test(t)) problemas.push(`console(${m.type()}): ${t.slice(0, 300)}`)
  })
  page.on('pageerror', (e) => problemas.push(`exceção: ${e.message}`))
  page.on('response', (r) => {
    if (r.status() >= 500 && !r.request().url().includes('/__')) {
      problemas.push(`${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`)
    }
  })
  return problemas
}

/** A vitrine como a API devolve — pra saber lote, tipo e preço sem adivinhar. */
async function vitrine(request: APIRequestContext) {
  const r = await request.get(`/api/e/${SLUG}`)
  expect(r.status()).toBe(200)
  const v = await r.json()
  const sabado = v.setores[0].lotes[0]
  return {
    v,
    lote: sabado.id as string,
    inteira: sabado.variacoes.find((x: any) => !x.ehMeia),
    meia: sabado.variacoes.find((x: any) => x.ehMeia),
  }
}

const SENHA_DA_CONTA = 'senha-do-e2e-2026'

/**
 * Abre uma conta de cliente NOVA neste contexto (034): o cookie fica no pote do `request`/da página,
 * e o checkout passa a tirar o comprador dela. Cada chamada = uma pessoa (CPF e e-mail novos).
 */
async function contaNova(request: APIRequestContext, d: {
  nome?: string; email?: string; telefone?: string; instagram?: string | null
} = {}) {
  const corpo = {
    nome: d.nome ?? 'Maria E2E Pública', email: d.email ?? emailNovo('conta'), cpf: cpf(),
    telefone: d.telefone ?? '73998260963', senha: SENHA_DA_CONTA, instagram: d.instagram ?? null,
    endereco: { cidade: 'Ubatã', estado: 'BA' }, evento: SLUG,
  }
  const r = await request.post('/api/conta/criar', { headers: { origin: BASE }, data: corpo })
  expect(r.status(), await r.text()).toBe(200)
  return corpo
}

/** Compra pela MESMA rota que a tela de pagamento chama (com uma conta nova no contexto). */
async function comprarPelaApi(request: APIRequestContext, opcoes: {
  quantidade?: number; forma?: 'pix' | 'credito'; promoter?: string; cupom?: string
} = {}) {
  const { lote, inteira } = await vitrine(request)
  await contaNova(request, { nome: 'Comprador E2E Público' })
  const r = await request.post('/api/checkout', {
    headers: { origin: BASE },
    data: {
      eventSlug: SLUG, itens: [{ lotId: lote, ticketTypeId: inteira.tipoId, quantidade: opcoes.quantidade ?? 1 }],
      comprador: { nome: 'Comprador E2E Público', email: emailNovo(), documento: cpf() },
      forma: opcoes.forma ?? 'pix', ...(opcoes.promoter ? { promoter: opcoes.promoter } : {}),
      ...(opcoes.cupom ? { cupom: opcoes.cupom } : {}),
    },
  })
  expect(r.status(), await r.text()).toBe(200)
  return r.json()
}

/** "O PIX caiu" — o gateway simulado confirma pela emissão de verdade. */
async function pagarSimulado(request: APIRequestContext, codigo: string) {
  const r = await request.post('/api/dev/pagar', { headers: { origin: BASE }, data: { pedido: codigo } })
  expect(r.status(), await r.text()).toBe(200)
  expect((await r.json()).emitiu).toBe(true)
}

/** O aviso do Asaas, como ele chega (na máquina o webhook aceita sem token). */
async function avisoDoAsaas(request: APIRequestContext, evento: string, pedidoId: string, pagamento: Record<string, any>) {
  const r = await request.post('/api/webhooks/asaas', {
    data: { id: `evt_e2e_${sufixo()}`, event: evento,
      payment: { id: `sim_e2e_${sufixo()}`, externalReference: pedidoId, ...pagamento } },
  })
  expect(r.status(), await r.text()).toBe(200)
}

/** Um contexto logado com um papel (o cookie que o `preparo` guardou). */
async function logado(browser: Browser, papel: 'master' | 'portaria') {
  return browser.newContext({ storageState: sessao(papel) })
}

/** O texto que o SSR e o navegador têm de concordar: a data no fuso do evento. */
function noFusoDoParque(iso: string) {
  return new Date(iso).toLocaleString('pt-BR', {
    day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'America/Bahia',
  })
}

/** A cor calculada de um elemento — medida, não suposta. */
const cor = (page: Page, seletor: string, prop: 'color' | 'backgroundColor' = 'backgroundColor') =>
  page.locator(seletor).first().evaluate((el, p) => getComputedStyle(el)[p as any], prop)

/** 300 → "R$ 3,00" (sem milhar: os valores destes casos não passam de R$ 999). */
const emReais = (c: number) => `R$ ${(c / 100).toFixed(2).replace('.', ',')}`

/**
 * O que era "preencher o formulário do comprador": desde a 034 quem compra é a CONTA. Abre uma conta
 * nova no navegador da página (mesmo pote de cookie) e recarrega — o carrinho mora no sessionStorage
 * e fica; a tela passa a mostrar "Seus dados". Os casos dos campos em si miram a janela da conta.
 */
async function preencherComprador(page: Page, extra: Parameters<typeof contaNova>[1] = {}) {
  const corpo = await contaNova(page.request, extra)
  await page.reload()
  await pronta(page)
  await expect(page.locator('[data-parte="seus-dados"]')).toBeVisible()
  return corpo
}

/** Passo 1 → "Avançar" → passo 2, na forma escolhida (Pix é a marcada de saída). */
async function irAoPasso2(page: Page, forma: 'pix' | 'credito' | 'debito' = 'pix') {
  await page.locator('[data-parte="avancar"]').click()
  await expect(page.getByRole('heading', { name: 'Como você quer pagar?' })).toBeVisible()
  if (forma !== 'pix') await page.locator(`[data-forma="${forma}"]`).click()
}
const botaoPagar = (page: Page) => page.locator('[data-parte="pagar"]')
async function pagarComPix(page: Page) {
  await irAoPasso2(page)
  await botaoPagar(page).click()
}
async function pagarComCartao(page: Page) {
  await irAoPasso2(page, 'credito')
  await botaoPagar(page).click()
}

/** A janela da conta, na aba de criar (ela abre sozinha no pagamento sem conta). */
async function janelaDeCriar(page: Page) {
  const janela = page.getByRole('dialog')
  await expect(janela).toBeVisible()
  await janela.getByRole('tab', { name: 'Criar conta' }).click()
  return janela
}

/** Preenche a aba de criar com dados bons; o caso troca o campo que quer testar. */
async function preencherJanela(page: Page, troca: Partial<Record<'nome' | 'cpf' | 'telefone' | 'email', string>> = {}) {
  const janela = await janelaDeCriar(page)
  await janela.locator('#conta-nome').fill(troca.nome ?? 'Maria E2E Pública')
  await janela.locator('#conta-cpf').fill(troca.cpf ?? cpf())
  await janela.locator('#conta-telefone').fill(troca.telefone ?? '73998260963')
  await janela.locator('#conta-email').fill(troca.email ?? emailNovo('janela'))
  await janela.locator('#conta-senha-nova').fill(SENHA_DA_CONTA)
  return janela
}
const criarNaJanela = (page: Page) =>
  page.getByRole('dialog').getByRole('button', { name: 'Criar conta e continuar' }).click()

/** Da vitrine até a tela de pagamento com `n` inteiras de sábado. */
async function irAoPagamento(page: Page, n = 1, caminho = `/e/${SLUG}`) {
  await page.goto(caminho)
  await pronta(page)
  const mais = page.getByRole('button', { name: 'Adicionar um Inteira' }).first()
  for (let i = 0; i < n; i++) await mais.click()
  // no computador é o botão do resumo; no celular, o "Pagar" da barra de baixo
  await page.getByRole('button', { name: /^(Ir para pagamento|Pagar)$/ }).filter({ visible: true }).first().click()
  await expect(page).toHaveURL(new RegExp(`/e/${SLUG}/pagamento`))
  await pronta(page)
  await expect(page.getByRole('heading', { name: 'Finalizar compra' })).toBeVisible()
}

/** O pedido que esta aba acabou de criar (a tela guarda em `dt:pedido`). */
const pedidoDaAba = (page: Page) => page.evaluate(() => JSON.parse(sessionStorage.getItem('dt:pedido') || 'null')?.pedido)

/* ================================================================= erro */

test.describe('erro e caminho codificado', () => {
  test('matriz 14 · B10/B25 — evento que não existe: HTTP 404, página em português com saída', async ({ page }) => {
    const problemas = vigia(page)
    const r = await page.goto('/e/evento-que-nao-existe')
    expect(r?.status(), 'o evento inexistente respondia 200').toBe(404)
    await expect(page.getByRole('heading', { name: 'Evento não encontrado' })).toBeVisible()
    await expect(page.getByText(/Page not found|not found/i)).toHaveCount(0)
    const voltar = page.getByRole('link', { name: 'Ver os eventos à venda' })
    await expect(voltar).toHaveAttribute('href', '/')
    // o botão é o azul da marca (pool-700), medido
    expect(await cor(page, 'main a.btn-primario')).toBe('rgb(20, 111, 131)')
    expect(problemas.filter((p) => !p.includes('404'))).toEqual([])
  })

  test('B25 — endereço qualquer: 404 com "Página não encontrada"', async ({ page }) => {
    const r = await page.goto('/qualquer-coisa-que-nao-existe')
    expect(r?.status()).toBe(404)
    await expect(page.getByRole('heading', { name: 'Página não encontrada' })).toBeVisible()
    await expect(page.getByText('Código do erro: 404')).toBeVisible()
  })

  test('B22 — /e/..%2Fadmin%2Fclientes logado como master não vira /api/admin/clientes', async ({ browser }) => {
    const ctx = await logado(browser, 'master')
    const page = await ctx.newPage()
    const pedidas: string[] = []
    page.on('request', (q) => pedidas.push(new URL(q.url()).pathname))
    const r = await page.goto('/e/..%2Fadmin%2Fclientes')
    expect(r?.status(), 'o slug subiu de pasta e abriu a rota do painel').toBe(404)
    await expect(page.getByRole('heading', { name: 'Evento não encontrado' })).toBeVisible()
    // nenhum dado de cliente do painel na página
    expect(await page.content()).not.toMatch(/"clientes"\s*:/)
    // e pela navegação do NAVEGADOR (quem normaliza o `..` é o fetch do navegador, com o cookie)
    await page.goto('/')
    await pronta(page)
    await page.evaluate(() => (document.querySelector('#__nuxt') as any).__vue_app__.config.globalProperties.$router
      .push('/e/..%2Fadmin%2Fclientes'))
    await expect(page.getByText('Evento não encontrado').first()).toBeVisible()
    expect(pedidas.filter((p) => p.startsWith('/api/admin/')),
      'o slug cru subiu de pasta: a vitrine pediu uma rota do painel com o cookie de quem abriu').toEqual([])
    await ctx.close()
  })

  test('matriz 134 · /api/%61dmin/eventos sem sessão: 401/404, nunca 200', async ({ request }) => {
    for (const caminho of ['/api/%61dmin/eventos', `/api/admin/%65vento/${EVENTO_ID}/vendas`]) {
      const r = await request.get(caminho)
      expect([401, 403, 404], caminho).toContain(r.status())
    }
  })
})

/* =============================================================== vitrine */

test.describe('vitrine', () => {
  test('matriz 16 · B10 — a bilheteria fora do ar: "não respondeu", com Tentar de novo (nunca "não encontrado")', async ({ page }) => {
    await page.goto('/')
    await pronta(page)
    // a navegação SEGUINTE é do navegador (NuxtLink), e é essa consulta que cai
    await page.route('**/api/e/**', (rota) => rota.fulfill({ status: 500, contentType: 'application/json',
      body: JSON.stringify({ statusCode: 500, statusMessage: 'banco fora do ar' }) }))
    await page.locator(`a[href="/e/${SLUG}"]`).first().click()
    await expect(page.getByText('A bilheteria não respondeu agora')).toBeVisible()
    await expect(page.getByText('Evento não encontrado')).toHaveCount(0)
    await page.unroute('**/api/e/**')
    await page.getByRole('button', { name: 'Tentar de novo' }).click()
    await expect(page.getByRole('heading', { name: /Escolha seus/ })).toBeVisible()
  })

  test('B24 — navegador em Manaus: a hora é a do PARQUE, e o SSR e a hidratação concordam', async ({ browser, request }) => {
    const { v } = await vitrine(request)
    const esperado = noFusoDoParque(v.evento.inicio)
    const ctx = await browser.newContext({ timezoneId: 'America/Manaus', locale: 'pt-BR' })
    const page = await ctx.newPage()
    const problemas = vigia(page)
    await page.goto(`/e/${SLUG}`)
    await pronta(page)
    await page.waitForTimeout(500)
    await expect(page.locator('dl').first()).toContainText(esperado)
    expect(problemas, 'hidratação trocou o texto (ou erro no console)').toEqual([])
    await ctx.close()
  })

  test('matriz 27 · B19 — F5 com 2 ingressos: a seleção volta, sem dado pessoal guardado', async ({ page }) => {
    await page.goto(`/e/${SLUG}`)
    await pronta(page)
    const mais = page.getByRole('button', { name: 'Adicionar um Inteira' }).first()
    await mais.click(); await mais.click()
    const total = await page.locator('aside').getByText(/^R\$/).last().textContent()
    await page.reload()
    await pronta(page)
    await expect(page.locator('aside')).toContainText('2×')
    await expect(page.locator('aside')).toContainText(total!.trim())
    const guardado = await page.evaluate(() => sessionStorage.getItem('dt:carrinho'))
    expect(guardado).not.toMatch(/"documento":"[^"]+"/)
  })

  test('matriz 21/22/23/19 · meia-entrada: sem motivo trava; só Estudante e Jovem pedem número; o número tem de 3 a 40; "Leve na entrada"; zerar tira a declaração', async ({ page }) => {
    await page.goto(`/e/${SLUG}`)
    await pronta(page)
    await page.getByRole('button', { name: 'Adicionar um Meia-entrada' }).first().click()
    const pagar = page.getByRole('button', { name: 'Ir para pagamento' })
    await expect(pagar).toBeDisabled()
    await expect(page.locator('aside')).toContainText('Falta preencher para continuar')
    const motivo = page.getByLabel('Motivo').first()
    const opcoes = (await motivo.locator('option').allTextContents()).filter((t) => t !== 'Escolha…')
    expect(opcoes).toHaveLength(6)
    const pedemNumero: string[] = []
    for (const o of opcoes) {
      await motivo.selectOption({ label: o })
      if (await page.getByLabel('Número do documento').count()) pedemNumero.push(o)
      await expect(page.getByText(/Leve na entrada:/).first()).toBeVisible()
    }
    expect(pedemNumero.map((x) => x.toLowerCase()).join(' | ')).toMatch(/estudante/)
    expect(pedemNumero).toHaveLength(2)
    await motivo.selectOption({ label: pedemNumero[0] })
    // matriz 23: vazio trava; 2 caracteres trava AQUI (a porta recusa menos de 3); 41+ é cortado
    const numero = page.getByLabel('Número do documento').first()
    await expect(pagar).toBeDisabled()
    await numero.fill('AB')
    await expect(page.locator('aside')).toContainText('pelo menos 3 caracteres')
    await expect(pagar, '2 caracteres passavam da vitrine e morriam num 400 no pagamento').toBeDisabled()
    // trocar pra um motivo SEM número esconde o campo — e o que sobrou nele não trava nada
    await motivo.selectOption({ label: opcoes.find((o) => !pedemNumero.includes(o))! })
    await expect(page.getByLabel('Número do documento')).toHaveCount(0)
    await expect(pagar, 'o número escondido travou a compra').toBeEnabled()
    await motivo.selectOption({ label: pedemNumero[0] })
    await expect(numero).toHaveValue('AB')
    await expect(pagar).toBeDisabled()
    await numero.fill('X'.repeat(45))
    await expect(numero).toHaveValue('X'.repeat(40))
    await numero.fill('<b>CART-E2E-1</b>')
    await expect(pagar).toBeEnabled()
    await numero.fill('CARTEIRINHA-E2E-1')
    await expect(pagar).toBeEnabled()
    // matriz 19: o "−" até zero tira a linha — e a declaração vai junto
    await page.getByRole('button', { name: 'Remover um Meia-entrada' }).first().click()
    await expect(page.getByLabel('Motivo')).toHaveCount(0)
    await expect(page.getByLabel('Número do documento')).toHaveCount(0)
  })

  test('matriz 20 · teto do pedido somando linhas: pendência com a conta e botão desligado', async ({ page, request }) => {
    const { v } = await vitrine(request)
    const teto = Number(v.evento.maxPorPedido)
    // quantos cada linha deixa (o teto da linha vem da vitrine), até passar o do pedido
    const linhas = [
      { botao: page.getByRole('button', { name: 'Adicionar um Inteira' }).nth(0), max: v.setores[0].lotes[0].variacoes[0].maxPorCompra },
      { botao: page.getByRole('button', { name: 'Adicionar um Inteira' }).nth(1), max: v.setores[1].lotes[0].variacoes[0].maxPorCompra },
      { botao: page.getByRole('button', { name: /Adicionar um COMBO/ }).first(), max: v.setores[2].lotes[0].variacoes[0].maxPorCompra },
    ]
    await page.goto(`/e/${SLUG}`)
    await pronta(page)
    let n = 0
    for (const l of linhas) {
      for (let i = 0; i < Number(l.max) && n <= teto; i++) { await l.botao.click(); n++ }
      if (n > teto) break
    }
    expect(n, 'as linhas da vitrine não somam além do teto do pedido — o caso não tem o que provar').toBeGreaterThan(teto)
    await expect(page.locator('aside')).toContainText(`Cada pedido leva no máximo ${teto} ingressos`)
    await expect(page.getByRole('button', { name: 'Ir para pagamento' })).toBeDisabled()
  })

  test('matriz 28/32 · botões com nome pro leitor de tela; "Ir para pagamento" grava o carrinho v2 carimbado', async ({ page }) => {
    await page.goto(`/e/${SLUG}`)
    await pronta(page)
    await expect(page.getByRole('button', { name: 'Remover um Inteira' }).first()).toBeDisabled()
    await page.getByRole('button', { name: 'Adicionar um Inteira' }).first().click()
    await expect(page.locator('[aria-live="polite"]').first()).toHaveText('1')
    await page.getByRole('button', { name: 'Ir para pagamento' }).click()
    await expect(page).toHaveURL(/\/pagamento$/)
    const c = await page.evaluate(() => JSON.parse(sessionStorage.getItem('dt:carrinho') || 'null'))
    expect(c).toMatchObject({ versao: 2, slug: SLUG })
    expect(typeof c.criadoEm).toBe('number')
  })

  test('matriz 33 · B07 — a venda pelo link do promoter é do promoter', async ({ browser, page }) => {
    const painel = await logado(browser, 'master')
    const criado = await painel.request.post(`/api/admin/evento/${EVENTO_ID}/promoters`, {
      headers: { origin: BASE }, data: { nome: `E2E Promoter ${sufixo()}`, comissaoBps: 1000 } })
    expect(criado.status(), await criado.text()).toBe(200)
    const promoter = await criado.json()
    const codigo = promoter.codigo ?? promoter.promoter?.codigo ?? promoter.code
    expect(codigo).toBeTruthy()

    await irAoPagamento(page, 1, `/e/${SLUG}?promoter=${encodeURIComponent(String(codigo).toLowerCase())}`)
    await preencherComprador(page)
    await pagarComPix(page)
    await expect(page.getByText(/Seus ingressos estão reservados por/)).toBeVisible()
    const pedido = await pedidoDaAba(page)
    await pagarSimulado(page.request, pedido.pedido)
    await expect(page.getByRole('heading', { name: 'Ingressos emitidos' })).toBeVisible({ timeout: 20_000 })

    const lista = await (await painel.request.get(`/api/admin/evento/${EVENTO_ID}/promoters`)).json()
    const dele = lista.promoters.find((p: any) => p.codigo === codigo)
    expect(dele?.pedidos, 'o link do promoter não atribuiu a venda').toBe(1)
    await painel.close()
  })

  test('matriz 17/18/19 · lote de mínimo 4: o "+" salta pro 4, para no teto dizendo o porquê, e o "−" do 4 zera', async ({ page }) => {
    await page.goto('/')
    await pronta(page)
    // o domingo vira um lote de mínimo 4, com o teto de 6 por CPF na inteira
    await comResposta(page, `**/api/e/${SLUG}`, (j) => {
      const lote = j.setores[1].lotes[0]
      lote.minPorCompra = 4
      lote.variacoes = lote.variacoes.map((v: any) => (v.ehMeia ? v : { ...v, maxPorCompra: 6, tetoPor: 'cpf' }))
      return j
    })
    await page.locator(`a[href="/e/${SLUG}"]`).first().click()
    await expect(page.getByRole('heading', { name: /Escolha seus/ })).toBeVisible()
    const mais = page.getByRole('button', { name: 'Adicionar um Inteira' }).nth(1)
    const menos = page.getByRole('button', { name: 'Remover um Inteira' }).nth(1)
    const quantos = menos.locator('xpath=following-sibling::span[1]')
    await expect(page.getByText('Mínimo de 4 por compra, somando as opções deste lote. Cada CPF leva no máximo 6 desta opção'))
      .toBeVisible()
    await mais.click()
    await expect(quantos, 'o primeiro "+" não entrou no mínimo').toHaveText('4')
    await mais.click(); await mais.click()
    await expect(quantos).toHaveText('6')
    // no teto (6 por CPF) o "+" desliga — o clique seguinte nem acontece
    await expect(mais, 'o "+" passou do teto da linha').toBeDisabled()
    await menos.click(); await menos.click()
    await expect(quantos).toHaveText('4')
    await menos.click()
    await expect(quantos, 'o "−" parou num número que não compra').toHaveText('0')
  })

  test('matriz 25 · vendas fechadas: o selo, a frase do porquê, nenhum "+" e o botão diz "Vendas fechadas"', async ({ page }) => {
    await page.goto('/')
    await pronta(page)
    await comResposta(page, `**/api/e/${SLUG}`, (j) => {
      j.evento.vendasAbertas = false
      j.evento.avisoDeVenda = 'As vendas pela internet deste evento já terminaram.'
      for (const s of j.setores) for (const l of s.lotes) l.situacao = 'fechado'
      return j
    })
    await page.locator(`a[href="/e/${SLUG}"]`).first().click()
    await expect(page.getByText('VENDAS FECHADAS', { exact: true })).toBeVisible()
    await expect(page.getByText('As vendas pela internet deste evento já terminaram.')).toBeVisible()
    await expect(page.getByRole('button', { name: /^Adicionar um/ })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Vendas fechadas' })).toBeDisabled()
  })

  test('matriz 26 · giro de lote: o lote que ainda vai abrir diz "Em breve" e QUANDO abre, sem "+"', async ({ page }) => {
    const abre = new Date(Date.now() + 5 * 86_400_000).toISOString()
    await page.goto('/')
    await pronta(page)
    await comResposta(page, `**/api/e/${SLUG}`, (j) => {
      const s = j.setores[0]
      s.lotes.push({ ...s.lotes[0], id: '00000000-0000-4000-8000-0000000e2e26', nome: '2º LOTE',
        situacao: 'em_breve', abreEm: abre,
        variacoes: s.lotes[0].variacoes.map((v: any, i: number) => ({ ...v,
          tipoId: `00000000-0000-4000-8000-00000000e2${i}6`, nome: `${v.nome} (2º lote)` })) })
      return j
    })
    await page.locator(`a[href="/e/${SLUG}"]`).first().click()
    const segundo = page.locator('main div.card').filter({ hasText: 'Inteira (2º lote)' })
    await expect(segundo).toContainText('Em breve')
    await expect(segundo).toContainText(`abre em ${noFusoDoParque(abre)}`)
    await expect(segundo.getByRole('button')).toHaveCount(0)
    // e o 1º lote segue vendendo
    await expect(page.getByRole('button', { name: 'Adicionar um Inteira' }).first()).toBeEnabled()
  })

  test('matriz 77 · PROD-06 — sem como cobrar pela internet: o aviso vem ANTES do formulário e o botão não leva ao pagamento', async ({ page }) => {
    await page.goto('/')
    await pronta(page)
    // é o que a rota diz de um evento à venda sem chave do Asaas (a bateria roda com o simulado)
    await comResposta(page, `**/api/e/${SLUG}`, (j) => {
      j.evento.pagamentoOnline = { disponivel: false,
        recado: 'A venda pela internet está pausada. Compre na bilheteria do parque.' }
      return j
    })
    await page.locator(`a[href="/e/${SLUG}"]`).first().click()
    const aviso = page.getByRole('status').filter({ hasText: 'Venda online indisponível agora' })
    await expect(aviso).toContainText('A venda pela internet está pausada. Compre na bilheteria do parque.')
    await page.getByRole('button', { name: 'Adicionar um Inteira' }).first().click()
    await expect(page.getByRole('button', { name: 'Venda online indisponível' })).toBeDisabled()
    await expect(page).toHaveURL(new RegExp(`/e/${SLUG}$`))
  })

  test('matriz 29 · preço mexido no navegador: a porta cobra o do banco e a cobrança avisa que mudou', async ({ page, request }) => {
    const { inteira } = await vitrine(request)
    await irAoPagamento(page, 1)
    // quem mexe no sessionStorage (ou uma extensão): R$ 1,00 o ingresso
    await page.evaluate(() => {
      const c = JSON.parse(sessionStorage.getItem('dt:carrinho')!)
      c.linhas[0].unitTotalCents = 100
      c.totais = { ...c.totais, total: 100, face: 91, taxa: 9 }
      sessionStorage.setItem('dt:carrinho', JSON.stringify(c))
    })
    await page.reload()
    await pronta(page)
    await expect(page.getByText('R$ 1,00').first()).toBeVisible()
    await preencherComprador(page)
    await pagarComPix(page)
    await expect(page.getByText(/Seus ingressos estão reservados por/)).toBeVisible()
    await expect(page.getByText(/O preço mudou entre a escolha e o pagamento: a tela mostrava R\$ 1,00/)).toBeVisible()
    const pedido = await pedidoDaAba(page)
    expect(pedido.totalCents, 'a porta cobrou o preço que veio do navegador').toBe(inteira.totalCents)
  })

  test('matriz 31 · celular 375: a barra fixa mostra total e Pagar, e nem com a pendência ela cobre a lista', async ({ browser }) => {
    const ctx = await celular(browser)
    const page = await ctx.newPage()
    await page.goto(`/e/${SLUG}`)
    await pronta(page)
    expect(await larguraDaPagina(page), 'rolagem de lado no celular').toBeLessThanOrEqual(375)
    // uma meia sem motivo: a barra ganha a pendência (e cresce)
    await page.getByRole('button', { name: 'Adicionar um Meia-entrada' }).first().click()
    const barra = page.locator('div.fixed.bottom-0')
    await expect(barra).toBeVisible()
    await expect(barra).toContainText('1 ingresso')
    await expect(barra).toContainText('R$ 16,50')
    await expect(barra.getByRole('button', { name: 'Pagar' })).toBeDisabled()
    await expect(barra.locator('.faixa-aviso')).toBeVisible()
    // rola até o fim: o último cartão de ingresso termina ACIMA da barra
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
    await page.waitForTimeout(300)
    const topoDaBarra = await barra.evaluate((e) => e.getBoundingClientRect().top)
    const fimDaLista = await page.locator('main div.card').filter({ visible: true }).last()
      .evaluate((e) => e.getBoundingClientRect().bottom)
    // com folga: encostar na barra já esconde a borda do cartão (sem o conserto: 0,5 px ENTRAVA nela)
    expect(fimDaLista + 8, 'a barra do celular cobre o fim da lista').toBeLessThanOrEqual(topoDaBarra)
    // e sem ingresso nenhum a barra some e o recheio volta ao da classe
    await page.getByRole('button', { name: 'Remover um Meia-entrada' }).first().click()
    await expect(barra).toHaveCount(0)
    expect(await page.locator('div.min-h-screen').first().evaluate((e) => e.style.paddingBottom)).toBe('')
    await ctx.close()
  })
})

/* ============================================================= pagamento */

test.describe('pagamento', () => {
  test('matriz 34 · sem carrinho: volta pra vitrine', async ({ page }) => {
    await page.goto(`/e/${SLUG}/pagamento`)
    await expect(page).toHaveURL(new RegExp(`/e/${SLUG}$`), { timeout: 30_000 })
  })

  test('matriz 59/60/61 · B17 (034) — a senha só existe na janela da conta; o checkout não pede dado pessoal', async ({ page }) => {
    await irAoPagamento(page)
    const janela = page.getByRole('dialog')
    await expect(janela.locator('input[type="password"]')).toHaveCount(1)
    await page.keyboard.press('Escape')
    await expect(janela).toHaveCount(0)
    await expect(page.locator('input[type="password"]')).toHaveCount(0)
    for (const id of ['nome', 'email', 'cpf', 'tel', 'nascimento', 'cep', 'cidade']) {
      await expect(page.locator(`#${id}`), `o checkout voltou a pedir #${id}`).toHaveCount(0)
    }
  })

  test('matriz 36/58 · B29 — limites no campo iguais aos do servidor (janela da conta, 034)', async ({ page }) => {
    await irAoPagamento(page)
    const janela = await janelaDeCriar(page)
    // os de `validarDadosDaConta`: nome 120, e-mail 160
    await expect(janela.locator('#conta-nome')).toHaveAttribute('maxlength', '120')
    await expect(janela.locator('#conta-email')).toHaveAttribute('maxlength', '160')
  })

  test('matriz 38 · B11 — e-mail a@b na janela da conta: campo marcado com a frase, e nenhuma ida ao checkout', async ({ page }) => {
    await irAoPagamento(page)
    let foiAoCheckout = false
    page.on('request', (q) => { if (q.url().includes('/api/checkout')) foiAoCheckout = true })
    const janela = await preencherJanela(page, { email: 'a@b' })
    await criarNaJanela(page)
    await expect(janela.getByRole('alert')).toContainText('Confira o e-mail')
    await expect(janela.locator('#conta-email')).toHaveAttribute('aria-invalid', 'true')
    expect(foiAoCheckout, 'foi ao checkout sem conta').toBe(false)
  })

  test('matriz 88 · B23 — todo campo tem rótulo, e a forma de pagamento anuncia o estado (rádio)', async ({ page }) => {
    await irAoPagamento(page)
    await preencherComprador(page)
    await irAoPasso2(page)
    /** campo que o leitor de tela não sabe dizer o que é */
    const semRotulo = () => page.locator('form input, form select').evaluateAll((els) => els
      .filter((e) => !(e as HTMLInputElement).labels?.length && !e.getAttribute('aria-label')
        && !e.getAttribute('aria-labelledby'))
      .map((e) => e.id || e.outerHTML.slice(0, 80)))
    expect(await semRotulo()).toEqual([])
    // as formas são rádios de verdade: o leitor de tela anuncia "selecionado"
    const pix = page.locator('[data-forma="pix"] input[type="radio"]')
    const cartao = page.locator('[data-forma="credito"] input[type="radio"]')
    await expect(pix).toBeChecked()
    await page.locator('[data-forma="credito"]').click()
    await expect(cartao).toBeChecked()
    await expect(pix).not.toBeChecked()
    // o seletor de parcelas, que só nasce no cartão, também tem rótulo
    await expect(page.getByLabel('Parcelas')).toBeVisible()
    expect(await semRotulo()).toEqual([])
  })

  // campo de cupom escondido no checkout por enquanto (MOSTRAR_CUPOM, pedido do dono 28/09)
  test.skip('matriz 67 · B18 — "Continuar sem o cupom" com a cidade vazia é barrado como o botão principal', async ({ page }) => {
    await irAoPagamento(page)
    await preencherComprador(page)
    await page.locator('#cidade').fill('')
    await page.locator('#cupom').fill(`NAOEXISTE${sufixo().toUpperCase()}`)
    await page.locator('#nome').click() // sai do campo: a tela confere o cupom
    const seguir = page.getByRole('button', { name: 'Continuar sem o cupom' })
    await expect(seguir).toBeVisible()
    let foiAoCheckout = false
    page.on('request', (q) => { if (q.url().includes('/api/checkout')) foiAoCheckout = true })
    await seguir.click()
    await expect(page.getByText('Diga em que cidade você mora.')).toBeVisible()
    expect(foiAoCheckout, 'o pedido nascia sem cidade').toBe(false)
  })

  // campo de cupom escondido no checkout por enquanto (MOSTRAR_CUPOM, pedido do dono 28/09)
  test.skip('matriz 71 · B21 — parcelas sobre o total COM o cupom, e "sem juros"', async ({ browser, page }) => {
    const painel = await logado(browser, 'master')
    const codigo = `E2E50${sufixo().toUpperCase()}`.slice(0, 20)
    const r = await painel.request.post(`/api/admin/evento/${EVENTO_ID}/cupons`, {
      headers: { origin: BASE }, data: { codigo, tipo: 'percentual', valor: 5000, maxUsos: 50, maxPorCliente: 5 } })
    expect(r.status(), await r.text()).toBe(200)
    await painel.close()

    await irAoPagamento(page, 4)
    await preencherComprador(page)
    await page.locator('#cupom').fill(codigo)
    await page.locator('#nome').click()
    await expect(page.getByText(/Desconto de/)).toBeVisible()
    await page.getByRole('button', { name: 'Cartão de crédito' }).click()
    const opcoes = await page.locator('#parcelas option').allTextContents()
    expect(opcoes.slice(1).every((o) => /sem juros/.test(o)), opcoes.join(' | ')).toBe(true)
    // a última parcela × n volta ao total com desconto (arredondado pra cima), nunca ao total cheio
    const avista = opcoes[0].match(/R\$\s*([\d.]+,\d{2})/)![1]
    const cents = (s: string) => Math.round(Number(s.replace(/\./g, '').replace(',', '.')) * 100)
    const totalComCupom = cents(avista)
    const semCupom = await page.evaluate(() => JSON.parse(sessionStorage.getItem('dt:carrinho') || 'null')?.totais?.total)
    expect(totalComCupom, 'o rótulo das parcelas usava o total antes do cupom').toBeLessThan(semCupom)
    const duas = opcoes.find((o) => o.startsWith('2×'))!
    expect(Math.ceil(totalComCupom / 2)).toBe(cents(duas.match(/R\$\s*([\d.]+,\d{2})/)![1]))
  })

  test('matriz 44/68/78/80/81 · PIX sem celular: QR, copiar, relógio; F5 na cobrança volta nela; o PIX cai e em segundos "Ingressos emitidos"; F5 leva ao ingresso', async ({ page }) => {
    const problemas = vigia(page)
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE })
    await irAoPagamento(page, 2)
    await preencherComprador(page) // sem celular: é opcional (matriz 44)
    await pagarComPix(page)
    await expect(page.getByAltText('QR Code do PIX')).toBeVisible()
    await expect(page.getByText(/Seus ingressos estão reservados por/)).toBeVisible()
    const pedido = await pedidoDaAba(page)
    // matriz 80: copiar o código
    await page.getByRole('button', { name: 'Copiar código PIX' }).click()
    await expect(page.getByRole('button', { name: 'Copiado!' })).toBeVisible()
    // matriz 78: F5 no meio da cobrança volta NA MESMA cobrança, sem formulário
    await page.reload()
    await pronta(page)
    await expect(page.getByAltText('QR Code do PIX')).toBeVisible()
    await expect(page.getByText(pedido.pedido).first()).toBeVisible()
    await expect(page.locator('#cpf')).toHaveCount(0)
    await pagarSimulado(page.request, pedido.pedido)
    await expect(page.getByRole('heading', { name: 'Ingressos emitidos' })).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('img[src^="/api/ingresso/"]')).toHaveCount(2)
    await page.reload()
    await expect(page).toHaveURL(new RegExp(`/ingressos/${pedido.pedido}$`), { timeout: 30_000 })
    expect(problemas).toEqual([])
  })

  test('matriz 79 · B13 — voltou e montou outro carrinho: a tela mostra o novo, avisa do anterior, e pagar larga o velho', async ({ page }) => {
    await irAoPagamento(page, 1)
    await preencherComprador(page)
    await pagarComPix(page)
    await expect(page.getByText(/Seus ingressos estão reservados por/)).toBeVisible()
    const anterior = await pedidoDaAba(page)

    // volta pra vitrine NA MESMA ABA e monta outra coisa
    await irAoPagamento(page, 3)
    const aviso = page.getByRole('status').filter({ hasText: 'Você tem um pedido aguardando pagamento.' })
    await expect(aviso).toContainText(anterior.pedido)
    // a conta continua aberta: a pessoa não digita nada de novo
    await expect(page.locator('[data-parte="seus-dados"]')).toContainText('Maria E2E Pública')
    await pagarComPix(page)
    await expect(page.getByText(/Seus ingressos estão reservados por/)).toBeVisible()
    const novo = await pedidoDaAba(page)
    expect(novo.pedido).not.toBe(anterior.pedido)
    const velho = await (await page.request.get(`/api/pedido/${anterior.pedidoId}`)).json()
    expect(velho.status, 'o pedido velho ficou segurando lugar no CPF').toBe('expirado')
  })

  test('B13 — "Trocar a forma de pagamento" volta à escolha da forma com o mesmo carrinho e larga o pedido', async ({ page }) => {
    await irAoPagamento(page, 1)
    await preencherComprador(page)
    await pagarComPix(page)
    await expect(page.getByText(/Seus ingressos estão reservados por/)).toBeVisible()
    const pedido = await pedidoDaAba(page)
    await page.getByRole('button', { name: 'Trocar a forma de pagamento ou mudar os ingressos' }).click()
    await expect(page.getByRole('heading', { name: 'Como você quer pagar?' })).toBeVisible()
    await expect(botaoPagar(page)).toHaveText(/com Pix/)
    expect((await (await page.request.get(`/api/pedido/${pedido.pedidoId}`)).json()).status).toBe('expirado')
  })

  test('matriz 82 · B20 — o prazo do PIX vence: o QR e o copia-e-cola somem, e a tela diz por quê', async ({ page }) => {
    await page.clock.install({ time: new Date() })
    await irAoPagamento(page, 1)
    await preencherComprador(page)
    await pagarComPix(page)
    await expect(page.getByAltText('QR Code do PIX')).toBeVisible()
    await page.clock.fastForward('25:00')
    await expect(page.getByText('O prazo deste PIX venceu')).toBeVisible({ timeout: 20_000 })
    await expect(page.getByAltText('QR Code do PIX')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Copiar código PIX' })).toHaveCount(0)
  })

  test('matriz 69/92 · B08 — cartão: a fatura abre (nova aba), o outro aparelho também paga, e as duas telas viram', async ({ browser, page }) => {
    await irAoPagamento(page, 1)
    await preencherComprador(page)
    await pagarComCartao(page)
    const abrir = page.getByRole('link', { name: 'Abrir pagamento com cartão' })
    await expect(abrir).toBeVisible()
    await expect(abrir).toHaveAttribute('target', '_blank')
    const pedido = await pedidoDaAba(page)

    // outro aparelho, sem a aba do pagamento: a página do pedido oferece a fatura
    const outroAparelho = await browser.newContext()
    const outro = await outroAparelho.newPage()
    await outro.goto(`/ingressos/${pedido.pedido}`)
    await pronta(outro)
    const pagarNoOutro = outro.getByRole('link', { name: 'Pagar com cartão' })
    await expect(pagarNoOutro, 'quem fechou a aba do cartão não tinha como pagar').toBeVisible()
    const [fatura] = await Promise.all([outroAparelho.waitForEvent('page'), pagarNoOutro.click()])
    await fatura.waitForLoadState()
    await fatura.getByRole('button', { name: 'Pagar com cartão (simulado)' }).click()
    await expect(fatura.getByText('Pagamento aprovado')).toBeVisible()

    await expect(page.getByRole('heading', { name: 'Ingressos emitidos' })).toBeVisible({ timeout: 20_000 })
    await expect(outro.locator('img[src^="/api/ingresso/"]')).toHaveCount(1, { timeout: 20_000 })
    await outroAparelho.close()
  })

  test('matriz 35/45 (034) · a janela da conta recusa nome sem sobrenome e celular pela metade, com a frase no campo — e nada vai ao checkout', async ({ page }) => {
    await irAoPagamento(page)
    let checkouts = 0
    page.on('request', (q) => { if (q.url().includes('/api/checkout')) checkouts++ })
    const janela = await preencherJanela(page, { nome: 'Jo' })
    const alerta = janela.getByRole('alert')
    await criarNaJanela(page)
    await expect(alerta).toContainText('nome completo')
    await expect(janela.locator('#conta-nome')).toHaveAttribute('aria-invalid', 'true')
    await janela.locator('#conta-nome').fill('Maria E2E Pública')
    await janela.locator('#conta-telefone').fill('739999000')
    await criarNaJanela(page)
    await expect(alerta).toContainText('Confira o celular')
    await expect(janela.locator('#conta-telefone')).toHaveAttribute('aria-invalid', 'true')
    await expect(janela.locator('#conta-nome')).not.toHaveAttribute('aria-invalid', 'true')
    expect(checkouts, 'foi ao checkout sem conta').toBe(0)
  })

  test('matriz 41/42/43 · CPF na janela da conta: a máscara limpa o que se cola; dígito errado e repetido voltam "CPF inválido" no campo', async ({ page }) => {
    await irAoPagamento(page)
    const janela = await preencherJanela(page)
    const campo = janela.locator('#conta-cpf')
    await campo.fill('abc529.982.247-25xyz')
    await expect(campo, 'a máscara deixou passar letra ou pontuação colada').toHaveValue('529.982.247-25')
    for (const torto of ['12345678900', '11111111111']) {
      await campo.fill(torto)
      await criarNaJanela(page)
      await expect(janela.getByRole('alert'), torto).toContainText('CPF inválido')
      await expect(campo, torto).toHaveAttribute('aria-invalid', 'true')
      await expect(janela.getByRole('button', { name: 'Criar conta e continuar' })).toBeEnabled()
    }
  })

  test('matriz 37 · nome com acento, emoji e <script>: aceito, e aparece como TEXTO no pedido', async ({ page }) => {
    let rodouScript = false
    page.on('dialog', async (d) => { rodouScript = true; await d.dismiss() })
    const nome = 'Zé Ñandú <script>alert(1)</script> 😀'
    await irAoPagamento(page)
    await preencherComprador(page, { nome })
    await pagarComPix(page)
    await expect(page.getByText(/Seus ingressos estão reservados por/)).toBeVisible()
    const pedido = await pedidoDaAba(page)
    await pagarSimulado(page.request, pedido.pedido)
    await expect(page.getByRole('heading', { name: 'Ingressos emitidos' })).toBeVisible({ timeout: 20_000 })
    await page.goto(`/ingressos/${pedido.pedido}`)
    await pronta(page)
    await expect(page.getByText(nome).first()).toBeVisible()
    // o JSON da carga do Nuxt leva o nome (escapado) — fora dele, nenhum <script> com o texto
    expect(await page.locator('script:not([type="application/json"])', { hasText: 'alert(1)' }).count(),
      'o nome virou elemento <script> na página').toBe(0)
    expect(rodouScript, 'o nome rodou como script').toBe(false)
  })

  test('matriz 39/46/52 · e-mail com maiúsculas e espaço, celular FIXO e Instagram colado com @ ou link: aceitos, e guardados limpos', async ({ browser, page }) => {
    const marca = sufixo()
    await irAoPagamento(page)
    // na conta (034): o e-mail torto, o fixo de 10 dígitos e o Instagram colado como link
    await preencherComprador(page, { email: `Maria.E2E.${marca}@Teste.Invalido `, telefone: '7133334444',
      instagram: 'https://www.instagram.com/Maria.Silva_E2E?igsh=zz' })
    await pagarComPix(page)
    await expect(page.getByText(/Seus ingressos estão reservados por/)).toBeVisible()
    const pedido = await pedidoDaAba(page)
    await pagarSimulado(page.request, pedido.pedido)
    // o cadastro que o painel mostra (a busca também casa dígito com CPF/telefone de outros:
    // o que interessa é o cliente DESTE e-mail)
    const painel = await logado(browser, 'master')
    const r = await painel.request.get(`/api/admin/clientes?q=${encodeURIComponent(marca)}`)
    expect(r.status(), await r.text()).toBe(200)
    const deste = (await r.json()).itens.filter((c: any) => String(c.email).toLowerCase().includes(marca))
    expect(deste).toHaveLength(1)
    expect(deste[0].email, 'o e-mail ficou gravado com maiúsculas').toBe(`maria.e2e.${marca}@teste.invalido`)
    expect(String(deste[0].telefone ?? deste[0].phone ?? '').replace(/\D/g, '')).toBe('7133334444')
    expect(deste[0].instagram).toBe('maria.silva_e2e')
    await painel.close()
  })

  // nascimento saiu do checkout, e o cadastro torto (e-mail de outra conta, Instagram) é recusado na
  // criação da conta — coberto em server/api/conta.test.ts
  test.skip('matriz 40/48/49/50/52 · o que só o servidor sabe: e-mail de outro CPF, data que não existe, no futuro, antiga demais, Instagram torto — frase no lugar certo, e nenhuma compra', async ({ page, request }) => {
    // um e-mail que já comprou (e pagou) com OUTRO CPF
    const jaUsado = emailNovo('dono')
    const { lote, inteira } = await vitrine(request)
    const r = await request.post('/api/checkout', { headers: { origin: BASE }, data: {
      eventSlug: SLUG, itens: [{ lotId: lote, ticketTypeId: inteira.tipoId, quantidade: 1 }],
      comprador: { nome: 'Dono do E-mail', email: jaUsado, documento: cpf() } } })
    expect(r.status(), await r.text()).toBe(200)
    await pagarSimulado(request, (await r.json()).pedido)

    await irAoPagamento(page)
    await preencherComprador(page)
    let criados = 0
    page.on('response', (x) => { if (x.url().endsWith('/api/checkout') && x.status() === 200) criados++ })
    const pagar = page.getByRole('button', { name: 'Pagar com PIX' })
    const alerta = page.locator('form [role="alert"]')
    const amanha = new Date(Date.now() + 86_400_000).toLocaleDateString('pt-BR', { timeZone: 'America/Bahia' })
    const casos: [string, string, string, RegExp][] = [
      ['#nascimento', '31021990', 'nascimento', /Confira a data de nascimento/],   // 48
      ['#nascimento', amanha.replace(/\D/g, ''), 'nascimento', /está no futuro/],  // 49
      ['#nascimento', '01011890', 'nascimento', /Confira o ano de nascimento/],   // 50
      ['#instagram', 'joão!', 'instagram', /Confira o Instagram/],               // 52
    ]
    for (const [campo, valor, id, frase] of casos) {
      await page.locator(campo).fill(valor)
      await pagar.click()
      await expect(alerta, `${campo}=${valor}`).toContainText(frase)
      await expect(page.locator(`#${id}`), `${campo}=${valor}`).toHaveAttribute('aria-invalid', 'true')
      await expect(pagar).toBeEnabled()
      await page.locator(campo).fill(campo === '#nascimento' ? '15031990' : '')
    }
    // matriz 40: o e-mail que já pagou com outro CPF
    await page.locator('#email').fill(jaUsado)
    await pagar.click()
    await expect(page.locator('form [role="alert"]')).toContainText('Este e-mail já está cadastrado com outro CPF')
    expect(criados, 'o servidor criou pedido com cadastro torto').toBe(0)
  })

  // o endereço saiu do checkout (034): mora na conta, é opcional e só pega cidade/UF do CEP
  test.skip('matriz 53/54/55/56 · CEP (o ViaCEP é respondido AQUI — nada sai da máquina): preenche o endereço; inexistente e fora do ar avisam e a compra segue; incompleto o servidor marca', async ({ page }) => {
    let foiPraFora = 0
    await page.route('https://viacep.com.br/**', async (rota) => {
      foiPraFora++
      const cep = /ws\/(\d{8})\//.exec(rota.request().url())?.[1]
      const cors = { 'access-control-allow-origin': '*' }
      if (cep === '45800000') {
        return rota.fulfill({ headers: cors, json: { cep: '45800-000', logradouro: 'Rua do Teste E2E',
          bairro: 'Centro', localidade: 'Itabuna', uf: 'BA' } })
      }
      if (cep === '99999999') return rota.fulfill({ headers: cors, json: { erro: true } })
      return rota.abort('internetdisconnected')   // qualquer outro: o serviço "caiu"
    })
    await irAoPagamento(page)
    await preencherComprador(page)
    // 53: CEP que existe — cidade, estado, rua e bairro vêm sozinhos
    await page.locator('#cidade').fill('')
    await page.locator('#cep').fill('45800000')
    await expect(page.locator('#cep')).toHaveValue('45800-000')
    await expect(page.locator('#cidade')).toHaveValue('Itabuna')
    await expect(page.locator('#estado')).toHaveValue('BA')
    await expect(page.locator('#rua')).toHaveValue('Rua do Teste E2E')
    await expect(page.locator('#bairro')).toHaveValue('Centro')
    // 54: CEP que não existe — avisa
    await page.locator('#cep').fill('99999999')
    await expect(page.getByText('Não achamos esse CEP. Preencha a cidade e o estado.')).toBeVisible()
    // 55: pela metade — não pergunta ao ViaCEP, e quem marca é o servidor ("são 8 números")
    const perguntas = foiPraFora
    await page.locator('#cep').fill('4580')
    expect(foiPraFora, 'perguntou ao ViaCEP com o CEP pela metade').toBe(perguntas)
    await pagarComPix(page)
    await expect(page.locator('form [role="alert"]')).toContainText('são 8 números')
    await expect(page.locator('#cep')).toHaveAttribute('aria-invalid', 'true')
    // 56: o serviço fora do ar — avisa, e a compra SEGUE (CEP é conveniência, não trava)
    await page.locator('#cep').fill('12345678')
    await expect(page.getByText('Não deu pra buscar o CEP agora. Preencha o endereço abaixo.')).toBeVisible()
    await pagarComPix(page)
    await expect(page.getByText(/Seus ingressos estão reservados por/)).toBeVisible()
  })

  // campo de cupom escondido no checkout por enquanto (MOSTRAR_CUPOM, pedido do dono 28/09)
  test.skip('matriz 63/64/65 · cupom: sem CPF diz que vale e avisa do limite por CPF; com o CPF reconfere; inexistente tem frase colada e saída', async ({ browser, page }) => {
    const painel = await logado(browser, 'master')
    const codigo = `E2EC${sufixo().toUpperCase()}`.slice(0, 20)
    const criado = await painel.request.post(`/api/admin/evento/${EVENTO_ID}/cupons`, {
      headers: { origin: BASE }, data: { codigo, tipo: 'percentual', valor: 1000, maxUsos: 50, maxPorCliente: 1 } })
    expect(criado.status(), await criado.text()).toBe(200)
    await painel.close()

    await irAoPagamento(page, 2)
    const conferencias: any[] = []
    page.on('request', (q) => { if (q.url().includes('/api/cupom/conferir')) conferencias.push(q.postDataJSON()) })
    await page.locator('#nome').fill('Maria E2E Pública')
    // matriz 63: sem CPF — vale, e avisa que o limite por CPF ainda vai ser conferido
    await page.locator('#cupom').fill(codigo)
    await page.locator('#nome').click()
    await expect(page.getByText(`Cupom ${codigo} aplicado.`)).toBeVisible()
    await expect(page.getByText('O limite de uso por CPF é conferido quando você preencher o CPF.')).toBeVisible()
    expect(conferencias.at(-1)?.documento).toBeUndefined()
    // matriz 64: sair do CPF reconfere, agora com o documento
    await page.locator('#cpf').fill(cpf())
    await page.locator('#nome').click()
    await expect.poll(() => conferencias.length).toBe(2)
    expect(conferencias.at(-1).documento).toMatch(/^\d{11}$/)
    await expect(page.getByText(/Desconto de/)).toBeVisible()
    await expect(page.getByText('O limite de uso por CPF é conferido')).toHaveCount(0)
    // matriz 65: código que não existe — frase colada ao campo, com a saída
    await page.locator('#cupom').fill(`NAOEXISTE${sufixo().toUpperCase()}`)
    await page.locator('#nome').click()
    const recusa = page.getByRole('alert').filter({ has: page.getByRole('button', { name: 'Continuar sem o cupom' }) })
    await expect(recusa).toBeVisible()
    await expect(recusa).toContainText(/cupom/i)
    await expect(page.locator('#cupom')).toHaveAttribute('aria-invalid', 'true')
  })

  // campo de cupom escondido no checkout por enquanto (MOSTRAR_CUPOM, pedido do dono 28/09)
  test.skip('matriz 66 · o cupom de um uso acaba entre conferir e pagar: a frase vem colada ao campo e dá pra seguir sem ele', async ({ browser, page, request }) => {
    const painel = await logado(browser, 'master')
    const codigo = `E2E1U${sufixo().toUpperCase()}`.slice(0, 20)
    const criado = await painel.request.post(`/api/admin/evento/${EVENTO_ID}/cupons`, {
      headers: { origin: BASE }, data: { codigo, tipo: 'percentual', valor: 1000, maxUsos: 1, maxPorCliente: 1 } })
    expect(criado.status(), await criado.text()).toBe(200)
    await painel.close()

    await irAoPagamento(page, 1)
    await preencherComprador(page)
    await page.locator('#cupom').fill(codigo)
    await page.locator('#nome').click()
    await expect(page.getByText(/Desconto de/)).toBeVisible()
    // outra pessoa usa o único uso antes do clique (pedido pendente já conta)
    await comprarPelaApi(request, { cupom: codigo })
    await pagarComPix(page)
    const recusa = page.getByRole('alert').filter({ has: page.getByRole('button', { name: 'Continuar sem o cupom' }) })
    await expect(recusa).toBeVisible()
    await expect(page.getByText(/Seus ingressos estão reservados por/)).toHaveCount(0)
    await recusa.getByRole('button', { name: 'Continuar sem o cupom' }).click()
    await expect(page.getByText(/Seus ingressos estão reservados por/)).toBeVisible()
    const pedido = await pedidoDaAba(page)
    expect(pedido.descontoCents ?? 0, 'seguiu com o desconto de um cupom que acabou').toBe(0)
  })

  test('matriz 72 · duplo clique e Enter duas vezes em Pagar: um pedido só, com "Gerando cobrança…" no meio', async ({ page }) => {
    await irAoPagamento(page, 1)
    await preencherComprador(page)
    let pedidos = 0
    let soltar!: () => void
    const segura = new Promise<void>((ok) => { soltar = ok })
    // a resposta do checkout demora: é nessa janela que o segundo clique criaria o segundo pedido
    await page.route('**/api/checkout', async (rota) => { pedidos++; await segura; await rota.continue() })
    await irAoPasso2(page)
    await botaoPagar(page).dblclick()
    await expect(page.getByRole('button', { name: 'Gerando a cobrança…' })).toBeDisabled()
    await page.keyboard.press('Enter')
    await page.keyboard.press('Enter')
    soltar()
    await expect(page.getByText(/Seus ingressos estão reservados por/)).toBeVisible()
    expect(pedidos, 'o mesmo clique criou mais de um pedido').toBe(1)
  })

  test('matriz 85 · cartão sem link do gateway: a cobrança diz o que fazer, com o número do pedido', async ({ page }) => {
    await irAoPagamento(page, 1)
    await preencherComprador(page)
    // o gateway respondeu sem `invoiceUrl`
    await comResposta(page, '**/api/checkout', (j) => ({ ...j, pagamento: { ...j.pagamento, linkFatura: null } }))
    await pagarComCartao(page)
    const aviso = page.locator('.faixa-aviso', { hasText: 'O link do cartão não veio do gateway.' })
    await expect(aviso).toBeVisible()
    await expect(aviso).toContainText((await pedidoDaAba(page)).pedido)
    await expect(page.getByRole('link', { name: 'Abrir pagamento com cartão' })).toHaveCount(0)
  })

  test('matriz 87 · celular 375: campos da janela com 16 px (sem zoom no iPhone), tudo cabe e o botão ocupa a largura', async ({ browser }) => {
    const ctx = await celular(browser)
    const page = await ctx.newPage()
    await irAoPagamento(page, 1)
    const janela = await janelaDeCriar(page)
    const campos = janela.locator('input:not([type="checkbox"]), select')
    const fontes = await campos.evaluateAll((els) => els.map((e) => parseFloat(getComputedStyle(e).fontSize)))
    expect(Math.min(...fontes), 'campo abaixo de 16 px: o iPhone dá zoom ao tocar').toBeGreaterThanOrEqual(16)
    for (const c of await campos.all()) {
      const caixa = (await c.boundingBox())!
      expect(caixa.x).toBeGreaterThanOrEqual(0)
      expect(caixa.x + caixa.width).toBeLessThanOrEqual(375)
    }
    expect(await larguraDaPagina(page), 'rolagem de lado no celular').toBeLessThanOrEqual(375)
    await page.keyboard.press('Escape')
    await preencherComprador(page)
    const botao = (await page.locator('[data-parte="avancar"]').boundingBox())!
    const formulario = (await page.locator('form').filter({ has: page.locator('[data-parte="avancar"]') }).boundingBox())!
    expect(Math.abs(botao.width - formulario.width), 'o botão de avançar não ocupa a largura').toBeLessThanOrEqual(1)
    await ctx.close()
  })
})

/* ============================================================= ingressos */

test.describe('ingressos', () => {
  test('matriz 89 · B10/B25 — código que não existe: HTTP 404 e "Pedido não encontrado"', async ({ page }) => {
    const r = await page.goto('/ingressos/PED-NAOE-XIST')
    expect(r?.status()).toBe(404)
    await expect(page.getByRole('heading', { name: 'Pedido não encontrado' })).toBeVisible()
  })

  test('matriz 90 · B10 — a consulta falha (500): "não respondeu", com Tentar de novo', async ({ page, request }) => {
    const pedido = await comprarPelaApi(request)
    await page.goto('/')
    await pronta(page)
    await page.route('**/api/pedido/**', (rota) => rota.fulfill({ status: 500, contentType: 'application/json',
      body: JSON.stringify({ statusCode: 500 }) }))
    // navegação do NAVEGADOR (o roteador da própria página), que é quem consulta a API
    await page.evaluate((c) => (document.querySelector('#__nuxt') as any).__vue_app__.config.globalProperties.$router
      .push(`/ingressos/${c}`), pedido.pedido)
    await expect(page.getByText('A bilheteria não respondeu agora')).toBeVisible()
    await expect(page.getByText('Pedido não encontrado')).toHaveCount(0)
    await page.unroute('**/api/pedido/**')
    await page.getByRole('button', { name: 'Tentar de novo' }).click()
    await expect(page.getByText(pedido.pedido).first()).toBeVisible()
  })

  test('matriz 91 · PIX pendente: QR, copiar e relógio — e "Total", não "Total pago"', async ({ page, request }) => {
    const pedido = await comprarPelaApi(request)
    await page.goto(`/ingressos/${pedido.pedido}`)
    await pronta(page)
    await expect(page.getByAltText('QR Code do PIX')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Copiar código PIX' })).toBeVisible()
    await expect(page.getByText(/Reserva garantida por/)).toBeVisible()
    await expect(page.getByText('AGUARDANDO PAGAMENTO')).toBeVisible()
    await expect(page.getByText('Total pago')).toHaveCount(0)
  })

  test('matriz 93 · pago: um bloco por ingresso, QR carregado e VÁLIDO (selo verde medido)', async ({ page, request }) => {
    const pedido = await comprarPelaApi(request, { quantidade: 2 })
    await pagarSimulado(request, pedido.pedido)
    await page.goto(`/ingressos/${pedido.pedido}`)
    await pronta(page)
    await expect(page.locator('article')).toHaveCount(2)
    const qr = page.locator('img[src^="/api/ingresso/"]').first()
    await expect(qr).toBeVisible()
    expect(await qr.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0)).toBe(true)
    await expect(page.getByText('VÁLIDO').first()).toBeVisible()
    // selo-ok = success-100 no fundo, success-800 no texto (tailwind.config.js), medido
    expect(await cor(page, 'article .selo-ok')).toBe('rgb(211, 248, 224)')
    expect(await cor(page, 'article .selo-ok', 'color')).toBe('rgb(22, 101, 52)')
  })

  test('matriz 97 · B01 — estorno PARCIAL: os ingressos continuam, com QR, e a página diz quanto voltou', async ({ page, request }) => {
    const pedido = await comprarPelaApi(request, { quantidade: 3 })
    await pagarSimulado(request, pedido.pedido)
    await avisoDoAsaas(request, 'PAYMENT_PARTIALLY_REFUNDED', pedido.pedidoId,
      { status: 'PARTIALLY_REFUNDED', value: pedido.totalCents / 100, refundedValue: 20 })
    await page.goto(`/ingressos/${pedido.pedido}`)
    await pronta(page)
    await expect(page.getByText('PAGO · DEVOLUÇÃO PARCIAL')).toBeVisible()
    await expect(page.getByText('R$ 20,00 deste pedido foram devolvidos')).toBeVisible()
    await expect(page.locator('article')).toHaveCount(3)
    await expect(page.locator('img[src^="/api/ingresso/"]')).toHaveCount(3)
    await expect(page.getByText('ainda não foi pago')).toHaveCount(0)
  })

  test('matriz 96/B10 — estorno TOTAL: "devolvido", sem ingresso, e o PNG do QR não abre', async ({ page, request }) => {
    const pedido = await comprarPelaApi(request, { quantidade: 1 })
    await pagarSimulado(request, pedido.pedido)
    const antes = await (await request.get(`/api/pedido/${pedido.pedido}`)).json()
    const ingressoId = antes.ingressos[0].id
    await avisoDoAsaas(request, 'PAYMENT_REFUNDED', pedido.pedidoId,
      { status: 'REFUNDED', value: pedido.totalCents / 100, refundedValue: pedido.totalCents / 100 })
    await page.goto(`/ingressos/${pedido.pedido}`)
    await pronta(page)
    await expect(page.getByText('O valor deste pedido foi devolvido')).toBeVisible()
    await expect(page.getByText('DEVOLVIDO', { exact: true })).toBeVisible()
    await expect(page.getByText('ainda não foi pago')).toHaveCount(0)
    await expect(page.getByText('Total pago')).toHaveCount(0)
    await expect(page.locator('article')).toHaveCount(0)
    const png = await request.get(`/api/ingresso/${ingressoId}/qr.png?pedido=${pedido.pedido}`)
    expect([404, 410]).toContain(png.status())
  })

  test('matriz 100/135 · QR com credencial trocada: 404; sem credencial: 400', async ({ request }) => {
    const pedido = await comprarPelaApi(request, { quantidade: 1 })
    await pagarSimulado(request, pedido.pedido)
    const v = await (await request.get(`/api/pedido/${pedido.pedido}`)).json()
    const id = v.ingressos[0].id
    expect((await request.get(`/api/ingresso/${id}/qr.png?pedido=${pedido.pedido}`)).status()).toBe(200)
    expect((await request.get(`/api/ingresso/${id}/qr.png?pedido=PED-OUTR-OPED`)).status()).toBe(404)
    expect((await request.get(`/api/ingresso/${id}/qr.png`)).status()).toBe(400)
  })

  test('B24 — página do pedido em Manaus: a hora é a do parque, sem aviso de hidratação', async ({ browser, request }) => {
    const pedido = await comprarPelaApi(request)
    const v = await (await request.get(`/api/pedido/${pedido.pedido}`)).json()
    const ctx = await browser.newContext({ timezoneId: 'America/Manaus', locale: 'pt-BR' })
    const page = await ctx.newPage()
    const problemas = vigia(page)
    await page.goto(`/ingressos/${pedido.pedido}`)
    await pronta(page)
    await page.waitForTimeout(500)
    await expect(page.locator('main, body').first()).toContainText(noFusoDoParque(v.evento.inicio))
    expect(problemas).toEqual([])
    await ctx.close()
  })

  test('matriz 98/96 · convite da casa: "Convidado", "Entrada: Cortesia" e selo CORTESIA; o cancelado pelo painel vira CANCELADO e o PNG responde 410', async ({ browser, page, request }) => {
    const { lote, inteira } = await vitrine(request)
    const painel = await logado(browser, 'master')
    const r = await painel.request.post(`/api/admin/evento/${EVENTO_ID}/cortesias`, { headers: { origin: BASE }, data: {
      loteId: lote, tipoId: inteira.tipoId, motivo: 'E2E — convite da casa', responsavel: 'Diretoria E2E',
      pessoas: [{ nome: 'Convidada E2E Um' }, { nome: 'Convidado E2E Dois' }] } })
    expect(r.status(), await r.text()).toBe(200)
    const codigo = (await r.json()).pedido as string
    await page.goto(`/ingressos/${codigo}`)
    await pronta(page)
    const ficha = page.locator('div.card').first()
    await expect(ficha).toContainText('Convidado')
    await expect(ficha).toContainText('Convidada E2E Um')
    await expect(ficha).toContainText('Entrada')
    await expect(ficha).toContainText('Cortesia')
    await expect(ficha, 'convite com "Comprador" em cima de ninguém').not.toContainText('Comprador')
    await expect(page.locator('article').getByText('CORTESIA', { exact: true })).toHaveCount(2)

    // matriz 96: o painel cancela um dos dois convites
    const v = await (await request.get(`/api/pedido/${codigo}`)).json()
    const cancelado = v.ingressos[1].id as string
    const d = await painel.request.delete(`/api/admin/evento/${EVENTO_ID}/cortesias`, {
      headers: { origin: BASE }, data: { id: cancelado } })
    expect(d.status(), await d.text()).toBe(200)
    await painel.close()
    await page.reload()
    await pronta(page)
    const segundo = page.locator('article').nth(1)
    await expect(segundo).toContainText('CANCELADO')
    await expect(segundo).toContainText('Ingresso cancelado')
    await expect(segundo.locator('img')).toHaveCount(0)
    expect((await request.get(`/api/ingresso/${cancelado}/qr.png?pedido=${codigo}`)).status()).toBe(410)
    // o outro convite segue valendo, com QR
    await expect(page.locator('article').first()).toContainText('VÁLIDO')
    await expect(page.locator('article').first().locator('img[src^="/api/ingresso/"]')).toBeVisible()
  })

  test('matriz 99 · cupom de 100%: a taxa continua (regra do dono) e o ingresso NÃO leva selo de cortesia', async ({ browser, page, request }) => {
    const painel = await logado(browser, 'master')
    const codigo = `E2E100${sufixo().toUpperCase()}`.slice(0, 20)
    const criado = await painel.request.post(`/api/admin/evento/${EVENTO_ID}/cupons`, {
      headers: { origin: BASE }, data: { codigo, tipo: 'percentual', valor: 10000, maxUsos: 50, maxPorCliente: 5 } })
    expect(criado.status(), await criado.text()).toBe(200)
    await painel.close()
    const pedido = await comprarPelaApi(request, { cupom: codigo })
    expect(pedido.descontoCents).toBe(pedido.faceCents)
    expect(pedido.totalCents, 'o cupom de 100% comeu a taxa').toBe(pedido.feeCents)
    expect(pedido.totalCents).toBeGreaterThan(0)
    await pagarSimulado(request, pedido.pedido)
    await page.goto(`/ingressos/${pedido.pedido}`)
    await pronta(page)
    await expect(page.locator('article')).toHaveCount(1)
    await expect(page.getByText('CORTESIA', { exact: true }), 'compra com cupom virou "esmola"').toHaveCount(0)
    await expect(page.getByText('Total pago')).toBeVisible()
    await expect(page.locator('div.card').first()).toContainText(emReais(pedido.feeCents))
  })

  test('matriz 101 · imprimir o ingresso: sem cabeçalho nem avisos; QR e código na folha', async ({ page, request }) => {
    const pedido = await comprarPelaApi(request, { quantidade: 1 })
    await pagarSimulado(request, pedido.pedido)
    await page.goto(`/ingressos/${pedido.pedido}`)
    await pronta(page)
    await expect(page.locator('header')).toBeVisible()
    await page.emulateMedia({ media: 'print' })
    await expect(page.locator('header')).toBeHidden()
    await expect(page.locator('.faixa-aviso')).toBeHidden()
    await expect(page.getByText('Guarde este link. Na portaria')).toBeHidden()
    await expect(page.locator('article img[src^="/api/ingresso/"]')).toBeVisible()
    await expect(page.locator('article [data-parte="codigo-do-ingresso"]')).toBeVisible()
    // e o Chrome imprime de verdade (PDF), sem erro
    const pdf = await page.pdf({ format: 'A4', printBackground: true })
    expect(pdf.byteLength).toBeGreaterThan(5_000)
    await page.emulateMedia({ media: 'screen' })
  })

  test('matriz 102 · celular 375: QR de 160 px no meio do cartão e o código numa linha só', async ({ browser, request }) => {
    const pedido = await comprarPelaApi(request, { quantidade: 1 })
    await pagarSimulado(request, pedido.pedido)
    const ctx = await celular(browser)
    const page = await ctx.newPage()
    await page.goto(`/ingressos/${pedido.pedido}`)
    await pronta(page)
    expect(await larguraDaPagina(page), 'rolagem de lado no celular').toBeLessThanOrEqual(375)
    const qr = (await page.locator('article img[src^="/api/ingresso/"]').first().boundingBox())!
    // `h-40 w-40` são 10 rem: 160 px na régua de 16, 170 no celular (a raiz sobe pra 17 px, base.css)
    expect(Math.round(qr.width), 'QR menor que 160 px no celular').toBeGreaterThanOrEqual(160)
    expect(Math.round(qr.width)).toBe(Math.round(qr.height))
    const cartao = (await page.locator('article').first().boundingBox())!
    expect(Math.abs((qr.x + qr.width / 2) - (cartao.x + cartao.width / 2)), 'o QR não está no meio').toBeLessThanOrEqual(2)
    const linhas = await page.locator('article [data-parte="codigo-do-ingresso"]').first().evaluate((e) => {
      const r = document.createRange()
      r.selectNodeContents(e)
      return r.getClientRects().length
    })
    expect(linhas, 'o código do ingresso quebrou de linha').toBe(1)
    await ctx.close()
  })
})

/* ========================================================= transferência */

test.describe('transferência', () => {
  let painel: Awaited<ReturnType<typeof logado>>
  test.beforeAll(async ({ browser }) => {
    painel = await logado(browser, 'master')
    const r = await painel.request.patch(`/api/admin/evento/${EVENTO_ID}/transferencias`, {
      headers: { origin: BASE }, data: { permitir: true } })
    expect(r.status(), await r.text()).toBe(200)
  })
  test.afterAll(async () => {
    await painel.request.patch(`/api/admin/evento/${EVENTO_ID}/transferencias`, {
      headers: { origin: BASE }, data: { permitir: false } })
    await painel.close()
  })

  /** Um ingresso pago e o link de transferência dele (pela tela do painel). */
  async function transferir(request: APIRequestContext) {
    const pedido = await comprarPelaApi(request, { quantidade: 1 })
    await pagarSimulado(request, pedido.pedido)
    const v = await (await request.get(`/api/pedido/${pedido.pedido}`)).json()
    const r = await painel.request.post(`/api/admin/evento/${EVENTO_ID}/transferencias`, {
      headers: { origin: BASE },
      data: { codigo: v.ingressos[0].codigo, paraNome: 'Ana Recebe E2E', paraEmail: emailNovo('recebe') } })
    expect(r.status(), await r.text()).toBe(200)
    const t = await r.json()
    const link = t.link ?? t.transferencia?.link
    expect(link).toMatch(/^\/transferencia\//)
    return { link, qr: v.ingressos[0].qr as string, pedido, id: t.transferencia?.id as string,
      codigo: v.ingressos[0].codigo as string, setor: v.ingressos[0].setor as string, tipo: v.ingressos[0].tipo as string }
  }

  test('matriz 103 · B10/B25 — link que não existe: HTTP 404 e "Link não encontrado"', async ({ page }) => {
    const r = await page.goto('/transferencia/token-que-nao-existe')
    expect(r?.status()).toBe(404)
    await expect(page.getByRole('heading', { name: 'Link não encontrado' })).toBeVisible()
  })

  test('matriz 104/105 · aguardando: evento, setor, tipo, remetente mascarado, nome preenchido e limites no campo', async ({ page, request }) => {
    const { link, setor, tipo } = await transferir(request)
    await page.goto(link)
    await pronta(page)
    await expect(page.getByText('Você recebeu um ingresso')).toBeVisible()
    await expect(page.getByRole('heading', { level: 1 })).toContainText('CONQUISTA PARK')
    const ficha = page.locator('dl').first()
    await expect(ficha.locator('div', { hasText: 'Setor' }).locator('dd')).toHaveText(setor)
    await expect(ficha.locator('div', { hasText: 'Tipo' }).locator('dd')).toHaveText(tipo)
    await expect(page.getByText(/•••@/)).toBeVisible()
    const nome = page.getByLabel('Nome completo')
    await expect(nome).toHaveValue('Ana Recebe E2E')
    await expect(nome).toHaveAttribute('maxlength', '120')
    await expect(nome).toHaveAttribute('required', '')
  })

  test('matriz 106 · B33 — CPF com letra/emoji: recusado com a frase e o campo marcado', async ({ page, request }) => {
    const { link } = await transferir(request)
    await page.goto(link)
    await pronta(page)
    const campoCpf = page.locator('input[inputmode="numeric"]')
    await campoCpf.fill('abc😀')
    await page.getByRole('button', { name: 'Aceitar ingresso' }).click()
    await expect(page.getByRole('alert')).toContainText('Digite só os números do CPF.')
    await expect(campoCpf).toHaveAttribute('aria-invalid', 'true')
  })

  test('matriz 107 · duplo clique em Aceitar: uma aceitação só', async ({ page, request }) => {
    const { link } = await transferir(request)
    await page.goto(link)
    await pronta(page)
    const posts: string[] = []
    page.on('request', (q) => { if (q.method() === 'POST' && q.url().includes('/api/transferencia/')) posts.push(q.url()) })
    await page.getByRole('button', { name: 'Aceitar ingresso' }).dblclick()
    await expect(page.getByText(/Ingresso é seu/)).toBeVisible()
    expect(posts.length, 'o duplo clique aceitou duas vezes').toBe(1)
  })

  // O "usado antes do aceite" (matriz 111) não dá pra montar aqui: a sessão do evento semeado é em
  // outubro e a catraca barra fora da janela, sem marcar o ingresso. O mesmo defeito (B33) tem o
  // irmão CANCELADO, que chega pelo estorno — é esse que o navegador exercita.
  test('B33 — ingresso cancelado ANTES do aceite (estorno): sem formulário, e a página diz por quê', async ({ page, request }) => {
    const { link, pedido } = await transferir(request)
    await avisoDoAsaas(request, 'PAYMENT_REFUNDED', pedido.pedidoId,
      { status: 'REFUNDED', value: pedido.totalCents / 100, refundedValue: pedido.totalCents / 100 })
    await page.goto(link)
    await pronta(page)
    await expect(page.getByRole('heading', { name: 'Ingresso cancelado' })).toBeVisible()
    await expect(page.getByText('Este ingresso foi cancelado e não pode mais ser transferido.')).toBeVisible()
    await expect(page.locator('form')).toHaveCount(0)
  })

  test('matriz 105 · o servidor também recusa o nome de 1 letra no aceite — e o ingresso não muda de dono', async ({ request }) => {
    const { link } = await transferir(request)
    const token = link.split('/').pop()!
    const r = await request.post(`/api/transferencia/${token}`, { headers: { origin: BASE }, data: { nome: 'A' } })
    expect(r.status()).toBe(400)
    expect((await (await request.get(`/api/transferencia/${token}`)).json()).status).toBe('aguardando')
  })

  test('matriz 95 · depois do aceite, o pedido de quem mandou mostra TRANSFERIDO, sem código e sem QR', async ({ page, request }) => {
    const { link, pedido } = await transferir(request)
    await page.goto(link)
    await pronta(page)
    await page.getByRole('button', { name: 'Aceitar ingresso' }).click()
    await expect(page.getByText(/Ingresso é seu/)).toBeVisible()
    await page.goto(`/ingressos/${pedido.pedido}`)
    await pronta(page)
    const bloco = page.locator('article').first()
    await expect(bloco).toContainText('TRANSFERIDO')
    await expect(bloco).toContainText('Ingresso transferido para outra pessoa')
    await expect(bloco.locator('img'), 'o remetente ainda tinha o QR do ingresso que passou adiante').toHaveCount(0)
    await expect(bloco.getByText('Código', { exact: true })).toHaveCount(0)
  })

  test('matriz 110 · o painel desfaz a transferência já aceita: quem recebeu perde o QR, o código muda de novo e quem mandou volta a ver o ingresso', async ({ page, request }) => {
    const { link, pedido, id, codigo: doRemetente } = await transferir(request)
    const token = link.split('/').pop()!
    await page.goto(link)
    await pronta(page)
    await page.getByRole('button', { name: 'Aceitar ingresso' }).click()
    await expect(page.getByText(/Ingresso é seu/)).toBeVisible()
    const doDestinatario = (await (await request.get(`/api/transferencia/${token}`)).json()).ingresso?.codigo
    expect(doDestinatario, 'o aceite não trocou o código').not.toBe(doRemetente)

    const r = await painel.request.patch(`/api/admin/evento/${EVENTO_ID}/transferencias`, {
      headers: { origin: BASE }, data: { transferenciaId: id, acao: 'cancelar' } })
    expect(r.status(), await r.text()).toBe(200)
    expect((await r.json()).devolvido).toBe(true)

    // quem recebeu: sem QR, e a página diz o que houve
    await page.reload()
    await pronta(page)
    await expect(page.getByText('Quem enviou cancelou esta transferência.')).toBeVisible()
    await expect(page.locator('img[alt^="QR do ingresso"]'), 'o destinatário seguiu com o QR').toHaveCount(0)
    // quem mandou: o ingresso volta, com QR e um código NOVO (nem o antigo, nem o do destinatário)
    await page.goto(`/ingressos/${pedido.pedido}`)
    await pronta(page)
    const bloco = page.locator('article').first()
    await expect(bloco).toContainText('VÁLIDO')
    await expect(bloco.locator('img[src^="/api/ingresso/"]')).toBeVisible()
    const agora = (await bloco.locator('[data-parte="codigo-do-ingresso"]').textContent())?.trim()
    expect(agora).toBeTruthy()
    expect(agora, 'voltou o código que o destinatário conhecia').not.toBe(doDestinatario)
    expect(agora, 'voltou o código de antes da transferência').not.toBe(doRemetente)
  })
})

/* ================================================================== home */

test.describe('home', () => {
  test('B23 — os títulos descem em ordem (h2 → h3), sem pular pra h4', async ({ page }) => {
    await page.goto('/')
    await pronta(page)
    const niveis = await page.locator('h1, h2, h3, h4, h5, h6').evaluateAll((els) =>
      els.map((e) => Number(e.tagName.slice(1))))
    for (let i = 1; i < niveis.length; i++) {
      expect(niveis[i] - niveis[i - 1], `pulo de h${niveis[i - 1]} pra h${niveis[i]}`).toBeLessThanOrEqual(1)
    }
    await expect(page.locator('#ingressos h3').first()).toBeVisible()
  })

  test('B31 — a descrição do evento guarda as quebras de linha (white-space medido)', async ({ page }) => {
    await page.goto('/')
    await pronta(page)
    const ws = await page.locator('#ingressos h2#precos + p').evaluate((el) => getComputedStyle(el).whiteSpace)
    expect(ws).toBe('pre-line')
  })

  test('matriz 1 · a lista chega pronta do servidor: sem JavaScript ela já está lá, e com a rede lenta nunca pisca "Nenhum evento"', async ({ browser }) => {
    // o HTML do servidor, sem JavaScript nenhum
    const semJs = await browser.newContext({ javaScriptEnabled: false })
    const cru = await semJs.newPage()
    await cru.goto('/')
    await expect(cru.locator('#ingressos h3').first()).toBeVisible()
    await expect(cru.getByText('Nenhum evento à venda no momento')).toHaveCount(0)
    await expect(cru.getByText('Carregando os eventos…')).toHaveCount(0)
    await semJs.close()

    // rede lenta (latência de 250 ms e 400 KB/s): o JavaScript chega devagar, e a hidratação não
    // troca a lista por "vazio" nem por um instante — um vigia marca se a frase aparecer
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    await page.addInitScript(() => {
      const w = window as any
      w.__piscou = false
      new MutationObserver(() => {
        if (document.getElementById('ingressos')?.innerText.includes('Nenhum evento à venda')) w.__piscou = true
      }).observe(document, { childList: true, subtree: true, characterData: true })
    })
    const cdp = await ctx.newCDPSession(page)
    await cdp.send('Network.enable')
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false, latency: 250, downloadThroughput: 400 * 1024, uploadThroughput: 200 * 1024 })
    await page.goto('/', { timeout: 150_000 })
    await pronta(page, 150_000)
    await expect(page.locator('#ingressos h3').first()).toBeVisible()
    expect(await page.evaluate(() => (window as any).__piscou), 'a lista piscou "Nenhum evento à venda"').toBe(false)
    await ctx.close()
  })

  test('matriz 2 · a lista não carrega (rota fora, vindo de /entrar): faixa de erro, nunca "Nenhum evento à venda"', async ({ page }) => {
    await page.goto('/entrar')
    await pronta(page)
    await page.route('**/api/eventos-publicos**', (rota) => rota.fulfill({ status: 500, contentType: 'application/json',
      body: JSON.stringify({ statusCode: 500 }) }))
    await page.locator('a[href="/"]').first().click()
    await expect(page.getByText('Não deu pra carregar a lista de eventos agora')).toBeVisible()
    await expect(page.getByText('Nenhum evento à venda no momento')).toHaveCount(0)
  })

  test('matriz 3 · nenhum evento à venda: a frase certa, e os três "Comprar ingressos" rolam até #ingressos', async ({ page }) => {
    await page.goto('/entrar')
    await pronta(page)
    await page.route('**/api/eventos-publicos**', (rota) => rota.fulfill({ json: { eventos: [] } }))
    await page.locator('a[href="/"]').first().click()
    await expect(page.getByText('Nenhum evento à venda no momento. Volte em breve.')).toBeVisible()
    const comprar = page.getByRole('link', { name: 'Comprar ingressos' })
    expect(await comprar.evaluateAll((els) => els.map((e) => e.getAttribute('href'))))
      .toEqual(['/#ingressos', '/#ingressos', '/#ingressos'])
    await comprar.last().click()
    await expect(page).toHaveURL(/\/#ingressos$/)
    await expect(page.locator('#ingressos')).toBeInViewport()
  })

  test('matriz 4 · um selo por situação, com a cor de verdade', async ({ page }) => {
    await page.goto('/entrar')
    await pronta(page)
    const SITUACOES = ['disponivel', 'ultimas', 'em_breve', 'esgotado', 'encerrado']
    await comResposta(page, '**/api/eventos-publicos**', (j) => {
      const base = j.eventos[0]
      const copia = (situacao: string) => ({ ...base, slug: `${base.slug}-zz-${situacao}`, nome: `ZZ ${situacao}`,
        situacao, aPartirDeCents: null })
      return { ...j, eventos: [base, ...SITUACOES.map(copia)] }
    })
    await page.locator('a[href="/"]').first().click()
    const esperado: Record<string, [string, string]> = {
      disponivel: ['À VENDA', 'rgb(211, 248, 224)'],        // verde (success-100)
      ultimas: ['ÚLTIMAS UNIDADES', 'rgb(254, 237, 199)'],  // amarelo (warning-100)
      em_breve: ['EM BREVE', 'rgb(239, 238, 244)'],         // cinza (ink-100)
      esgotado: ['ESGOTADO', 'rgb(254, 226, 226)'],         // vermelho (danger-100)
      encerrado: ['ENCERRADO', 'rgb(239, 238, 244)'],       // cinza
    }
    for (const s of SITUACOES) {
      const selo = page.getByRole('link', { name: new RegExp(`ZZ ${s}`) }).getByText(esperado[s][0], { exact: true })
      await expect(selo, s).toBeVisible()
      expect(await selo.evaluate((e) => getComputedStyle(e).backgroundColor), `${s}: cor do selo`).toBe(esperado[s][1])
    }
  })

  // Com mais de um evento a home mostra só a grade de cartões (sem as linhas de preço de cada um):
  // o riscado da variação esgotada é do cartão do evento ÚNICO.
  test('matriz 8 · evento único: a variação esgotada sai riscada e a outra não', async ({ page }) => {
    await page.goto('/entrar')
    await pronta(page)
    await comResposta(page, '**/api/eventos-publicos**', (j) => ({ ...j, eventos: [j.eventos.find((e: any) => e.slug === SLUG) ?? j.eventos[0]] }))
    await comResposta(page, `**/api/e/${SLUG}`, (j) => {
      const l = j.setores[0].lotes[0]
      l.variacoes = l.variacoes.map((v: any) => (v.ehMeia ? { ...v, esgotado: true } : v))
      return j
    })
    await page.locator('a[href="/"]').first().click()
    const sabado = page.locator('#ingressos ul.grid > li').first()
    const preco = (nome: RegExp) => sabado.locator('li').filter({ hasText: nome }).locator('span').last()
      .evaluate((e) => getComputedStyle(e).textDecorationLine)
    expect(await preco(/Meia/), 'a meia esgotada não saiu riscada').toContain('line-through')
    expect(await preco(/Inteira/), 'a inteira (que vende) saiu riscada').not.toContain('line-through')
  })

  test('matriz 12 · rodapé: "Ingressos e datas" rola até #ingressos e "Área da equipe" abre /entrar', async ({ page }) => {
    await page.goto('/')
    await pronta(page)
    const rodape = page.locator('footer')
    await rodape.scrollIntoViewIfNeeded()
    await rodape.getByRole('link', { name: 'Ingressos e datas' }).click()
    await expect(page).toHaveURL(/\/#ingressos$/)
    await expect(page.locator('#ingressos')).toBeInViewport()
    await rodape.scrollIntoViewIfNeeded()
    await rodape.getByRole('link', { name: 'Área da equipe' }).click()
    await expect(page).toHaveURL(/\/entrar$/)
    await expect(page.getByLabel(/senha/i)).toBeVisible()
  })

  test('matriz 7 · os três "Comprar ingressos" (cabeçalho, capa e fim) levam à vitrine do evento à venda', async ({ page }) => {
    await page.goto('/')
    await pronta(page)
    const comprar = page.getByRole('link', { name: 'Comprar ingressos' })
    expect(await comprar.evaluateAll((els) => els.map((e) => e.getAttribute('href'))))
      .toEqual([`/e/${SLUG}`, `/e/${SLUG}`, `/e/${SLUG}`])
    await comprar.last().click()
    await expect(page).toHaveURL(new RegExp(`/e/${SLUG}$`))
    await expect(page.getByRole('heading', { name: /Escolha seus/ })).toBeVisible()
  })

  test('matriz 9 · dúvidas pelo teclado: o Tab chega na pergunta com o foco à mostra, e o Enter abre e fecha', async ({ page }) => {
    await page.goto('/')
    await pronta(page)
    const perguntas = page.locator('section[aria-labelledby="duvidas"] summary')
    const primeira = page.locator('section[aria-labelledby="duvidas"] details').first()
    await perguntas.nth(1).focus()
    await page.keyboard.press('Shift+Tab')
    await expect(perguntas.first()).toBeFocused()
    const foco = await perguntas.first().evaluate((e) => {
      const s = getComputedStyle(e)
      return { visivel: e.matches(':focus-visible'), estilo: s.outlineStyle, largura: parseFloat(s.outlineWidth) }
    })
    expect(foco.visivel).toBe(true)
    expect(foco.estilo !== 'none' && foco.largura >= 2, `foco invisível: ${JSON.stringify(foco)}`).toBe(true)
    await page.keyboard.press('Enter')
    await expect(primeira).toHaveJSProperty('open', true)
    await page.keyboard.press('Enter')
    await expect(primeira).toHaveJSProperty('open', false)
    await page.keyboard.press('Tab')
    await expect(perguntas.nth(1)).toBeFocused()
  })

  test('matriz 10 · "reduzir movimento": sem bolhas, letreiro e ondas parados, e nada escondido esperando a rolagem', async ({ browser, page }) => {
    // o controle: sem a preferência, o letreiro corre (senão o caso não provaria nada)
    await page.goto('/')
    await pronta(page)
    expect(await page.locator('.letreiro-trilho').evaluate((e) => getComputedStyle(e).animationName)).not.toBe('none')

    const ctx = await browser.newContext({ reducedMotion: 'reduce' })
    const calma = await ctx.newPage()
    await calma.goto('/')
    await pronta(calma)
    await calma.evaluate(() => document.fonts.ready)
    await calma.waitForTimeout(300)
    const bolhas = await calma.locator('.bolha').evaluateAll((els) => els.map((e) => getComputedStyle(e).display))
    expect(bolhas.length).toBeGreaterThan(0)
    expect(bolhas.every((d) => d === 'none'), 'bolha subindo com "reduzir movimento"').toBe(true)
    expect(await calma.locator('.letreiro-trilho').evaluate((e) => getComputedStyle(e).animationName)).toBe('none')
    const ondas = await calma.locator('.ondas-lentas').evaluateAll((els) => els.map((e) => getComputedStyle(e).animationName))
    expect(ondas.length).toBeGreaterThan(0)
    expect(ondas.every((a) => a === 'none'), 'onda balançando com "reduzir movimento"').toBe(true)
    expect(await calma.locator('.revelar').count(), 'conteúdo escondido esperando a rolagem').toBe(0)
    await expect(calma.locator('#ingressos h3').first()).toBeVisible()
    await ctx.close()
  })

  test('matriz 11 · celular 375: sem rolagem de lado, e os cartões de preço numa coluna só', async ({ browser }) => {
    const ctx = await celular(browser)
    const page = await ctx.newPage()
    await page.goto('/')
    await pronta(page)
    expect(await larguraDaPagina(page), 'rolagem de lado no celular').toBeLessThanOrEqual(375)
    // os cartões: os dos setores (li.group, evento único) ou os da grade de eventos (2+) — não as
    // linhas de preço de dentro deles, que também são `ul.grid > li`
    const esquerdas = await page.locator('#ingressos ul.grid > li.group, [data-parte="eventos-da-home"] > li')
      .evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().left)))
    expect(esquerdas.length).toBeGreaterThan(1)
    expect(new Set(esquerdas).size, 'cartões lado a lado no celular').toBe(1)
    await ctx.close()
  })

  test('matriz 13 · imprimir: o que esperava a rolagem sai no papel', async ({ page }) => {
    await page.goto('/')
    await pronta(page)
    // na tela, o que está abaixo da dobra fica escondido até a pessoa rolar (o controle do caso)
    await expect.poll(() => page.locator('.revelar').count(), { timeout: 15_000 }).toBeGreaterThan(0)
    await page.emulateMedia({ media: 'print' })
    const escondidos = await page.locator('[data-revelar]')
      .evaluateAll((els) => els.filter((e) => getComputedStyle(e).opacity !== '1').length)
    expect(escondidos, 'bloco invisível no papel').toBe(0)
    await page.emulateMedia({ media: 'screen' })
  })
})

/* ================================================================ entrar */

test.describe('entrar', () => {
  test('matriz 117/120 · ?de= para outro site: depois de entrar fica no /admin; o cookie é HttpOnly, SameSite=Lax, Path=/ e vale 30 dias', async ({ browser }) => {
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    await page.goto('/entrar?de=https://site-de-fora.example/roubo')
    await pronta(page)
    await page.getByPlaceholder(/@/).fill(LOGINS.master)
    await page.getByLabel(/senha/i).fill(SENHA)
    await page.getByRole('button', { name: /^entrar$/i }).click()
    await expect(page).toHaveURL(/\/admin/, { timeout: 30_000 })
    expect(new URL(page.url()).host, 'o login mandou a pessoa pra fora do site').toBe(new URL(BASE).host)
    // matriz 120: o cookie da sessão
    const c = (await ctx.cookies()).find((k) => k.name === 'dt_sessao')
    expect(c, 'sem cookie de sessão depois de entrar').toBeTruthy()
    expect(c!.httpOnly).toBe(true)
    expect(c!.sameSite).toBe('Lax')
    expect(c!.path).toBe('/')
    const dias = (c!.expires * 1000 - Date.now()) / 86_400_000
    expect(dias).toBeGreaterThan(29.9)
    expect(dias).toBeLessThanOrEqual(30.01)
    // na máquina é http: Secure aqui descartaria o cookie. Em produção ele vai (conferido no build).
    expect(c!.secure).toBe(false)
    await ctx.close()
  })

  test('matriz 119 · F5 com a senha digitada: ela não volta, nem fica guardada no navegador', async ({ page }) => {
    await page.goto('/entrar')
    await pronta(page)
    await page.getByLabel(/senha/i).fill('senha-que-nao-pode-ficar')
    await page.reload()
    await pronta(page)
    await expect(page.getByLabel(/senha/i)).toHaveValue('')
    const guardado = await page.evaluate(() => JSON.stringify({ ...sessionStorage }) + JSON.stringify({ ...localStorage }))
    expect(guardado).not.toContain('senha-que-nao-pode-ficar')
  })
})

/* =================================================================== API */

test.describe('API pública', () => {
  test('matriz 121 · preço no corpo é ignorado: o total é o do banco', async ({ request }) => {
    const { lote, inteira } = await vitrine(request)
    await contaNova(request)
    const r = await request.post('/api/checkout', { headers: { origin: BASE }, data: {
      eventSlug: SLUG, itens: [{ lotId: lote, ticketTypeId: inteira.tipoId, quantidade: 1, unitTotalCents: 1, precoCents: 1 }],
      totalCents: 1, comprador: { nome: 'Comprador E2E Público', email: emailNovo(), documento: cpf() } } })
    expect(r.status()).toBe(200)
    expect((await r.json()).totalCents).toBe(inteira.totalCents)
  })

  test('matriz 122/123 · quantidade 0, -1, 51, 1e9 e 21 itens: 400', async ({ request }) => {
    const { lote, inteira } = await vitrine(request)
    await contaNova(request)
    const corpo = (itens: any[]) => ({ eventSlug: SLUG, itens,
      comprador: { nome: 'Comprador E2E Público', email: emailNovo(), documento: cpf() } })
    for (const quantidade of [0, -1, 51, 1e9]) {
      const r = await request.post('/api/checkout', { headers: { origin: BASE },
        data: corpo([{ lotId: lote, ticketTypeId: inteira.tipoId, quantidade }]) })
      expect(r.status(), `quantidade ${quantidade}`).toBe(400)
    }
    const vinteEUm = Array.from({ length: 21 }, () => ({ lotId: lote, ticketTypeId: inteira.tipoId, quantidade: 1 }))
    expect((await request.post('/api/checkout', { headers: { origin: BASE }, data: corpo(vinteEUm) })).status()).toBe(400)
  })

  test('matriz 127 · declaração de meia numa inteira: 422 meia_em_inteira', async ({ request }) => {
    const { lote, inteira } = await vitrine(request)
    await contaNova(request)
    const r = await request.post('/api/checkout', { headers: { origin: BASE }, data: {
      eventSlug: SLUG, itens: [{ lotId: lote, ticketTypeId: inteira.tipoId, quantidade: 1,
        meia: { motivo: 'estudante', documento: 'CART-123' } }],
      comprador: { nome: 'Comprador E2E Público', email: emailNovo(), documento: cpf() } } })
    expect(r.status()).toBe(422)
    expect(JSON.stringify(await r.json())).toContain('meia_em_inteira')
  })

  test('matriz 137/138 · portaria sem login: 401; catraca com origem de outro site: 403', async ({ browser, request }) => {
    expect((await request.post('/api/portaria/sincronizar', { data: {} })).status()).toBe(401)
    const portaria = await logado(browser, 'portaria')
    const r = await portaria.request.post('/api/checkin', {
      headers: { origin: 'https://site-de-fora.example' }, data: { qr: 'DT2:x:y:z:w', eventId: EVENTO_ID } })
    expect(r.status()).toBe(403)
    await portaria.close()
  })

  test('B03/B04/B15 — a própria máquina não é freada (o E2E compra em sequência)', async ({ request }) => {
    for (let i = 0; i < 25; i++) {
      expect((await request.get(`/api/pedido/PED-ZZ00-${String(i).padStart(4, '0')}`)).status()).toBe(404)
    }
  })

  test('/api/saude — responde e não vaza segredo', async ({ request }) => {
    const r = await request.get('/api/saude')
    expect([200, 503]).toContain(r.status())
    const corpo = await r.text()
    expect(corpo).not.toMatch(/postgres(ql)?:\/\/|\$aact_|dmd_live_|smtp:\/\//i)
    const j = JSON.parse(corpo)
    expect(j.banco?.ok).toBe(true)
    expect(Object.values(j.config ?? {}).every((x: any) => ['SIM', 'NÃO'].includes(String(x)) || typeof x === 'object')).toBe(true)
  })

  test('matriz 125/126 · tipo de OUTRO lote: 400 "não é deste lote"; lote com tipos e sem o tipo: 400 "Escolha o tipo"', async ({ request }) => {
    const { v, lote } = await vitrine(request)
    await contaNova(request)
    const tipoDoDomingo = v.setores[1].lotes[0].variacoes.find((x: any) => !x.ehMeia).tipoId
    const corpo = (itens: any[]) => ({ eventSlug: SLUG, itens,
      comprador: { nome: 'Comprador E2E Público', email: emailNovo(), documento: cpf() } })
    const deOutro = await request.post('/api/checkout', { headers: { origin: BASE },
      data: corpo([{ lotId: lote, ticketTypeId: tipoDoDomingo, quantidade: 1 }]) })
    expect(deOutro.status()).toBe(400)
    expect(JSON.stringify(await deOutro.json())).toContain('Tipo de ingresso não é deste lote')
    const semTipo = await request.post('/api/checkout', { headers: { origin: BASE },
      data: corpo([{ lotId: lote, quantidade: 1 }]) })
    expect(semTipo.status()).toBe(400)
    expect(JSON.stringify(await semTipo.json())).toContain('Escolha o tipo de ingresso de \\"ENTRADA\\"')
  })

  test('matriz 129/130 · o aviso do Asaas repetido emite UMA vez; o OVERDUE que chega atrasado não despaga', async ({ request }) => {
    const pedido = await comprarPelaApi(request, { quantidade: 2 })
    // a MESMA entrega duas vezes (mesmo id de evento), como o Asaas reenvia
    const entrega = { id: `evt_e2e_rep_${sufixo()}`, event: 'PAYMENT_RECEIVED',
      payment: { id: `sim_e2e_${sufixo()}`, externalReference: pedido.pedidoId, status: 'RECEIVED',
        billingType: 'PIX', value: pedido.totalCents / 100 } }
    for (let i = 0; i < 2; i++) {
      const r = await request.post('/api/webhooks/asaas', { data: entrega })
      expect(r.status(), `entrega ${i + 1}: ${await r.text()}`).toBe(200)
    }
    const pago = await (await request.get(`/api/pedido/${pedido.pedido}`)).json()
    expect(pago.status).toBe('pago')
    expect(pago.ingressos, 'a entrega repetida emitiu de novo').toHaveLength(2)
    // o OVERDUE de ontem, reenviado depois do pagamento
    await avisoDoAsaas(request, 'PAYMENT_OVERDUE', pedido.pedidoId, { status: 'OVERDUE', value: pedido.totalCents / 100 })
    const depois = await (await request.get(`/api/pedido/${pedido.pedido}`)).json()
    expect(depois.status, 'o OVERDUE atrasado despagou um pedido pago').toBe('pago')
    expect(depois.ingressos.map((t: any) => t.status)).toEqual(['valido', 'valido'])
  })

  test('matriz 136 · /api/midia com caminho fora do padrão: 400, nunca o arquivo', async ({ request }) => {
    for (const caminho of ['/api/midia/..%2F..%2F.env', '/api/midia/x',
      '/api/midia/eventos%2F..%2F..%2F..%2Fpackage.json']) {
      expect((await request.get(caminho)).status(), caminho).toBe(400)
    }
  })
})
