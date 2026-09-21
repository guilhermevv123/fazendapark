/**
 * O título da aba: "<tela> · Conquista Park", como no site do parque
 * (`title.template` do sistemapark). Tela sem título próprio fica só com o nome.
 *
 * É plugin, e não `app.head.titleTemplate` no nuxt.config, porque o template é
 * uma FUNÇÃO e o `app.head` do config é serializado — a função se perdia no
 * caminho e a aba mostrava só "Entrar", sem o nome do parque.
 */
export default defineNuxtPlugin(() => {
  useHead({
    titleTemplate: (titulo?: string) =>
      titulo && titulo !== 'Conquista Park' ? `${titulo} · Conquista Park` : 'Conquista Park',
  })
})
