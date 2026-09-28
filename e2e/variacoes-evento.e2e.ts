/**
 * variacoes-evento.e2e.ts — as 36 variações "de dentro do evento" que a matriz de 535 ainda não
 * exercitava (rodada final V-EVT, 28/09): formulário lateral com F5 e Voltar, dois operadores no
 * mesmo cadastro, sessão vencida, texto enorme e <script>, os limites de cada campo das telas de
 * ingressos, sessões, assentos, configurações, relatórios e balcão.
 *
 *   E2E_BASE=http://127.0.0.1:3120 npx playwright test e2e/variacoes-evento.e2e.ts --reporter=line
 *
 * Regras da casa, as mesmas de `evento.e2e.ts`: o terreno nasce pela API que a tela chamaria
 * (`evento-apoio.ts`); volume que a tela não cria em tempo útil (mais pedidos que o limite do
 * extrato) entra por SQL no banco de E2E, com trava (`variacoes-evento-apoio.ts`). Tudo que a
 * rodada cria leva o prefixo ZZVAREVT e os eventos ficam ocultos no fim.
 *
 * Caso vermelho aqui é DEFEITO (o teste afirma o comportamento certo) — a lista está no resultado
 * da rodada, com passos, esperado, obtido e a linha provável da causa.
 */
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test'
import { BASE, hidratada, sessao, travaDeBase } from './apoio'
import {
  abrir, apiComo, corpo, cpfDeTeste, diaNaBahia, esconderEventosDaRodada, ingressosDoPedido, limpo,
  textoDoDownload, venderNoBalcao,
} from './evento-apoio'
import {
  PREFIXO, balcaoDaRodada, campoDataHora, cupomDaRodada, eventoDaRodada, proximoSabado, sqlE2e,
} from './variacoes-evento-apoio'

test.beforeAll(() => travaDeBase(BASE))

let master: APIRequestContext
test.beforeAll(async () => { master = await apiComo('master') })
test.afterAll(async () => {
  if (master) await esconderEventosDaRodada(master)
  await master?.dispose()
})

test.use({ storageState: sessao('master') })

/* ------------------------------------------------------------------ apoio local */

const url = (id: string, resto: string) => `/admin/evento/${id}/${resto}`
const escapar = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** o campo que vem logo depois do rótulo (as telas do evento põem o <label class="rotulo"> e o campo em seguida, sem `for`) */
const campoDoRotulo = (raiz: Page | Locator, rotulo: string) =>
  raiz.locator('label.rotulo', { hasText: new RegExp(`^\\s*${escapar(rotulo)}\\s*$`) })
    .locator('xpath=following-sibling::*[1]')

const janela = (page: Page) => page.getByRole('dialog')

/** GET de uma rota do evento pela API do master */
const doEvento = async (id: string, rota: string) => corpo(await master.get(`/api/admin/evento/${id}/${rota}`))

/** dois cliques NO MESMO TIQUE, dentro do navegador — o `dblclick` do Playwright espera a tela e esconde a corrida */
async function doisCliquesColados(page: Page, seletor: string, texto: RegExp) {
  const achou = await page.evaluate(([sel, fonte]) => {
    const alvo = [...document.querySelectorAll<HTMLButtonElement>(sel)]
      .find((b) => new RegExp(fonte).test((b.textContent ?? '').trim()))
    if (!alvo) return false
    alvo.click(); alvo.click()
    return true
  }, [seletor, texto.source] as const)
  expect(achou, `botão ${texto} não achado em ${seletor}`).toBe(true)
}

/** "AAAA-MM-DDTHH:mm" no relógio da Bahia, de um instante ISO */
const naBahia = (iso: string) => new Date(new Date(iso).getTime() - 3 * 3_600_000).toISOString().slice(0, 16)

