<script setup lang="ts">
/**
 * Inteligência → Base de conhecimento (pedido do dono, 05/10): "o robô está programado pra uma
 * coisa, a pessoa quer colocar informação nova — coloca lá e já dispara pra todas as automações".
 *
 * Como funciona: cada item vira uma linha em `fp_conhecimento` (banco da automação) e TODO robô —
 * WhatsApp, Instagram e comentários — lê a tabela no nó "Base do painel" a cada mensagem. Salvou,
 * vale na próxima mensagem; arquivou, para de valer. Nada de editar prompt na mão nem de esperar
 * alguém mexer no n8n. "Dia fechado" e "dia aberto" mudam a CONTA de funcionamento (hoje, amanhã,
 * calendário, datas que o cliente cita); informação e aviso entram como uma seção do prompt que
 * vale mais que a base fixa — mas nunca muda preço nem link de compra (esses vêm do site, ao vivo).
 *
 * "Revisar com IA" reescreve claro e aponta conflito com o que já está ativo; "Testar com a Sofia"
 * manda a pergunta pelo caminho REAL do WhatsApp com um número de teste (nada é enviado a ninguém).
 * A tela fala só com `/api/admin/inteligencia/base/*` (área `agentes`, só master).
 */
definePageMeta({ layout: 'admin' })
useHead({ title: 'Base de conhecimento' })

type Tipo = 'informacao' | 'aviso' | 'dia_fechado' | 'dia_aberto'
type Canal = 'whatsapp' | 'instagram' | 'comentarios'
type Item = {
  id: string; tipo: Tipo; titulo: string; texto: string; dia: string | null; vale_de: string | null
  vale_ate: string | null; canais: Canal[]; ativo: boolean; criado_por: string | null; criado_em: string
  atualizado_por: string | null; atualizado_em: string
}
type Revisao = { titulo_sugerido: string; texto_sugerido: string; conflitos: { titulo: string; porque: string }[]; duvidas: string[]; alerta: string }

const TIPOS: { valor: Tipo; nome: string; ajuda: string }[] = [
  { valor: 'informacao', nome: 'Informação', ajuda: 'Algo que a Sofia passa a saber (regra, novidade, resposta pronta).' },
  { valor: 'aviso', nome: 'Aviso temporário', ajuda: 'Vale por um período: atração em manutenção, mudança de horário.' },
  { valor: 'dia_fechado', nome: 'Dia fechado', ajuda: 'O parque NÃO abre nesse dia, mesmo sendo sexta, sábado, domingo ou feriado.' },
  { valor: 'dia_aberto', nome: 'Dia aberto especial', ajuda: 'O parque abre num dia que normalmente fecha (ex.: quinta de feriado escolar).' },
]
const NOME_DO_TIPO = Object.fromEntries(TIPOS.map((t) => [t.valor, t.nome])) as Record<Tipo, string>
const CANAIS: { valor: Canal; nome: string }[] = [
  { valor: 'whatsapp', nome: 'WhatsApp' }, { valor: 'instagram', nome: 'Instagram (Direct)' }, { valor: 'comentarios', nome: 'Comentários' },
]
const ehDia = (t: Tipo) => t === 'dia_fechado' || t === 'dia_aberto'

const { data, pending, error: falha, refresh } = await useFetch<{
  itens: Item[]; historico: { id: number; item_id: string; acao: string; autor: string | null; em: string; titulo: string | null }[]
  robos_veem: Record<Canal, string>
}>('/api/admin/inteligencia/base')

const verArquivados = ref(false)
const itens = computed(() => (data.value?.itens ?? []).filter((i) => i.ativo !== verArquivados.value))
const totalAtivos = computed(() => (data.value?.itens ?? []).filter((i) => i.ativo).length)

/* ------------------------------------------------------------------ datas */
const hojeIso = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bahia' }).format(new Date())
const dataBR = (iso?: string | null) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '')
const quando = (ts?: string | null) => ts
  ? new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Bahia', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(ts))
  : ''
/** item que já passou (dia ou "vale até" antes de hoje): continua ativo no banco, mas robô nenhum lê */
const venceu = (i: Item) => {
  const h = hojeIso()
  return (!!i.dia && i.dia < h) || (!!i.vale_ate && i.vale_ate < h)
}
const aindaNao = (i: Item) => !!i.vale_de && !ehDia(i.tipo) && i.vale_de > hojeIso()

