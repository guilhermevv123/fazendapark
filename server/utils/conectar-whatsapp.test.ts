import { describe, expect, it } from 'vitest'
import { configDaConexao, lerEstadoDaUazapi, numeroMascarado, tokenDoLinkDeConexao } from './conectar-whatsapp'

const env = { UAZAPI_URL: 'https://x.uazapi.com', UAZAPI_TOKEN: 'abc-123' }

describe('link de conexão do WhatsApp', () => {
  it('o token do link é estável, longo e muda com o token da instância', () => {
    const t = tokenDoLinkDeConexao('abc-123')
    expect(t).toBe(tokenDoLinkDeConexao('abc-123'))
    expect(t).toHaveLength(40)
    expect(t).not.toBe(tokenDoLinkDeConexao('abc-124'))
    expect(t).not.toContain('abc-123')
  })
  it('só abre com o token certo; desligado ou sem env = fechado', () => {
    const t = tokenDoLinkDeConexao('abc-123')
    expect(configDaConexao(t, env)).toEqual({ url: 'https://x.uazapi.com', token: 'abc-123' })
    expect(configDaConexao('errado', env)).toBeNull()
    expect(configDaConexao('', env)).toBeNull()
    expect(configDaConexao(t, { ...env, CONECTAR_WHATSAPP: 'off' })).toBeNull()
    expect(configDaConexao(t, { UAZAPI_URL: 'https://x.uazapi.com' })).toBeNull()
  })
  it('lê o estado e nunca devolve o número inteiro', () => {
    const e = lerEstadoDaUazapi({ instance: { status: 'connecting', qrcode: 'data:image/png;base64,' + 'A'.repeat(100), owner: '557398421010' } })
    expect(e.estado).toBe('conectando')
    expect(e.qrcode).toMatch(/^data:image\/png;base64,/)
    expect(e.numero).toBe('5573•••••10')
    expect(JSON.stringify(e)).not.toContain('557398421010')
    expect(lerEstadoDaUazapi({ instance: { status: 'connected', qrcode: 'x'.repeat(100) }, status: { connected: true } }))
      .toMatchObject({ estado: 'conectado', qrcode: null })
    expect(lerEstadoDaUazapi({ instance: { status: 'disconnected' } }).estado).toBe('desconectado')
    expect(numeroMascarado('12')).toBeNull()
  })
})
