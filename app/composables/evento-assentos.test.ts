// @vitest-environment happy-dom
/**
 * Mapa de assentos marcado "em preparação" (ADM-42, 27/09).
 *
 * A tela saiu do menu (22/09) porque o checkout, a vitrine, o balcão e a emissão ignoram `seats`,
 * mas continua abrindo pelo endereço — e dizia "Setor numerado vende lugar, não quantidade".
 * Bloquear um lugar não mexe no estoque e o mapa nunca mostra vendido: quem chega aqui precisa
 * saber disso antes de planejar a casa em cima do mapa.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { limparTela, montarTela } from './.vitest-setup-dom'

const EV = 'ev-assentos'

const SETOR = (campos: Record<string, any> = {}) => ({
  id: 's1', nome: 'Arquibancada', numerado: true, total: 2, livres: 2, vendidosNoMapa: 0,
  reservados: 0, bloqueados: 0, estoque: 2, vendidos: 0,
  fileiras: [{ nome: 'A', lugares: [
    { id: 'a1', numero: 1, rotulo: 'A1', status: 'livre' },
    { id: 'a2', numero: 2, rotulo: 'A2', status: 'livre' },
  ] }],
  ...campos,
})

async function abrir(setores: any[]) {
  return montarTela(await import('../pages/admin/evento/[id]/assentos.vue'), {
    rota: { params: { id: EV } },
    respostas: { [`/api/admin/evento/${EV}/assentos`]: { setores } },
    stubs: { ModalLateral: true, CampoMoeda: true },
  })
}

afterEach(() => limparTela())

describe('mapa de assentos: diz que a venda ainda não usa o mapa (ADM-42)', () => {
  it('com mapa: o aviso "em preparação" diz o que o mapa NÃO faz', async () => {
    const w = await abrir([SETOR()])
    const aviso = w.find('[data-parte="em-preparacao"]')
    expect(aviso.exists(), 'a tela aberta pelo endereço não avisa que a venda ignora o mapa').toBe(true)
    const texto = aviso.text()
    expect(texto).toContain('Em preparação')
    expect(texto).toContain('não escolhe lugar')
    expect(texto).toContain('não tira nada do estoque')
    expect(texto).toContain('não mostra o que foi vendido')
  })

  it('a tela não promete mais que "setor numerado vende lugar"', async () => {
    const w = await abrir([SETOR(), SETOR({ id: 's2', nome: 'Pista', numerado: false, total: 0, estoque: 50, vendidos: 3 })])
    expect(w.text()).not.toContain('vende lugar')
    // o setor sem mapa não promete "dizer a alguém onde sentar"
    await w.findAll('aside button').find((b) => b.text().includes('Pista'))!.trigger('click')
    expect(w.text()).not.toContain('onde sentar')
    expect(w.text()).toContain('a venda continua por quantidade')
  })
})
