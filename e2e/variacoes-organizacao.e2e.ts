/**
 * variacoes-organizacao.e2e.ts — as variações do painel da ORGANIZAÇÃO que ficaram fora da
 * bateria automática (rodada final da matriz, agente V-ORG, 28/09).
 *
 * Um `test()` por variação, com o número dela na matriz (`#n`) no título. Cada caso afirma o que a
 * PESSOA vê (texto, botão travado, URL, F5) e, quando faz sentido, o que o servidor gravou.
 *
 *   E2E_BASE=http://127.0.0.1:3120 npx playwright test e2e/variacoes-organizacao.e2e.ts --reporter=line
 *
 * Terreno: o que não pode nascer na organização do seed (outra bateria roda ao mesmo tempo no
 * mesmo banco) nasce numa organização própria "ZZVARORG …" — ver `variacoes-organizacao-apoio.ts`.
 * Os eventos publicados daqui são PRIVADOS (abrem pelo link, não entram na vitrine) e tudo sai no
 * `afterAll`. Casos só de leitura usam as sessões do `preparo` na organização do seed.
 *
 * Duplo clique: os dois cliques saem no próprio navegador (`el.click()` duas vezes seguidas) —
 * as ações do Playwright esperam a tela estabilizar entre um e outro e escondem a corrida.
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import { BASE, PAPEIS, SENHA, entrarPeloFormulario, hidratada, sessao, travaDeBase, type Papel } from './apoio'
import { abrir, abrirBalcao, corpo, cpfDeTeste, textoDoDownload, venderNoBalcao } from './evento-apoio'
import {
  PNG_8x4, PREFIXO, apagarArquivo, apagarOrganizacao, caixaDeErro, criarEventoApi, criarEventoSql, criarOrganizacao,
  criarUsuario, entrarComo, esperarEmail, fecharBanco, limparRestos, marcaNova, passoAtual, preencherAssistente,
  preencherDoPasso2, prosseguir, publicarAssistente, sql, type OrgZZ, type UsuarioZZ,
} from './variacoes-organizacao-apoio'

test.beforeAll(async () => {
  travaDeBase(BASE)
  await limparRestos()
})
test.afterAll(async () => { await fecharBanco() })

/** as opções de contexto do projeto "computador", pra um segundo navegador no mesmo caso */
const OPCOES_DO_CONTEXTO = {
  baseURL: BASE, viewport: { width: 1366, height: 860 }, locale: 'pt-BR', timezoneId: 'America/Bahia',
} as const

/** print de conferência: na pasta de E2E_PRINTS quando dada, senão na saída do próprio caso */
async function printar(page: Page, nome: string) {
  const pasta = process.env.E2E_PRINTS
  const caminho = pasta ? `${pasta}/${nome}.png` : test.info().outputPath(`${nome}.png`)
  await page.screenshot({ path: caminho, fullPage: true })
  await test.info().attach(nome, { path: caminho, contentType: 'image/png' })
}

/** põe a sessão de um usuário ZZVARORG no navegador do caso */
async function logar(context: BrowserContext, u: UsuarioZZ) {
  const { api, cookies } = await entrarComo(u.email)
  await context.addCookies(cookies)
  return api
}

const menuDaConta = (page: Page) => page.getByRole('button', { name: 'Menu da sua conta' })
const painelLateral = (page: Page) => page.locator('[data-parte="modal-lateral"]')

/* ================================================================ layout do painel */

test.describe('Layout do painel', () => {
  test.describe('trilho (sessão do master do seed, só leitura)', () => {
    test.use({ storageState: sessao('master') })

    test('#6 Trilho (desktop) › hover: expande na hora, recolhe 200 ms depois e o conteúdo não pula', async ({ page }) => {
      await abrir(page, '/admin')
      await page.mouse.move(900, 450)
      // relógio do próprio navegador: quando o mouse entrou/saiu e quando a classe da largura trocou,
      // e a posição do conteúdo a cada quadro — o conteúdo não pode andar junto com a lateral
      await page.evaluate(() => {
        const el = document.getElementById('menu-lateral')!
        const conteudo = document.querySelector<HTMLElement>('#menu-lateral ~ div')!
        const h1 = document.querySelector<HTMLElement>('h1')!
        const w = window as any
        w.__trilho = { entrou: 0, saiu: 0, abriu: 0, fechou: 0, xs: [] as number[], hs: [] as number[], larguras: [] as number[], medindo: true }
        el.addEventListener('mouseenter', () => { if (!w.__trilho.entrou) w.__trilho.entrou = performance.now() })
        el.addEventListener('mouseleave', () => { if (!w.__trilho.saiu) w.__trilho.saiu = performance.now() })
        new MutationObserver(() => {
          const aberto = el.classList.contains('lg:w-72')
          if (aberto && !w.__trilho.abriu) w.__trilho.abriu = performance.now()
          if (!aberto && w.__trilho.abriu && !w.__trilho.fechou) w.__trilho.fechou = performance.now()
        }).observe(el, { attributes: true, attributeFilter: ['class'] })
        const quadro = () => {
          if (!w.__trilho.medindo) return
          w.__trilho.xs.push(conteudo.getBoundingClientRect().left)
          w.__trilho.hs.push(h1.getBoundingClientRect().left)
          w.__trilho.larguras.push(el.getBoundingClientRect().width)
          requestAnimationFrame(quadro)
        }
        requestAnimationFrame(quadro)
      })
      const lateral = page.locator('#menu-lateral')
      const recolhida = (await lateral.boundingBox())!.width
      await page.mouse.move(48, 320, { steps: 4 })
      await page.waitForTimeout(700)
      const aberta = (await lateral.boundingBox())!.width
      await page.mouse.move(900, 450, { steps: 4 })
      await page.waitForTimeout(900)
      const t = await page.evaluate(() => { const w = window as any; w.__trilho.medindo = false; return w.__trilho })
      expect(recolhida, 'recolhida, a lateral é o trilho de 80 px').toBeLessThan(100)
      expect(aberta, 'no hover a lateral abre inteira (288 px)').toBeGreaterThan(260)
      expect(t.abriu - t.entrou, 'abrir é na hora (sem espera)').toBeLessThan(120)
      expect(t.fechou - t.saiu, 'recolher espera o respiro de 200 ms').toBeGreaterThanOrEqual(190)
      expect(t.fechou - t.saiu, 'e não fica aberta além do respiro').toBeLessThan(700)
      expect(Math.max(...t.larguras), 'a lateral voltou a crescer e recolher durante a medida').toBeGreaterThan(260)
      expect((await lateral.boundingBox())!.width, 'recolheu de volta').toBeLessThan(100)
      expect(Math.max(...t.xs) - Math.min(...t.xs), 'a coluna do conteúdo andou com o hover').toBeLessThan(0.5)
      expect(Math.max(...t.hs) - Math.min(...t.hs), 'o título da página andou com o hover').toBeLessThan(0.5)
    })
  })

  test.describe('trocar a própria senha (usuários próprios, organização ZZVARORG)', () => {
    let org: OrgZZ
    let duplo: UsuarioZZ
    let freio: UsuarioZZ
    test.beforeAll(async () => {
      org = await criarOrganizacao('senha', ['master'])
      duplo = await criarUsuario(org, 'operacao', 'duplo')
      freio = await criarUsuario(org, 'operacao', 'freio')
    })
    test.afterAll(async () => { if (org) await apagarOrganizacao(org.id) })

    async function abrirTrocaDeSenha(page: Page) {
      await abrir(page, '/admin')
      await menuDaConta(page).click()
      await page.getByRole('menuitem', { name: 'Trocar senha' }).click()
      await expect(painelLateral(page)).toBeVisible()
      return painelLateral(page)
    }

    test('#18 Trocar senha › duplo clique: um POST só, e o botão fica "Trocando…" desligado', async ({ page, context }) => {
      await logar(context, duplo)
      const painel = await abrirTrocaDeSenha(page)
      const nova = `zz-${marcaNova()}-nova`
      await painel.locator('#senha-atual').fill(SENHA)
      await painel.locator('#senha-nova').fill(nova)
      await painel.locator('#senha-confirma').fill(nova)
      let posts = 0
      page.on('request', (r) => { if (r.method() === 'POST' && new URL(r.url()).pathname === '/api/auth/senha') posts++ })
      // segura a resposta 1,5 s: dá tempo de ver o estado "enviando" que a pessoa veria
      await page.route('**/api/auth/senha', async (rota) => { await new Promise((r) => setTimeout(r, 1500)); await rota.continue() })
      await painel.getByRole('button', { name: 'Trocar senha' }).evaluate((b: HTMLButtonElement) => { b.click(); b.click() })
      const enviando = painel.getByRole('button', { name: 'Trocando…' })
      await expect(enviando).toBeVisible()
      await expect(enviando).toBeDisabled()
      await expect(painel.getByRole('status')).toContainText('Senha trocada', { timeout: 20_000 })
      expect(posts, 'o segundo clique mandou outro POST').toBe(1)
      // o servidor trocou UMA vez (um registro na auditoria) e a senha nova é a que vale
      const [a] = await sql<{ n: number }>(
        `SELECT count(*)::int AS n FROM audit_log WHERE entity = 'usuario' AND entity_id = $1 AND action = 'senha_trocada'`, [duplo.id])
      expect(a!.n).toBe(1)
      const { api } = await entrarComo(duplo.email, nova)
      await api.dispose()
    })

    test('#20 Trocar senha › força bruta: a 9ª tentativa leva 429 "Muitas tentativas…" e o painel continua aberto', async ({ page, context }) => {
      test.setTimeout(240_000)
      try {
        await logar(context, freio)
        const painel = await abrirTrocaDeSenha(page)
        await painel.locator('#senha-nova').fill('uma-senha-nova-longa')
        await painel.locator('#senha-confirma').fill('uma-senha-nova-longa')
        const botao = painel.getByRole('button', { name: 'Trocar senha' })
        const tentar = async (atual: string) => {
          await painel.locator('#senha-atual').fill(atual)
          const resposta = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/auth/senha')
          await botao.click()
          return (await resposta).status()
        }
        for (let i = 1; i <= 8; i++) {
          expect(await tentar(`errada-${i}-zz`), `tentativa ${i}`).toBe(422)
          await expect(painel.getByRole('alert')).toContainText('A senha atual não confere')
        }
        expect(await tentar('errada-9-zz'), 'a 9ª tentativa').toBe(429)
        await expect(painel.getByRole('alert')).toContainText('Muitas tentativas')
        // o freio é por tentativa, não pela senha: nem a certa passa enquanto ele está armado
        expect(await tentar(SENHA)).toBe(429)
        // e ninguém foi posto pra fora: mesma tela, painel aberto, sessão de pé
        await expect(page).toHaveURL(/\/admin$/)
        await expect(painel).toBeVisible()
        expect((await (await page.request.get('/api/auth/eu')).json()).usuario?.email).toBe(freio.email)
      } finally {
        // as falhas deste e-mail saem na hora — o freio por IP (quando há IP) não fica inchado
        await sql(`DELETE FROM login_attempts WHERE email = $1`, [freio.email])
      }
    })
  })
})

/* ======================================================================= Eventos (/admin) */

