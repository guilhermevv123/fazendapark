<script setup lang="ts">
/**
 * Códigos promocionais.
 *
 * A coluna que a plataforma de origem não mostra é a última: **quanto este
 * cupom já tirou do caixa**. Contador de uso engana — dez usos de R$ 5 e dez
 * de R$ 50 aparecem iguais, e é sempre o segundo que estoura o orçamento de
 * desconto do evento.
 */
definePageMeta({ layout: 'admin' })

const route = useRoute()
const id = route.params.id as string

const { data, refresh, pending, error: falha } = await useFetch<any>(
  `/api/admin/evento/${id}/cupons`)

const reais = (c: number) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
const erro = ref('')
const salvando = ref(false)

async function chamar(metodo: 'POST' | 'PATCH' | 'DELETE', body: any) {
  erro.value = ''
  salvando.value = true
  try {
    await $fetch(`/api/admin/evento/${id}/cupons`, { method: metodo, body })
    await refresh()
    return true
  } catch (e: any) {
    erro.value = e?.data?.statusMessage || 'Não foi possível salvar.'
    return false
  } finally {
    salvando.value = false
  }
}

const form = reactive({
  aberto: false, id: '', codigo: '', tipo: 'percentual' as 'percentual' | 'fixo',
  /** na tela: % ou reais. Vira bps/centavos só no envio. */
  valor: 10, maxUsos: null as number | null, maxPorCliente: 1,
  comecaEm: '', terminaEm: '', loteIds: [] as string[], ativo: true,
})

function abrir(c?: any) {
  Object.assign(form, {
    aberto: true,
    id: c?.id ?? '',
    codigo: c?.codigo ?? '',
    tipo: c?.tipo ?? 'percentual',
    valor: c ? (c.tipo === 'percentual' ? c.valor / 100 : c.valor / 100) : 10,
    maxUsos: c?.maxUsos ?? null,
    maxPorCliente: c?.maxPorCliente ?? 1,
    comecaEm: c?.comecaEm ? new Date(c.comecaEm).toISOString().slice(0, 16) : '',
    terminaEm: c?.terminaEm ? new Date(c.terminaEm).toISOString().slice(0, 16) : '',
    loteIds: [...(c?.loteIds ?? [])],
    ativo: c?.ativo ?? true,
  })
}

const deCampo = (v: string) => (v ? new Date(v).toISOString() : null)

async function salvar() {
  // percentual → bps; fixo → centavos. Os dois multiplicam por 100, mas por
  // motivos diferentes: deixar isso implícito é como 10% vira R$ 0,10.
  const valor = Math.round(form.valor * 100)
  const campos = {
    valor,
    maxUsos: form.maxUsos || null,
    maxPorCliente: form.maxPorCliente,
    comecaEm: deCampo(form.comecaEm),
    terminaEm: deCampo(form.terminaEm),
    loteIds: form.loteIds,
    ativo: form.ativo,
  }
  const ok = form.id
    ? await chamar('PATCH', { id: form.id, campos })
    : await chamar('POST', { codigo: form.codigo, tipo: form.tipo, ...campos })
  if (ok) form.aberto = false
}

const confirmando = ref('')
async function apagar(cupomId: string) {
  if (confirmando.value !== cupomId) { confirmando.value = cupomId; return }
  confirmando.value = ''
  await chamar('DELETE', { id: cupomId })
}

const copiado = ref('')
async function copiar(codigo: string) {
  try {
    await navigator.clipboard.writeText(codigo)
    copiado.value = codigo
    setTimeout(() => { if (copiado.value === codigo) copiado.value = '' }, 2000)
  } catch { erro.value = 'O navegador bloqueou a cópia. Selecione o código à mão.' }
}

const descricao = (c: any) =>
  c.tipo === 'percentual' ? `${(c.valor / 100).toFixed(c.valor % 100 ? 2 : 0)}%` : reais(c.valor)

function situacao(c: any) {
  if (!c.ativo) return { texto: 'DESATIVADO', classe: 'selo-neutro' }
  const agora = Date.now()
  if (c.comecaEm && new Date(c.comecaEm).getTime() > agora) return { texto: 'AGENDADO', classe: 'selo-alerta' }
  if (c.terminaEm && new Date(c.terminaEm).getTime() < agora) return { texto: 'EXPIRADO', classe: 'selo-neutro' }
  if (c.maxUsos && c.usos >= c.maxUsos) return { texto: 'ESGOTADO', classe: 'selo-erro' }
  return { texto: 'ATIVO', classe: 'selo-ok' }
}

useHead({ title: 'Códigos promocionais' })
</script>

