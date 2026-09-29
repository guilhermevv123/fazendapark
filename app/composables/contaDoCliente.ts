/**
 * A conta de quem compra, do lado da tela (034).
 *
 * Um estado só (`useState`) pra o site inteiro: o cabeçalho mostra "Entrar" ou o nome, a janela
 * de entrar abre de qualquer tela, e o checkout espera a conta pra seguir. Quem decide se a pessoa
 * está dentro é o servidor (`/api/conta/eu`) — o cookie é `httpOnly` e esta tela nunca o lê.
 */

export interface ContaNaTela {
  nome: string
  primeiroNome: string
  email: string
  cpf: string
  telefone: string
  instagram: string | null
  endereco: {
    cep: string | null; rua: string | null; numero: string | null; bairro: string | null
    cidade: string | null; estado: string | null; complemento: string | null
  }
  aceitaNovidades: boolean
  temSenha: boolean
  google: boolean
  apple: boolean
}

interface EstadoDaConta {
  carregada: boolean
  conta: ContaNaTela | null
  exigeConta: boolean
  social: { google: boolean; apple: boolean }
  /** o evento da tela (a conta é da organização DELE) */
  evento: string | null
}

export type AbaDaConta = 'entrar' | 'criar'

// a leitura em andamento (só no navegador): o cabeçalho e a tela pedem juntos, sai UMA requisição
let emVoo: { evento: string | null; promessa: Promise<EstadoDaConta> } | null = null

export function useContaDoCliente() {
  const estado = useState<EstadoDaConta>('conta-do-cliente', () => ({
    carregada: false, conta: null, exigeConta: false, social: { google: false, apple: false }, evento: null,
  }))
  const janela = useState<{ aberta: boolean; aba: AbaDaConta; motivo: string | null }>('janela-da-conta',
    () => ({ aberta: false, aba: 'entrar', motivo: null }))

  /** Lê a conta no servidor. Só no navegador (ver `BotaoDaConta`): o nome não entra no HTML. */
  async function carregar(evento?: string | null) {
    const e = evento === undefined ? estado.value.evento : evento
    try {
      const r = await $fetch<any>('/api/conta/eu', { query: e ? { evento: e } : {} })
      estado.value = { carregada: true, conta: r.conta, exigeConta: !!r.exigeConta, social: r.social, evento: e }
    } catch {
      // sem resposta, a tela trata como "fora da conta" — o servidor segue sendo quem decide
      estado.value = { ...estado.value, carregada: true, evento: e }
    }
    return estado.value
  }

  /** Lê a conta se ainda não leu (ou se a tela é de outro evento); junta pedidos simultâneos. */
  function garantir(evento: string | null = null) {
    if (estado.value.carregada && estado.value.evento === evento) return Promise.resolve(estado.value)
    if (emVoo && emVoo.evento === evento) return emVoo.promessa
    const promessa = carregar(evento).finally(() => { if (emVoo?.promessa === promessa) emVoo = null })
    emVoo = { evento, promessa }
    return promessa
  }

  function abrir(aba: AbaDaConta = 'entrar', motivo: string | null = null) {
    janela.value = { aberta: true, aba, motivo }
  }
  function fechar() {
    janela.value = { ...janela.value, aberta: false }
  }

  async function entrar(login: string, senha: string) {
    const r = await $fetch<any>('/api/conta/entrar', {
      method: 'POST', body: { login, senha, evento: estado.value.evento },
    })
    estado.value = { ...estado.value, carregada: true, conta: r.conta }
    return r.conta as ContaNaTela
  }

  async function criar(dados: Record<string, unknown>) {
    const r = await $fetch<any>('/api/conta/criar', {
      method: 'POST', body: { ...dados, evento: estado.value.evento },
    })
    estado.value = { ...estado.value, carregada: true, conta: r.conta }
    return r.conta as ContaNaTela
  }

  async function sair() {
    await $fetch('/api/conta/sair', { method: 'POST' }).catch(() => {})
    estado.value = { ...estado.value, conta: null }
  }

  /** O endereço do botão do Google/Apple, voltando pra ESTA tela. */
  function urlSocial(provedor: 'google' | 'apple', volta: string) {
    const q = new URLSearchParams({ volta })
    if (estado.value.evento) q.set('evento', estado.value.evento)
    return `/api/conta/${provedor}?${q.toString()}`
  }

  return {
    estado, janela, carregar, garantir, abrir, fechar, entrar, criar, sair, urlSocial,
    logado: computed(() => !!estado.value.conta),
  }
}

/* ------------------------------------------------------------ máscaras */

export function mascaraCpf(v: string) {
  const d = String(v ?? '').replace(/\D/g, '').slice(0, 11)
  return d.replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})(\d)/, '$1.$2')
    .replace(/(\d{3})(\d{1,2})$/, '$1-$2')
}
export function mascaraTel(v: string) {
  const d = String(v ?? '').replace(/\D/g, '').slice(0, 11)
  if (d.length <= 10) return d.replace(/(\d{2})(\d)/, '($1) $2').replace(/(\d{4})(\d)/, '$1-$2')
  return d.replace(/(\d{2})(\d)/, '($1) $2').replace(/(\d{5})(\d)/, '$1-$2')
}
export function mascaraCep(v: string) {
  return String(v ?? '').replace(/\D/g, '').slice(0, 8).replace(/(\d{5})(\d)/, '$1-$2')
}
/** No campo "CPF ou e-mail": só mascara quando é número. */
export function mascaraLogin(v: string) {
  const t = String(v ?? '')
  return /[a-z@]/i.test(t) ? t.trim() : mascaraCpf(t)
}
export function cpfLegivel(cpf: string | null | undefined) {
  return mascaraCpf(String(cpf ?? ''))
}
/** `529.***.***-25`: o bastante pra pessoa reconhecer o dela, sem expor o número na tela do checkout. */
export function cpfEscondido(cpf: string | null | undefined) {
  const d = String(cpf ?? '').replace(/\D/g, '')
  return d.length === 11 ? `${d.slice(0, 3)}.***.***-${d.slice(9)}` : mascaraCpf(d)
}
export function telefoneLegivel(tel: string | null | undefined) {
  return mascaraTel(String(tel ?? ''))
}
