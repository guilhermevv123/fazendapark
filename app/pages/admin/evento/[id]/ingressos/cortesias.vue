<script setup lang="ts">
/**
 * Cortesias.
 *
 * A caixa que importa é a terceira: **quanto isso deixou de faturar**. Cortesia
 * é a única categoria que ocupa lugar e não aparece na receita — o produtor
 * costuma descobrir o tamanho dela olhando a fila da portaria, não o painel.
 * Aqui o número fica ao lado do botão que emite.
 *
 * Desde a 017 a tela mostra também o TETO, e o teto fica na primeira caixa: um
 * número de cortesia emitida sem nada ao lado não responde a pergunta que o
 * produtor faz ("isso é muito?"). Com "12 de 30" ele sabe na hora.
 *
 * Motivo e quem pediu deixaram de ser opcionais. O botão de emitir fica
 * desabilitado sem os dois, e a tela diz por quê antes de a pessoa preencher
 * 40 nomes e levar um 400 na cara.
 *
 * A busca fica na URL (`?q=`) porque o operador precisa mandar o link do que
 * está vendo — "as cortesias que o João pediu" tem que ser um endereço.
 */
definePageMeta({ layout: 'admin' })

const route = useRoute()
const router = useRouter()
const id = route.params.id as string

const { data, refresh, pending, error: falha } = await useFetch<any>(
  `/api/admin/evento/${id}/cortesias`)

/**
 * Emitir é trabalho de quem atende; mexer no TETO, não.
 *
 * A rota recusa `acao: 'cota'` de quem não é master (é lá que fica a trava —
 * esconder botão não protege nada). Isto aqui é pra que a pessoa de Operação
 * não descubra o limite dela levando um 403 na cara, com o drawer preenchido.
 */
const { data: eu } = await useFetch<any>('/api/auth/eu')
const souMaster = computed(() => eu.value?.usuario?.papel === 'master')

const reais = (c: number) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
const erro = ref('')
const salvando = ref(false)

/**
 * A frase que o servidor escreveu, e não a genérica.
 *
 * `e.statusMessage` NÃO serve: o h3 higieniza a linha de status HTTP e come os
 * acentos ("Faa login para continuar"). O texto inteiro só existe no corpo
 * JSON — `e.data.statusMessage`. `e.data.message` é a rede pra quando o erro
 * vier de outro lugar da pilha.
 */
const recado = (e: any, padrao: string) =>
  e?.data?.statusMessage || e?.data?.message || padrao

/* --------------------------------------------------------------- busca */

const busca = ref(String(route.query.q ?? ''))
watch(busca, (v) => {
  router.replace({ query: { ...route.query, q: v || undefined } })
})
const listaFiltrada = computed(() => {
  const termo = busca.value.trim().toLowerCase()
  const todos = data.value?.ingressos ?? []
  if (!termo) return todos
  return todos.filter((t: any) =>
    [t.codigo, t.nome, t.email, t.documento, t.motivo, t.pedidaPor, t.autorizadaPor, t.lote, t.setor]
      .some((c: string | null) => (c ?? '').toLowerCase().includes(termo)))
})

/* -------------------------------------------------------------- emitir */

const form = reactive({
  aberto: false, loteId: '', motivo: '', responsavel: '',
  /** Uma linha por pessoa. Cortesia sem nome não serve pra nada na portaria. */
  pessoas: [{ nome: '', email: '', documento: '' }],
})
function abrir() {
  Object.assign(form, {
    aberto: true,
    loteId: data.value?.lotes.find((l: any) => podeReceber(l))?.id ?? '',
    motivo: '', responsavel: '',
    pessoas: [{ nome: '', email: '', documento: '' }],
  })
}
/** lote que ainda tem estoque E ainda tem cota */
const podeReceber = (l: any) => l.disponivel > 0 && (l.cotaRestam === null || l.cotaRestam > 0)

const loteEscolhido = computed(() =>
  data.value?.lotes.find((l: any) => l.id === form.loteId))
const quantosNomes = computed(() => form.pessoas.filter((p) => p.nome.trim()).length)

