/**
 * cupom-consumacao.test.ts — a conta pura do Volte Mais permanente + cupom do bar (042), sem banco:
 *   · o estado do cupom (válido / já usado / ativo o dia todo / outro dia / pedido cancelado);
 *   · o código que a atendente digita (sem 0/O nem 1/I) e o que ela confere (CPF mascarado);
 *   · o programa permanente: regra do dia sem data de fim e o regulamento que diz "por tempo
 *     indeterminado" e "em todas as próximas visitas".
 * O caminho com banco e HTTP (baixa, trava, papel de portaria) está em `server/api/cupom-consumacao.test.ts`.
 */
import { describe, expect, it } from 'vitest'
import {
  codigoDoCupomLimpo, codigoNovoDoCupom, cpfParaConferir, estadoDoCupomDeConsumacao, nomeCurtoDoTitular, RECADO_DO_CUPOM,
} from './cupom-consumacao'
import { regraDoDiaDaFidelidade } from './fidelidade'
import { fidelidadePermanente, PROGRAMA_DE_FIDELIDADE_PADRAO, regulamentoDaFidelidade, type ProgramaDeFidelidade } from './fidelidade-texto'

const prog = (x: Partial<ProgramaDeFidelidade> = {}): ProgramaDeFidelidade =>
  ({ id: 'p', org_id: 'o', ...PROGRAMA_DE_FIDELIDADE_PADRAO, ativo: true, vigencia_inicio: '2026-10-01', ...x })

describe('estado do cupom', () => {
  const base = { pedidoVale: true, dia: '2026-10-10', hoje: '2026-10-10', usos: 0, usosMax: 1, diaTodo: false }
  it.each([
    [{}, 'valido'],
    [{ usos: 1 }, 'usado'],
    [{ usos: 1, usosMax: 2 }, 'valido'],
    [{ hoje: '2026-10-09' }, 'antes_do_dia'],
    [{ hoje: '2026-10-11' }, 'passou_o_dia'],
    [{ pedidoVale: false }, 'pedido_cancelado'],
    [{ pedidoVale: false, usos: 0, hoje: '2026-10-11' }, 'pedido_cancelado'],   // cancelado vence tudo
    [{ diaTodo: true }, 'valido'],
    [{ diaTodo: true, usos: 1 }, 'ativo'],
    [{ diaTodo: true, usos: 1, hoje: '2026-10-11' }, 'passou_o_dia'],          // o dia todo é SÓ o dia
  ] as const)('%o → %s', (x, esperado) => {
    expect(estadoDoCupomDeConsumacao({ ...base, ...x })).toBe(esperado)
  })
  it('cada estado tem a frase grande da tela', () => {
    expect(RECADO_DO_CUPOM.valido).toBe('VÁLIDO')
    expect(RECADO_DO_CUPOM.usado).toBe('JÁ USADO')
  })
})

describe('o que a atendente lê e digita', () => {
  it('código novo: 6 caracteres, sem 0/O/1/I ambíguos', () => {
    for (let i = 0; i < 300; i++) expect(codigoNovoDoCupom()).toMatch(/^[A-HJ-NP-Z2-9]{6}$/)
  })
  it('o digitado é limpo: minúscula, espaço, traço, 0→O e 1→I', () => {
    expect(codigoDoCupomLimpo(' k7m-2qx ')).toBe('K7M2QX')
    expect(codigoDoCupomLimpo('AB0C1D')).toBe('ABOCID')
  })
  it('CPF mascarado pra conferir com o documento; nome curto no cupom público', () => {
    expect(cpfParaConferir('52998224725')).toBe('***.982.247-**')
    expect(cpfParaConferir('529.982.247-25')).toBe('***.982.247-**')
    expect(cpfParaConferir('123')).toBeNull()
    expect(nomeCurtoDoTitular('Maria da Silva Santos')).toBe('Maria S.')
    expect(nomeCurtoDoTitular('Maria')).toBe('Maria')
    expect(nomeCurtoDoTitular('  ')).toBeNull()
  })
})

describe('Volte Mais permanente (042)', () => {
  it('o padrão de fábrica é o pedido do dono: permanente, 50% + 10%, 1 baixa — e desligado', () => {
    expect(PROGRAMA_DE_FIDELIDADE_PADRAO).toMatchObject({
      ativo: false, retornos: null, prazo_dias: null, desconto_bps: 5000, consumacao_bps: 1000,
      consumacao_usos: 1, consumacao_dia_todo: false, vigencia_fim: null,
    })
    expect(fidelidadePermanente(prog())).toBe(true)
    expect(fidelidadePermanente(prog({ retornos: 2 }))).toBe(false)
    expect(fidelidadePermanente(prog({ vigencia_fim: '2026-12-31' }))).toBe(false)
  })
  it('sem data de fim, vale daqui pra frente; sem início, não liga', () => {
    const ev = { id: 'e', dia: '2027-03-06' } // sábado
    expect(regraDoDiaDaFidelidade(prog(), ev, '2027-03-01')).toEqual({ vale: true })
    expect(regraDoDiaDaFidelidade(prog(), ev, '2026-09-30')).toMatchObject({ vale: false, motivo: 'a promoção ainda não começou' })
    expect(regraDoDiaDaFidelidade(prog({ vigencia_inicio: null }), ev, '2027-03-01').vale).toBe(false)
    expect(regraDoDiaDaFidelidade(prog({ vigencia_fim: '2026-12-31' }), ev, '2027-01-02'))
      .toMatchObject({ vale: false, motivo: 'a promoção terminou' })
  })
  it('o regulamento diz "por tempo indeterminado", "todas as próximas visitas" e como usar o cupom', () => {
    const t = regulamentoDaFidelidade(prog())
    expect(t).toContain('a partir de 01/10/2026, por tempo indeterminado')
    expect(t).toContain('avisando no site com 30 dias de antecedência')
    expect(t).toContain('50% de desconto no ingresso em todas as próximas visitas')
    expect(t).toContain('10% de desconto na consumação')
    expect(t).toContain('o cupom é usado 1 vez por visita')
    expect(t).not.toMatch(/dentro da vigência\./)
    expect(regulamentoDaFidelidade(prog({ consumacao_dia_todo: true }))).toContain('vale o dia todo depois de ativado no caixa')
  })
  it('com limite e fim, o texto antigo continua (retornos contados, vigência fechada)', () => {
    const t = regulamentoDaFidelidade(prog({ retornos: 2, vigencia_fim: '2026-12-31', prazo_dias: 60 }))
    expect(t).toContain('de 01/10/2026 a 31/12/2026')
    expect(t).toContain('2 retornos com 50% de desconto')
    expect(t).toContain('em até 60 dias depois da primeira visita, e dentro da vigência')
  })
})

describe('regulamento sem buraco na numeração', () => {
  it('sem prazo (permanente), os itens seguem 1, 2, 3… sem pular', () => {
    const numeros = regulamentoDaFidelidade(prog()).split('\n').slice(1).map((l) => Number(l.split('.')[0]))
    expect(numeros).toEqual(numeros.map((_, i) => i + 1))
  })
})
