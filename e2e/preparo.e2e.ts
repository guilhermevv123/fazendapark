/**
 * Preparo — roda antes de todo o resto: confere o endereço (nunca o real, nunca produção) e entra
 * UMA vez com cada um dos quatro papéis pelo formulário, guardando o cookie em e2e/.auth/.
 */
import { expect, test } from '@playwright/test'
import { BASE, EVENTO_SEED, LOGINS, PAPEIS, entrarPeloFormulario, hidratada, sessao, travaDeBase } from './apoio'

test('a base da bateria é a instância de E2E', async ({ request }) => {
  travaDeBase(BASE)
  const r = await request.get('/api/eventos-publicos')
  expect(r.status(), 'o servidor de E2E está no ar? (npm run dev:e2e)').toBe(200)
})

/**
 * O `nuxt dev` compila cada tela no PRIMEIRO acesso (e às vezes reotimiza dependências e recarrega
 * a página). Com a máquina carregada isso passou de um minuto por tela e derrubou casos por tempo,
 * não por defeito (27/09). Uma visita a cada tela grande antes da bateria paga esse custo uma vez.
 */
test('aquece o servidor (compila as telas uma vez)', async ({ page }) => {
  test.setTimeout(900_000)
  for (const caminho of ['/', '/entrar', `/e/${EVENTO_SEED.slug}`, `/e/${EVENTO_SEED.slug}/pagamento`]) {
    await page.goto(caminho, { timeout: 300_000 })
    await hidratada(page, 300_000)
  }
})

for (const papel of PAPEIS) {
  test(`entra como ${papel} e guarda a sessão`, async ({ page }) => {
    await entrarPeloFormulario(page, LOGINS[papel])
    // a portaria cai no endereço dela (30/09: /portaria); o resto, no painel
    await expect(page).toHaveURL(papel === 'portaria' ? /\/portaria$/ : /\/admin/, { timeout: 30_000 })
    const eu = await page.request.get('/api/auth/eu')
    const corpo = await eu.json()
    expect(corpo.usuario?.email).toBe(LOGINS[papel])
    await page.context().storageState({ path: sessao(papel) })
  })
}
