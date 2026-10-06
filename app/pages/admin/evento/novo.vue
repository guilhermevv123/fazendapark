<script setup lang="ts">
/**
 * Criar evento — cinco passos, na mesma ordem e com os mesmos blocos do
 * painel de origem: Dados básicos → Descrição → Setores, lotes e tipos →
 * Preços e quantidades → Datas e horários.
 *
 * Conferido de verdade em 21/09/2026, passo a passo, no painel da Zig do
 * próprio parque (sem publicar nada): o passo 1 leva TAMBÉM "Onde vai
 * acontecer" e "Contato de suporte" (obrigatório), e o passo 2 é só a
 * descrição. Antes isto morava aqui com os dois blocos no passo 2, por
 * dedução de arquivo de tradução — e a equipe, que já conhece o painel de
 * lá, procurava o endereço no passo errado.
 *
 * Tudo fica em memória até o último passo, e o evento inteiro (com setor,
 * lote e tipo) é gravado numa transação só. Criar o rascunho já no passo 1
 * encheria o banco de evento pela metade de quem fechou a aba no meio.
 *
 * Preços ficam no passo 4, separados dos setores do passo 3, porque é assim
 * que o produtor pensa: primeiro "quais áreas eu vendo", depois "quanto custa
 * cada uma". Misturar os dois numa tela só é o que faz alguém errar preço de
 * lote inteiro sem perceber.
 */
import { TETO_POR_COMPRA } from '~~/server/utils/limite-de-compra'
import { faceDoTipo, precificar } from '~~/server/utils/dinheiro'
import { decidirAcesso, ehPapel } from '~~/server/utils/papeis'
import { instanteNoFuso } from '~/composables/fusoHorario'
import {
  CONTATO_DO_PARQUE, LOCAL_DO_PARQUE, MAPA_DO_PARQUE, NOMES_DAS_CATEGORIAS, subcategoriasDe, telefoneValido,
} from '~/composables/eventoDoParque'
import { mascaraTel } from '~/composables/contaDoCliente'
import PainelFalha from '~/components/painel/Falha.vue'
definePageMeta({ layout: false })

/**
 * EVT-09: a chave desta criação. Nasce uma vez por evento a criar (e vai no rascunho): se a
 * resposta do "Publicar" se perde — rede do parque caindo — e a pessoa clica de novo, o servidor
 * reconhece a chave e devolve o evento que JÁ criou, em vez de nascer um segundo com "-2".
 */
