<script setup lang="ts">
/**
 * Sessões — os dias e horários que o parque vende.
 *
 * O parque não vende "um evento": vende sábado, domingo e o feriado. Esta tela
 * é o calendário desse catálogo, e ela existe pra resolver três coisas que
 * nenhuma outra resolve:
 *
 *   criar em lote   ninguém cadastra 52 sábados na mão — cadastra 51
 *   teto por dia    quantas PESSOAS cabem na piscina naquele dia
 *   lote × dia      o mesmo ingresso valendo em vários dias, sem clonar setor
 *
 * A ocupação mostrada aqui é a mesma conta que o banco usa pra recusar a venda
 * quando o dia lota (`sessao_ocupacao`, do 016) — não uma segunda conta feita
 * no navegador, que envelheceria sozinha.
 *
 * Datas são formatadas NO FUSO DO EVENTO, não no fuso de quem está olhando:
 * quem administra o parque da Bahia pode estar em Lisboa, e "09:00" tem que
 * continuar sendo a hora em que o portão abre lá.
 */
definePageMeta({ layout: 'admin' })

const route = useRoute()
const router = useRouter()
const id = route.params.id as string

const { data, refresh, status, error: falha } = await useFetch<any>(
  `/api/admin/evento/${id}/sessoes`)

const erro = ref('')
const aviso = ref('')
const salvando = ref(false)

