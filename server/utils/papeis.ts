/**
 * Quem pode abrir o quê. A grade fina, num arquivo só.
 *
 * ## O defeito que isto fecha
 *
 * O porteiro antigo (`middleware/01.autenticacao.ts`) pergunta "você está
 * logado e o seu papel cobre esta ÁREA?" — e a área dele é um prefixo de URL.
 * Acontece que **tudo que é do evento mora no mesmo prefixo**:
 * `/api/admin/evento/:id/ingressos` e `/api/admin/evento/:id/financeiro` são
 * a mesma "área evento" pra ele. Medido no sistema no ar, antes desta grade:
 *
 * | rota                                  | operacional | portaria |
 * |---------------------------------------|-------------|----------|
 * | GET  /evento/:id/financeiro (saldo)   | **200**     | 403      |
 * | POST /evento/:id/financeiro (saque)   | **200**     | 403      |
 * | GET  /evento/:id/bordero              | **200**     | 403      |
 * | GET  /admin/organizacao (chave Asaas) | **200**     | **200**  |
 * | GET  /admin/pedido/:id (CPF, e-mail)  | **200**     | **200**  |
 *
 * Quem cadastra lote pedia transferência, e quem fica no portão lia o
 * cadastro da organização e a ficha do comprador. Não é detalhe de tela: é a
 * conta do parque aberta pro pessoal do portão.
 *
 * ## A régua
 *
 * Quatro papéis, porque são quatro pessoas de verdade no parque:
 *
 * - **master** — o dono. Tudo.
 * - **financeiro** — dinheiro: saldo, transferência, borderô, extrato,
 *   relatório. Não mexe em evento nem em equipe.
 * - **operacao** — evento, ingresso, bilheteria, portaria. **Sem caixa e sem
 *   saque.** Vê o pedido de quem está na frente dela; não vê o saldo.
 * - **portaria** — só o leitor de entrada.
 *
 * ## Duas decisões que valem mais que o código
 *
 * 1. **Rota que ninguém classificou é rota do master.** `areaDaRota()`
 *    devolve `null` pro que não está na tabela, e `null` só passa pro master.
 *    O contrário — cair no "deixa passar" quando não reconhece — é como a
 *    rota nova nasce aberta: ela funciona, a tela fica bonita, e ninguém
 *    descobre até o dado sair. Aqui a rota nova nasce TRANCADA e quem
 *    precisar dela abre de propósito, no diff.
 *
 * 2. **Esconder o item do menu não protege rota.** Esta tabela é lida pelo
 *    `middleware/03.papel.ts`, que roda antes de QUALQUER handler
 *    administrativo. O menu é conveniência; a trava é aqui.
 *
 * Este arquivo é PURO de propósito: não importa banco, não importa `h3`. É o
 * que deixa o teste exercitar a grade inteira sem subir servidor — e o que
 * deixa a rota de equipe devolver o catálogo pra tela sem duplicar texto.
 */

export type Papel = 'master' | 'financeiro' | 'operacao' | 'portaria'

export type Area =
  | 'dinheiro'    // saldo, transferência, borderô, extrato, relatório
  | 'evento'      // configurar evento, setor, lote, cupom, cortesia, assento
  | 'evento_ver'  // só o nome/estado do evento e a lista de eventos
  | 'venda'       // pedido, participante, transferência de ingresso
  | 'pdv'         // bilheteria: terminal, turno, gaveta, venda no balcão
  | 'portaria'    // o leitor de entrada em si: POST /api/checkin
  | 'portaria_historico' // a lista de quem já entrou, dentro do evento
  | 'equipe'      // quem tem acesso ao painel
  | 'organizacao' // cadastro e credencial de cobrança

export const AREAS: Area[] = [
  'dinheiro', 'evento', 'evento_ver', 'venda', 'pdv', 'portaria', 'portaria_historico',
  'equipe', 'organizacao',
]

export const PAPEIS: Papel[] = ['master', 'financeiro', 'operacao', 'portaria']

