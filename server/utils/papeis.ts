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
 *
 * **Esta tabela tem que cobrir TODA rota de `server/api/admin/`.** O balde do
 * `null` é rede de segurança pra rota que nasce amanhã, não destino de rota
 * que já existe: enquanto `sessoes`, `reenviar`, `remarcar` e `cancelar`
 * estiveram fora daqui, quatro telas já construídas respondiam 403 pra todo
 * mundo menos o master — inclusive a que o guichê usa. O teste
 * `papeis.test.ts` varre a pasta de rotas e fica vermelho quando sobra uma
 * sem área.
 */
const AREA_DA_TELA: Record<string, Area> = {
  resumo: 'evento_ver',
  publico: 'evento_ver',

  configuracoes: 'evento',
  ingressos: 'evento',
  // as datas/horários do evento: a tela mora em `ingressos/sessoes`
  sessoes: 'evento',
  ordenar: 'evento',
  assentos: 'evento',
  cortesias: 'evento',
  cupons: 'evento',
  promoters: 'evento',
  // adiar é o caminho em que o dinheiro FICA (ver `remarcar.post.ts`): o que
  // muda é a data do evento e a das sessões, que é configuração de evento.
  remarcar: 'evento',

  vendas: 'venda',
  participantes: 'venda',
  transferencias: 'venda',
  // "não chegou, manda de novo" — ato sobre o PEDIDO de quem está na frente
  // do guichê. Em `pdv` ele ficaria só na bilheteria; em `venda` alcança
  // também quem atende pelo painel, que é onde o chamado costuma cair.
  reenviar: 'venda',

  pdv: 'pdv',

  // a LISTA de quem já entrou, não o leitor — ver o comentário de PODE
  checkins: 'portaria_historico',

  dashboard: 'dinheiro',
  financeiro: 'dinheiro',
  bordero: 'dinheiro',
  extrato: 'dinheiro',
  relatorios: 'dinheiro',
  // Cancelar mata todo ingresso válido e enfileira ESTORNO de cada pedido
  // vivo: é a maior saída de dinheiro do sistema depois do saque. O botão
  // mora na tela de Configurações (área `evento`), mas quem manda aqui é o
  // ATO, não a página em que o botão foi parar — deixar em `evento` daria a
  // quem é de operação, que por definição não tem caixa, o poder de estornar
  // o evento inteiro em dois cliques.
  cancelar: 'dinheiro',
}

/** Rotas que não são de um evento. Mais específica primeiro. */
const AREA_DA_RAIZ: [string, Area][] = [
  ['/api/checkin', 'portaria'],
  ['/api/admin/equipe', 'equipe'],
  ['/api/admin/organizacoes', 'organizacao'],
  ['/api/admin/organizacao', 'organizacao'],
  ['/api/admin/financeiro', 'dinheiro'],
  /*
   * A execução da fila de saque — a única rota em que o dinheiro SAI da
   * plataforma. Ela ficou fora desta tabela por um tempo, trancada por
   * ausência, com a justificativa "mandar dinheiro embora é ato de dono".
   *
   * Por que ela passou a ser `dinheiro`, de propósito:
   *
   * 1. **O papel `financeiro` existe exatamente pra isto.** Ele já pede o
   *    saque (`POST /api/admin/evento/:id/financeiro` é área `dinheiro`) e já
   *    lê borderô, extrato e auditoria. Deixar só a EXECUÇÃO com o dono
   *    partia a mesma tarefa em duas pessoas: uma pede, a outra manda — e a
   *    outra é a que viaja. Medido antes desta linha: `financeiro` levava
   *    **403** em `POST /api/admin/payout/executar`, e com o dono fora do ar
   *    o pedido ficava `solicitada` para sempre, que é o defeito que a
   *    própria rota foi escrita pra fechar.
   * 2. **Ausência não é tranca escrita.** "Rota sem área é do master" é rede
   *    de segurança pra rota que NASCE amanhã — quem já existe e tem dono
   *    conhecido entra na tabela, senão a rede vira o esconderijo de decisões
   *    que ninguém revisa.
   * 3. **Quem não tem caixa continua sem mandar dinheiro embora**: `operacao`
   *    e `portaria` não têm `dinheiro`, então os 403 delas não mudaram.
   *
   * Não é "abrir": é dizer em voz alta quem pode, no mesmo lugar em que se
   * diz o resto. Quem quiser voltar atrás tira daqui e põe em `SO_DO_MASTER`,
   * no mesmo diff do teste de `executar.test.ts`.
   */
  ['/api/admin/payout', 'dinheiro'],
  // A tela de "quem mexeu nisso": valor de venda, motivo de estorno e e-mail
  // de operador. Sem esta linha nem o financeiro abria — e a tranca própria
  // que a rota tem (`podeFazer(..., 'financeiro')`, em `auditoria.get.ts`)
  // virava código morto, porque ninguém além do master chegava até ela.
  ['/api/admin/auditoria', 'dinheiro'],
  // O extrato do Asaas ao lado do nosso caixa: conferência de dinheiro.
  ['/api/admin/reconciliacao', 'dinheiro'],
  ['/api/admin/eventos', 'evento_ver'],
  ['/api/admin/pedido', 'venda'],
  ['/api/admin/evento', 'evento'], // criar evento; o `/evento/<id>/...` é tratado acima
]

