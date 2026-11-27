import { describe, expect, it } from 'vitest'
import { numeroDaPulseira } from './nfc'

describe('número da pulseira no formato do leitor USB (10 dígitos)', () => {
  // 0110264695 = 0x06928177 (o número que o leitor USB do parque digitou)
  it('invertida: o Android entrega 77 81 92 06, o leitor digita 0110264695', () => {
    expect(numeroDaPulseira('77819206', 'invertida')).toBe('0110264695')
  })
  it('normal: o Android entrega 06 92 81 77, o leitor digita 0110264695', () => {
    expect(numeroDaPulseira('06928177', 'normal')).toBe('0110264695')
  })
  it('UID de 7 bytes: só os 4 primeiros, como o leitor USB', () => {
    expect(numeroDaPulseira('04A1B2C3D4E5F6', 'normal')).toBe(String(0x04a1b2c3).padStart(10, '0'))
  })
  it('lixo não vira pulseira', () => {
    expect(numeroDaPulseira('12', 'normal')).toBeNull()
    expect(numeroDaPulseira('', 'invertida')).toBeNull()
  })
  it('FFFFFFFF cabe em 10 dígitos', () => {
    expect(numeroDaPulseira('FFFFFFFF', 'normal')).toBe('4294967295')
  })
})
