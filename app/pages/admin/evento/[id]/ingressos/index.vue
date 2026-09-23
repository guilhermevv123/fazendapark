<script setup lang="ts">
/**
 * Configurar ingressos: setor → lote → tipo, em tabela.
 *
 * A diferença de produto em relação à plataforma de origem está numa coluna:
 * aqui cada lote mostra as quatro pontas do dinheiro lado a lado —
 * **face, taxa, o que o comprador paga e o que a produção recebe**. Lá o
 * produtor digita a face e descobre o valor final só quando abre a página de
 * vendas; foi assim que alguém precisou calcular 27,27 na mão pra o comprador
 * pagar R$ 30 redondo. Aqui existe um botão que faz essa conta ao contrário.
 *
 * O formato é o do painel de origem de propósito: abas em cima, um cartão por
 * setor, tabela de lotes dentro do cartão e o total do evento numa barra azul
 * fixa no rodapé. Quem já opera a outra ferramenta não precisa reaprender onde
 * fica nada.
 */
definePageMeta({ layout: 'admin' })

// A lista de motivos e o teto de 40% vêm do MESMO módulo que o checkout usa
// (server/utils/meia-entrada.ts). Copiar os textos para cá criaria duas
// verdades sobre o que a portaria pede — e a da tela é a que o produtor lê
// antes de configurar. O módulo é regra pura: não importa `pg` em valor, não
// toca banco, não tem efeito colateral nenhum ao ser carregado.
import { COTA_LEGAL_BPS, cotaDeMeias, MOTIVOS } from '~~/server/utils/meia-entrada'
import { ehPapel, podeAbrirPagina } from '~~/server/utils/papeis'

const route = useRoute()
const id = route.params.id as string

// `error` não é enfeite: sem ele, uma falha no GET deixa `data` nulo e
// `pending` falso ao mesmo tempo — a tela renderia o esqueleto do admin com o
// miolo em branco e nenhuma pista do motivo. Foi exatamente assim que uma
// coluna faltando no banco virou "página vazia" em vez de "deu erro".
const { data, refresh, pending, error: falha } = await useFetch<any>(
  `/api/admin/evento/${id}/ingressos`)

/*
 * Data e dinheiro saem de `app/composables/formato.ts`. As duas cópias que
 * moravam aqui tinham o mesmo defeito das outras telas — e a de data era a
 * que aparecia:
 *
 *   paraCampo = (iso) => new Date(iso).toISOString().slice(0, 16)
 *
 * `toISOString()` converte pra UTC antes de cortar e o `datetime-local` lê
 * hora LOCAL. Medido: lote que abre 21:00 do dia 20 vinha pro formulário como
 * 00:00 do dia 21. Salvar sem tocar no campo empurrava a abertura do lote três
 * horas — a noite de venda inteira.
 */
const erro = ref('')
const salvando = ref(false)

async function chamar(metodo: 'POST' | 'PATCH' | 'DELETE', body: any) {
  erro.value = ''
  salvando.value = true
  try {
    await $fetch(`/api/admin/evento/${id}/ingressos`, { method: metodo, body })
    await refresh()
    return true
  } catch (e: any) {
    erro.value = e?.data?.statusMessage || 'Não foi possível salvar.'
    return false
  } finally {
    salvando.value = false
  }
}

/* --------------------------------------------------------------- totais --- */
/**
 * O rodapé soma o estoque de TODOS os lotes do evento, não a capacidade dos
 * setores: é a quantidade que pode, de fato, ser vendida. Capacidade de setor
 * é teto; lote é o que está na prateleira.
 */
const totais = computed(() => {
  const s = { quantidade: 0, vendidos: 0, reservados: 0, disponivel: 0, teto: 0 }
  for (const setor of data.value?.setores ?? []) {
    s.teto += setor.capacidade ?? 0
    for (const l of setor.lotes) {
      s.quantidade += l.quantidade
      s.vendidos += l.vendidos
      s.reservados += l.reservados
      s.disponivel += l.disponivel
    }
  }
  return s
})

/* ------------------------------------------------------- disponibilidade -- */
/**
 * O estado que o comprador vê. Vem de três coisas ao mesmo tempo — visível,
 * janela de data e estoque — e é justamente por serem três que vale mostrar
 * resolvido: "oculto" e "esgotado" dão a mesma tela pra quem compra, mas se
 * resolvem de formas opostas.
 */
function disponibilidade(l: any) {
  if (!l.visivel) return { texto: 'Oculto', classe: 'selo-neutro' }
  const agora = Date.now()
  const abre = paraData(l.abreEm)
  const expira = paraData(l.expiraEm)
  if (abre && abre.getTime() > agora) return { texto: 'Em breve', classe: 'selo-alerta' }
  if (expira && expira.getTime() < agora) return { texto: 'Encerrado', classe: 'selo-neutro' }
  if (l.disponivel <= 0) return { texto: 'Esgotado', classe: 'selo-erro' }
  return { texto: 'À venda', classe: 'selo-ok' }
}

/* ------------------------------------------------------------ giro auto --- */
async function alternarGiro() {
  await chamar('PATCH', {
    o: 'evento', id,
    campos: { giroAutomatico: !data.value.evento.giroAutomatico },
  })
}

/* ------------------------------------------------------------- setores ---- */
const ROTULO_TIPO: Record<string, string> = {
  ingresso: 'Ingresso', passaporte: 'Passaporte / combo', mesa: 'Mesa', camarote: 'Camarote',
}

