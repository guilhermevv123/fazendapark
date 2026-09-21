<script setup lang="ts">
/**
 * Mapa de assentos.
 *
 * O mapa é a única tela em que o estoque deixa de ser número e vira lugar.
 * Duas decisões de desenho vieram disso:
 *
 * 1. **Seleção por arrasto não, por clique e faixa sim.** Arrastar sobre 900
 *    poltronas num trackpad erra mais do que acerta; clicar A1 e depois A12
 *    com "selecionar até aqui" pega a fila inteira sem erro.
 *
 * 2. **O palco fica no topo.** Todo mapa de casa de espetáculo é desenhado do
 *    ponto de vista de quem olha pro palco. Inverter isso faz a fila A
 *    parecer a do fundo.
 */
definePageMeta({ layout: 'admin' })

const route = useRoute()
const id = route.params.id as string

const { data, refresh, pending, error: falha } = await useFetch<any>(
  `/api/admin/evento/${id}/assentos`)

const erro = ref('')
const aviso = ref('')
const salvando = ref(false)

const setorAberto = ref<string | null>(null)
const selecionados = ref<Set<string>>(new Set())
const ultimoClicado = ref<string | null>(null)

watch(data, (d) => {
  if (d && !setorAberto.value) {
    setorAberto.value = d.setores.find((s: any) => s.numerado)?.id ?? d.setores[0]?.id ?? null
  }
}, { immediate: true })

const setor = computed(() =>
  data.value?.setores.find((s: any) => s.id === setorAberto.value) ?? null)

watch(setorAberto, () => { selecionados.value = new Set(); ultimoClicado.value = null })

const COR: Record<string, string> = {
  livre: 'bg-fundo-cinza text-tinta-suave hover:bg-acao-claro',
  vendido: 'bg-ok text-white',
  reservado: 'bg-alerta text-white',
  bloqueado: 'bg-linha-forte text-tinta-fraca line-through',
}

function clicar(l: any, evt: MouseEvent) {
  const s = new Set(selecionados.value)
  // Shift pega a faixa: é como se seleciona uma fila inteira sem 40 cliques.
  if (evt.shiftKey && ultimoClicado.value && setor.value) {
    const todos = setor.value.fileiras.flatMap((f: any) => f.lugares)
    const a = todos.findIndex((x: any) => x.id === ultimoClicado.value)
    const b = todos.findIndex((x: any) => x.id === l.id)
    if (a >= 0 && b >= 0) {
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) s.add(todos[i].id)
      selecionados.value = s
      return
    }
  }
  if (s.has(l.id)) s.delete(l.id)
  else s.add(l.id)
  selecionados.value = s
  ultimoClicado.value = l.id
}

function selecionarFileira(f: any) {
  const s = new Set(selecionados.value)
  const todosDentro = f.lugares.every((l: any) => s.has(l.id))
  for (const l of f.lugares) { todosDentro ? s.delete(l.id) : s.add(l.id) }
  selecionados.value = s
}

const selecaoVendida = computed(() => {
  if (!setor.value) return 0
  return setor.value.fileiras.flatMap((f: any) => f.lugares)
    .filter((l: any) => selecionados.value.has(l.id) && (l.status === 'vendido' || l.ingresso))
    .length
})

async function marcar(status: 'livre' | 'bloqueado') {
  if (!selecionados.value.size) return
  erro.value = ''
  aviso.value = ''
  salvando.value = true
  try {
    const r = await $fetch<any>(`/api/admin/evento/${id}/assentos`, {
      method: 'PATCH',
      body: { ids: [...selecionados.value], status,
              nota: status === 'bloqueado' ? nota.value || null : null },
    })
    selecionados.value = new Set()
    nota.value = ''
    await refresh()
    aviso.value = `${r.alterados} lugar(es) ${status === 'livre' ? 'liberados' : 'bloqueados'}.`
    setTimeout(() => { aviso.value = '' }, 3000)
  } catch (e: any) {
    erro.value = e?.data?.statusMessage || 'Não foi possível alterar.'
  } finally {
    salvando.value = false
  }
}

const nota = ref('')

// ---- gerador -------------------------------------------------------------
const gerar = reactive({
  aberto: false, setorId: '', fileiras: 10, porFileira: 20,
  primeiroNumero: 1, primeiraFileira: 'A', pular: '', substituir: false,
})
const totalGerado = computed(() => {
  const pular = gerar.pular.split(',').map((x) => Number(x.trim())).filter((n) => n >= 1)
  const porFila = Math.max(gerar.porFileira - new Set(pular).size, 0)
  return gerar.fileiras * porFila
})

function abrirGerador(s: any) {
  Object.assign(gerar, { aberto: true, setorId: s.id, substituir: s.total > 0 })
}

