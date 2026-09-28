/**
 * dadosDaEmpresa.test.ts — a conferência do CNPJ/CPF e os formatos do rodapé público.
 *
 * CFG-02: o campo "CNPJ ou CPF" gravava "abc". Agora a tela mascara e a rota recusa o que não
 * passa no dígito verificador. Mutação conferida: `cnpjValido` devolvendo `true` pra qualquer
 * 14 caracteres deixa o caso "dígito errado" vermelho; tirar o ramo alfanumérico deixa o caso do
 * CNPJ novo da Receita vermelho.
 */
import { describe, expect, it } from 'vitest'
import {
  cnpjValido, documentoDaEmpresaValido, formatarCep, formatarDocumento, formatarTelefoneBR,
  linhasDoEndereco, mascaraDocumento,
} from './dadosDaEmpresa'

describe('CNPJ', () => {
  it('aceita o numérico com dígito certo, com ou sem máscara', () => {
    expect(cnpjValido('00.000.000/0001-91')).toBe(true)
    expect(cnpjValido('00000000000191')).toBe(true)
  })

  it('recusa dígito errado, tamanho errado e os repetidos', () => {
    expect(cnpjValido('00.000.000/0001-92')).toBe(false)
    expect(cnpjValido('0000000000019')).toBe(false)
    expect(cnpjValido('11.111.111/1111-11')).toBe(false)
    expect(cnpjValido('abc')).toBe(false)
  })

  it('aceita o CNPJ ALFANUMÉRICO (Receita, julho/2026) — o exemplo oficial 12.ABC.345/01DE-35', () => {
    expect(cnpjValido('12.ABC.345/01DE-35')).toBe(true)
    expect(cnpjValido('12abc34501de35')).toBe(true)
    expect(cnpjValido('12.ABC.345/01DE-36')).toBe(false)
    // letra nos dígitos verificadores não existe
    expect(cnpjValido('12.ABC.345/01DE-3A')).toBe(false)
  })
})

describe('o campo "CNPJ ou CPF"', () => {
  it('CPF válido passa, CPF inventado não', () => {
    expect(documentoDaEmpresaValido('529.982.247-25')).toBe(true)
    expect(documentoDaEmpresaValido('529.982.247-26')).toBe(false)
    expect(documentoDaEmpresaValido('111.111.111-11')).toBe(false)
  })

  it('formata os dois tamanhos e devolve o resto como veio', () => {
    expect(formatarDocumento('00000000000191')).toBe('00.000.000/0001-91')
    expect(formatarDocumento('12abc34501de35')).toBe('12.ABC.345/01DE-35')
    expect(formatarDocumento('52998224725')).toBe('529.982.247-25')
    expect(formatarDocumento(' 123 ')).toBe('123')
  })

  it('a máscara acompanha a digitação: CPF até 11 dígitos, CNPJ depois (e com letra)', () => {
    expect(mascaraDocumento('529')).toBe('529')
    expect(mascaraDocumento('5299822')).toBe('529.982.2')
    expect(mascaraDocumento('52998224725')).toBe('529.982.247-25')
    expect(mascaraDocumento('000000000001')).toBe('00.000.000/0001')
    expect(mascaraDocumento('00000000000191')).toBe('00.000.000/0001-91')
    expect(mascaraDocumento('12ABC34501DE35')).toBe('12.ABC.345/01DE-35')
    expect(mascaraDocumento('00000000000191999')).toBe('00.000.000/0001-91')
  })
})

describe('o que o rodapé público escreve', () => {
  it('CEP e telefone com DDD', () => {
    expect(formatarCep('45000000')).toBe('45000-000')
    expect(formatarTelefoneBR('73998123456')).toBe('(73) 99812-3456')
    expect(formatarTelefoneBR('7332811234')).toBe('(73) 3281-1234')
  })

  it('o endereço pula o que está vazio — o site omite, nunca escreve "a preencher"', () => {
    expect(linhasDoEndereco({ linha: 'Rua Exemplo, 100', bairro: 'Centro', cidade: 'Cidade Teste', uf: 'BA', cep: '45000000' }))
      .toEqual(['Rua Exemplo, 100 — Centro', 'Cidade Teste/BA · CEP 45000-000'])
    expect(linhasDoEndereco({ cidade: 'Cidade Teste', uf: 'BA' })).toEqual(['Cidade Teste/BA'])
    expect(linhasDoEndereco({})).toEqual([])
    expect(linhasDoEndereco(null)).toEqual([])
  })
})
