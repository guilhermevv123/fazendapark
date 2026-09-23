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
import { faceDoTipo, precificar } from '~~/server/utils/dinheiro'
definePageMeta({ layout: false })

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
  orgId: '',
  nome: '',
  faixaEtaria: 18,
  privado: false,
  categoria: '',
  subcategorias: [] as string[],

  descricao: '',
  online: false,
  linkTransmissao: '',
  local: { nome: '', cep: '', endereco: '', numero: '', bairro: '', cidade: '', estado: '', complemento: '' },
  suporteTipo: 'whatsapp' as 'whatsapp' | 'telefone' | 'email',
  suporteValor: '',

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
  encerramento: 'inicio' as 'inicio' | 'minutos' | 'data',
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

const { data: orgs } = await useFetch<any>('/api/admin/organizacoes')
watchEffect(() => { if (!f.orgId && orgs.value?.length) f.orgId = orgs.value[0].id })

/* ----------------------------------------------------- endereço (slug) ---
 * Sem campo na tela (dono, 23/09: "que a pessoa sempre fosse no site
 * oficial"): o servidor tira o endereço do NOME (`paraSlug` + `slugLivre` em
 * `index.post.ts` — sem acento, "-2" se já existir, nunca rota reservada). */

/* ----------------------------------------------------------- endereço --- */
const buscandoCep = ref(false)
async function buscarCep() {
  const cep = f.local.cep.replace(/\D/g, '')
  if (cep.length !== 8) return
  buscandoCep.value = true
  try {
    const r: any = await $fetch(`https://viacep.com.br/ws/${cep}/json/`)
    if (r.erro) return
    f.local.endereco = r.logradouro || f.local.endereco
    f.local.bairro = r.bairro || f.local.bairro
    f.local.cidade = r.localidade || f.local.cidade
    f.local.estado = r.uf || f.local.estado
  } catch {
    // CEP é conveniência: se o serviço cair, a pessoa digita. Bloquear o
    // cadastro por causa de um serviço de terceiro seria pior que o problema.
  } finally { buscandoCep.value = false }
}

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
    nome, faceCents: 0, quantidade: 100, minPorCompra: 1, maxPorCompra: 6,
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
    if (!f.orgId) e.push('Escolha a organização vinculada.')
    if (f.nome.trim().length < 3) e.push('O nome do evento precisa de pelo menos 3 letras.')
    if (f.online && !/^https?:\/\//.test(f.linkTransmissao)) {
      e.push('Evento online precisa do link de transmissão.')
    }
    if (!f.online && !f.local.cidade.trim()) e.push('Evento presencial precisa da cidade.')
    if (f.suporteValor.trim().length < 5) e.push('Informe um contato de suporte ao cliente.')
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
    // a capacidade do setor agora se preenche aqui, no cabeçalho de cada setor
    f.setores.forEach((s) => {
      const soma = s.lotes.reduce((a, l) => a + l.quantidade, 0)
      if (s.capacidade && soma > s.capacidade) {
        e.push(`"${s.nome}": os lotes somam ${soma} para uma capacidade de ${s.capacidade}.`)
      }
    })
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
/** preenchido = encerra nessa data; em branco = encerra quando o evento começa */
const encerraCampo = computed({
  get: () => f.encerramento === 'data' ? juntar(f.encerraData, f.encerraHora) : '',
  set: (v: string) => {
    const [d, h] = (v || '').split('T')
    if (d) { f.encerramento = 'data'; f.encerraData = d; f.encerraHora = (h || '').slice(0, 5) }
    else { f.encerramento = 'inicio'; f.encerraData = ''; f.encerraHora = '' }
  },
})

/* ------------------------------------------------------------ gravar ---- */

/**
 * Data + hora digitadas (relógio de quem está criando o evento) → o instante
 * que o servidor guarda. `deCampoDataHora` mora em `app/composables/formato.ts`
 * e é o único lugar do projeto que faz esta conversão: sem a hora, o
 * `new Date('2026-10-17')` que existia aqui nasceria meia-noite UTC e o evento
 * começaria às 21h do dia ANTERIOR.
 */
const iso = (data: string, hora: string) =>
  deCampoDataHora(`${data}T${hora || '00:00'}`)

