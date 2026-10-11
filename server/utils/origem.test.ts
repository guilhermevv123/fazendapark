/**
 * De onde veio a pessoa (052): a regra de "isto é anúncio / robô / orgânico / direto" — a mesma no
 * navegador e no servidor.
 */
import { describe, expect, it } from 'vitest'
import { dominioDaReferencia, origemDaUrl, OrigemDoNavegador, OrigemDoPedido, tipoDaOrigem } from './origem'

const NOSSO = 'www.conquistapark.com.br'

describe('origem da chegada', () => {
  it('UTM de anúncio da Meta = tráfego pago, com campanha e anúncio', () => {
    const o = origemDaUrl({ utm_source: 'meta', utm_medium: 'paid_social', utm_campaign: 'Black Friday',
      utm_content: 'video-tobogã', fbclid: 'IwAR1' }, null, { entrada: '/', nossoHost: NOSSO })
    expect(o).toMatchObject({ tipo: 'pago', fonte: 'meta', meio: 'paid_social', campanha: 'Black Friday',
      conteudo: 'video-tobogã', clique: 'fbclid', entrada: '/' })
  })
  it('os jeitos comuns de escrever anúncio no utm_medium e no utm_source', () => {
    for (const meio of ['cpc', 'CPC', 'ppc', 'paid', 'pago', 'ads', 'anuncio', 'anúncios', 'trafego', 'tráfego', 'cpm', 'paid-social', 'social_paid'])
      expect(tipoDaOrigem({ fonte: 'x', meio, campanha: null, clique: null, referencia: null }), meio).toBe('pago')
    expect(tipoDaOrigem({ fonte: 'facebook_ads', meio: null, campanha: null, clique: null, referencia: null })).toBe('pago')
    expect(tipoDaOrigem({ fonte: 'instagram', meio: 'bio', campanha: null, clique: null, referencia: null })).toBe('organico')
    // "adsense"/"lead" não são "ads": não confunde palavra que só CONTÉM as letras
    expect(tipoDaOrigem({ fonte: 'x', meio: 'leads', campanha: null, clique: null, referencia: null })).toBe('organico')
  })
  it('o link do robô (utm_medium=robo) é do robô', () => {
    expect(origemDaUrl({ utm_source: 'whatsapp', utm_medium: 'robo', utm_campaign: 'sofia' })?.tipo).toBe('robo')
    expect(origemDaUrl({ utm_source: 'instagram', utm_medium: 'robo_dm' })?.tipo).toBe('robo')
  })
  it('gclid é anúncio do Google; fbclid sozinho NÃO é prova de anúncio', () => {
    expect(origemDaUrl({ gclid: 'abc' })?.tipo).toBe('pago')
    expect(origemDaUrl({ fbclid: 'IwAR' })?.tipo).toBe('meta_sem_utm')
  })
  it('sem UTM: veio de outro site = orgânico; do nosso próprio site ou de lugar nenhum = nada', () => {
    expect(origemDaUrl({}, 'https://l.instagram.com/?u=abc', { nossoHost: NOSSO })).toMatchObject({ tipo: 'organico', referencia: 'l.instagram.com' })
    expect(origemDaUrl({}, 'https://www.conquistapark.com.br/e/x', { nossoHost: NOSSO })).toBeNull()
    expect(origemDaUrl({}, null)).toBeNull()
    expect(dominioDaReferencia('https://www.google.com/search?q=cpf+123')).toBe('google.com')
  })
  it('o que vem do navegador é limpo e RECLASSIFICADO (o tipo mandado não vale)', () => {
    const o = OrigemDoNavegador.parse({ tipo: 'pago', fonte: '  instagram\u0000 ', meio: 'bio', clique: null, em: 'lixo' })
    expect(o).toMatchObject({ tipo: 'organico', fonte: 'instagram', em: null })
    expect(OrigemDoPedido.safeParse({ ultimo: { clique: 'outro' } }).success).toBe(false)
    expect(OrigemDoNavegador.parse({ fonte: 'x'.repeat(500) }).fonte).toHaveLength(120)
  })
})
