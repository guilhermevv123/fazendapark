/**
 * Base de conhecimento dos robôs (05/10) — o formato de um item, conferido antes de ir pra automação.
 * A regra de conteúdo (título obrigatório, dia pro "dia fechado", "vale até" depois de "vale de")
 * mora na automação — `build_base_api.py` no vault — e é ela que responde 400 com o recado.
 */
export const TIPOS_DA_BASE = ['informacao', 'aviso', 'dia_fechado', 'dia_aberto'] as const
export type TipoDaBase = typeof TIPOS_DA_BASE[number]
export const CANAIS_DA_BASE = ['whatsapp', 'instagram', 'comentarios'] as const
export const UUID_DA_BASE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type ItemDaBase = {
  id: string; tipo: TipoDaBase; titulo: string; texto: string
  dia: string; vale_de: string; vale_ate: string; canais: string[]; ativo: boolean
}

const DATA = /^\d{4}-\d{2}-\d{2}$/

export function lerItemDaBase(bruto: unknown): ItemDaBase {
  const it = (bruto && typeof bruto === 'object' ? bruto : {}) as Record<string, unknown>
  const recusa = (m: string) => createError({ statusCode: 400, statusMessage: m })
  const tipo = String(it.tipo ?? 'informacao') as TipoDaBase
  if (!TIPOS_DA_BASE.includes(tipo)) throw recusa('Tipo inválido.')
  const id = String(it.id ?? '')
  if (id && !UUID_DA_BASE.test(id)) throw recusa('Item inválido.')
  const data = (v: unknown) => {
    const s = String(v ?? '').trim()
    if (s && !DATA.test(s)) throw recusa('Data inválida.')
    return s
  }
  const canais = Array.isArray(it.canais) ? it.canais.map(String).filter((c) => (CANAIS_DA_BASE as readonly string[]).includes(c)) : [...CANAIS_DA_BASE]
  return {
    id, tipo,
    titulo: String(it.titulo ?? '').trim().slice(0, 120),
    texto: String(it.texto ?? '').trim().slice(0, 1500),
    dia: data(it.dia), vale_de: data(it.vale_de), vale_ate: data(it.vale_ate),
    canais, ativo: it.ativo !== false,
  }
}

/** Quem escreveu, pro histórico: o nome e o e-mail de quem está logado — nunca o que veio no corpo. */
export function autorDaSessao(s: { nome?: string; email?: string } | undefined): string {
  return [s?.nome, s?.email && `<${s.email}>`].filter(Boolean).join(' ').slice(0, 120)
}
