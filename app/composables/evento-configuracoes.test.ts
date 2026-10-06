// @vitest-environment happy-dom
/**
 * Configurações do evento — a taxa que zerava sozinha (ADM-09) e o botão de cancelar oferecido
 * a quem a rota recusa (ADM-43).
 *
 * O campo da taxa era `type="number"` com `Math.round(Number(valor) * 100)` no `@input`:
 * apagado virava 0 bps e a plataforma parava de cobrar SEM aviso — a guarda "preencha o
 * percentual" nunca disparava; e "2," no meio da digitação zerava o campo debaixo do dedo.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { chamadas, limparTela, montarTela } from './.vitest-setup-dom'

const tela = () => import('../pages/admin/evento/[id]/configuracoes.vue')
const EV = 'ev-config'
const CONFIG = {"id": "ev-config", "organizacao": "Fazenda Park Nova Conquista", "nome": "CONQUISTA PARK 4ª EDIÇÃO", "slug": "conquista-park-4-edicao", "descricao": "Vem aí uma nova experiência no Conquista Park! Atrações, diversão e momentos inesquecíveis para toda a família.", "status": "ativo", "comecaEm": "2026-10-18T23:09:49.574Z", "terminaEm": "2026-10-19T23:09:49.574Z", "vendaAte": "2026-10-19T23:09:49.574Z", "vendaAteMinutos": null, "esconderFim": false, "classificacao": 14, "substantivo": "Ingressos", "fuso": "America/Bahia", "moeda": "BRL", "online": false, "urlTransmissao": null, "local": "Fazenda Park Nova Conquista", "cep": "45550-000", "endereco": "Zona rural, a 2 km da BR-101 (entre Itamari e Gandu)", "numero": "s/n", "bairro": "Zona rural", "cidade": "Ubatã", "uf": "BA", "complemento": null, "lat": null, "lng": null, "banner": null, "thumb": null, "categoria": "Parques, Passeios e Tours", "subcategorias": ["Infantil", "Gastronomia"], "tags": [], "suporteTipo": "telefone", "suporteValor": "(73) 99826-0963", "privado": false, "minutosDeReserva": 20, "agruparPorSetor": true, "giroAutomatico": true, "taxaBps": 1000, "modoTaxaOnline": "repassar", "modoTaxaPdv": "absorver", "maxPorCliente": 20, "criadoEm": "2026-09-27T23:09:49.574Z", "atualizadoEm": "2026-09-27T23:09:49.574Z", "jaVendeu": false, "pedidosPagos": 0, "ingressos": 0}

async function montar(papel = 'master', config: any = CONFIG) {
  return montarTela(await tela(), {
    rota: { params: { id: EV } },
    respostas: {
      [`/api/admin/evento/${EV}/configuracoes`]: config,
      '/api/auth/eu': { usuario: { papel } },
    },
    stubs: { EnvioDeImagem: true, AbasSecao: true, InfoDica: true, ModalLateral: true },
  })
}
const botao = (w: any, texto: string) => w.findAll('button').find((b: any) => b.text().trim() === texto)

afterEach(() => limparTela())

describe('taxa de serviço — percentual em pontos-base, sem float (ADM-09)', () => {
  it('conversões', async () => {
    const { bpsDoPercentual, percentualDosBps } = await tela()
    expect(bpsDoPercentual('2,5')).toBe(250)
    expect(bpsDoPercentual('2.5')).toBe(250)
    expect(bpsDoPercentual('10')).toBe(1000)
    expect(bpsDoPercentual('12,34')).toBe(1234)
    expect(bpsDoPercentual('0')).toBe(0)
    expect(bpsDoPercentual(' 7 % ')).toBe(700)
    expect(bpsDoPercentual(''), 'vazio não é zero').toBe('')
    expect(bpsDoPercentual('2,555')).toBeNull()
    expect(bpsDoPercentual('abc')).toBeNull()
    expect(bpsDoPercentual('-1')).toBeNull()
    expect(percentualDosBps(250)).toBe('2,5')
    expect(percentualDosBps(1000)).toBe('10')
    expect(percentualDosBps(1234)).toBe('12,34')
    expect(percentualDosBps(5)).toBe('0,05')
  })

  it('montada: apagar a taxa e salvar NÃO grava 0% — pede o valor', async () => {
    const w = await montar()
    await w.find('#taxa').setValue('')
    await botao(w, 'Salvar').trigger('click')
    await new Promise((r) => setTimeout(r, 0))
    expect(chamadas.filter((c) => c.opcoes?.method === 'PATCH'), 'gravou a taxa apagada como 0%').toHaveLength(0)
    expect(w.text()).toContain('Preencha o percentual da "Taxa de serviço"')
  })

  it('montada: "2,5" grava 250 bps', async () => {
    const w = await montar()
    await w.find('#taxa').setValue('2,5')
    await botao(w, 'Salvar').trigger('click')
    await new Promise((r) => setTimeout(r, 0))
    const patch = chamadas.find((c) => c.opcoes?.method === 'PATCH')
    expect(patch?.opcoes.body).toEqual({ taxaBps: 250 })
  })

  it('montada: formato torto avisa e não salva', async () => {
    const w = await montar()
    await w.find('#taxa').setValue('2,555')
    expect(w.find('[data-parte="taxa-invalida"]').exists()).toBe(true)
    await botao(w, 'Salvar').trigger('click')
    await new Promise((r) => setTimeout(r, 0))
    expect(chamadas.filter((c) => c.opcoes?.method === 'PATCH')).toHaveLength(0)
  })
})

describe('cancelar o evento — só pra quem a rota deixa (ADM-43)', () => {
  it('régua: master e financeiro sim; operação e portaria não', async () => {
    const { podeCancelarEvento } = await tela()
    expect(podeCancelarEvento('master', EV)).toBe(true)
    expect(podeCancelarEvento('financeiro', EV)).toBe(true)
    expect(podeCancelarEvento('operacao', EV)).toBe(false)
    expect(podeCancelarEvento('portaria', EV)).toBe(false)
    expect(podeCancelarEvento(undefined, EV)).toBe(false)
  })

  it('montada como Operação: sem o botão vermelho, com o recado de quem pode', async () => {
    const w = await montar('operacao')
    expect(w.text()).not.toContain('Cancelar evento e devolver')
    expect(w.find('[data-parte="cancelar-sem-acesso"]').exists()).toBe(true)
    expect(w.text(), 'adiar é da Operação e sumiu junto').toContain('Adiar evento')
  })

  it('montada como master: o botão continua', async () => {
    const w = await montar('master')
    expect(w.text()).toContain('Cancelar evento e devolver')
  })
})

// 05/10 (dono): "categorias já predefinidas, sem ficar em aberto"; "endereço é fixo, o do Fazenda Park"
describe('categoria pronta e endereço fixo', () => {
  it('evento antigo com outro endereço: o próximo Salvar grava o do parque', async () => {
    const w = await montar('master', { ...CONFIG, cep: null, endereco: 'Rua Velha, 10', bairro: 'Centro', cidade: 'Gandu' })
    expect(w.find('[data-parte="local-fixo"]').text()).toContain('Fazenda Park Nova Conquista')
    expect(w.find('[data-parte="local-fixo"] input').exists(), 'sobrou campo pra digitar endereço').toBe(false)
    await botao(w, 'Salvar').trigger('click')
    await new Promise((r) => setTimeout(r, 0))
    const corpo = chamadas.find((c) => c.opcoes?.method === 'PATCH')?.opcoes.body
    expect(corpo).toMatchObject({ cep: '45550-000', cidade: 'Ubatã', bairro: 'Zona rural' })
  })

  it('categoria é lista; subcategoria é escolha da lista dela e vai no Salvar', async () => {
    const w = await montar('master', { ...CONFIG, categoria: 'Show', subcategorias: [] })
    const opcoes = w.findAll('#cat-conf option').map((o: any) => o.text())
    expect(opcoes).toContain('Parque aquático')
    const forro = w.findAll('[data-parte="subcategorias"] button').find((b: any) => b.text() === 'Forró')
    expect(forro, 'Show não ofereceu Forró').toBeTruthy()
    await forro.trigger('click')
    await botao(w, 'Salvar').trigger('click')
    await new Promise((r) => setTimeout(r, 0))
    const corpo = chamadas.find((c) => c.opcoes?.method === 'PATCH')?.opcoes.body
    expect(corpo.subcategorias).toEqual(['Forró'])
  })
})