function novaChaveDeCriacao(): string {
  const c = globalThis.crypto as Crypto | undefined
  if (c?.randomUUID) return c.randomUUID()
  // http sem TLS não tem randomUUID; getRandomValues existe em todo navegador
  const b = new Uint8Array(16)
  c?.getRandomValues?.(b) ?? b.forEach((_, i) => { b[i] = Math.floor(Math.random() * 256) })
  b[6] = (b[6]! & 0x0f) | 0x40
  b[8] = (b[8]! & 0x3f) | 0x80
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

const PASSOS = [
  'Dados básicos', 'Descrição do evento', 'Setores, lotes e tipos',
  'Preços e quantidades', 'Datas e horários',
]
const passo = ref(1)
/** pra que lado o passo desliza: avançar entra pela direita, voltar pela esquerda */
const sentido = ref<'frente' | 'volta'>('frente')
/** conta as tentativas barradas: muda a `key` da caixa de erro e a faz tremer de novo */
const tentativas = ref(0)
/** evento gravado: mostra o ✓ antes de abrir a tela de ingressos */
const criado = ref(false)
/** capa e miniatura escolhidas: sobem depois do evento gravado (a rota precisa do id) */
const imagens = reactive<{ banner: File | null; thumb: File | null }>({ banner: null, thumb: null })
/** o que não subiu — dito no ✓ de "criado", com o caminho pra enviar de novo */
const imagensQueFalharam = ref<string[]>([])
const salvando = ref(false)
const erro = ref('')
const erros = ref<string[]>([])

/* ------------------------------------------------------------- estado --- */
const f = reactive({
  chaveDeCriacao: novaChaveDeCriacao(),
  nome: '',
  // EVT-14: nasce "Livre", como o servidor e o banco. Era 18: o evento do parque criado sem mexer
  // aqui aparecia na página pública com "Idade 18 anos" — um parque aquático de família.
  faixaEtaria: 0,
  privado: false,
  categoria: '',
  subcategorias: [] as string[],

  descricao: '',
  online: false,
  linkTransmissao: '',
  // o endereço é fixo, o do parque (dono, 05/10) — ver `composables/eventoDoParque.ts`
  local: { ...LOCAL_DO_PARQUE } as { nome: string; cep: string; endereco: string; numero: string; bairro: string; cidade: string; estado: string; complemento: string },
  // telefone, e já nasce com o WhatsApp oficial do parque (dono, 05/10)
  suporteTipo: CONTATO_DO_PARQUE.tipo as 'whatsapp' | 'telefone',
  suporteValor: CONTATO_DO_PARQUE.valor,

  setores: [] as Setor[],

  /** "Nomenclatura do bilhete": como o site e os e-mails chamam o que se compra */
  substantivo: 'Ingressos',
  /** o clique final PUBLICA (dono, 23/09: "o botão não tem que ser criar, tem
   *  que ser publicar"). A caixa "Publicar assim que criar" saiu, e com ela a
   *  publicação foi junto por engano — o evento nascia rascunho e não aparecia
   *  no site. O servidor publica na mesma transação ou recusa tudo. */
  publicarAoCriar: true,

  /** sem taxa de serviço por padrão (dono, 23/09: "não vai ter taxa de serviço");
   *  quem quiser cobrar liga em Configurações do evento */
  taxaBps: 0,
  modoTaxaOnline: 'repassar' as 'repassar' | 'absorver',
  modoTaxaPdv: 'absorver' as 'repassar' | 'absorver',
  maxPorCliente: null as number | null,
  minutosDeReserva: 20,

  inicioData: '', inicioHora: '20:00',
  fimData: '', fimHora: '23:59',
  fuso: 'America/Bahia',
  esconderFim: false,
  encerramento: 'padrao' as 'padrao' | 'minutos' | 'data',
  encerraMinutos: 60,
  encerraData: '', encerraHora: '',
})

type Tipo = { nome: string; quantidade: number; descontoBps: number; exigeDocumento: boolean }
/**
 * `gratuito` e `canais` são escolhas que o assistente não pedia, e as duas
 * custavam caro: o lote nascia a R$ 0,00 e, sem ninguém digitar o preço, saía
 * de graça no site; e nascia só `online` (padrão do banco), então o balcão
 * recusava todo lote criado aqui. Agora zero só passa marcando "Ingresso
 * gratuito", e o lote nasce vendendo no site E na bilheteria.
 */
type Lote = {
  nome: string; faceCents: number; quantidade: number; minPorCompra: number; maxPorCompra: number
  gratuito: boolean; canais: ('online' | 'bilheteria')[]; tipos: Tipo[]
  /** `datetime-local` (hora do navegador); vazio = vende até o fim das vendas do evento */
  expiraEm: string
}
type Setor = { nome: string; tipo: string; descricao: string; capacidade: number | null; indiceSessao: number | null; lotes: Lote[] }

/* A organização do evento é a da SESSÃO — o servidor tira de lá (`index.post.ts`). O select que
 * existia aqui lia `/api/admin/organizacoes`, que é só do master: pra quem é de operação vinha
 * vazio e o passo 1 travava em "Escolha a organização vinculada" (auditoria EVT-01). O parque é
 * uma organização só; não há o que escolher. */

/* ----------------------------------------------------- endereço (slug) ---
 * Sem campo na tela (dono, 23/09: "que a pessoa sempre fosse no site
 * oficial"): o servidor tira o endereço do NOME (`paraSlug` + `slugLivre` em
 * `index.post.ts` — sem acento, "-2" se já existir, nunca rota reservada). */

/* ----------------------------------------------------------- endereço ---
 * Fixo, o do parque (dono, 05/10): `LOCAL_DO_PARQUE` em `composables/eventoDoParque.ts`. A busca de
 * CEP saiu junto com os campos. */

/* ------------------------------------------------------------- setores -- */
/* ----------------------------------------- estrutura (passo 3) ------------
 * No modelo da Zig (o dono preferiu, 22/09): três listas simples — setores,
 * lotes e tipos — em vez de montar setor por setor, lote por lote. Todo setor
 * recebe os mesmos lotes, e todo lote os mesmos tipos. Já nasce pronto pro
 * caso comum: setor "Geral", "1º lote", Inteira + Meia-entrada.
 *
 * As listas são a fonte do passo 3; ao avançar, `montarSetores()` as
 * desdobra em `f.setores` (setor × lote × tipo, o formato que o POST sempre
 * mandou) GUARDANDO o que o passo 4 já tinha preenchido — voltar pro 3 e
 * acrescentar um lote não apaga preço nem quantidade dos outros.
 */
type TipoDoEvento = { nome: string; descontoBps: number; exigeDocumento: boolean }
const estrutura = reactive({
  setores: ['Geral'] as string[],
  lotes: ['1º lote'] as string[],
  tipos: [
    { nome: 'Inteira', descontoBps: 0, exigeDocumento: false },
    { nome: 'Meia-entrada', descontoBps: 5000, exigeDocumento: true },
  ] as TipoDoEvento[],
})
const novoNomeSetor = ref('')
const novoNomeLote = ref('')
const avisoEstrutura = ref('')
const proximoLote = computed(() => `${estrutura.lotes.length + 1}º lote`)

function acrescentar(lista: string[], nome: string, oQue: string): boolean {
  avisoEstrutura.value = ''
  if (lista.some((x) => x.toLowerCase() === nome.toLowerCase())) {
    avisoEstrutura.value = `Já existe ${oQue} "${nome}".`
    return false
  }
  lista.push(nome)
  return true
}
function adicionarSetor() {
  const n = novoNomeSetor.value.trim()
  if (!n) { avisoEstrutura.value = 'Digite o nome do setor antes de adicionar.'; return }
  if (acrescentar(estrutura.setores, n, 'um setor')) novoNomeSetor.value = ''
}
/** lote em branco vira o próximo número ("2º lote") — é o nome que quase todo mundo digitaria */
function adicionarLote() {
  const n = novoNomeLote.value.trim() || proximoLote.value
  if (acrescentar(estrutura.lotes, n, 'um lote')) novoNomeLote.value = ''
}
/**
 * Pedir documento na compra não é pergunta na tela (o dono tirou a caixinha,
 * 23/09): meia-entrada pede por lei, o resto não. Decidido pelo nome.
 */
const exigeDocumento = (nome: string) => /\bmeia\b/i.test(nome)

function adicionarTipo() {
  estrutura.tipos.push({ nome: '', descontoBps: 0, exigeDocumento: false })
}
/** o que ficou digitado sem clicar em "Adicionar" entra ao prosseguir */
function acrescentarPendentes() {
  if (novoNomeSetor.value.trim()) adicionarSetor()
  if (novoNomeLote.value.trim()) adicionarLote()
}

function montarSetores() {
  const antes = f.setores
  // só Inteira sem desconto = lote vendido direto, sem escolha de tipo
  const semTipos = estrutura.tipos.length === 1 && !estrutura.tipos[0]!.descontoBps
  f.setores = estrutura.setores.map((nome) => {
    const s0 = antes.find((x) => x.nome === nome)
    const setor: Setor = s0
      ? { ...s0, nome }
      : { nome, tipo: 'ingresso', descricao: '', capacidade: null, indiceSessao: null, lotes: [] }
    setor.lotes = estrutura.lotes.map((nomeLote) => {
      const l0 = s0?.lotes.find((x) => x.nome === nomeLote)
      const lote: Lote = l0 ? { ...l0 } : loteNovo(nomeLote)
      lote.tipos = semTipos ? [] : estrutura.tipos.map((t) => {
        const t0 = l0?.tipos.find((x) => x.nome === t.nome.trim())
        // os tipos COMPARTILHAM o estoque do lote (a quantidade de cada um
        // acompanha a do lote no envio — ver `publicar()`)
        return {
          nome: t.nome.trim(), descontoBps: t.descontoBps, exigeDocumento: exigeDocumento(t.nome),
          quantidade: t0?.quantidade ?? lote.quantidade,
        }
      })
      return lote
    })
    return setor
  })
}

function loteNovo(nome: string): Lote {
  return {
    nome, faceCents: 0, quantidade: 100, minPorCompra: 1, maxPorCompra: TETO_POR_COMPRA,
    gratuito: false, canais: ['online', 'bilheteria'], tipos: [], expiraEm: '',
  }
}
const NOMENCLATURAS = ['Ingressos', 'Passaportes', 'Convites', 'Couverts', 'Doações']
/** os canais do lote como UMA escolha — a tabela da Zig tem uma coluna, não duas caixas */
const canalDoLote = (l: Lote) =>
  l.canais.length === 2 ? 'todos' : (l.canais[0] ?? 'todos')
function definirCanais(l: Lote, v: string) {
  l.canais = v === 'online' ? ['online'] : v === 'bilheteria' ? ['bilheteria'] : ['online', 'bilheteria']
}
function marcarGratuito(l: Lote, v: boolean) {
  l.gratuito = v
  if (v) l.faceCents = 0
}
/** abaixo disto o campo de valor pede conferência (R$ 5,00) */
const CONFERIR_ABAIXO_CENTS = 500

/* -------------------------------------------------------------- preço --- */
// `reais` vem de `app/composables/formato.ts`. A cópia que morava aqui era
// `(c / 100).toLocaleString('pt-BR', { style: 'currency' })`: divide centavo
// em float pra formatar e separa o `R$` com espaço FINO (U+00A0).
/** Prévia de um tipo (meia…) com a MESMA conta da vitrine e do checkout
 *  (`faceDoTipo`): a conta daqui era `face × (1 − desconto)` + taxa, que
 *  arredonda duas vezes e mostrava 1 centavo diferente do que a venda cobra. */
const precoDoTipo = (faceLote: number, descontoBps: number) =>
  precificar(faceDoTipo(faceLote || 0, descontoBps || 0, f.taxaBps, f.modoTaxaOnline), f.taxaBps, f.modoTaxaOnline)


/* --------------------------------------------------------------- dias --- */


/* ------------------------------------------------------------ validar --- */
function validar(p: number): string[] {
  const e: string[] = []
  if (p === 1) {
    if (f.nome.trim().length < 3) e.push('O nome do evento precisa de pelo menos 3 letras.')
    // local: fixo, o do parque (ver `publicar`) — não tem o que conferir aqui
    if (!telefoneValido(f.suporteValor)) e.push('Informe o telefone de suporte com DDD, ex.: (73) 99842-1010.')
  }
  if (p === 3) {
    if (!estrutura.setores.length) e.push('Adicione pelo menos um setor.')
    if (!estrutura.lotes.length) e.push('Adicione pelo menos um lote.')
    const nomes = estrutura.tipos.map((t) => t.nome.trim().toLowerCase())
    if (nomes.some((n) => !n)) e.push('Dê um nome a cada tipo de ingresso (ou remova o que sobrou em branco).')
    const repetido = nomes.find((n, i) => n && nomes.indexOf(n) !== i)
    if (repetido) e.push(`Dois tipos de ingresso com o mesmo nome: "${repetido}".`)
    if (estrutura.tipos.some((t) => t.descontoBps < 0 || t.descontoBps > 10_000)) {
      e.push('O desconto de um tipo tem que ficar entre 0% e 100%.')
    }
  }
  if (p === 4) {
    // EVT-08: a regra "os lotes somam X para uma capacidade de Y" morava aqui sem campo nenhum de
    // capacidade na tela — `capacidade` nasce null e nunca muda, então a regra nunca disparou.
    // Saiu. A capacidade do setor (quando existir) é dita em Ingressos, depois de criado, e o
    // servidor continua conferindo a soma se ela vier.
    f.setores.forEach((s) => s.lotes.forEach((l) => {
      if (l.faceCents === 0 && !l.gratuito) {
        e.push(`"${s.nome} · ${l.nome}": o valor está R$ 0,00. Digite o preço ou marque "Ingresso gratuito".`)
      }
      if (!l.canais.length) e.push(`"${s.nome} · ${l.nome}": marque onde vende — Site, Bilheteria ou os dois.`)
      if (l.quantidade < 1) e.push(`"${s.nome} · ${l.nome}": a quantidade tem que ser pelo menos 1.`)
      if (l.minPorCompra > l.maxPorCompra) {
        e.push(`"${s.nome} · ${l.nome}": o mínimo por compra passou do máximo.`)
      }
      if (l.expiraEm && !paraData(l.expiraEm)) e.push(`"${s.nome} · ${l.nome}": a data de expiração está incompleta.`)
    }))
  }
  if (p === 5) {
    if (!f.inicioData) e.push('Informe a data de início.')
    if (!f.fimData) e.push('Informe a data de término.')
    if (f.inicioData && f.fimData) {
      // `paraData` e não `new Date(...)`: é a mesma porta que o resto da tela
      // usa, e ela é quem sabe que data sem hora é dia de calendário LOCAL.
      const ini = paraData(`${f.inicioData}T${f.inicioHora}`)
      const fim = paraData(`${f.fimData}T${f.fimHora}`)
      if (ini && fim && fim <= ini) e.push('O término tem que ser depois do início.')
    }
    if (f.encerramento === 'data' && !f.encerraData) {
      e.push('Informe a data de encerramento das vendas.')
    }
  }
  return e
}

function avancar() {
  erro.value = ''
  if (passo.value === 3) acrescentarPendentes()
  erros.value = validar(passo.value)
  // barrado: a caixa treme e a tela sobe até ela — com a barra de ação fixa
  // embaixo, o erro no topo ficava fora da vista e o clique "não fazia nada"
  if (erros.value.length) { tentativas.value++; window.scrollTo({ top: 0, behavior: 'smooth' }); return }
  if (passo.value === 3) montarSetores()
  if (passo.value < PASSOS.length) { sentido.value = 'frente'; passo.value++; window.scrollTo({ top: 0 }); return }
  publicar()
}
function voltar() { erros.value = []; sentido.value = 'volta'; passo.value--; window.scrollTo({ top: 0 }) }

const sair = () => navigateTo('/admin')

/* ------------------------------------------------- datas (passo 5) ------
 * Um campo de data-e-hora na tela, os dois pedaços (dia, hora) no formulário
 * — que é o que o resto da tela e o envio já usam. */
const juntar = (d: string, h: string) => d ? `${d}T${h || '00:00'}` : ''
const inicioCampo = computed({
  get: () => juntar(f.inicioData, f.inicioHora),
  set: (v: string) => { const [d, h] = (v || '').split('T'); f.inicioData = d || ''; if (h) f.inicioHora = h.slice(0, 5) },
})
const fimCampo = computed({
  get: () => juntar(f.fimData, f.fimHora),
  set: (v: string) => { const [d, h] = (v || '').split('T'); f.fimData = d || ''; if (h) f.fimHora = h.slice(0, 5) },
})
/** preenchido = encerra nessa data; em branco = o site vende até 1 dia antes do término (`fimDasVendas`) */
const encerraCampo = computed({
  get: () => f.encerramento === 'data' ? juntar(f.encerraData, f.encerraHora) : '',
  set: (v: string) => {
    const [d, h] = (v || '').split('T')
    if (d) { f.encerramento = 'data'; f.encerraData = d; f.encerraHora = (h || '').slice(0, 5) }
    else { f.encerramento = 'padrao'; f.encerraData = ''; f.encerraHora = '' }
  },
})

/* ------------------------------------------------------------ gravar ---- */

/**
 * Data + hora digitadas → o instante que o servidor guarda, NO FUSO ESCOLHIDO no passo 5 (EVT-03).
 *
 * Antes a conta era pelo relógio do navegador (`deCampoDataHora`): o fuso ia gravado, mas "20:00"
 * de um evento em Manaus criado de Ubatã virava 20:00 da Bahia. Agora todo horário do assistente —
 * início, término, encerramento das vendas e expiração do lote — vale no fuso do evento, e a hora
 * continua obrigatória no formato (sem ela, meia-noite UTC seria 21h do dia ANTERIOR).
 */
const iso = (data: string, hora: string) =>
  instanteNoFuso(`${data}T${hora || '00:00'}`, f.fuso)

async function publicar() {
  salvando.value = true
  erro.value = ''
  try {
    const corpo: any = {
      chaveDeCriacao: f.chaveDeCriacao,
      nome: f.nome.trim(),
      descricao: f.descricao || undefined,
      inicio: iso(f.inicioData, f.inicioHora),
      fim: iso(f.fimData, f.fimHora),
      fuso: f.fuso,
      esconderFim: f.esconderFim,
      encerraVendasEm: f.encerramento === 'data' ? iso(f.encerraData, f.encerraHora || '23:59') : null,
      encerraVendasMinutosApos: f.encerramento === 'minutos' ? f.encerraMinutos : null,
      faixaEtaria: f.faixaEtaria,
      substantivo: f.substantivo.trim() || 'Ingressos',
      categoria: f.categoria || undefined,
      subcategorias: f.subcategorias,
      // presencial, no parque, sempre — mesmo que um rascunho antigo traga outro endereço
      online: false,
      linkTransmissao: undefined,
      local: { ...LOCAL_DO_PARQUE },
      suporte: f.suporteValor ? { tipo: f.suporteTipo, valor: f.suporteValor.trim() } : null,
      taxaBps: f.taxaBps,
      modoTaxaOnline: f.modoTaxaOnline,
      modoTaxaPdv: f.modoTaxaPdv,
      maxPorCliente: f.maxPorCliente,
      minutosDeReserva: f.minutosDeReserva,
      privado: f.privado,
      // sessões por dia saíram do assistente (dono, 23/09): ficam em Ingressos → Sessões
      sessoes: [],
      setores: f.setores.map((s) => ({
        nome: s.nome.trim(), tipo: s.tipo,
        descricao: s.descricao || undefined,
        capacidade: s.capacidade,
        indiceSessao: null,
        lotes: s.lotes.map((l) => ({
          nome: l.nome.trim(), faceCents: l.faceCents,
          gratuito: l.faceCents === 0 && l.gratuito, canais: l.canais,
          quantidade: l.quantidade,
          expiraEm: instanteNoFuso(l.expiraEm, f.fuso) ?? undefined,
          minPorCompra: l.minPorCompra, maxPorCompra: l.maxPorCompra,
          // cada tipo vai até o lote inteiro: é o lote que segura o total
          tipos: l.tipos.map((t) => ({
            nome: t.nome.trim(), quantidade: l.quantidade,
            descontoBps: t.descontoBps, exigeDocumento: t.exigeDocumento,
          })),
        })),
      })),
      // Publicar vai no MESMO pedido: o servidor cria e publica numa transação,
      // ou recusa tudo (sem ingresso à venda, por ex.) antes de gravar. Antes
      // eram dois pedidos, e a falha do segundo deixava um rascunho que a
      // pessoa achava que estava no ar.
      publicar: f.publicarAoCriar,
    }
    const r: any = await $fetch('/api/admin/evento', { method: 'POST', body: corpo })
    // o evento existe: o rascunho sai JÁ (antes das fotos) — recarregar a
    // página agora não pode oferecer "continuar" e criar o evento duas vezes
    apagarRascunho()
    rascunhoLigado = false
    // EVT-09: o primeiro clique tinha chegado (a resposta é que se perdeu) — o servidor devolveu o
    // MESMO evento; o ✓ diz isso em vez de fingir que criou outro
    jaExistia.value = !!r.repetido
    // As imagens sobem DEPOIS: o evento já existe, e uma falha aqui não pode
    // desfazer o cadastro. O que não subir é dito no ✓, com onde reenviar.
    imagensQueFalharam.value = []
    for (const campo of ['banner', 'thumb'] as const) {
      const arquivo = imagens[campo]
      if (!arquivo) continue
      try {
        const corpoImagem = new FormData()
        corpoImagem.append('campo', campo)
        corpoImagem.append('arquivo', arquivo)
        await $fetch(`/api/admin/evento/${r.id}/imagem`, { method: 'POST', body: corpoImagem })
      } catch {
        imagensQueFalharam.value.push(campo === 'banner' ? 'a capa' : 'a miniatura')
      }
    }
    // o ✓ fica na tela antes da troca de página: "deu certo" dito antes, senão
    // a pessoa cai na lista de ingressos sem saber se o clique gravou. Com
    // imagem que falhou, fica mais tempo — é recado pra ler.
    criado.value = true
    await new Promise((ok) => setTimeout(ok, imagensQueFalharam.value.length ? 3500 : 1200))
    await navigateTo(`/admin/evento/${r.id}/ingressos`)
  } catch (e: any) {
    // o servidor já diz QUAL campo (setor, lote, sessão) na frase; a lista crua
    // do validador era em inglês e só repetia o nome da chave
    erro.value = e?.data?.statusMessage || 'Não foi possível criar o evento.'
  } finally { salvando.value = false }
}

/* ------------------------------------------------------- rascunho ------
 * O que foi preenchido fica salvo NESTE navegador a cada alteração: sair no
 * meio, fechar a aba, cair a internet ou o servidor reiniciar não joga a
 * criação fora (a Zig faz isso; o dono pediu em 22/09 — "se eu sair no meio
 * as coisas ficam salvas, é algo muito importante"). Ao voltar, continua do
 * passo onde parou, em silêncio (a faixa de aviso saiu, 23/09), com a saída
 * "Começar do zero" na linha discreta de salvo. Some quando o
 * evento é criado.
 *
 * Fica de fora: as fotos (arquivo não cabe no armazenamento do navegador) —
 * o aviso lembra de escolher de novo. `localStorage` e não o banco: rascunho
 * no banco seria um evento "rascunho" nascendo na lista de todo mundo a cada
 * pessoa que abre o assistente e desiste.
 */
/**
 * EVT-10: o rascunho é DA PESSOA, não do navegador. Com uma chave só (`dt:criar-evento:v1`), quem
 * entrava depois no mesmo computador da bilheteria abria "Criar evento" e herdava o rascunho do
 * outro — nome, preços, contato. Agora a chave leva uma marca de quem está logado (organização +
 * e-mail, embaralhados: o e-mail não fica escrito no armazenamento). Sem saber quem é, não há
 * rascunho. O de chave antiga não tem dono conhecido: é apagado na montagem, não entregue.
 */
const CHAVE_ANTIGA = 'dt:criar-evento:v1'
const { data: eu } = await useFetch<any>('/api/auth/eu', { key: 'auth-eu' })

/**
 * Quem não cria evento (financeiro, portaria) só descobria no FIM: preenchia os cinco passos e o
 * "Publicar evento" voltava 403 (matriz da auditoria, "Financeiro pela URL"). A recusa aparece na
 * ENTRADA, com a mesma frase que a rota de criação mandaria — `decidirAcesso` sobre
 * `POST /api/admin/evento`, a régua de papeis.ts, não uma lista escrita aqui. Sem saber o papel, não
 * trava: quem decide continua sendo a rota.
 */
const recusa = computed(() => {
  const p = eu.value?.usuario?.papel
  if (!ehPapel(p)) return null
  const d = decidirAcesso(p, '/api/admin/evento')
  return d.liberado ? null : { statusCode: 403, data: { statusMessage: d.motivo } }
})
function marcaDaPessoa(texto: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < texto.length; i++) { h ^= texto.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return h.toString(16).padStart(8, '0')
}
const chaveDoRascunho = computed<string | null>(() => {
  const u = eu.value?.usuario
  return u?.email ? `dt:criar-evento:v2:${marcaDaPessoa(`${u.orgId ?? ''}|${String(u.email).toLowerCase()}`)}` : null
})
const rascunhoSalvoEm = ref<number | null>(null)
/** EVT-07: o rascunho lembrava que havia foto e ninguém lia — agora vira aviso até escolher de novo */
const fotoPerdida = ref(false)
const jaExistia = ref(false)
watch(() => [imagens.banner, imagens.thumb], ([b, t]) => { if (b || t) fotoPerdida.value = false })
let esperaRascunho: ReturnType<typeof setTimeout> | null = null
let rascunhoLigado = false

function gravarRascunho() {
  if (!rascunhoLigado || criado.value || !chaveDoRascunho.value) return
  try {
    const salvoEm = Date.now()
    localStorage.setItem(chaveDoRascunho.value, JSON.stringify({
      versao: 1, salvoEm, passo: passo.value,
      f, estrutura, tinhaFoto: !!(imagens.banner || imagens.thumb) || fotoPerdida.value,
    }))
    rascunhoSalvoEm.value = salvoEm
  } catch { /* navegador sem armazenamento (aba anônima cheia etc.): segue sem rascunho */ }
}
function apagarRascunho() {
  try { if (chaveDoRascunho.value) localStorage.removeItem(chaveDoRascunho.value) } catch { /* idem */ }
}
function comecarDoZero() {
  apagarRascunho()
  rascunhoLigado = false
  window.location.reload()
}

onMounted(() => {
  try { localStorage.removeItem(CHAVE_ANTIGA) } catch { /* sem armazenamento */ }
  // sem saber quem é, não há rascunho (nem pra ler, nem pra gravar)
  if (!chaveDoRascunho.value) return
  try {
    const bruto = localStorage.getItem(chaveDoRascunho.value)
    const r = bruto ? JSON.parse(bruto) : null
    if (r?.versao === 1 && r.f && r.estrutura) {
      Object.assign(f, r.f)
      // rascunho de antes da chave de criação: ganha uma agora
      if (!f.chaveDeCriacao) f.chaveDeCriacao = novaChaveDeCriacao()
      fotoPerdida.value = !!r.tinhaFoto
      // rascunho do navegador salvo quando o padrão era não publicar
      f.publicarAoCriar = true
      // rascunho antigo trazia os 10% do padrão velho; o assistente não mostra taxa
      f.taxaBps = 0
      Object.assign(estrutura, r.estrutura)
      passo.value = Math.min(Math.max(1, Number(r.passo) || 1), PASSOS.length)
      rascunhoSalvoEm.value = r.salvoEm
    }
  } catch { apagarRascunho() }
  // só depois de restaurar: senão o estado vazio da montagem gravava por cima
  rascunhoLigado = true
})
watch([() => f, () => estrutura, passo], () => {
  if (esperaRascunho) clearTimeout(esperaRascunho)
  esperaRascunho = setTimeout(gravarRascunho, 400)
}, { deep: true })
onBeforeUnmount(() => { if (esperaRascunho) { clearTimeout(esperaRascunho); gravarRascunho() } })


useHead({ title: 'Criar evento' })
</script>

<template>
  <NuxtLayout v-if="recusa" name="admin">
    <div class="py-5" data-parte="sem-acesso-criar">
      <h1 class="titulo text-2xl font-semibold text-tinta">Criar evento</h1>
      <PainelFalha :falha="recusa" o-que="criar evento" />
    </div>
  </NuxtLayout>
  <NuxtLayout v-else name="criacao" :passos="PASSOS" :passo="passo"
              :pode-voltar="passo > 1" :salvando="salvando"
              :rotulo-avancar="passo === PASSOS.length ? 'Publicar evento' : 'Prosseguir'"
              @voltar="voltar" @avancar="avancar" @sair="sair">

    <!-- rascunho: salva sozinho, sem faixa (dono, 23/09: "tira isso"); fica só
         a linha discreta com a saída pra quem quer outro evento do zero -->
    <p v-if="rascunhoSalvoEm" class="flex items-center justify-end gap-2 text-[12px] text-tinta-fraca" aria-live="polite">
      Salvo automaticamente em {{ diaMesHora(rascunhoSalvoEm) }}
      <button type="button" class="font-semibold text-pool-700 underline-offset-2 hover:underline" @click="comecarDoZero">Começar do zero</button>
    </p>

    <!-- EVT-07: foto não cabe no rascunho; depois de recarregar, a tela AVISA em vez de publicar sem
         capa em silêncio. Some quando uma foto é escolhida de novo. -->
    <div v-if="fotoPerdida && !imagens.banner && !imagens.thumb" role="status" data-parte="foto-perdida"
         class="flex flex-wrap items-center justify-between gap-3 rounded-card border border-alerta bg-alerta-claro px-4 py-3 text-sm text-tinta">
      <p>As fotos escolhidas antes de a página recarregar não ficam no rascunho. <strong>Escolha a capa de novo</strong> no passo 1 — sem ela, o evento entra com a foto do parque.</p>
      <button v-if="passo !== 1" type="button" class="btn-secundario min-h-[40px] shrink-0" data-acao="ir-para-fotos"
              @click="erros = []; sentido = 'volta'; passo = 1">
        Ir ao passo 1
      </button>
    </div>

    <div v-if="erros.length || erro" :key="'erro' + tentativas" role="alert"
         class="animate-sacode rounded-card border border-erro bg-erro-claro px-4 py-3 text-sm text-erro">
      <p v-if="erro" class="font-semibold">{{ erro }}</p>
      <ul v-if="erros.length" class="list-disc space-y-0.5 pl-5">
        <li v-for="(x, i) in erros" :key="i">{{ x }}</li>
      </ul>
    </div>

    <!-- O passo inteiro desliza ao trocar: `key` recria o bloco, e a animação
         (CSS por tempo, não <Transition>, que congela com a aba escondida)
         entra pela direita ao avançar e pela esquerda ao voltar. -->
    <div :key="passo" class="space-y-5"
         :class="sentido === 'volta' ? 'animate-passo-volta' : 'animate-passo-frente'">

    <!-- ============================================ 1. DADOS BÁSICOS ==== -->
    <template v-if="passo === 1">
      <section class="card">
        <h2 class="titulo-bloco">Informações Básicas</h2>
        <p class="apoio-bloco">
          Seja inventivo ao escolher o nome do seu evento e explique aos participantes por que
          não podem perder essa experiência única.
        </p>
        <hr class="my-4 border-linha">

        <div>
          <label for="nome" class="rotulo">Nome do Evento</label>
          <input id="nome" v-model="f.nome" class="campo" placeholder="Nome do Evento">
        </div>

        <div class="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <label for="idade" class="rotulo">Faixa etária</label>
            <select id="idade" v-model.number="f.faixaEtaria" class="campo">
              <option :value="0">Livre</option>
              <option v-for="n in [10, 12, 14, 16, 18]" :key="n" :value="n">{{ n }} anos</option>
            </select>
          </div>
          <div>
            <label for="moeda" class="rotulo">Moeda</label>
            <select id="moeda" class="campo" disabled>
              <option>Real (R$)</option>
            </select>
          </div>
        </div>

        <p class="mt-4 text-sm text-tinta-suave">
          Marque a caixa 'Privado' para restringir o acesso ao evento apenas para aqueles que possuem o link.
        </p>
        <label class="mt-1 flex items-center gap-2 text-tinta-corpo">
          <input v-model="f.privado" type="checkbox"> Privado
        </label>
      </section>

      <section class="card">
        <h2 class="titulo-bloco">Categorização</h2>
        <p class="apoio-bloco">
          Ajude os participantes a encontrarem seu evento de maneira fácil e rápida: categorize-o com clareza.
        </p>
        <hr class="my-4 border-linha">
        <div class="grid gap-4 lg:grid-cols-2">
          <div>
            <label for="cat" class="rotulo">Categoria</label>
            <select id="cat" v-model="f.categoria" class="campo"
                    @change="f.subcategorias = f.subcategorias.filter((x) => subcategoriasDe(f.categoria).includes(x))">
              <option value="">Escolha a categoria</option>
              <option v-for="c in NOMES_DAS_CATEGORIAS" :key="c" :value="c">{{ c }}</option>
            </select>
          </div>
          <div>
            <p class="rotulo">Subcategoria</p>
            <p v-if="!f.categoria" class="text-sm text-tinta-fraca">Escolha a categoria primeiro.</p>
            <div v-else class="flex flex-wrap gap-1.5" data-parte="subcategorias">
              <button v-for="sub in subcategoriasDe(f.categoria)" :key="sub" type="button"
                      :class="f.subcategorias.includes(sub) ? 'chip-ativo' : 'chip'"
                      :aria-pressed="f.subcategorias.includes(sub)"
                      @click="f.subcategorias.includes(sub)
                        ? f.subcategorias.splice(f.subcategorias.indexOf(sub), 1)
                        : f.subcategorias.push(sub)">
                {{ sub }}
              </button>
            </div>
          </div>
        </div>
      </section>

      <section class="card">
        <h2 class="titulo-bloco">Imagens do evento (Opcional)</h2>
        <p class="apoio-bloco">
          Enriqueça seu evento com fotos impactantes e conquiste a atenção imediata dos participantes.
        </p>
        <hr class="my-4 border-linha">
        <!-- Clique ou arraste. O evento ainda não existe aqui (a rota de envio
             precisa do id), então o arquivo fica guardado na tela e sobe logo
             depois de gravar o evento — ver `publicar()`. -->
        <div class="grid gap-4 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <div>
            <EnvioDeImagem rotulo="Capa" medida="1600 × 900, horizontal" proporcao="16 / 9" campo="banner"
                           :arquivo="imagens.banner"
                           @escolher="imagens.banner = $event" @remover="imagens.banner = null" />
            <p class="mt-1.5 text-xs text-tinta-fraca">A faixa do topo da página de vendas. Sem capa, entra a foto do parque.</p>
          </div>
          <div class="max-w-[260px]">
            <EnvioDeImagem rotulo="Miniatura" medida="500 × 500, quadrada" proporcao="1 / 1" campo="thumb"
                           :arquivo="imagens.thumb"
                           @escolher="imagens.thumb = $event" @remover="imagens.thumb = null" />
            <p class="mt-1.5 text-xs text-tinta-fraca">O quadrado do evento na lista do painel.</p>
          </div>
        </div>
      </section>

      <section class="card">
        <h2 class="titulo-bloco">Onde vai acontecer o seu evento</h2>
        <p class="apoio-bloco">
          Garanta que seu evento seja facilmente localizado e acessível a todos.
        </p>
        <hr class="my-4 border-linha">

        <!-- fixo, o do parque (dono, 05/10): não tem o que digitar aqui -->
        <div class="flex flex-wrap items-start justify-between gap-3 rounded-xl bg-fundo-cinza p-4 ring-1 ring-ink-200"
             data-parte="local-fixo">
          <div class="min-w-0">
            <p class="font-semibold text-tinta">{{ LOCAL_DO_PARQUE.nome }}</p>
            <p class="text-sm text-tinta-suave">{{ LOCAL_DO_PARQUE.endereco }}</p>
            <p class="text-sm text-tinta-suave">
              {{ LOCAL_DO_PARQUE.cidade }}/{{ LOCAL_DO_PARQUE.estado }} · CEP {{ LOCAL_DO_PARQUE.cep }}
            </p>
          </div>
          <a :href="MAPA_DO_PARQUE" target="_blank" rel="noopener" class="btn-secundario px-3 py-2 text-sm">
            Ver no mapa
          </a>
        </div>
        <p class="mt-2 text-xs text-tinta-fraca">Todo evento acontece no parque: o endereço entra sozinho.</p>
      </section>

      <section class="card">
        <h2 class="titulo-bloco">Contato de suporte ao cliente</h2>
        <p class="apoio-bloco">
          Este contato é para quem comprou o ingresso e precisa de suporte em relação ao evento.
        </p>
        <hr class="my-4 border-linha">
        <div class="grid gap-4 lg:grid-cols-3">
          <div>
            <label for="stipo" class="rotulo">Tipo de contato</label>
            <select id="stipo" v-model="f.suporteTipo" class="campo">
              <option value="whatsapp">WhatsApp</option>
              <option value="telefone">Telefone</option>
            </select>
          </div>
          <div class="lg:col-span-2">
            <label for="sval" class="rotulo">Telefone</label>
            <input id="sval" :value="f.suporteValor" class="campo" type="tel" inputmode="tel" autocomplete="off"
                   placeholder="(73) 99842-1010"
                   @input="f.suporteValor = mascaraTel(($event.target as HTMLInputElement).value)">
            <p class="mt-1 text-xs text-tinta-fraca">Com DDD. Já vem o WhatsApp do parque; troque só se o evento tiver outro.</p>
          </div>
        </div>
      </section>
    </template>

    <!-- ========================================= 2. DESCRIÇÃO ========== -->
    <template v-if="passo === 2">
      <section class="card">
        <h2 class="titulo-bloco">Descrição do evento (Opcional)</h2>
        <p class="apoio-bloco">
          Detalhe sobre o que se trata o evento e dê o máximo de informação útil para o seu
          participante. Esse campo afeta o posicionamento do evento nos buscadores.
        </p>
        <hr class="my-4 border-linha">
        <textarea v-model="f.descricao" rows="8" class="campo"
                  placeholder="O que vai acontecer, quem toca, o que está incluso, o que levar…"></textarea>
        <p class="mt-1 text-xs text-tinta-fraca">{{ f.descricao.length }} caracteres</p>
      </section>
    </template>

    <!-- ================================ 3. SETORES, LOTES E TIPOS ====== -->
    <template v-if="passo === 3">
      <section class="card">
        <h2 class="titulo-bloco">Setores, lotes e tipos de ingresso</h2>
        <p class="apoio-bloco">
          Já vem pronto pro caso mais comum. Mude só o que o seu evento tiver de diferente —
          preço e quantidade de cada um entram no próximo passo.
        </p>
        <hr class="my-4 border-linha">

        <!-- ---- setores -->
        <div class="flex items-center gap-1.5">
          <h3 class="titulo text-[15px] font-semibold text-tinta">Setores</h3>
          <InfoDica rotulo="O que é setor?">
            Onde a pessoa fica ou o que ela compra: Pista, Camarote, Área VIP, Entrada sábado.
            Cada setor tem os próprios lotes, preço e estoque. Evento com uma entrada só usa
            um setor só — o "Geral".
          </InfoDica>
        </div>
        <div class="mt-2 flex flex-col gap-2 sm:flex-row">
          <input v-model="novoNomeSetor" class="campo" placeholder="Nome do setor — ex.: Pista, Camarote, Entrada sábado"
                 aria-label="Nome do setor" @keydown.enter.prevent="adicionarSetor">
          <button type="button" class="btn-primario shrink-0 sm:min-w-[180px]" @click="adicionarSetor">Adicionar setor</button>
        </div>
        <div class="mt-3 flex flex-wrap items-center gap-2">
          <span class="text-[13px] text-tinta-suave">Setores criados:</span>
          <span v-if="!estrutura.setores.length" class="text-[13px] italic text-tinta-fraca">nenhum ainda</span>
          <span v-for="(nome, i) in estrutura.setores" :key="nome"
                class="inline-flex animate-encaixa items-center gap-1 rounded-lg bg-pool-700 py-1 pl-3 pr-1 text-[13.5px] font-semibold text-white">
            {{ nome }}
            <button type="button" class="grid size-7 place-items-center rounded-md hover:bg-white/15"
                    :aria-label="`Remover o setor ${nome}`" @click="estrutura.setores.splice(i, 1)">
              <IconeMenu nome="fechar" :tamanho="14" />
            </button>
          </span>
        </div>

        <hr class="my-5 border-linha">

        <!-- ---- lotes -->
        <div class="flex items-center gap-1.5">
          <h3 class="titulo text-[15px] font-semibold text-tinta">Lotes</h3>
          <InfoDica rotulo="O que é lote?">
            As levas de venda: 1º lote, 2º lote… Normalmente o preço sobe a cada lote. Todo
            setor recebe os mesmos lotes, e a quantidade e o preço de cada um você define no
            próximo passo.
          </InfoDica>
        </div>
        <div class="mt-2 flex flex-col gap-2 sm:flex-row">
          <input v-model="novoNomeLote" class="campo" :placeholder="`Nome do lote — em branco vira “${proximoLote}”`"
                 aria-label="Nome do lote" @keydown.enter.prevent="adicionarLote">
          <button type="button" class="btn-primario shrink-0 sm:min-w-[180px]" @click="adicionarLote">Adicionar lote</button>
        </div>
        <div class="mt-3 flex flex-wrap items-center gap-2">
          <span class="text-[13px] text-tinta-suave">Lotes criados:</span>
          <span v-if="!estrutura.lotes.length" class="text-[13px] italic text-tinta-fraca">nenhum ainda</span>
          <span v-for="(nome, i) in estrutura.lotes" :key="nome"
                class="inline-flex animate-encaixa items-center gap-1 rounded-lg bg-grape-700 py-1 pl-3 pr-1 text-[13.5px] font-semibold text-white">
            {{ nome }}
            <button type="button" class="grid size-7 place-items-center rounded-md hover:bg-white/15"
                    :aria-label="`Remover o lote ${nome}`" @click="estrutura.lotes.splice(i, 1)">
              <IconeMenu nome="fechar" :tamanho="14" />
            </button>
          </span>
        </div>

        <p v-if="avisoEstrutura" class="mt-3 text-[13px] font-medium text-erro" role="alert">{{ avisoEstrutura }}</p>

        <hr class="my-5 border-linha">

        <!-- ---- tipos -->
        <div class="flex flex-wrap items-center gap-2">
          <div class="flex items-center gap-1.5">
            <h3 class="titulo text-[15px] font-semibold text-tinta">Tipos de ingresso</h3>
            <InfoDica rotulo="O que é tipo de ingresso?">
              As opções de compra dentro de cada lote, com o desconto de cada uma. A
              Meia-entrada tem por lei 50% sobre a Inteira. Dá pra criar outros, como
              "Meia solidária", "Criança" ou "Professor".
            </InfoDica>
          </div>
          <button type="button" class="btn-primario ml-auto" @click="adicionarTipo">
            <IconeMenu nome="mais" :tamanho="18" /> Adicionar novo tipo
          </button>
        </div>
        <ul class="mt-3 grid gap-2">
          <li v-for="(t, i) in estrutura.tipos" :key="i"
              class="grid animate-encaixa grid-cols-[auto_minmax(0,1fr)] items-center gap-2 sm:grid-cols-[auto_minmax(0,1fr)_150px]">
            <!-- a Inteira é a base do desconto dos outros: não sai, e não tem desconto -->
            <button type="button" class="grid size-11 place-items-center rounded-xl ring-1 ring-inset ring-ink-200 transition-colors"
                    :class="i === 0 ? 'cursor-not-allowed text-ink-300' : 'text-danger-600 hover:bg-danger-50'"
                    :disabled="i === 0"
                    :aria-label="i === 0 ? 'A Inteira não pode ser removida' : `Remover o tipo ${t.nome || 'sem nome'}`"
                    :title="i === 0 ? 'A Inteira é a base do desconto dos outros tipos' : undefined"
                    @click="estrutura.tipos.splice(i, 1)">
              <IconeMenu nome="fechar" :tamanho="18" />
            </button>
            <input v-model="t.nome" class="campo" :placeholder="i === 0 ? 'Inteira' : 'Ex.: Meia-entrada, Criança'"
                   :aria-label="`Nome do tipo ${i + 1}`">
            <label class="col-span-2 flex items-center overflow-hidden rounded-xl ring-1 ring-inset ring-ink-200 sm:col-span-1"
                   :class="i === 0 && 'bg-ink-50'">
              <span class="px-3 text-sm font-semibold text-tinta-suave">%</span>
              <input :value="t.descontoBps ? t.descontoBps / 100 : ''" type="number" min="0" max="100"
                     class="w-full border-0 bg-transparent py-2.5 pr-3 text-[16px] tabular-nums focus:outline-none focus:ring-0 sm:text-[15px]"
                     :placeholder="i === 0 ? '0' : 'ex.: 50'" :disabled="i === 0"
                     :aria-label="`Desconto do tipo ${t.nome || i + 1}`"
                     @input="t.descontoBps = Math.round(Number(($event.target as HTMLInputElement).value) * 100)">
            </label>
          </li>
        </ul>
      </section>
    </template>

    <!-- ==================================== 4. PREÇOS E QUANTIDADES ==== -->
    <template v-if="passo === 4">
      <!-- No modelo da Zig (o dono, 22/09: "a parte de preços está muito
           difícil"): uma tabela por setor — lote, valor, quantidade, quando
           expira e onde vende. Taxa, limite por cliente e tempo de reserva
           ficam no padrão e se mudam depois em Configurações do evento. -->
      <section class="card">
        <h2 class="titulo-bloco">Preços e quantidades</h2>
        <p class="apoio-bloco">Digite o valor e a quantidade de cada lote. É só isso — o resto já vem no padrão.</p>
        <hr class="my-4 border-linha">

        <div class="max-w-xs">
          <label for="substantivo" class="rotulo">Nomenclatura do bilhete</label>
          <select id="substantivo" v-model="f.substantivo" class="campo">
            <option v-for="n in NOMENCLATURAS" :key="n" :value="n">{{ n }}</option>
          </select>
        </div>

        <div v-for="(s, i) in f.setores" :key="i" class="mt-5 overflow-hidden rounded-2xl ring-1 ring-ink-200">
          <p class="bg-gradient-to-r from-pool-700 to-grape-700 px-4 py-2.5 text-center text-[14px] font-semibold text-white">
            Setor: {{ s.nome }}
          </p>
          <div class="hidden gap-3 bg-fundo-cinza px-4 py-2 text-[11.5px] font-semibold uppercase tracking-[0.08em] text-tinta-suave sm:grid sm:grid-cols-[minmax(0,0.8fr)_minmax(0,1.3fr)_minmax(0,0.7fr)_minmax(0,1.3fr)_minmax(0,1fr)]">
            <span>Lote</span><span>Valor</span><span>Qtd</span><span>Expira em</span><span>Canais de venda</span>
          </div>
          <div v-for="(l, j) in s.lotes" :key="j"
               class="grid grid-cols-2 gap-3 border-t border-linha px-4 py-3.5 sm:items-start sm:grid-cols-[minmax(0,0.8fr)_minmax(0,1.3fr)_minmax(0,0.7fr)_minmax(0,1.3fr)_minmax(0,1fr)]">
            <div class="col-span-2 sm:col-span-1 sm:pt-2.5">
              <p class="titulo font-semibold text-tinta">{{ l.nome }}</p>
            </div>
            <div class="col-span-2 sm:col-span-1">
              <label class="rotulo sm:sr-only">Valor</label>
              <!-- GER-02: o teto do preço é o do servidor (R$ 100.000,00) — o campo segura e diz -->
              <CampoMoeda v-model="l.faceCents" :disabled="l.gratuito" :conferir-abaixo="CONFERIR_ABAIXO_CENTS"
                          :maximo="100_000_00" />
              <!-- preço de cada tipo com desconto (a meia sai por metade) -->
              <p v-if="!l.gratuito && l.faceCents && l.tipos.some((x) => x.descontoBps)" class="mt-1 text-[12px] leading-snug text-tinta-suave">
                <template v-for="(t, k) in l.tipos.filter((x) => x.descontoBps)" :key="t.nome">
                  <template v-if="k">· </template>{{ t.nome }}: <strong class="text-tinta">{{ reais(precoDoTipo(l.faceCents, t.descontoBps).totalCents) }}</strong>
                </template>
              </p>
              <label class="mt-1.5 flex items-center gap-1.5 text-[12.5px] text-tinta-suave">
                <input type="checkbox" :checked="l.gratuito" class="size-4 accent-pool-600"
                       @change="marcarGratuito(l, ($event.target as HTMLInputElement).checked)">
                Ingresso gratuito
              </label>
            </div>
            <div>
              <label class="rotulo sm:sr-only">Quantidade</label>
              <input v-model.number="l.quantidade" type="number" min="1" class="campo text-center tabular-nums"
                     :aria-label="`Quantidade do ${l.nome}`">
            </div>
            <div>
              <label class="rotulo sm:sr-only">Expira em</label>
              <input v-model="l.expiraEm" type="datetime-local" class="campo"
                     :aria-label="`Data de expiração do ${l.nome}`">
              <p class="mt-1 text-[11.5px] text-tinta-fraca">opcional · no fuso do evento (passo 5)</p>
            </div>
            <div class="col-span-2 sm:col-span-1">
              <label class="rotulo sm:sr-only">Canais de venda</label>
              <select :value="canalDoLote(l)" class="campo" :aria-label="`Canais de venda do ${l.nome}`"
                      @change="definirCanais(l, ($event.target as HTMLSelectElement).value)">
                <option value="todos">Todos</option>
                <option value="online">Só no site</option>
                <option value="bilheteria">Só na bilheteria</option>
              </select>
            </div>
          </div>
        </div>
      </section>
    </template>

    <!-- ======================================= 5. DATAS E HORÁRIOS ===== -->
    <template v-if="passo === 5">
      <!-- No modelo da Zig (dono, 23/09: "novamente o nível de complexidade"):
           UM cartão — início, término, fuso e UMA data de encerramento das
           vendas. "X minutos depois do início" continua em Configurações do
           evento; vender por dias fica numa linha opcional aqui embaixo. -->
      <section class="card">
        <h2 class="titulo-bloco">Datas e horários</h2>
        <p class="apoio-bloco">Quando o evento acontece e até quando vende no site.</p>
        <hr class="my-4 border-linha">

        <div class="grid gap-4 lg:grid-cols-3">
          <div>
            <label for="inicio" class="rotulo">Início do evento</label>
            <input id="inicio" v-model="inicioCampo" type="datetime-local" class="campo">
          </div>
          <div>
            <label for="fim" class="rotulo">Término do evento</label>
            <input id="fim" v-model="fimCampo" type="datetime-local" class="campo" :min="inicioCampo || undefined">
          </div>
          <div>
            <label for="fuso" class="rotulo">Fuso horário</label>
            <select id="fuso" v-model="f.fuso" class="campo">
              <option value="America/Bahia">Brasília / Bahia (GMT-3)</option>
              <option value="America/Manaus">Manaus (GMT-4)</option>
              <option value="America/Rio_Branco">Rio Branco (GMT-5)</option>
              <option value="America/Noronha">Fernando de Noronha (GMT-2)</option>
            </select>
          </div>
        </div>
        <!-- EVT-03: o fuso vale pra TODOS os horários do assistente, não só fica gravado -->
        <p class="mt-2 text-[12.5px] text-tinta-suave" data-parte="aviso-fuso">
          Todos os horários daqui (e a expiração dos lotes) valem no fuso escolhido — não no deste computador.
        </p>
        <label class="mt-3 flex items-center gap-2 text-sm text-tinta-corpo">
          <input v-model="f.esconderFim" type="checkbox" class="size-4 accent-pool-600"> Não mostrar o término do evento
        </label>

        <h3 class="titulo mt-6 text-[15px] font-semibold text-tinta">Encerramento das vendas</h3>
        <div class="mt-2 max-w-sm">
          <label for="encerra" class="rotulo">Data de encerramento das vendas</label>
          <input id="encerra" v-model="encerraCampo" type="datetime-local" class="campo">
          <p class="mt-1 text-[12.5px] text-tinta-suave">Em branco: o site vende até 1 dia antes do término do evento. A bilheteria não para.</p>
        </div>

      </section>
    </template>
    </div>

    <!-- evento gravado: um ✓ que se desenha, antes de abrir os ingressos.
         Sem <Transition> (congela em aba oculta): só keyframes por tempo. -->
    <div v-if="criado" class="fixed inset-0 z-50 grid animate-fade-in place-items-center bg-ink-950/50 p-6" role="status">
      <div class="card flex animate-pop flex-col items-center px-10 py-8 text-center">
        <span class="grid size-20 place-items-center rounded-full bg-gradient-to-br from-success-600 to-pool-600 text-white shadow-lg">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6"
               stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M20 6L9 17l-5-5" stroke-dasharray="48" class="animate-desenha" />
          </svg>
        </span>
        <p class="titulo mt-4 text-xl font-semibold text-tinta">Evento publicado!</p>
        <p class="mt-1 text-sm text-tinta-suave">
          Já está à venda no site. Abrindo os ingressos…
        </p>
        <p v-if="jaExistia" class="mt-2 max-w-xs text-sm text-tinta-suave" data-parte="ja-existia">
          O primeiro clique já tinha criado este evento — a resposta é que não voltou. Nada foi criado em dobro.
        </p>
        <p v-if="imagensQueFalharam.length" class="mt-3 max-w-xs rounded-lg bg-warning-50 px-3 py-2 text-sm text-warning-800 ring-1 ring-inset ring-warning-600/25">
          Não consegui enviar {{ imagensQueFalharam.join(' e ') }}. Envie de novo em
          <strong>Configurações do evento</strong>.
        </p>
      </div>
    </div>
  </NuxtLayout>
</template>