/**
 * Rotas administrativas que ficam de fora da grade DE PROPÓSITO — o `null`
 * delas é decisão registrada, não esquecimento.
 *
 * `/api/admin/payout` MOROU aqui e saiu: a execução da fila de saque virou
 * área `dinheiro` (o porquê está escrito na linha dela, em `AREA_DA_RAIZ`).
 * Enquanto esteve aqui, a tranca da rota que manda dinheiro embora era uma
 * AUSÊNCIA — e ausência não é decisão que alguém revisa: é o esconderijo de
 * quem não quis escolher. Quem quiser voltar atrás traz a linha de volta pra
 * cá e ajusta `executar.test.ts` no mesmo diff.
 *
 * Serve também pro teste de varredura: rota que aparece aqui pode ficar sem
 * área; qualquer outra sem área deixa a suíte vermelha.
 */
export const SO_DO_MASTER: string[] = [
  // `/api/admin/filas` nasceu nesta mesma rodada, em outra trilha. Ela segue
  // sem área — que é o estado em que ela já está no ar — porque quem decide a
  // quem uma tela serve é quem a construiu: a resposta mistura "o ingresso
  // saiu?" (bilheteria) com "o estorno voltou?" (dinheiro), e chutar uma das
  // duas abriria a outra de lambuja. Fica trancada até essa decisão existir,
  // que é a direção segura.
  '/api/admin/filas',
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

/* --------------------------------------------------- a página do painel */

/**
 * A PÁGINA do painel → área. É o que o menu da lateral lê pra não oferecer
 * porta fechada.
 *
 * Por que aqui e não uma lista no `layouts/admin.vue`: duas listas de quem-vê-o-quê
 * divergem no primeiro dia em que alguém muda uma e esquece a outra, e a que
 * envelhece é sempre a da tela — que passa a oferecer o que o servidor nega
 * (item morto) ou a esconder o que ele libera (tela que "sumiu"). Esta é a
 * MESMA tabela que tranca a rota: as telas do evento caem em `AREA_DA_TELA`,
 * e aqui embaixo fica só o que DIVERGE do caminho da API.
 *
 * **Esconder item de menu não protege nada** — quem tranca é o
 * `middleware/03.papel.ts`, que roda antes de qualquer handler. O menu é
 * conveniência: porta que a pessoa não consegue abrir não devia estar
 * desenhada na parede.
 */
const RAIZ_DA_PAGINA_DO_EVENTO = '/admin/evento/'

/**
 * Telas do evento cujo nome de PÁGINA não é o da rota de API. O resto cai em
 * `AREA_DA_TELA` pelo primeiro segmento depois do id, que é o mesmo nos dois
 * lados (`/admin/evento/<id>/ingressos/cupons` → `ingressos` → evento).
 */
const AREA_DA_PAGINA_DO_EVENTO: Record<string, Area | 'livre'> = {
  // O leitor de entrada não tem rota de API sob o evento: ele fala com
  // `/api/checkin`, que é a área `portaria` — a única da portaria.
  validacao: 'portaria',
  // e o histórico de leituras é a outra área, a que a portaria não tem
  'validacao/historico': 'portaria_historico',
}

/**
 * Páginas do painel que não são de um evento. Mais específica primeiro —
 * `/admin` casa com tudo e por isso fica por último.
 */
const AREA_DA_PAGINA_RAIZ: [string, Area | 'livre'][] = [
  ['/admin/organizacoes', 'organizacao'],
  ['/admin/configuracoes', 'organizacao'], // cadastro e chave do Asaas
  ['/admin/equipe', 'equipe'],
  ['/admin/financeiro', 'dinheiro'],
  ['/admin/auditoria', 'dinheiro'],
  ['/admin/reconciliacao', 'dinheiro'],
  // Suporte é "o que fazer quando algo dá errado no dia do evento", e ele é
  // uma parede de ATALHOS: Vendas, Histórico de leituras, Participantes,
  // Cortesias, Financeiro, Equipe, Configurações. Pra quem só abre o leitor
  // de entrada, a tela inteira é porta fechada — sete, em vez das seis do
  // menu. Fica na área da única consulta que ela faz (`/api/admin/eventos`).
  ['/admin/suporte', 'evento_ver'],
  ['/admin/evento/novo', 'evento'],
]

/**
 * A lista de eventos. Ela casa EXATO, e por isso não entra na lista acima.
 *
 * Enquanto `['/admin', 'evento_ver']` era só mais um prefixo daquela lista,
 * ele engolia TODA página de raiz que ninguém tinha classificado — `/admin` é
 * prefixo de qualquer coisa sob o painel — e devolvia `evento_ver` pra ela.
 * O resultado é o avesso do que este arquivo promete duas vezes (no comentário
 * de `podeAbrirPagina` e na decisão 1 lá no topo): a página nova nascia
 * LIBERADA no menu de quem é de operação e de quem é do financeiro, enquanto a
 * rota dela — que não tem catch-all nenhum, `areaDaRota` devolve `null` —
 * respondia 403 no clique. Ou seja, o item morto que este arquivo existe pra
 * apagar voltava a nascer sozinho na PRÓXIMA tela.
 *
 * Não é hipótese: `/api/admin/filas` já existe e é só-do-master (está em
 * `SO_DO_MASTER`). Medido antes desta linha,
 * `podeAbrirPagina('operacao', '/admin/filas')` devolvia `true` e
 * `decidirAcesso('operacao', '/api/admin/filas')` devolvia 403 — bastava
 * alguém pendurar a tela de filas no menu pra recriar o defeito inteiro.
 *
 * Com o casamento exato, página de raiz sem classificação volta a ser `null`,
 * que é só-do-master: igual à rota, e igual ao que está escrito.
 */
const PAGINA_DA_LISTA_DE_EVENTOS: [string, Area] = ['/admin', 'evento_ver']

/** Área de uma página do painel, ou `null` quando ninguém classificou. */
export function areaDaPagina(caminho: string): Area | 'livre' | null {
  const c = (caminho.split('?')[0] ?? '').replace(/\/+$/, '') || '/'

  if (c.startsWith(RAIZ_DA_PAGINA_DO_EVENTO)) {
    const partes = c.slice(RAIZ_DA_PAGINA_DO_EVENTO.length).split('/')
    // `/admin/evento/novo` não tem id: é a criação, não uma tela do evento
    if (partes[0] === 'novo') return 'evento'
    const tela = partes[1]
    if (!tela) return 'evento_ver' // `/admin/evento/<id>` cru
    const duas = partes.slice(1, 3).join('/')
    return AREA_DA_PAGINA_DO_EVENTO[duas]
      ?? AREA_DA_PAGINA_DO_EVENTO[tela]
      ?? AREA_DA_TELA[tela]
      ?? null
  }

  for (const [prefixo, area] of AREA_DA_PAGINA_RAIZ) {
    if (c === prefixo || c.startsWith(prefixo + '/')) return area
  }
  if (c === PAGINA_DA_LISTA_DE_EVENTOS[0]) return PAGINA_DA_LISTA_DE_EVENTOS[1]
  return null
}

/**
 * O menu pergunta isto. Mesma régua da rota: página sem classificação é
 * página do master, igual a `decidirAcesso`.
 */
export function podeAbrirPagina(papel: Papel, caminho: string): boolean {
  const area = areaDaPagina(caminho)
  if (area === 'livre') return true
  if (!area) return papel === 'master'
  return papelPode(papel, area)
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

/**
 * Catálogo pronto pra tela — a rota de equipe devolve isto, ninguém copia.
 *
 * O nome é longo por um motivo de build, não de gosto: o Nitro varre
 * `server/utils` inteiro pra montar o auto-import, e `utils/reconciliacao.ts`
 * também exporta um `CATALOGO` (o de tipos de divergência). Com os dois, o
 * build avisa `Duplicated imports "CATALOGO", the one from papeis.ts has been
 * ignored` — e o dia em que alguém escrever `CATALOGO` sem importar recebe o
 * da reconciliação, em silêncio, com a forma errada dentro.
 */
export const CATALOGO_DE_PAPEIS = PAPEIS.map((p) => ({
  valor: p,
  rotulo: ROTULO[p],
  resumo: RESUMO[p],
  areas: PODE[p],
}))

/**
 * Apelido de compatibilidade — a ÚNICA razão de o aviso de duplicidade ainda
 * existir pra `CATALOGO`.
 *
 * `server/api/admin/equipe/index.get.ts` importa `CATALOGO` deste arquivo pelo
 * nome. **Apague esta linha junto com a troca do nome lá**, num diff só; não
 * dá pra fazer um sem o outro sem quebrar o build. Nada novo deve usar este
 * nome: o nome é `CATALOGO_DE_PAPEIS`.
 */
export const CATALOGO = CATALOGO_DE_PAPEIS

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

