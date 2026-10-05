/**
 * email-volte-mais.test.ts — o e-mail do pedido com o Volte Mais (042), sem banco:
 *   · o RETORNO leva o cupom do bar (QR embutido, código, "mostre no caixa"), DEPOIS dos ingressos;
 *   · a 1ª visita leva o convite ("todas as próximas visitas");
 *   · pedido comum não leva nada disso.
 */
import { describe, expect, it } from 'vitest'
import { montarConfirmacao, type DadosConfirmacao } from './email'

const base: DadosConfirmacao = {
  pedido: 'PED-TESTE-1', compradorNome: 'Maria', compradorEmail: 'maria@exemplo.com', eventoNome: 'Dia de Parque',
  eventoInicio: '2026-10-10T15:00:00Z', local: 'Conquista Park', totalCents: 1500, linkIngressos: 'https://www.conquistapark.com.br/ingressos/PED-TESTE-1',
  ingressos: [{ id: 't1', codigo: 'ABC123', qrPng: Buffer.from('png') }],
}

describe('e-mail do pedido · Volte Mais', () => {
  it('retorno: o cupom do bar vem depois dos ingressos, com QR, código e o recado do caixa', () => {
    const m = montarConfirmacao({ ...base, cupomConsumacao: {
      codigo: 'K7M2QX', consumacaoPct: 10, dia: '10/10/2026', link: 'https://www.conquistapark.com.br/consumo/tok', qrPng: Buffer.from('qr'),
    } })
    expect(m.html).toContain('Cliente Volte Mais')
    expect(m.html).toContain('10% no bar')
    expect(m.html).toContain('K7M2QX')
    expect(m.html).toContain('cid:cupom-K7M2QX@diamond-tickets')
    expect(m.html.indexOf('K7M2QX')).toBeGreaterThan(m.html.indexOf('ABC123'))
    expect(m.imagens.some((i) => i.nome === 'cupom-K7M2QX.png')).toBe(true)
    expect(m.texto).toContain('CLIENTE VOLTE MAIS — 10% de desconto na consumação em 10/10/2026.')
    expect(m.texto).toContain('https://www.conquistapark.com.br/consumo/tok')
  })
  it('1ª visita: o convite pro retorno', () => {
    const m = montarConfirmacao({ ...base, conviteVolteMais: { nome: 'Volte Mais', descontoPct: 50, consumacaoPct: 10, permanente: true } })
    expect(m.html).toContain('50% de desconto no ingresso')
    expect(m.html).toContain('em todas as próximas visitas')
    expect(m.texto).toContain('Volte Mais: depois desta visita, 50% de desconto no ingresso em todas as próximas visitas e 10% na consumação.')
  })
  it('pedido comum: nada de Volte Mais', () => {
    const m = montarConfirmacao(base)
    expect(m.html).not.toContain('Volte Mais')
    expect(m.texto).not.toContain('Volte Mais')
  })
})