async function publicar() {
  salvando.value = true
  erro.value = ''
  try {
    const corpo: any = {
      orgId: f.orgId,
      nome: f.nome.trim(),
      descricao: f.descricao || undefined,
      inicio: iso(f.inicioData, f.inicioHora),
      fim: iso(f.fimData, f.fimHora),
      fuso: f.fuso,
      esconderFim: f.esconderFim,
      encerraVendasEm: f.encerramento === 'data' ? iso(f.encerraData, f.encerraHora || '23:59') : null,
      encerraVendasMinutosApos: f.encerramento === 'minutos' ? f.encerraMinutos : (f.encerramento === 'inicio' ? 0 : null),
      faixaEtaria: f.faixaEtaria,
      substantivo: f.substantivo.trim() || 'Ingressos',
      categoria: f.categoria || undefined,
      subcategorias: f.subcategorias,
      online: f.online,
      linkTransmissao: f.online ? f.linkTransmissao : undefined,
      local: f.online ? {} : { ...f.local, estado: f.local.estado || undefined },
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
          expiraEm: deCampoDataHora(l.expiraEm) ?? undefined,
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
const CHAVE_RASCUNHO = 'dt:criar-evento:v1'
const rascunhoSalvoEm = ref<number | null>(null)
let esperaRascunho: ReturnType<typeof setTimeout> | null = null
let rascunhoLigado = false

function gravarRascunho() {
  if (!rascunhoLigado || criado.value) return
  try {
    const salvoEm = Date.now()
    localStorage.setItem(CHAVE_RASCUNHO, JSON.stringify({
      versao: 1, salvoEm, passo: passo.value,
      f, estrutura, tinhaFoto: !!(imagens.banner || imagens.thumb),
    }))
    rascunhoSalvoEm.value = salvoEm
  } catch { /* navegador sem armazenamento (aba anônima cheia etc.): segue sem rascunho */ }
}
function apagarRascunho() {
  try { localStorage.removeItem(CHAVE_RASCUNHO) } catch { /* idem */ }
}
function comecarDoZero() {
  apagarRascunho()
  rascunhoLigado = false
  window.location.reload()
}

onMounted(() => {
  try {
    const bruto = localStorage.getItem(CHAVE_RASCUNHO)
    const r = bruto ? JSON.parse(bruto) : null
    if (r?.versao === 1 && r.f && r.estrutura) {
      Object.assign(f, r.f)
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
  <NuxtLayout name="criacao" :passos="PASSOS" :passo="passo"
              :pode-voltar="passo > 1" :salvando="salvando"
              :rotulo-avancar="passo === PASSOS.length ? 'Publicar evento' : 'Prosseguir'"
              @voltar="voltar" @avancar="avancar" @sair="sair">

    <!-- rascunho: salva sozinho, sem faixa (dono, 23/09: "tira isso"); fica só
         a linha discreta com a saída pra quem quer outro evento do zero -->
    <p v-if="rascunhoSalvoEm" class="flex items-center justify-end gap-2 text-[12px] text-tinta-fraca" aria-live="polite">
      Salvo automaticamente em {{ diaMesHora(rascunhoSalvoEm) }}
      <button type="button" class="font-semibold text-pool-700 underline-offset-2 hover:underline" @click="comecarDoZero">Começar do zero</button>
    </p>

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

        <div class="mt-4 grid gap-4 lg:grid-cols-3">
          <div>
            <label for="org" class="rotulo">Organização vinculada</label>
            <select id="org" v-model="f.orgId" class="campo">
              <option value="" disabled>Organização</option>
              <option v-for="o in orgs ?? []" :key="o.id" :value="o.id">{{ o.nome }}</option>
            </select>
          </div>
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
            <select id="cat" v-model="f.categoria" class="campo">
              <option value="">Categorias</option>
              <option v-for="c in ['Show', 'Festa', 'Festival', 'Teatro', 'Esporte', 'Curso', 'Corporativo', 'Parque']"
                      :key="c" :value="c">{{ c }}</option>
            </select>
          </div>
          <div>
            <label for="sub" class="rotulo">Subcategoria</label>
            <input id="sub" class="campo" placeholder="Digite e pressione Enter"
                   :disabled="!f.categoria"
                   @keydown.enter.prevent="(e) => {
                     const v = (e.target as HTMLInputElement).value.trim()
                     if (v && !f.subcategorias.includes(v)) f.subcategorias.push(v)
                     ;(e.target as HTMLInputElement).value = ''
                   }">
            <div v-if="f.subcategorias.length" class="mt-2 flex flex-wrap gap-1.5">
              <span v-for="(s, i) in f.subcategorias" :key="s" class="selo-neutro">
                {{ s }}
                <button type="button" class="ml-1" @click="f.subcategorias.splice(i, 1)">×</button>
              </span>
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
            <EnvioDeImagem rotulo="Capa" medida="1600 × 900, horizontal" proporcao="16 / 9"
                           :arquivo="imagens.banner"
                           @escolher="imagens.banner = $event" @remover="imagens.banner = null" />
            <p class="mt-1.5 text-xs text-tinta-fraca">A faixa do topo da página de vendas. Sem capa, entra a foto do parque.</p>
          </div>
          <div class="max-w-[260px]">
            <EnvioDeImagem rotulo="Miniatura" medida="500 × 500, quadrada" proporcao="1 / 1"
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

        <p class="rotulo">Modalidade do evento</p>
        <div class="mb-4 flex gap-2">
          <button type="button" :class="!f.online ? 'chip-ativo' : 'chip'" @click="f.online = false">
            Presencial
          </button>
          <button type="button" :class="f.online ? 'chip-ativo' : 'chip'" @click="f.online = true">
            Online
          </button>
        </div>

        <div v-if="f.online">
          <label for="link" class="rotulo">Link de transmissão</label>
          <input id="link" v-model="f.linkTransmissao" class="campo" placeholder="https://…">
        </div>

        <div v-else class="grid gap-4 lg:grid-cols-3">
          <div class="lg:col-span-2">
            <label for="ln" class="rotulo">Nome Fantasia (opcional)</label>
            <input id="ln" v-model="f.local.nome" class="campo" placeholder="Ex: Casa A">
          </div>
          <div>
            <label for="cep" class="rotulo">CEP</label>
            <input id="cep" v-model="f.local.cep" class="campo" placeholder="00000-000"
                   inputmode="numeric" @blur="buscarCep">
            <p v-if="buscandoCep" class="mt-1 text-xs text-tinta-fraca">Buscando CEP…</p>
          </div>
          <div class="lg:col-span-2">
            <label for="rua" class="rotulo">Rua / avenida / logradouro</label>
            <input id="rua" v-model="f.local.endereco" class="campo">
          </div>
          <div>
            <label for="num" class="rotulo">Número</label>
            <input id="num" v-model="f.local.numero" class="campo">
          </div>
          <div>
            <label for="bai" class="rotulo">Bairro</label>
            <input id="bai" v-model="f.local.bairro" class="campo">
          </div>
          <div>
            <label for="cid" class="rotulo">Cidade</label>
            <input id="cid" v-model="f.local.cidade" class="campo">
          </div>
          <div>
            <label for="uf" class="rotulo">Estado</label>
            <input id="uf" v-model="f.local.estado" maxlength="2" class="campo uppercase">
          </div>
          <div class="lg:col-span-3">
            <label for="comp" class="rotulo">Complemento (opcional)</label>
            <input id="comp" v-model="f.local.complemento" class="campo">
          </div>
        </div>
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
              <option value="email">E-mail</option>
            </select>
          </div>
          <div class="lg:col-span-2">
            <label for="sval" class="rotulo">Contato</label>
            <input id="sval" v-model="f.suporteValor" class="campo"
                   :placeholder="f.suporteTipo === 'email' ? 'suporte@empresa.com.br' : '(00) 00000-0000'">
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
              <CampoMoeda v-model="l.faceCents" :disabled="l.gratuito" :conferir-abaixo="CONFERIR_ABAIXO_CENTS" />
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
              <p class="mt-1 text-[11.5px] text-tinta-fraca">opcional</p>
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
        <label class="mt-3 flex items-center gap-2 text-sm text-tinta-corpo">
          <input v-model="f.esconderFim" type="checkbox" class="size-4 accent-pool-600"> Não mostrar o término do evento
        </label>

        <h3 class="titulo mt-6 text-[15px] font-semibold text-tinta">Encerramento das vendas</h3>
        <div class="mt-2 max-w-sm">
          <label for="encerra" class="rotulo">Data de encerramento das vendas</label>
          <input id="encerra" v-model="encerraCampo" type="datetime-local" class="campo">
          <p class="mt-1 text-[12.5px] text-tinta-suave">Em branco: as vendas no site param quando o evento começa. A bilheteria não para.</p>
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
        <p v-if="imagensQueFalharam.length" class="mt-3 max-w-xs rounded-lg bg-warning-50 px-3 py-2 text-sm text-warning-800 ring-1 ring-inset ring-warning-600/25">
          Não consegui enviar {{ imagensQueFalharam.join(' e ') }}. Envie de novo em
          <strong>Configurações do evento</strong>.
        </p>
      </div>
    </div>
  </NuxtLayout>
</template>