test.describe('Eventos (/admin)', () => {
  test.describe('organização sem evento nenhum', () => {
    let org: OrgZZ
    test.beforeAll(async () => { org = await criarOrganizacao('vazia', ['master', 'financeiro', 'operacao']) })
    test.afterAll(async () => { if (org) await apagarOrganizacao(org.id) })

    test('#31 Estado vazio › organização sem evento: "Nenhum evento ainda" e "Criar evento" só pra quem cria', async ({ page, context }) => {
      for (const papel of ['master', 'operacao', 'financeiro'] as Papel[]) {
        await context.clearCookies()
        await logar(context, org.usuarios[papel]!)
        await abrir(page, '/admin')
        const vazio = page.locator('[data-parte="vazio"]')
        await expect(vazio, papel).toContainText('Nenhum evento ainda')
        await expect(vazio, papel).toContainText('Crie o primeiro evento')
        await expect(vazio, papel).not.toContainText('Nenhum evento com este filtro')
        const criar = vazio.getByRole('link', { name: 'Criar evento' })
        if (papel === 'financeiro') {
          await expect(criar, 'financeiro não cria evento: o botão não é desenhado').toHaveCount(0)
          await expect(page.locator('a[href="/admin/evento/novo"]')).toHaveCount(0)
        } else {
          await expect(criar, papel).toBeVisible()
        }
      }
      // o botão leva ao assistente (operação, a última sessão com o botão)
      await context.clearCookies()
      await logar(context, org.usuarios.master!)
      await abrir(page, '/admin')
      await page.locator('[data-parte="vazio"]').getByRole('link', { name: 'Criar evento' }).click()
      await expect(page).toHaveURL(/\/admin\/evento\/novo$/)
      await hidratada(page)
      await expect(page.locator('#nome')).toBeVisible()
    })
  })

  test.describe('lista da organização do seed (só leitura)', () => {
    test.use({ storageState: sessao('master') })

    test('#32 Estado de erro › servidor fora: "Não foi possível carregar os eventos" + Tentar de novo, nunca "nenhum evento"', async ({ page }) => {
      await abrir(page, '/admin/suporte')
      // a lista é pedida pelo navegador na navegação de dentro do painel (o F5 seria SSR, que o
      // servidor faz sozinho): é aí que "a API caiu" aparece pra quem está usando
      await page.route('**/api/admin/eventos', (r) => r.abort('failed'))
      await page.locator('#menu-lateral').hover()
      await page.locator('nav[aria-label="Menu do painel"]').getByRole('link', { name: 'Eventos', exact: true }).click()
      await expect(page).toHaveURL(/\/admin$/)
      await expect(page.getByText('Não foi possível carregar os eventos')).toBeVisible()
      await expect(page.getByText('O servidor não respondeu. Confira a internet e tente de novo.')).toBeVisible()
      const tentar = page.getByRole('button', { name: 'Tentar de novo' })
      await expect(tentar).toBeVisible()
      await expect(page.locator('[data-parte="vazio"]')).toHaveCount(0)
      await expect(page.getByText('Nenhum evento ainda')).toHaveCount(0)
      // o servidor responde 500: continua sendo erro, não "vazio"
      await page.unroute('**/api/admin/eventos')
      await page.route('**/api/admin/eventos', (r) => r.fulfill({
        status: 500, contentType: 'application/json',
        body: JSON.stringify({ statusCode: 500, statusMessage: 'Banco fora do ar (simulado)' }),
      }))
      await tentar.click()
      await expect(page.getByText('Banco fora do ar (simulado)')).toBeVisible()
      await expect(page.getByText('Nenhum evento ainda')).toHaveCount(0)
      // voltou: o mesmo botão traz a lista
      await page.unroute('**/api/admin/eventos')
      await page.getByRole('button', { name: 'Tentar de novo' }).click()
      await expect(page.locator('[data-evento]').first()).toBeVisible()
      await expect(page.getByText('Não foi possível carregar os eventos')).toHaveCount(0)
    })
  })

  test.describe('portaria com UM leitor', () => {
    let org: OrgZZ
    test.beforeAll(async () => { org = await criarOrganizacao('portaria', ['master', 'portaria']) })
    test.afterAll(async () => { if (org) await apagarOrganizacao(org.id) })

    test('#33 403 portaria › um leitor: /admin vai direto pra /admin/evento/<id>/validacao', async ({ page, context }) => {
      const agora = Date.now()
      const ev = await criarEventoSql(org.id, {
        nome: `${org.nome} evento no ar`, inicio: new Date(agora - 3_600_000), fim: new Date(agora + 6 * 3_600_000),
      })
      await logar(context, org.usuarios.portaria!)
      await page.goto('/admin')
      await expect(page).toHaveURL(new RegExp(`/admin/evento/${ev.id}/validacao$`))
      await hidratada(page)
      // o contraste: com DOIS leitores a tela oferece a escolha em vez de decidir sozinha
      const outro = await criarEventoSql(org.id, {
        nome: `${org.nome} segundo evento`, inicio: new Date(agora + 86_400_000), fim: new Date(agora + 90_000_000),
      })
      await abrir(page, '/admin')
      await expect(page).toHaveURL(/\/admin$/)
      await expect(page.getByText('Abrir o leitor de entrada')).toBeVisible()
      await expect(page.locator(`a[href="/admin/evento/${ev.id}/validacao"]`)).toBeVisible()
      await expect(page.locator(`a[href="/admin/evento/${outro.id}/validacao"]`)).toBeVisible()
    })
  })

  test.describe('publicar rascunho da lista', () => {
    let org: OrgZZ
    test.beforeAll(async () => { org = await criarOrganizacao('publicar', ['master']) })
    test.afterAll(async () => { if (org) await apagarOrganizacao(org.id) })

    test('#40 Publicar (rascunho) › duplo clique: um PATCH só', async ({ page, context }) => {
      const api = await logar(context, org.usuarios.master!)
      const ev = await criarEventoApi(api, { nome: `${org.nome} rascunho`, publicar: false })
      await abrir(page, '/admin')
      const cartao = page.locator(`[data-evento="${ev.id}"]`)
      const publicar = cartao.getByRole('button', { name: 'Publicar' })
      await expect(publicar).toBeVisible()
      let patches = 0
      page.on('request', (r) => {
        if (r.method() === 'PATCH' && new URL(r.url()).pathname === `/api/admin/evento/${ev.id}/configuracoes`) patches++
      })
      await page.route(`**/api/admin/evento/${ev.id}/configuracoes`, async (rota) => {
        await new Promise((r) => setTimeout(r, 1200)); await rota.continue()
      })
      await publicar.evaluate((b: HTMLButtonElement) => { b.click(); b.click() })
      const publicando = cartao.getByRole('button', { name: 'Publicando…' })
      await expect(publicando).toBeVisible()
      await expect(publicando).toBeDisabled()
      await expect(cartao.locator('[data-parte="selo"]')).toHaveText('PUBLICADO', { timeout: 20_000 })
      expect(patches, 'o segundo clique mandou outro PATCH').toBe(1)
      const [e] = await sql<{ status: string }>(`SELECT status FROM events WHERE id = $1`, [ev.id])
      expect(e!.status).toBe('ativo')
      await api.dispose()
    })
  })

  test('#43 Botões do topo › por papel: Relatórios pra master e financeiro; Criar evento pra master e operação', async ({ browser }) => {
    const esperado: Record<Papel, { relatorios: boolean; criar: boolean }> = {
      master: { relatorios: true, criar: true },
      financeiro: { relatorios: true, criar: false },
      operacao: { relatorios: false, criar: true },
      portaria: { relatorios: false, criar: false },
    }
    for (const papel of PAPEIS) {
      const ctx = await browser.newContext({ ...OPCOES_DO_CONTEXTO, storageState: sessao(papel) })
      const page = await ctx.newPage()
      try {
        await abrir(page, '/admin')
        // o topo da lista é o bloco do h1 "Eventos" (a lateral também tem "Visão geral": não conta)
        const topo = page.locator('div.py-5', { has: page.locator('h1', { hasText: 'Eventos' }) })
        await expect(topo, papel).toBeVisible()
        await expect(topo.locator('a[href="/admin/relatorios"]', { hasText: 'Relatórios' }), `${papel}: Relatórios`)
          .toHaveCount(esperado[papel].relatorios ? 1 : 0)
        await expect(topo.locator('a[href="/admin/evento/novo"]', { hasText: 'Criar evento' }), `${papel}: Criar evento`)
          .toHaveCount(esperado[papel].criar ? 1 : 0)
        if (papel === 'operacao') {
          // EVT-01: a operação entra no assistente e não trava no passo 1 (sem "organização vinculada")
          await topo.locator('a[href="/admin/evento/novo"]').click()
          await expect(page).toHaveURL(/\/admin\/evento\/novo$/)
          await hidratada(page)
          await expect(page.locator('#nome')).toBeVisible()
          await expect(page.locator('#org')).toHaveCount(0)
          await expect(page.locator('[data-parte="sem-acesso-criar"]')).toHaveCount(0)
        }
        if (papel === 'financeiro') {
          // pela URL, o financeiro ouve a recusa na ENTRADA do assistente, não no fim
          await abrir(page, '/admin/evento/novo')
          await expect(page.locator('[data-parte="sem-acesso-criar"]')).toBeVisible()
          await expect(page.locator('#nome')).toHaveCount(0)
        }
      } finally {
        await ctx.close()
      }
    }
  })
})

/* ============================================ Criar evento (/admin/evento/novo) — parte A */

