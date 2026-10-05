/**
 * Liga o trabalhador do ingresso pelo WhatsApp (038). Só roda com UAZAPI_URL + UAZAPI_TOKEN no
 * ambiente — sem eles o plugin só avisa que está desligado e nada sai.
 */
import { configDoWhatsapp, garantirWorkerDoWhatsapp, pararWorkerDoWhatsapp } from '../utils/whatsapp-ingresso'

export default defineNitroPlugin((nitro) => {
  const cfg = configDoWhatsapp()
  const ligou = garantirWorkerDoWhatsapp()
  console.log(`[whatsapp] ingresso pelo WhatsApp ${ligou ? 'ligado' : 'desligado'}`
    + (ligou && cfg.soPara.length ? ` (modo de teste: só ${cfg.soPara.length} número(s))` : ''))
  nitro.hooks.hook('close', () => pararWorkerDoWhatsapp())
})
