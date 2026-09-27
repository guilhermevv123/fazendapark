/**
 * asaas-ambiente.test.ts — o selo e a trava de troca leem o MESMO prefixo que escolhe o gateway.
 *
 * O defeito (auditoria ORG-01, P0): a tela mostrava `asaas_env` (o `<select>`) e o gateway usava o
 * prefixo da chave. Com chave de sandbox e o select em Produção, a tela dizia PRODUÇÃO e o PIX saía
 * de sandbox; com chave de produção e o select em Testes, "ninguém é cobrado" cobrava de verdade.
 *
 * Mutação conferida: `ambienteEfetivo` devolvendo só `configurado` deixa o primeiro bloco vermelho;
 * `recusaDeAmbiente` sem o ramo da chave gravada deixa o segundo vermelho.
 */
import { describe, expect, it } from 'vitest'
import { ambienteDaChave } from './asaas'
import { ambienteDivergente, ambienteEfetivo, recusaDeAmbiente } from './asaas-ambiente'

// chaves de mentira, só no formato — nenhuma delas fala com o Asaas
const PROD = '$aact_prod_000000000000000000000000TESTE'
const HMLG = '$aact_hmlg_000000000000000000000000TESTE'
const SEM_PREFIXO = '$aact_YTU5YTE0M2M2N2I4MTliNzk0YTI5NzJmNTAwTESTE'

describe('o ambiente que a tela mostra é o do gateway', () => {
  it('o prefixo da chave manda; a configuração só desempata a chave sem prefixo', () => {
    expect(ambienteEfetivo(PROD, 'sandbox')).toBe('production')
    expect(ambienteEfetivo(HMLG, 'production')).toBe('sandbox')
    expect(ambienteEfetivo(SEM_PREFIXO, 'production')).toBe('production')
    expect(ambienteEfetivo(SEM_PREFIXO, 'sandbox')).toBe('sandbox')
    expect(ambienteEfetivo(null, 'production')).toBe('production')
    expect(ambienteEfetivo(null, null)).toBe('sandbox')
  })

  it('é a mesma leitura de prefixo de utils/asaas.ts (não uma cópia)', () => {
    for (const chave of [PROD, HMLG, SEM_PREFIXO, null, '']) {
      const daChave = ambienteDaChave(chave)
      if (daChave) expect(ambienteEfetivo(chave, daChave === 'production' ? 'sandbox' : 'production')).toBe(daChave)
    }
  })

  it('divergente só quando a chave TEM ambiente e ele não é o configurado', () => {
    expect(ambienteDivergente(PROD, 'sandbox')).toBe(true)
    expect(ambienteDivergente(HMLG, 'production')).toBe(true)
    expect(ambienteDivergente(PROD, 'production')).toBe(false)
    expect(ambienteDivergente(SEM_PREFIXO, 'production')).toBe(false)
    expect(ambienteDivergente(null, 'production')).toBe(false)
  })
})

describe('a troca que não muda para onde a cobrança vai é recusada', () => {
  it('chave de SANDBOX gravada + trocar só o select pra Produção → recusa (o caso da auditoria)', () => {
    const r = recusaDeAmbiente({ chaveFinal: HMLG, ambienteFinal: 'production', chaveNova: false })
    expect(r).toMatch(/chave gravada não é de produção/i)
  })

  it('chave de PRODUÇÃO gravada + trocar só o select pra Testes → recusa (a variante que cobra de verdade)', () => {
    const r = recusaDeAmbiente({ chaveFinal: PROD, ambienteFinal: 'sandbox', chaveNova: false })
    expect(r).toMatch(/chave gravada é de PRODUÇÃO/)
  })

  it('chave antiga sem prefixo não vira produção por troca de select', () => {
    expect(recusaDeAmbiente({ chaveFinal: SEM_PREFIXO, ambienteFinal: 'production', chaveNova: false }))
      .toMatch(/não é de produção/)
    // em testes ela continua valendo (é o formato antigo de sandbox)
    expect(recusaDeAmbiente({ chaveFinal: SEM_PREFIXO, ambienteFinal: 'sandbox', chaveNova: false })).toBeNull()
  })

  it('produção sem chave nenhuma continua recusada', () => {
    expect(recusaDeAmbiente({ chaveFinal: null, ambienteFinal: 'production', chaveNova: false }))
      .toMatch(/sem chave/i)
  })

  it('par coerente passa: chave nova de produção junto com a troca, ou testes com chave de testes', () => {
    expect(recusaDeAmbiente({ chaveFinal: PROD, ambienteFinal: 'production', chaveNova: true })).toBeNull()
    expect(recusaDeAmbiente({ chaveFinal: HMLG, ambienteFinal: 'sandbox', chaveNova: true })).toBeNull()
    // remover a chave e voltar pra testes (o botão "Remover" da tela)
    expect(recusaDeAmbiente({ chaveFinal: null, ambienteFinal: 'sandbox', chaveNova: false })).toBeNull()
  })

  it('a frase diz se o problema é a chave colada ou a gravada', () => {
    expect(recusaDeAmbiente({ chaveFinal: PROD, ambienteFinal: 'sandbox', chaveNova: true }))
      .toMatch(/^A chave colada/)
    expect(recusaDeAmbiente({ chaveFinal: PROD, ambienteFinal: 'sandbox', chaveNova: false }))
      .toMatch(/^A chave gravada/)
  })
})