test.describe('Criar evento — nome, modalidade, endereço, contato e descrição', () => {
  let org: OrgZZ
  test.beforeAll(async () => { org = await criarOrganizacao('assistente-a', ['master']) })
  test.afterAll(async () => { if (org) await apagarOrganizacao(org.id) })

  /** o master da organização no navegador do caso, já dentro do assistente */
  async function noAssistente(page: Page, context: BrowserContext) {
    const api = await logar(context, org.usuarios.master!)
    await abrir(page, '/admin/evento/novo')
    await expect(page.locator('#nome')).toBeVisible()
    return api
  }

  test('#46 Criar evento › Nome vazio / 2 letras: a caixa de erro treme com "pelo menos 3 letras"', async ({ page, context }) => {
    await noAssistente(page, context)
    await page.locator('#cid').fill('Vitória da Conquista')
    await page.locator('#sval').fill('(73) 99999-0000')
    await prosseguir(page).click()
    const caixa = caixaDeErro(page)
    await expect(caixa).toContainText('O nome do evento precisa de pelo menos 3 letras.')
    // "treme" de verdade: a animação existe no CSS gerado (classe inventada não geraria nada)
    expect(await caixa.evaluate((el) => getComputedStyle(el).animationName)).toBe('sacode')
    await caixa.evaluate((el) => { (el as any).__primeira = true })
    await page.locator('#nome').fill('ab')
    await prosseguir(page).click()
    await expect(caixa).toContainText('pelo menos 3 letras')
    // a caixa é RECRIADA a cada tentativa barrada (a `key` muda) — é isso que faz tremer de novo
    await expect.poll(() => caixa.evaluate((el) => !!(el as any).__primeira)).toBe(false)
    expect(await caixa.evaluate((el) => getComputedStyle(el).animationName)).toBe('sacode')
    await expect(page.locator('#nome'), 'continua no passo 1').toBeVisible()
    await page.locator('#nome').fill('  ab  ')
    await prosseguir(page).click()
    await expect(caixa, 'espaço não conta como letra').toContainText('pelo menos 3 letras')
    await page.locator('#nome').fill('abc')
    await prosseguir(page).click()
    await expect(page.getByRole('heading', { name: 'Descrição do evento (Opcional)' })).toBeVisible()
    await expect(caixa).toHaveCount(0)
  })

  test('#47 Criar evento › Nome com 141 caracteres: o servidor recusa com "Nome do evento: aceita no máximo 140 caractere(s)" no topo', async ({ page, context }) => {
    test.setTimeout(240_000)
    await noAssistente(page, context)
    const inicio = `${PREFIXO} ${marcaNova()} `
    const nome = inicio + 'x'.repeat(141 - inicio.length)
    expect(nome.length).toBe(141)
    await preencherAssistente(page, { nome })
    await page.getByRole('button', { name: 'Publicar evento' }).click()
    await expect(caixaDeErro(page)).toContainText('Nome do evento: aceita no máximo 140 caractere(s)')
    await expect(page.getByRole('button', { name: 'Publicar evento' }), 'continua no passo 5 com o botão').toBeEnabled()
    const [n] = await sql<{ n: number }>(`SELECT count(*)::int AS n FROM events WHERE org_id = $1 AND name LIKE $2`, [org.id, `${inicio}%`])
    expect(n!.n, 'nenhum evento gravado').toBe(0)
  })

  test('#48 Criar evento › Nome com emoji, acento e <script>: aceito, endereço sem acento/símbolo e texto no site', async ({ page, context }) => {
    test.setTimeout(240_000)
    const api = await noAssistente(page, context)
    const marca = marcaNova()
    const nome = `${PREFIXO} Festa 🎉 São João <script> ${marca}`
    await preencherAssistente(page, { nome })
    const { id, slug } = await publicarAssistente(page, api)
    expect(slug, 'o endereço sai do nome, sem acento nem símbolo').toBe(`zzvarorg-festa-sao-joao-script-${marca}`)
    const [e] = await sql<{ name: string }>(`SELECT name FROM events WHERE id = $1`, [id])
    expect(e!.name, 'o nome é gravado como foi digitado').toBe(nome)
    let rodou = false
    page.on('dialog', async (d) => { rodou = true; await d.dismiss() })
    await abrir(page, `/e/${slug}`)
    await expect(page.locator('h1')).toHaveText(nome)
    expect(await page.locator('script:not([type="application/json"])', { hasText: 'São João' }).count(),
      'o nome virou elemento <script> na página').toBe(0)
    expect(rodou).toBe(false)
    // e na lista do painel, também texto
    await abrir(page, '/admin')
    await expect(page.locator(`[data-evento="${id}"] h2`)).toHaveText(nome)
  })

  test('#58 Criar evento › Modalidade online: sem link erro, "www.x.com" erro, "https://x.com" aceita', async ({ page, context }) => {
    test.setTimeout(240_000)
    const api = await noAssistente(page, context)
    const nome = `${PREFIXO} online ${marcaNova()}`
    await page.locator('#nome').fill(nome)
    await page.getByLabel('Privado').check()
    await page.getByRole('button', { name: 'Online', exact: true }).click()
    await expect(page.locator('#cid'), 'online não pede endereço').toHaveCount(0)
    await page.locator('#sval').fill('(73) 99999-0000')
    await prosseguir(page).click()
    await expect(caixaDeErro(page)).toContainText('Evento online precisa do link de transmissão.')
    await page.locator('#link').fill('www.x.com')
    await prosseguir(page).click()
    await expect(caixaDeErro(page)).toContainText('Evento online precisa do link de transmissão.')
    await expect(page.locator('#link'), 'continua no passo 1').toBeVisible()
    await page.locator('#link').fill('https://x.com')
    await prosseguir(page).click()
    await preencherDoPasso2(page, {})
    const { id } = await publicarAssistente(page, api)
    const [e] = await sql<{ is_online: boolean; stream_url: string; city: string | null }>(
      `SELECT is_online, stream_url, city FROM events WHERE id = $1`, [id])
    expect(e).toEqual({ is_online: true, stream_url: 'https://x.com', city: null })
  })

  test('#60 Criar evento › Endereço: presencial sem cidade diz "Evento presencial precisa da cidade."', async ({ page, context }) => {
    await noAssistente(page, context)
    await page.locator('#nome').fill(`${PREFIXO} sem cidade`)
    await page.locator('#sval').fill('(73) 99999-0000')
    await page.locator('#rua').fill('Rua do Parque')
    await prosseguir(page).click()
    await expect(caixaDeErro(page)).toContainText('Evento presencial precisa da cidade.')
    await page.locator('#cid').fill('   ')
    await prosseguir(page).click()
    await expect(caixaDeErro(page), 'só espaço não é cidade').toContainText('Evento presencial precisa da cidade.')
    await page.locator('#cid').fill('Ubatã')
    await prosseguir(page).click()
    await expect(page.getByRole('heading', { name: 'Descrição do evento (Opcional)' })).toBeVisible()
  })

  test('#62 Criar evento › Contato de suporte: 4 caracteres barram, 5 passam — e o formato não é conferido', async ({ page, context }) => {
    test.setTimeout(240_000)
    const api = await noAssistente(page, context)
    const nome = `${PREFIXO} contato ${marcaNova()}`
    await page.locator('#nome').fill(nome)
    await page.getByLabel('Privado').check()
    await page.locator('#cid').fill('Vitória da Conquista')
    const tipo = page.locator('#stipo')
    const valor = page.locator('#sval')
    const passo2 = page.getByRole('heading', { name: 'Descrição do evento (Opcional)' })
    for (const t of ['whatsapp', 'telefone', 'email']) {
      await tipo.selectOption(t)
      await valor.fill('1234')
      await prosseguir(page).click()
      await expect(caixaDeErro(page), `${t} com 4 caracteres`).toContainText('Informe um contato de suporte ao cliente.')
      await valor.fill('12345')
      await prosseguir(page).click()
      await expect(passo2, `${t} com 5 caracteres passa`).toBeVisible()
      await page.getByRole('button', { name: 'Voltar' }).click()
      await expect(page.locator('#nome')).toHaveValue(nome)
    }
    // e-mail sem @: o assistente aceita e o servidor grava (anotado pro dono: formato não é conferido)
    await tipo.selectOption('email')
    await expect(valor).toHaveAttribute('placeholder', 'suporte@empresa.com.br')
    await valor.fill('semarroba')
    await prosseguir(page).click()
    await preencherDoPasso2(page, {})
    const { id } = await publicarAssistente(page, api)
    const [e] = await sql<{ support_kind: string; support_value: string }>(
      `SELECT support_kind, support_value FROM events WHERE id = $1`, [id])
    expect(e).toEqual({ support_kind: 'email', support_value: 'semarroba' })
  })

  test('#63 Criar evento › Descrição: vazia passa; 20.001 caracteres dá 400 com o nome do campo', async ({ page, context }) => {
    test.setTimeout(240_000)
    await noAssistente(page, context)
    const nome = `${PREFIXO} descricao ${marcaNova()}`
    await preencherAssistente(page, {
      nome,
      // vazia: o passo 2 deixa passar (a própria helper avança com o campo em branco)
      noPasso2: async (p) => { await expect(p.locator('textarea')).toHaveValue('') },
    })
    // volta ao passo 2 e cola 20.001 caracteres
    for (let i = 0; i < 3; i++) await page.getByRole('button', { name: 'Voltar' }).click()
    await expect(page.getByRole('heading', { name: 'Descrição do evento (Opcional)' })).toBeVisible()
    await page.locator('textarea').fill('a'.repeat(20_001))
    await expect(page.getByText('20001 caracteres')).toBeVisible()
    for (let i = 0; i < 3; i++) await prosseguir(page).click()
    await expect(page.getByRole('heading', { name: 'Datas e horários' })).toBeVisible()
    const resposta = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/admin/evento' && r.request().method() === 'POST')
    await page.getByRole('button', { name: 'Publicar evento' }).click()
    expect((await resposta).status()).toBe(400)
    // o nome do campo é o que a pessoa lê na tela ("Descrição do evento"), como o "Nome do evento" do #47
    await expect(caixaDeErro(page)).toContainText(/Descrição/)
    await expect(caixaDeErro(page)).toContainText(/20\.?000/)
    const [n] = await sql<{ n: number }>(`SELECT count(*)::int AS n FROM events WHERE org_id = $1 AND name = $2`, [org.id, nome])
    expect(n!.n).toBe(0)
  })
})

/* ============================================ Criar evento — parte B (classificação, estrutura) */

