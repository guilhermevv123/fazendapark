// @vitest-environment happy-dom
/**
 * A caixa "Dias de uso na catraca" (047), montada — a que o painel usa no tipo de ingresso e no
 * passo 5 do assistente. O que a tela tem que garantir (dono, 07/10: "já vai ser previamente
 * ativado, eu só vou colocar os dias"):
 *
 *  · nasce LIGADA; sem dia marcado diz com todas as letras que passa em qualquer dia;
 *  · no tipo NOVO, o nome marca o dia ("SEXTA" → a sexta do evento) até a pessoa mexer;
 *  · no tipo JÁ GRAVADO nada é marcado sozinho: aparece a sugestão, e só vale clicando;
 *  · voltar ao passo (a caixa remonta) não desfaz o que a pessoa ajustou.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { limparTela, montarTela } from './.vitest-setup-dom'
import { diasDoEvento } from '../../server/utils/dias-de-uso'

const caixa = () => import('../components/DiasDeUsoDoTipo.vue')
const DIAS = diasDoEvento('2026-10-09T12:00:00Z', '2026-10-12T20:00:00Z', 'America/Bahia')
const montadas: any[] = []
afterEach(() => { for (const t of montadas.splice(0)) t.unmount(); limparTela() })

async function abrir(props: Record<string, any>) {
  const emitidos: any[] = []
  const t = await montarTela(await caixa(), {
    props: { dias: DIAS, ...props, 'onUpdate:modelValue': (v: any) => emitidos.push(v) },
  })
  montadas.push(t)
  return { t, emitidos }
}

describe('dias de uso na tela do tipo (047)', () => {
  it('tipo novo chamado SEXTA: a sexta já vem marcada', async () => {
    const { emitidos } = await abrir({ modelValue: undefined, nome: 'ENTRADA INDIVIDUAL SEXTA', autoPeloNome: true })
    expect(emitidos.at(-1)).toEqual(['2026-10-09'])
  })

  it('tipo já gravado sem dia: ligada, "qualquer dia", e a sugestão só vale clicando', async () => {
    const { t, emitidos } = await abrir({ modelValue: null, nome: 'COMBO DOMINGO - COMBO 10 PESSOAS' })
    expect(t.find('[data-parte="chave-dias-de-uso"]').attributes('aria-checked')).toBe('true')
    expect(t.find('[data-parte="frase-dias-de-uso"]').text()).toContain('passa em qualquer dia')
    expect(emitidos, 'marcou sozinho num tipo já gravado').toHaveLength(0)
    const sug = t.find('[data-parte="sugestao-dias-de-uso"]')
    expect(sug.text()).toContain('domingo 11/10')
    await sug.trigger('click')
    expect(emitidos.at(-1)).toEqual(['2026-10-11'])
  })

  it('clicar nos dias marca e desmarca, em ordem', async () => {
    const { t, emitidos } = await abrir({ modelValue: ['2026-10-11'], nome: 'X' })
    await t.find('[data-dia="2026-10-09"]').trigger('click')
    expect(emitidos.at(-1)).toEqual(['2026-10-09', '2026-10-11'])
  })

  it('desligar a chave limpa os dias (null = qualquer dia)', async () => {
    const { t, emitidos } = await abrir({ modelValue: ['2026-10-09'], nome: 'SEXTA' })
    await t.find('[data-parte="chave-dias-de-uso"]').trigger('click')
    expect(emitidos.at(-1)).toBeNull()
    expect(t.text()).toContain('Desligado: passa em qualquer dia do evento.')
  })

  it('a caixa remonta (voltou ao passo) com o dia que a pessoa ajustou: o nome não passa por cima', async () => {
    const { emitidos } = await abrir({ modelValue: ['2026-10-10'], nome: 'ENTRADA SEXTA', autoPeloNome: true })
    expect(emitidos, 'a sugestão do nome desfez o ajuste da pessoa').toHaveLength(0)
  })
})