async function criarMapa() {
  erro.value = ''
  salvando.value = true
  try {
    const r = await $fetch<any>(`/api/admin/evento/${id}/assentos`, {
      method: 'POST',
      body: {
        setorId: gerar.setorId, fileiras: gerar.fileiras, porFileira: gerar.porFileira,
        primeiroNumero: gerar.primeiroNumero, primeiraFileira: gerar.primeiraFileira,
        pular: gerar.pular.split(',').map((x) => Number(x.trim())).filter((n) => n >= 1),
        substituir: gerar.substituir,
      },
    })
    gerar.aberto = false
    setorAberto.value = gerar.setorId
    await refresh()
    aviso.value = `${r.criados} lugares criados em ${r.fileiras} fileiras.`
    setTimeout(() => { aviso.value = '' }, 4000)
  } catch (e: any) {
    erro.value = e?.data?.statusMessage || 'Não foi possível gerar o mapa.'
  } finally {
    salvando.value = false
  }
}

useHead({ title: 'Mapa de assentos' })
</script>

<template>
  <div v-if="data">
    <div class="flex flex-wrap items-start justify-between gap-3 py-5">
      <div>
        <h1 class="titulo text-2xl font-semibold text-tinta">Mapa de assentos</h1>
        <p class="mt-1 text-tinta-suave">
          Setor numerado vende lugar, não quantidade. Clique pra selecionar;
          Shift pega a faixa inteira.
        </p>
      </div>
    </div>

    <p v-if="erro" class="rounded-card border border-erro bg-erro-claro px-3 py-2 text-sm text-erro">
      {{ erro }}
    </p>
    <p v-if="aviso" class="rounded-card border border-ok bg-ok-claro px-3 py-2 text-sm text-ok">
      {{ aviso }}
    </p>

    <div class="mt-4 grid gap-4 lg:grid-cols-[260px_1fr]">
      <aside class="grid content-start gap-2">
        <button v-for="s in data.setores" :key="s.id" type="button"
                class="rounded-card border px-3 py-2.5 text-left transition-colors"
                :class="s.id === setorAberto
                  ? 'border-acao bg-acao-fraco' : 'border-linha bg-fundo-card hover:border-linha-forte'"
                @click="setorAberto = s.id">
          <p class="font-medium text-tinta">{{ s.nome }}</p>
          <p class="text-xs text-tinta-fraca">
            <template v-if="s.numerado && s.total">
              {{ s.total }} lugares · {{ s.livres }} livres
            </template>
            <template v-else>não numerado · estoque {{ s.estoque }}</template>
          </p>
        </button>
      </aside>

      <div>
        <div v-if="!setor" class="card py-12 text-center text-tinta-suave">
          Nenhum setor neste evento.
        </div>

        <div v-else-if="!setor.total" class="card py-12 text-center">
          <p class="titulo text-lg font-semibold text-tinta">{{ setor.nome }} não tem mapa</p>
          <p class="mx-auto mt-2 max-w-md text-sm text-tinta-suave">
            Hoje este setor vende por quantidade: {{ setor.estoque }} no estoque,
            {{ setor.vendidos }} vendidos. Gerar um mapa transforma cada vaga num lugar
            com nome — e é o que permite dizer a alguém onde sentar.
          </p>
          <button type="button" class="btn-primario mt-4" @click="abrirGerador(setor)">
            Gerar mapa deste setor
          </button>
        </div>

        <div v-else>
          <div class="card flex flex-wrap items-center justify-between gap-3">
            <div class="flex flex-wrap items-center gap-4 text-xs">
              <span class="flex items-center gap-1.5">
                <i class="h-3 w-3 rounded-sm bg-fundo-cinza ring-1 ring-linha-forte" /> livre
                <strong class="tabular-nums">{{ setor.livres }}</strong>
              </span>
              <span class="flex items-center gap-1.5">
                <i class="h-3 w-3 rounded-sm bg-ok" /> vendido
                <strong class="tabular-nums">{{ setor.vendidosNoMapa }}</strong>
              </span>
              <span class="flex items-center gap-1.5">
                <i class="h-3 w-3 rounded-sm bg-alerta" /> reservado
                <strong class="tabular-nums">{{ setor.reservados }}</strong>
              </span>
              <span class="flex items-center gap-1.5">
                <i class="h-3 w-3 rounded-sm bg-linha-forte" /> bloqueado
                <strong class="tabular-nums">{{ setor.bloqueados }}</strong>
              </span>
            </div>
            <button type="button" class="btn-secundario py-1.5 text-sm"
                    @click="abrirGerador(setor)">Refazer mapa</button>
          </div>

          <div v-if="selecionados.size"
               class="card mt-3 flex flex-wrap items-end gap-3 border-acao">
            <p class="text-sm text-tinta">
              <strong class="tabular-nums">{{ selecionados.size }}</strong> selecionado(s)
              <span v-if="selecaoVendida" class="text-erro">
                — {{ selecaoVendida }} está vendido e não muda por aqui
              </span>
            </p>
            <div class="min-w-[180px] flex-1">
              <label class="rotulo">Motivo (opcional)</label>
              <input v-model="nota" class="campo py-1 text-sm"
                     placeholder="poltrona quebrada, reserva da produção…">
            </div>
            <button type="button" class="btn-secundario py-1.5 text-sm"
                    :disabled="salvando" @click="marcar('bloqueado')">Bloquear</button>
            <button type="button" class="btn-secundario py-1.5 text-sm"
                    :disabled="salvando" @click="marcar('livre')">Liberar</button>
            <button type="button" class="px-2 text-sm text-tinta-fraca hover:text-tinta"
                    @click="selecionados = new Set()">Limpar</button>
          </div>

          <div class="card mt-3 overflow-x-auto">
            <p class="titulo mx-auto mb-5 w-2/3 rounded-card bg-tinta py-1.5 text-center text-xs font-semibold uppercase tracking-widest text-white">
              Palco
            </p>
            <div class="inline-grid gap-1.5">
              <div v-for="f in setor.fileiras" :key="f.nome" class="flex items-center gap-1.5">
                <button type="button"
                        class="w-7 shrink-0 text-right text-xs font-semibold text-tinta-fraca hover:text-acao"
                        :title="`Selecionar a fileira ${f.nome} inteira`"
                        @click="selecionarFileira(f)">{{ f.nome }}</button>
                <button v-for="l in f.lugares" :key="l.id" type="button"
                        class="h-7 w-7 rounded-sm text-[10px] font-medium tabular-nums transition-colors"
                        :class="[COR[l.status] ?? COR.livre,
                                 selecionados.has(l.id) ? 'ring-2 ring-acao ring-offset-1' : '']"
                        :title="l.rotulo
                          + (l.titular ? ` — ${l.titular}` : '')
                          + (l.ingresso ? ` (${l.ingresso})` : '')
                          + (l.nota ? ` — ${l.nota}` : '')"
                        @click="clicar(l, $event)">
                  {{ l.numero }}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <ModalLateral v-if="gerar.aberto" titulo="Gerar mapa do setor" @fechar="gerar.aberto = false">
      <div class="grid gap-3">
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="rotulo">Fileiras</label>
            <input v-model.number="gerar.fileiras" type="number" min="1" max="200" class="campo">
          </div>
          <div>
            <label class="rotulo">Lugares por fileira</label>
            <input v-model.number="gerar.porFileira" type="number" min="1" max="200" class="campo">
          </div>
          <div>
            <label class="rotulo">Primeira fileira</label>
            <input v-model="gerar.primeiraFileira" maxlength="4" class="campo">
            <p class="mt-1 text-xs text-tinta-fraca">letra (A) ou número (1)</p>
          </div>
          <div>
            <label class="rotulo">Primeiro número</label>
            <input v-model.number="gerar.primeiroNumero" type="number" min="0" class="campo">
          </div>
        </div>
        <div>
          <label class="rotulo">Números que não existem (corredor)</label>
          <input v-model="gerar.pular" class="campo" placeholder="ex.: 10, 11">
          <p class="mt-1 text-xs text-tinta-fraca">
            Separados por vírgula. Esses lugares simplesmente não são criados.
          </p>
        </div>
        <label class="flex items-center gap-2 text-sm text-tinta-suave">
          <input v-model="gerar.substituir" type="checkbox" class="h-4 w-4 accent-acao">
          Substituir o mapa atual
        </label>
        <p class="rounded-card bg-fundo-cinza px-3 py-2 text-sm text-tinta-suave">
          Vai criar <strong class="tabular-nums text-tinta">{{ totalGerado }}</strong> lugares.
          Setor com lugar já vendido não é refeito — a ligação entre a pessoa e a
          poltrona dela se perderia.
        </p>
      </div>
      <template #acoes>
        <button type="button" class="btn-secundario" @click="gerar.aberto = false">Cancelar</button>
        <button type="button" class="btn-primario" :disabled="salvando || !totalGerado"
                @click="criarMapa">
          {{ salvando ? 'Gerando…' : 'Gerar' }}
        </button>
      </template>
    </ModalLateral>
  </div>

  <p v-else-if="pending" class="card mt-6 text-tinta-suave">Carregando…</p>

  <div v-else class="card mt-6">
    <p class="rotulo-kpi text-erro">Não foi possível carregar o mapa</p>
    <p class="mt-1 text-sm text-tinta-suave">
      {{ (falha as any)?.data?.statusMessage || (falha as any)?.message || 'Erro desconhecido.' }}
    </p>
    <button type="button" class="btn-secundario mt-3" @click="refresh()">Tentar de novo</button>
  </div>
</template>