<template>
  <div v-if="data">
    <div class="flex flex-wrap items-start justify-between gap-3 py-5">
      <div>
        <h1 class="titulo text-2xl font-bold text-tinta">Códigos promocionais</h1>
        <p class="mt-1 text-tinta-suave">
          Desconto por código, com teto de uso e validade. O que já foi usado não some.
        </p>
      </div>
      <button type="button" class="btn-primario" @click="abrir()">
        <IconeMenu nome="mais" :tamanho="18" /> Criar código
      </button>
    </div>

    <AbasSecao :evento-id="id" />

    <p v-if="erro" class="mt-4 rounded-card border border-erro bg-erro-claro px-3 py-2 text-sm text-erro">
      {{ erro }}
    </p>

    <p v-if="!data.cupons.length" class="card mt-5 py-12 text-center text-tinta-suave">
      Nenhum código promocional ainda.
    </p>

    <div v-else class="card mt-5 overflow-x-auto p-0">
      <table class="w-full min-w-[900px] border-collapse text-sm">
        <thead>
          <tr class="border-b border-linha bg-fundo-cinza/60 text-left">
            <th class="titulo px-4 py-2 text-xs font-bold uppercase tracking-wide text-tinta-rotulo">Código</th>
            <th class="titulo px-3 py-2 text-xs font-bold uppercase tracking-wide text-tinta-rotulo">Desconto</th>
            <th class="titulo px-3 py-2 text-xs font-bold uppercase tracking-wide text-tinta-rotulo">Vale em</th>
            <th class="titulo px-3 py-2 text-right text-xs font-bold uppercase tracking-wide text-tinta-rotulo">Usos</th>
            <th class="titulo px-3 py-2 text-right text-xs font-bold uppercase tracking-wide text-tinta-rotulo">Já descontou</th>
            <th class="titulo px-3 py-2 text-xs font-bold uppercase tracking-wide text-tinta-rotulo">Validade</th>
            <th class="titulo px-3 py-2 text-xs font-bold uppercase tracking-wide text-tinta-rotulo">Situação</th>
            <th class="titulo px-3 py-2 text-right text-xs font-bold uppercase tracking-wide text-tinta-rotulo">Ações</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="c in data.cupons" :key="c.id" class="border-b border-linha last:border-0">
            <td class="px-4 py-3">
              <button type="button" class="flex items-center gap-2 font-bold text-acao hover:underline"
                      @click="copiar(c.codigo)">
                {{ c.codigo }}
                <IconeMenu :nome="copiado === c.codigo ? 'check' : 'copia'" :tamanho="14" />
              </button>
            </td>
            <td class="px-3 py-3 font-medium tabular-nums text-tinta">{{ descricao(c) }}</td>
            <td class="px-3 py-3 text-tinta-suave">
              <template v-if="!c.loteIds.length">Todos os lotes</template>
              <template v-else>
                {{ c.loteIds.length }} lote(s)
                <span class="block text-xs text-tinta-fraca">
                  {{ data.lotes.filter((l: any) => c.loteIds.includes(l.id)).map((l: any) => l.nome).join(', ') }}
                </span>
              </template>
            </td>
            <td class="px-3 py-3 text-right tabular-nums text-tinta">
              {{ c.usos }}<span v-if="c.maxUsos" class="text-tinta-fraca"> / {{ c.maxUsos }}</span>
              <span class="block text-xs text-tinta-fraca">máx. {{ c.maxPorCliente }} por pessoa</span>
            </td>
            <td class="px-3 py-3 text-right tabular-nums"
                :class="c.descontoDadoCents ? 'font-medium text-alerta' : 'text-tinta-fraca'">
              {{ reais(c.descontoDadoCents) }}
            </td>
            <td class="px-3 py-3 text-xs text-tinta-suave">
              <template v-if="c.comecaEm">de {{ new Date(c.comecaEm).toLocaleDateString('pt-BR') }}</template>
              <template v-if="c.terminaEm"> até {{ new Date(c.terminaEm).toLocaleDateString('pt-BR') }}</template>
              <template v-if="!c.comecaEm && !c.terminaEm">sem prazo</template>
            </td>
            <td class="px-3 py-3">
              <span :class="situacao(c).classe">{{ situacao(c).texto }}</span>
            </td>
            <td class="px-3 py-3">
              <div class="flex items-center justify-end gap-1">
                <button type="button" class="p-1 text-tinta-fraca hover:text-acao"
                        :title="c.ativo ? 'Desativar' : 'Ativar'"
                        @click="chamar('PATCH', { id: c.id, campos: { ativo: !c.ativo } })">
                  <IconeMenu :nome="c.ativo ? 'check' : 'fechar'" :tamanho="16" />
                </button>
                <button type="button" class="p-1 text-tinta-fraca hover:text-acao"
                        title="Editar" @click="abrir(c)">
                  <IconeMenu nome="lapis" :tamanho="16" />
                </button>
                <button type="button" class="p-1 disabled:opacity-30"
                        :class="confirmando === c.id ? 'text-erro' : 'text-tinta-fraca hover:text-erro'"
                        :disabled="!c.podeApagar"
                        :title="c.podeApagar
                          ? (confirmando === c.id ? 'Clique de novo para confirmar' : 'Apagar')
                          : 'Cupom já usado: desative em vez de apagar'"
                        @click="apagar(c.id)">
                  <IconeMenu nome="lixo" :tamanho="16" />
                </button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <ModalLateral v-if="form.aberto" :titulo="form.id ? 'Editar código' : 'Criar código promocional'"
                  @fechar="form.aberto = false">
      <div class="grid gap-3">
        <div v-if="!form.id">
          <label class="rotulo">Código</label>
          <input v-model="form.codigo" class="campo uppercase" placeholder="VERAO10"
                 @input="form.codigo = form.codigo.toUpperCase()">
          <p class="mt-1 text-xs text-tinta-fraca">
            Vira maiúscula sem espaço nem acento. Depois de criado não muda — ele já saiu em
            post e flyer.
          </p>
        </div>
        <p v-else class="rounded-card bg-fundo-cinza px-3 py-2 text-sm text-tinta-suave">
          Código: <strong class="text-tinta">{{ data.cupons.find((c: any) => c.id === form.id)?.codigo }}</strong>
          — para trocar, desative este e crie outro.
        </p>

        <div class="grid gap-3 sm:grid-cols-2">
          <div v-if="!form.id">
            <label class="rotulo">Tipo</label>
            <select v-model="form.tipo" class="campo">
              <option value="percentual">Percentual (%)</option>
              <option value="fixo">Valor fixo (R$)</option>
            </select>
          </div>
          <div>
            <label class="rotulo">{{ form.tipo === 'percentual' ? 'Desconto (%)' : 'Desconto (R$)' }}</label>
            <input v-model.number="form.valor" type="number" min="0.01"
                   :max="form.tipo === 'percentual' ? 100 : undefined" step="0.01"
                   class="campo tabular-nums">
          </div>
          <div>
            <label class="rotulo">Limite de usos (opcional)</label>
            <input v-model.number="form.maxUsos" type="number" min="1" class="campo tabular-nums"
                   placeholder="sem limite">
          </div>
          <div>
            <label class="rotulo">Máx. por pessoa</label>
            <input v-model.number="form.maxPorCliente" type="number" min="1" max="100"
                   class="campo tabular-nums">
          </div>
          <div>
            <label class="rotulo">Começa em (opcional)</label>
            <input v-model="form.comecaEm" type="datetime-local" class="campo">
          </div>
          <div>
            <label class="rotulo">Termina em (opcional)</label>
            <input v-model="form.terminaEm" type="datetime-local" class="campo">
          </div>
        </div>

        <fieldset v-if="data.lotes.length">
          <legend class="rotulo">Vale em quais lotes</legend>
          <p class="mb-2 text-xs text-tinta-fraca">Nenhum marcado = vale em todos.</p>
          <div class="max-h-48 space-y-1 overflow-y-auto rounded-card border border-linha p-2">
            <label v-for="l in data.lotes" :key="l.id"
                   class="flex items-center gap-2 rounded px-1 py-1 text-sm hover:bg-fundo-cinza">
              <input v-model="form.loteIds" type="checkbox" :value="l.id">
              <span class="text-tinta">{{ l.nome }}</span>
              <span class="text-xs text-tinta-fraca">{{ l.setor }}</span>
            </label>
          </div>
        </fieldset>

        <label class="flex items-center gap-2 text-sm text-tinta-corpo">
          <input v-model="form.ativo" type="checkbox"> Ativo
        </label>
      </div>
      <template #acoes>
        <button type="button" class="btn-secundario" @click="form.aberto = false">Cancelar</button>
        <button type="button" class="btn-primario" :disabled="salvando" @click="salvar">
          {{ form.id ? 'Salvar' : 'Criar código' }}
        </button>
      </template>
    </ModalLateral>
  </div>

  <p v-else-if="pending" class="card mt-6 text-tinta-suave">Carregando…</p>

  <div v-else class="card mt-6">
    <p class="rotulo-kpi text-erro">Não foi possível carregar os códigos</p>
    <p class="mt-1 text-sm text-tinta-suave">
      {{ (falha as any)?.data?.statusMessage || (falha as any)?.message || 'Erro desconhecido.' }}
    </p>
    <button type="button" class="btn-secundario mt-3" @click="refresh()">Tentar de novo</button>
  </div>
</template>