test.describe('Criar evento — faixa etária, categoria, imagens, tipos e quantidade', () => {
  let org: OrgZZ
  test.beforeAll(async () => { org = await criarOrganizacao('assistente-b', ['master']) })
  test.afterAll(async () => { if (org) await apagarOrganizacao(org.id) })

  async function noAssistente(page: Page, context: BrowserContext) {
    const api = await logar(context, org.usuarios.master!)
    await abrir(page, '/admin/evento/novo')
    await expect(page.locator('#nome')).toBeVisible()
    return api
  }
  /** a linha "Idade" da página de venda (não existe quando é Livre) */
  const idadeNoSite = (page: Page) => page.locator('dl > div', { has: page.locator('dt', { hasText: 'Idade' }) })

  test('#52 Criar evento › Faixa etária Livre, 10, 12, 14, 16 e 18: a classificação certa no site', async ({ page, context }) => {
    test.setTimeout(600_000)
    const api = await noAssistente(page, context)
    for (const faixa of [0, 10, 12, 14, 16, 18]) {
      if (faixa) await abrir(page, '/admin/evento/novo')
      const nome = `${PREFIXO} faixa ${faixa} ${marcaNova()}`
      await preencherAssistente(page, { nome, faixa })
      const { slug } = await publicarAssistente(page, api)
      const publico = await corpo(await page.request.get(`/api/e/${slug}`))
      expect(publico.evento.classificacao, `faixa ${faixa} gravada`).toBe(faixa)
      await abrir(page, `/e/${slug}`)
      await expect(page.locator('h1')).toHaveText(nome)
      if (faixa === 0) await expect(idadeNoSite(page), 'Livre não mostra idade').toHaveCount(0)
      else await expect(idadeNoSite(page).locator('dd'), `faixa ${faixa}`).toHaveText(`${faixa} anos`)
    }
  })

  test('#55 Criar evento › Categoria e subcategorias: chips entram e saem, repetido não duplica, a 11ª o servidor recusa (máx. 10)', async ({ page, context }) => {
    test.setTimeout(300_000)
    const api = await noAssistente(page, context)
    const nome = `${PREFIXO} categoria ${marcaNova()}`
    const sub = page.locator('#sub')
    const chips = page.locator('#sub ~ div span.selo-neutro')
    await preencherAssistente(page, {
      nome,
      noPasso1: async (p) => {
        await expect(sub, 'sem categoria, a subcategoria fica desligada').toBeDisabled()
        await p.locator('#cat').selectOption('Parque')
        await expect(sub).toBeEnabled()
        await sub.fill('Toboágua')
        await sub.press('Enter')
        await expect(chips).toHaveCount(1)
        await expect(chips.first()).toContainText('Toboágua')
        await expect(sub, 'o campo limpa depois do Enter').toHaveValue('')
        await sub.fill('Toboágua')
        await sub.press('Enter')
        await expect(chips, 'repetido não duplica').toHaveCount(1)
        await chips.first().getByRole('button', { name: '×' }).click()
        await expect(chips, 'o X tira o chip').toHaveCount(0)
        for (let i = 1; i <= 11; i++) { await sub.fill(`Sub ${i}`); await sub.press('Enter') }
        await expect(chips).toHaveCount(11)
      },
    })
    const resposta = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/admin/evento' && r.request().method() === 'POST')
    await page.getByRole('button', { name: 'Publicar evento' }).click()
    expect((await resposta).status(), 'a 11ª subcategoria').toBe(400)
    await expect(caixaDeErro(page)).toContainText('o máximo é 10')
    const [n] = await sql<{ n: number }>(`SELECT count(*)::int AS n FROM events WHERE org_id = $1 AND name = $2`, [org.id, nome])
    expect(n!.n, 'nada gravado com 11').toBe(0)
    // tira uma e publica: 10 cabem
    for (let i = 0; i < 4; i++) await page.getByRole('button', { name: 'Voltar' }).click()
    await chips.last().getByRole('button', { name: '×' }).click()
    await expect(chips).toHaveCount(10)
    for (let i = 0; i < 4; i++) await prosseguir(page).click()
    const { id } = await publicarAssistente(page, api)
    const [e] = await sql<{ category: string; subcategories: string[] }>(`SELECT category, subcategories FROM events WHERE id = $1`, [id])
    expect(e!.category).toBe('Parque')
    expect(e!.subcategories).toEqual(Array.from({ length: 10 }, (_, i) => `Sub ${i + 1}`))
  })

  test('#57 Criar evento › Miniatura: os casos da capa, com a prévia QUADRADA (1:1)', async ({ page, context }) => {
    await noAssistente(page, context)
    const mini = page.locator('input[type="file"]').nth(1)
    const area = page.getByRole('button', { name: 'Miniatura: escolher imagem' })
    const previa = page.getByAltText('Prévia: Miniatura')
    const quadro = async () => {
      const caixa = (await previa.locator('xpath=..').boundingBox())!
      return caixa.width / caixa.height
    }
    // clique na área → escolher arquivo (horizontal de propósito: a prévia recorta, não estica)
    const escolha = page.waitForEvent('filechooser')
    await area.click()
    await (await escolha).setFiles({ name: 'mini.png', mimeType: 'image/png', buffer: PNG_8x4 })
    await expect(previa).toBeVisible()
    expect(await quadro(), 'prévia da miniatura é quadrada').toBeCloseTo(1, 2)
    expect(await previa.evaluate((i) => getComputedStyle(i).objectFit)).toBe('cover')
    await expect(page.getByText('Sobe ao criar o evento')).toBeVisible()
    // a capa, ao lado, é 16:9 — a diferença é o que a pessoa confere
    await page.locator('input[type="file"]').nth(0).setInputFiles({ name: 'capa.png', mimeType: 'image/png', buffer: PNG_8x4 })
    const capa = page.getByAltText('Prévia: Capa')
    const caixaCapa = (await capa.locator('xpath=..').boundingBox())!
    expect(caixaCapa.width / caixaCapa.height).toBeCloseTo(16 / 9, 1)
    // Trocar: outra foto no lugar
    const srcAntes = await previa.getAttribute('src')
    const troca = page.waitForEvent('filechooser')
    await previa.locator('xpath=..').getByRole('button', { name: 'Trocar' }).click()
    await (await troca).setFiles({ name: 'mini2.png', mimeType: 'image/png', buffer: PNG_8x4 })
    await expect.poll(() => previa.getAttribute('src')).not.toBe(srcAntes)
    expect(await quadro()).toBeCloseTo(1, 2)
    // Remover: volta a área vazia
    await previa.locator('xpath=..').getByRole('button', { name: 'Remover' }).click()
    await expect(previa).toHaveCount(0)
    await expect(area).toBeVisible()
    const caixaVazia = (await area.boundingBox())!
    expect(caixaVazia.width / caixaVazia.height, 'vazia, a área já tem o formato quadrado').toBeCloseTo(1, 1)
    // tipo errado e arquivo grande: recusados na hora, com a frase
    const aviso = area.locator('xpath=../..').getByRole('alert')
    await mini.setInputFiles({ name: 'mini.gif', mimeType: 'image/gif', buffer: Buffer.from('GIF89a') })
    await expect(aviso).toHaveText('Envie uma foto em JPG, PNG ou WEBP.')
    await expect(previa).toHaveCount(0)
    await mini.setInputFiles({ name: 'grande.png', mimeType: 'image/png', buffer: Buffer.alloc(Math.round(8.5 * 1024 * 1024)) })
    await expect(aviso).toHaveText('A foto tem 8,5MB — o máximo é 8MB.')
    await expect(previa).toHaveCount(0)
    // arrastar e soltar
    await area.evaluate(async (el, b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
      const dt = new DataTransfer()
      dt.items.add(new File([bytes], 'arrastada.png', { type: 'image/png' }))
      const zona = el.parentElement!
      zona.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }))
      zona.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
    }, PNG_8x4.toString('base64'))
    await expect(previa).toBeVisible()
    expect(await quadro()).toBeCloseTo(1, 2)
    await expect(aviso).toHaveCount(0)
  })

  test('#66 Criar evento › Tipos de ingresso: nome vazio, nomes iguais, -10% e 150% barram; 12,5% é aceito', async ({ page, context }) => {
    test.setTimeout(300_000)
    const api = await noAssistente(page, context)
    const nome = `${PREFIXO} tipos ${marcaNova()}`
    await preencherAssistente(page, {
      nome,
      noPasso3: async (p) => {
        await p.getByRole('button', { name: 'Adicionar novo tipo' }).click()
        await prosseguir(p).click()
        await expect(caixaDeErro(p)).toContainText('Dê um nome a cada tipo de ingresso (ou remova o que sobrou em branco).')
        await p.getByLabel('Nome do tipo 3').fill('Meia-entrada')
        await prosseguir(p).click()
        await expect(caixaDeErro(p)).toContainText('Dois tipos de ingresso com o mesmo nome: "meia-entrada".')
        await p.getByLabel('Nome do tipo 3').fill('Criança')
        const desconto = p.getByLabel('Desconto do tipo Criança')
        for (const errado of ['-10', '150']) {
          await desconto.fill(errado)
          await prosseguir(p).click()
          await expect(caixaDeErro(p), `desconto ${errado}`).toContainText('O desconto de um tipo tem que ficar entre 0% e 100%.')
        }
        // como a pessoa digita no Brasil: vírgula
        await desconto.fill('')
        await desconto.click()
        await p.keyboard.type('12,5')
        await expect(desconto).toHaveValue('12.5')
      },
      noPasso4: async (p) => {
        // a prévia do preço de cada tipo: 12,5% sobre R$ 10,00
        await expect(p.getByText(/Criança:\s*R\$\s*8,75/)).toBeVisible()
        await expect(p.getByText(/Meia-entrada:\s*R\$\s*5,00/)).toBeVisible()
      },
    })
    const { id } = await publicarAssistente(page, api)
    const tipos = await sql<{ name: string; discount_bps: number }>(
      `SELECT tt.name, tt.discount_bps FROM ticket_types tt JOIN lots l ON l.id = tt.lot_id
         JOIN sectors s ON s.id = l.sector_id WHERE s.event_id = $1 ORDER BY tt.sort_order`, [id])
    expect(tipos).toEqual([
      { name: 'Inteira', discount_bps: 0 }, { name: 'Meia-entrada', discount_bps: 5000 }, { name: 'Criança', discount_bps: 1250 },
    ])
  })

  test('#67 Criar evento › Só Inteira: a Inteira não tem X nem desconto, e o lote vende sem escolha de tipo', async ({ page, context }) => {
    test.setTimeout(300_000)
    const api = await noAssistente(page, context)
    const nome = `${PREFIXO} so inteira ${marcaNova()}`
    await preencherAssistente(page, {
      nome,
      noPasso3: async (p) => {
        await expect(p.getByRole('button', { name: 'A Inteira não pode ser removida' })).toBeDisabled()
        await expect(p.getByLabel('Desconto do tipo Inteira')).toBeDisabled()
        await p.getByRole('button', { name: 'Remover o tipo Meia-entrada' }).click()
        await expect(p.locator('input[aria-label^="Nome do tipo"]')).toHaveCount(1)
      },
      noPasso4: async (p) => {
        await expect(p.getByText(/Meia-entrada:/), 'sem tipo com desconto, sem prévia por tipo').toHaveCount(0)
      },
    })
    const { id, slug } = await publicarAssistente(page, api)
    const [t] = await sql<{ n: number }>(
      `SELECT count(*)::int AS n FROM ticket_types tt JOIN lots l ON l.id = tt.lot_id
         JOIN sectors s ON s.id = l.sector_id WHERE s.event_id = $1`, [id])
    expect(t!.n, 'o lote nasce sem tipos').toBe(0)
    await abrir(page, `/e/${slug}`)
    const mais = page.getByRole('button', { name: /^Adicionar um / })
    await expect(mais).toHaveCount(1)
    await expect(mais).toHaveAccessibleName('Adicionar um 1º lote')
    await expect(page.getByText('Meia-entrada')).toHaveCount(0)
    await expect(page.getByText(/^Inteira$/)).toHaveCount(0)
  })

  test('#69 Criar evento › InfoDica: abre no hover, no Tab e no clique; fecha ao sair', async ({ page, context }) => {
    await noAssistente(page, context)
    // passo 3, onde moram as três dicas
    await page.locator('#nome').fill(`${PREFIXO} infodica`)
    await page.locator('#cid').fill('Vitória da Conquista')
    await page.locator('#sval').fill('(73) 99999-0000')
    await prosseguir(page).click()
    await prosseguir(page).click()
    await expect(page.getByRole('heading', { name: 'Setores, lotes e tipos de ingresso' })).toBeVisible()
    const botao = page.getByRole('button', { name: 'O que é setor?' })
    const dica = botao.locator('xpath=..').getByRole('tooltip')
    await expect(dica).toBeHidden()
    // hover
    await botao.hover()
    await expect(dica).toBeVisible()
    await expect(dica).toContainText('Onde a pessoa fica ou o que ela compra')
    await page.mouse.move(1200, 820)
    await expect(dica).toBeHidden()
    // teclado: Tab até o "i"
    await page.getByRole('heading', { name: 'Setores, lotes e tipos de ingresso' }).click()
    let chegou = false
    for (let i = 0; i < 40 && !chegou; i++) {
      await page.keyboard.press('Tab')
      chegou = await botao.evaluate((b) => document.activeElement === b)
    }
    expect(chegou, 'o Tab alcança o "i"').toBe(true)
    await expect(dica).toBeVisible()
    await page.keyboard.press('Tab')
    await expect(dica, 'o foco saiu: fecha').toBeHidden()
    // clique (o toque do celular) e clique fora
    await botao.click()
    await page.mouse.move(1200, 820)
    await expect(dica, 'aberta pelo clique, fica aberta sem o mouse em cima').toBeVisible()
    await page.mouse.click(1200, 820)
    await expect(dica).toBeHidden()
  })

  test('#74 Criar evento › Quantidade: vazio, 0 e -5 barram na tela; 10,5 e 1.000.001 o servidor recusa (400)', async ({ page, context }) => {
    test.setTimeout(300_000)
    await noAssistente(page, context)
    const nome = `${PREFIXO} quantidade ${marcaNova()}`
    const qtd = page.getByLabel('Quantidade do 1º lote')
    await preencherAssistente(page, {
      nome,
      noPasso4: async (p) => {
        for (const errado of ['', '0', '-5']) {
          await qtd.fill(errado)
          await prosseguir(p).click()
          await expect(caixaDeErro(p), `quantidade "${errado}"`).toContainText('"Geral · 1º lote": a quantidade tem que ser pelo menos 1.')
        }
        await qtd.fill('')
        await qtd.click()
        await p.keyboard.type('10,5')
        await expect(qtd).toHaveValue('10.5')
      },
    })
    const publicarE = async () => {
      const resposta = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/admin/evento' && r.request().method() === 'POST')
      await page.getByRole('button', { name: 'Publicar evento' }).click()
      return (await resposta).status()
    }
    expect(await publicarE(), '10,5').toBe(400)
    await expect(caixaDeErro(page)).toContainText('Quantidade: valor em formato errado')
    await page.getByRole('button', { name: 'Voltar' }).click()
    await qtd.fill('1000001')
    await prosseguir(page).click()
    expect(await publicarE(), '1.000.001').toBe(400)
    // o limite com o milhar escrito (explicarErro, 28/09): "1.000.000", não "1000000"
    await expect(caixaDeErro(page)).toContainText('Quantidade: o máximo é 1.000.000')
    const [n] = await sql<{ n: number }>(`SELECT count(*)::int AS n FROM events WHERE org_id = $1 AND name = $2`, [org.id, nome])
    expect(n!.n).toBe(0)
  })
})