const setorForm = reactive({
  aberto: false, id: '', nome: '', tipo: 'ingresso', sessaoId: '',
  capacidade: null as number | null, descricao: '',
})
function abrirSetor(s?: any) {
  erro.value = ''
  Object.assign(setorForm, {
    aberto: true,
    id: s?.id ?? '',
    nome: s?.nome ?? '',
    tipo: s?.tipo ?? 'ingresso',
    sessaoId: s?.sessaoId ?? '',
    capacidade: s?.capacidade ?? null,
    descricao: s?.descricao ?? '',
  })
}
async function salvarSetor() {
  if (!setorForm.nome.trim()) return
  const campos = {
    nome: setorForm.nome,
    descricao: setorForm.descricao || null,
    capacidade: setorForm.capacidade || null,
  }
  const ok = setorForm.id
    ? await chamar('PATCH', { o: 'setor', id: setorForm.id, campos })
    : await chamar('POST', {
        o: 'setor', ...campos, tipo: setorForm.tipo,
        sessaoId: setorForm.sessaoId || null,
      })
  if (ok) setorForm.aberto = false
}

/* --------------------------------------------------------------- lotes ---- */
/**
 * `gratuito` e `canais` são as duas escolhas que o formulário antigo não
 * pedia, e as duas custavam caro:
 *  - face R$ 0,00 (o valor com que o campo nasce) virava ingresso de graça no
 *    site, sem aviso. Agora zero só passa marcando "Ingresso gratuito";
 *  - sem canal, o lote nascia só `online` (padrão do banco) e o balcão dizia
 *    "não está liberado para venda na bilheteria". Agora nasce nos dois.
 */
const loteForm = reactive({
  aberto: false, id: '', setorId: '', nome: '', faceCents: 0,
  quantidade: 100, minPorCompra: 1, maxPorCompra: 10,
  abreEm: '', expiraEm: '', visivel: true,
  gratuito: false, canais: ['online', 'bilheteria'] as string[],
})
const erroLote = ref('')
/** abaixo disto o campo de valor pede conferência (R$ 5,00) */
const CONFERIR_ABAIXO_CENTS = 500

function alternarCanal(canal: 'online' | 'bilheteria') {
  const i = loteForm.canais.indexOf(canal)
  if (i >= 0) loteForm.canais.splice(i, 1)
  else loteForm.canais.push(canal)
}
function marcarGratuito(v: boolean) {
  loteForm.gratuito = v
  if (v) loteForm.faceCents = 0
}
/** ISO com fuso → 'YYYY-MM-DDTHH:mm' que o input datetime-local entende. */
const paraCampo = (iso: string | null) => paraCampoDataHora(iso)
/** E a volta: hora local digitada → o instante que o banco guarda. */
const deCampo = (v: string) => deCampoDataHora(v)

function abrirLote(setorId: string, l?: any) {
  Object.assign(loteForm, {
    aberto: true, setorId,
    id: l?.id ?? '',
    nome: l?.nome ?? '',
    faceCents: l?.faceCents ?? 0,
    quantidade: l?.quantidade ?? 100,
    minPorCompra: l?.minPorCompra ?? 1,
    maxPorCompra: l?.maxPorCompra ?? 10,
    abreEm: paraCampo(l?.abreEm ?? null),
    expiraEm: paraCampo(l?.expiraEm ?? null),
    visivel: l?.visivel ?? true,
    // lote que já existe com R$ 0,00 foi gravado gratuito: reabrir não pode
    // obrigar a marcar de novo pra salvar outra coisa
    gratuito: l ? Number(l.faceCents) === 0 : false,
    canais: l?.canais?.length ? [...l.canais] : ['online', 'bilheteria'],
  })
  erroLote.value = ''
  erro.value = ''
}
async function salvarLote() {
  erroLote.value = ''
  if (loteForm.faceCents === 0 && !loteForm.gratuito) {
    erroLote.value = 'O valor está R$ 0,00. Digite o preço ou marque "Ingresso gratuito".'
    return
  }
  if (!loteForm.canais.length) {
    erroLote.value = 'Marque onde este lote vende: Site, Bilheteria ou os dois.'
    return
  }
  const campos = {
    nome: loteForm.nome || 'Lote único',
    faceCents: loteForm.faceCents,
    gratuito: loteForm.faceCents === 0 && loteForm.gratuito,
    quantidade: loteForm.quantidade,
    minPorCompra: loteForm.minPorCompra,
    maxPorCompra: loteForm.maxPorCompra,
    abreEm: deCampo(loteForm.abreEm),
    expiraEm: deCampo(loteForm.expiraEm),
    visivel: loteForm.visivel,
    // 'cortesia' (se o lote tiver) é preservado: a tela só liga e desliga os dois de venda
    canais: loteForm.canais,
  }
  const ok = loteForm.id
    ? await chamar('PATCH', { o: 'lote', id: loteForm.id, campos })
    : await chamar('POST', { o: 'lote', setorId: loteForm.setorId, ...campos })
  if (ok) loteForm.aberto = false
  // o erro do servidor aparece DENTRO da janela: o aviso do topo da página
  // fica atrás dela, e o botão parecia não fazer nada
  else erroLote.value = erro.value
}

/** "só site" / "só bilheteria" na tabela — o caso que surpreende no balcão. */
function rotuloCanais(canais: string[] | undefined) {
  const c = canais ?? []
  const site = c.includes('online'), balcao = c.includes('bilheteria')
  if (site && balcao) return ''
  if (site) return 'só no site'
  if (balcao) return 'só na bilheteria'
  return 'fora do site e da bilheteria'
}

/*
 * O endereço pedido no assistente já existia e o evento nasceu com outro
 * ("-2"). O assistente manda os dois pela URL, e a tela avisa UMA vez: o link
 * que a pessoa ia divulgar é o que está aqui, não o que ela digitou.
 */
const enderecoRenomeado = computed(() => {
  const novo = route.query.endereco, pedido = route.query.pedido
  return typeof novo === 'string' && typeof pedido === 'string' && novo !== pedido
    ? { novo, pedido } : null
})

// Quem é da operação não abre o dashboard (área de dinheiro): o botão do
// rodapé some pra não levar a um 403. Mesma régua do menu (`podeAbrirPagina`).
const { data: eu } = await useFetch<any>('/api/auth/eu', { key: 'auth-eu' })
const podeDashboard = computed(() => {
  const p = eu.value?.usuario?.papel
  return ehPapel(p) && podeAbrirPagina(p, `/admin/evento/${id}/dashboard`)
})

