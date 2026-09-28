/**
 * O comprador diante do gateway — três funções puras de `utils/asaas.ts`.
 *
 *  · B12 `telefoneParaAsaas`: celular em `mobilePhone`, fixo em `phone` (os dois
 *    campos que a doc do Asaas separa), e número torto não vai.
 *  · B12 `recusaDeDadoDoComprador`: a recusa do Asaas que é de CAMPO do
 *    comprador vira frase com o campo — em vez de "Não foi possível gerar a
 *    cobrança. Tente de novo.", que se repetia a cada tentativa.
 *  · PROD-06 `pagamentoOnline`: sem chave, ou com chave de TESTE em produção,
 *    não há venda online — e a resposta nunca carrega a chave.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { ErroAsaas, pagamentoOnline, recusaDeDadoDoComprador, telefoneParaAsaas } from './asaas'

describe('B12 · telefoneParaAsaas', () => {
  it('celular (11 dígitos, 9 depois do DDD) vai em mobilePhone, com ou sem máscara', () => {
    expect(telefoneParaAsaas('(73) 99826-0963')).toEqual({ mobilePhone: '73998260963' })
    expect(telefoneParaAsaas('73998260963')).toEqual({ mobilePhone: '73998260963' })
    expect(telefoneParaAsaas('+55 73 99826-0963')).toEqual({ mobilePhone: '73998260963' })
  })
  it('fixo (10 dígitos) vai em phone — era mandado como celular', () => {
    expect(telefoneParaAsaas('(73) 3421-0000')).toEqual({ phone: '7334210000' })
  })
  it('número torto não vai (o telefone é opcional pro Asaas; lixo só gera recusa)', () => {
    expect(telefoneParaAsaas('999990000')).toEqual({})
    expect(telefoneParaAsaas('73898260963')).toEqual({})
    expect(telefoneParaAsaas('')).toEqual({})
    expect(telefoneParaAsaas(null)).toEqual({})
    expect(telefoneParaAsaas(undefined)).toEqual({})
  })
})

describe('B12 · recusaDeDadoDoComprador', () => {
  const erro = (erros: any[], status = 400) => new ErroAsaas(status, { errors: erros }, 'Asaas 400')

  it('celular recusado → campo telefone, com a descrição do Asaas', () => {
    const r = recusaDeDadoDoComprador(erro([
      { code: 'invalid_mobilePhone', description: 'O celular informado é inválido.' }]))
    expect(r).toEqual({
      campo: 'telefone',
      recado: 'O sistema de pagamento recusou o celular (O celular informado é inválido). '
        + 'Corrija e tente de novo.',
    })
  })
  it('e-mail, CPF e nome também apontam o campo', () => {
    expect(recusaDeDadoDoComprador(erro([{ code: 'invalid_email', description: 'x' }]))?.campo).toBe('email')
    expect(recusaDeDadoDoComprador(erro([{ code: 'invalid_cpfCnpj', description: 'x' }]))?.campo).toBe('documento')
    expect(recusaDeDadoDoComprador(erro([{ code: 'invalid_name', description: 'x' }]))?.campo).toBe('nome')
  })
  it('acha o campo do comprador mesmo depois de um erro que não é dele', () => {
    const r = recusaDeDadoDoComprador(erro([
      { code: 'invalid_value', description: 'valor' }, { code: 'invalid_phone', description: 'fixo' }]))
    expect(r?.campo).toBe('telefone')
  })
  it('o que não é do comprador segue como indisponibilidade (null)', () => {
    expect(recusaDeDadoDoComprador(erro([{ code: 'invalid_value', description: 'valor' }]))).toBeNull()
    expect(recusaDeDadoDoComprador(erro([{ code: 'invalid_mobilePhone' }], 500))).toBeNull()
    expect(recusaDeDadoDoComprador(new ErroAsaas(400, null, 'sem corpo'))).toBeNull()
    expect(recusaDeDadoDoComprador(new Error('rede caiu'))).toBeNull()
    expect(recusaDeDadoDoComprador(undefined)).toBeNull()
  })
})

describe('PROD-06 · pagamentoOnline', () => {
  const guardado = { NODE_ENV: process.env.NODE_ENV, PAGAMENTO_SIMULADO: process.env.PAGAMENTO_SIMULADO,
    ASAAS_WEBHOOK_TOKEN: process.env.ASAAS_WEBHOOK_TOKEN }
  afterEach(() => {
    for (const [k, v] of Object.entries(guardado)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })
  /** com o token do webhook configurado, salvo quando o caso diz o contrário */
  const ambiente = (nodeEnv: string, simulado: string, token: string | null = 'token-do-webhook-de-teste') => {
    process.env.NODE_ENV = nodeEnv
    process.env.PAGAMENTO_SIMULADO = simulado
    if (token == null) delete process.env.ASAAS_WEBHOOK_TOKEN
    else process.env.ASAAS_WEBHOOK_TOKEN = token
  }
  const CHAVE_TESTE = '$aact_hmlg_000MzkwODA2MWY2OGM3MWRlMDU2NWM3MzJlNzZmNGZhZGY6OmZha2U'
  const CHAVE_PROD = '$aact_prod_000MzkwODA2MWY2OGM3MWRlMDU2NWM3MzJlNzZmNGZhZGY6OmZha2U'

  it('na máquina com o gateway simulado ligado: vende', () => {
    ambiente('development', '1')
    expect(pagamentoOnline({ asaas_api_key: null })).toEqual({ ok: true })
  })
  it('sem chave (e sem simulado): não vende, e diz por quê', () => {
    ambiente('development', '0')
    const r = pagamentoOnline({ asaas_api_key: null })
    expect(r).toMatchObject({ ok: false, motivo: 'sem_chave' })
    expect((r as any).recado).toMatch(/bilheteria/)
  })
  it('em produção o simulado não liga: sem chave continua sem venda', () => {
    ambiente('production', '1')
    expect(pagamentoOnline({ asaas_api_key: '' })).toMatchObject({ ok: false, motivo: 'sem_chave' })
  })
  it('em produção, chave de TESTE não vende (PIX que nenhum banco paga)', () => {
    ambiente('production', '0')
    expect(pagamentoOnline({ asaas_api_key: CHAVE_TESTE })).toMatchObject({ ok: false, motivo: 'chave_de_teste' })
    // chave sem marca: vale o ambiente gravado, e sem ele é sandbox
    expect(pagamentoOnline({ asaas_api_key: 'chave-sem-marca', asaas_env: null }))
      .toMatchObject({ ok: false, motivo: 'chave_de_teste' })
    expect(pagamentoOnline({ asaas_api_key: 'chave-sem-marca', asaas_env: 'production' })).toEqual({ ok: true })
  })
  it('em produção, chave de produção vende', () => {
    ambiente('production', '0')
    expect(pagamentoOnline({ asaas_api_key: CHAVE_PROD })).toEqual({ ok: true })
  })
  it('PROD-01 · em produção sem ASAAS_WEBHOOK_TOKEN não vende: o PIX cairia e o ingresso não sairia', () => {
    ambiente('production', '0', null)
    expect(pagamentoOnline({ asaas_api_key: CHAVE_PROD })).toMatchObject({ ok: false, motivo: 'sem_webhook' })
    ambiente('production', '0', '   ')
    expect(pagamentoOnline({ asaas_api_key: CHAVE_PROD })).toMatchObject({ ok: false, motivo: 'sem_webhook' })
    // fora de produção o webhook aceita sem token (com aviso): não trava a máquina
    ambiente('development', '0', null)
    expect(pagamentoOnline({ asaas_api_key: CHAVE_TESTE })).toEqual({ ok: true })
  })
  it('fora de produção, chave de teste vende (é o sandbox de quem desenvolve)', () => {
    ambiente('development', '0')
    expect(pagamentoOnline({ asaas_api_key: CHAVE_TESTE })).toEqual({ ok: true })
  })
  it('a resposta nunca carrega a chave', () => {
    ambiente('production', '0')
    expect(JSON.stringify(pagamentoOnline({ asaas_api_key: CHAVE_TESTE }))).not.toContain('aact')
  })
})