/* ============================================ Criar evento — parte C (site, e-mail, rascunho, falhas) */

test.describe('Criar evento — nomenclatura, término, rascunho, sessão, imagem, Asaas e CEP', () => {
  let org: OrgZZ
  const emailsGravados: string[] = []
  test.beforeAll(async () => { org = await criarOrganizacao('assistente-c', ['master']) })
  test.afterAll(async () => {
    for (const a of emailsGravados) await apagarArquivo(a)
    if (org) await apagarOrganizacao(org.id)
  })

  async function noAssistente(page: Page, context: BrowserContext) {
    const api = await logar(context, org.usuarios.master!)
    await abrir(page, '/admin/evento/novo')
    await expect(page.locator('#nome')).toBeVisible()
    return api
  }

  test('#77 Criar evento › Nomenclatura (Ingressos, Passaportes, Convites, Couverts, Doações): a palavra aparece no site e no e-mail', async ({ page, context }) => {
    test.setTimeout(600_000)
    const api = await noAssistente(page, context)
    for (const [i, palavra] of ['Ingressos', 'Passaportes', 'Convites', 'Couverts', 'Doações'].entries()) {
      if (i) await abrir(page, '/admin/evento/novo')
      const nome = `${PREFIXO} nomenclatura ${palavra} ${marcaNova()}`
      await preencherAssistente(page, {
        nome, substantivo: palavra,
        noPasso4: async (p) => {
          await expect(p.locator('#substantivo option')).toHaveText(['Ingressos', 'Passaportes', 'Convites', 'Couverts', 'Doações'])
          await expect(p.locator('#substantivo')).toHaveValue(palavra)
        },
      })
      const { id, slug } = await publicarAssistente(page, api)
      // no site
      await abrir(page, `/e/${slug}`)
      await expect(page.getByRole('heading', { name: `Escolha seus ${palavra.toLowerCase()}` }), palavra).toBeVisible()
      // no e-mail: uma venda de balcão com o e-mail do comprador (o transporte é o simulado → .eml)
      const ing = await corpo(await api.get(`/api/admin/evento/${id}/ingressos`))
      const lote = ing.setores[0].lotes[0]
      const inteira = lote.tipos.find((t: any) => t.nome === 'Inteira')
      const { turnoId } = await abrirBalcao(api, id)
      const email = `zzvarorg.email.${marcaNova()}@teste.invalido`
      await venderNoBalcao(api, id, turnoId, [{ lotId: lote.id, ticketTypeId: inteira.id, quantidade: 1 }], 'debito',
        { comprador: { nome: `${PREFIXO} Comprador`, email } })
      const eml = await esperarEmail(email)
      emailsGravados.push(eml.arquivo)
      expect(eml.assunto, `assunto (${palavra})`).toContain(`${palavra} confirmados — ${nome}`)
      expect(eml.texto, `botão do e-mail (${palavra})`).toContain(`Ver ${palavra.toLowerCase()} no celular`)
    }
  })

  test('#82 Criar evento › "Não mostrar término" marcado: o site esconde o fim', async ({ page, context }) => {
    test.setTimeout(300_000)
    const api = await noAssistente(page, context)
    const quando = (p: Page) => p.locator('dl > div', { has: p.locator('dt', { hasText: 'Quando' }) }).locator('dd')
    const escondido = await (async () => {
      await preencherAssistente(page, { nome: `${PREFIXO} sem termino ${marcaNova()}`, esconderFim: true })
      return publicarAssistente(page, api)
    })()
    await abrir(page, '/admin/evento/novo')
    const normal = await (async () => {
      await preencherAssistente(page, { nome: `${PREFIXO} com termino ${marcaNova()}` })
      return publicarAssistente(page, api)
    })()
    await abrir(page, `/e/${normal.slug}`)
    await expect(quando(page), 'sem marcar, o site diz até quando').toContainText('até')
    await abrir(page, `/e/${escondido.slug}`)
    await expect(quando(page)).toBeVisible()
    await expect(quando(page), 'marcado, o fim some').not.toContainText('até')
    expect((await corpo(await page.request.get(`/api/e/${escondido.slug}`))).evento.fim, 'a rota pública nem manda o fim').toBeNull()
    const [e] = await sql<{ hide_end_date: boolean }>(`SELECT hide_end_date FROM events WHERE id = $1`, [escondido.id])
    expect(e!.hide_end_date).toBe(true)
  })

  test('#87 Criar evento › Voltar do navegador no passo 3: sai do assistente, e reabrir retoma o rascunho', async ({ page, context }) => {
    await logar(context, org.usuarios.master!)
    await abrir(page, '/admin')
    const nome = `${PREFIXO} voltar ${marcaNova()}`
    await page.locator('a[href="/admin/evento/novo"]').first().click()
    await expect(page).toHaveURL(/\/admin\/evento\/novo$/)
    await page.locator('#nome').fill(nome)
    await page.locator('#cid').fill('Vitória da Conquista')
    await page.locator('#sval').fill('(73) 99999-0000')
    await prosseguir(page).click()
    await page.locator('textarea').fill('Descrição que precisa voltar.')
    await prosseguir(page).click()
    await expect(page.getByRole('heading', { name: 'Setores, lotes e tipos de ingresso' })).toBeVisible()
    await expect(page.getByText(/Salvo automaticamente em/)).toBeVisible()
    await page.goBack()
    await expect(page, 'o Voltar sai do assistente (não volta um passo)').toHaveURL(/\/admin$/)
    await expect(page.locator('h1')).toHaveText('Eventos')
    await page.locator('a[href="/admin/evento/novo"]').first().click()
    await expect(page).toHaveURL(/\/admin\/evento\/novo$/)
    await expect(page.getByRole('heading', { name: 'Setores, lotes e tipos de ingresso' }), 'retoma no passo 3').toBeVisible()
    await expect(passoAtual(page)).toContainText('Setores, lotes e tipos')
    await page.getByRole('button', { name: 'Voltar' }).click()
    await expect(page.locator('textarea')).toHaveValue('Descrição que precisa voltar.')
    await page.getByRole('button', { name: 'Voltar' }).click()
    await expect(page.locator('#nome')).toHaveValue(nome)
    // e o F5 também retoma (o rascunho grava 400 ms depois da última mudança: espera ele ter o passo 1)
    await expect.poll(() => page.evaluate(() => {
      const k = Object.keys(localStorage).find((x) => x.startsWith('dt:criar-evento:v2:'))
      return k ? JSON.parse(localStorage.getItem(k)!).passo : null
    })).toBe(1)
    await page.reload()
    await hidratada(page)
    await expect(page.locator('#nome')).toHaveValue(nome)
  })

  test('#90 Criar evento › Publicar com a sessão expirada: erro no topo e o rascunho fica', async ({ page, context }) => {
    test.setTimeout(240_000)
    await noAssistente(page, context)
    const nome = `${PREFIXO} sessao ${marcaNova()}`
    await preencherAssistente(page, { nome })
    await expect(page.getByText(/Salvo automaticamente em/)).toBeVisible()
    await context.clearCookies({ name: 'dt_sessao' })
    const resposta = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/admin/evento' && r.request().method() === 'POST')
    await page.getByRole('button', { name: 'Publicar evento' }).click()
    expect((await resposta).status()).toBe(401)
    await expect(caixaDeErro(page)).toContainText('Faça login para continuar')
    await expect(page.getByRole('heading', { name: 'Datas e horários' }), 'continua no passo 5').toBeVisible()
    await expect(page.getByRole('button', { name: 'Publicar evento' })).toBeEnabled()
    const rascunho = await page.evaluate(() => {
      const k = Object.keys(localStorage).find((x) => x.startsWith('dt:criar-evento:v2:'))
      return k ? JSON.parse(localStorage.getItem(k)!) : null
    })
    expect(rascunho?.f?.nome, 'o rascunho guardou o nome').toBe(nome)
    expect(rascunho?.passo).toBe(5)
    const [n] = await sql<{ n: number }>(`SELECT count(*)::int AS n FROM events WHERE org_id = $1 AND name = $2`, [org.id, nome])
    expect(n!.n, 'nada foi criado').toBe(0)
    // entra de novo e reabre: está tudo lá, no passo 5
    await logar(context, org.usuarios.master!)
    await abrir(page, '/admin/evento/novo')
    await expect(page.getByRole('heading', { name: 'Datas e horários' })).toBeVisible()
    for (let i = 0; i < 4; i++) await page.getByRole('button', { name: 'Voltar' }).click()
    await expect(page.locator('#nome')).toHaveValue(nome)
  })

  test('#91 Criar evento › Publicar com o envio da capa falhando: ✓ com o aviso "Não consegui enviar a capa"', async ({ page, context }) => {
    test.setTimeout(240_000)
    const api = await noAssistente(page, context)
    let tentativas = 0
    // o envio de imagem nunca sai do navegador (e nunca chega ao armazenamento)
    await page.route('**/api/admin/evento/*/imagem', (r) => { tentativas++; return r.abort('failed') })
    const nome = `${PREFIXO} capa ${marcaNova()}`
    await preencherAssistente(page, {
      nome,
      noPasso1: async (p) => {
        await p.locator('input[type="file"]').nth(0).setInputFiles({ name: 'capa.png', mimeType: 'image/png', buffer: PNG_8x4 })
        await expect(p.getByAltText('Prévia: Capa')).toBeVisible()
      },
    })
    await page.getByRole('button', { name: 'Publicar evento' }).click()
    await expect(page.getByText('Evento publicado!')).toBeVisible({ timeout: 60_000 })
    await expect(page.getByText('Não consegui enviar a capa. Envie de novo em Configurações do evento.')).toBeVisible()
    await expect(page).toHaveURL(/\/admin\/evento\/[0-9a-f-]{36}\/ingressos/, { timeout: 60_000 })
    expect(tentativas).toBe(1)
    const [e] = await sql<{ banner_url: string | null; status: string }>(
      `SELECT banner_url, status FROM events WHERE org_id = $1 AND name = $2`, [org.id, nome])
    expect(e, 'o evento existe, publicado, sem capa').toEqual({ banner_url: null, status: 'ativo' })
    await api.dispose()
  })

  test('#92 Criar evento › Asaas em testes / sem chave: o evento vai ao ar e o comprador vê o checkout de teste', async ({ page, context, browser }) => {
    test.setTimeout(300_000)
    const api = await noAssistente(page, context)
    const [o] = await sql<{ asaas_api_key: string | null; asaas_env: string }>(
      `SELECT asaas_api_key, asaas_env FROM organizations WHERE id = $1`, [org.id])
    expect(o, 'a organização está sem chave e em testes').toEqual({ asaas_api_key: null, asaas_env: 'sandbox' })
    const nome = `${PREFIXO} sem chave ${marcaNova()}`
    await preencherAssistente(page, { nome })
    const { id, slug } = await publicarAssistente(page, api)
    const [e] = await sql<{ status: string }>(`SELECT status FROM events WHERE id = $1`, [id])
    expect(e!.status, 'evento no ar').toBe('ativo')
    await abrir(page, '/admin/configuracoes')
    await expect(page.locator('[data-parte="selo-ambiente"]')).toHaveText('TESTES')
    // o comprador (sem login, outro navegador)
    const comprador = await browser.newContext({ ...OPCOES_DO_CONTEXTO })
    const p = await comprador.newPage()
    try {
      await abrir(p, `/e/${slug}`)
      await expect(p.getByText('Venda online indisponível agora'), 'nesta máquina o pagamento é simulado: vende').toHaveCount(0)
      await p.getByRole('button', { name: 'Adicionar um Inteira' }).click()
      await p.getByRole('button', { name: /^(Ir para pagamento|Pagar)$/ }).filter({ visible: true }).first().click()
      await expect(p).toHaveURL(new RegExp(`/e/${slug}/pagamento`))
      await hidratada(p)
      // quem compra é a conta (034) — da organização DESTE evento
      const conta = await p.request.post('/api/conta/criar', { headers: { origin: BASE }, data: {
        nome: `${PREFIXO} Comprador`, email: `zzvarorg.checkout.${marcaNova()}@teste.invalido`,
        cpf: cpfDeTeste(), telefone: '73998260963', senha: 'senha-do-e2e-2026', evento: slug } })
      expect(conta.status(), await conta.text()).toBe(200)
      await p.reload()
      await hidratada(p)
      await expect(p.locator('[data-parte="seus-dados"]')).toBeVisible()
      await p.locator('[data-parte="avancar"]').click()
      await p.locator('[data-parte="pagar"]').click()
      await expect(p.getByText(/Seus ingressos estão reservados por/)).toBeVisible({ timeout: 30_000 })
      await expect(p.getByText('Ambiente de teste')).toBeVisible()
      await expect(p.getByRole('button', { name: 'Simular pagamento recebido' })).toBeVisible()
      await printar(p, '92-checkout-sem-chave')
    } finally {
      await comprador.close()
    }
  })

  test('#59 Criar evento › CEP: 8 dígitos preenchem rua/bairro/cidade/UF; CEP inexistente não muda nada; ViaCEP fora segue manual sem erro', async ({ page, context }) => {
    await noAssistente(page, context)
    const pedidos: string[] = []
    let modo: 'ok' | 'inexistente' | 'fora' = 'ok'
    // o serviço de fora nunca é chamado daqui: a resposta de cada caso é a do contrato do ViaCEP
    await page.route('https://viacep.com.br/ws/**', async (r) => {
      pedidos.push(r.request().url())
      if (modo === 'fora') return r.abort('failed')
      if (modo === 'inexistente') return r.fulfill({ json: { erro: 'true' } })
      return r.fulfill({ json: {
        cep: '45000-000', logradouro: 'Praça Barão do Rio Branco', complemento: '', bairro: 'Centro',
        localidade: 'Vitória da Conquista', uf: 'BA', ibge: '2933307',
      } })
    })
    const cep = page.locator('#cep')
    const campos = { rua: page.locator('#rua'), bai: page.locator('#bai'), cid: page.locator('#cid'), uf: page.locator('#uf') }
    // menos de 8 dígitos: nem pergunta
    await cep.fill('4500-00')
    await cep.blur()
    expect(pedidos).toHaveLength(0)
    await cep.fill('45000-000')
    await cep.blur()
    await expect(campos.rua).toHaveValue('Praça Barão do Rio Branco')
    await expect(campos.bai).toHaveValue('Centro')
    await expect(campos.cid).toHaveValue('Vitória da Conquista')
    await expect(campos.uf).toHaveValue('BA')
    expect(pedidos.at(-1)).toContain('/ws/45000000/json/')
    // CEP que não existe: o que estava fica
    modo = 'inexistente'
    await campos.rua.fill('Rua digitada')
    await cep.fill('99999-999')
    await cep.blur()
    await expect.poll(() => pedidos.length).toBe(2)
    await expect(page.getByText('Buscando CEP…')).toHaveCount(0)
    await expect(campos.rua).toHaveValue('Rua digitada')
    await expect(campos.cid).toHaveValue('Vitória da Conquista')
    // ViaCEP fora: nenhuma mensagem de erro, e a pessoa segue digitando
    modo = 'fora'
    await cep.fill('40010-000')
    await cep.blur()
    await expect.poll(() => pedidos.length).toBe(3)
    await expect(page.getByText('Buscando CEP…')).toHaveCount(0)
    await expect(page.locator('[role="alert"]')).toHaveCount(0)
    await campos.cid.fill('Ubatã')
    await page.locator('#nome').fill(`${PREFIXO} cep`)
    await page.locator('#sval').fill('(73) 99999-0000')
    await prosseguir(page).click()
    await expect(page.getByRole('heading', { name: 'Descrição do evento (Opcional)' })).toBeVisible()
  })
})