/** o menor teto que vale pra esta emissão, e de onde ele vem */
const tetoDaVez = computed(() => {
  const l = loteEscolhido.value
  const cand: { quanto: number; onde: string }[] = []
  if (data.value?.cota.eventoRestam !== null && data.value?.cota.eventoRestam !== undefined) {
    cand.push({ quanto: data.value.cota.eventoRestam, onde: 'na cota do evento' })
  }
  if (l && l.cotaRestam !== null) cand.push({ quanto: l.cotaRestam, onde: `na cota de ${l.nome}` })
  if (l) cand.push({ quanto: l.disponivel, onde: `de estoque em ${l.nome}` })
  return cand.sort((a, b) => a.quanto - b.quanto)[0] ?? null
})

const faltaPreencher = computed(() => {
  if (!form.loteId) return 'Escolha o lote.'
  if (form.motivo.trim().length < 3) return 'Escreva o motivo da cortesia.'
  if (form.responsavel.trim().length < 2) return 'Diga quem pediu a cortesia.'
  if (!quantosNomes.value) return 'Preencha ao menos um nome.'
  if (tetoDaVez.value && quantosNomes.value > tetoDaVez.value.quanto) {
    return `Só cabem ${tetoDaVez.value.quanto} ${tetoDaVez.value.onde}, e você listou ${quantosNomes.value}.`
  }
  return ''
})

const emitido = ref<{ pedido: string; quantidade: number } | null>(null)

async function emitir() {
  if (faltaPreencher.value) { erro.value = faltaPreencher.value; return }
  const pessoas = form.pessoas
    .filter((p) => p.nome.trim())
    .map((p) => ({ nome: p.nome.trim(), email: p.email || null, documento: p.documento || null }))

  erro.value = ''
  salvando.value = true
  let r: any
  try {
    r = await $fetch(`/api/admin/evento/${id}/cortesias`, {
      method: 'POST',
      body: {
        loteId: form.loteId,
        motivo: form.motivo.trim(),
        responsavel: form.responsavel.trim(),
        pessoas,
      },
    })
  } catch (e: any) {
    erro.value = recado(e, 'Não foi possível emitir.')
    return
  } finally {
    salvando.value = false
  }

  // Daqui pra baixo a cortesia JÁ EXISTE. Recarregar a lista é o passo
  // seguinte, não parte do ato: enquanto o `refresh()` ficou dentro do mesmo
  // `try`, uma falha dele (sessão vencida, rede caindo) virava "Não foi
  // possível emitir" com os ingressos emitidos — e o operador emitia tudo de
  // novo. Silêncio nenhum: se a lista não recarregar, a tela diz isso.
  form.aberto = false
  emitido.value = { pedido: r.pedido, quantidade: r.quantidade }
  try {
    await refresh()
  } catch (e: any) {
    erro.value = `As cortesias foram emitidas (pedido ${r.pedido}), mas a lista não recarregou: ${recado(e, 'tente atualizar a página')}.`
  }
}

/* ----------------------------------------------------------------- cota */

const cota = reactive({
  aberto: false,
  evento: '' as string,
  lotes: [] as { id: string; nome: string; setor: string; emitidas: number; cota: string }[],
})
function abrirCota() {
  Object.assign(cota, {
    aberto: true,
    evento: data.value?.cota.eventoCota === null ? '' : String(data.value.cota.eventoCota),
    lotes: (data.value?.lotes ?? []).map((l: any) => ({
      id: l.id, nome: l.nome, setor: l.setor, emitidas: l.cortesias,
      cota: l.cota === null ? '' : String(l.cota),
    })),
  })
}
/** campo em branco = sem teto. Zero é um teto de verdade ("aqui não se dá"). */
const numeroOuNulo = (v: string) => (v.trim() === '' ? null : Math.max(0, Math.trunc(Number(v) || 0)))

async function salvarCota() {
  erro.value = ''
  salvando.value = true
  try {
    await $fetch(`/api/admin/evento/${id}/cortesias`, {
      method: 'POST',
      body: {
        acao: 'cota',
        cotaEvento: numeroOuNulo(cota.evento),
        lotes: cota.lotes.map((l) => ({ id: l.id, cota: numeroOuNulo(l.cota) })),
      },
    })
  } catch (e: any) {
    erro.value = recado(e, 'Não foi possível salvar a cota.')
    return
  } finally {
    salvando.value = false
  }

  // mesma separação da emissão: a cota já está gravada
  cota.aberto = false
  try {
    await refresh()
  } catch (e: any) {
    erro.value = `A cota foi salva, mas a tela não recarregou: ${recado(e, 'tente atualizar a página')}.`
  }
}

