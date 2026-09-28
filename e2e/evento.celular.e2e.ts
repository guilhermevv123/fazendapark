/**
 * evento.celular.e2e.ts — portaria e balcão NO CELULAR (frota F3, 28/09), a 390 px: o leitor de
 * entrada (online, sem rede, só conferir, QR torto, câmera sem o leitor) e o PDV (abrir caixa,
 * vender com duplo clique e com F5 no meio, meia-entrada, conferência cega, trocar de caixa), mais
 * o painel e a varredura de 375 px das telas do evento.
 *
 *   E2E_BASE=http://127.0.0.1:3123 npx playwright test e2e/evento.e2e.ts e2e/evento.celular.e2e.ts
 *
 * Sem rede é `context.setOffline(true)` — o navegador inteiro fica sem rede, como o tablet no
 * apagão; o leitor decide pela lista que baixou e manda a fila quando a rede volta.
 */
import { chromium, expect, test, type APIRequestContext, type Page } from '@playwright/test'
import { BASE, sessao, travaDeBase, unico, vigiar } from './apoio'
import {
  abrir, abrirBalcao, apiComo, corpo, cpfDeTeste, criarEvento, ingressosDoPedido, limpo, rolaNaHorizontal,
  venderNoBalcao, type EventoDeTeste,
} from './evento-apoio'

test.beforeAll(() => travaDeBase(BASE))
test.use({ viewport: { width: 390, height: 844 } })

let master: APIRequestContext
let ev: EventoDeTeste
let balcao: { pontoId: string; turnoId: string }

test.beforeAll(async () => {
  master = await apiComo('master')
  ev = await criarEvento(master)
  balcao = await abrirBalcao(master, ev.id)
})
test.afterAll(async () => { await master?.dispose() })

/** ingressos novos, vendidos no balcão pela rota do guichê */
async function ingressos(n: number, extra: { ticketTypeId?: string; meia?: any; comprador?: any } = {}) {
  const v = await venderNoBalcao(master, ev.id, balcao.turnoId,
    [{ lotId: ev.lote.id, ticketTypeId: extra.ticketTypeId ?? ev.inteira, quantidade: n, meia: extra.meia ?? null }],
    'pix', extra.comprador ? { comprador: extra.comprador } : {})
  return v.ingressos
}

const leitor = (id = ev.id) => `/admin/evento/${id}/validacao`

/** lê como o leitor de mão lê: o texto do QR no campo e Enter */
async function ler(page: Page, texto: string) {
  const campo = page.locator('#cod')
  await campo.fill(texto)
  await campo.press('Enter')
  await expect(page.locator('#cod')).toHaveValue('', { timeout: 15_000 })
}
const veredito = (page: Page) => page.locator('[data-parte="veredito"]')
const cartao = (page: Page) => page.locator('[data-parte="cartao-veredito"]')

/* ======================================================= leitor, com rede */

