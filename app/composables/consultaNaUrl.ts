import { computed, shallowRef } from 'vue'
import type { LocationQuery, LocationQueryRaw } from 'vue-router'

/**
 * Os filtros da tela na URL, sem perder troca rápida (auditoria 28/09).
 *
 * Duas armadilhas, as duas mudas — nada no console, nenhum teste vermelho, só a URL errada e o
 * F5 mostrando outra coisa:
 *
 * 1. `navigateTo` chamado enquanto OUTRA navegação ainda está no middleware (o do /admin confere a
 *    sessão no servidor a cada troca, de 0,1 a 0,5 s) acha que foi chamado DE DENTRO do middleware
 *    e só devolve o destino, sem navegar (é o `isProcessingMiddleware` do Nuxt). Medido no
 *    Atendimento IA: escolher o canal e já digitar a busca — a lista filtrava, a URL ficava sem a
 *    busca, e o F5 a esquecia.
 * 2. Montar a consulta nova a partir de `route.query` com uma troca ainda a caminho parte do estado
 *    VELHO: a segunda troca apagava a primeira.
 *
 * Aqui: `router.replace` direto (a navegação mais nova cancela a anterior, sem o desvio do
 * middleware; `replace` porque mexer em filtro não empilha histórico — o Voltar sai da tela), e
 * `atual` é a ÚLTIMA consulta pedida enquanto ela não chega na rota. A tela lê o filtro de
 * `atual`, então o chip já acende no clique, e a troca seguinte parte dela.
 */
export type ConsultaPedida = Record<string, string | number | boolean | null | undefined>

interface Rota { path: string; query: LocationQuery }
interface Roteador { replace: (para: { path: string; query: LocationQueryRaw }) => Promise<unknown> }

/** mesma consulta, chave por chave (a ordem das chaves não importa) */
function mesmaConsulta(a: LocationQuery, b: LocationQuery) {
  const chaves = Object.keys(a)
  if (chaves.length !== Object.keys(b).length) return false
  return chaves.every((k) => JSON.stringify(a[k]) === JSON.stringify(b[k]))
}

export function criarConsultaNaUrl(rota: Rota, roteador: Roteador) {
  const pedida = shallowRef<LocationQuery | null>(null)
  // Quando a rota chega IGUAL ao que foi pedido, devolve o MESMO objeto: sem isto, a troca da
  // pedida pela rota recalculava o filtro da tela e cada `useFetch` buscava de novo a mesma coisa
  // (dois pedidos por clique, medido no Clientes).
  const atual = computed<LocationQuery>((anterior) => {
    const agora = pedida.value ?? rota.query
    return anterior && mesmaConsulta(anterior, agora) ? anterior : agora
  })

  /** Troca a consulta INTEIRA pela dada (vazio, nulo e `false` ficam fora da URL). */
  async function escrever(consulta: ConsultaPedida, caminho: string = rota.path) {
    const limpa: Record<string, string> = {}
    for (const [chave, valor] of Object.entries(consulta)) {
      if (valor === null || valor === undefined || valor === '' || valor === false) continue
      limpa[chave] = String(valor)
    }
    pedida.value = limpa
    try {
      await roteador.replace({ path: caminho, query: limpa })
    } finally {
      // só a navegação mais nova limpa: uma velha que termina depois não apaga a pedida da nova
      if (pedida.value === limpa) pedida.value = null
    }
  }

  return { atual, escrever }
}

export function useConsultaNaUrl() {
  return criarConsultaNaUrl(useRoute(), useRouter())
}
