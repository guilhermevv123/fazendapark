import { encerrarSessao } from '../../utils/sessao'

export default defineEventHandler(async (event) => {
  await encerrarSessao(event)
  return { ok: true }
})
