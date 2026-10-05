/**
 * Painel dos agentes — o sistema do parque pergunta à automação (n8n) o que a Sofia está fazendo.
 *
 * ## Por que via n8n e não direto no banco da Sofia
 *
 * As conversas moram no Postgres da automação (Supabase), e a senha dele vive só dentro do n8n,
 * junto com a chave da OpenAI que escreve os resumos. O n8n expõe uma API SÓ DE LEITURA
 * (`FAZENDA PARK · API do painel dos agentes`, fonte em `conquista-park/scripts/build_painel_api.py`
 * no vault) protegida por um token de cabeçalho. Quem guarda o token é este servidor — ele NUNCA
 * vai pro navegador: a tela fala com `/api/admin/agentes/*`, que é área `agentes` (só master).
 *
 * Configuração (env): `AGENTES_API_URL` (o webhook) e `AGENTES_API_TOKEN`. Sem os dois, as rotas
 * respondem 503 com o recado de o que falta — tela que diz "sem conversa" quando na verdade não
 * está ligada é o defeito da tela que afirma com tranquilidade algo falso.
 */
export type AcaoDoPainel = 'visao' | 'conversa' | 'resumo' | 'saude' | 'comentarios'

export class PainelNaoConfigurado extends Error {}
export class PainelForaDoAr extends Error {
  constructor(msg: string, public status?: number) { super(msg) }
}

const PACIENCIA_MS: Record<AcaoDoPainel, number> = {
  visao: 20_000,
  conversa: 20_000,
  saude: 25_000,
  comentarios: 20_000,
  // o resumo chama a OpenAI quando não tem cache — é a única que pode demorar
  resumo: 60_000,
}

export function painelConfigurado(): boolean {
  return !!(process.env.AGENTES_API_URL && process.env.AGENTES_API_TOKEN)
}

export async function perguntarAoPainel<T = any>(acao: AcaoDoPainel, extra: Record<string, string> = {}): Promise<T> {
  const url = process.env.AGENTES_API_URL
  const token = process.env.AGENTES_API_TOKEN
  if (!url || !token) throw new PainelNaoConfigurado('AGENTES_API_URL/AGENTES_API_TOKEN ausentes')
  try {
    return await $fetch<T>(url, {
      query: { acao, ...extra },
      headers: { 'x-painel-token': token },
      timeout: PACIENCIA_MS[acao],
      retry: 0,
    })
  } catch (e: any) {
    const status = e?.response?.status ?? e?.statusCode
    throw new PainelForaDoAr(status ? `a automação respondeu ${status}` : 'a automação não respondeu a tempo', status)
  }
}

/** Traduz a falha pro recado que a tela mostra — o que houve e o que fazer. */
export function erroDoPainel(e: unknown) {
  if (e instanceof PainelNaoConfigurado) {
    return createError({
      statusCode: 503,
      statusMessage: 'O painel dos agentes ainda não foi ligado neste servidor: falta configurar '
        + 'AGENTES_API_URL e AGENTES_API_TOKEN. Os agentes continuam atendendo normalmente.',
    })
  }
  if (e instanceof PainelForaDoAr) {
    if (e.status === 403) {
      return createError({
        statusCode: 502,
        statusMessage: 'A automação recusou o token deste servidor (AGENTES_API_TOKEN diferente do que está no n8n).',
      })
    }
    return createError({
      statusCode: 502,
      statusMessage: `Não consegui ler a automação agora (${e.message}). Os agentes podem estar `
        + 'funcionando normalmente — tente de novo em 1 minuto.',
    })
  }
  return e
}

/* ------------------------------------------------- base de conhecimento (05/10) */

/**
 * A BASE DE CONHECIMENTO dos robôs (Inteligência → Base de conhecimento): o que a equipe escreve aqui
 * vale na próxima mensagem de todo robô (WhatsApp, Instagram, comentários) — cada um lê a tabela
 * `fp_conhecimento` no nó "Base do painel". Diferente da API acima, esta GRAVA: é outro webhook do n8n
 * (`FAZENDA PARK · Base de conhecimento (API do painel)`, fonte `conquista-park/scripts/build_base_api.py`),
 * com o MESMO token. O endereço sai de `AGENTES_BASE_URL` ou, sem ele, do `AGENTES_API_URL` trocando o
 * caminho — não precisa de variável nova no servidor.
 */
export type AcaoDaBase = 'listar' | 'salvar' | 'arquivar' | 'revisar' | 'testar' | 'resultado'

const PACIENCIA_BASE_MS: Record<AcaoDaBase, number> = {
  listar: 20_000, salvar: 20_000, arquivar: 20_000, testar: 25_000, resultado: 45_000,
  // a revisão chama a OpenAI
  revisar: 60_000,
}

export function urlDaBase(env: Record<string, string | undefined> = process.env): string | null {
  if (env.AGENTES_BASE_URL) return env.AGENTES_BASE_URL
  const api = env.AGENTES_API_URL
  if (!api) return null
  return api.replace(/fazenda-park-painel-agentes\/?$/, 'fazenda-park-painel-base')
}

export async function perguntarABase<T = any>(acao: AcaoDaBase, corpo: Record<string, unknown> = {}): Promise<T> {
  const url = urlDaBase()
  const token = process.env.AGENTES_API_TOKEN
  if (!url || !token || url === process.env.AGENTES_API_URL) {
    throw new PainelNaoConfigurado('AGENTES_API_URL/AGENTES_API_TOKEN ausentes')
  }
  try {
    return await $fetch<T>(url, {
      method: 'POST',
      body: { acao, ...corpo },
      headers: { 'x-painel-token': token },
      timeout: PACIENCIA_BASE_MS[acao],
      retry: 0,
    })
  } catch (e: any) {
    const status = e?.response?.status ?? e?.statusCode
    // 400 é recusa de CONTEÚDO (falta o título, data inválida): o recado da automação vai pra tela
    if (status === 400) {
      throw createError({ statusCode: 400, statusMessage: String(e?.data?.erro || 'pedido inválido') })
    }
    throw new PainelForaDoAr(status ? `a automação respondeu ${status}` : 'a automação não respondeu a tempo', status)
  }
}