test.describe('leitor (portaria, 390 px)', () => {
  test.use({ storageState: sessao('portaria') })

  test('#172 no celular o campo e o veredito vêm logo abaixo do título (ADM-24)', async ({ page }) => {
    const [t] = await ingressos(1)
    await abrir(page, leitor())
    const campo = await page.locator('#cod').boundingBox()
    expect(campo!.y, 'o campo desceu pra baixo da dobra').toBeLessThan(844 - 60)
    await ler(page, t.qr)
    const v = await cartao(page).boundingBox()
    const contador = await page.locator('[data-parte="contador"]').boundingBox()
    expect(v!.y, 'o veredito ficou embaixo dos números').toBeLessThan(contador!.y)
    expect(await rolaNaHorizontal(page)).toBe(false)
  })

  test('#163 QR válido entra; o mesmo QR de novo é barrado com onde e quando; digitado pede documento', async ({ page }) => {
    const [a, b] = await ingressos(2)
    const problemas = vigiar(page)
    await abrir(page, leitor())
    await page.locator('#gate').fill('Norte')
    await ler(page, a.qr)
    await expect(veredito(page)).toHaveText('PODE ENTRAR')
    await expect(page.locator('[data-parte="codigo-digitado"]')).toHaveCount(0)
    await ler(page, a.qr)
    await expect(veredito(page)).toHaveText('BARRADO')
    await expect(cartao(page)).toContainText('pelo portão Norte')
    // o código digitado à mão entra, e o cartão manda conferir o documento (ADM-25)
    await ler(page, b.codigo)
    await expect(veredito(page)).toHaveText('PODE ENTRAR')
    await expect(page.locator('[data-parte="codigo-digitado"]')).toHaveText('Digitado à mão: confira o documento')
    expect(problemas.filter((p) => /^5\d\d|exceção/.test(p))).toEqual([])
  })

  test('#163 QR de outro evento, QR fabricado e QR torto: nenhum vira o ingresso de outra pessoa', async ({ page }) => {
    const [alvo] = await ingressos(1)
    const outro = await criarEvento(master)
    const b2 = await abrirBalcao(master, outro.id)
    const [deFora] = (await venderNoBalcao(master, outro.id, b2.turnoId,
      [{ lotId: outro.lote.id, ticketTypeId: outro.inteira, quantidade: 1 }], 'pix')).ingressos
    await abrir(page, leitor())
    await ler(page, deFora.qr)
    await expect(veredito(page)).toHaveText('BARRADO')
    await expect(cartao(page)).toContainText(/outro evento/i)
    // assinatura trocada: fabricado
    const partes = alvo.qr.split(':')
    await ler(page, [...partes.slice(0, -1), 'AAAAAAAAAA'].join(':'))
    await expect(veredito(page)).toHaveText('BARRADO')
    // QR torto (DT2 sem a assinatura, DT1 com parte a mais): é "código digitado" inteiro, recusado
    await ler(page, `DT2:k1:${ev.id}:${alvo.codigo}`)
    await expect(veredito(page)).toHaveText('BARRADO')
    await ler(page, `${alvo.qr}:X`)
    await expect(veredito(page)).toHaveText('BARRADO')
    // e o ingresso de verdade continua valendo: nenhum dos tortos entrou por ele
    await ler(page, alvo.qr)
    await expect(veredito(page)).toHaveText('PODE ENTRAR')
  })

  test('#165 "Só conferir" vale UMA leitura, diz que ninguém entrou, e desliga sozinho (ADM-03)', async ({ page }) => {
    const [t] = await ingressos(1)
    await abrir(page, leitor())
    await page.locator('[data-parte="so-conferir"] input').check()
    await expect(page.locator('[data-parte="modo-consulta"]')).toContainText('MODO CONSULTA')
    await ler(page, t.qr)
    await expect(veredito(page)).toHaveText('VÁLIDO — NÃO ENTROU')
    await expect(page.locator('[data-parte="so-conferir"] input')).not.toBeChecked()
    await expect(page.locator('[data-parte="modo-consulta"]')).toHaveCount(0)
    // a próxima leitura é entrada de verdade — a consulta não gastou o ingresso
    await ler(page, t.qr)
    await expect(veredito(page)).toHaveText('PODE ENTRAR')
  })

  test('#170 meia-entrada: o cartão diz o motivo e o documento a pedir', async ({ page }) => {
    const [m] = await ingressos(1, {
      ticketTypeId: ev.meia, meia: { motivo: 'estudante', documento: 'CIE-12345' },
      comprador: { nome: 'Estudante Teste', documento: cpfDeTeste() },
    })
    await abrir(page, leitor())
    await ler(page, m.qr)
    await expect(veredito(page)).toHaveText('PODE ENTRAR')
    await expect(cartao(page)).toContainText('MEIA-ENTRADA')
    await expect(cartao(page)).toContainText('Peça este documento')
  })

  test('#171 portaria: o leitor funciona e o quarto card mostra as passagens sem rede (nada de 403 na tela)', async ({ page }) => {
    await abrir(page, leitor())
    await expect(page.getByText('Passagens sem rede')).toBeVisible()
    await expect(page.locator('main')).not.toContainText('Seu acesso')
  })
})

