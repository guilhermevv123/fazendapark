/**
 * Guarda de rota do navegador para tudo sob /admin.
 *
 * Isto é conveniência, NÃO segurança: quem tranca de verdade é o middleware
 * do servidor, porque o do navegador qualquer um desliga no DevTools. O papel
 * daqui é só evitar que a tela pisque carregada e depois estoure 401 em cada
 * chamada — o que faz o operador achar que o sistema quebrou quando ele
 * apenas não está logado.
 *
 * Na navegação de DENTRO do painel, o `useFetch` desta chave devolve a resposta
 * guardada e não pergunta de novo ao servidor. Quem o master desativava (ou tinha
 * a sessão encerrada) seguia navegando com o nome e o papel na tela até o F5 —
 * cada lista vindo vazia, com 401 que ninguém lia (#191, 28/09). Então, fora da
 * primeira carga (que já veio do servidor, fresca), a sessão é conferida a cada
 * troca de TELA — a troca só de filtro na URL (`?de=`, `?q=`) não pergunta: é
 * digitação, e esperar o servidor a cada tecla atrasaria a lista. Falha de REDE
 * não desloga: a portaria sem sinal segue com o que já sabia, e cada chamada que
 * precisar de sessão responde por si.
 */
export default defineNuxtRouteMiddleware(async (para, de) => {
  if (!para.path.startsWith('/admin')) return

  // antes do primeiro `await`: o contexto do Nuxt é o da chamada
  const nuxtApp = useNuxtApp()
  const { data } = await useFetch('/api/auth/eu', { key: 'auth-eu' })
  if (import.meta.client && !nuxtApp.isHydrating && para.path !== de?.path) {
    try {
      data.value = await $fetch<any>('/api/auth/eu', { timeout: 4000, retry: 0 })
    } catch {
      // sem resposta do servidor: fica o que já se sabia (ver acima)
    }
  }
  if (!data.value?.usuario) {
    return navigateTo(`/entrar?de=${encodeURIComponent(para.fullPath)}`)
  }
  // senha provisória da Equipe ainda não trocada: cria a própria antes de qualquer tela
  if (data.value.usuario.trocarSenha) {
    return navigateTo(`/entrar?trocar=1&de=${encodeURIComponent(para.fullPath)}`)
  }
})