/* ======================================================================= Clientes */

test.describe('Clientes — exportar', () => {
  let org: OrgZZ
  test.beforeAll(async () => {
    org = await criarOrganizacao('clientes', ['master'])
    // 20.001 clientes: um a mais que o teto da exportação; 5 deles de Ubatã (o filtro que resolve)
    await sql(
      `INSERT INTO customers (org_id, name, email, city, state)
       SELECT $1, 'ZZVARORG Cliente ' || g, 'zzvarorg.cliente.' || g || '.' || $2 || '@teste.invalido',
              CASE WHEN g <= 5 THEN 'Ubatã' END, CASE WHEN g <= 5 THEN 'BA' END
         FROM generate_series(1, 20001) g`, [org.id, org.marca])
  })
  test.afterAll(async () => { if (org) await apagarOrganizacao(org.id) })

  const exportados = () => sql<{ n: number }>(
    `SELECT count(*)::int AS n FROM audit_log WHERE org_id = $1 AND entity = 'clientes' AND action = 'exportado'`, [org.id])

  test('#116 Clientes › Exportar com mais de 20.000: 413 com a orientação de filtrar (e o filtro resolve)', async ({ page, context }) => {
    await logar(context, org.usuarios.master!)
    await abrir(page, '/admin/clientes')
    const botao = page.getByRole('button', { name: 'Exportar 20.001 clientes' })
    await expect(botao).toBeEnabled()
    let baixou = false
    page.on('download', () => { baixou = true })
    const resposta = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/admin/clientes/exportar')
    await botao.click()
    expect((await resposta).status()).toBe(413)
    await expect(page.locator('p.faixa-erro')).toHaveText(
      'São mais de 20.000 clientes. Aplique um filtro (cidade, faixa de idade, quem aceita novidades) e exporte de novo.')
    expect(baixou, 'nenhum arquivo sai').toBe(false)
    expect((await exportados())[0]!.n, 'recusada, a exportação não vai pra Auditoria').toBe(0)
    // a orientação funciona: com a cidade, sai a planilha
    await page.locator('[data-parte="filtro-cidade"]').selectOption('BA|Ubatã')
    const filtrado = page.getByRole('button', { name: 'Exportar 5 clientes' })
    await expect(filtrado).toBeEnabled()
    const download = page.waitForEvent('download')
    await filtrado.click()
    const csv = await textoDoDownload(await download)
    expect(csv.trim().split('\r\n')).toHaveLength(6)
    await expect(page.locator('p.faixa-erro')).toHaveCount(0)
    expect((await exportados())[0]!.n).toBe(1)
  })

  test('#117 Clientes › Exportar com a sessão expirada: faixa vermelha "Faça login para continuar"', async ({ page, context }) => {
    await logar(context, org.usuarios.master!)
    await abrir(page, '/admin/clientes')
    const antes = (await exportados())[0]!.n
    await context.clearCookies({ name: 'dt_sessao' })
    const resposta = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/admin/clientes/exportar')
    await page.getByRole('button', { name: /^Exportar / }).click()
    expect((await resposta).status()).toBe(401)
    await expect(page.locator('p.faixa-erro')).toHaveText('Faça login para continuar')
    await expect(page.getByRole('button', { name: /^Exportar / }), 'o botão volta a funcionar').toBeEnabled()
    expect((await exportados())[0]!.n, 'nada registrado').toBe(antes)
  })
})

/* ============================================================ Visão geral (/admin/relatorios) */

test.describe('Visão geral — quem compra', () => {
  let org: OrgZZ
  test.beforeAll(async () => { org = await criarOrganizacao('visao', ['master']) })
  test.afterAll(async () => { if (org) await apagarOrganizacao(org.id) })

  test('#135 Visão geral › Quem compra, recorte só com balcão sem cadastro: as frases de que cidade e idade vêm do site', async ({ page, context }) => {
    const api = await logar(context, org.usuarios.master!)
    const ev = await criarEventoApi(api, { nome: `${org.nome} balcão` })
    const { turnoId } = await abrirBalcao(api, ev.id)
    await venderNoBalcao(api, ev.id, turnoId, [{ lotId: ev.loteId, ticketTypeId: ev.inteira, quantidade: 2 }], 'debito')
    await abrir(page, `/admin/relatorios?periodo=tudo&evento=${ev.id}`)
    const quem = page.locator('section[aria-labelledby="titulo-quem"]')
    await expect(quem).toBeVisible()
    await expect(quem.locator('[data-parte="clientes"]')).toHaveText('0')
    await expect(quem).toContainText('1 venda sem cliente identificado (balcão sem cadastro)')
    await expect(quem).toContainText('Ninguém informou a cidade ainda. Ela vem do formulário de compra do site.')
    await expect(quem).toContainText('Ninguém informou a idade ainda. Ela vem do formulário de compra do site.')
    await expect(quem, 'porcentagem de zero clientes não vira NaN').not.toContainText('NaN')
    await api.dispose()
  })
})

