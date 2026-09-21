<script setup lang="ts">
/**
 * Cortesias.
 *
 * A caixa que importa é a terceira: **quanto isso deixou de faturar**. Cortesia
 * é a única categoria que ocupa lugar e não aparece na receita — o produtor
 * costuma descobrir o tamanho dela olhando a fila da portaria, não o painel.
 * Aqui o número fica ao lado do botão que emite.
 */
definePageMeta({ layout: 'admin' })

const route = useRoute()
const id = route.params.id as string

const { data, refresh, pending, error: falha } = await useFetch<any>(
  `/api/admin/evento/${id}/cortesias`)

const reais = (c: number) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
const erro = ref('')
const salvando = ref(false)

const form = reactive({
  aberto: false, loteId: '', motivo: '',
  /** Uma linha por pessoa. Cortesia sem nome não serve pra nada na portaria. */
  pessoas: [{ nome: '', email: '', documento: '' }],
})
function abrir() {
  Object.assign(form, {
    aberto: true,
    loteId: data.value?.lotes.find((l: any) => l.disponivel > 0)?.id ?? '',
    motivo: '',
    pessoas: [{ nome: '', email: '', documento: '' }],
  })
}
const loteEscolhido = computed(() =>
  data.value?.lotes.find((l: any) => l.id === form.loteId))

const emitido = ref<{ pedido: string; quantidade: number } | null>(null)

async function emitir() {
  const pessoas = form.pessoas
    .filter((p) => p.nome.trim())
    .map((p) => ({ nome: p.nome.trim(), email: p.email || null, documento: p.documento || null }))
  if (!pessoas.length) { erro.value = 'Preencha ao menos um nome.'; return }

  erro.value = ''
  salvando.value = true
  try {
    const r: any = await $fetch(`/api/admin/evento/${id}/cortesias`, {
      method: 'POST',
      body: { loteId: form.loteId, motivo: form.motivo || null, pessoas },
    })
    await refresh()
    form.aberto = false
    emitido.value = { pedido: r.pedido, quantidade: r.quantidade }
  } catch (e: any) {
    erro.value = e?.data?.statusMessage || 'Não foi possível emitir.'
  } finally {
    salvando.value = false
  }
}