/** Prévia do que o comprador paga, dentro do formulário de lote. */
const previaLote = computed(() => {
  if (!data.value) return null
  const bps = data.value.evento.taxaBps
  const face = loteForm.faceCents
  const taxa = data.value.evento.modoTaxaOnline === 'repassar'
    ? Math.round((face * bps) / 10_000) : 0
  return { face, taxa, total: face + taxa }
})

/* ---------------------------------------------------------- preço redondo - */
const alvo = reactive({ loteId: '', totalCents: 0 })
const faceParaTotal = (totalCents: number, bps: number, modo: string) => {
  if (modo === 'absorver') return totalCents
  // face = round(total * 10000 / (10000 + bps)), meia pra cima
  const num = totalCents * 10_000, den = 10_000 + bps
  return Math.floor((num + den / 2) / den)
}
const previaAlvo = computed(() => {
  if (!data.value || !alvo.totalCents) return null
  const bps = data.value.evento.taxaBps
  const modo = data.value.evento.modoTaxaOnline
  const face = faceParaTotal(alvo.totalCents, bps, modo)
  const taxa = modo === 'absorver' ? Math.round((face * bps) / 10_000) : alvo.totalCents - face
  return { face, taxa, total: face + (modo === 'absorver' ? 0 : taxa) }
})
async function aplicarAlvo(loteId: string) {
  if (!previaAlvo.value) return
  const ok = await chamar('PATCH', { o: 'lote', id: loteId, campos: { faceCents: previaAlvo.value.face } })
  if (ok) Object.assign(alvo, { loteId: '', totalCents: 0 })
}

/* -------------------------------------------------------- meia-entrada ---- */
/**
 * A espécie do tipo, decidida do MESMO jeito que a coluna gerada
 * `ticket_types.kind` decide (db/015_meia_entrada.sql): desconto de 100% é
 * gratuidade, desconto COM documento é meia-entrada legal, o resto é inteira
 * (inclusive uma promoção de 50% — promoção não pede documento no portão e não
 * consome cota).
 *
 * Está espelhada aqui, e não lida do servidor, porque o GET desta tela ainda
 * não devolve a coluna `kind` — e a rota do GET não é deste pacote de
 * alteração. Quando ela passar a devolver, esta função sai e a tela lê o valor
 * do banco. Enquanto isso: mudou a regra na migração, muda aqui.
 */
function especieDoTipo(t: any): 'inteira' | 'meia' | 'gratuito' {
  const desconto = Number(t?.descontoBps ?? 0)
  if (desconto >= 10_000) return 'gratuito'
  if (desconto > 0 && t?.exigeDocumento) return 'meia'
  return 'inteira'
}

const SELO_ESPECIE: Record<string, { texto: string; classe: string }> = {
  meia: { texto: 'Meia-entrada', classe: 'selo-alerta' },
  gratuito: { texto: 'Gratuito', classe: 'selo-ok' },
}

/**
 * Quanto da cota legal deste lote já saiu.
 *
 * A cota é do LOTE e vale para todos os tipos de meia dele somados: um lote
 * com "Meia estudante" e "Meia idoso" tem uma cota só, não duas. O número sai
 * da mesma função que o checkout usa para recusar a venda — se as duas
 * discordassem, o produtor veria vaga onde o comprador ouve "acabou".
 *
 * Usa o teto legal (40%). O servidor lê `lots.half_quota_bps`, que hoje nasce
 * nesse mesmo valor em todo lote e não tem tela que mude — quando tiver, este
 * número precisa vir do GET junto com o resto do lote.
 */
function cotaDoLote(lote: any) {
  const meias = (lote.tipos ?? []).filter((t: any) => especieDoTipo(t) === 'meia')
  if (!meias.length) return null
  const cota = cotaDeMeias(Number(lote.quantidade), COTA_LEGAL_BPS)
  const vendidas = meias.reduce((s: number, t: any) => s + Number(t.vendidos), 0)
  return { cota, vendidas, restam: Math.max(cota - vendidas, 0) }
}

const inteiro = (n: number) => n.toLocaleString('pt-BR')

/* --------------------------------------------------------------- tipos ---- */
const tipoForm = reactive({
  aberto: false, id: '', loteId: '', nome: '', quantidade: 50,
  descontoBps: 0, exigeDocumento: false, maxPorCliente: null as number | null,
})
/** Quanto do lote ainda não foi distribuído entre os tipos. */
function sobraDoLote(loteId: string) {
  for (const s of data.value?.setores ?? []) {
    const l = s.lotes.find((x: any) => x.id === loteId)
    if (l) return Math.max(0, Number(l.quantidade) - l.tipos.reduce((a: number, t: any) => a + Number(t.quantidade), 0))
  }
  return 0
}
function abrirTipo(loteId: string, t?: any) {
  erro.value = ''
  Object.assign(tipoForm, {
    aberto: true, loteId,
    id: t?.id ?? '',
    nome: t?.nome ?? '',
    // tipo novo nasce com o que SOBRA do lote — um número fixo (50) estourava
    // o lote de 30 já no primeiro "Criar tipo"
    quantidade: t?.quantidade ?? sobraDoLote(loteId),
    descontoBps: t?.descontoBps ?? 0,
    exigeDocumento: t?.exigeDocumento ?? false,
    maxPorCliente: t?.maxPorCliente ?? null,
  })
}
async function salvarTipo() {
  const campos = {
    nome: tipoForm.nome || 'Inteira',
    quantidade: tipoForm.quantidade,
    descontoBps: tipoForm.descontoBps,
    exigeDocumento: tipoForm.exigeDocumento,
    maxPorCliente: tipoForm.maxPorCliente || null,
  }
  const ok = tipoForm.id
    ? await chamar('PATCH', { o: 'tipo', id: tipoForm.id, campos })
    : await chamar('POST', { o: 'tipo', loteId: tipoForm.loteId, ...campos })
  if (ok) tipoForm.aberto = false
}