/* ======================================================= leitor, sem rede */

test.describe('leitor sem rede (portaria, 390 px)', () => {
  test.use({ storageState: sessao('portaria') })

  test('#167 #168 sem rede decide pela lista, barra a segunda passagem, e a fila conta a pessoa UMA vez (ADM-06, ADM-25)', async ({ page, context }) => {
    const [a, b] = await ingressos(2)
    await abrir(page, leitor())
    await expect(page.locator('main')).toContainText(/Lista:\s*[1-9]\d*\s*ingressos\s*·\s*baixada/)
    // a lista do aparelho não guarda o código em claro (ADM-25)
    const guardado = await page.evaluate(() => JSON.stringify(Object.fromEntries(Object.entries(localStorage))))
    expect(guardado).not.toContain(a.codigo)
    expect(guardado).not.toContain(b.codigo)

    await context.setOffline(true)
    try {
      await expect(page.locator('[data-parte="rede-curta"]')).toContainText('Sem rede')
      await ler(page, a.qr)
      await expect(veredito(page)).toHaveText('PODE ENTRAR')
      await expect(cartao(page)).toContainText('decidido no aparelho, sem rede')
      await ler(page, a.qr)
      await expect(veredito(page)).toHaveText('BARRADO')
      await expect(page.locator('[data-parte="rede-curta"]')).toContainText('1 na fila')
    } finally {
      await context.setOffline(false)
    }
    // a rede volta: a fila sobe sozinha e zera
    await expect(page.getByText('Fila para enviar: 0')).toBeVisible({ timeout: 30_000 })
    await page.getByRole('button', { name: /Enviar fila/ }).isDisabled()
    const hist = await corpo(await master.get(`/api/admin/evento/${ev.id}/checkins?busca=${a.codigo}&resultado=ok`))
    expect(hist.leituras.filter((l: any) => l.resultado === 'ok'), 'a pessoa entrou duas vezes no livro').toHaveLength(1)
  })

  test('#167 sem rede e sem lista: "não dá pra conferir", nunca um barrado nem um entra', async ({ page, context }) => {
    const [t] = await ingressos(1)
    // a lista nunca desce: o aparelho que chegou sem sinal
    await page.route('**/api/portaria/sincronizar', (r) => r.abort('internetdisconnected'))
    await abrir(page, leitor())
    await expect(page.getByText('nunca baixada')).toBeVisible()
    await context.setOffline(true)
    try {
      await ler(page, t.qr)
      await expect(veredito(page)).toHaveText('NÃO LIDO — TENTE DE NOVO')
      await expect(cartao(page)).toContainText('não dá pra conferir')
    } finally {
      await context.setOffline(false)
    }
  })
})

/* ============================================== câmera sem o leitor (jsQR) */