const confirmando = ref('')
async function cancelar(ticketId: string) {
  if (confirmando.value !== ticketId) { confirmando.value = ticketId; return }
  confirmando.value = ''
  erro.value = ''
  try {
    await $fetch(`/api/admin/evento/${id}/cortesias`, { method: 'DELETE', body: { id: ticketId } })
    await refresh()
  } catch (e: any) {
    erro.value = e?.data?.statusMessage || 'Não foi possível cancelar.'
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

useHead({ title: 'Cortesias' })
</script>

<template>
  <div v-if="data">
    <div class="flex flex-wrap items-start justify-between gap-3 py-5">
      <div>
        <h1 class="titulo text-2xl font-bold text-tinta">Cortesias</h1>
        <p class="mt-1 text-tinta-suave">
          Ingresso de graça, com nome e código. Baixa estoque igual a uma venda — o lugar é o mesmo.
        </p>
      </div>
      <button type="button" class="btn-primario" @click="abrir()">
        <IconeMenu nome="presente" :tamanho="18" /> Emitir cortesia
      </button>
    </div>

    <AbasSecao :evento-id="id" />

    <p v-if="erro" class="mt-4 rounded-card border border-erro bg-erro-claro px-3 py-2 text-sm text-erro">
      {{ erro }}
    </p>
    <p v-if="emitido" class="mt-4 flex items-center gap-2 rounded-card border border-ok bg-ok-claro px-3 py-2 text-sm text-ok">
      <IconeMenu nome="check" :tamanho="16" />
      {{ emitido.quantidade }} cortesia(s) emitida(s) no pedido {{ emitido.pedido }}.
      <button type="button" class="ml-auto underline" @click="emitido = null">ok</button>
    </p>

    <!-- resumo -->
    <div class="mt-5 grid gap-3 sm:grid-cols-4">
      <div class="card">
        <p class="rotulo-kpi">Emitidas</p>
        <p class="numero-kpi mt-1">{{ data.resumo.total }}</p>
      </div>
      <div class="card">
        <p class="rotulo-kpi">Já entraram</p>
        <p class="numero-kpi mt-1">{{ data.resumo.usados }}</p>
      </div>
      <div class="card">
        <p class="rotulo-kpi">Deixou de faturar</p>
        <p class="numero-kpi mt-1 text-alerta">{{ reais(data.resumo.valorDadoCents) }}</p>
        <p class="mt-1 text-xs text-tinta-fraca">pelo valor de face do lote</p>
      </div>
      <div class="card">
        <p class="rotulo-kpi">Canceladas</p>
        <p class="numero-kpi mt-1">{{ data.resumo.cancelados }}</p>
      </div>
    </div>

    <p v-if="!data.ingressos.length" class="card mt-4 py-12 text-center text-tinta-suave">
      Nenhuma cortesia emitida.
    </p>

    <div v-else class="card mt-4 overflow-x-auto p-0">
      <table class="w-full min-w-[900px] border-collapse text-sm">
        <thead>
          <tr class="border-b border-linha bg-fundo-cinza/60 text-left">
            <th class="titulo px-4 py-2 text-xs font-bold uppercase tracking-wide text-tinta-rotulo">Código</th>
            <th class="titulo px-3 py-2 text-xs font-bold uppercase tracking-wide text-tinta-rotulo">Quem recebeu</th>
            <th class="titulo px-3 py-2 text-xs font-bold uppercase tracking-wide text-tinta-rotulo">Setor / lote</th>
            <th class="titulo px-3 py-2 text-xs font-bold uppercase tracking-wide text-tinta-rotulo">Emitida em</th>
            <th class="titulo px-3 py-2 text-xs font-bold uppercase tracking-wide text-tinta-rotulo">Entrou</th>
            <th class="titulo px-3 py-2 text-xs font-bold uppercase tracking-wide text-tinta-rotulo">Situação</th>
            <th class="titulo px-3 py-2 text-right text-xs font-bold uppercase tracking-wide text-tinta-rotulo">Ações</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="t in data.ingressos" :key="t.id" class="border-b border-linha last:border-0">
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
            <td class="px-3 py-3 text-xs text-tinta-suave">
              {{ new Date(t.emitidoEm).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) }}
            </td>
            <td class="px-3 py-3 text-xs text-tinta-suave">
              {{ t.entrouEm ? new Date(t.entrouEm).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—' }}
            </td>
            <td class="px-3 py-3">
              <span :class="SELO[t.status] ?? 'selo-neutro'">{{ t.status.toUpperCase() }}</span>
            </td>
            <td class="px-3 py-3 text-right">
              <!-- O rótulo acompanha o estado: um botão desabilitado escrito
                   "Cancelar" numa linha CANCELADO faz a pessoa clicar de novo
                   achando que a primeira vez não pegou. -->
              <button type="button" class="px-2 text-sm disabled:opacity-40"
                      :class="confirmando === t.id ? 'font-bold text-erro' : 'text-tinta-fraca hover:text-erro'"
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
            <option v-for="l in data.lotes" :key="l.id" :value="l.id" :disabled="l.disponivel <= 0">
              {{ l.setor }} › {{ l.nome }} — {{ l.disponivel }} disponível(is)
            </option>
          </select>
          <p v-if="loteEscolhido" class="mt-1 text-xs"
             :class="loteEscolhido.disponivel < form.pessoas.length ? 'text-erro' : 'text-tinta-fraca'">
            Valor de face {{ reais(loteEscolhido.faceCents) }} · sobram {{ loteEscolhido.disponivel }}
            <template v-if="loteEscolhido.disponivel < form.pessoas.filter((p: any) => p.nome.trim()).length">
              — você listou mais pessoas do que existe estoque.
            </template>
          </p>
        </div>

        <div>
          <label class="rotulo">Motivo (opcional)</label>
          <input v-model="form.motivo" class="campo" placeholder="Imprensa, patrocinador, equipe…">
          <p class="mt-1 text-xs text-tinta-fraca">Fica no registro de auditoria junto com quem emitiu.</p>
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
        <button type="button" class="btn-secundario" @click="form.aberto = false">Cancelar</button>
        <button type="button" class="btn-primario" :disabled="salvando || !form.loteId" @click="emitir">
          Emitir {{ form.pessoas.filter((p) => p.nome.trim()).length || '' }} cortesia(s)
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
