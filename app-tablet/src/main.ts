import { ClientOnly, NuxtLink } from './nuxt'
import '@fontsource-variable/geist/index.css'
import '@fontsource-variable/geist-mono/index.css'
import '~/assets/base.css'
import { createApp } from 'vue'
import { createRouter, createWebHashHistory } from 'vue-router'
// componentes que o Nuxt registra sozinho e as telas da comanda usam sem importar
import IconeMenu from '~/components/IconeMenu.vue'
import ModalLateral from '~/components/ModalLateral.vue'
import App from './App.vue'
import Comandas from './Comandas.vue'
import { ligarNfc } from './nfc'

const router = createRouter({
  history: createWebHashHistory(),
  routes: [{ path: '/', component: Comandas }, { path: '/:resto(.*)*', redirect: '/' }],
})

createApp(App)
  .use(router)
  .component('NuxtLink', NuxtLink)
  .component('ClientOnly', ClientOnly)
  .component('ModalLateral', ModalLateral)
  .component('IconeMenu', IconeMenu)
  .mount('#app')

// NFC do próprio tablet (só no app Android); o leitor USB funciona sozinho, como teclado
ligarNfc()