test.describe('câmera da portaria sem o pedaço do leitor', () => {
  // câmera falsa do Chrome: é opção de LANÇAR o navegador (não dá por grupo), então o caso abre o dele
  test('#166 o leitor não baixou: a câmera é solta, o recado é honesto e o botão recarrega (ADM-59)', async () => {
    const navegador = await chromium.launch({
      channel: 'chrome', args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
    })
    try {
      const ctx = await navegador.newContext({
        baseURL: BASE, storageState: sessao('portaria'), viewport: { width: 390, height: 844 },
        isMobile: true, hasTouch: true, locale: 'pt-BR', permissions: ['camera'], serviceWorkers: 'block',
      })
      const page = await ctx.newPage()
      await page.addInitScript(() => {
        delete (window as any).BarcodeDetector
        ;(window as any).__cams = []
        const orig = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
        navigator.mediaDevices.getUserMedia = async (c) => { const s = await orig(c); (window as any).__cams.push(s); return s }
        localStorage.setItem('dt_modo_leitura', 'camera')
      })
      await page.route(/jsqr/i, (r) => r.abort('internetdisconnected'))
      await abrir(page, leitor())
      const alerta = page.locator('.faixa-erro[role="alert"]')
      await expect(alerta).toContainText('Não deu pra carregar o leitor de câmera (sem rede)')
      await expect(page.locator('[data-parte="recarregar"]')).toBeVisible()
      // nenhuma câmera ficou ligada à toa
      const ligadas = await page.evaluate(() =>
        (window as any).__cams.filter((s: MediaStream) => s.getTracks().some((t) => t.readyState === 'live')).length)
      expect(ligadas).toBe(0)
      // o campo de código continua lá pra seguir a fila
      await page.getByRole('button', { name: 'Leitor / código' }).click()
      await expect(page.locator('#cod')).toBeVisible()
    } finally {
      await navegador.close()
    }
  })
})

/* ================================================================ balcão */

