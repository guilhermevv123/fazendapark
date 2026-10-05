/**
 * confirmacao.ts — `confirm()` do sistema: `await perguntar({...})` devolve true/false, e a tela
 * renderiza `<JanelaConfirmar v-if="pergunta" v-bind="pergunta" @responder="responder" />`.
 *
 * Nada de `window.confirm`/`alert`/`prompt` no painel nem no site (ordem do dono, 05/10).
 */
export interface Pergunta {
  titulo: string
  texto?: string
  detalhes?: string[]
  confirmar?: string
  cancelar?: string
  perigo?: boolean
}

export function usarConfirmacao() {
  const pergunta = shallowRef<Pergunta | null>(null)
  let resolver: ((sim: boolean) => void) | null = null

  function perguntar(p: Pergunta): Promise<boolean> {
    // uma pergunta por vez: a anterior, se ficou aberta, vale como "não"
    resolver?.(false)
    pergunta.value = p
    return new Promise((r) => { resolver = r })
  }
  function responder(sim: boolean) {
    const r = resolver
    resolver = null
    pergunta.value = null
    r?.(sim)
  }
  return { pergunta, perguntar, responder }
}
