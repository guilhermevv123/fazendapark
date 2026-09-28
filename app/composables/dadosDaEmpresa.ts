/**
 * dadosDaEmpresa.ts — CNPJ, CEP, telefone e endereço da ORGANIZAÇÃO: conferência e formato.
 *
 * O site de vendas passou a mostrar os dados da empresa (Decreto 7.962/2013; auditoria PROD-08) e
 * as Configurações passaram a pedir esses dados com máscara e conferência de dígito (CFG-02). A
 * mesma regra vale nas duas pontas — a tela avisa enquanto digita, a rota recusa com frase — e por
 * isso mora aqui, num arquivo puro que o servidor também importa (como `formato.ts`).
 *
 * **CNPJ alfanumérico.** Desde julho de 2026 a Receita emite CNPJ com letras nas 12 primeiras
 * posições (os 2 dígitos verificadores continuam números). A conta é a mesma de sempre, com cada
 * caractere valendo o código ASCII − 48 ('0'..'9' → 0..9, 'A' → 17 … 'Z' → 42). Uma conferência só
 * numérica recusaria um CNPJ novo e verdadeiro — e o dono não teria como cadastrar a empresa.
 */
import { cpfValido } from '../../server/utils/documento'

/** Só os dígitos de um texto (máscara, espaço e pontuação fora). */
export function somenteDigitos(v: unknown): string {
  return String(v ?? '').replace(/\D/g, '')
}

/** CNPJ sem máscara, em maiúsculas: 12 posições alfanuméricas + 2 dígitos. */
function cnpjCru(v: unknown): string {
  return String(v ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '')
}

function digitoDoCnpj(base: string): number {
  const pesos = base.length === 12
    ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
    : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
  const soma = [...base].reduce((s, c, i) => s + (c.charCodeAt(0) - 48) * pesos[i]!, 0)
  const resto = soma % 11
  return resto < 2 ? 0 : 11 - resto
}

/** CNPJ (numérico ou alfanumérico) com os dois dígitos verificadores certos. */
export function cnpjValido(v: unknown): boolean {
  const c = cnpjCru(v)
  if (!/^[0-9A-Z]{12}[0-9]{2}$/.test(c)) return false
  // os repetidos passam na conta e são o "só pra preencher" clássico
  if (/^(.)\1{13}$/.test(c)) return false
  const d1 = digitoDoCnpj(c.slice(0, 12))
  const d2 = digitoDoCnpj(c.slice(0, 12) + d1)
  return c.endsWith(`${d1}${d2}`)
}

/** CPF ou CNPJ válido — é o que o campo "CNPJ ou CPF" da organização aceita. */
/**
 * O CNPJ que a instalação grava de exemplo (`scripts/seed.mjs`): 00.000.000/0001-91 é o do Banco
 * do Brasil. Ninguém o preencheu no painel — mostrado no rodapé, o site diria que quem vende é um
 * banco. O site trata como AUSENTE e a tela de Dados e cobrança pede pra trocar.
 */
export const DOCUMENTO_DE_EXEMPLO = '00000000000191'
export function ehDocumentoDeExemplo(v: unknown): boolean {
  return cnpjCru(v) === DOCUMENTO_DE_EXEMPLO
}

export function documentoDaEmpresaValido(v: unknown): boolean {
  const cru = cnpjCru(v)
  if (cru.length === 14) return cnpjValido(cru)
  if (/^\d{11}$/.test(cru)) return cpfValido(cru)
  return false
}

/** O documento como se escreve: 12.345.678/0001-90 ou 123.456.789-09. Fora do tamanho, como veio. */
export function formatarDocumento(v: unknown): string {
  const c = cnpjCru(v)
  if (c.length === 14) return `${c.slice(0, 2)}.${c.slice(2, 5)}.${c.slice(5, 8)}/${c.slice(8, 12)}-${c.slice(12)}`
  if (/^\d{11}$/.test(c)) return `${c.slice(0, 3)}.${c.slice(3, 6)}.${c.slice(6, 9)}-${c.slice(9)}`
  return String(v ?? '').trim()
}

/**
 * A máscara enquanto se digita: aceita letra só onde o CNPJ novo aceita (as 12 primeiras
 * posições) e monta a pontuação conforme o tamanho — 11 dígitos puros ainda são um CPF possível.
 */