/** Que espécie este tipo VAI ser quando salvar, com o que está no formulário. */
const especieDoForm = computed(() => especieDoTipo({
  descontoBps: tipoForm.descontoBps, exigeDocumento: tipoForm.exigeDocumento,
}))

/** O lote que o formulário está editando — é a cota DELE que a janela mostra. */
const loteDoForm = computed(() => {
  for (const s of data.value?.setores ?? []) {
    const l = s.lotes.find((x: any) => x.id === tipoForm.loteId)
    if (l) return l
  }
  return null
})

/* -------------------------------------------------------------- apagar ---- */
const confirmando = ref('')
async function apagar(o: string, alvoId: string) {
  if (confirmando.value !== `${o}:${alvoId}`) { confirmando.value = `${o}:${alvoId}`; return }
  confirmando.value = ''
  await chamar('DELETE', { o, id: alvoId })
}

/** Linhas abertas: o chevron mostra os tipos daquele lote. */
const expandidos = ref<string[]>([])
function expandir(loteId: string) {
  const i = expandidos.value.indexOf(loteId)
  if (i >= 0) expandidos.value.splice(i, 1)
  else expandidos.value.push(loteId)
}

async function alternarVisivel(lote: any) {
  await chamar('PATCH', { o: 'lote', id: lote.id, campos: { visivel: !lote.visivel } })
}

useHead({ title: 'Ingressos' })
</script>