/* ------------------------------------------------------------- cancelar */

const confirmando = ref('')
async function cancelar(ticketId: string) {
  if (confirmando.value !== ticketId) { confirmando.value = ticketId; return }
  confirmando.value = ''
  erro.value = ''
  try {
    await $fetch(`/api/admin/evento/${id}/cortesias`, { method: 'DELETE', body: { id: ticketId } })
  } catch (e: any) {
    erro.value = recado(e, 'Não foi possível cancelar.')
    return
  }
  try {
    await refresh()
  } catch (e: any) {
    erro.value = `A cortesia foi cancelada, mas a lista não recarregou: ${recado(e, 'tente atualizar a página')}.`
  }
}

/** Cola: uma pessoa por linha, `nome, email, documento`. */
const colar = ref('')
function aplicarColagem() {
  const linhas = colar.value.split('\n').map((l) => l.trim()).filter(Boolean)
  if (!linhas.length) return
  form.pessoas = linhas.map((l) => {
    const [nome, email, documento] = l.split(/[,;\t]/).map((s) => (s ?? '').trim())
    return { nome: nome ?? '', email: email ?? '', documento: documento ?? '' }
  })
  colar.value = ''
}

const SELO: Record<string, string> = {
  valido: 'selo-ok', usado: 'selo-neutro', cancelado: 'selo-erro', transferido: 'selo-alerta',
}

const quando = (d: string | null) => d
  ? new Date(d).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
  : '—'

useHead({ title: 'Cortesias' })
</script>