/* ------------------------------------------------------------------ formulário */
const vazio = () => ({ id: '', tipo: 'informacao' as Tipo, titulo: '', texto: '', dia: '', vale_de: '', vale_ate: '',
  canais: ['whatsapp', 'instagram', 'comentarios'] as Canal[], ativo: true })
const form = reactive(vazio())
const editando = ref(false)
const salvando = ref(false)
const erroForm = ref('')
const recado = ref('')
const revisao = ref<Revisao | null>(null)
const revisando = ref(false)

function novo(tipo: Tipo = 'informacao') {
  Object.assign(form, vazio(), { tipo })
  revisao.value = null; erroForm.value = ''; editando.value = true
  nextTick(() => document.getElementById('base-titulo')?.focus())
}
function editar(i: Item) {
  Object.assign(form, { id: i.id, tipo: i.tipo, titulo: i.titulo, texto: i.texto, dia: i.dia ?? '', vale_de: i.vale_de ?? '',
    vale_ate: i.vale_ate ?? '', canais: [...i.canais], ativo: i.ativo })
  revisao.value = null; erroForm.value = ''; editando.value = true
  nextTick(() => document.getElementById('form-base')?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
}
function cancelar() { editando.value = false; revisao.value = null; erroForm.value = '' }

const rotuloTexto = computed(() => form.tipo === 'dia_fechado' ? 'Motivo (a Sofia fala isso pro cliente)'
  : form.tipo === 'dia_aberto' ? 'O que é esse dia (a Sofia fala isso pro cliente)' : 'O que a Sofia precisa saber')
const exemploTexto = computed(() => ({
  informacao: 'Ex.: O parque agora aceita cartão de crédito na bilheteria, em até 3x.',
  aviso: 'Ex.: O tobogã azul está em manutenção; as outras atrações funcionam normalmente.',
  dia_fechado: 'Ex.: dia de eleição',
  dia_aberto: 'Ex.: feriado do Dia do Professor',
} as Record<Tipo, string>)[form.tipo])

function mensagemDe(e: any, padrao: string) {
  return e?.data?.statusMessage || e?.statusMessage || padrao
}

async function salvar() {
  erroForm.value = ''
  if (!form.canais.length) { erroForm.value = 'Marque ao menos um canal.'; return }
  salvando.value = true
  try {
    await $fetch('/api/admin/inteligencia/base/salvar', { method: 'POST', body: { item: { ...form } } })
    recado.value = form.id ? 'Alteração salva — vale na próxima mensagem dos robôs.' : 'Salvo — vale na próxima mensagem dos robôs.'
    editando.value = false; revisao.value = null
    await refresh()
  } catch (e: any) {
    erroForm.value = mensagemDe(e, 'Não consegui salvar agora. Confira a internet e tente de novo.')
  } finally {
    salvando.value = false
  }
}

async function revisar() {
  erroForm.value = ''; revisao.value = null; revisando.value = true
  try {
    revisao.value = await $fetch<Revisao>('/api/admin/inteligencia/base/revisar', { method: 'POST', body: { item: { ...form } } })
  } catch (e: any) {
    erroForm.value = mensagemDe(e, 'A revisão não respondeu agora. Dá pra salvar mesmo assim.')
  } finally {
    revisando.value = false
  }
}
function usarSugestao() {
  if (!revisao.value) return
  if (revisao.value.texto_sugerido) form.texto = revisao.value.texto_sugerido
  if (revisao.value.titulo_sugerido) form.titulo = revisao.value.titulo_sugerido
}

/* ------------------------------------------------------------------ arquivar / reativar */
const confirmando = ref('')   // id do item com a confirmação aberta (sem caixa nativa do navegador)
const mexendo = ref('')
const erroLista = ref('')
async function arquivar(i: Item) {
  mexendo.value = i.id; erroLista.value = ''
  try {
    await $fetch('/api/admin/inteligencia/base/arquivar', { method: 'POST', body: { id: i.id } })
    recado.value = `"${i.titulo}" arquivado — os robôs param de usar na próxima mensagem.`
    confirmando.value = ''
    await refresh()
  } catch (e: any) {
    erroLista.value = mensagemDe(e, 'Não consegui arquivar agora.')
  } finally {
    mexendo.value = ''
  }
}
async function reativar(i: Item) {
  mexendo.value = i.id; erroLista.value = ''
  try {
    await $fetch('/api/admin/inteligencia/base/salvar', { method: 'POST', body: { item: { ...i, dia: i.dia ?? '', vale_de: i.vale_de ?? '', vale_ate: i.vale_ate ?? '', ativo: true } } })
    recado.value = `"${i.titulo}" voltou a valer.`
    await refresh()
  } catch (e: any) {
    erroLista.value = mensagemDe(e, 'Não consegui reativar agora.')
  } finally {
    mexendo.value = ''
  }
}

/* ------------------------------------------------------------------ como a Sofia lê agora */
const canalVisto = ref<Canal>('whatsapp')
const textoDoCanal = computed(() => data.value?.robos_veem?.[canalVisto.value] ?? '')

/* ------------------------------------------------------------------ testar com a Sofia */
const pergunta = ref('')
const testando = ref(false)
const teste = ref<{ bolhas: string[]; datas_citadas?: string | null; sem_resposta?: boolean } | null>(null)
const erroTeste = ref('')
let paraDeEsperar = false
onBeforeUnmount(() => { paraDeEsperar = true })
async function testar() {
  const p = pergunta.value.trim()
  if (p.length < 2) return
  testando.value = true; teste.value = null; erroTeste.value = ''
  try {
    const { msg_id } = await $fetch<{ msg_id: string }>('/api/admin/inteligencia/base/testar', { method: 'POST', body: { pergunta: p } })
    const inicio = Date.now()
    while (!paraDeEsperar && Date.now() - inicio < 150_000) {
      await new Promise((r) => setTimeout(r, 4000))
      const r = await $fetch<any>('/api/admin/inteligencia/base/resultado', { query: { msg_id } })
      if (r?.pronto) { teste.value = r; return }
    }
    if (!paraDeEsperar) erroTeste.value = 'A Sofia demorou mais que 2 minutos pra responder o teste. Tente de novo.'
  } catch (e: any) {
    erroTeste.value = mensagemDe(e, 'Não consegui fazer o teste agora.')
  } finally {
    testando.value = false
  }
}

const ACAO: Record<string, string> = { criou: 'criou', editou: 'editou', arquivou: 'arquivou' }
</script>

<template>
  <div>
    <header class="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 class="titulo text-2xl font-semibold text-tinta">Base de conhecimento</h1>
        <p class="apoio-bloco">O que você escrever aqui vale na <strong>próxima mensagem</strong> de todos os robôs — WhatsApp, Instagram e comentários.</p>
      </div>
      <button type="button" class="btn-primario" data-parte="nova-informacao" @click="novo()">Nova informação</button>
    </header>

    <p v-if="recado" class="mt-5 rounded-xl bg-success-50 px-4 py-3 text-sm text-success-800 ring-1 ring-inset ring-success-600/30" role="status" data-parte="recado">{{ recado }}</p>

    <div v-if="falha" class="mt-5" :class="falha.statusCode === 503 ? 'faixa-aviso' : 'faixa-erro'" role="alert">
      <p class="font-semibold">{{ falha.statusCode === 503 ? 'Ainda não ligado neste servidor' : 'Não consegui ler a base agora' }}</p>
      <p class="mt-1">{{ falha.data?.statusMessage || falha.statusMessage || 'Tente de novo em 1 minuto.' }}</p>
      <button v-if="falha.statusCode !== 503" type="button" class="btn-secundario mt-3" @click="refresh()">Tentar de novo</button>
    </div>

    <!-- ============================================================ formulário -->
    <form v-if="editando" id="form-base" class="card mt-5 grid gap-4" data-parte="form-base" @submit.prevent="salvar">
      <h2 class="titulo text-lg font-semibold text-tinta">{{ form.id ? 'Editar' : 'Nova' }} {{ NOME_DO_TIPO[form.tipo].toLowerCase() }}</h2>

      <fieldset>
        <legend class="rotulo">Tipo</legend>
        <div class="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          <label v-for="t in TIPOS" :key="t.valor"
                 class="flex cursor-pointer flex-col gap-1 rounded-md border p-3 text-sm"
                 :class="form.tipo === t.valor ? 'border-acao bg-acao/5 ring-1 ring-acao' : 'border-line-200/60 hover:bg-fundo-cinza'">
            <span class="flex items-center gap-2 font-semibold text-tinta">
              <input v-model="form.tipo" type="radio" name="tipo" :value="t.valor" class="accent-[var(--cor-acao,#2f6f84)]">
              {{ t.nome }}
            </span>
            <span class="text-xs text-tinta-suave">{{ t.ajuda }}</span>
          </label>
        </div>
      </fieldset>

      <div class="grid gap-4 md:grid-cols-[1fr_220px]">
        <div>
          <label for="base-titulo" class="rotulo">Título (pra equipe achar depois)</label>
          <input id="base-titulo" v-model="form.titulo" class="campo" maxlength="120" required
                 :placeholder="ehDia(form.tipo) ? 'Ex.: Domingo de eleição' : 'Ex.: Cartão na bilheteria'">
        </div>
        <div v-if="ehDia(form.tipo)">
          <label for="base-dia" class="rotulo">Dia</label>
          <input id="base-dia" v-model="form.dia" type="date" class="campo" :min="hojeIso()" required>
        </div>
      </div>

      <div>
        <label for="base-texto" class="rotulo">{{ rotuloTexto }}</label>
        <textarea id="base-texto" v-model="form.texto" class="campo min-h-[96px]" :maxlength="ehDia(form.tipo) ? 200 : 1500" required
                  :placeholder="exemploTexto" />
        <p class="mt-1 text-xs text-tinta-suave">
          Preço e link de compra <strong>não</strong> se escrevem aqui: a Sofia lê os dois ao vivo do site de vendas.
        </p>
      </div>

      <div v-if="!ehDia(form.tipo)" class="grid gap-4 sm:grid-cols-2">
        <div>
          <label for="base-de" class="rotulo">Vale a partir de — opcional</label>
          <input id="base-de" v-model="form.vale_de" type="date" class="campo">
        </div>
        <div>
          <label for="base-ate" class="rotulo">Vale até — {{ form.tipo === 'aviso' ? 'recomendado' : 'opcional' }}</label>
          <input id="base-ate" v-model="form.vale_ate" type="date" class="campo" :min="form.vale_de || hojeIso()">
          <p class="mt-1 text-xs text-tinta-suave">Depois dessa data a Sofia esquece sozinha.</p>
        </div>
      </div>

      <fieldset>
        <legend class="rotulo">Onde vale</legend>
        <div class="flex flex-wrap gap-4">
          <label v-for="c in CANAIS" :key="c.valor" class="flex items-center gap-2 text-sm text-tinta-corpo">
            <input v-model="form.canais" type="checkbox" :value="c.valor"> {{ c.nome }}
          </label>
        </div>
      </fieldset>

      <!-- revisão pela IA -->
      <div v-if="revisao" class="rounded-md border border-line-200/60 bg-fundo-cinza p-4 text-sm" data-parte="revisao">
        <p class="font-semibold text-tinta">Sugestão da IA</p>
        <p v-if="revisao.alerta" class="faixa-aviso mt-2">{{ revisao.alerta }}</p>
        <p v-if="revisao.texto_sugerido" class="mt-2 whitespace-pre-line text-tinta-corpo">{{ revisao.texto_sugerido }}</p>
        <div v-if="revisao.conflitos.length" class="mt-3">
          <p class="font-semibold text-alerta">Conflita com o que já está valendo:</p>
          <ul class="mt-1 list-disc pl-5">
            <li v-for="(c, k) in revisao.conflitos" :key="k"><strong>{{ c.titulo }}</strong> — {{ c.porque }}</li>
          </ul>
        </div>
        <div v-if="revisao.duvidas.length" class="mt-3">
          <p class="font-semibold text-tinta">Vale deixar mais claro:</p>
          <ul class="mt-1 list-disc pl-5"><li v-for="(d, k) in revisao.duvidas" :key="k">{{ d }}</li></ul>
        </div>
        <button v-if="revisao.texto_sugerido" type="button" class="btn-secundario mt-3" data-parte="usar-sugestao" @click="usarSugestao">
          Usar a sugestão
        </button>
      </div>

      <p v-if="erroForm" class="faixa-erro" role="alert">{{ erroForm }}</p>

      <div class="flex flex-wrap gap-2">
        <button type="submit" class="btn-primario" :disabled="salvando" data-parte="salvar-base">
          {{ salvando ? 'Salvando…' : form.id ? 'Salvar alteração' : 'Salvar e valer agora' }}
        </button>
        <button type="button" class="btn-secundario" :disabled="revisando || form.texto.trim().length < 2 || form.titulo.trim().length < 2"
                data-parte="revisar" @click="revisar">
          {{ revisando ? 'Revisando…' : 'Revisar com IA' }}
        </button>
        <button type="button" class="btn-secundario" @click="cancelar">Cancelar</button>
      </div>
    </form>

    <!-- ============================================================ lista -->
    <section v-if="data" class="mt-6" aria-label="Itens da base">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="flex gap-2" role="tablist">
          <button type="button" role="tab" :aria-selected="!verArquivados" class="btn-secundario"
                  :class="!verArquivados && 'ring-1 ring-acao'" @click="verArquivados = false">
            Valendo ({{ totalAtivos }})
          </button>
          <button type="button" role="tab" :aria-selected="verArquivados" class="btn-secundario"
                  :class="verArquivados && 'ring-1 ring-acao'" @click="verArquivados = true">
            Arquivados
          </button>
        </div>
        <div v-if="!verArquivados" class="flex flex-wrap gap-2">
          <button type="button" class="btn-secundario" @click="novo('dia_fechado')">+ Dia fechado</button>
          <button type="button" class="btn-secundario" @click="novo('aviso')">+ Aviso</button>
        </div>
      </div>

      <p v-if="erroLista" class="faixa-erro mt-3" role="alert">{{ erroLista }}</p>

      <p v-if="!itens.length" class="card mt-3 text-center text-tinta-suave" data-parte="base-vazia">
        {{ verArquivados ? 'Nada arquivado.' : 'Nada escrito ainda. A Sofia segue só com o que já sabia — clique em "Nova informação" pra ensinar algo.' }}
      </p>

      <ul v-else class="mt-3 grid gap-3" data-parte="itens-base">
        <li v-for="i in itens" :key="i.id" class="card" :data-item="i.id">
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div class="min-w-0">
              <p class="flex flex-wrap items-center gap-2">
                <span :class="i.tipo === 'dia_fechado' ? 'selo-erro' : i.tipo === 'aviso' ? 'selo-alerta' : i.tipo === 'dia_aberto' ? 'selo-ok' : 'selo-neutro'">
                  {{ NOME_DO_TIPO[i.tipo] }}
                </span>
                <span v-if="i.ativo && venceu(i)" class="selo-neutro">Já passou</span>
                <span v-else-if="i.ativo && aindaNao(i)" class="selo-neutro">Começa {{ dataBR(i.vale_de) }}</span>
                <strong class="text-tinta">{{ i.titulo }}</strong>
              </p>
              <p class="mt-1.5 whitespace-pre-line text-sm text-tinta-corpo">{{ i.texto }}</p>
              <p class="mt-2 text-xs text-tinta-suave">
                <template v-if="i.dia">{{ dataBR(i.dia) }} · </template>
                <template v-if="i.vale_de || i.vale_ate">vale {{ i.vale_de ? `de ${dataBR(i.vale_de)} ` : '' }}{{ i.vale_ate ? `até ${dataBR(i.vale_ate)}` : '' }} · </template>
                {{ i.canais.map((c) => CANAIS.find((x) => x.valor === c)?.nome ?? c).join(', ') }}
                · {{ i.atualizado_por || i.criado_por || 'sem autor' }}, {{ quando(i.atualizado_em) }}
              </p>
            </div>
            <div class="flex shrink-0 flex-wrap gap-2">
              <template v-if="i.ativo">
                <button type="button" class="btn-secundario" @click="editar(i)">Editar</button>
                <template v-if="confirmando === i.id">
                  <button type="button" class="btn-erro" :disabled="mexendo === i.id" data-parte="confirma-arquivar" @click="arquivar(i)">
                    {{ mexendo === i.id ? 'Arquivando…' : 'Arquivar mesmo' }}
                  </button>
                  <button type="button" class="btn-secundario" @click="confirmando = ''">Não</button>
                </template>
                <button v-else type="button" class="btn-secundario" data-parte="arquivar" @click="confirmando = i.id">Arquivar</button>
              </template>
              <button v-else type="button" class="btn-secundario" :disabled="mexendo === i.id" @click="reativar(i)">
                {{ mexendo === i.id ? 'Reativando…' : 'Voltar a valer' }}
              </button>
            </div>
          </div>
        </li>
      </ul>
    </section>

    <!-- ============================================================ teste + como lê -->
    <div v-if="data" class="mt-6 grid gap-4 xl:grid-cols-2">
      <section class="card" aria-label="Testar com a Sofia" data-parte="testar-sofia">
        <h2 class="titulo text-lg font-semibold text-tinta">Testar com a Sofia</h2>
        <p class="apoio-bloco">A pergunta passa pelo atendimento de verdade do WhatsApp, com um número de teste — ninguém recebe nada.</p>
        <form class="mt-3 flex flex-col gap-2 sm:flex-row" @submit.prevent="testar">
          <label for="pergunta-teste" class="sr-only">Pergunta de teste</label>
          <input id="pergunta-teste" v-model="pergunta" class="campo flex-1" maxlength="600" placeholder="Ex.: Vocês abrem domingo?">
          <button type="submit" class="btn-primario" :disabled="testando || pergunta.trim().length < 2" data-parte="enviar-teste">
            {{ testando ? 'Sofia respondendo…' : 'Perguntar' }}
          </button>
        </form>
        <p v-if="testando" class="mt-3 text-sm text-tinta-suave" aria-live="polite">Leva de 10 segundos a 1 minuto (o mesmo tempo que um cliente espera).</p>
        <p v-if="erroTeste" class="faixa-erro mt-3" role="alert">{{ erroTeste }}</p>
        <div v-if="teste" class="mt-4 grid gap-2" data-parte="resposta-teste">
          <p v-if="teste.sem_resposta || !teste.bolhas?.length" class="text-sm text-tinta-suave">
            A Sofia não respondeu essa (a mensagem foi pra equipe ou ficou em silêncio de propósito).
          </p>
          <p v-for="(b, k) in teste.bolhas" :key="k"
             class="max-w-[85%] whitespace-pre-line rounded-lg rounded-tl-sm bg-fundo-cinza px-3 py-2 text-sm text-tinta-corpo">{{ b }}</p>
          <p v-if="teste.datas_citadas && teste.datas_citadas !== 'o cliente nao citou data'" class="text-xs text-tinta-suave">
            Datas que ela entendeu: {{ teste.datas_citadas }}
          </p>
        </div>
      </section>

      <section class="card" aria-label="Assim a Sofia lê agora" data-parte="robos-veem">
        <h2 class="titulo text-lg font-semibold text-tinta">Assim a Sofia lê agora</h2>
        <p class="apoio-bloco">O texto exato que entra no atendimento de cada canal (o que passou da data já saiu sozinho).</p>
        <div class="mt-3 flex flex-wrap gap-2">
          <button v-for="c in CANAIS" :key="c.valor" type="button" class="btn-secundario"
                  :class="canalVisto === c.valor && 'ring-1 ring-acao'" @click="canalVisto = c.valor">{{ c.nome }}</button>
        </div>
        <pre v-if="textoDoCanal" class="mt-3 max-h-80 overflow-auto whitespace-pre-wrap rounded-md bg-fundo-cinza p-3 text-xs text-tinta-corpo">{{ textoDoCanal }}</pre>
        <p v-else class="mt-3 text-sm text-tinta-suave">Nada da base nesse canal — a Sofia segue só com o que já sabia.</p>
      </section>
    </div>

    <section v-if="data?.historico?.length" class="card mt-6" aria-label="Histórico">
      <h2 class="titulo text-lg font-semibold text-tinta">Histórico</h2>
      <ul class="mt-2 divide-y divide-line-200/60 text-sm">
        <li v-for="h in data.historico.slice(0, 15)" :key="h.id" class="py-2 text-tinta-corpo">
          <span class="text-tinta-suave">{{ quando(h.em) }}</span> · {{ h.autor || 'alguém' }} {{ ACAO[h.acao] || h.acao }}
          <strong>{{ h.titulo }}</strong>
        </li>
      </ul>
    </section>

    <div v-else-if="pending && !data" class="mt-6 grid gap-3" aria-busy="true">
      <div v-for="k in 3" :key="k" class="card h-[92px] animate-pulse bg-fundo-cinza" />
    </div>
  </div>
</template>