const fuso = computed(() => data.value?.evento?.fuso || 'America/Bahia')
const fmt = (iso: string, opcoes: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat('pt-BR', { timeZone: fuso.value, ...opcoes }).format(new Date(iso))
const diaLongo = (iso: string) =>
  fmt(iso, { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' })
const hora = (iso: string) => fmt(iso, { hour: '2-digit', minute: '2-digit' })

// O filtro mora na URL: o operador precisa mandar o link do que está vendo.
const verPassadas = computed(() => route.query.passadas === '1')
function alternarPassadas() {
  const q: any = { ...route.query }
  if (verPassadas.value) delete q.passadas
  else q.passadas = '1'
  router.replace({ query: q })
}

const agora = Date.now()
const sessoes = computed<any[]>(() => data.value?.sessoes ?? [])
const visiveis = computed(() => verPassadas.value
  ? sessoes.value
  : sessoes.value.filter((s) => new Date(s.fim ?? s.inicio).getTime() >= agora))
const passadas = computed(() => sessoes.value.length - visiveis.value.length)

const lotes = computed<any[]>(() => data.value?.lotes ?? [])
const semDia = computed(() => lotes.value.filter((l) => l.dias === 0))
// Quem a rota marcou como "ainda vai ter que escolher o dia". Filtrar por
// `dias > 1` aqui era MENTIRA para o passaporte: ele vale em vários dias sem
// escolher nenhum e ocupa vaga em TODOS (medido: um passe de 4 pessoas ligado
// a dois dias subiu a ocupação dos dois numa venda só). A régua é da rota, que
// é quem sabe o tipo do setor.
const comEscolha = computed(() => lotes.value.filter((l) => l.escolheDia))
const passaportes = computed(() => lotes.value.filter((l) => l.cobreTodosOsDias))

const totalPessoas = computed(() =>
  visiveis.value.reduce((n, s) => n + s.ocupadas, 0))

async function chamar(corpo: any) {
  erro.value = ''
  aviso.value = ''
  salvando.value = true
  try {
    const r: any = await $fetch(`/api/admin/evento/${id}/sessoes`, { method: 'POST', body: corpo })
    await refresh()
    return r
  } catch (e: any) {
    erro.value = e?.data?.statusMessage || e?.statusMessage || 'Não foi possível salvar.'
    return null
  } finally {
    salvando.value = false
  }
}

// ------------------------------------------------------------ criar em lote
const DIAS = [
  { n: 1, r: 'Seg' }, { n: 2, r: 'Ter' }, { n: 3, r: 'Qua' }, { n: 4, r: 'Qui' },
  { n: 5, r: 'Sex' }, { n: 6, r: 'Sáb' }, { n: 7, r: 'Dom' },
]
const novo = reactive({
  de: '', ate: '', dias: [6, 7] as number[],
  horarios: [{ inicio: '09:00', fim: '17:00' }],
  capacidade: null as number | null,
  titulo: '',
  loteIds: [] as string[],
})
function alternarDia(n: number) {
  const i = novo.dias.indexOf(n)
  if (i >= 0) novo.dias.splice(i, 1)
  else novo.dias.push(n)
}
function alternarLote(loteId: string) {
  const i = novo.loteIds.indexOf(loteId)
  if (i >= 0) novo.loteIds.splice(i, 1)
  else novo.loteIds.push(loteId)
}
async function criar() {
  if (!novo.de || !novo.ate) {
    erro.value = 'Escolha a data inicial e a final.'
    return
  }
  const r = await chamar({
    o: 'criar', de: novo.de, ate: novo.ate, dias: novo.dias,
    horarios: novo.horarios,
    capacidade: novo.capacidade || null,
    titulo: novo.titulo.trim() || null,
    loteIds: novo.loteIds,
  })
  if (r) {
    aviso.value = `${r.criadas} dia(s) criado(s)`
      + (r.repetidas ? `, ${r.repetidas} que já existia(m) foram mantidos` : '')
      + (r.vinculos ? `, ${r.vinculos} ingresso(s) ligado(s) a esses dias` : '') + '.'
  }
}

// ------------------------------------------------------------------ editar
const edicao = reactive({ aberto: false, id: '', titulo: '', capacidade: null as number | null })
function abrirEdicao(s: any) {
  Object.assign(edicao, {
    aberto: true, id: s.id, titulo: s.titulo ?? '', capacidade: s.capacidade,
  })
}
async function salvarEdicao() {
  const r = await chamar({
    o: 'editar', sessaoId: edicao.id,
    titulo: edicao.titulo.trim() || null,
    capacidade: edicao.capacidade || null,
  })
  if (r) edicao.aberto = false
}

// ------------------------------------------------------- lotes daquele dia
const escolha = reactive({ aberto: false, id: '', titulo: '', loteIds: [] as string[] })
function abrirLotes(s: any) {
  Object.assign(escolha, {
    aberto: true, id: s.id, titulo: s.titulo ?? diaLongo(s.inicio),
    loteIds: lotes.value.filter((l) => l.sessoes.includes(s.id)).map((l) => l.id),
  })
}
function alternarEscolha(loteId: string) {
  const i = escolha.loteIds.indexOf(loteId)
  if (i >= 0) escolha.loteIds.splice(i, 1)
  else escolha.loteIds.push(loteId)
}
async function salvarLotes() {
  const r = await chamar({ o: 'lotes', sessaoId: escolha.id, loteIds: escolha.loteIds })
  if (r) escolha.aberto = false
}

async function apagar(s: any) {
  if (!confirm(`Apagar ${s.titulo ?? diaLongo(s.inicio)} do calendário?`)) return
  await chamar({ o: 'apagar', sessaoId: s.id })
}

/** quanto da lotação já foi, em %, pra barra */
function porcento(s: any) {
  if (!s.capacidade) return 0
  return Math.min(Math.round((s.ocupadas / s.capacidade) * 100), 100)
}

useHead({ title: 'Sessões e datas' })
</script>

<template>
  <div v-if="data">
    <div class="flex flex-wrap items-start justify-between gap-3 py-5">
      <div>
        <h1 class="titulo text-2xl font-bold text-tinta">Sessões e datas</h1>
        <p class="mt-1 text-tinta-suave">
          Os dias e horários que este evento vende, com o teto de gente de cada um.
        </p>
      </div>
      <button type="button" class="chip" @click="alternarPassadas()">
        {{ verPassadas ? 'Esconder dias passados' : `Mostrar dias passados (${passadas})` }}
      </button>
    </div>

    <AbasSecao :evento-id="id" />

    <p v-if="erro" class="faixa-erro mt-4">{{ erro }}</p>
    <p v-if="aviso" class="faixa-aviso mt-4">{{ aviso }}</p>

    <!-- O que esta tela ainda NÃO resolve, dito na cara: lote que vale em
         vários dias vende sem carimbar dia nenhum enquanto o checkout não
         perguntar. Esconder isso vira ingresso sem data na portaria. -->
    <div v-if="comEscolha.length"
         class="mt-4 rounded-card border border-alerta bg-alerta-claro px-4 py-3 text-sm text-tinta-corpo">
      <strong class="text-tinta">{{ comEscolha.length }} ingresso(s) valem em mais de um dia.</strong>
      Enquanto a tela de compra não perguntar qual dia, eles saem sem data — e não descontam
      vaga de nenhuma sessão.
      <span class="text-tinta-suave">({{ comEscolha.map((l: any) => l.nome).join(', ') }})</span>
    </div>
    <!-- O passaporte é o contrário do aviso de cima, e precisa ser dito: ele
         não escolhe dia, ocupa vaga em TODOS os dias em que vale. Quem planeja
         a lotação da piscina precisa saber que um passe de 4 pessoas tirou 4
         lugares de cada dia, não de um. -->
    <div v-if="passaportes.length"
         class="mt-3 rounded-card border border-linha bg-fundo-cinza px-4 py-3 text-sm text-tinta-corpo">
      <strong class="text-tinta">{{ passaportes.length }} passaporte(s) valem em vários dias.</strong>
      Eles não escolhem data: cada passe vendido ocupa vaga em <em>todos</em> os dias em que vale,
      e o dia lota contando essa gente.
      <span class="text-tinta-suave">({{ passaportes.map((l: any) => l.nome).join(', ') }})</span>
    </div>
    <div v-if="semDia.length"
         class="mt-3 rounded-card border border-linha bg-fundo-cinza px-4 py-3 text-sm text-tinta-corpo">
      <strong class="text-tinta">{{ semDia.length }} ingresso(s) não estão em dia nenhum.</strong>
      Eles continuam vendendo, mas fora do calendário — ninguém sabe em que dia essa gente entra.
    </div>

    <!-- ------------------------------------------------------ criar em lote -->
    <section class="card mt-5">
      <h2 class="titulo-bloco">Criar várias datas de uma vez</h2>
      <p class="apoio-bloco">
        O parque abre todo fim de semana: escolha o período, os dias da semana e o horário.
        Rodar de novo o mesmo período não duplica nada.
      </p>

      <div class="mt-4 grid gap-4 sm:grid-cols-4">
        <div>
          <label class="rotulo" for="de">Do dia</label>
          <input id="de" v-model="novo.de" type="date" class="campo">
        </div>
        <div>
          <label class="rotulo" for="ate">Até o dia</label>
          <input id="ate" v-model="novo.ate" type="date" class="campo">
        </div>
        <div>
          <label class="rotulo" for="cap">Cabem por sessão</label>
          <input id="cap" v-model.number="novo.capacidade" type="number" min="1"
                 class="campo tabular-nums" placeholder="sem teto">
          <p class="mt-1 text-xs text-tinta-fraca">Pessoas, não ingressos: mesa de 10 ocupa 10.</p>
        </div>
        <div>
          <label class="rotulo" for="tit">Nome do dia (opcional)</label>
          <input id="tit" v-model="novo.titulo" type="text" class="campo"
                 placeholder="Sábado 07/11">
        </div>
      </div>

      <div class="mt-4">
        <span class="rotulo">Dias da semana</span>
        <div class="flex flex-wrap gap-2">
          <button v-for="d in DIAS" :key="d.n" type="button"
                  :class="novo.dias.includes(d.n) ? 'chip-ativo' : 'chip'"
                  @click="alternarDia(d.n)">{{ d.r }}</button>
        </div>
      </div>

      <div class="mt-4">
        <span class="rotulo">Horários</span>
        <div v-for="(h, i) in novo.horarios" :key="i" class="mb-2 flex flex-wrap items-center gap-2">
          <input v-model="h.inicio" type="time" class="campo w-32">
          <span class="text-tinta-suave">até</span>
          <input v-model="h.fim" type="time" class="campo w-32">
          <button v-if="novo.horarios.length > 1" type="button"
                  class="p-1 text-tinta-fraca hover:text-erro"
                  aria-label="Remover horário" @click="novo.horarios.splice(i, 1)">
            <IconeMenu nome="lixo" :tamanho="16" />
          </button>
        </div>
        <button v-if="novo.horarios.length < 6" type="button" class="btn-secundario"
                @click="novo.horarios.push({ inicio: '09:00', fim: '17:00' })">
          <IconeMenu nome="mais" :tamanho="16" /> Outro horário no mesmo dia
        </button>
      </div>

      <div v-if="lotes.length" class="mt-4">
        <span class="rotulo">Já deixar estes ingressos à venda nesses dias</span>
        <div class="flex flex-wrap gap-2">
          <button v-for="l in lotes" :key="l.id" type="button"
                  :class="novo.loteIds.includes(l.id) ? 'chip-ativo' : 'chip'"
                  @click="alternarLote(l.id)">
            {{ l.setor }} · {{ l.nome }}
          </button>
        </div>
      </div>

      <div class="mt-5 flex justify-end">
        <button type="button" class="btn-primario" :disabled="salvando" @click="criar()">
          <IconeMenu nome="calendario" :tamanho="18" /> Criar datas
        </button>
      </div>
    </section>

    <!-- --------------------------------------------------------- calendário -->
    <p v-if="!visiveis.length" class="card mt-4 py-12 text-center text-tinta-suave">
      Nenhum dia no calendário ainda. Crie o primeiro no bloco acima.
    </p>

    <section v-for="s in visiveis" :key="s.id" class="card mt-4 p-0">
      <header class="flex flex-wrap items-center gap-3 border-b border-linha px-4 py-3">
        <div>
          <h2 class="titulo text-base font-bold uppercase tracking-wide text-acao">
            {{ s.titulo ?? diaLongo(s.inicio) }}
          </h2>
          <p class="text-sm text-tinta-suave">
            {{ diaLongo(s.inicio) }} · {{ hora(s.inicio) }} às {{ hora(s.fim) }}
          </p>
        </div>
        <span v-if="s.lotado" class="selo-erro">Lotado</span>
        <span v-else-if="s.capacidade === null" class="selo-neutro">Sem teto</span>
        <span v-else class="selo-ok">{{ s.vagas }} vaga(s)</span>

        <div class="ml-auto flex items-center gap-1">
          <button type="button" class="p-1 text-tinta-fraca hover:text-acao"
                  :aria-label="`Ingressos de ${s.titulo ?? diaLongo(s.inicio)}`"
                  @click="abrirLotes(s)">
            <IconeMenu nome="bilhetes" :tamanho="18" />
          </button>
          <button type="button" class="p-1 text-tinta-fraca hover:text-acao"
                  :aria-label="`Editar ${s.titulo ?? diaLongo(s.inicio)}`" @click="abrirEdicao(s)">
            <IconeMenu nome="lapis" :tamanho="16" />
          </button>
          <button type="button" class="p-1 text-tinta-fraca hover:text-erro"
                  :disabled="!s.podeApagar"
                  :title="s.podeApagar ? 'Apagar este dia' : 'Este dia já tem gente ou setor amarrado'"
                  :aria-label="`Apagar ${s.titulo ?? diaLongo(s.inicio)}`" @click="apagar(s)">
            <IconeMenu nome="lixo" :tamanho="16" />
          </button>
        </div>
      </header>

      <div class="grid gap-4 p-4 sm:grid-cols-4">
        <div>
          <p class="rotulo-kpi">Pessoas confirmadas</p>
          <p class="numero-kpi mt-1">{{ s.ocupadas }}</p>
        </div>
        <div>
          <p class="rotulo-kpi">Cabem</p>
          <p class="numero-kpi mt-1">{{ s.capacidade ?? '—' }}</p>
        </div>
        <div>
          <p class="rotulo-kpi">Ingressos emitidos</p>
          <p class="numero-kpi mt-1">{{ s.ingressosEmitidos }}</p>
        </div>
        <div>
          <p class="rotulo-kpi">Estoque apontado pra cá</p>
          <p class="numero-kpi mt-1" :class="s.excedeCapacidade ? 'text-alerta' : ''">
            {{ s.estoquePrometido }}
          </p>
        </div>
      </div>

      <div v-if="s.capacidade" class="px-4 pb-3">
        <div class="h-2 w-full rounded bg-fundo-cinza">
          <div class="h-2 rounded" :class="s.lotado ? 'bg-erro' : 'bg-acao'"
               :style="{ width: porcento(s) + '%' }" />
        </div>
      </div>

      <p v-if="s.excedeCapacidade"
         class="mx-4 mb-3 rounded-card border border-alerta bg-alerta-claro px-3 py-2 text-sm text-tinta-corpo">
        Os ingressos apontados para este dia somam {{ s.estoquePrometido }} lugares e cabem
        {{ s.capacidade }}. A venda para aqui em {{ s.capacidade }} — quem chegar depois vai
        ver "lotado" com ingresso ainda no estoque.
      </p>

      <div class="flex flex-wrap items-center gap-2 border-t border-linha px-4 py-3">
        <span class="rotulo mb-0">Vendendo neste dia</span>
        <span v-for="l in s.lotes" :key="l.id"
              class="selo-neutro" :title="l.vinculo === 'setor'
                ? 'herdado do setor (modelo antigo)' : 'escolhido nesta tela'">
          {{ l.setor }} · {{ l.nome }}
          <template v-if="l.vinculo === 'setor'"> (setor)</template>
        </span>
        <span v-if="!s.lotes.length" class="text-sm text-erro">
          Nenhum ingresso à venda neste dia — ninguém consegue comprar.
        </span>
      </div>
    </section>

    <div v-if="visiveis.length"
         class="sticky bottom-0 mt-4 flex flex-wrap items-center gap-x-8 rounded-card bg-acao px-5 py-3 text-white">
      <p class="titulo text-base font-bold">
        Pessoas confirmadas no período: <span class="tabular-nums">{{ totalPessoas }}</span>
      </p>
      <p class="text-sm opacity-90">{{ visiveis.length }} dia(s) no calendário</p>
    </div>

    <!-- ------------------------------------------------------------ modais -->
    <ModalLateral v-if="edicao.aberto" titulo="Editar dia" @fechar="edicao.aberto = false">
      <div class="grid gap-3">
        <div>
          <label class="rotulo" for="e-tit">Nome do dia</label>
          <input id="e-tit" v-model="edicao.titulo" type="text" class="campo">
        </div>
        <div>
          <label class="rotulo" for="e-cap">Quantas pessoas cabem</label>
          <input id="e-cap" v-model.number="edicao.capacidade" type="number" min="1"
                 class="campo tabular-nums" placeholder="sem teto">
          <p class="mt-1 text-xs text-tinta-fraca">
            Em branco tira o teto. O teto não pode ficar abaixo do que já foi vendido.
          </p>
        </div>
      </div>
      <template #acoes>
        <button type="button" class="btn-secundario" @click="edicao.aberto = false">Cancelar</button>
        <button type="button" class="btn-primario" :disabled="salvando" @click="salvarEdicao()">
          Salvar
        </button>
      </template>
    </ModalLateral>

    <ModalLateral v-if="escolha.aberto" :titulo="`Ingressos de ${escolha.titulo}`"
                  @fechar="escolha.aberto = false">
      <p class="text-sm text-tinta-suave">
        Marque os ingressos que valem neste dia. Um mesmo ingresso pode valer em vários dias —
        é assim que o sábado e o domingo param de ser dois setores clonados.
      </p>
      <div class="mt-3 grid gap-2">
        <button v-for="l in lotes" :key="l.id" type="button"
                class="flex items-center justify-between rounded-card border px-3 py-2 text-left"
                :class="escolha.loteIds.includes(l.id)
                  ? 'border-acao-forte bg-acao-claro' : 'border-linha bg-white'"
                @click="alternarEscolha(l.id)">
          <span>
            <span class="font-bold text-tinta">{{ l.nome }}</span>
            <span class="text-tinta-suave"> · {{ l.setor }}</span>
            <!-- Sem isto o lote que já vende o dia pelo setor apareceria
                 desmarcado, e o operador marcaria de novo achando que estava
                 desligado. Desmarcado aqui não quer dizer "não vende". -->
            <span v-if="l.sessaoDoSetor === escolha.id" class="block text-xs text-tinta-fraca">
              já vende neste dia pelo setor
            </span>
          </span>
          <IconeMenu v-if="escolha.loteIds.includes(l.id)" nome="check" :tamanho="16" />
        </button>
      </div>
      <template #acoes>
        <button type="button" class="btn-secundario" @click="escolha.aberto = false">Cancelar</button>
        <button type="button" class="btn-primario" :disabled="salvando" @click="salvarLotes()">
          Salvar
        </button>
      </template>
    </ModalLateral>
  </div>

  <p v-else-if="status === 'pending'" class="card mt-6 text-tinta-suave">Carregando…</p>

  <div v-else class="card mt-6">
    <p class="rotulo-kpi text-erro">Não foi possível carregar</p>
    <p class="mt-1 text-sm text-tinta-suave">
      {{ (falha as any)?.data?.statusMessage || (falha as any)?.message || 'Erro desconhecido.' }}
    </p>
    <button type="button" class="btn-secundario mt-3" @click="refresh()">Tentar de novo</button>
  </div>
</template>
