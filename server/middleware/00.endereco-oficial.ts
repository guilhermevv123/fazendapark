/**
 * 00.endereco-oficial — página aberta fora do endereço oficial vai pro oficial (05/10).
 *
 * O login do cliente travava com "Origem não autorizada" quando a pessoa estava no endereço antigo
 * do EasyPanel (`*.easypanel.host`, que ficou em e-mail, QR e link antigos) ou no domínio sem
 * `www.`: a conta é aberta por mutação, e a mutação só vale vinda do endereço do `PUBLIC_BASE_URL`.
 * Em vez de abrir a porta, a PÁGINA vai pro endereço certo e tudo acontece lá.
 *
 * Só GET/HEAD de página, só em produção, só os hosts que sabemos que são nossos (o gêmeo com/sem
 * `www.` e o do EasyPanel). `/api/*` não muda de lugar: o webhook do Asaas é POST no host antigo,
 * e a saúde do container chama 127.0.0.1.
 */
import { getRequestHeader, sendRedirect } from 'h3'
import { enderecoOficial, hostGemeo } from '../utils/caminho'

export default defineEventHandler((event) => {
  if (process.env.NODE_ENV !== 'production') return
  if (event.method !== 'GET' && event.method !== 'HEAD') return
  if (event.path.startsWith('/api/')) return
  const oficial = enderecoOficial()
  if (!oficial) return
  const host = String(getRequestHeader(event, 'host') ?? '').toLowerCase().replace(/:\d+$/, '')
  if (!host || host === oficial.hostname) return
  if (host !== hostGemeo(oficial.hostname) && !host.endsWith('.easypanel.host')) return
  return sendRedirect(event, `${oficial.origin}${event.path}`, 301)
})