/* ============================================ organização nova: Financeiro vazio e Suporte sem evento */

test.describe('Organização nova (sem evento)', () => {
  let vazia: OrgZZ
  let foco: OrgZZ
  test.beforeAll(async () => {
    vazia = await criarOrganizacao('nova', ['master'])
    foco = await criarOrganizacao('foco', ['master'])
  })
  test.afterAll(async () => {
    if (vazia) await apagarOrganizacao(vazia.id)
    if (foco) await apagarOrganizacao(foco.id)
  })

  test('#160 Financeiro › organização nova: KPIs R$ 0,00, a frase que orienta e a grade sem buraco', async ({ page, context }) => {
    await logar(context, vazia.usuarios.master!)
    await abrir(page, '/admin/financeiro')
    for (const k of ['liquido', 'disponivel', 'retido', 'transferido']) {
      await expect(page.locator(`[data-kpi="${k}"] [data-parte="kpi-valor"]`), k).toHaveText(/^R\$\s0,00$/)
    }
    await expect(page.getByText('Nenhum evento com movimento financeiro ainda.')).toBeVisible()
    await expect(page.getByText('O dinheiro aparece aqui depois da primeira venda paga.', { exact: false })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Ver os eventos' })).toHaveAttribute('href', '/admin')
    await expect(page.getByText('Nenhuma transferência pedida ainda.')).toBeVisible()
    // grade sem buraco: os 4 cartões numa linha que fecha a largura, e "Saques esperando" ocupa a
    // linha inteira quando não há "Como entrou" do lado (nada de coluna vazia)
    const cartoes = await page.locator('[data-kpi="liquido"]').locator('xpath=..').locator('> [data-kpi]')
      .evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON()))
    const grade = await page.locator('[data-kpi="liquido"]').evaluate((e) => e.parentElement!.getBoundingClientRect().toJSON())
    expect(cartoes).toHaveLength(4)
    expect(new Set(cartoes.map((c: any) => Math.round(c.top))).size, 'os 4 cartões na mesma linha').toBe(1)
    expect(Math.abs(cartoes[3].right - grade.right), 'o último cartão fecha a linha').toBeLessThan(1)
    const saques = (await page.locator('[data-parte="saques"]').boundingBox())!
    const linha = await page.locator('[data-parte="saques"]').evaluate((e) => e.parentElement!.getBoundingClientRect().toJSON())
    expect(Math.abs(saques.width - linha.width), '"Saques esperando" ocupa a linha inteira').toBeLessThan(1)
    await expect(page.locator('section[aria-labelledby="titulo-forma"]'), 'sem venda, sem "Como entrou"').toHaveCount(0)
  })

  test('#214 Suporte › evento em foco: o que acontece agora; senão o próximo; senão o primeiro; sem eventos, os botões levam a /admin', async ({ page, context }) => {
    const agora = Date.now()
    const h = 3_600_000
    const d = 24 * h
    const mk = (nome: string, ini: number, fim: number) =>
      criarEventoSql(foco.id, { nome: `${foco.nome} ${nome}`, inicio: new Date(agora + ini), fim: new Date(agora + fim) })
    const passado = await mk('passado', -4 * d, -3 * d)
    const longe = await mk('daqui a 10 dias', 10 * d, 10 * d + 8 * h)
    const perto = await mk('daqui a 2 dias', 2 * d, 2 * d + 8 * h)
    const agoraEv = await mk('acontecendo', -h, 4 * h)
    const emFoco = page.locator('.card', { has: page.getByText('Evento em foco') })
    const vendas = page.getByRole('link', { name: 'Abrir Vendas' })

    await logar(context, foco.usuarios.master!)
    await abrir(page, '/admin/suporte')
    await expect(emFoco).toContainText(`${foco.nome} acontecendo`)
    await expect(vendas).toHaveAttribute('href', `/admin/evento/${agoraEv.id}/vendas`)

    // o que acontecia acabou: vale o PRÓXIMO (o de 2 dias, não o de 10)
    await sql(`UPDATE events SET starts_at = now() - interval '10 days', ends_at = now() - interval '9 days' WHERE id = $1`, [agoraEv.id])
    await abrir(page, '/admin/suporte')
    await expect(emFoco).toContainText(`${foco.nome} daqui a 2 dias`)
    await expect(vendas).toHaveAttribute('href', `/admin/evento/${perto.id}/vendas`)

    // nada acontecendo nem à frente: vale o PRIMEIRO da lista (o de início mais recente)
    await sql(`UPDATE events SET starts_at = now() - interval '20 days', ends_at = now() - interval '19 days' WHERE id = $1`, [longe.id])
    await sql(`UPDATE events SET starts_at = now() - interval '30 days', ends_at = now() - interval '29 days' WHERE id = $1`, [perto.id])
    await abrir(page, '/admin/suporte')
    await expect(emFoco).toContainText(`${foco.nome} passado`)
    await expect(vendas).toHaveAttribute('href', `/admin/evento/${passado.id}/vendas`)

    // organização sem evento nenhum: sem cartão de foco, e os atalhos do evento levam a /admin
    await context.clearCookies()
    await logar(context, vazia.usuarios.master!)
    await abrir(page, '/admin/suporte')
    await expect(page.locator('h1')).toHaveText('Suporte')
    await expect(page.getByText('Evento em foco')).toHaveCount(0)
    for (const nome of ['Abrir Vendas', 'Ver histórico de leituras', 'Abrir Participantes', 'Emitir cortesia']) {
      await expect(page.getByRole('link', { name: nome }), nome).toHaveAttribute('href', '/admin')
    }
    await expect(page.getByRole('link', { name: 'Abrir Financeiro' })).toHaveAttribute('href', '/admin/financeiro')
    await page.getByRole('link', { name: 'Abrir Vendas' }).click()
    await expect(page).toHaveURL(/\/admin$/)
    await expect(page.locator('[data-parte="vazio"]')).toContainText('Nenhum evento ainda')
  })
})

/* ======================================================================= Configurações */