export function mascaraDocumento(v: unknown): string {
  const c = cnpjCru(v).slice(0, 14)
  if (/^\d{0,11}$/.test(c)) {
    // até 11 dígitos: vai montando como CPF (000.000.000-00)
    const p = [c.slice(0, 3), c.slice(3, 6), c.slice(6, 9)].filter(Boolean).join('.')
    return c.length > 9 ? `${p}-${c.slice(9)}` : p
  }
  const partes = [c.slice(0, 2), c.slice(2, 5), c.slice(5, 8)].filter(Boolean).join('.')
  const filial = c.slice(8, 12)
  const dv = c.slice(12)
  return partes + (filial ? `/${filial}` : '') + (dv ? `-${dv}` : '')
}

/** 45590-000 */
export function formatarCep(v: unknown): string {
  const d = somenteDigitos(v)
  return d.length === 8 ? `${d.slice(0, 5)}-${d.slice(5)}` : String(v ?? '').trim()
}

/** (73) 99812-3456 ou (73) 3281-1234 — só com DDD, que é o que o banco aceita. */
export function formatarTelefoneBR(v: unknown): string {
  const d = somenteDigitos(v)
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`
  return String(v ?? '').trim()
}

export interface EnderecoDaEmpresa {
  linha?: string | null
  bairro?: string | null
  cidade?: string | null
  uf?: string | null
  cep?: string | null
}

/**
 * O endereço em até duas linhas, pulando o que está vazio — o site OMITE o que não foi
 * preenchido (nunca escreve "a preencher" pro público, nunca inventa).
 */
export function linhasDoEndereco(e: EnderecoDaEmpresa | null | undefined): string[] {
  if (!e) return []
  const primeira = [e.linha, e.bairro].map((x) => String(x ?? '').trim()).filter(Boolean).join(' — ')
  const cidade = [String(e.cidade ?? '').trim(), String(e.uf ?? '').trim()].filter(Boolean).join('/')
  const segunda = [cidade, e.cep ? `CEP ${formatarCep(e.cep)}` : ''].filter(Boolean).join(' · ')
  return [primeira, segunda].filter(Boolean)
}

/** Como o comprador fala com o parque: texto pra ler e link pra tocar (e-mail, telefone, WhatsApp). */
export function linkDeContato(tipo: string, valor: string): { rotulo: string; texto: string; href: string } {
  const v = String(valor ?? '').trim()
  if (tipo === 'email' || v.includes('@')) return { rotulo: 'E-mail', texto: v, href: `mailto:${v}` }
  let d = somenteDigitos(v)
  if (d.length > 11 && d.startsWith('55')) d = d.slice(2)
  if (tipo === 'whatsapp') return { rotulo: 'WhatsApp', texto: formatarTelefoneBR(d), href: `https://wa.me/55${d}` }
  return { rotulo: 'Telefone', texto: formatarTelefoneBR(d), href: `tel:+55${d}` }
}

/** O mesmo, ou `null` quando o campo está vazio — o site omite a linha em vez de inventar. */
export function linhaDeContatoOuNada(tipo: string, valor: string | null | undefined) {
  return String(valor ?? '').trim() ? linkDeContato(tipo, String(valor)) : null
}

/** O que `/api/organizacao-publica` devolve (só o que foi preenchido vem). */
export interface EmpresaPublica {
  nome?: string
  razaoSocial?: string
  documento?: string
  endereco?: EnderecoDaEmpresa
  email?: string
  telefone?: string
  encarregado?: string
  contatosDosEventos?: { tipo: string; valor: string }[]
}

/**
 * "Quem vende" pronto pra tela: o rodapé e as páginas de termos, privacidade e cancelamento
 * mostram o MESMO bloco. `canais` é o atendimento da empresa; sem ele, o contato de suporte dos
 * eventos publicados (reserva) — e `canaisSaoDosEventos` diz qual dos dois a tela está mostrando.
 */
export function resumoDaEmpresa(e: EmpresaPublica | null | undefined) {
  const documento = e?.documento
    ? { rotulo: String(e.documento).length === 11 ? 'CPF' : 'CNPJ', texto: formatarDocumento(e.documento) }
    : null
  const daEmpresa = [linhaDeContatoOuNada('email', e?.email), linhaDeContatoOuNada('telefone', e?.telefone)]
    .filter((c): c is NonNullable<typeof c> => !!c)
  const dosEventos = daEmpresa.length ? [] : (e?.contatosDosEventos ?? []).map((c) => linkDeContato(c.tipo, c.valor))
  return {
    nomeLegal: e?.razaoSocial ?? e?.nome ?? null,
    nomeFantasia: e?.razaoSocial && e?.nome && e.nome !== e.razaoSocial ? e.nome : null,
    documento,
    endereco: linhasDoEndereco(e?.endereco),
    canais: daEmpresa.length ? daEmpresa : dosEventos,
    canaisSaoDosEventos: !daEmpresa.length && dosEventos.length > 0,
    encarregado: e?.encarregado ?? null,
  }
}