test.describe('balcão (operação, 390 px)', () => {
  test.use({ storageState: sessao('operacao') })

  /** um ponto sem caixa aberto (criado pela API), pro caso começar do "Abrir caixa" */
  async function pontoNovo() {
    const nome = unico('ZZE2E Guichê Cel')
    const ponto = await corpo(await master.post(`/api/admin/evento/${ev.id}/pdv`, {
      data: { nome, formas: ['dinheiro', 'debito', 'credito', 'pix'] },
    }))
    return { nome, id: ponto.id as string }
  }

  /** abre o caixa pela tela e devolve o turno (da URL do vender) */
  async function abrirCaixaPelaTela(page: Page, nome: string) {
    await abrir(page, `/admin/evento/${ev.id}/pdv`)
    await page.locator('.card', { hasText: nome }).getByRole('button', { name: 'Abrir caixa' }).click()
    await page.locator('#fundo').fill('5000')
    await page.locator('#fundo').press('Enter')
    await page.waitForURL(/pdv\/vender\?turno=/)
    await expect(page.locator('#venda')).toBeAttached()
    return new URL(page.url()).searchParams.get('turno')!
  }

  test('#143 Enter duas vezes no fundo de troco abre UM caixa (ADM-49)', async ({ page }) => {
    const { nome } = await pontoNovo()
    const aberturas: number[] = []
    page.on('response', (r) => { if (r.request().method() === 'POST' && r.url().endsWith('/pdv/turno')) aberturas.push(r.status()) })
    await abrir(page, `/admin/evento/${ev.id}/pdv`)
    await page.locator('.card', { hasText: nome }).getByRole('button', { name: 'Abrir caixa' }).click()
    await page.locator('#fundo').fill('5000')
    // dois Enter colados, direto no teclado: o segundo chega com a abertura ainda a caminho
    await page.locator('#fundo').focus()
    await page.keyboard.press('Enter')
    await page.keyboard.press('Enter')
    await page.waitForURL(/pdv\/vender\?turno=/)
    await page.waitForLoadState('networkidle').catch(() => {})
    expect(aberturas, `aberturas: ${aberturas.join(',')}`).toEqual([200])
  })

  test('#154 #156 duplo clique em Vender: uma venda; no celular a barra leva ao carrinho (ADM-08, ADM-49)', async ({ page }) => {
    const { nome } = await pontoNovo()
    const turno = await abrirCaixaPelaTela(page, nome)
    const vendas: number[] = []
    page.on('response', (r) => { if (r.request().method() === 'POST' && r.url().endsWith('/pdv/venda')) vendas.push(r.status()) })
    await page.locator('button.card', { hasText: 'Inteira' }).first().click()
    // a barra do rodapé: total e "Fechar venda", que desce até o carrinho
    const barra = page.getByRole('link', { name: 'Fechar venda' })
    await expect(barra).toBeVisible()
    await barra.click()
    await expect(page.locator('#venda')).toBeInViewport()
    await page.locator('#venda').getByRole('button', { name: 'Débito' }).click()
    await page.locator('#venda').getByRole('button', { name: /^Vender R\$/ }).dblclick()
    await expect(page.getByText('Venda registrada')).toBeVisible()
    await page.waitForLoadState('networkidle').catch(() => {})
    expect(vendas.filter((s) => s === 200).length, `vendas: ${vendas.join(',')}`).toBeGreaterThanOrEqual(1)
    const caixa = await corpo(await master.get(`/api/admin/evento/${ev.id}/pdv/turno?turno=${turno}`))
    expect(caixa.vendas, 'o duplo clique virou duas vendas').toHaveLength(1)
  })

  test('#154 F5 no meio da venda (a resposta se perdeu): refazer NÃO vira duas vendas (ADM-08)', async ({ page }) => {
    const { nome } = await pontoNovo()
    const turno = await abrirCaixaPelaTela(page, nome)
    await page.locator('button.card', { hasText: 'Inteira' }).first().click()
    await page.locator('#venda').getByRole('button', { name: 'Débito' }).click()
    // a venda chega ao servidor, mas a resposta nunca volta pro aparelho
    await page.route('**/pdv/venda', async (r) => { await r.fetch(); await r.abort('internetdisconnected') })
    await page.locator('#venda').getByRole('button', { name: /^Vender R\$/ }).click()
    await expect(page.locator('#venda .faixa-erro')).toBeVisible()
    await page.unroute('**/pdv/venda')
    // F5: o carrinho e a chave da venda voltam iguais
    await page.reload()
    await expect(page.locator('#venda')).toContainText('Inteira')
    await page.locator('#venda').getByRole('button', { name: 'Débito' }).click()
    await page.locator('#venda').getByRole('button', { name: /^Vender R\$/ }).click()
    await expect(page.getByText('Esta venda já tinha sido registrada')).toBeVisible()
    const caixa = await corpo(await master.get(`/api/admin/evento/${ev.id}/pdv/turno?turno=${turno}`))
    expect(caixa.vendas, 'o F5 no meio virou duas vendas').toHaveLength(1)
  })

  test('#148 meia-entrada no balcão: pede o motivo e o CPF antes de vender (ADM-02)', async ({ page }) => {
    const { nome } = await pontoNovo()
    await abrirCaixaPelaTela(page, nome)
    await page.locator('button.card', { hasText: 'Meia' }).first().click()
    const vender = page.locator('#venda').getByRole('button', { name: /^Vender R\$/ })
    await page.locator('#venda').getByRole('button', { name: 'Débito' }).click()
    await expect(page.locator('#venda').getByText('Motivo da meia-entrada')).toBeVisible()
    await expect(vender).toBeDisabled()
    await page.locator('#venda select').first().selectOption('estudante')
    await expect(page.locator('#venda')).toContainText('Confira agora:')
    await expect(vender, 'vendeu meia sem CPF').toBeDisabled()
    await page.locator('#venda').getByPlaceholder('CPF (só números)').fill(cpfDeTeste())
    await expect(vender).toBeEnabled()
    await vender.click()
    await expect(page.getByText('Venda registrada')).toBeVisible()
  })

  test('#162 #160 #161 conferência cega pra quem conta; o esperado só depois; trocar de caixa zera a conta (ADM-07, ADM-21)', async ({ page }) => {
    const a = await pontoNovo()
    const turnoA = await abrirCaixaPelaTela(page, a.nome)
    await page.locator('button.card', { hasText: 'Inteira' }).first().click()
    await page.locator('#venda').getByRole('button', { name: 'Dinheiro' }).click()
    await page.locator('#recebido').fill('3000')
    await page.locator('#venda').getByRole('button', { name: /^Vender R\$/ }).click()
    await expect(page.getByText('Venda registrada')).toBeVisible()
    const b = await pontoNovo()
    const turnoB = await abrirCaixaPelaTela(page, b.nome)

    await abrir(page, `/admin/evento/${ev.id}/pdv/caixa?turno=${turnoA}`)
    await expect(page.locator('[data-parte="conferencia-cega"]')).toBeVisible()
    for (const proibido of ['Fundo de troco', 'Vendas em dinheiro', 'O sistema esperava']) {
      await expect(page.locator('main'), `a conferência mostrou "${proibido}" antes da contagem`).not.toContainText(proibido)
    }
    // "Cancelar" só na venda paga inteira (d8a11f1)
    await expect(page.locator('[data-parte="cancelar-venda"]')).toHaveCount(1)

    // conta um valor em A e troca pra B: o formulário zera (a conta de A não vai pro caixa B)
    await page.locator('#contado').fill('8000')
    await page.locator('textarea').first().fill('nota de 5 rasgada')
    await page.locator('select').first().selectOption(turnoB)
    await expect(page.locator('#contado')).toHaveValue('0,00')
    await expect(page.locator('textarea').first()).toHaveValue('')

    // volta pra A, conta e fecha: o esperado aparece DEPOIS
    await page.locator('select').first().selectOption(turnoA)
    await page.locator('#contado').fill('8000')
    await page.getByRole('button', { name: 'Conferir e fechar o caixa' }).click()
    await expect(page.getByText('O sistema esperava')).toBeVisible()
    await expect(page.locator('main')).toContainText('R$ 80,00')
  })
})

