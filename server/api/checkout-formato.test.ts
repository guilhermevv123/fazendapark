/**
 * B11 · a recusa de FORMATO do checkout diz o campo e o que fazer.
 *
 * Era `400 "Dados inválidos"` com o `flatten()` do Zod no `data`, que a tela
 * não lia: quem digitou o celular sem DDD, um e-mail `a@b`, uma rua de 121
 * letras ou 2 letras no documento da meia não sabia o que corrigir. Os casos
 * são os passos da auditoria (auditoria-publico.json, B11).
 *
 * Função pura, com o MESMO `Entrada` da rota — sem servidor.
 */
import { createError } from 'h3'
import { describe, expect, it } from 'vitest'

;(globalThis as any).defineEventHandler ??= (h: any) => h
;(globalThis as any).createError ??= createError
const { Entrada, recusaDeFormato } = await import('./checkout.post')

const LOTE = '00000000-0000-4000-8000-000000000001'
const base = () => ({
  eventSlug: 'qualquer',
  itens: [{ lotId: LOTE, quantidade: 1 }],
  comprador: { nome: 'Maria de Teste', email: 'maria@teste.com.br', documento: '52998224725',
    telefone: '73998260963' },
})

function recusa(mexer: (b: any) => void) {
  const b: any = base()
  mexer(b)
  const p = Entrada.safeParse(b)
  expect(p.success, 'o corpo deveria ser recusado pelo formato').toBe(false)
  const e: any = recusaDeFormato((p as any).error)
  return { status: e.statusCode, frase: e.statusMessage as string, data: e.data }
}

describe('B11 · recusa de formato com campo e frase', () => {
  it('o corpo certo passa (a régua não ficou mais dura)', () => {
    expect(Entrada.safeParse(base()).success).toBe(true)
  })

  it('celular de 9 dígitos → campo telefone, com o exemplo do formato', () => {
    const r = recusa((b) => { b.comprador.telefone = '999990000' })
    expect(r.status).toBe(400)
    expect(r.data).toEqual({ tipo: 'cadastro', campo: 'telefone' })
    expect(r.frase).toMatch(/DDD/)
    expect(r.frase).not.toMatch(/Dados inválidos/)
  })

  it('e-mail a@b → campo email', () => {
    const r = recusa((b) => { b.comprador.email = 'a@b' })
    expect(r.data).toEqual({ tipo: 'cadastro', campo: 'email' })
    expect(r.frase).toMatch(/e-mail/)
  })

  it('nome com 121 letras → campo nome, e diz o limite', () => {
    const r = recusa((b) => { b.comprador.nome = 'M'.repeat(121) })
    expect(r.data).toEqual({ tipo: 'cadastro', campo: 'nome' })
    expect(r.frase).toMatch(/120/)
  })

  it('nome curto → pede o nome completo', () => {
    const r = recusa((b) => { b.comprador.nome = 'Ma' })
    expect(r.data.campo).toBe('nome')
    expect(r.frase).toMatch(/nome completo/)
  })

  it('rua com 121 letras → campo rua, e diz o limite', () => {
    const r = recusa((b) => { b.comprador.endereco = { rua: 'R'.repeat(121), cidade: 'Salvador', estado: 'BA' } })
    expect(r.data).toEqual({ tipo: 'cadastro', campo: 'rua' })
    expect(r.frase).toMatch(/A rua passou do limite de 120/)
  })

  it('documento da meia com 2 caracteres → campo meia_documento, e em QUAL linha', () => {
    const r = recusa((b) => {
      b.itens.push({ lotId: LOTE, quantidade: 1, meia: { motivo: 'estudante', documento: 'ab' } })
    })
    expect(r.data).toEqual({ tipo: 'cadastro', campo: 'meia_documento', item: 1 })
    expect(r.frase).toMatch(/meia-entrada/)
  })

  it('o que a TELA monta (lote, quantidade) não aponta campo: manda recarregar', () => {
    const r = recusa((b) => { b.itens[0].lotId = 'nao-e-uuid' })
    expect(r.data).toEqual({ tipo: 'cadastro', campo: null })
    expect(r.frase).toMatch(/Recarregue a página/)
  })
})