/**
 * A grade. Deny-by-default: o que não está na lista do papel, o papel não faz.
 *
 * `operacao` tem `venda` porque quem atende precisa achar o pedido da pessoa
 * que está na frente dela — e não tem `dinheiro`, que é saldo e saque. São
 * perguntas diferentes: "qual foi a compra desta pessoa" não é "quanto tem
 * pra transferir".
 *
 * `portaria` tem UMA área e ela é o leitor: `POST /api/checkin`. O histórico
 * de leituras é `portaria_historico`, e fica de fora — não por capricho, mas
 * porque foi MEDIDO: `/api/admin/evento/<id>/checkins` responde
 * `403 Seu acesso (portaria) não inclui evento` pelo porteiro antigo, que lê
 * todo o prefixo do evento como área "evento". Enquanto esta grade dizia que
 * a portaria podia, ela prometia o que o sistema nunca entregou — e, pior, a
 * única coisa segurando aquela porta era o porteiro VELHO. No dia em que
 * alguém aposentar o 01 (este arquivo existe justamente pra substituí-lo), a
 * portaria ganharia o histórico do evento em silêncio. Agora os dois negam.
 */
export const PODE: Record<Papel, Area[]> = {
  master:     [...AREAS],
  financeiro: ['dinheiro', 'venda', 'evento_ver'],
  operacao:   ['evento', 'evento_ver', 'venda', 'pdv', 'portaria', 'portaria_historico'],
  portaria:   ['portaria'],
}

/**
 * Papel → `users.role`, a grade GROSSA que o porteiro antigo lê.
 *
 * Não é enfeite de compatibilidade: sem isto o financeiro não chega no
 * dinheiro. O porteiro antigo trata todo `/api/admin/evento/*` como área
 * "evento", e `role = 'financeiro'` não tem essa área — o saldo do evento
 * responde 403 pra quem cuida do dinheiro. `admin` é o único valor legado que
 * abre "evento" E "financeiro" ao mesmo tempo; quem fecha o resto é a grade
 * fina daqui.
 *
 * Nos outros três o valor legado já é estreito, e aí a negação acontece DUAS
 * vezes (no porteiro antigo e aqui). Portaria é o caso que importa: mesmo se
 * esta grade sumisse, `role = 'portaria'` continua barrando o evento inteiro.
 */
export function roleLegado(papel: Papel): string {
  return ({
    master: 'master',
    financeiro: 'admin',
    operacao: 'operacional',
    portaria: 'portaria',
  } as const)[papel]
}

/** O caminho inverso, pra ler linha antiga que ainda não tem `papel`. */
export function papelDoRoleLegado(role: string | null | undefined): Papel {
  if (role === 'master' || role === 'admin') return 'master'
  if (role === 'financeiro') return 'financeiro'
  if (role === 'portaria') return 'portaria'
  return 'operacao'
}

/* ------------------------------------------------------------------ rotas */

/**
 * A tela do evento → área. A chave é o segmento DEPOIS do id:
 * `/api/admin/evento/<id>/bordero` → `bordero`.
 *
 * `dashboard` está no dinheiro porque ele é faturamento do dia: é a primeira
 * tela do evento e mostra quanto entrou. Custa uma porta fechada na cara de
 * quem é de operação — e o preço de deixar aberto é a operação inteira vendo
 * o caixa.
 */
const AREA_DA_TELA: Record<string, Area> = {
  resumo: 'evento_ver',
  publico: 'evento_ver',

  configuracoes: 'evento',
  ingressos: 'evento',
  ordenar: 'evento',
  assentos: 'evento',
  cortesias: 'evento',
  cupons: 'evento',
  promoters: 'evento',

  vendas: 'venda',
  participantes: 'venda',
  transferencias: 'venda',

  pdv: 'pdv',

  // a LISTA de quem já entrou, não o leitor — ver o comentário de PODE
  checkins: 'portaria_historico',

  dashboard: 'dinheiro',
  financeiro: 'dinheiro',
  bordero: 'dinheiro',
  extrato: 'dinheiro',
  relatorios: 'dinheiro',
}

/** Rotas que não são de um evento. Mais específica primeiro. */
const AREA_DA_RAIZ: [string, Area][] = [
  ['/api/checkin', 'portaria'],
  ['/api/admin/equipe', 'equipe'],
  ['/api/admin/organizacoes', 'organizacao'],
  ['/api/admin/organizacao', 'organizacao'],
  ['/api/admin/financeiro', 'dinheiro'],
  ['/api/admin/eventos', 'evento_ver'],
  ['/api/admin/pedido', 'venda'],
  ['/api/admin/evento', 'evento'], // criar evento; o `/evento/<id>/...` é tratado acima
]