<template>
  <div v-if="data">
    <div class="flex flex-wrap items-start justify-between gap-3 py-5">
      <div>
        <h1 class="titulo text-2xl font-semibold text-tinta">Cortesias</h1>
        <p class="mt-1 text-tinta-suave">
          Ingresso de graça, com nome e código. Baixa estoque igual a uma venda — o lugar é o mesmo.
        </p>
      </div>
      <div class="flex gap-2">
        <button type="button" class="btn-secundario disabled:opacity-50"
                :disabled="!souMaster"
                :title="souMaster ? 'Quantas cortesias este evento pode dar'
                                  : 'Só um acesso Master muda o teto de cortesia. Emitir dentro da cota você continua podendo.'"
                @click="abrirCota()">
          <IconeMenu nome="etiqueta" :tamanho="18" /> Definir cota
        </button>
        <button type="button" class="btn-primario" @click="abrir()">
          <IconeMenu nome="presente" :tamanho="18" /> Emitir cortesia
        </button>
      </div>
    </div>

    <AbasSecao :evento-id="id" />

    <p v-if="erro" class="faixa-erro mt-4">{{ erro }}</p>
    <p v-if="emitido" class="mt-4 flex items-center gap-2 rounded-card border border-ok bg-ok-claro px-3 py-2 text-sm text-ok">
      <IconeMenu nome="check" :tamanho="16" />
      {{ emitido.quantidade }} cortesia(s) emitida(s) no pedido {{ emitido.pedido }}.
      <button type="button" class="ml-auto underline" @click="emitido = null">ok</button>
    </p>

    <!-- resumo -->
    <div class="mt-5 grid gap-3 sm:grid-cols-4">
      <div class="card">
        <p class="rotulo-kpi">Emitidas</p>
        <!-- O teto fica colado no número: "12" sozinho não responde "isso é
             muito?". "12 de 30" responde. -->
        <p class="numero-kpi mt-1">
          {{ data.cota.eventoUsadas }}<span v-if="data.cota.eventoCota !== null"
            class="text-tinta-fraca"> de {{ data.cota.eventoCota }}</span>
        </p>
        <p class="mt-1 text-xs"
           :class="data.cota.eventoRestam === 0 ? 'text-alerta' : 'text-tinta-fraca'">
          <template v-if="data.cota.eventoCota === null">sem cota definida</template>
          <template v-else-if="data.cota.eventoRestam === 0">a cota acabou</template>
          <template v-else>ainda cabem {{ data.cota.eventoRestam }}</template>
        </p>
      </div>
      <div class="card">
        <p class="rotulo-kpi">Já entraram</p>
        <p class="numero-kpi mt-1">{{ data.resumo.usados }}</p>
      </div>
      <div class="card">
        <p class="rotulo-kpi">Deixou de faturar</p>
        <p class="numero-kpi mt-1 text-alerta">{{ reais(data.resumo.valorDadoCents) }}</p>
        <p class="mt-1 text-xs text-tinta-fraca">pelo valor de face da emissão</p>
      </div>
      <div class="card">
        <p class="rotulo-kpi">Canceladas</p>
        <p class="numero-kpi mt-1">{{ data.resumo.cancelados }}</p>
      </div>
    </div>

    <!-- Honestidade sobre o que o rastro não tem: as cortesias emitidas antes
         de motivo e "quem pediu" virarem obrigatórios não ganharam registro
         inventado. A tela diz quantas são em vez de fingir que o rastro está
         completo. -->
    <p v-if="data.resumo.semRastro" class="faixa-aviso mt-3">
      {{ data.resumo.semRastro }} cortesia(s) desta lista foram emitidas antes de motivo e
      "quem pediu" virarem obrigatórios — delas só existe o código, a pessoa e a data.
    </p>

    <div class="mt-4 flex flex-wrap items-center gap-3">
      <input v-model="busca" class="campo max-w-sm" placeholder="Buscar por nome, motivo, quem pediu…">
      <p v-if="busca" class="text-sm text-tinta-suave">
        {{ listaFiltrada.length }} de {{ data.ingressos.length }}
      </p>
    </div>

    <p v-if="!data.ingressos.length" class="card mt-4 py-12 text-center text-tinta-suave">
      Nenhuma cortesia emitida.
    </p>
    <p v-else-if="!listaFiltrada.length" class="card mt-4 py-12 text-center text-tinta-suave">
      Nenhuma cortesia bate com "{{ busca }}".
    </p>

    <div v-else class="card mt-4 overflow-x-auto p-0">
      <table class="w-full min-w-[1180px] border-collapse text-sm">
        <thead>
          <tr class="border-b border-linha bg-fundo-cinza/60 text-left">
            <th class="titulo px-4 py-2 text-xs font-semibold uppercase tracking-wide text-tinta-rotulo">Código</th>
            <th class="titulo px-3 py-2 text-xs font-semibold uppercase tracking-wide text-tinta-rotulo">Quem recebeu</th>
            <th class="titulo px-3 py-2 text-xs font-semibold uppercase tracking-wide text-tinta-rotulo">Setor / lote</th>
            <th class="titulo px-3 py-2 text-xs font-semibold uppercase tracking-wide text-tinta-rotulo">Motivo / quem pediu</th>
            <th class="titulo px-3 py-2 text-xs font-semibold uppercase tracking-wide text-tinta-rotulo">Autorizada por</th>
            <th class="titulo px-3 py-2 text-xs font-semibold uppercase tracking-wide text-tinta-rotulo">Entrou</th>
            <th class="titulo px-3 py-2 text-xs font-semibold uppercase tracking-wide text-tinta-rotulo">Situação</th>
            <th class="titulo px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-tinta-rotulo">Ações</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="t in listaFiltrada" :key="t.id" class="border-b border-linha last:border-0">
            <td class="px-4 py-3 font-mono text-xs text-acao">{{ t.codigo }}</td>
            <td class="px-3 py-3">
              <p class="font-medium text-tinta">{{ t.nome || '—' }}</p>
              <p class="text-xs text-tinta-fraca">
                {{ [t.email, t.documento].filter(Boolean).join(' · ') || 'sem contato' }}
              </p>
            </td>
            <td class="px-3 py-3 text-tinta-suave">
              {{ t.setor }}
              <span class="block text-xs text-tinta-fraca">{{ t.lote }}<template v-if="t.tipo"> · {{ t.tipo }}</template></span>
            </td>
            <td class="px-3 py-3">
              <template v-if="t.motivo">
                <p class="text-tinta-suave">{{ t.motivo }}</p>
                <p class="text-xs text-tinta-fraca">a pedido de {{ t.pedidaPor }}</p>
              </template>
              <span v-else class="text-xs text-tinta-fraca">não registrado</span>
            </td>
            <td class="px-3 py-3">
              <template v-if="t.autorizadaPor">
                <p class="text-tinta-suave">{{ t.autorizadaPor }}</p>
                <p class="text-xs text-tinta-fraca">{{ quando(t.autorizadaEm) }}</p>
              </template>
              <span v-else class="text-xs text-tinta-fraca">{{ quando(t.emitidoEm) }}</span>
            </td>
            <td class="px-3 py-3 text-xs text-tinta-suave">{{ quando(t.entrouEm) }}</td>
            <td class="px-3 py-3">
              <span :class="SELO[t.status] ?? 'selo-neutro'">{{ t.status.toUpperCase() }}</span>
            </td>
            <td class="px-3 py-3 text-right">
              <!-- O rótulo acompanha o estado: um botão desabilitado escrito
                   "Cancelar" numa linha CANCELADO faz a pessoa clicar de novo
                   achando que a primeira vez não pegou. -->
              <button type="button" class="px-2 text-sm disabled:opacity-40"
                      :class="confirmando === t.id ? 'font-semibold text-erro' : 'text-tinta-fraca hover:text-erro'"
                      :disabled="t.status === 'usado' || t.status === 'cancelado'"
                      :title="t.status === 'usado' ? 'Já entrou no evento' : 'Cancelar cortesia'"
                      @click="cancelar(t.id)">
                {{ t.status === 'cancelado' ? 'Cancelada'
                   : t.status === 'usado' ? 'Já entrou'
                   : confirmando === t.id ? 'Confirmar' : 'Cancelar' }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- ===================================================== emitir -->
    <ModalLateral v-if="form.aberto" titulo="Emitir cortesia" largura="max-w-2xl"
                  @fechar="form.aberto = false">
      <div class="grid gap-3">
        <div>
          <label class="rotulo">De qual lote</label>
          <select v-model="form.loteId" class="campo">
            <option v-for="l in data.lotes" :key="l.id" :value="l.id" :disabled="!podeReceber(l)">
              {{ l.setor }} › {{ l.nome }} — {{ l.disponivel }} em estoque<template
                v-if="l.cota !== null">, {{ l.cotaRestam }} de cota</template>
            </option>
          </select>
          <p v-if="loteEscolhido" class="mt-1 text-xs text-tinta-fraca">
            Valor de face {{ reais(loteEscolhido.faceCents) }}
            <template v-if="loteEscolhido.cota !== null">
              · cota do lote {{ loteEscolhido.cortesias }} de {{ loteEscolhido.cota }}
            </template>
            <template v-if="data.cota.eventoCota !== null">
              · cota do evento {{ data.cota.eventoUsadas }} de {{ data.cota.eventoCota }}
            </template>
          </p>
        </div>

        <div class="grid gap-3 sm:grid-cols-2">
          <div>
            <label class="rotulo">Motivo</label>
            <input v-model="form.motivo" class="campo" placeholder="Imprensa, patrocinador, equipe…">
            <p class="mt-1 text-xs text-tinta-fraca">
              Ela sai do estoque e não entra no faturamento — isto é o que explica a diferença depois.
            </p>
          </div>
          <div>
            <label class="rotulo">Quem pediu</label>
            <input v-model="form.responsavel" class="campo" placeholder="Nome de quem solicitou">
            <p class="mt-1 text-xs text-tinta-fraca">
              A pessoa que pediu, não quem está emitindo — seu nome já vai carimbado.
            </p>
          </div>
        </div>

        <fieldset>
          <legend class="rotulo">Quem recebe</legend>
          <div class="space-y-2">
            <div v-for="(p, i) in form.pessoas" :key="i" class="grid gap-2 sm:grid-cols-[2fr,2fr,1.2fr,auto]">
              <input v-model="p.nome" class="campo" placeholder="Nome">
              <input v-model="p.email" type="email" class="campo" placeholder="E-mail (opcional)">
              <input v-model="p.documento" class="campo" placeholder="Documento">
              <button type="button" class="px-2 text-tinta-fraca hover:text-erro"
                      :disabled="form.pessoas.length === 1" aria-label="Remover linha"
                      @click="form.pessoas.splice(i, 1)">
                <IconeMenu nome="lixo" :tamanho="16" />
              </button>
            </div>
          </div>
          <button type="button" class="btn-secundario mt-2 py-1.5 text-sm"
                  @click="form.pessoas.push({ nome: '', email: '', documento: '' })">
            <IconeMenu nome="mais" :tamanho="16" /> Mais uma
          </button>
        </fieldset>

        <details class="rounded-card border border-linha p-3">
          <summary class="cursor-pointer text-sm font-medium text-tinta">Colar uma lista</summary>
          <p class="mt-2 text-xs text-tinta-fraca">
            Uma pessoa por linha, separando com vírgula: <code>Nome, email, documento</code>.
          </p>
          <textarea v-model="colar" rows="4" class="campo mt-2 font-mono text-xs"
                    placeholder="Maria Silva, maria@email.com, 000.000.000-00" />
          <button type="button" class="btn-secundario mt-2 py-1.5 text-sm" @click="aplicarColagem">
            Preencher com essa lista
          </button>
        </details>
      </div>

      <template #acoes>
        <!-- O motivo de o botão estar apagado fica ao lado dele. Botão
             desabilitado sem explicação faz a pessoa preencher 40 nomes e só
             então descobrir o que faltava. -->
        <p v-if="faltaPreencher" class="mr-auto self-center text-xs text-alerta">{{ faltaPreencher }}</p>
        <button type="button" class="btn-secundario" @click="form.aberto = false">Cancelar</button>
        <button type="button" class="btn-primario" :disabled="salvando || !!faltaPreencher" @click="emitir">
          Emitir {{ quantosNomes || '' }} cortesia(s)
        </button>
      </template>
    </ModalLateral>

    <!-- ======================================================= cota -->
    <ModalLateral v-if="cota.aberto" titulo="Cota de cortesia" largura="max-w-xl"
                  @fechar="cota.aberto = false">
      <p class="text-sm text-tinta-suave">
        Quantas cortesias este evento pode dar. Campo em branco é <strong>sem teto</strong>;
        zero é um teto de verdade — "aqui não se dá cortesia".
      </p>
      <p class="apoio-bloco">
        A cota não pode ficar abaixo do que já foi emitido: as pessoas que já receberam
        aparecem na portaria do mesmo jeito. Cancele cortesias antes de baixar o teto.
      </p>

      <div class="mt-4">
        <label class="rotulo">Cota do evento inteiro</label>
        <input v-model="cota.evento" type="number" min="0" class="campo max-w-[200px]"
               placeholder="sem teto">
        <p class="mt-1 text-xs text-tinta-fraca">
          {{ data.cota.eventoUsadas }} já emitida(s).
        </p>
      </div>

      <div class="mt-5">
        <p class="rotulo">Cota por lote</p>
        <table class="w-full border-collapse text-sm">
          <tbody>
            <tr v-for="l in cota.lotes" :key="l.id" class="border-b border-linha last:border-0">
              <td class="py-2 pr-3">
                <p class="text-tinta">{{ l.nome }}</p>
                <p class="text-xs text-tinta-fraca">{{ l.setor }} · {{ l.emitidas }} emitida(s)</p>
              </td>
              <td class="w-[130px] py-2">
                <input v-model="l.cota" type="number" min="0" class="campo" placeholder="sem teto">
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <template #acoes>
        <button type="button" class="btn-secundario" @click="cota.aberto = false">Cancelar</button>
        <button type="button" class="btn-primario" :disabled="salvando" @click="salvarCota">
          Salvar cota
        </button>
      </template>
    </ModalLateral>
  </div>

  <p v-else-if="pending" class="card mt-6 text-tinta-suave">Carregando…</p>

  <div v-else class="card mt-6">
    <p class="rotulo-kpi text-erro">Não foi possível carregar as cortesias</p>
    <p class="mt-1 text-sm text-tinta-suave">
      {{ (falha as any)?.data?.statusMessage || (falha as any)?.message || 'Erro desconhecido.' }}
    </p>
    <button type="button" class="btn-secundario mt-3" @click="refresh()">Tentar de novo</button>
  </div>
</template>
