/**
 * Guarda de rota do navegador para tudo sob /admin.
 *
 * Isto é conveniência, NÃO segurança: quem tranca de verdade é o middleware
 * do servidor, porque o do navegador qualquer um desliga no DevTools. O papel
 * daqui é só evitar que a tela pisque carregada e depois estoure 401 em cada
 * chamada — o que faz o operador achar que o sistema quebrou quando ele
 * apenas não está logado.
 */
export default defineNuxtRouteMiddleware(async (para) => {
  if (!para.path.startsWith('/admin')) return

  const { data } = await useFetch('/api/auth/eu', { key: 'auth-eu' })
  if (!data.value?.usuario) {
    return navigateTo(`/entrar?de=${encodeURIComponent(para.fullPath)}`)
  }
})
