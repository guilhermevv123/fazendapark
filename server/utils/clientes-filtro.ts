/**
 * clientes-filtro.ts — o recorte da lista de clientes, num lugar só.
 *
 * A lista da tela e a exportação em planilha precisam falar da MESMA gente:
 * exportar "quem aceita novidades de Salvador" e receber a base inteira (ou o
 * contrário) é o erro que só aparece quando a mensagem já saiu. Por isso os dois
 * leem o filtro daqui, e nenhum monta SQL de filtro por conta própria.
 *
 * Quem chama passa o alias `cu` para `customers`. O `WHERE` devolvido SEMPRE
 * começa em `cu.org_id = $1`: a base de clientes é da organização da sessão, e
 * a ficha de outra organização não pode aparecer por filtro nenhum.
 */
import { FAIXAS_ETARIAS, SQL_FAIXA } from './cadastro'
import { PEDIDO_VIVO } from './liquido'

export class FiltroInvalido extends Error {}

export const SITUACOES = ['compraram', 'so_tentaram'] as const

const UF = /^[A-Z]{2}$/

/** `%` e `_` são curinga do LIKE: o que a pessoa digita é texto, não padrão. */
const semCuringa = (s: string) => s.replace(/[\\%_]/g, '\\$&')

const texto = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

export function filtroDeClientes(
  orgId: string, f: Record<string, unknown>,
): { onde: string; params: any[] } {
  const params: any[] = [orgId]
  const cond = ['cu.org_id = $1']
  const p = (v: unknown) => { params.push(v); return `$${params.length}` }

  const busca = texto(f.q).replace(/^@+/, '')
  if (busca) {
    const nome = p(`%${semCuringa(busca)}%`)
    const partes = [`cu.name ILIKE ${nome}`, `cu.email ILIKE ${nome}`, `cu.instagram ILIKE ${nome}`]
    // CPF e telefone se procuram por dígito: "(73) 99826" e "73998260963" são o mesmo
    const digitos = busca.replace(/\D/g, '')
    if (digitos.length >= 3) {
      const d = p(`%${digitos}%`)
      partes.push(`cu.document LIKE ${d}`, `cu.phone LIKE ${d}`)
    }
    cond.push(`(${partes.join(' OR ')})`)
  }

  const uf = texto(f.uf).toUpperCase()
  if (uf) {
    if (!UF.test(uf)) throw new FiltroInvalido('Estado inválido. Use a sigla, como BA.')
    cond.push(`cu.state = ${p(uf)}`)
  }

  const cidade = texto(f.cidade)
  if (cidade) cond.push(`cu.city = ${p(cidade)}`)

  const faixa = texto(f.faixa)
  if (faixa) {
    if (!FAIXAS_ETARIAS.some((x) => x.chave === faixa)) {
      throw new FiltroInvalido('Faixa de idade inválida.')
    }
    cond.push(`${SQL_FAIXA('cu.birth_date')} = ${p(faixa)}`)
  }

  // "aceita novidades" é consentimento (LGPD), não conveniência: quem vai
  // mandar divulgação filtra por aqui, então este recorte tem que ser exato
  if (texto(f.novidades) === '1') cond.push('cu.marketing_opt_in')
  if (texto(f.cadastro) === '1') cond.push('cu.registered_at IS NOT NULL')

  const situacao = texto(f.situacao)
  if (situacao) {
    if (!(SITUACOES as readonly string[]).includes(situacao)) {
      throw new FiltroInvalido('Situação inválida.')
    }
    const comprou = `EXISTS (SELECT 1 FROM orders o
                              WHERE o.customer_id = cu.id AND ${PEDIDO_VIVO('o.')})`
    cond.push(situacao === 'compraram' ? comprou : `NOT ${comprou}`)
  }

  return { onde: cond.join(' AND '), params }
}
