/**
 * cadastro.ts — o que o formulário do site guarda sobre quem compra.
 *
 * O ingresso só precisa de nome, e-mail, CPF e celular. O PARQUE quer mais:
 * de onde vem quem compra, que idade tem, como chamar no Instagram — pra falar
 * com essa gente depois (follow-up, remarketing). Este arquivo é a única porta
 * por onde esses dados entram: o checkout chama `prepararCadastro` ANTES de abrir
 * a transação, e o que sai daqui já sai limpo (UF em maiúsculas, CEP só com
 * dígitos, Instagram sem @). Não é capricho: os relatórios agrupam por esse
 * texto, e "ba", "Ba" e "BA" viram três linhas.
 *
 * Puro de propósito — sem banco e sem Nitro. Dá pra testar sem servidor no ar.
 */

export class CadastroInvalido extends Error {
  constructor(public campo: string, mensagem: string) {
    super(mensagem)
    this.name = 'CadastroInvalido'
  }
}

export const UFS = [
  'AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA',
  'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO',
] as const

/** Corta as pontas e junta espaço repetido; vazio vira `null`. */
function limpar(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = v.replace(/\s+/g, ' ').trim()
  return t === '' ? null : t
}

/**
 * "SALVADOR" e "salvador" viram "Salvador"; "Vitória da Conquista" fica como
 * veio. Só mexe quando o texto está TODO em uma caixa: quem digitou com
 * maiúscula e minúscula misturadas sabia o que queria (McDonald, D'Ávila).
 */
export function nomeProprio(texto: string): string {
  const t = limpar(texto) ?? ''
  if (t !== t.toLowerCase() && t !== t.toUpperCase()) return t
  const particulas = new Set(['de', 'da', 'do', 'das', 'dos', 'e'])
  return t.toLowerCase().split(' ')
    .map((p, i) => (i > 0 && particulas.has(p) ? p : p.charAt(0).toUpperCase() + p.slice(1)))
    .join(' ')
}

// ------------------------------------------------------------- nascimento

/** Hoje no relógio LOCAL (`toISOString` converte pra UTC e às 21h vira amanhã). */
function hojeLocal(agora: Date): { ano: number; mes: number; dia: number } {
  return { ano: agora.getFullYear(), mes: agora.getMonth() + 1, dia: agora.getDate() }
}

/**
 * Recebe `AAAA-MM-DD` (a página converte o `dd/mm/aaaa` que a pessoa digita) e
 * devolve o mesmo texto se for uma data que existe, não for no futuro e não for
 * de mais de 120 anos atrás. O banco só tem o piso de 1900 (um CHECK não pode
 * conter "hoje"); o resto é aqui.
 */
export function validarNascimento(iso: string, agora: Date = new Date()): string {
  const invalida = () => new CadastroInvalido('nascimento',
    'Confira a data de nascimento: digite dia, mês e ano (ex.: 25/12/1990).')
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim())
  if (!m) throw invalida()
  const [ano, mes, dia] = [Number(m[1]), Number(m[2]), Number(m[3])]
  // `new Date(2026, 1, 31)` vira 3 de março em vez de recusar; conferir de volta
  const d = new Date(Date.UTC(ano, mes - 1, dia))
  if (d.getUTCFullYear() !== ano || d.getUTCMonth() !== mes - 1 || d.getUTCDate() !== dia) {
    throw invalida()
  }
  const h = hojeLocal(agora)
  const numero = (a: number, mm: number, dd: number) => a * 10000 + mm * 100 + dd
  if (numero(ano, mes, dia) > numero(h.ano, h.mes, h.dia)) {
    throw new CadastroInvalido('nascimento', 'A data de nascimento está no futuro. Confira o ano.')
  }
  if (ano < 1900 || h.ano - ano > 120) {
    throw new CadastroInvalido('nascimento', 'Confira o ano de nascimento.')
  }
  return `${m[1]}-${m[2]}-${m[3]}`
}

// -------------------------------------------------------------- instagram

/**
 * Aceita `@nome`, `nome` e o link colado (`instagram.com/nome/?igsh=…`);
 * guarda só `nome`, minúsculo — a regra do próprio Instagram (letras, números,
 * ponto e sublinhado, até 30). Vazio não é erro: o campo é opcional.
 */
