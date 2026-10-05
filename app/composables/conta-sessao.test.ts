// @vitest-environment happy-dom
/**
 * "Minha conta" com a sessão caída (05/10): o dono saiu numa aba e a outra seguiu dizendo
 * "Olá, Guilherme", com "Confira a internet" e "Entre na sua conta" soltos em vermelho. 401 é
 * "fora da conta" — a tela tem que dizer isso e oferecer o entrar, não culpar a internet.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { montarTela } from './.vitest-setup-dom'

const CONTA = { id: 'c1', nome: 'Guilherme', email: 'g@exemplo.com', emailConfirmado: false, telefone: '', cpf: '',
  instagram: null, endereco: null, aceitaNovidades: false }
const caiu = Object.assign(new Error('401'), { statusCode: 401, data: { statusMessage: 'Entre na sua conta.' } })

const montadas: any[] = []
afterEach(() => { while (montadas.length) montadas.pop().unmount(); document.body.innerHTML = ''; vi.unstubAllGlobals() })

async function abrirConta(ingressos: any, fidelidade: any = { ligado: false }) {
  const t = await montarTela((await import('../pages/conta/index.vue')).default, {
    rota: { path: '/conta', query: {} },
    respostas: {
      '/api/conta/eu': { conta: CONTA, exigeConta: false, social: {} },
      '/api/conta/ingressos': ingressos,
      '/api/conta/fidelidade': fidelidade,
      '/api/conta/email/reenviar': caiu,
    },
    stubs: { JanelaDaConta: true, CurrencyInputBR: true },
  })
  montadas.push(t)
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
  await t.vm.$nextTick()
  return t
}

describe('/conta com a sessão caída', () => {
  it('401 nos ingressos: some o "Olá" e o erro de internet', async () => {
    // controle: com a sessão de pé, a caixa da conta aparece (o teste abaixo não passa à toa)
    expect((await abrirConta({ pedidos: [] })).find('[data-parte="confirmar-email"]').exists()).toBe(true)
    const t = await abrirConta(caiu)
    expect(t.text()).not.toContain('Confira a internet')
    expect(t.find('[data-parte="confirmar-email"]').exists()).toBe(false)
  })

  it('a caixa de confirmação não diz que já mandou um link que nunca saiu', async () => {
    const t = await abrirConta({ pedidos: [] })
    const caixa = t.find('[data-parte="confirmar-email"]')
    expect(caixa.exists()).toBe(true)
    expect(caixa.text()).not.toContain('Mandamos')
    expect(caixa.find('[data-parte="reenviar-confirmacao"]').text()).toBe('Mandar o link de confirmação')
  })
})