/** dia seguinte a AAAA-MM-DD */
const diaSeguinte = (dia: string) => new Date(Date.parse(`${dia}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10)

/* =============================================================== todas as telas */

test.describe('todas as telas', () => {
  test('#0 Todas as telas › F5 com o formulário lateral aberto: fecha, nada gravado pela metade, a lista volta como estava', async ({ page }) => {
    const e = await eventoDaRodada(master)
    const lotesAntes = (await doEvento(e.id, 'ingressos')).setores.flatMap((s: any) => s.lotes.map((l: any) => [l.id, l.nome, l.faceCents]))

    // lote: metade do formulário preenchida e F5
    await abrir(page, url(e.id, 'ingressos'))
    await page.locator('section', { hasText: 'Piscinas' }).getByRole('button', { name: 'Criar novo lote' }).click()
    await janela(page).getByPlaceholder('1º lote').fill(`${PREFIXO} meio lote`)
    await janela(page).locator('input[inputmode="numeric"]').fill('4500')
    await page.reload()
    await hidratada(page)
    await expect(page.locator('[data-parte="modal-lateral"]')).toHaveCount(0)
    await expect(page.locator('main')).not.toContainText(`${PREFIXO} meio lote`)
    await expect(page.locator('tr', { hasText: '1º lote' }).first()).toBeVisible()
    const lotesDepois = (await doEvento(e.id, 'ingressos')).setores.flatMap((s: any) => s.lotes.map((l: any) => [l.id, l.nome, l.faceCents]))
    expect(lotesDepois, 'o F5 gravou o lote pela metade').toEqual(lotesAntes)

    // cupom: idem, em outra tela
    const codigo = cupomDaRodada()
    await abrir(page, url(e.id, 'ingressos/cupons'))
    await page.getByRole('button', { name: 'Criar código' }).click()
    await janela(page).getByPlaceholder('VERAO10').fill(codigo)
    await page.reload()
    await hidratada(page)
    await expect(page.locator('[data-parte="modal-lateral"]')).toHaveCount(0)
    await expect(page.getByText('Nenhum código promocional ainda.')).toBeVisible()
    expect((await doEvento(e.id, 'cupons')).cupons, 'o F5 gravou o cupom pela metade').toEqual([])
  })

  test('#1 Todas as telas › Voltar do navegador com o formulário aberto: sai sem gravar; ir pra frente não grava de novo', async ({ page }) => {
    const e = await eventoDaRodada(master)
    await abrir(page, url(e.id, 'ingressos/cupons'))
    await page.locator('[data-parte="abas"]').getByRole('link', { name: 'Cortesias' }).click()
    await page.waitForURL(/\/ingressos\/cortesias$/)
    const emitirCortesia = page.getByRole('button', { name: 'Emitir cortesia' })
    const preencher = async (nome: string) => {
      await emitirCortesia.click()
      await janela(page).getByPlaceholder('Imprensa, patrocinador, equipe…').fill(`${PREFIXO} imprensa`)
      await janela(page).getByPlaceholder('Nome de quem solicitou').fill('Diretoria')
      await janela(page).getByPlaceholder('Nome', { exact: true }).fill(nome)
    }
    await preencher('Convidado Voltar')
    await page.goBack()
    await expect(page).toHaveURL(/\/ingressos\/cupons$/)
    await expect(page.locator('[data-parte="modal-lateral"]')).toHaveCount(0)
    expect((await doEvento(e.id, 'cortesias')).resumo.total, 'Voltar emitiu a cortesia').toBe(0)
    await page.goForward()
    await expect(page).toHaveURL(/\/ingressos\/cortesias$/)
    await expect(emitirCortesia).toBeVisible()
    await expect(page.locator('[data-parte="modal-lateral"]')).toHaveCount(0)
    expect((await doEvento(e.id, 'cortesias')).resumo.total, 'ir pra frente emitiu a cortesia').toBe(0)

    // depois de gravar de verdade: voltar e ir pra frente não grava de novo
    await preencher('Convidado Gravado')
    await janela(page).getByRole('button', { name: /Emitir 1 cortesia/ }).click()
    await expect(page.getByText(/1 cortesia\(s\) emitida\(s\) no pedido/)).toBeVisible()
    await page.goBack()
    await expect(page).toHaveURL(/\/ingressos\/cupons$/)
    await page.goForward()
    await expect(page).toHaveURL(/\/ingressos\/cortesias$/)
    await expect(page.locator('tbody tr')).toHaveCount(1)
    expect((await doEvento(e.id, 'cortesias')).resumo.total, 'voltar e ir pra frente gravou de novo').toBe(1)
  })

  test('#3 Todas as telas › Dois operadores no mesmo lote, cupom e configuração: cada um só muda o que mexeu', async ({ browser }) => {
    const e = await eventoDaRodada(master)
    const codigo = cupomDaRodada()
    await corpo(await master.post(`/api/admin/evento/${e.id}/cupons`, {
      data: { codigo, tipo: 'percentual', valor: 1000, maxUsos: 10, maxPorCliente: 1, ativo: true, loteIds: [] },
    }))
    const ctxA = await browser.newContext({ storageState: sessao('master') })
    const ctxB = await browser.newContext({ storageState: sessao('master') })
    const a = await ctxA.newPage()
    const b = await ctxB.newPage()
    try {
      // --- LOTE: A troca o nome, B (com a janela aberta ANTES) troca só a quantidade
      for (const p of [a, b]) {
        await abrir(p, url(e.id, 'ingressos'))
        await p.locator('tr', { hasText: '1º lote' }).first().locator('button[title="Editar lote"]').click()
        await expect(janela(p)).toBeVisible()
      }
      await janela(a).getByPlaceholder('1º lote').fill(`${PREFIXO} nome da A`)
      await janela(a).getByRole('button', { name: 'Salvar' }).click()
      await expect(janela(a)).toHaveCount(0)
      await janela(b).locator('input[type="number"]').first().fill('250')
      await janela(b).getByRole('button', { name: 'Salvar' }).click()
      await expect(janela(b)).toHaveCount(0)
      const lote = (await doEvento(e.id, 'ingressos')).setores[0].lotes.find((l: any) => l.id === e.lote.id)
      expect.soft(lote.quantidade, 'lote: a quantidade da B não gravou').toBe(250)
      expect.soft(lote.nome, 'lote: a gravação da B devolveu o nome da A ao valor antigo, sem aviso').toBe(`${PREFIXO} nome da A`)

      // --- CUPOM: A muda o "máx. por pessoa", B muda o "limite de usos"
      for (const p of [a, b]) {
        await abrir(p, url(e.id, 'ingressos/cupons'))
        await p.locator('tr', { hasText: codigo }).locator('button[title="Editar"]').click()
        await expect(janela(p)).toBeVisible()
      }
      await janela(a).locator('input[type="number"][min="1"][max="100"]').fill('3')
      await janela(a).locator('[data-parte="salvar-cupom"]').click()
      await expect(janela(a)).toHaveCount(0)
      await janela(b).getByPlaceholder('sem limite').fill('50')
      await janela(b).locator('[data-parte="salvar-cupom"]').click()
      await expect(janela(b)).toHaveCount(0)
      const cupom = (await doEvento(e.id, 'cupons')).cupons.find((c: any) => c.codigo === codigo)
      expect.soft(cupom.maxUsos, 'cupom: o limite de usos da B não gravou').toBe(50)
      expect.soft(cupom.maxPorCliente, 'cupom: a gravação da B devolveu o "máx. por pessoa" da A ao valor antigo, sem aviso').toBe(3)

      // --- CONFIGURAÇÕES: A muda o nome do evento, B muda o nome do local
      for (const p of [a, b]) await abrir(p, url(e.id, 'configuracoes'))
      await campoDoRotulo(a, 'Nome do evento').fill(`${PREFIXO} evento da A`)
      await a.getByRole('button', { name: 'Salvar', exact: true }).click()
      await expect(a.getByText('Salvo.')).toBeVisible()
      await campoDoRotulo(b, 'Nome do local').fill(`${PREFIXO} local da B`)
      await b.getByRole('button', { name: 'Salvar', exact: true }).click()
      await expect(b.getByText('Salvo.')).toBeVisible()
      const cfg = await doEvento(e.id, 'configuracoes')
      expect.soft(cfg.local, 'configurações: o local da B não gravou').toBe(`${PREFIXO} local da B`)
      expect.soft(cfg.nome, 'configurações: a gravação da B devolveu o nome da A').toBe(`${PREFIXO} evento da A`)
    } finally {
      await ctxA.close()
      await ctxB.close()
    }
  })

  test('#5 Todas as telas › Sessão vencida no meio da ação: "Faça login para continuar", com acento, e nada gravado', async ({ page, context, browser }) => {
    const e = await eventoDaRodada(master)
    // cupom: a janela preenchida, a sessão cai, Salvar
    const codigo = cupomDaRodada()
    await abrir(page, url(e.id, 'ingressos/cupons'))
    await page.getByRole('button', { name: 'Criar código' }).click()
    await janela(page).getByPlaceholder('VERAO10').fill(codigo)
    await janela(page).locator('#cupom-valor').fill('10')
    await context.clearCookies({ name: 'dt_sessao' })
    await janela(page).locator('[data-parte="salvar-cupom"]').click()
    await expect(janela(page).locator('[data-parte="erro-cupom"]')).toHaveText('Faça login para continuar')
    await expect(janela(page), 'a janela fechou e o que foi digitado se perdeu').toBeVisible()
    expect((await doEvento(e.id, 'cupons')).cupons, 'gravou o cupom sem sessão').toEqual([])

    // configurações: outra tela, outra aba com sessão, a sessão cai no meio
    const ctx = await browser.newContext({ storageState: sessao('master') })
    try {
      const p = await ctx.newPage()
      await abrir(p, url(e.id, 'configuracoes'))
      const nomeAntes = await campoDoRotulo(p, 'Nome do evento').inputValue()
      await campoDoRotulo(p, 'Nome do evento').fill(`${PREFIXO} sem sessão`)
      await ctx.clearCookies({ name: 'dt_sessao' })
      await p.getByRole('button', { name: 'Salvar', exact: true }).click()
      await expect(p.locator('p.border-erro').first()).toHaveText('Faça login para continuar')
      expect((await doEvento(e.id, 'configuracoes')).nome, 'gravou sem sessão').toBe(nomeAntes)
    } finally {
      await ctx.close()
    }
  })

  test('#8 Todas as telas › 600 caracteres e <script> em nome, motivo e observação: recusa nomeando o campo e o limite; o texto aparece escapado', async ({ page }) => {
    const e = await eventoDaRodada(master)
    const balcao = await balcaoDaRodada(master, e.id)
    const longo = `${PREFIXO} ${'x'.repeat(600 - PREFIXO.length - 1)}`
    const script = '<script>alert(1)</script>'
    let dialogos = 0
    page.on('dialog', async (d) => { dialogos++; await d.dismiss() })

    // (1) divulgador: nome com 600 caracteres
    await abrir(page, url(e.id, 'ingressos/promoters'))
    await page.getByRole('button', { name: 'Cadastrar divulgador' }).click()
    await janela(page).getByPlaceholder('Nome de quem divulga').fill(longo)
    await janela(page).getByRole('button', { name: 'Cadastrar' }).click()
    const erroDivulgador = janela(page).locator('[data-parte="erro-na-janela"]')
    await expect(erroDivulgador).toBeVisible()
    expect.soft(limpo(await erroDivulgador.textContent()), 'divulgador: a recusa não diz o campo e o limite').toMatch(/Nome.*120/)
    // (2) divulgador: nome com <script> grava e aparece como texto
    await janela(page).getByPlaceholder('Nome de quem divulga').fill(`${PREFIXO} ${script}`)
    await janela(page).getByRole('button', { name: 'Cadastrar' }).click()
    await expect(janela(page)).toHaveCount(0)
    await expect(page.locator('tbody')).toContainText(`${PREFIXO} ${script}`)
    expect(await page.locator('tbody script').count(), 'o <script> do nome virou tag na página').toBe(0)

    // (3) cortesia: motivo com 600 caracteres
    await abrir(page, url(e.id, 'ingressos/cortesias'))
    await page.getByRole('button', { name: 'Emitir cortesia' }).click()
    await janela(page).getByPlaceholder('Imprensa, patrocinador, equipe…').fill(longo)
    await janela(page).getByPlaceholder('Nome de quem solicitou').fill('Diretoria')
    await janela(page).getByPlaceholder('Nome', { exact: true }).fill('Convidado Texto Longo')
    await janela(page).getByRole('button', { name: /Emitir 1 cortesia/ }).click()
    const erroCortesia = janela(page).locator('[data-parte="erro-na-janela"]')
    await expect(erroCortesia).toBeVisible()
    expect.soft(limpo(await erroCortesia.textContent()),
      'cortesia: 600 caracteres no motivo e a recusa manda "dizer o motivo" — não diz que passou do limite (200)').toMatch(/motivo.*(200|máximo|caracteres)/i)
    // (4) cortesia: motivo com <script> emite e aparece escapado
    await janela(page).getByPlaceholder('Imprensa, patrocinador, equipe…').fill(`${PREFIXO} ${script}`)
    await janela(page).getByRole('button', { name: /Emitir 1 cortesia/ }).click()
    await expect(janela(page)).toHaveCount(0)
    await expect(page.locator('tbody')).toContainText(`${PREFIXO} ${script}`)
    expect(await page.locator('tbody script').count()).toBe(0)
    expect((await doEvento(e.id, 'cortesias')).resumo.total, 'o motivo longo emitiu mesmo assim').toBe(1)

    // (5) caixa: observação do fechamento com 600 caracteres
    await abrir(page, url(e.id, `pdv/caixa?turno=${balcao.turnoId}`))
    await page.locator('#contado').fill('0')
    await campoDoRotulo(page, 'Observação').fill(longo)
    await page.getByRole('button', { name: 'Conferir e fechar o caixa' }).click()
    const erroCaixa = page.locator('section', { hasText: 'Fechar o caixa' }).locator('.faixa-erro')
    await expect(erroCaixa).toBeVisible()
    expect.soft(limpo(await erroCaixa.textContent()),
      'caixa: a recusa da observação longa fala de outro campo ("quanto contou")').toMatch(/observa.*(400|máximo|caracteres)/i)
    const turno = await doEvento(e.id, `pdv/turno?turno=${balcao.turnoId}`)
    expect(turno.turno.status, 'o caixa fechou com a observação recusada').toBe('aberto')
    expect(dialogos, 'um alert() rodou na página').toBe(0)
  })
})

/* ====================================================================== relatórios */

test.describe('relatórios', () => {
  test('#31 Relatórios › Extrato › "Até" antes de "De": a tela avisa o período invertido', async ({ page }) => {
    const e = await eventoDaRodada(master)
    const b = await balcaoDaRodada(master, e.id)
    await venderNoBalcao(master, e.id, b.turnoId, [{ lotId: e.lote.id, ticketTypeId: e.inteira, quantidade: 1 }], 'debito')
    // a venda de hoje fica ENTRE as duas datas: quem trocou as pontas precisa saber que trocou
    const de = diaNaBahia(3)
    const ate = diaNaBahia(-3)
    await abrir(page, url(e.id, 'relatorios/extrato'))
    await page.locator('input[type="date"]').first().fill(de)
    await page.locator('input[type="date"]').nth(1).fill(ate)
    await expect(page).toHaveURL(new RegExp(`de=${de}`))
    await expect(page).toHaveURL(new RegExp(`ate=${ate}`))
    await page.waitForLoadState('networkidle').catch(() => {})
    const texto = limpo(await page.locator('main').innerText())
    expect(texto, 'período invertido: a tela só diz "Nenhum pedido neste recorte.", sem avisar que o "Até" está antes do "De"')
      .toMatch(/invertid|"?Até"? (está |vem )?antes|antes d[oe] "?De"?/i)
  })

  test('#36 Relatórios › Extrato › mais pedidos que o limite: "mostrando os 300 mais recentes" e o total "das linhas visíveis"', async ({ page }) => {
    const e = await eventoDaRodada(master)
    // 305 pedidos pagos de balcão, R$ 10,00 cada, sem cliente (não enfileira e-mail) — volume pelo banco de E2E
    await sqlE2e(
      `INSERT INTO orders (org_id, event_id, code, status, channel, face_cents, fee_cents, platform_cents,
                           discount_cents, total_cents, payment_method, paid_at)
       SELECT ev.org_id, ev.id, 'ZZVAREVT-' || upper(substr(md5(random()::text || g::text), 1, 12)),
              'pago', 'bilheteria', 1000, 0, 100, 0, 1000, 'dinheiro', now() - make_interval(mins => g)
         FROM events ev, generate_series(1, 305) g
        WHERE ev.id = $1`, [e.id])
    try {
      await abrir(page, url(e.id, 'relatorios/extrato'))
      const tabela = page.locator('table', { has: page.locator('th', { hasText: /^Pedido$/ }) })
      await expect(page.getByText(/mostrando os 300 mais recentes/)).toBeVisible()
      await expect(tabela.locator('tbody tr')).toHaveCount(300)
      await expect(tabela.locator('tfoot')).toContainText('Total das linhas visíveis')
      // o rodapé soma o que está na tela; o cartão de cima, o recorte inteiro
      await expect(tabela.locator('tfoot')).toContainText('R$ 3.000,00')
      const cobrado = page.locator('.card', { has: page.locator('.rotulo-kpi', { hasText: 'Cobrado do comprador' }) })
      await expect(cobrado.locator('.numero-kpi')).toHaveText('R$ 3.050,00')
      await expect(cobrado).toContainText('305 pedidos')
    } finally {
      // pedido pago sem ingresso é o alarme de "emissão" da /api/saude: os 305 deixavam a saúde
      // da instância de E2E em 503 até o banco ser recriado
      await sqlE2e(`DELETE FROM orders o WHERE o.event_id = $1 AND o.code LIKE 'ZZVAREVT-%'
                      AND NOT EXISTS (SELECT 1 FROM tickets t WHERE t.order_id = o.id)`, [e.id])
    }
  })

  test('#41 Relatórios › Lotes › Exportar: o CSV tem os mesmos números do borderô', async ({ page }) => {
    const e = await eventoDaRodada(master)
    const b = await balcaoDaRodada(master, e.id)
    await corpo(await master.post(`/api/admin/evento/${e.id}/ingressos`, {
      data: { o: 'lote', setorId: e.setorId, nome: `${PREFIXO} 2º lote`, faceCents: 4500, quantidade: 40, canais: ['online', 'bilheteria'] },
    }))
    const lote2 = (await doEvento(e.id, 'ingressos')).setores[0].lotes.find((l: any) => l.nome === `${PREFIXO} 2º lote`)
    await venderNoBalcao(master, e.id, b.turnoId, [{ lotId: e.lote.id, ticketTypeId: e.inteira, quantidade: 2 }], 'debito')
    await venderNoBalcao(master, e.id, b.turnoId, [{ lotId: lote2.id, quantidade: 3 }], 'pix')
    await corpo(await master.post(`/api/admin/evento/${e.id}/cortesias`, {
      data: { loteId: e.lote.id, motivo: `${PREFIXO} imprensa`, responsavel: 'Diretoria', pessoas: [{ nome: 'Convidado Borderô' }] },
    }))

    await abrir(page, url(e.id, 'relatorios/lotes'))
    const [baixado] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /Exportar/ }).click()])
    const linhasCsv = (await textoDoDownload(baixado)).split('\r\n')
      .map((l) => [...l.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1].replace(/""/g, '"')))
    const [cab, ...dados] = linhasCsv
    const col = (nome: string) => cab.indexOf(nome)
    expect(dados.length).toBeGreaterThanOrEqual(3)

    await abrir(page, url(e.id, 'financeiro/bordero'))
    const secao = page.locator('section', { has: page.locator('h2', { hasText: 'Por setor e lote' }) })
    const cabBordero = (await secao.locator('thead th').allTextContents()).map((t) => limpo(t))
    const linhasBordero = await secao.locator('tbody tr').evaluateAll((trs) =>
      trs.map((tr) => [...tr.querySelectorAll('td')].map((td) => (td.textContent ?? '').replace(/\s+/g, ' ').trim())))
    expect(linhasBordero).toHaveLength(dados.length)
    const noBordero = (linha: string[], coluna: string) => linha[cabBordero.findIndex((c) => c.toLowerCase() === coluna.toLowerCase())]
    for (const lb of linhasBordero) {
      const lote = noBordero(lb, 'Lote')
      const csv = dados.find((d) => d[col('Lote')] === lote)
      expect(csv, `o lote ${lote} do borderô não está no CSV`).toBeTruthy()
      expect([csv![col('Setor')], csv![col('Face unitária')], csv![col('Estoque')], csv![col('Vendidos')],
              csv![col('Cortesias')], csv![col('Face')], csv![col('Taxa')]], `lote ${lote}`)
        .toEqual([noBordero(lb, 'Setor'), noBordero(lb, 'Face unit.'), noBordero(lb, 'Estoque'), noBordero(lb, 'Vendidos'),
                  noBordero(lb, 'Cortesias'), noBordero(lb, 'Face'), noBordero(lb, 'Taxa')])
    }
    // e o total da face bate com o rodapé do borderô
    const totalFaceCsv = dados.reduce((s, d) => s + Number(d[col('Face')].replace(/[^\d]/g, '')), 0)
    const rodape = await secao.locator('tfoot td').allTextContents()
    expect(rodape.map((t) => limpo(t))).toContain(`R$ ${(totalFaceCsv / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`)
  })
})

/* ======================================================= ingressos › setores e lotes */

test.describe('ingressos › setores e lotes', () => {
  test('#62 Ingressos › Setores e lotes › um setor de cada tipo: os três que não são ingresso simples aparecem em Passaportes', async ({ page }) => {
    const e = await eventoDaRodada(master, { semLote: true })
    await abrir(page, url(e.id, 'ingressos'))
    const tipos = [['ingresso', 'Ingresso'], ['passaporte', 'Passaporte'], ['mesa', 'Mesa'], ['camarote', 'Camarote']] as const
    for (const [valor, nome] of tipos) {
      await page.getByRole('button', { name: 'Criar Setor' }).click()
      await janela(page).locator('#sn').fill(`${PREFIXO} ${nome}`)
      await janela(page).locator('#st').selectOption(valor)
      await janela(page).getByRole('button', { name: 'Criar setor' }).click()
      await expect(janela(page)).toHaveCount(0)
    }
    // na tela de ingressos, cada setor com o tipo que foi escolhido
    for (const [, nome] of tipos) await expect(page.locator('section header', { hasText: `${PREFIXO} ${nome}` })).toBeVisible()
    await expect(page.locator('section header', { hasText: `${PREFIXO} Mesa` })).toContainText('Mesa')
    await expect(page.locator('section header', { hasText: `${PREFIXO} Passaporte` })).toContainText('Passaporte / combo')

    await abrir(page, url(e.id, 'ingressos/passaportes'))
    const titulos = (await page.locator('section h2').allTextContents()).map((t) => t.trim()).sort()
    expect(titulos).toEqual([`${PREFIXO} Camarote`, `${PREFIXO} Mesa`, `${PREFIXO} Passaporte`])
    await expect(page.locator('main')).not.toContainText(`${PREFIXO} Ingresso`)
    await expect(page.locator('section', { hasText: `${PREFIXO} Passaporte` }).locator('.selo-neutro').first()).toHaveText('Passaporte / combo')
    await expect(page.locator('section', { hasText: `${PREFIXO} Camarote` }).locator('.selo-neutro').first()).toHaveText('Camarote')
    await expect(page.getByText('3 setor(es) fora do ingresso simples')).toBeVisible()
    const api = await doEvento(e.id, 'ingressos')
    expect(api.setores.map((s: any) => s.tipo).sort()).toEqual(['camarote', 'ingresso', 'mesa', 'passaporte'])
  })

  test('#65 Ingressos › Setores e lotes › valor do lote digitado como uma pessoa digita: 1.234,56 grava 123456 e 0,01 grava 1', async ({ page }) => {
    const e = await eventoDaRodada(master)
    await abrir(page, url(e.id, 'ingressos'))
    const casos = [
      { digitos: '123456', texto: '1.234,56', cents: 123456, nome: `${PREFIXO} lote mil` },
      { digitos: '1', texto: '0,01', cents: 1, nome: `${PREFIXO} lote centavo` },
    ]
    for (const c of casos) {
      await page.locator('section', { hasText: 'Piscinas' }).getByRole('button', { name: 'Criar novo lote' }).click()
      await janela(page).getByPlaceholder('1º lote').fill(c.nome)
      const valor = janela(page).locator('input[inputmode="numeric"]')
      // a pessoa clica no campo (o clique cai no meio da caixa, à esquerda do "0,00" alinhado à direita) e digita
      await valor.click()
      await valor.pressSequentially(c.digitos, { delay: 40 })
      await expect.soft(valor, `clicou no campo e digitou ${c.digitos}`).toHaveValue(c.texto)
      await janela(page).getByRole('button', { name: 'Criar lote' }).click()
      await expect(janela(page)).toHaveCount(0)
    }
    const lotes = (await doEvento(e.id, 'ingressos')).setores[0].lotes
    for (const c of casos) {
      expect.soft(lotes.find((l: any) => l.nome === c.nome)?.faceCents, `digitou ${c.digitos}: o lote gravou outro valor`).toBe(c.cents)
    }
    // pelo teclado (Tab seleciona o campo inteiro) a mesma digitação sai certa — é o clique que desloca o cursor
    await page.locator('section', { hasText: 'Piscinas' }).getByRole('button', { name: 'Criar novo lote' }).click()
    await janela(page).getByPlaceholder('1º lote').fill(`${PREFIXO} lote pelo tab`)
    await page.keyboard.press('Tab')
    await page.keyboard.type('123456', { delay: 40 })
    await expect(janela(page).locator('input[inputmode="numeric"]')).toHaveValue('1.234,56')
    await page.keyboard.press('Escape')
  })

  test('#68 Ingressos › Setores e lotes › desmarcar "Site" no lote: some do site e segue no balcão', async ({ page }) => {
    const e = await eventoDaRodada(master)
    const b = await balcaoDaRodada(master, e.id)
    const lotesDoSite = async () => ((await (await master.get(`/api/e/${e.slug}`)).json()).setores ?? [])
      .flatMap((s: any) => s.lotes.map((l: any) => l.nome))
    expect(await lotesDoSite()).toContain('1º lote')

    await abrir(page, url(e.id, 'ingressos'))
    await page.locator('tr', { hasText: '1º lote' }).first().locator('button[title="Editar lote"]').click()
    await janela(page).getByLabel('Site', { exact: true }).uncheck()
    await janela(page).getByRole('button', { name: 'Salvar' }).click()
    await expect(janela(page)).toHaveCount(0)
    await expect(page.locator('tr', { hasText: '1º lote' }).first()).toContainText('só na bilheteria')
    expect((await doEvento(e.id, 'ingressos')).setores[0].lotes.find((l: any) => l.id === e.lote.id).canais.sort())
      .toEqual(['bilheteria', 'cortesia'])

    // o site: o lote sumiu da vitrine (a página e a rota que ela chama)
    expect(await lotesDoSite()).not.toContain('1º lote')
    await abrir(page, `/e/${e.slug}`)
    await expect(page.locator('body')).toContainText('Lote redondo')
    await expect(page.locator('body')).not.toContainText('1º lote')
    // o balcão: continua à venda
    await abrir(page, url(e.id, `pdv/vender?turno=${b.turnoId}`))
    await expect(page.locator('button.card', { hasText: '1º lote' }).first()).toBeEnabled()
    await page.locator('button.card', { hasText: 'Inteira' }).first().click()
    await page.locator('#venda').getByRole('button', { name: 'Débito' }).click()
    await page.locator('#venda').getByRole('button', { name: /^Vender R\$/ }).click()
    await expect(page.getByText('Venda registrada')).toBeVisible()
  })

  test('#72 Ingressos › Setores e lotes › giro automático ligado × desligado: com giro o 2º lote abre sozinho quando o 1º esgota; sem giro, não', async ({ page }) => {
    /** evento com um setor e dois lotes: o 1º com 2 lugares (esgota no balcão), o 2º com 20 */
    async function montar(segundoVisivel: boolean) {
      const e = await eventoDaRodada(master, { semLote: true })
      const setor = await corpo(await master.post(`/api/admin/evento/${e.id}/ingressos`, {
        data: { o: 'setor', nome: `${PREFIXO} Giro`, tipo: 'ingresso' },
      }))
      for (const [nome, quantidade, visivel] of [['1º lote', 2, true], ['2º lote', 20, segundoVisivel]] as const) {
        await corpo(await master.post(`/api/admin/evento/${e.id}/ingressos`, {
          data: { o: 'lote', setorId: setor.id, nome, faceCents: 3000, quantidade, canais: ['online', 'bilheteria'], visivel },
        }))
      }
      await corpo(await master.patch(`/api/admin/evento/${e.id}/configuracoes`, { data: { status: 'ativo' } }))
      const lotes = (await doEvento(e.id, 'ingressos')).setores[0].lotes
      return { e, primeiro: lotes.find((l: any) => l.nome === '1º lote'), segundo: lotes.find((l: any) => l.nome === '2º lote') }
    }
    const situacao = async (slug: string) => Object.fromEntries(((await (await master.get(`/api/e/${slug}`)).json()).setores ?? [])
      .flatMap((s: any) => s.lotes.map((l: any) => [l.nome, l.situacao])))
    const esgotar = async (e: any, loteId: string) => {
      const b = await balcaoDaRodada(master, e.id)
      await venderNoBalcao(master, e.id, b.turnoId, [{ lotId: loteId, quantidade: 2 }], 'debito')
    }

    // LIGADO (o padrão): o 2º espera "em breve" e abre sozinho quando o 1º esgota
    const ligado = await montar(true)
    await abrir(page, url(ligado.e.id, 'ingressos'))
    await expect(page.getByRole('switch')).toHaveAttribute('aria-checked', 'true')
    expect(await situacao(ligado.e.slug)).toMatchObject({ '1º lote': expect.stringMatching(/disponivel|ultimas/), '2º lote': 'em_breve' })
    await esgotar(ligado.e, ligado.primeiro.id)
    expect(await situacao(ligado.e.slug)).toMatchObject({ '1º lote': 'esgotado', '2º lote': expect.stringMatching(/disponivel|ultimas/) })
    await abrir(page, `/e/${ligado.e.slug}`)
    await expect(page.locator('body')).toContainText('2º lote')
    await expect(page.locator('body')).not.toContainText('Em breve')

    // DESLIGADO pela tela: o 2º (oculto) não abre quando o 1º esgota — só quando o produtor manda
    const desligado = await montar(false)
    await abrir(page, url(desligado.e.id, 'ingressos'))
    await page.getByRole('switch').click()
    await expect(page.getByRole('switch')).toHaveAttribute('aria-checked', 'false')
    expect((await doEvento(desligado.e.id, 'ingressos')).evento.giroAutomatico).toBe(false)
    await esgotar(desligado.e, desligado.primeiro.id)
    const depois = await situacao(desligado.e.slug)
    expect(depois['1º lote']).toBe('esgotado')
    expect(depois['2º lote'], 'sem giro, o 2º lote abriu sozinho').toBeUndefined()
    // o produtor manda: mostrar o 2º lote na página de venda
    await abrir(page, url(desligado.e.id, 'ingressos'))
    await page.locator('tr', { hasText: '2º lote' }).first().locator('button[title="Mostrar na página de venda"]').click()
    await expect(page.locator('tr', { hasText: '2º lote' }).first().locator('button[title="Ocultar da página de venda"]')).toBeVisible()
    expect((await situacao(desligado.e.slug))['2º lote']).toMatch(/disponivel|ultimas/)
  })
})

/* ================================================================ ingressos › cortesias */

test.describe('ingressos › cortesias', () => {
  const emitirBotao = (page: Page) => janela(page).getByRole('button', { name: /Emitir .*cortesia/ })
  const motivoAoLado = (page: Page) => janela(page).locator('footer p.text-alerta')

  test('#74 Ingressos › Cortesias › Emitir sem lote / motivo < 3 / quem pediu < 2 / sem nome: botão travado com o motivo ao lado', async ({ page }) => {
    // sem lote: evento sem ingresso nenhum
    const semLote = await eventoDaRodada(master, { semLote: true })
    await abrir(page, url(semLote.id, 'ingressos/cortesias'))
    await page.getByRole('button', { name: 'Emitir cortesia' }).click()
    await expect(emitirBotao(page)).toBeDisabled()
    await expect(motivoAoLado(page)).toHaveText('Escolha o lote.')

    const e = await eventoDaRodada(master)
    await abrir(page, url(e.id, 'ingressos/cortesias'))
    await page.getByRole('button', { name: 'Emitir cortesia' }).click()
    const motivo = janela(page).getByPlaceholder('Imprensa, patrocinador, equipe…')
    const quem = janela(page).getByPlaceholder('Nome de quem solicitou')
    const nome = janela(page).getByPlaceholder('Nome', { exact: true })
    await expect(emitirBotao(page)).toBeDisabled()
    await expect(motivoAoLado(page)).toHaveText('Escreva o motivo da cortesia.')
    await motivo.fill('ab')
    await expect(emitirBotao(page)).toBeDisabled()
    await expect(motivoAoLado(page)).toHaveText('Escreva o motivo da cortesia.')
    await motivo.fill(`${PREFIXO} imprensa`)
    await expect(motivoAoLado(page)).toHaveText('Diga quem pediu a cortesia.')
    await quem.fill('D')
    await expect(emitirBotao(page)).toBeDisabled()
    await expect(motivoAoLado(page)).toHaveText('Diga quem pediu a cortesia.')
    await quem.fill('Diretoria')
    await expect(emitirBotao(page)).toBeDisabled()
    await expect(motivoAoLado(page)).toHaveText('Preencha ao menos um nome.')
    await nome.fill('Convidado Completo')
    await expect(emitirBotao(page)).toBeEnabled()
    await expect(motivoAoLado(page)).toHaveCount(0)
    expect((await doEvento(e.id, 'cortesias')).resumo.total).toBe(0)
  })

  test('#76 Ingressos › Cortesias › colar 40 linhas com vírgula, ponto e vírgula e tab: 40 pessoas preenchidas', async ({ page }) => {
    const e = await eventoDaRodada(master)
    const separadores = [', ', '; ', '\t']
    const pessoas = Array.from({ length: 40 }, (_, i) => ({
      nome: `${PREFIXO} Pessoa ${String(i + 1).padStart(2, '0')}`,
      email: `pessoa${i + 1}.zzvarevt@teste.invalido`,
      documento: `DOC${i + 1}`,
    }))
    const texto = pessoas.map((p, i) => [p.nome, p.email, p.documento].join(separadores[i % 3])).join('\n')
    await abrir(page, url(e.id, 'ingressos/cortesias'))
    await page.getByRole('button', { name: 'Emitir cortesia' }).click()
    await janela(page).locator('summary', { hasText: 'Colar uma lista' }).click()
    await janela(page).getByPlaceholder('Maria Silva, maria@email.com, 000.000.000-00').fill(texto)
    await janela(page).getByRole('button', { name: 'Preencher com essa lista' }).click()
    const nomes = janela(page).getByPlaceholder('Nome', { exact: true })
    await expect(nomes).toHaveCount(40)
    const lidos = await janela(page).locator('fieldset .grid').evaluateAll((linhas) => linhas.map((l) =>
      [...l.querySelectorAll('input')].map((i) => (i as HTMLInputElement).value)))
    expect(lidos).toEqual(pessoas.map((p) => [p.nome, p.email, p.documento]))
    await expect(emitirBotao(page)).toHaveText(/Emitir 40 cortesia\(s\)/)
    // e o servidor aceita as 40 como vieram
    await janela(page).getByPlaceholder('Imprensa, patrocinador, equipe…').fill(`${PREFIXO} lista colada`)
    await janela(page).getByPlaceholder('Nome de quem solicitou').fill('Diretoria')
    await emitirBotao(page).click()
    await expect(page.getByText(/40 cortesia\(s\) emitida\(s\) no pedido/)).toBeVisible()
    const lista = await doEvento(e.id, 'cortesias')
    expect(lista.resumo.total).toBe(40)
    expect(lista.ingressos.map((t: any) => t.nome).sort()).toEqual(pessoas.map((p) => p.nome).sort())
  })

  test('#77 Ingressos › Cortesias › Emitir com duplo clique e com a rede caindo depois de gravar: uma emissão, e a tela diz que saiu', async ({ page }) => {
    const e = await eventoDaRodada(master)
    const posts: number[] = []
    page.on('response', (r) => {
      if (r.request().method() === 'POST' && r.url().endsWith(`/evento/${e.id}/cortesias`)) posts.push(r.status())
    })
    await abrir(page, url(e.id, 'ingressos/cortesias'))
    const preencher = async (nome: string) => {
      await page.getByRole('button', { name: 'Emitir cortesia' }).click()
      await janela(page).getByPlaceholder('Imprensa, patrocinador, equipe…').fill(`${PREFIXO} imprensa`)
      await janela(page).getByPlaceholder('Nome de quem solicitou').fill('Diretoria')
      await janela(page).getByPlaceholder('Nome', { exact: true }).fill(nome)
      await expect(emitirBotao(page)).toBeEnabled()
    }

    // (1) duplo clique no próprio navegador: os dois cliques no mesmo tique
    await preencher('Convidado Duplo Clique')
    await doisCliquesColados(page, '[role="dialog"] footer button', /^Emitir 1 cortesia/)
    await expect(janela(page)).toHaveCount(0)
    await page.waitForLoadState('networkidle').catch(() => {})
    const depoisDoDuplo = (await doEvento(e.id, 'cortesias')).resumo.total
    expect.soft(posts, `duplo clique: ${posts.length} emissões pra um clique duplo`).toHaveLength(1)
    expect.soft(depoisDoDuplo, 'duplo clique: a mesma pessoa saiu com duas cortesias').toBe(1)

    // (2) a rede cai DEPOIS de gravar: o POST passa, o recarregar da lista cai
    await abrir(page, url(e.id, 'ingressos/cortesias'))
    await preencher('Convidado Rede Caiu')
    await page.route(`**/api/admin/evento/${e.id}/cortesias`, (rota) =>
      rota.request().method() === 'GET' ? rota.abort('internetdisconnected') : rota.continue())
    await emitirBotao(page).click()
    await expect.poll(async () => (await doEvento(e.id, 'cortesias')).resumo.total, { message: 'a emissão com a rede caindo não gravou' })
      .toBe(depoisDoDuplo + 1)
    await page.waitForTimeout(1500)
    const tela = limpo(await page.locator('main').innerText())
    await page.unroute(`**/api/admin/evento/${e.id}/cortesias`)
    expect.soft(tela, 'a cortesia foi emitida, a lista não recarregou e a tela não diz que emitiu (mostra só "Não foi possível carregar")')
      .toMatch(/emitida/i)
  })

  test('#83 Ingressos › Cortesias › Cancelar numa cortesia que já entrou / já cancelada: travado com "Já entrou" / "Cancelada"', async ({ page }) => {
    const e = await eventoDaRodada(master)
    for (const nome of [`${PREFIXO} Entrou`, `${PREFIXO} Cancelada`, `${PREFIXO} Valendo`]) {
      await corpo(await master.post(`/api/admin/evento/${e.id}/cortesias`, {
        data: { loteId: e.lote.id, motivo: `${PREFIXO} imprensa`, responsavel: 'Diretoria', pessoas: [{ nome }] },
      }))
    }
    const lista = await doEvento(e.id, 'cortesias')
    const acha = (nome: string) => lista.ingressos.find((t: any) => t.nome === nome)
    const entrou = acha(`${PREFIXO} Entrou`)
    const { ingressos } = await ingressosDoPedido(master, entrou.pedidoId)
    const qr = ingressos.find((i) => i.codigo === entrou.codigo)!.qr
    await corpo(await master.post('/api/checkin', { data: { qr, eventId: e.id, gate: PREFIXO } }))
    expect((await doEvento(e.id, 'cortesias')).ingressos.find((t: any) => t.id === entrou.id).status, 'a leitura não marcou a entrada').toBe('usado')
    await corpo(await master.delete(`/api/admin/evento/${e.id}/cortesias`, { data: { id: acha(`${PREFIXO} Cancelada`).id } }))

    await abrir(page, url(e.id, 'ingressos/cortesias'))
    const botao = (nome: string) => page.locator('tr', { hasText: nome }).locator('td').last().getByRole('button')
    await expect(botao(`${PREFIXO} Entrou`)).toBeDisabled()
    await expect(botao(`${PREFIXO} Entrou`)).toHaveText('Já entrou')
    await expect(botao(`${PREFIXO} Entrou`)).toHaveAttribute('title', 'Já entrou no evento')
    await expect(botao(`${PREFIXO} Cancelada`)).toBeDisabled()
    await expect(botao(`${PREFIXO} Cancelada`)).toHaveText('Cancelada')
    await expect(botao(`${PREFIXO} Valendo`)).toBeEnabled()
    await expect(botao(`${PREFIXO} Valendo`)).toHaveText('Cancelar')
  })
})

/* =================================================================== ingressos › cupons */

test.describe('ingressos › cupons', () => {
  test('#86 Ingressos › Cupons › percentual 0 / 0,5 / 100 / 150: 0 recusado, 150 "não pode passar de 100%"', async ({ page }) => {
    const e = await eventoDaRodada(master)
    await abrir(page, url(e.id, 'ingressos/cupons'))
    const erro = janela(page).locator('[data-parte="erro-cupom"]')
    const salvar = janela(page).locator('[data-parte="salvar-cupom"]')
    const digitar = async (valor: string) => {
      await janela(page).locator('#cupom-valor').click({ clickCount: 3 })
      await page.keyboard.type(valor, { delay: 40 })
    }
    const codigo = cupomDaRodada()
    await page.getByRole('button', { name: 'Criar código' }).click()
    await janela(page).getByPlaceholder('VERAO10').fill(codigo)
    // 0: recusado, a janela fica aberta
    await digitar('0')
    await salvar.click()
    await expect(erro).toContainText('Valor do desconto')
    await expect(janela(page)).toBeVisible()
    // 150: sem limite de usos a tela trata como "100% sem limite" e trava o botão; com o limite
    // (o que a própria tela pede), a recusa é a frase dos 100%
    await digitar('150')
    await expect(janela(page).locator('[data-parte="aviso-gratis-ilimitado"]')).toBeVisible()
    await expect(salvar).toBeDisabled()
    await janela(page).getByPlaceholder('sem limite').fill('20')
    await salvar.click()
    await expect(erro).toHaveText('Desconto percentual não pode passar de 100%')
    await expect(janela(page)).toBeVisible()
    // 0,5 (vírgula, como se digita no Brasil): grava meio por cento
    await digitar('0,5')
    await salvar.click()
    await expect(janela(page)).toHaveCount(0)
    await expect(page.locator('tr', { hasText: codigo })).toContainText(/0[.,]50?%/)
    // 100 com limite de usos: grava
    const cem = cupomDaRodada()
    await page.getByRole('button', { name: 'Criar código' }).click()
    await janela(page).getByPlaceholder('VERAO10').fill(cem)
    await digitar('100')
    await janela(page).getByPlaceholder('sem limite').fill('20')
    await salvar.click()
    await expect(janela(page)).toHaveCount(0)
    await expect(page.locator('tr', { hasText: cem })).toContainText('100%')
    const cupons = (await doEvento(e.id, 'cupons')).cupons
    expect(cupons.map((c: any) => [c.codigo, c.valor, c.maxUsos]).sort()).toEqual([[cem, 10000, 20], [codigo, 50, 20]].sort())
  })

  test('#88 Ingressos › Cupons › limite de usos vazio / 0 / abaixo do já usado: vazio = sem limite; abaixo do usado → 409 na janela', async ({ page }) => {
    const e = await eventoDaRodada(master)
    const b = await balcaoDaRodada(master, e.id)
    const codigo = cupomDaRodada()
    await corpo(await master.post(`/api/admin/evento/${e.id}/cupons`, {
      data: { codigo, tipo: 'percentual', valor: 1000, maxUsos: 10, maxPorCliente: 1, ativo: true, loteIds: [] },
    }))
    // dois usos no balcão, cada um com um CPF
    for (const nome of ['Cliente Um', 'Cliente Dois']) {
      await venderNoBalcao(master, e.id, b.turnoId, [{ lotId: e.lote.id, ticketTypeId: e.inteira, quantidade: 1 }], 'pix',
        { cupom: codigo, comprador: { nome: `${PREFIXO} ${nome}`, documento: cpfDeTeste() } })
    }
    await abrir(page, url(e.id, 'ingressos/cupons'))
    const linha = page.locator('tr', { hasText: codigo })
    await expect(linha).toContainText('2 / 10')
    const limite = janela(page).getByPlaceholder('sem limite')
    const salvar = janela(page).locator('[data-parte="salvar-cupom"]')
    const doCupom = async () => (await doEvento(e.id, 'cupons')).cupons.find((c: any) => c.codigo === codigo)

    // abaixo do que já foi usado: 409 com a frase, dentro da janela
    await linha.locator('button[title="Editar"]').click()
    await limite.fill('1')
    await salvar.click()
    await expect(janela(page).locator('[data-parte="erro-cupom"]'))
      .toHaveText('Este cupom já foi usado 2 vezes. O limite não pode ficar abaixo disso.')
    expect((await doCupom()).maxUsos).toBe(10)
    // vazio = sem limite
    await limite.fill('')
    await salvar.click()
    await expect(janela(page)).toHaveCount(0)
    expect((await doCupom()).maxUsos).toBeNull()
    await expect(linha.locator('td').nth(3)).not.toContainText('/')
    // 0 NÃO é "sem limite": o `|| null` do salvar gravava sem limite em silêncio — o contrário do
    // que o 0 diz, e num cupom de 100% é ingresso grátis pra todo mundo (#88, 28/09). Recusado na
    // janela, dizendo como deixar sem limite ou parar o cupom; o limite gravado não muda.
    await corpo(await master.patch(`/api/admin/evento/${e.id}/cupons`, { data: { id: (await doCupom()).id, campos: { maxUsos: 5 } } }))
    await page.reload()
    await hidratada(page)
    await linha.locator('button[title="Editar"]').click()
    await limite.fill('0')
    await salvar.click()
    await expect(janela(page).locator('[data-parte="erro-cupom"]')).toContainText('Limite de usos 0 não existe')
    await expect(janela(page)).toBeVisible()
    expect((await doCupom()).maxUsos, 'o 0 gravou alguma coisa').toBe(5)
  })
})

/* ============================================================== ingressos › passaportes */

test.describe('ingressos › passaportes', () => {
  test('#97 Ingressos › Passaportes › pessoas por unidade 1 / 4 / 100 / 0 / vazio: 0 e vazio recusados dizendo o campo', async ({ page }) => {
    const e = await eventoDaRodada(master, { semLote: true })
    const nome = `${PREFIXO} Mesa`
    await corpo(await master.post(`/api/admin/evento/${e.id}/ingressos`, { data: { o: 'setor', nome, tipo: 'mesa' } }))
    await abrir(page, url(e.id, 'ingressos/passaportes'))
    const cabecalho = page.locator('section header', { hasText: nome })
    const campo = campoDoRotulo(janela(page), 'Pessoas por unidade')
    for (const v of ['4', '1', '100']) {
      await page.getByRole('button', { name: `Configurar ${nome}` }).click()
      await campo.fill(v)
      await janela(page).getByRole('button', { name: 'Salvar' }).click()
      await expect(janela(page)).toHaveCount(0)
      await expect(cabecalho).toContainText(`${v} pessoa(s) por unidade`)
    }
    await page.getByRole('button', { name: `Configurar ${nome}` }).click()
    for (const v of ['0', '']) {
      await campo.fill(v)
      await janela(page).getByRole('button', { name: 'Salvar' }).click()
      const erro = janela(page).locator('[data-parte="erro-na-janela"]')
      await expect(erro).toBeVisible()
      await expect(janela(page)).toBeVisible()
      expect.soft(limpo(await erro.textContent()), `"${v}" foi recusado, mas a frase não diz o campo como a tela o chama`)
        .toMatch(/Pessoas por unidade/)
    }
    expect((await doEvento(e.id, 'ingressos')).setores[0].admite).toBe(100)
  })

  test('#99 Ingressos › Passaportes › mudar de 4 para 2 pessoas com mesa já vendida: a tela avisa que muda a contagem da portaria', async ({ page }) => {
    const e = await eventoDaRodada(master, { semLote: true })
    const nome = `${PREFIXO} Mesa de 4`
    const setor = await corpo(await master.post(`/api/admin/evento/${e.id}/ingressos`, { data: { o: 'setor', nome, tipo: 'mesa' } }))
    await corpo(await master.patch(`/api/admin/evento/${e.id}/ingressos`, { data: { o: 'setor', id: setor.id, campos: { admite: 4 } } }))
    await corpo(await master.post(`/api/admin/evento/${e.id}/ingressos`, {
      data: { o: 'lote', setorId: setor.id, nome: 'Mesa', faceCents: 20000, quantidade: 10, canais: ['online', 'bilheteria'] },
    }))
    await corpo(await master.patch(`/api/admin/evento/${e.id}/configuracoes`, { data: { status: 'ativo' } }))
    const lote = (await doEvento(e.id, 'ingressos')).setores[0].lotes[0]
    const b = await balcaoDaRodada(master, e.id)
    await venderNoBalcao(master, e.id, b.turnoId, [{ lotId: lote.id, quantidade: 1 }], 'debito')

    await abrir(page, url(e.id, 'ingressos/passaportes'))
    const secao = page.locator('section', { hasText: nome })
    const vendidas = secao.locator('div', { has: page.locator('p.rotulo-kpi', { hasText: 'Pessoas já vendidas' }) }).last()
    await expect(vendidas.locator('.numero-kpi')).toHaveText('4')
    await page.getByRole('button', { name: `Configurar ${nome}` }).click()
    // o que conta como aviso: uma faixa/alerta que APARECE por causa da mudança (o texto fixo da
    // janela — "É o número que a portaria usa…" — e o rótulo "Pessoas já vendidas" não contam)
    const avisos = (raiz: Locator) => raiz.locator('.faixa-aviso, .faixa-erro, [role="alert"], [role="status"], p.text-alerta')
    const falaDaVenda = /vendid|já saí|portaria|contagem/i
    expect(limpo((await avisos(janela(page)).allInnerTexts()).join(' '))).not.toMatch(falaDaVenda)
    await campoDoRotulo(janela(page), 'Pessoas por unidade').fill('2')
    let aviso = limpo((await avisos(janela(page)).allInnerTexts()).join(' '))
    if (!falaDaVenda.test(aviso)) {
      // talvez o aviso venha ao salvar
      await janela(page).getByRole('button', { name: 'Salvar' }).click()
      await janela(page).waitFor({ state: 'detached', timeout: 10_000 }).catch(() => {})
      aviso = limpo((await avisos(page.locator('body')).allInnerTexts()).join(' '))
    }
    const admiteAgora = (await doEvento(e.id, 'ingressos')).setores[0].admite
    test.info().annotations.push({ type: 'obs', description: `depois do Salvar, admite=${admiteAgora}; aviso visto: "${aviso}"` })
    expect(aviso, 'mudou de 4 para 2 pessoas por mesa com 1 mesa vendida (4 pessoas na portaria) e a tela não avisou nada').toMatch(falaDaVenda)
  })
})

/* =============================================================== ingressos › promoters */

test.describe('ingressos › promoters', () => {
  const erroNaJanela = (page: Page) => janela(page).locator('[data-parte="erro-na-janela"]')

  test('#100 Ingressos › Promoters › cadastrar com nome de 1 letra, e-mail torto, código vazio, repetido e com acento', async ({ page }) => {
    const e = await eventoDaRodada(master)
    await abrir(page, url(e.id, 'ingressos/promoters'))
    const cadastrar = () => page.getByRole('button', { name: 'Cadastrar divulgador' }).click()
    const nome = janela(page).getByPlaceholder('Nome de quem divulga')
    const email = janela(page).getByPlaceholder('para mandar o link')
    const codigo = janela(page).getByPlaceholder('derivado do nome')
    const gravar = () => janela(page).getByRole('button', { name: 'Cadastrar' }).click()

    await cadastrar()
    await nome.fill('Z')
    await gravar()
    await expect(erroNaJanela(page)).toHaveText('Nome: precisa de pelo menos 2 caractere(s)')
    await nome.fill(`${PREFIXO} Maria`)
    await email.fill('maria@')
    await gravar()
    await expect(erroNaJanela(page)).toContainText('E-mail')
    // código vazio: derivado do nome, sem acento
    await email.fill('')
    await nome.fill(`${PREFIXO} João Ávila`)
    await gravar()
    await expect(janela(page)).toHaveCount(0)
    await expect(page.locator('tr', { hasText: `${PREFIXO} João Ávila` })).toContainText('ZZVAREVTJOAOAVILA')
    // repetido: ganha sufixo
    await cadastrar()
    await nome.fill(`${PREFIXO} Outro`)
    await codigo.fill('ZZVAREVTJOAOAVILA')
    await gravar()
    await expect(janela(page)).toHaveCount(0)
    await expect(page.locator('tr', { hasText: `${PREFIXO} Outro` })).toContainText('ZZVAREVTJOAOAVILA2')
    // com acento e espaço: limpo
    await cadastrar()
    await nome.fill(`${PREFIXO} Açaí`)
    await codigo.fill('zzvarevt Açaí 10')
    await gravar()
    await expect(janela(page)).toHaveCount(0)
    await expect(page.locator('tr', { hasText: `${PREFIXO} Açaí` })).toContainText('ZZVAREVTACAI10')
    const codigos = (await doEvento(e.id, 'promoters')).promoters.map((p: any) => p.codigo).sort()
    expect(codigos).toEqual(['ZZVAREVTACAI10', 'ZZVAREVTJOAOAVILA', 'ZZVAREVTJOAOAVILA2'])
  })

  test('#101 Ingressos › Promoters › comissão 0 / 12,5 / 100 / 101: 101 recusado', async ({ page }) => {
    const e = await eventoDaRodada(master)
    await abrir(page, url(e.id, 'ingressos/promoters'))
    // o percentual com vírgula, como a gente escreve ("12,5%", não "12.5%") — 28/09
    const casos = [['0', 0, '0%'], ['12,5', 1250, '12,5%'], ['100', 10000, '100%']] as const
    for (const [digitado, bps, escrito] of casos) {
      await page.getByRole('button', { name: 'Cadastrar divulgador' }).click()
      await janela(page).getByPlaceholder('Nome de quem divulga').fill(`${PREFIXO} Comissão ${bps}`)
      await janela(page).locator('input[type="number"]').click({ clickCount: 3 })
      await page.keyboard.type(digitado, { delay: 40 })
      await janela(page).getByRole('button', { name: 'Cadastrar' }).click()
      await expect(janela(page)).toHaveCount(0)
      await expect(page.locator('tr', { hasText: `${PREFIXO} Comissão ${bps}` })).toContainText(escrito)
    }
    await page.getByRole('button', { name: 'Cadastrar divulgador' }).click()
    await janela(page).getByPlaceholder('Nome de quem divulga').fill(`${PREFIXO} Comissão 101`)
    await janela(page).locator('input[type="number"]').click({ clickCount: 3 })
    await page.keyboard.type('101', { delay: 40 })
    await janela(page).getByRole('button', { name: 'Cadastrar' }).click()
    // em %, não em pontos-base ("o máximo é 10000" era a comissão de 100% escrita em bps)
    await expect(erroNaJanela(page)).toHaveText('Comissão: não pode passar de 100%')
    const lista = (await doEvento(e.id, 'promoters')).promoters
    expect(lista.map((p: any) => p.comissaoBps).sort((a: number, b: number) => a - b)).toEqual([0, 1250, 10000])
  })

  test('#104 Ingressos › Promoters › copiar link sem área de transferência: recado de bloqueio', async ({ page }) => {
    const e = await eventoDaRodada(master)
    await corpo(await master.post(`/api/admin/evento/${e.id}/promoters`, { data: { nome: `${PREFIXO} Link`, comissaoBps: 0 } }))
    // o tablet em http na rede do parque: navigator.clipboard não existe
    await page.addInitScript(() => { Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true }) })
    await abrir(page, url(e.id, 'ingressos/promoters'))
    await page.locator('tr', { hasText: `${PREFIXO} Link` }).getByRole('button', { name: /ZZVAREVTLINK/ }).click()
    await expect(page.getByText('O navegador bloqueou a cópia. Selecione o link à mão:')).toBeVisible()
    await expect(page.locator('tr', { hasText: `${PREFIXO} Link` })).not.toContainText('link copiado')
    // "selecione à mão" precisa ter o que selecionar: o link vem inteiro na própria recusa
    const mostraOLink = await page.locator('main').innerText().then((t) => /\/e\/[a-z0-9-]+\?[^\s]*ZZVAREVTLINK/i.test(t))
    expect(mostraOLink, 'a recusa manda selecionar o link, e o link não está na tela').toBe(true)
  })
})

/* ================================================================== ingressos › sessões */

test.describe('ingressos › sessões', () => {
  test('#106 Ingressos › Sessões › 23:00–01:00, menos de 15 min e 6 horários: atravessa a meia-noite certo; < 15 min recusado', async ({ page }) => {
    const e = await eventoDaRodada(master)
    const dia = proximoSabado(10)
    await abrir(page, url(e.id, 'ingressos/sessoes'))
    await page.locator('#de').fill(dia)
    await page.locator('#ate').fill(dia)
    const hora = page.locator('section', { hasText: 'Criar várias datas de uma vez' }).locator('input[type="time"]')
    // menos de 15 minutos: recusado com a frase, nada criado
    await hora.nth(0).fill('10:00')
    await hora.nth(1).fill('10:10')
    await page.getByRole('button', { name: 'Criar datas' }).click()
    await expect(page.locator('.faixa-erro')).toHaveText('O horário 10:00–10:10 dura menos de 15 minutos.')
    expect((await doEvento(e.id, 'sessoes')).sessoes).toHaveLength(0)
    // seis horários no mesmo dia, o primeiro atravessando a meia-noite
    const faixas = [['23:00', '01:00'], ['08:00', '09:00'], ['10:00', '11:00'], ['12:00', '13:00'], ['14:00', '15:00'], ['16:00', '17:00']]
    const outro = page.getByRole('button', { name: 'Outro horário no mesmo dia' })
    for (let i = 1; i < faixas.length; i++) await outro.click()
    await expect(outro, 'com 6 horários o botão de mais um some').toHaveCount(0)
    for (const [i, [ini, fim]] of faixas.entries()) {
      await hora.nth(i * 2).fill(ini)
      await hora.nth(i * 2 + 1).fill(fim)
    }
    await page.getByRole('button', { name: 'Criar datas' }).click()
    await expect(page.locator('.faixa-aviso')).toContainText('6 dia(s) criado(s)')
    const sessoes = (await doEvento(e.id, 'sessoes')).sessoes
    expect(sessoes).toHaveLength(6)
    const meiaNoite = sessoes.find((s: any) => naBahia(s.inicio).endsWith('T23:00'))
    expect(meiaNoite, 'a sessão das 23:00 não foi criada').toBeTruthy()
    expect(naBahia(meiaNoite.inicio).slice(0, 10)).toBe(dia)
    expect(naBahia(meiaNoite.fim), 'o fim das 01:00 é no dia SEGUINTE').toBe(`${diaSeguinte(dia)}T01:00`)
    expect(Date.parse(meiaNoite.fim) - Date.parse(meiaNoite.inicio)).toBe(2 * 3_600_000)
    await expect(page.locator('section', { hasText: '23:00 às 01:00' })).toHaveCount(1)
  })

  test('#110 Ingressos › Sessões › ingressos do dia: o herdado do setor aparece como "já vende neste dia pelo setor"; o escolhido, marcado', async ({ page }) => {
    const e = await eventoDaRodada(master)
    const dia = proximoSabado(10)
    await corpo(await master.post(`/api/admin/evento/${e.id}/sessoes`, {
      data: { o: 'criar', de: dia, ate: dia, dias: [6], horarios: [{ inicio: '09:00', fim: '17:00' }], titulo: `${PREFIXO} Dia` },
    }))
    const sessao = (await doEvento(e.id, 'sessoes')).sessoes[0]
    // o modelo antigo: um setor inteiro preso ao dia, com o lote dele
    const setor = await corpo(await master.post(`/api/admin/evento/${e.id}/ingressos`, {
      data: { o: 'setor', nome: `${PREFIXO} Setor do dia`, tipo: 'ingresso', sessaoId: sessao.id },
    }))
    await corpo(await master.post(`/api/admin/evento/${e.id}/ingressos`, {
      data: { o: 'lote', setorId: setor.id, nome: `${PREFIXO} Lote herdado`, faceCents: 2000, quantidade: 50, canais: ['online', 'bilheteria'] },
    }))
    // o modelo novo: o 1º lote escolhido pra esse dia
    await corpo(await master.post(`/api/admin/evento/${e.id}/sessoes`, { data: { o: 'lotes', sessaoId: sessao.id, loteIds: [e.lote.id] } }))

    await abrir(page, url(e.id, 'ingressos/sessoes'))
    const cartao = page.locator('section', { hasText: `${PREFIXO} Dia` }).filter({ hasText: 'Vendendo neste dia' })
    await expect(cartao.locator('.selo-neutro', { hasText: `${PREFIXO} Lote herdado` })).toContainText('(setor)')
    await expect(cartao.locator('.selo-neutro', { hasText: '1º lote' })).not.toContainText('(setor)')
    await page.getByRole('button', { name: `Ingressos de ${PREFIXO} Dia` }).click()
    const herdado = janela(page).getByRole('button', { name: new RegExp(`${PREFIXO} Lote herdado`) })
    const escolhido = janela(page).getByRole('button', { name: /1º lote/ })
    await expect(herdado).toContainText('já vende neste dia pelo setor')
    await expect(herdado, 'o herdado aparece como escolhido nesta tela').not.toHaveClass(/border-acao-forte/)
    await expect(escolhido).not.toContainText('já vende neste dia pelo setor')
    await expect(escolhido, 'o escolhido não aparece marcado').toHaveClass(/border-acao-forte/)
    await expect(escolhido.locator('svg')).toHaveCount(1)
  })

  test('#113 Ingressos › Sessões › lote em 2 dias: hoje vende sem escolher o dia e não desconta vaga, e a tela avisa (ADM-27, decisão do dono)', async ({ page }) => {
    const e = await eventoDaRodada(master)
    const b = await balcaoDaRodada(master, e.id)
    const sabado = proximoSabado(10)
    await corpo(await master.post(`/api/admin/evento/${e.id}/sessoes`, {
      data: { o: 'criar', de: sabado, ate: diaSeguinte(sabado), dias: [6, 7], horarios: [{ inicio: '09:00', fim: '17:00' }], capacidade: 100 },
    }))
    const dias = (await doEvento(e.id, 'sessoes')).sessoes
    expect(dias).toHaveLength(2)
    await corpo(await master.post(`/api/admin/evento/${e.id}/sessoes`, {
      data: { o: 'lotes', loteId: e.lote.id, sessaoIds: dias.map((s: any) => s.id) },
    }))
    await venderNoBalcao(master, e.id, b.turnoId, [{ lotId: e.lote.id, ticketTypeId: e.inteira, quantidade: 2 }], 'debito')

    await abrir(page, url(e.id, 'ingressos/sessoes'))
    await expect(page.locator('main')).toContainText('1 ingresso(s) valem em mais de um dia.')
    await expect(page.locator('main')).toContainText('não descontam vaga de nenhuma sessão')
    // hoje (ADM-27): a venda não desconta de dia nenhum — o ideal é descontar do dia escolhido na compra
    for (const s of dias) {
      const cartao = page.locator('section', { hasText: s.titulo })
      const confirmadas = cartao.locator('div', { has: page.locator('p.rotulo-kpi', { hasText: 'Pessoas confirmadas' }) }).last()
      await expect(confirmadas.locator('.numero-kpi')).toHaveText('0')
      await expect(cartao.locator('.selo-ok')).toHaveText('100 vaga(s)')
    }
    expect((await doEvento(e.id, 'sessoes')).sessoes.map((s: any) => s.ocupadas)).toEqual([0, 0])
    test.info().annotations.push({ type: 'obs', description: 'ADM-27 não consertado (decisão do dono): 2 ingressos vendidos, 0 pessoas nos dois dias' })
  })
})

/* ============================================================================ assentos */

test.describe('assentos', () => {
  test('#114 Assentos › Gerar mapa 10×20 com corredor "10, 11": 180 lugares, sem o 10 e o 11', async ({ page }) => {
    const e = await eventoDaRodada(master)
    await abrir(page, url(e.id, 'assentos'))
    await page.getByRole('button', { name: 'Gerar mapa deste setor' }).click()
    await campoDoRotulo(janela(page), 'Fileiras').fill('10')
    await campoDoRotulo(janela(page), 'Lugares por fileira').fill('20')
    await campoDoRotulo(janela(page), 'Números que não existem (corredor)').fill('10, 11')
    await expect(janela(page)).toContainText('Vai criar 180 lugares')
    await janela(page).getByRole('button', { name: 'Gerar', exact: true }).click()
    await expect(page.getByText('180 lugares criados em 10 fileiras.')).toBeVisible()
    const numeros = await page.locator('.inline-grid > div').evaluateAll((filas) => filas.map((f) =>
      [...f.querySelectorAll('button')].filter((b) => !b.title.startsWith('Selecionar')).map((b) => Number(b.textContent))))
    expect(numeros).toHaveLength(10)
    const esperado = Array.from({ length: 20 }, (_, i) => i + 1).filter((n) => n !== 10 && n !== 11)
    for (const fila of numeros) expect(fila).toEqual(esperado)
    const setor = (await doEvento(e.id, 'assentos')).setores.find((s: any) => s.id === e.setorId)
    expect(setor.total).toBe(180)
    expect(setor.fileiras.map((f: any) => f.nome)).toEqual(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'])
  })

  test('#116 Assentos › seleção por clique, Shift e fileira; Bloquear e Liberar com motivo', async ({ page }) => {
    const e = await eventoDaRodada(master)
    await corpo(await master.post(`/api/admin/evento/${e.id}/assentos`, { data: { setorId: e.setorId, fileiras: 3, porFileira: 10 } }))
    await abrir(page, url(e.id, 'assentos'))
    const lugar = (r: string) => page.locator(`.inline-grid button[title="${r}"]`)
    const selecionados = page.locator('p', { hasText: 'selecionado(s)' }).locator('strong').first()
    await lugar('A2').click()
    await lugar('A6').click({ modifiers: ['Shift'] })
    await expect(selecionados).toHaveText('5')
    await page.getByTitle('Selecionar a fileira B inteira').click()
    await expect(selecionados).toHaveText('15')
    await lugar('B10').click()
    await expect(selecionados).toHaveText('14')
    await page.getByPlaceholder('poltrona quebrada, reserva da produção…').fill(`${PREFIXO} poltrona quebrada`)
    await page.getByRole('button', { name: 'Bloquear', exact: true }).click()
    await expect(page.getByText('14 lugar(es) bloqueados.')).toBeVisible()
    const setor = async () => (await doEvento(e.id, 'assentos')).setores.find((s: any) => s.id === e.setorId)
    const bloqueados = (s: any) => s.fileiras.flatMap((f: any) => f.lugares).filter((l: any) => l.status === 'bloqueado')
    let s = await setor()
    expect(bloqueados(s).map((l: any) => l.rotulo).sort()).toEqual(
      ['A2', 'A3', 'A4', 'A5', 'A6', 'B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B9'].sort())
    expect(new Set(bloqueados(s).map((l: any) => l.nota))).toEqual(new Set([`${PREFIXO} poltrona quebrada`]))
    await expect(page.locator(`.inline-grid button[title="A2 — ${PREFIXO} poltrona quebrada"]`)).toBeVisible()
    // Liberar: a fileira A inteira volta, a B continua bloqueada
    await page.getByTitle('Selecionar a fileira A inteira').click()
    await expect(selecionados).toHaveText('10')
    await page.getByRole('button', { name: 'Liberar', exact: true }).click()
    await expect(page.getByText(/lugar\(es\) liberados\./)).toBeVisible()
    s = await setor()
    expect(bloqueados(s).map((l: any) => l.rotulo).sort()).toEqual(['B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B9'].sort())
    expect(s.fileiras[0].lugares.every((l: any) => l.status === 'livre' && !l.nota)).toBe(true)
  })
})

/* ======================================================================= configurações */

test.describe('configurações', () => {
  const salvar = (page: Page) => page.getByRole('button', { name: 'Salvar', exact: true })
  const salvo = (page: Page) => page.locator('p.border-ok', { hasText: 'Salvo.' })
  const erro = (page: Page) => page.locator('p.border-erro').first()

  test('#118 Configurações › Salvar manda só o campo mudado; Desfazer volta tudo', async ({ page }) => {
    const e = await eventoDaRodada(master)
    const corpos: any[] = []
    page.on('request', (r) => { if (r.method() === 'PATCH' && r.url().endsWith(`/evento/${e.id}/configuracoes`)) corpos.push(r.postDataJSON()) })
    await abrir(page, url(e.id, 'configuracoes'))
    const desfazer = page.getByRole('button', { name: 'Desfazer' })
    await expect(salvar(page)).toBeDisabled()
    await expect(desfazer).toBeDisabled()
    await campoDoRotulo(page, 'Categoria').fill(`${PREFIXO} Festa`)
    await salvar(page).click()
    await expect(salvo(page)).toBeVisible()
    expect(corpos, 'o Salvar mandou mais do que o campo mudado').toEqual([{ categoria: `${PREFIXO} Festa` }])

    const nome = campoDoRotulo(page, 'Nome do evento')
    const local = campoDoRotulo(page, 'Nome do local')
    const [nomeAntes, localAntes] = [await nome.inputValue(), await local.inputValue()]
    await nome.fill(`${PREFIXO} nome que volta`)
    await local.fill(`${PREFIXO} local que volta`)
    await page.locator('#taxa').fill('7')
    await expect(desfazer).toBeEnabled()
    await desfazer.click()
    await expect(nome).toHaveValue(nomeAntes)
    await expect(local).toHaveValue(localAntes)
    await expect(page.locator('#taxa')).toHaveValue('10')
    await expect(campoDoRotulo(page, 'Categoria')).toHaveValue(`${PREFIXO} Festa`)
    await expect(salvar(page)).toBeDisabled()
    await expect(desfazer).toBeDisabled()
    expect(corpos, 'Desfazer gravou alguma coisa').toHaveLength(1)
    const cfg = await doEvento(e.id, 'configuracoes')
    expect([cfg.nome, cfg.local, cfg.taxaBps, cfg.categoria]).toEqual([nomeAntes, localAntes, 1000, `${PREFIXO} Festa`])
  })

  test('#122 Configurações › "Venda encerra" por data fixa × por minutos após o início: preencher um zera o outro', async ({ page }) => {
    const e = await eventoDaRodada(master)
    await abrir(page, url(e.id, 'configuracoes'))
    const dataFixa = campoDoRotulo(page, 'Venda encerra em (data fixa)')
    const minutos = campoDoRotulo(page, '…ou minutos após o início')
    const quando = campoDataHora(2, '18:00')

    // A) na mesma edição, a partir do vazio: a data e depois os minutos
    await dataFixa.fill(quando)
    await minutos.fill('120')
    await expect.soft(dataFixa, 'a tela diz "Preencher um zera o outro", mas a data continuou preenchida').toHaveValue('')
    await salvar(page).click()
    await expect(salvo(page)).toBeVisible()
    let cfg = await doEvento(e.id, 'configuracoes')
    expect.soft(cfg.vendaAteMinutos, 'os minutos (o último preenchido) sumiram em silêncio; ficou a data').toBe(120)
    expect.soft(cfg.vendaAte).toBeNull()

    // B) em gravações separadas: com a data gravada (o ponto de partida vem pela API, pra não
    //    depender do que o A deixou), gravar os minutos pela tela zera a data
    await corpo(await master.patch(`/api/admin/evento/${e.id}/configuracoes`, {
      data: { vendaAte: new Date(Date.now() + 2 * 86_400_000).toISOString() },
    }))
    await page.reload()
    await hidratada(page)
    await expect(dataFixa).not.toHaveValue('')
    await expect(minutos).toHaveValue('')
    await minutos.fill('90')
    await salvar(page).click()
    await expect(salvo(page)).toBeVisible()
    cfg = await doEvento(e.id, 'configuracoes')
    expect([cfg.vendaAte, cfg.vendaAteMinutos]).toEqual([null, 90])
    await expect(dataFixa).toHaveValue('')
    // C) e o contrário: com os minutos gravados, gravar a data zera os minutos
    await dataFixa.fill(quando)
    await salvar(page).click()
    await expect(salvo(page)).toBeVisible()
    cfg = await doEvento(e.id, 'configuracoes')
    expect(cfg.vendaAteMinutos).toBeNull()
    expect(cfg.vendaAte).not.toBeNull()
    await expect(minutos).toHaveValue('')
  })

  test('#125 Configurações › reserva no carrinho 4 / 5 / 120 / 121: fora de 5–120 recusado dizendo o campo', async ({ page }) => {
    const e = await eventoDaRodada(master)
    await abrir(page, url(e.id, 'configuracoes'))
    const campo = campoDoRotulo(page, 'Minutos de reserva no carrinho')
    const casos = [['4', 'Minutos de reserva no carrinho: o mínimo é 5'], ['5', null], ['121', 'Minutos de reserva no carrinho: o máximo é 120'], ['120', null]] as const
    for (const [v, recusa] of casos) {
      await campo.fill(v)
      await salvar(page).click()
      if (recusa) {
        await expect(erro(page)).toHaveText(recusa)
      } else {
        await expect(salvo(page)).toBeVisible()
        expect((await doEvento(e.id, 'configuracoes')).minutosDeReserva).toBe(Number(v))
      }
    }
    // vazio: a tela pede o valor antes de mandar
    await campo.fill('')
    await salvar(page).click()
    await expect(erro(page)).toHaveText('Preencha os "Minutos de reserva no carrinho" (de 5 a 120).')
    expect((await doEvento(e.id, 'configuracoes')).minutosDeReserva).toBe(120)
  })

  test('#126 Configurações › máximo por cliente vazio / 0 / 200 / 201: vazio = sem limite', async ({ page }) => {
    const e = await eventoDaRodada(master)
    await abrir(page, url(e.id, 'configuracoes'))
    const campo = campoDoRotulo(page, 'Máximo por cliente')
    const doCfg = async () => (await doEvento(e.id, 'configuracoes')).maxPorCliente
    await campo.fill('200')
    await salvar(page).click()
    await expect(salvo(page)).toBeVisible()
    expect(await doCfg()).toBe(200)
    await campo.fill('201')
    await salvar(page).click()
    await expect(erro(page)).toHaveText('Máximo por cliente: o máximo é 200')
    await campo.fill('0')
    await salvar(page).click()
    await expect(erro(page)).toHaveText('Máximo por cliente: o mínimo é 1')
    expect(await doCfg()).toBe(200)
    await campo.fill('')
    await salvar(page).click()
    await expect(salvo(page)).toBeVisible()
    expect(await doCfg(), 'vazio não virou "sem limite"').toBeNull()
    await page.reload()
    await hidratada(page)
    await expect(campo).toHaveValue('')
    await expect(campo).toHaveAttribute('placeholder', 'sem limite')
  })

  test('#128 Configurações › Adiar com data passada, mesma data, fim antes, motivo curto e duplo clique: recusas com a frase e UMA remarcação', async ({ page }) => {
    const e = await eventoDaRodada(master)
    const cfg0 = await doEvento(e.id, 'configuracoes')
    const remarcacoes = async () => Number((await sqlE2e(
      `SELECT count(*)::int AS n FROM event_cancellations WHERE event_id = $1 AND kind = 'adiado'`, [e.id]))[0].n)
    await abrir(page, url(e.id, 'configuracoes'))
    const bloco = page.locator('#cancelamento')
    const inicio = campoDoRotulo(bloco, 'Novo início')
    const fim = campoDoRotulo(bloco, 'Novo término')
    const motivo = bloco.getByPlaceholder('Chuva forte: passou para o dia 25')
    const adiar = bloco.getByRole('button', { name: 'Adiar evento' })
    const recusa = bloco.locator('p.faixa-erro')

    // motivo curto: o botão trava — e diz por quê
    await motivo.fill('ab')
    await expect(adiar).toBeDisabled()
    expect.soft(limpo(await bloco.innerText()), 'motivo com 2 letras: o botão "Adiar evento" travou sem dizer por quê')
      .toMatch(/motivo[^.]*(3|três) letras|pelo menos 3/i)
    await motivo.fill(`${PREFIXO} chuva forte`)
    // data que já passou
    await inicio.fill(campoDataHora(-1, '10:00'))
    await fim.fill(campoDataHora(-1, '18:00'))
    await adiar.click()
    await expect(recusa).toContainText('A data nova precisa estar no futuro')
    // a mesma data de hoje
    await inicio.fill(naBahia(cfg0.comecaEm))
    await fim.fill(naBahia(cfg0.terminaEm))
    await adiar.click()
    await expect(recusa).toContainText('Esta já é a data do evento')
    // fim antes do início
    await inicio.fill(campoDataHora(20, '18:00'))
    await fim.fill(campoDataHora(20, '10:00'))
    await adiar.click()
    await expect(recusa).toHaveText('O fim do evento não pode ser antes do início.')
    expect(await remarcacoes(), 'alguma recusa remarcou mesmo assim').toBe(0)

    // duplo clique no próprio navegador, com a data certa: UMA remarcação
    const respostas: number[] = []
    page.on('response', (r) => { if (r.request().method() === 'POST' && r.url().endsWith('/remarcar')) respostas.push(r.status()) })
    await inicio.fill(campoDataHora(20, '10:00'))
    await fim.fill(campoDataHora(20, '18:00'))
    await doisCliquesColados(page, '#cancelamento button', /^Adiar evento$/)
    await expect(bloco.getByText('Feito', { exact: true })).toBeVisible()
    await page.waitForLoadState('networkidle').catch(() => {})
    await expect.poll(() => respostas.length).toBeGreaterThanOrEqual(1)
    expect(await remarcacoes(), `duplo clique virou mais de uma remarcação (respostas: ${respostas.join(',')})`).toBe(1)
    expect(naBahia((await doEvento(e.id, 'configuracoes')).comecaEm)).toBe(campoDataHora(20, '10:00'))
    test.info().annotations.push({
      type: 'obs',
      description: `duplo clique: respostas ${respostas.join(',')}; recusa na tela depois do "Feito": "${limpo(await recusa.textContent().catch(() => '') ?? '')}"`,
    })
  })
})

/* ================================================================================= PDV */

test.describe('pdv', () => {
  test('#141 PDV › Pontos de venda › novo ponto sem forma de pagamento / com nome vazio: recusa com a frase', async ({ page }) => {
    const e = await eventoDaRodada(master)
    const posts: number[] = []
    page.on('response', (r) => { if (r.request().method() === 'POST' && r.url().endsWith(`/evento/${e.id}/pdv`)) posts.push(r.status()) })
    await abrir(page, url(e.id, 'pdv'))
    const form = page.locator('form', { has: page.getByPlaceholder('Guichê Portão A') })
    const nome = form.getByPlaceholder('Guichê Portão A')
    const criar = form.getByRole('button', { name: 'Criar ponto' })
    // sem forma de pagamento: a tela recusa antes de mandar
    await nome.fill(`${PREFIXO} Sem Forma`)
    for (const f of ['Dinheiro', 'Débito', 'Crédito', 'Pix']) await form.getByRole('button', { name: f, exact: true }).click()
    await criar.click()
    await expect(page.locator('.faixa-erro')).toHaveText('Escolha pelo menos uma forma de pagamento.')
    expect(posts).toEqual([])
    // nome vazio: o campo é obrigatório — o navegador segura e diz o que falta
    await form.getByRole('button', { name: 'Pix', exact: true }).click()
    await nome.fill('')
    await criar.click()
    expect(await nome.evaluate((el) => (el as HTMLInputElement).validationMessage)).not.toBe('')
    expect(posts).toEqual([])
    // nome só de espaços: passa pelo navegador e o servidor recusa com a frase
    await nome.fill('   ')
    await criar.click()
    await expect(page.locator('.faixa-erro')).toHaveText('Dê um nome ao ponto de venda (de 2 a 80 letras).')
    expect(posts).toEqual([400])
    expect((await doEvento(e.id, 'pdv')).pontos).toEqual([])
  })

  test('#150 PDV › Vender › evento encerrado / cancelado / rascunho: a tela avisa antes do clique e a venda volta 409 com a frase', async ({ page }) => {
    test.setTimeout(300_000)
    for (const situacao of ['encerrado', 'rascunho', 'cancelado'] as const) {
      const e = await eventoDaRodada(master)
      const b = await balcaoDaRodada(master, e.id)
      if (situacao === 'cancelado') {
        await corpo(await master.post(`/api/admin/evento/${e.id}/cancelar`, { data: { escopo: 'evento', motivo: `${PREFIXO} teste do balcão` } }))
      } else {
        await corpo(await master.patch(`/api/admin/evento/${e.id}/configuracoes`, { data: { status: situacao } }))
      }
      const vendas: number[] = []
      const ouvir = (r: any) => { if (r.request().method() === 'POST' && r.url().endsWith('/pdv/venda')) vendas.push(r.status()) }
      page.on('response', ouvir)
      await abrir(page, url(e.id, `pdv/vender?turno=${b.turnoId}`))
      // antes do clique: a tela do balcão já diz que este evento não vende
      const antes = limpo(await page.locator('main').innerText())
      expect.soft(antes, `${situacao}: o balcão abre normal, sem avisar que o evento não está vendendo`)
        .toMatch(/vendas deste evento não estão abertas|evento (está |foi )?(encerrado|cancelado|em rascunho)|não está (vendendo|à venda)/i)
      // o clique: a venda é recusada com a frase
      await page.locator('button.card', { hasText: 'Inteira' }).first().click()
      await page.locator('#venda').getByRole('button', { name: 'Débito' }).click()
      await page.locator('#venda').getByRole('button', { name: /^Vender R\$/ }).click()
      await expect(page.locator('#venda .faixa-erro')).toHaveText('As vendas deste evento não estão abertas')
      expect(vendas, situacao).toEqual([409])
      page.off('response', ouvir)
      expect((await doEvento(e.id, `pdv/turno?turno=${b.turnoId}`)).vendas, `${situacao}: gravou venda`).toEqual([])
    }
  })

  test('#157 PDV › Conferência de caixa › anular o suprimento que deixaria a gaveta negativa: recusado com a frase', async ({ page }) => {
    const e = await eventoDaRodada(master)
    const b = await balcaoDaRodada(master, e.id, 0)
    await corpo(await master.post(`/api/admin/evento/${e.id}/pdv/gaveta`, {
      data: { turnoId: b.turnoId, tipo: 'suprimento', valorCents: 10000, motivo: `${PREFIXO} troco extra` },
    }))
    await corpo(await master.post(`/api/admin/evento/${e.id}/pdv/gaveta`, {
      data: { turnoId: b.turnoId, tipo: 'sangria', valorCents: 8000, motivo: `${PREFIXO} recolhido` },
    }))
    await abrir(page, url(e.id, `pdv/caixa?turno=${b.turnoId}`))
    await page.locator('tr', { hasText: `${PREFIXO} troco extra` }).getByRole('button', { name: 'Anular' }).click()
    const formulario = page.locator('tr.bg-erro-claro')
    await formulario.getByPlaceholder('Ex.: digitei 500 em vez de 50').fill(`${PREFIXO} lançado errado`)
    await formulario.getByRole('button', { name: 'Anular R$ 100,00' }).click()
    await expect(formulario.locator('.faixa-erro')).toContainText('anular este suprimento deixaria a gaveta negativa')
    await expect(formulario.locator('.faixa-erro')).toContainText('R$ 20,00')
    const turno = await doEvento(e.id, `pdv/turno?turno=${b.turnoId}`)
    expect(turno.movimentos, 'a anulação recusada entrou mesmo assim').toHaveLength(2)
    expect(turno.movimentos.some((m: any) => m.anula || m.anuladoPor)).toBe(false)
  })
})