<template>
  <div v-if="data" class="pb-16">
    <!-- ======================================================= cabeçalho -->
    <div class="flex flex-wrap items-start justify-between gap-3 py-5">
      <div>
        <h1 class="titulo text-2xl font-semibold text-tinta">Ingressos</h1>
        <p class="mt-1 text-tinta-suave">
          Crie, configure e gerencie os ingressos pagos e gratuitos do seu evento.
        </p>
      </div>
      <button type="button" class="btn-primario" @click="abrirSetor()">
        <IconeMenu nome="mais" :tamanho="18" /> Criar Setor
      </button>
    </div>

    <AbasSecao :evento-id="id" />

    <!-- ===================================================== giro de lote -->
    <div class="mt-5 flex flex-wrap items-center gap-3 rounded-card border border-linha bg-fundo-card px-4 py-3">
      <button type="button" role="switch" :aria-checked="data.evento.giroAutomatico"
              class="relative h-6 w-11 shrink-0 rounded-full transition-colors"
              :class="data.evento.giroAutomatico ? 'bg-acao' : 'bg-linha-forte'"
              :disabled="salvando" @click="alternarGiro">
        <span class="absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all"
              :class="data.evento.giroAutomatico ? 'left-[22px]' : 'left-0.5'" />
      </button>
      <div class="min-w-0">
        <p class="text-[15px] font-medium text-tinta">Lotes viram automaticamente</p>
        <p class="text-sm text-tinta-suave">
          Quando um lote esgota, o próximo do mesmo setor abre sozinho. Desligado, cada
          lote só aparece quando você mandar.
        </p>
      </div>
      <p class="ml-auto shrink-0 text-sm text-tinta-suave">
        Taxa <strong class="text-tinta">{{ (data.evento.taxaBps / 100).toFixed(2) }}%</strong> ·
        online: <strong class="text-tinta">{{ data.evento.modoTaxaOnline === 'repassar' ? 'comprador paga' : 'produção absorve' }}</strong>
      </p>
    </div>

    <p v-if="enderecoRenomeado" class="faixa-aviso mt-4">
      O endereço <strong>/e/{{ enderecoRenomeado.pedido }}</strong> já estava em uso, então a página
      deste evento ficou em <strong>/e/{{ enderecoRenomeado.novo }}</strong>. É esse que vale divulgar —
      dá pra trocar em <NuxtLink :to="`/admin/evento/${id}/configuracoes`" class="underline">Configurações</NuxtLink>
      enquanto não houver venda.
    </p>

    <p v-if="erro" class="mt-4 rounded-card border border-erro bg-erro-claro px-3 py-2 text-sm text-erro">
      {{ erro }}
    </p>

    <p v-if="!data.setores.length" class="card mt-4 py-12 text-center text-tinta-suave">
      Nenhum setor ainda. Crie o primeiro para começar a vender.
    </p>

    <!-- ======================================================== setores -->
    <section v-for="setor in data.setores" :key="setor.id" class="card mt-4 p-0">
      <header class="flex flex-wrap items-center gap-2 px-4 py-3">
        <h2 class="titulo text-base font-semibold uppercase tracking-wide text-acao">{{ setor.nome }}</h2>
        <button type="button" class="p-1 text-tinta-fraca hover:text-acao"
                :aria-label="`Editar ${setor.nome}`" @click="abrirSetor(setor)">
          <IconeMenu nome="lapis" :tamanho="16" />
        </button>
        <button type="button" class="p-1"
                :class="confirmando === `setor:${setor.id}` ? 'text-erro' : 'text-tinta-fraca hover:text-erro'"
                :aria-label="`Apagar ${setor.nome}`"
                :title="confirmando === `setor:${setor.id}` ? 'Clique de novo para confirmar' : ''"
                @click="apagar('setor', setor.id)">
          <IconeMenu nome="lixo" :tamanho="16" />
        </button>
        <span class="text-sm text-tinta-fraca">
          {{ ROTULO_TIPO[setor.tipo] }}
          <template v-if="setor.capacidade"> · capacidade {{ setor.capacidade }}</template>
          <template v-if="setor.sessaoId">
            · {{ data.sessoes.find((s: any) => s.id === setor.sessaoId)?.titulo }}
          </template>
        </span>
        <button type="button" class="btn-secundario ml-auto py-1.5 text-sm"
                @click="abrirLote(setor.id)">
          <IconeMenu nome="mais" :tamanho="16" /> Criar novo lote
        </button>
      </header>

      <p v-if="!setor.lotes.length" class="border-t border-linha px-4 py-6 text-sm text-tinta-fraca">
        Nenhum lote neste setor — nada à venda ainda.
      </p>

      <!-- tabela de lotes -->
      <div v-else class="overflow-x-auto">
        <table class="w-full min-w-[920px] border-collapse text-sm">
          <thead>
            <tr class="border-y border-linha bg-fundo-cinza/60 text-left">
              <th class="w-8" />
              <th class="titulo px-3 py-2 text-xs font-semibold uppercase tracking-wide text-tinta-rotulo">Lote</th>
              <th class="titulo px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-tinta-rotulo">Valor</th>
              <th class="titulo px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-tinta-rotulo">Vendido + Pendente</th>
              <th class="titulo px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-tinta-rotulo">Disponível</th>
              <th class="titulo w-40 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-tinta-rotulo">Ocupação</th>
              <th class="titulo px-3 py-2 text-xs font-semibold uppercase tracking-wide text-tinta-rotulo">Disponibilidade</th>
              <th class="titulo px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-tinta-rotulo">Ações</th>
            </tr>
          </thead>

          <tbody>
            <template v-for="lote in setor.lotes" :key="lote.id">
              <tr class="border-b border-linha align-middle last:border-0">
                <td class="pl-2">
                  <button v-if="lote.tipos.length" type="button"
                          class="p-1 text-tinta-fraca transition-transform hover:text-tinta"
                          :class="expandidos.includes(lote.id) && 'rotate-180'"
                          :aria-label="`Tipos de ${lote.nome}`" @click="expandir(lote.id)">
                    <IconeMenu nome="baixo" :tamanho="16" />
                  </button>
                </td>

                <td class="px-3 py-3">
                  <p class="font-medium text-tinta">{{ lote.nome }}</p>
                  <p v-if="rotuloCanais(lote.canais)" class="text-xs text-alerta">{{ rotuloCanais(lote.canais) }}</p>
                  <p v-if="lote.abreEm || lote.expiraEm" class="text-xs text-tinta-fraca">
                    <template v-if="lote.abreEm">abre {{ dataHora(lote.abreEm) }}</template>
                    <template v-if="lote.abreEm && lote.expiraEm"> · </template>
                    <template v-if="lote.expiraEm">fecha {{ dataHora(lote.expiraEm) }}</template>
                  </p>
                </td>

                <!-- as quatro pontas do dinheiro, empilhadas na coluna de valor -->
                <td class="px-3 py-3 text-right">
                  <p class="titulo font-semibold tabular-nums text-tinta">{{ reais(lote.totalCents) }}</p>
                  <p class="text-xs tabular-nums text-tinta-fraca">
                    face {{ reais(lote.faceCents) }} + taxa {{ reais(lote.taxaCents) }}
                  </p>
                  <p class="text-xs tabular-nums text-ok">
                    produção recebe {{ reais(lote.produtorRecebeCents) }}
                  </p>
                </td>

                <td class="px-3 py-3 text-right tabular-nums text-tinta">
                  {{ lote.vendidos + lote.reservados }}
                  <span v-if="lote.reservados" class="block text-xs text-tinta-fraca">
                    {{ lote.vendidos }} pago · {{ lote.reservados }} em carrinho
                  </span>
                </td>

                <td class="px-3 py-3 text-right tabular-nums text-tinta">
                  {{ lote.disponivel }}
                  <span class="block text-xs text-tinta-fraca">de {{ lote.quantidade }}</span>
                </td>

                <td class="px-3 py-3">
                  <div class="h-2 w-full overflow-hidden rounded-full bg-fundo-cinza">
                    <div class="h-full rounded-full bg-acao"
                         :style="{ width: `${lote.quantidade ? Math.min(100, ((lote.vendidos + lote.reservados) / lote.quantidade) * 100) : 0}%` }" />
                  </div>
                  <p class="mt-1 text-xs tabular-nums text-tinta-fraca">
                    {{ lote.quantidade ? Math.round(((lote.vendidos + lote.reservados) / lote.quantidade) * 100) : 0 }}%
                  </p>
                </td>

                <td class="px-3 py-3">
                  <span :class="disponibilidade(lote).classe">{{ disponibilidade(lote).texto }}</span>
                </td>

                <td class="px-3 py-3">
                  <div class="flex items-center justify-end gap-1">
                    <button type="button" class="p-1 text-tinta-fraca hover:text-acao"
                            title="Preço redondo"
                            @click="alvo.loteId = alvo.loteId === lote.id ? '' : lote.id">
                      <IconeMenu nome="etiqueta" :tamanho="16" />
                    </button>
                    <button type="button" class="p-1 text-tinta-fraca hover:text-acao"
                            title="Novo tipo de ingresso" @click="abrirTipo(lote.id)">
                      <IconeMenu nome="mais" :tamanho="16" />
                    </button>
                    <button type="button" class="p-1 text-tinta-fraca hover:text-acao"
                            :title="lote.visivel ? 'Ocultar da página de venda' : 'Mostrar na página de venda'"
                            @click="alternarVisivel(lote)">
                      <IconeMenu :nome="lote.visivel ? 'check' : 'fechar'" :tamanho="16" />
                    </button>
                    <button type="button" class="p-1 text-tinta-fraca hover:text-acao"
                            title="Editar lote" @click="abrirLote(setor.id, lote)">
                      <IconeMenu nome="lapis" :tamanho="16" />
                    </button>
                    <button type="button" class="p-1 disabled:opacity-30"
                            :class="confirmando === `lote:${lote.id}` ? 'text-erro' : 'text-tinta-fraca hover:text-erro'"
                            :disabled="!lote.podeApagar"
                            :title="lote.podeApagar
                              ? (confirmando === `lote:${lote.id}` ? 'Clique de novo para confirmar' : 'Apagar lote')
                              : 'Lote com venda não pode ser apagado'"
                            @click="apagar('lote', lote.id)">
                      <IconeMenu nome="lixo" :tamanho="16" />
                    </button>
                  </div>
                </td>
              </tr>

              <!-- conta ao contrário -->
              <tr v-if="alvo.loteId === lote.id" class="border-b border-linha bg-acao-fraco">
                <td />
                <td colspan="7" class="px-3 py-4">
                  <p class="text-sm font-medium text-tinta">Quero que o comprador pague um valor redondo</p>
                  <p class="mt-1 text-xs text-tinta-suave">
                    A face é calculada de trás pra frente, para o total bater exato com a taxa dentro.
                  </p>
                  <div class="mt-3 flex flex-wrap items-end gap-3">
                    <div class="w-40">
                      <label class="rotulo">Comprador paga</label>
                      <CampoMoeda v-model="alvo.totalCents" />
                    </div>
                    <p v-if="previaAlvo" class="pb-2 text-sm text-tinta-suave">
                      face <strong class="text-tinta">{{ reais(previaAlvo.face) }}</strong>
                      + taxa <strong class="text-tinta">{{ reais(previaAlvo.taxa) }}</strong>
                      = <strong class="text-tinta">{{ reais(previaAlvo.total) }}</strong>
                    </p>
                    <div class="ml-auto flex gap-2">
                      <button type="button" class="btn-secundario" @click="alvo.loteId = ''">Cancelar</button>
                      <button type="button" class="btn-primario" :disabled="!previaAlvo || salvando"
                              @click="aplicarAlvo(lote.id)">Aplicar</button>
                    </div>
                  </div>
                </td>
              </tr>

              <!-- tipos do lote -->
              <template v-if="expandidos.includes(lote.id)">
                <!-- A cota legal da meia deste lote. Fica ACIMA dos tipos
                     porque ela vale para todos eles somados: o produtor
                     precisa ver que "Meia estudante" e "Meia idoso" dividem o
                     mesmo teto, e não têm um cada. -->
                <tr v-if="cotaDoLote(lote)" class="border-b border-linha bg-alerta-claro">
                  <td />
                  <td colspan="7" class="px-3 py-2 pl-6">
                    <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span class="selo-alerta">Meia-entrada</span>
                      <span class="text-sm text-tinta-corpo">
                        Cota legal de 40% deste lote:
                        <strong class="tabular-nums text-tinta">{{ inteiro(cotaDoLote(lote)!.vendidas) }}</strong>
                        de <strong class="tabular-nums text-tinta">{{ inteiro(cotaDoLote(lote)!.cota) }}</strong>
                        vendidas ·
                        <strong class="tabular-nums text-tinta">{{ inteiro(cotaDoLote(lote)!.restam) }}</strong>
                        ainda cabem
                      </span>
                      <span v-if="!cotaDoLote(lote)!.restam" class="selo-erro">Cota esgotada</span>
                      <span class="ml-auto w-40 shrink-0">
                        <span class="block h-2 w-full overflow-hidden rounded-full bg-white">
                          <span class="block h-full rounded-full bg-alerta"
                                :style="{ width: `${cotaDoLote(lote)!.cota
                                  ? Math.min(100, (cotaDoLote(lote)!.vendidas / cotaDoLote(lote)!.cota) * 100) : 0}%` }" />
                        </span>
                      </span>
                    </div>
                    <p class="mt-1 text-xs text-tinta-suave">
                      Lei 12.933/2013: quando a cota acaba, o comprador ouve que a meia
                      esgotou e a inteira deste lote segue à venda.
                    </p>
                  </td>
                </tr>

                <tr v-for="t in lote.tipos" :key="t.id" class="border-b border-linha bg-fundo-cinza/40">
                  <td />
                  <td class="px-3 py-2 pl-6">
                    <span class="font-medium text-tinta">{{ t.nome }}</span>
                    <span v-if="t.descontoBps" class="selo-neutro ml-2">−{{ (t.descontoBps / 100).toFixed(0) }}%</span>
                    <span v-if="SELO_ESPECIE[especieDoTipo(t)]"
                          class="ml-2" :class="SELO_ESPECIE[especieDoTipo(t)].classe">
                      {{ SELO_ESPECIE[especieDoTipo(t)].texto }}
                    </span>
                    <span v-if="t.exigeDocumento" class="ml-2 text-xs text-tinta-fraca">com documento</span>
                  </td>
                  <td class="px-3 py-2 text-right">
                    <span class="tabular-nums text-tinta">{{ reais(t.totalCents) }}</span>
                    <span class="block text-xs tabular-nums text-tinta-fraca">
                      face {{ reais(t.faceCents) }} + taxa {{ reais(t.taxaCents) }}
                    </span>
                  </td>
                  <td class="px-3 py-2 text-right tabular-nums text-tinta-suave">{{ t.vendidos }}</td>
                  <td class="px-3 py-2 text-right tabular-nums text-tinta-suave">
                    {{ t.quantidade - t.vendidos }}
                    <span class="block text-xs text-tinta-fraca">de {{ t.quantidade }}</span>
                  </td>
                  <td colspan="2" class="px-3 py-2 text-xs text-tinta-fraca">
                    <template v-if="t.maxPorCliente">máx. {{ t.maxPorCliente }} por cliente</template>
                  </td>
                  <td class="px-3 py-2">
                    <div class="flex items-center justify-end gap-1">
                      <button type="button" class="p-1 text-tinta-fraca hover:text-acao"
                              title="Editar tipo" @click="abrirTipo(lote.id, t)">
                        <IconeMenu nome="lapis" :tamanho="14" />
                      </button>
                      <button type="button" class="p-1 disabled:opacity-30"
                              :class="confirmando === `tipo:${t.id}` ? 'text-erro' : 'text-tinta-fraca hover:text-erro'"
                              :disabled="!t.podeApagar"
                              :title="t.podeApagar ? 'Apagar tipo' : 'Tipo com venda não pode ser apagado'"
                              @click="apagar('tipo', t.id)">
                        <IconeMenu nome="lixo" :tamanho="14" />
                      </button>
                    </div>
                  </td>
                </tr>
              </template>
            </template>
          </tbody>
        </table>
      </div>
    </section>

    <!-- ================================================ rodapé do total -->
    <div v-if="data.setores.length"
         class="sticky bottom-0 mt-4 flex flex-wrap items-center gap-x-8 gap-y-1 rounded-card bg-acao px-5 py-3 text-white">
      <p class="titulo text-base font-semibold">
        Quantidade Total: <span class="tabular-nums">{{ totais.quantidade }}</span>
        <span v-if="totais.teto" class="font-normal opacity-80"> / {{ totais.teto }}</span>
      </p>
      <p class="text-sm opacity-90">
        Vendido + pendente: <span class="tabular-nums">{{ totais.vendidos + totais.reservados }}</span>
      </p>
      <p class="text-sm opacity-90">
        Disponível: <span class="tabular-nums">{{ totais.disponivel }}</span>
      </p>
      <NuxtLink v-if="podeDashboard" :to="`/admin/evento/${id}/dashboard`"
                class="ml-auto rounded-card border border-white/60 px-3 py-1.5 text-sm font-semibold hover:bg-white/10">
        Ir para o dashboard
      </NuxtLink>
    </div>

    <!-- ==================================================== janela setor -->
    <ModalLateral v-if="setorForm.aberto" :titulo="setorForm.id ? 'Editar setor' : 'Criar setor'"
                  @fechar="setorForm.aberto = false">
      <div class="grid gap-3">
        <div>
          <label for="sn" class="rotulo">Nome</label>
          <input id="sn" v-model="setorForm.nome" class="campo" placeholder="Ex: Entrada individual sábado">
        </div>
        <div v-if="!setorForm.id">
          <label for="st" class="rotulo">Tipo</label>
          <select id="st" v-model="setorForm.tipo" class="campo">
            <option v-for="(v, k) in ROTULO_TIPO" :key="k" :value="k">{{ v }}</option>
          </select>
        </div>
        <div v-if="!setorForm.id && data.sessoes.length">
          <label for="ss" class="rotulo">Sessão</label>
          <select id="ss" v-model="setorForm.sessaoId" class="campo">
            <option value="">Todas</option>
            <option v-for="s in data.sessoes" :key="s.id" :value="s.id">
              {{ s.titulo ?? dataCurta(s.inicio) }}
            </option>
          </select>
        </div>
        <div>
          <label for="sc" class="rotulo">Capacidade (opcional)</label>
          <input id="sc" v-model.number="setorForm.capacidade" type="number" min="1"
                 class="campo tabular-nums" placeholder="sem teto">
          <p class="mt-1 text-xs text-tinta-fraca">
            Teto do setor. A soma dos lotes não pode passar disso.
          </p>
        </div>
        <div>
          <label for="sd" class="rotulo">Descrição (opcional)</label>
          <textarea id="sd" v-model="setorForm.descricao" rows="2" class="campo"
                    placeholder="O que está incluso neste setor" />
        </div>
      </div>
      <!-- o erro do servidor aparece DENTRO da janela (o do topo fica atrás dela) -->
      <p v-if="erro" class="mt-3 rounded-card border border-erro bg-erro-claro px-3 py-2 text-sm text-erro" role="alert">
        {{ erro }}
      </p>
      <template #acoes>
        <button type="button" class="btn-secundario" @click="setorForm.aberto = false">Cancelar</button>
        <button type="button" class="btn-primario" :disabled="salvando" @click="salvarSetor">
          {{ setorForm.id ? 'Salvar' : 'Criar setor' }}
        </button>
      </template>
    </ModalLateral>

    <!-- ===================================================== janela lote -->
    <ModalLateral v-if="loteForm.aberto" :titulo="loteForm.id ? 'Editar lote' : 'Criar novo lote'"
                  @fechar="loteForm.aberto = false">
      <div class="grid gap-3 sm:grid-cols-2">
        <div class="sm:col-span-2">
          <label class="rotulo">Nome do lote</label>
          <input v-model="loteForm.nome" class="campo" placeholder="1º lote">
        </div>
        <div>
          <label class="rotulo">Valor de face</label>
          <CampoMoeda v-model="loteForm.faceCents" :disabled="loteForm.gratuito"
                      :conferir-abaixo="CONFERIR_ABAIXO_CENTS" />
          <label class="mt-1.5 flex items-center gap-2 text-sm text-tinta-corpo">
            <input type="checkbox" :checked="loteForm.gratuito"
                   @change="marcarGratuito(($event.target as HTMLInputElement).checked)">
            Ingresso gratuito
          </label>
        </div>
        <div>
          <label class="rotulo">Quantidade</label>
          <input v-model.number="loteForm.quantidade" type="number" min="0" class="campo tabular-nums">
        </div>
        <div>
          <label class="rotulo">Mín. por compra</label>
          <input v-model.number="loteForm.minPorCompra" type="number" min="1" max="50" class="campo tabular-nums">
        </div>
        <div>
          <label class="rotulo">Máx. por compra</label>
          <input v-model.number="loteForm.maxPorCompra" type="number" min="1" max="50" class="campo tabular-nums">
        </div>
        <div>
          <label class="rotulo">Abre em (opcional)</label>
          <input v-model="loteForm.abreEm" type="datetime-local" class="campo">
        </div>
        <div>
          <label class="rotulo">Fecha em (opcional)</label>
          <input v-model="loteForm.expiraEm" type="datetime-local" class="campo">
        </div>
        <div class="sm:col-span-2">
          <p class="rotulo">Onde vende</p>
          <div class="flex flex-wrap gap-4 text-sm text-tinta-corpo">
            <label class="flex items-center gap-2">
              <input type="checkbox" :checked="loteForm.canais.includes('online')"
                     @change="alternarCanal('online')"> Site
            </label>
            <label class="flex items-center gap-2">
              <input type="checkbox" :checked="loteForm.canais.includes('bilheteria')"
                     @change="alternarCanal('bilheteria')"> Bilheteria (balcão)
            </label>
          </div>
        </div>
        <label class="flex items-center gap-2 text-sm text-tinta-corpo sm:col-span-2">
          <input v-model="loteForm.visivel" type="checkbox"> Visível na página de venda
        </label>
      </div>
      <p v-if="previaLote?.face" class="mt-3 rounded-card bg-acao-fraco px-3 py-2 text-sm text-tinta-suave">
        O comprador vai pagar
        <strong class="text-tinta">{{ reais(previaLote.total) }}</strong>
        ({{ reais(previaLote.face) }} + {{ reais(previaLote.taxa) }} de taxa)
      </p>
      <p v-else-if="loteForm.gratuito" class="faixa-aviso mt-3">
        <strong>Gratuito:</strong> sai por R$ 0,00 — o comprador não paga nada e o
        ingresso continua saindo do estoque.
      </p>
      <p v-else class="mt-3 rounded-card border border-erro bg-erro-claro px-3 py-2 text-sm text-erro">
        O valor está R$ 0,00. Digite o preço ou marque "Ingresso gratuito".
      </p>
      <p v-if="erroLote" class="mt-3 rounded-card border border-erro bg-erro-claro px-3 py-2 text-sm text-erro"
         role="alert">
        {{ erroLote }}
      </p>
      <template #acoes>
        <button type="button" class="btn-secundario" @click="loteForm.aberto = false">Cancelar</button>
        <button type="button" class="btn-primario" :disabled="salvando" @click="salvarLote">
          {{ loteForm.id ? 'Salvar' : 'Criar lote' }}
        </button>
      </template>
    </ModalLateral>

    <!-- ===================================================== janela tipo -->
    <ModalLateral v-if="tipoForm.aberto" :titulo="tipoForm.id ? 'Editar tipo' : 'Novo tipo de ingresso'"
                  @fechar="tipoForm.aberto = false">
      <div class="grid gap-3 sm:grid-cols-2">
        <div class="sm:col-span-2">
          <label class="rotulo">Nome</label>
          <input v-model="tipoForm.nome" class="campo" placeholder="Meia-entrada">
        </div>
        <div>
          <label class="rotulo">Quantidade</label>
          <input v-model.number="tipoForm.quantidade" type="number" min="0" class="campo tabular-nums">
        </div>
        <div>
          <label class="rotulo">Desconto (%)</label>
          <input :value="tipoForm.descontoBps / 100" type="number" min="0" max="100" step="1"
                 class="campo tabular-nums"
                 @input="tipoForm.descontoBps = Math.round(Number(($event.target as HTMLInputElement).value) * 100)">
        </div>
        <div>
          <label class="rotulo">Máx. por cliente (opcional)</label>
          <input v-model.number="tipoForm.maxPorCliente" type="number" min="1" class="campo tabular-nums"
                 placeholder="sem limite">
        </div>
        <label class="flex items-center gap-2 pt-6 text-sm text-tinta-corpo">
          <input v-model="tipoForm.exigeDocumento" type="checkbox"> Exige documento
        </label>
      </div>

      <!-- O que este tipo VAI ser. A espécie não é um campo separado: ela sai
           do desconto + "exige documento", que é o que o produtor já preenche.
           Mostrar o resultado aqui é o que impede a confusão cara — criar
           "Meia-entrada" sem marcar o documento e achar que a cota de 40%
           está valendo quando não está. -->
      <div v-if="especieDoForm === 'meia'" class="faixa-aviso mt-3">
        <p class="font-semibold text-tinta">Isto é uma meia-entrada legal.</p>
        <p class="mt-1">
          Vale para até 40% dos ingressos do lote<template v-if="loteDoForm">
            — <strong class="tabular-nums">{{ inteiro(cotaDeMeias(Number(loteDoForm.quantidade))) }}</strong>
            em "{{ loteDoForm.nome }}"</template>. O comprador escolhe o motivo na compra
          e a portaria confere:
        </p>
        <ul class="mt-2 space-y-1">
          <li v-for="(m, chave) in MOTIVOS" :key="chave" class="text-xs">
            <strong class="text-tinta">{{ m.rotulo }}</strong> — {{ m.documento }}
          </li>
        </ul>
      </div>

      <div v-else-if="tipoForm.descontoBps > 0 && tipoForm.descontoBps < 10000"
           class="faixa-aviso mt-3">
        <p class="font-semibold text-tinta">Isto é uma promoção, não meia-entrada.</p>
        <p class="mt-1">
          Desconto sem documento não entra na cota de 40% e a portaria não vai pedir
          comprovação nenhuma na entrada. Marque <strong>Exige documento</strong> para
          valer como meia-entrada da Lei 12.933/2013.
        </p>
      </div>

      <div v-else-if="especieDoForm === 'gratuito'" class="faixa-aviso mt-3">
        <p class="font-semibold text-tinta">Isto é uma gratuidade.</p>
        <p class="mt-1">
          Sai por R$ 0,00 e não consome a cota de meia-entrada do lote — mas continua
          tirando ingresso do estoque.
        </p>
      </div>

      <p v-if="erro" class="mt-3 rounded-card border border-erro bg-erro-claro px-3 py-2 text-sm text-erro" role="alert">
        {{ erro }}
      </p>

      <template #acoes>
        <button type="button" class="btn-secundario" @click="tipoForm.aberto = false">Cancelar</button>
        <button type="button" class="btn-primario" :disabled="salvando" @click="salvarTipo">
          {{ tipoForm.id ? 'Salvar' : 'Criar tipo' }}
        </button>
      </template>
    </ModalLateral>
  </div>

  <p v-else-if="pending" class="card mt-6 text-tinta-suave">Carregando…</p>

  <div v-else class="card mt-6">
    <p class="rotulo-kpi text-erro">Não foi possível carregar os ingressos</p>
    <p class="mt-1 text-sm text-tinta-suave">
      {{ (falha as any)?.data?.statusMessage || (falha as any)?.message || 'Erro desconhecido.' }}
    </p>
    <button type="button" class="btn-secundario mt-3" @click="refresh()">Tentar de novo</button>
  </div>
</template>