/* ============================================ painel e varredura no celular */

test.describe('no celular (master)', () => {
  test.use({ storageState: sessao('master') })

  test('#25 painel a 390 px: números em coluna, o gráfico rola dentro do cartão, a página não', async ({ page }) => {
    await venderNoBalcao(master, ev.id, balcao.turnoId, [{ lotId: ev.lote.id, ticketTypeId: ev.inteira, quantidade: 1 }], 'pix')
    await abrir(page, `/admin/evento/${ev.id}/dashboard`)
    const xs = await page.locator('[data-parte^="kpi-"]').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().x)))
    expect(new Set(xs).size, `os cartões não estão em coluna: ${xs.join(',')}`).toBe(1)
    const rolagem = page.locator('[data-parte="rolagem-dias"]')
    expect(await rolagem.evaluate((e) => e.scrollWidth > e.clientWidth)).toBe(true)
    expect(await rolaNaHorizontal(page)).toBe(false)
  })

  test('#5 varredura a 375 px: nenhuma tela do evento rola a página na horizontal', async ({ page }) => {
    test.setTimeout(300_000)
    await page.setViewportSize({ width: 375, height: 812 })
    const rolam: string[] = []
    for (const tela of ['dashboard', 'relatorios', 'relatorios/extrato', 'relatorios/lotes', 'vendas', 'vendas/participantes',
      'vendas/transferencias', 'ingressos', 'ingressos/cortesias', 'ingressos/cupons', 'ingressos/sessoes',
      'ingressos/ordenar', 'ingressos/passaportes', 'ingressos/promoters', 'assentos', 'configuracoes', 'financeiro',
      'financeiro/bordero', 'pdv', 'pdv/caixa', 'validacao', 'validacao/historico']) {
      await abrir(page, `/admin/evento/${ev.id}/${tela}`)
      if (await rolaNaHorizontal(page)) {
        rolam.push(`${tela} (${await page.evaluate(() => document.documentElement.scrollWidth)} px)`)
      }
    }
    expect(rolam, 'telas que rolam a página na horizontal a 375 px').toEqual([])
  })
})

/* ingressosDoPedido e limpo ficam importados pra quem estender a bateria */
void ingressosDoPedido; void limpo
