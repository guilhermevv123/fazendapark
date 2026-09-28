/**
 * ultimoDadoBom.ts — a tela não some quando o recarregar falha (#77, 28/09).
 *
 * No Nuxt 4 o `refresh()` do `useFetch` NUNCA rejeita: quando o recarregar falha (a rede caiu, a
 * sessão venceu), ele põe a falha em `error` e troca `data` pelo `default()` — que, sem `default`,
 * é `undefined`. As telas do painel moram sob `v-if="data"`: a tela inteira sumia no meio de uma
 * ação que JÁ tinha gravado, e sobrava "Não foi possível carregar…". Nas cortesias, o operador não
 * via que tinha emitido e emitia de novo. (O `try/catch` em volta do `refresh()` nunca pegou nada.)
 *
 * Com isto, o recarregar que falha deixa na tela o último dado bom, e a falha continua em `error`
 * pra tela dizer que não recarregou. Só pra endereço FIXO: com filtro na URL, o último dado bom é
 * de OUTRO recorte, e mostrá-lo como se fosse o novo seria pior que a tela vazia.
 *
 *   const bom = ultimoDadoBom<any>()
 *   const { data, refresh, error: falha } = await useFetch<any>(url, { default: bom.default })
 *   bom.guardar(data)
 *   …
 *   await refresh()
 *   if (falha.value) erro.value = 'Gravou, mas a lista não recarregou: …'
 */
import { watch, type Ref } from 'vue'

export function ultimoDadoBom<T>() {
  let ultimo: T | undefined
  return {
    /** o `default` do `useFetch`: na falha do recarregar, devolve o que a tela já mostrava */
    default: () => ultimo as T,
    /** guarda cada dado bom que chega — inclusive o da hidratação, que não passa por `transform` */
    guardar(data: Ref<T | null | undefined>) {
      watch(data, (v) => { if (v != null) ultimo = v }, { immediate: true })
    },
  }
}
