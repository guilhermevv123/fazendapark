/**
 * papeis-resumo.test.ts — a descrição de cada papel tem que bater com o que a grade deixa abrir.
 *
 * ADM-65: o resumo da Operação dizia "Não vê o caixa", e a grade dá a ela a área `pdv` — Pontos de
 * venda e a conferência do caixa do turno, com os totais. É o texto que o dono lê na Equipe ao
 * escolher o papel: prometer o que a grade não cumpre é entregar dinheiro achando que não entrega.
 */
import { describe, expect, it } from 'vitest'
import { papelPode, RESUMO } from './papeis'

describe('RESUMO do papel × grade', () => {
  it('a Operação abre a bilheteria com o caixa do turno, e o resumo diz isso', () => {
    expect(papelPode('operacao', 'pdv')).toBe(true)
    expect(RESUMO.operacao).not.toMatch(/não vê o caixa/i)
    expect(RESUMO.operacao).toMatch(/caixa do turno/)
  })

  it('o que a Operação não vê (o dinheiro da produtora) continua dito — e a grade confirma', () => {
    expect(papelPode('operacao', 'dinheiro')).toBe(false)
    expect(RESUMO.operacao).toMatch(/não vê o financeiro/i)
    expect(RESUMO.operacao).toMatch(/não pede transferência/i)
  })
})
