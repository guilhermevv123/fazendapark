/**
 * Cartão de crédito (dono, 05/10): bandeira, dígito verificador, agrupamento e conferência. Números
 * de TESTE públicos das bandeiras/gateways (nenhum é cartão de verdade).
 */
import { describe, expect, it } from 'vitest'
import {
  bandeiraDoCartao, conferirCartao, luhnValido, numeroAgrupado, numeroNaFrenteDoCartao,
  soDigitosDoCartao, tamanhoMaximoDoNumero, validadeEmDia,
} from './cartao'

const HOJE = new Date('2026-10-05T12:00:00-03:00')

describe('bandeira pelo começo do número', () => {
  it.each([
    ['4111111111111111', 'visa'],
    ['4444444444444444', 'visa'],          // o "aprova" do sandbox do Asaas
    ['5555555555554444', 'mastercard'],
    ['2221000000000009', 'mastercard'],    // faixa 2-série
    ['5184019740373151', 'mastercard'],    // o "recusa" Master do sandbox do Asaas
    ['378282246310005', 'amex'],
    ['30569309025904', 'diners'],
    ['6011111111111117', 'discover'],
    ['3530111333300000', 'jcb'],
    ['6062825624254001', 'hipercard'],
    ['5067224275805500', 'elo'],
    ['4011784545454545', 'elo'],           // Elo que começa com 4: NÃO é Visa
    ['6363680000457044', 'elo'],
    ['6504870000000000', 'elo'],           // Elo dentro da faixa 65 do Discover
  ])('%s → %s', (n, id) => {
    expect(bandeiraDoCartao(n)?.id).toBe(id)
  })
  it('vazio ou desconhecido: null (não bloqueia — o banco decide)', () => {
    expect(bandeiraDoCartao('')).toBeNull()
    expect(bandeiraDoCartao('9999')).toBeNull()
  })
  it('aceita espaços e traços no meio', () => {
    expect(bandeiraDoCartao('4111 1111-1111 1111')?.id).toBe('visa')
    expect(soDigitosDoCartao('4111 1111 1111 1111 9999 9999')).toHaveLength(19)
  })
})

describe('dígito verificador (Luhn)', () => {
  it('números de teste passam; um dígito trocado não', () => {
    expect(luhnValido('4111111111111111')).toBe(true)
    expect(luhnValido('378282246310005')).toBe(true)
    expect(luhnValido('4111111111111112')).toBe(false)
    expect(luhnValido('1234')).toBe(false)
  })
})

describe('agrupamento e frente do cartão', () => {
  it('4-4-4-4 no Visa, 4-6-5 no Amex, 4-6-4 no Diners', () => {
    expect(numeroAgrupado('4111111111111111')).toBe('4111 1111 1111 1111')
    expect(numeroAgrupado('378282246310005')).toBe('3782 822463 10005')
    expect(numeroAgrupado('30569309025904')).toBe('3056 930902 5904')
    expect(numeroAgrupado('41111')).toBe('4111 1')
  })
  it('o campo para no tamanho da bandeira', () => {
    expect(tamanhoMaximoDoNumero('37')).toBe(15)
    expect(tamanhoMaximoDoNumero('5555')).toBe(16)
    expect(tamanhoMaximoDoNumero('')).toBe(19)
  })
  it('a frente mostra só os 4 primeiros e os 4 últimos', () => {
    expect(numeroNaFrenteDoCartao('4111111111111234').join('')).toBe('4111••••••••1234')
    expect(numeroNaFrenteDoCartao('4111').join('')).toBe('4111############')
    expect(numeroNaFrenteDoCartao('378282246310005')).toHaveLength(15)
    // Amex: o último grupo (5) inteiro à vista — nada de ponto colado nele (visto na tela, 05/10)
    expect(numeroNaFrenteDoCartao('378282246310005').join('')).toBe('3782••••••10005')
  })
})

describe('conferência do formulário', () => {
  const bom = { numero: '4111111111111111', titular: 'Maria da Silva', mes: '12', ano: '2027', cvv: '123' }
  it('tudo certo: ok', () => {
    expect(conferirCartao(bom, HOJE)).toMatchObject({ ok: true, numero: null, titular: null, validade: null, cvv: null })
  })
  it('cada campo diz o que está errado, em português', () => {
    expect(conferirCartao({ ...bom, numero: '4111111111111112' }, HOJE).numero).toMatch(/algum dígito está errado/)
    expect(conferirCartao({ ...bom, numero: '411111' }, HOJE).numero).toMatch(/Visa tem 13 ou 16 ou 19 dígitos/)
    expect(conferirCartao({ ...bom, titular: 'Maria' }, HOJE).titular).toMatch(/nome e sobrenome/)
    expect(conferirCartao({ ...bom, mes: '09', ano: '2026' }, HOJE).validade).toBe('Este cartão está vencido.')
    expect(conferirCartao({ ...bom, mes: '', ano: '' }, HOJE).validade).toMatch(/mês e o ano/)
    expect(conferirCartao({ ...bom, cvv: '12' }, HOJE).cvv).toMatch(/3 dígitos/)
  })
  it('Amex pede 4 dígitos de segurança', () => {
    const amex = { ...bom, numero: '378282246310005' }
    expect(conferirCartao({ ...amex, cvv: '123' }, HOJE).cvv).toMatch(/American Express tem 4 dígitos/)
    expect(conferirCartao({ ...amex, cvv: '1234' }, HOJE).ok).toBe(true)
  })
  it('validade: o mês atual ainda vale (até o último dia)', () => {
    expect(validadeEmDia('10', '2026', HOJE)).toBe(true)
    expect(validadeEmDia('09', '2026', HOJE)).toBe(false)
    expect(validadeEmDia('13', '2027', HOJE)).toBe(false)
  })
})