test.describe('Configurações — salvar e chave do Asaas', () => {
  let org: OrgZZ
  test.beforeAll(async () => { org = await criarOrganizacao('config', ['master']) })
  test.afterAll(async () => { if (org) await apagarOrganizacao(org.id) })

  /** chave de mentira no formato das de TESTE do Asaas ($aact_hmlg_…): só é gravada, nunca usada */
  const chaveFalsa = () => `$aact_hmlg_ZZVARORG${marcaNova()}${'0'.repeat(32)}${marcaNova()}`
  const campoChave = (page: Page) => page.locator('[data-parte="campo-chave"]')
  const chaveConfigurada = (page: Page) => page.getByText(/configurada · termina em/)

  test('#167 Configurações › Salvar com duplo clique: um PATCH só', async ({ page, context }) => {
    await logar(context, org.usuarios.master!)
    await abrir(page, '/admin/configuracoes')
    const novo = `${org.nome} novo`
    await page.locator('#cfg-nome').fill(novo)
    let patches = 0
    page.on('request', (r) => { if (r.method() === 'PATCH' && new URL(r.url()).pathname === '/api/admin/organizacao') patches++ })
    await page.route('**/api/admin/organizacao', async (rota) => {
      if (rota.request().method() === 'PATCH') await new Promise((r) => setTimeout(r, 1200))
      await rota.continue()
    })
    const salvar = page.locator('[data-acao="salvar"]')
    await salvar.evaluate((b: HTMLButtonElement) => { b.click(); b.click() })
    await expect(salvar).toHaveText('Salvando…')
    await expect(salvar).toBeDisabled()
    await expect(page.getByRole('status').filter({ hasText: 'Salvo.' })).toBeVisible({ timeout: 20_000 })
    expect(patches, 'o segundo clique mandou outro PATCH').toBe(1)
    const [o] = await sql<{ name: string }>(`SELECT name FROM organizations WHERE id = $1`, [org.id])
    expect(o!.name).toBe(novo)
    const [a] = await sql<{ n: number }>(`SELECT count(*)::int AS n FROM audit_log WHERE org_id = $1 AND entity = 'organizacao'`, [org.id])
    expect(a!.n, 'uma alteração registrada').toBe(1)
  })

  test('#173 Configurações › Chave de API: trocar mostra o fim novo; "Cancelar troca" volta ao que era', async ({ page, context }) => {
    await logar(context, org.usuarios.master!)
    await abrir(page, '/admin/configuracoes')
    // sem chave: o campo já vem aberto (a primeira chave)
    const primeira = chaveFalsa()
    await campoChave(page).fill(primeira)
    await page.locator('[data-acao="salvar"]').click()
    await expect(chaveConfigurada(page)).toContainText(`termina em ${primeira.slice(-6)}`)
    // Trocar → colar → salvar
    const segunda = chaveFalsa()
    await page.getByRole('button', { name: 'Trocar', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Cancelar troca' })).toBeVisible()
    await campoChave(page).fill(segunda)
    await page.locator('[data-acao="salvar"]').click()
    await expect(chaveConfigurada(page)).toContainText(`termina em ${segunda.slice(-6)}`)
    // Trocar → Cancelar troca: volta, sem mandar nada
    let patches = 0
    page.on('request', (r) => { if (r.method() === 'PATCH' && new URL(r.url()).pathname === '/api/admin/organizacao') patches++ })
    await page.getByRole('button', { name: 'Trocar', exact: true }).click()
    await campoChave(page).fill(chaveFalsa())
    await page.getByRole('button', { name: 'Cancelar troca' }).click()
    await expect(chaveConfigurada(page)).toContainText(`termina em ${segunda.slice(-6)}`)
    await expect(campoChave(page)).toHaveCount(0)
    await expect(page.locator('[data-acao="salvar"]'), 'nada pendente depois de cancelar').toBeDisabled()
    expect(patches).toBe(0)
    const [o] = await sql<{ asaas_api_key: string }>(`SELECT asaas_api_key FROM organizations WHERE id = $1`, [org.id])
    expect(o!.asaas_api_key.endsWith(segunda.slice(-6))).toBe(true)
  })

  test('#174 Configurações › Chave de API, Remover: o 1º clique arma, Cancelar desarma, o 2º remove e volta pra Testes', async ({ page, context }) => {
    const api = await logar(context, org.usuarios.master!)
    await corpo(await api.patch('/api/admin/organizacao', { data: { chaveAsaas: chaveFalsa(), ambienteAsaas: 'sandbox' } }))
    await abrir(page, '/admin/configuracoes')
    await expect(chaveConfigurada(page)).toBeVisible()
    const remover = page.getByRole('button', { name: 'Remover', exact: true })
    await remover.click()
    await expect(page.getByRole('button', { name: 'Confirmar remoção', exact: true }), 'o 1º clique só arma').toBeVisible()
    await page.getByRole('button', { name: 'Cancelar', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Remover', exact: true }), 'Cancelar desarma').toBeVisible()
    await expect(chaveConfigurada(page)).toBeVisible()
    const [antes] = await sql<{ tem: boolean }>(`SELECT asaas_api_key IS NOT NULL AS tem FROM organizations WHERE id = $1`, [org.id])
    expect(antes!.tem, 'armar e desarmar não remove').toBe(true)
    await page.getByRole('button', { name: 'Remover', exact: true }).click()
    await page.getByRole('button', { name: 'Confirmar remoção', exact: true }).click()
    await expect(page.getByRole('status')).toContainText('Chave removida. A organização voltou pro ambiente de testes.')
    await expect(chaveConfigurada(page)).toHaveCount(0)
    await expect(campoChave(page)).toBeVisible()
    await expect(page.locator('[data-parte="selo-ambiente"]')).toHaveText('TESTES')
    const [o] = await sql<{ asaas_api_key: string | null; asaas_env: string }>(
      `SELECT asaas_api_key, asaas_env FROM organizations WHERE id = $1`, [org.id])
    expect(o).toEqual({ asaas_api_key: null, asaas_env: 'sandbox' })
    await api.dispose()
  })
})

/* ======================================================================= Equipe */

test.describe('Equipe — dar acesso, desativar e reativar', () => {
  let org: OrgZZ
  test.beforeAll(async () => { org = await criarOrganizacao('equipe', ['master', 'operacao']) })
  test.afterAll(async () => { if (org) await apagarOrganizacao(org.id) })

  test('#186 Equipe › Dar acesso, senha provisória: aparece uma vez, copia, some no Entendi, e o F5 perde', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE })
    await logar(context, org.usuarios.master!)
    await abrir(page, '/admin/equipe')
    const darAcesso = async (nome: string, email: string) => {
      await page.getByRole('button', { name: 'Dar acesso a alguém' }).click()
      const painel = painelLateral(page)
      await painel.getByPlaceholder('Nome completo').fill(nome)
      await painel.getByPlaceholder('pessoa@empresa.com.br').fill(email)
      await painel.getByRole('button', { name: 'Criar acesso' }).click()
      await expect(page.getByText(`Senha de ${nome} — anote agora`)).toBeVisible()
    }
    const nome = `${PREFIXO} Pessoa Nova`
    const email = `zzvarorg.acesso.${org.marca}@teste.invalido`
    await darAcesso(nome, email)
    const bloco = page.locator('div.entra-bloco')
    const senha = (await bloco.locator('code').innerText()).trim()
    expect(senha.length).toBeGreaterThanOrEqual(8)
    await expect(page.getByText(senha), 'a senha aparece num lugar só').toHaveCount(1)
    await bloco.getByRole('button', { name: 'Copiar' }).click()
    await expect(bloco.getByRole('button', { name: 'Copiado' })).toBeVisible()
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(senha)
    // a senha mostrada é a que entra
    const { api } = await entrarComo(email, senha)
    await api.dispose()
    await bloco.getByRole('button', { name: 'Entendi' }).click()
    await expect(bloco).toHaveCount(0)
    await expect(page.getByText(senha)).toHaveCount(0)
    await expect(page.locator('tr', { hasText: email })).toBeVisible()
    // e a auditoria registra a criação SEM a senha
    const [u] = await sql<{ id: string }>(`SELECT id FROM users WHERE org_id = $1 AND email = $2`, [org.id, email])
    const linhas = await sql<{ t: string }>(`SELECT coalesce(after::text, '') || coalesce(before::text, '') AS t FROM audit_log WHERE entity_id = $1`, [u!.id])
    expect(linhas.length).toBeGreaterThan(0)
    for (const l of linhas) expect(l.t).not.toContain(senha)
    // F5 antes de anotar: a senha some de vez (é o combinado — só dá pra sortear outra)
    const nome2 = `${PREFIXO} Pessoa Esquecida`
    const email2 = `zzvarorg.acesso2.${org.marca}@teste.invalido`
    await darAcesso(nome2, email2)
    const senha2 = (await bloco.locator('code').innerText()).trim()
    await page.reload()
    await hidratada(page)
    await expect(page.locator('tr', { hasText: email2 }), 'o acesso foi criado').toBeVisible()
    await expect(page.getByText(`Senha de ${nome2} — anote agora`)).toHaveCount(0)
    await expect(page.getByText(senha2)).toHaveCount(0)
  })

  test('#191 Equipe › Desativar quem está logado em outro navegador: cai no próximo clique; reativado entra com a senha antiga', async ({ page, context, browser }) => {
    const alvo = org.usuarios.operacao!
    const outro = await browser.newContext({ ...OPCOES_DO_CONTEXTO })
    const b = await outro.newPage()
    try {
      await entrarPeloFormulario(b, alvo.email)
      await expect(b).toHaveURL(/\/admin/, { timeout: 30_000 })
      await hidratada(b)
      await logar(context, org.usuarios.master!)
      await abrir(page, '/admin/equipe')
      const linha = page.locator('tr', { hasText: alvo.email })
      await linha.getByRole('button', { name: 'Desativar' }).click()
      await linha.getByRole('button', { name: 'Confirmar' }).click()
      await expect(linha).toContainText('DESATIVADO')
      // o outro navegador, no próximo clique, cai no login
      await b.locator('header[data-parte="topo"] a[href="/admin/suporte"]').click()
      // (suave: o caso segue pra conferir o resto — desativado no F5, fora do login e a reativação)
      await expect.soft(b, 'desativado cai no próximo clique').toHaveURL(/\/entrar/)
      if (!/\/entrar/.test(b.url())) {
        await b.reload()
        await expect(b, 'no F5 o servidor já não reconhece a sessão').toHaveURL(/\/entrar/)
      }
      // e não entra enquanto estiver desativado
      await entrarPeloFormulario(b, alvo.email)
      await expect(b.getByText('E-mail ou senha não confere')).toBeVisible()
      // reativar: entra com a MESMA senha de antes
      await linha.getByRole('button', { name: 'Reativar' }).click()
      await expect(linha).not.toContainText('DESATIVADO')
      await entrarPeloFormulario(b, alvo.email)
      await expect(b).toHaveURL(/\/admin/, { timeout: 30_000 })
      expect((await (await b.request.get('/api/auth/eu')).json()).usuario?.email).toBe(alvo.email)
    } finally {
      await outro.close()
    }
  })
})

/* ============================================================== Reconciliação e Auditoria */

test.describe('Reconciliação e Auditoria — o corte da lista', () => {
  let recon: OrgZZ
  let aud: OrgZZ
  test.beforeAll(async () => {
    recon = await criarOrganizacao('recon', ['master'])
    const ev = await criarEventoSql(recon.id, {
      nome: `${recon.nome} evento`, inicio: new Date(Date.now() + 5 * 86_400_000), fim: new Date(Date.now() + 5.3 * 86_400_000),
    })
    // 305 pedidos que o gateway diz ter recebido e que aqui expiraram: 305 "webhook perdido"
    await sql(
      `INSERT INTO orders (org_id, event_id, code, status, channel, face_cents, total_cents, asaas_payment_id, payment_method)
       SELECT $1, $2, 'ZZVARORG-' || $3 || '-' || g, 'expirado', 'online', 1000, 1000, 'pay_zzvarorg_' || $3 || '_' || g, 'pix'
         FROM generate_series(1, 305) g`, [recon.id, ev.id, recon.marca])
    await sql(
      `INSERT INTO payment_events (provider, external_id, event_name, payload, processed_at, gateway_event_id, order_id)
       SELECT 'asaas', o.asaas_payment_id, 'PAYMENT_RECEIVED',
              jsonb_build_object('event', 'PAYMENT_RECEIVED', 'payment', jsonb_build_object(
                'id', o.asaas_payment_id, 'status', 'RECEIVED', 'value', 10.00,
                'paymentDate', to_char(now(), 'YYYY-MM-DD'), 'externalReference', o.id::text)),
              now(), 'evt_zzvarorg_' || o.asaas_payment_id, o.id
         FROM orders o WHERE o.org_id = $1`, [recon.id])
    aud = await criarOrganizacao('auditoria', ['master'])
    await sql(
      `INSERT INTO audit_log (org_id, user_id, actor_email, entity, entity_id, action, after, created_at)
       SELECT $1, $2, $3, 'zzvarorg', 'zzvarorg-' || g, 'teste_zzvarorg', jsonb_build_object('n', g),
              now() - make_interval(secs => g)
         FROM generate_series(1, 230) g`, [aud.id, aud.usuarios.master!.id, aud.usuarios.master!.email])
  })
  test.afterAll(async () => {
    if (recon) await apagarOrganizacao(recon.id)
    if (aud) await apagarOrganizacao(aud.id)
  })

  test('#198 Reconciliação › Exportar com mais de 300 divergências: "Exportar 300 de N" e arquivo com PARCIAL no nome', async ({ page, context }) => {
    await logar(context, recon.usuarios.master!)
    await abrir(page, '/admin/reconciliacao')
    const r = await corpo(await page.request.get('/api/admin/reconciliacao'))
    const total = r.totais.webhookPerdido + r.totais.semCobranca + r.totais.valorDiferente + r.totais.cobrancaRepetida
    expect(total, 'as 305 divergências contadas inteiras').toBe(305)
    expect(r.divergencias).toHaveLength(300)
    const botao = page.getByRole('button', { name: 'Exportar 300 de 305' })
    await expect(botao).toBeVisible()
    const download = page.waitForEvent('download')
    await botao.click()
    const d = await download
    expect(d.suggestedFilename()).toBe(`reconciliacao-${r.periodo.de}-a-${r.periodo.ate}-PARCIAL-300-de-305.csv`)
    const linhas = (await textoDoDownload(d)).trim().split('\r\n')
    expect(linhas, 'cabeçalho + 300 linhas').toHaveLength(301)
  })

  test('#206 Auditoria › Exportar com 201+ atos: "Exportar 200 de N"', async ({ page, context }) => {
    await logar(context, aud.usuarios.master!)
    await abrir(page, '/admin/auditoria')
    const r = await corpo(await page.request.get('/api/admin/auditoria'))
    expect(r.truncado).toBe(true)
    expect(r.total).toBe(230)
    const botao = page.getByRole('button', { name: `Exportar 200 de ${r.total}` })
    await expect(botao).toBeVisible()
    await expect(botao).toHaveAttribute('title', `O arquivo leva os 200 atos da lista, não os ${r.total} do período — aperte o período pra levar o resto.`)
    await expect(page.getByText('mostrando os 200 mais recentes — aperte o período pra ver o resto')).toBeVisible()
    const download = page.waitForEvent('download')
    await botao.click()
    const linhas = (await textoDoDownload(await download)).trim().split('\r\n')
    expect(linhas, 'cabeçalho + 200 atos').toHaveLength(201)
  })
})
