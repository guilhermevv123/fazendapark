/**
 * PROD-01, 03, 04, 05 e B05 · a configuração de produção grita — e nunca
 * mostra valor.
 *
 * `conferirConfiguracao` é a lista que sai no boot (`avisarConfiguracaoNoBoot`)
 * e em `/api/saude`. Cada peça que faltava no deploy falhava em silêncio e
 * longe da causa; aqui cada uma vira SIM/NÃO e frase. O teste mexe no
 * `process.env` e devolve no fim de cada caso.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { avisarConfiguracaoNoBoot, conferirConfiguracao } from './asaas'

const NOMES = ['NODE_ENV', 'ASAAS_WEBHOOK_TOKEN', 'SMTP_URL', 'EMAIL_REMETENTE', 'EMAIL_TRANSPORTE',
  'PUBLIC_BASE_URL', 'NUXT_SESSION_SECRET', 'TICKET_KEYS', 'TICKET_KEY_LEGADO_DT1', 'CONFIAR_PROXY',
  'MONITOR_TOKEN'] as const
const guardado = Object.fromEntries(NOMES.map((n) => [n, process.env[n]]))
afterEach(() => {
  for (const n of NOMES) {
    if (guardado[n] === undefined) delete process.env[n]
    else process.env[n] = guardado[n]
  }
})

const SEGREDOS = {
  ASAAS_WEBHOOK_TOKEN: 'tok-webhook-ZZ-que-nao-pode-vazar-0001',
  SMTP_URL: 'smtps://usuario:SenhaSmtpQueNaoPodeVazar@smtp.exemplo.com.br:465',
  EMAIL_REMETENTE: 'Conquista Park <ingressos@exemplo.com.br>',
  PUBLIC_BASE_URL: 'https://ingressos.exemplo.com.br',
  NUXT_SESSION_SECRET: 'segredo-da-sessao-ZZ-que-nao-pode-vazar',
  TICKET_KEYS: 'k1:' + Buffer.alloc(32, 7).toString('base64'),
  MONITOR_TOKEN: 'monitor-ZZ-0123456789-0123456789-0123456789',
}

function producaoCompleta(extra: Partial<Record<(typeof NOMES)[number], string | null>> = {}) {
  for (const n of NOMES) delete process.env[n]
  Object.assign(process.env, { NODE_ENV: 'production', CONFIAR_PROXY: '1' }, SEGREDOS)
  for (const [k, v] of Object.entries(extra)) {
    if (v === null) delete process.env[k]
    else process.env[k] = v
  }
}
const critico = (itens: string[]) => (p: { item: string; critico: boolean }) => p.critico && itens.includes(p.item)

describe('conferirConfiguracao · o que falta em produção', () => {
  it('tudo configurado: nenhum problema, tudo SIM', () => {
    producaoCompleta()
    const c = conferirConfiguracao()
    expect(c.problemas).toEqual([])
    expect(Object.values(c.itens).every((v) => v === 'SIM')).toBe(true)
    expect(c.assinaQrCom).toBe('DT2')
  })

  it('PROD-01 · sem ASAAS_WEBHOOK_TOKEN é crítico (nenhum PIX vira ingresso)', () => {
    producaoCompleta({ ASAAS_WEBHOOK_TOKEN: null })
    const c = conferirConfiguracao()
    expect(c.itens.webhookToken).toBe('NÃO')
    expect(c.problemas.some(critico(['ASAAS_WEBHOOK_TOKEN']))).toBe(true)
  })

  it('PROD-05 · sem SMTP_URL é crítico; EMAIL_TRANSPORTE=simulado é o ensaio declarado', () => {
    producaoCompleta({ SMTP_URL: null })
    expect(conferirConfiguracao().problemas.some(critico(['SMTP_URL/EMAIL_REMETENTE']))).toBe(true)
    producaoCompleta({ SMTP_URL: null, EMAIL_TRANSPORTE: 'simulado' })
    expect(conferirConfiguracao().problemas.some((p) => p.item === 'SMTP_URL/EMAIL_REMETENTE')).toBe(false)
  })

  it('PROD-04 · PUBLIC_BASE_URL apontando pra esta máquina não serve em produção', () => {
    producaoCompleta({ PUBLIC_BASE_URL: 'http://localhost:3100' })
    const c = conferirConfiguracao()
    expect(c.itens.publicBaseUrl).toBe('NÃO')
    expect(c.problemas.find((p) => p.item === 'PUBLIC_BASE_URL')).toMatchObject({ critico: false })
  })

  it('PROD-03 · sem chave nenhuma pra assinar ingresso é crítico', () => {
    producaoCompleta({ TICKET_KEYS: null, NUXT_SESSION_SECRET: null })
    const c = conferirConfiguracao()
    expect(c.assinaQrCom).toBeNull()
    expect(c.problemas.some(critico(['TICKET_KEYS']))).toBe(true)
  })

  it('PROD-03 · só o segredo da sessão: assina DT1 e AVISA não trocar — sem mandar configurar DT2 antes da portaria', () => {
    producaoCompleta({ TICKET_KEYS: null })
    const c = conferirConfiguracao()
    expect(c.assinaQrCom).toBe('DT1')
    expect(c.itens.chaveDoIngresso).toBe('NÃO')
    const avisos = c.problemas.filter((p) => p.item === 'TICKET_KEYS')
    expect(avisos).toHaveLength(1)
    expect(avisos[0]).toMatchObject({ critico: false })
    expect(avisos[0].frase).toMatch(/NÃO troque/)
    expect(avisos[0].frase).toMatch(/portaria/)
  })

  it('fora de produção, a falta de webhook e de SMTP não é problema', () => {
    producaoCompleta({ NODE_ENV: 'development', ASAAS_WEBHOOK_TOKEN: null, SMTP_URL: null, PUBLIC_BASE_URL: null })
    expect(conferirConfiguracao().problemas).toEqual([])
  })

  it('nenhum valor de variável sai na resposta — só SIM/NÃO e frases', () => {
    producaoCompleta({ ASAAS_WEBHOOK_TOKEN: null, PUBLIC_BASE_URL: 'http://localhost:3100' })
    const texto = JSON.stringify(conferirConfiguracao())
    for (const valor of Object.values(SEGREDOS)) {
      for (const pedaco of [valor, ...valor.split(/[:@<>/ ]/).filter((x) => x.length >= 8)]) {
        expect(texto, `vazou "${pedaco}"`).not.toContain(pedaco)
      }
    }
    expect(texto).not.toContain('localhost:3100')
  })
})

describe('avisarConfiguracaoNoBoot · o boot grita no que impede venda', () => {
  it('em produção, falta crítica sai em console.error — sem valor nenhum', async () => {
    producaoCompleta({ ASAAS_WEBHOOK_TOKEN: null })
    const linhas: Array<[string, string]> = []
    await avisarConfiguracaoNoBoot({
      error: (m: string) => linhas.push(['error', m]),
      warn: (m: string) => linhas.push(['warn', m]),
      log: (m: string) => linhas.push(['log', m]),
    } as any)
    expect(linhas.some(([nivel, m]) => nivel === 'error' && /ASAAS_WEBHOOK_TOKEN/.test(m))).toBe(true)
    const tudo = linhas.map(([, m]) => m).join('\n')
    for (const valor of Object.values(SEGREDOS)) expect(tudo).not.toContain(valor)
  })

  it('em produção sem falta crítica, uma linha só de "tudo certo"', async () => {
    producaoCompleta()
    const linhas: string[] = []
    await avisarConfiguracaoNoBoot({
      error: (m: string) => linhas.push(`E ${m}`), warn: (m: string) => linhas.push(`W ${m}`),
      log: (m: string) => linhas.push(`L ${m}`),
    } as any)
    expect(linhas.filter((l) => l.startsWith('E ') && !/evento à venda/.test(l))).toEqual([])
    expect(linhas.some((l) => l.startsWith('L [config] produção:'))).toBe(true)
  })
})