export function normalizarInstagram(bruto: string | null | undefined): string | null {
  const s = limpar(bruto)
  if (!s) return null
  let u = s.toLowerCase()
  const link = /instagram\.com\/([^/?#\s]+)/.exec(u)
  if (link) u = link[1]
  u = u.replace(/^@+/, '')
  if (!/^[a-z0-9._]{1,30}$/.test(u)) {
    throw new CadastroInvalido('instagram',
      'Confira o Instagram: só letras, números, ponto e sublinhado (ex.: @seunome).')
  }
  return u
}

// --------------------------------------------------------------- endereço

export interface Endereco {
  cep: string | null
  rua: string | null
  numero: string | null
  bairro: string | null
  cidade: string
  estado: string
  complemento: string | null
}

export interface EnderecoBruto {
  cep?: string | null
  rua?: string | null
  numero?: string | null
  bairro?: string | null
  cidade?: string | null
  estado?: string | null
  complemento?: string | null
}

/**
 * O mínimo que serve pra falar com uma região é cidade + UF; o resto ajuda mas
 * não trava. Tudo vazio → `null` (a pessoa não preencheu endereço nenhum).
 * Qualquer coisa preenchida sem cidade e UF é recusada, senão a linha entraria
 * no banco sem servir a nenhum relatório.
 */
export function normalizarEndereco(e: EnderecoBruto | null | undefined): Endereco | null {
  if (!e) return null
  const cep = limpar(e.cep)?.replace(/\D/g, '') ?? null
  const rua = limpar(e.rua)
  const numero = limpar(e.numero)
  const bairro = limpar(e.bairro)
  const cidade = limpar(e.cidade)
  const uf = limpar(e.estado)?.toUpperCase() ?? null
  const complemento = limpar(e.complemento)
  if (!cep && !rua && !numero && !bairro && !cidade && !uf && !complemento) return null

  if (cep && cep.length !== 8) {
    throw new CadastroInvalido('cep', 'Confira o CEP: são 8 números (ex.: 45000-000).')
  }
  if (!cidade || cidade.length < 2) {
    throw new CadastroInvalido('cidade', 'Diga em que cidade você mora.')
  }
  if (!uf || !(UFS as readonly string[]).includes(uf)) {
    throw new CadastroInvalido('estado', 'Escolha o estado (a sigla, ex.: BA).')
  }
  return { cep, rua, numero, bairro, cidade: nomeProprio(cidade), estado: uf, complemento }
}

// ------------------------------------------------------------------ senha

/**
 * O bcrypt lê só os 72 primeiros bytes: senha maior que isso seria cortada em
 * silêncio, e duas senhas diferentes passariam a valer a mesma. Recusar é mais
 * honesto que truncar.
 */
export function validarSenha(senha: string, quem: { email: string; documento: string }): void {
  if (senha.length < 8) {
    throw new CadastroInvalido('senha', 'A senha precisa ter pelo menos 8 caracteres.')
  }
  if (new TextEncoder().encode(senha).length > 72) {
    throw new CadastroInvalido('senha', 'A senha é longa demais: use até 72 caracteres.')
  }
  const s = senha.toLowerCase()
  const email = quem.email.toLowerCase()
  const doc = quem.documento.replace(/\D/g, '')
  if (s === email || s === email.split('@')[0] || s.replace(/\D/g, '') === doc) {
    throw new CadastroInvalido('senha', 'A senha não pode ser o seu e-mail nem o seu CPF.')
  }
  if (/^(.)\1+$/.test(senha)) {
    throw new CadastroInvalido('senha', 'Escolha uma senha menos óbvia (não vale repetir a mesma letra).')
  }
}

// ---------------------------------------------------------------- conjunto

export interface CadastroBruto {
  nascimento?: string | null
  instagram?: string | null
  endereco?: EnderecoBruto | null
  senha?: string | null
  aceitaNovidades?: boolean | null
}

export interface Cadastro {
  nascimento: string | null
  instagram: string | null
  endereco: Endereco | null
  senha: string | null
  /** `null` = a pessoa não se manifestou: o banco NÃO muda o consentimento que já tinha. */
  aceitaNovidades: boolean | null
}

/**
 * Valida e limpa tudo de uma vez. Lança `CadastroInvalido` no primeiro problema
 * (com o `campo`, pra a página marcar o lugar certo). Nada é gravado aqui.
 */
export function prepararCadastro(
  bruto: CadastroBruto,
  quem: { email: string; documento: string },
  agora: Date = new Date(),
): Cadastro {
  const nasc = limpar(bruto.nascimento)
  const senha = bruto.senha == null || bruto.senha === '' ? null : bruto.senha
  if (senha !== null) validarSenha(senha, quem)
  return {
    nascimento: nasc ? validarNascimento(nasc, agora) : null,
    instagram: normalizarInstagram(bruto.instagram),
    endereco: normalizarEndereco(bruto.endereco),
    senha,
    aceitaNovidades: typeof bruto.aceitaNovidades === 'boolean' ? bruto.aceitaNovidades : null,
  }
}

// ------------------------------------------------------ leitura (relatórios)

/** `***.456.789-**`: o painel lista o CPF assim; inteiro só na ficha do cliente. */
export function cpfMascarado(documento: string | null | undefined): string {
  const d = (documento ?? '').replace(/\D/g, '')
  return d.length === 11 ? `***.${d.slice(3, 6)}.${d.slice(6, 9)}-**` : '—'
}

/**
 * As faixas de idade moram numa lista só, e o SQL dos relatórios é GERADO dela.
 * Duas tabelas de corte (uma no `CASE` do SQL, outra no rótulo da tela) é o jeito
 * de a tela dizer "18 a 24" sobre gente que o banco contou como "25 a 34".
 */
export const FAIXAS_ETARIAS = [
  { chave: 'ate17', rotulo: 'Até 17', de: 0, ate: 17 },
  { chave: '18a24', rotulo: '18 a 24', de: 18, ate: 24 },
  { chave: '25a34', rotulo: '25 a 34', de: 25, ate: 34 },
  { chave: '35a44', rotulo: '35 a 44', de: 35, ate: 44 },
  { chave: '45a59', rotulo: '45 a 59', de: 45, ate: 59 },
  { chave: '60mais', rotulo: '60 ou mais', de: 60, ate: null as number | null },
] as const

/** Idade em anos completos de uma coluna `date` (é `age()` do Postgres: já conta aniversário). */
export const SQL_IDADE = (coluna: string) => `date_part('year', age(${coluna}))::int`

/** `'ate17' | '18a24' | …` da coluna, ou NULL quando a pessoa não informou a data. */
export function SQL_FAIXA(coluna: string): string {
  const idade = SQL_IDADE(coluna)
  const ramos = FAIXAS_ETARIAS.map((f) =>
    f.ate === null
      ? `WHEN ${idade} >= ${f.de} THEN '${f.chave}'`
      : `WHEN ${idade} BETWEEN ${f.de} AND ${f.ate} THEN '${f.chave}'`)
  return `CASE WHEN ${coluna} IS NULL THEN NULL ${ramos.join(' ')} END`
}