const RAIZ_DO_EVENTO = '/api/admin/evento/'

/** Rotas que esta grade tranca. Fora daqui ela não opina. */
export function rotaGateada(caminho: string): boolean {
  return caminho.startsWith('/api/admin/') || caminho === '/api/checkin'
}

/**
 * Área da rota, ou `null` quando ninguém classificou — e `null` é negação
 * pra todo mundo menos o master. Ver a decisão 1 no topo do arquivo.
 */
export function areaDaRota(caminho: string): Area | null {
  const c = caminho.replace(/\/+$/, '') || '/'

  if (c.startsWith(RAIZ_DO_EVENTO)) {
    // partes[0] é o id do evento; a tela é a seguinte
    const tela = c.slice(RAIZ_DO_EVENTO.length).split('/')[1]
    if (!tela) return 'evento_ver' // /api/admin/evento/<id> cru
    return AREA_DA_TELA[tela] ?? null
  }

  for (const [prefixo, area] of AREA_DA_RAIZ) {
    if (c === prefixo || c.startsWith(prefixo + '/')) return area
  }
  return null
}

/* ------------------------------------------------------------- vocabulário */

export const ROTULO: Record<Papel, string> = {
  master: 'Master',
  financeiro: 'Financeiro',
  operacao: 'Operação',
  portaria: 'Portaria',
}

export const RESUMO: Record<Papel, string> = {
  master: 'Tudo, inclusive equipe e credenciais de cobrança.',
  financeiro: 'Dinheiro: saldo, transferência, borderô, extrato e relatórios.',
  operacao: 'Evento, ingressos, bilheteria e portaria. Não vê o caixa nem pede transferência.',
  portaria: 'Só o leitor de entrada.',
}

/** Catálogo pronto pra tela — a rota de equipe devolve isto, ninguém copia. */
export const CATALOGO = PAPEIS.map((p) => ({
  valor: p,
  rotulo: ROTULO[p],
  resumo: RESUMO[p],
  areas: PODE[p],
}))

/**
 * Como a recusa é escrita pra quem está lendo ela às 21h com fila na frente:
 * o que ele tentou abrir, e o que fazer agora.
 */
const NOME_DA_AREA: Record<Area, string> = {
  dinheiro: 'o dinheiro do evento (saldo, transferência, borderô e extrato)',
  evento: 'a configuração do evento (setores, lotes, cupons e cortesias)',
  evento_ver: 'a lista de eventos',
  venda: 'os pedidos e participantes',
  pdv: 'a bilheteria',
  portaria: 'o leitor de entrada',
  portaria_historico: 'a lista de quem já entrou no evento',
  equipe: 'a equipe',
  organizacao: 'o cadastro e as credenciais de cobrança',
}

export type Decisao = { liberado: boolean; area: Area | null; motivo: string }

/** A decisão, com o motivo já escrito. Nenhuma rota decide por conta própria. */
export function decidirAcesso(papel: Papel, caminho: string): Decisao {
  const area = areaDaRota(caminho)
  const rotulo = ROTULO[papel] ?? papel

  if (!area) {
    if (papel === 'master') return { liberado: true, area: null, motivo: '' }
    return {
      liberado: false,
      area: null,
      motivo: `Esta tela ainda não foi liberada para nenhum acesso além do master. `
        + `O seu é de ${rotulo} — peça a um master da sua organização.`,
    }
  }

  if (PODE[papel]?.includes(area)) return { liberado: true, area, motivo: '' }

  return {
    liberado: false,
    area,
    motivo: `Seu acesso é de ${rotulo} e não inclui ${NOME_DA_AREA[area]}. `
      + `Peça a um master da sua organização.`,
  }
}

/** Atalho de leitura, pros testes e pra quem só quer o sim/não. */
export const papelPode = (papel: Papel, area: Area) => PODE[papel]?.includes(area) ?? false

/** Valor que veio de fora (corpo de requisição, banco antigo) é papel mesmo? */
export function ehPapel(v: unknown): v is Papel {
  return typeof v === 'string' && (PAPEIS as string[]).includes(v)
}
