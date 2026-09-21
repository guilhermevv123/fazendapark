<script setup lang="ts">
/**
 * Participantes — a lista da portaria.
 *
 * É lista de INGRESSOS, não de pedidos: um pedido de 6 é uma linha em Vendas e
 * seis pessoas aqui. E é onde se NOMEIA o ingresso em branco — quem compra 6
 * recebe 5 sem nome, e é esse preenchimento que transforma a compra numa lista
 * de entrada com documento.
 */
definePageMeta({ layout: 'admin' })

const route = useRoute()
const id = route.params.id as string

const busca = ref('')
const status = ref('')
const setor = ref('')
const pagina = ref(1)

// Debounce: sem ele, cada tecla dispara uma consulta e a resposta da 3ª letra
// pode chegar depois da 5ª, repintando a tela com um resultado velho.
const buscaDebounce = ref('')
let timer: any
watch(busca, (v) => {
  clearTimeout(timer)
  timer = setTimeout(() => { buscaDebounce.value = v; pagina.value = 1 }, 300)
})
watch([status, setor], () => { pagina.value = 1 })

const { data, refresh, pending, error: falha } = await useFetch<any>(
  () => `/api/admin/evento/${id}/participantes`,
  { query: { busca: buscaDebounce, status, setor, pagina } })

const erro = ref('')
const salvando = ref(false)

const form = reactive({ aberto: false, id: '', codigo: '', nome: '', email: '', documento: '' })
function abrir(p: any) {
  Object.assign(form, {
    aberto: true, id: p.id, codigo: p.codigo,
    nome: p.nome ?? '', email: p.email ?? '', documento: p.documento ?? '',
  })
}
async function salvar() {
  erro.value = ''
  salvando.value = true
  try {
    await $fetch(`/api/admin/evento/${id}/participantes`, {
      method: 'PATCH',
      body: { id: form.id, nome: form.nome || null, email: form.email || null,
              documento: form.documento || null },
    })
    await refresh()
    form.aberto = false
  } catch (e: any) {
    erro.value = e?.data?.statusMessage || 'Não foi possível salvar.'
  } finally {
    salvando.value = false
  }
}

const SELO: Record<string, string> = {
  valido: 'selo-ok', usado: 'selo-neutro', cancelado: 'selo-erro', transferido: 'selo-alerta',
}

function exportar() {
  const cab = ['Código', 'Portador', 'Documento', 'E-mail', 'Setor', 'Lote', 'Tipo',
               'Situação', 'Entrou em', 'Pedido', 'Comprador']
  const linhas = (data.value?.participantes ?? []).map((p: any) => [
    p.codigo, p.nome ?? '', p.documento ?? '', p.email ?? '',
    p.setor, p.lote, p.tipo ?? '', p.status,
    p.entrouEm ? new Date(p.entrouEm).toLocaleString('pt-BR') : '',
    p.pedido ?? '', p.comprador ?? '',
  ])
  const csv = [cab, ...linhas]
    .map((l) => l.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(';'))
    .join('\r\n')
  const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = `participantes-${id.slice(0, 8)}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

useHead({ title: 'Participantes' })
</script>

<template>
  <div v-if="data">
    <div class="flex flex-wrap items-start justify-between gap-3 py-5">
      <div>
        <h1 class="titulo text-2xl font-bold text-tinta">Participantes</h1>
        <p class="mt-1 text-tinta-suave">
          Um por ingresso, não por pedido. É esta lista que a portaria usa.
        </p>
      </div>
      <button type="button" class="btn-secundario" @click="exportar">
        <IconeMenu nome="exportar" :tamanho="18" /> Exportar página
      </button>
    </div>

    <AbasSecao :evento-id="id" />

    <p v-if="erro" class="mt-4 rounded-card border border-erro bg-erro-claro px-3 py-2 text-sm text-erro">
      {{ erro }}
    </p>

    <div class="mt-5 grid gap-3 sm:grid-cols-3">
      <div class="card">
        <p class="rotulo-kpi">Ingressos no filtro</p>
        <p class="numero-kpi mt-1">{{ data.resumo.total }}</p>
      </div>
      <div class="card">
        <p class="rotulo-kpi">Já entraram</p>
        <p class="numero-kpi mt-1">{{ data.resumo.entraram }}</p>
      </div>
      <div class="card">
        <p class="rotulo-kpi">Cortesias</p>
        <p class="numero-kpi mt-1">{{ data.resumo.cortesias }}</p>
      </div>
    </div>

    <div class="card mt-4 flex flex-wrap items-end gap-3">
      <div class="min-w-[240px] flex-1">
        <label for="q" class="rotulo">Buscar</label>
        <input id="q" v-model="busca" class="campo"
               placeholder="nome, documento, código, e-mail ou pedido">
      </div>
      <div>
        <label for="st" class="rotulo">Situação</label>
        <select id="st" v-model="status" class="campo">
          <option value="">Todas</option>
          <option value="valido">Válido</option>
          <option value="usado">Já entrou</option>
          <option value="cancelado">Cancelado</option>
          <option value="transferido">Transferido</option>
        </select>
      </div>
      <div>
        <label for="se" class="rotulo">Setor</label>
        <select id="se" v-model="setor" class="campo">
          <option value="">Todos</option>
          <option v-for="s in data.setores" :key="s.id" :value="s.id">{{ s.nome }}</option>
        </select>
      </div>
      <p class="pb-2 text-sm text-tinta-suave">
        página {{ data.pagina }} de {{ data.paginas }}
      </p>
    </div>

    <p v-if="!data.participantes.length" class="card mt-4 py-12 text-center text-tinta-suave">
      Nenhum participante com esses filtros.
    </p>

    <div v-else class="card mt-4 overflow-x-auto p-0">
      <table class="w-full min-w-[960px] border-collapse text-sm">
        <thead>
          <tr class="border-b border-linha bg-fundo-cinza/60 text-left">
            <th class="titulo px-4 py-2 text-xs font-bold uppercase tracking-wide text-tinta-rotulo">Código</th>
            <th class="titulo px-3 py-2 text-xs font-bold uppercase tracking-wide text-tinta-rotulo">Portador</th>
            <th class="titulo px-3 py-2 text-xs font-bold uppercase tracking-wide text-tinta-rotulo">Setor / lote</th>
            <th class="titulo px-3 py-2 text-xs font-bold uppercase tracking-wide text-tinta-rotulo">Comprador</th>
            <th class="titulo px-3 py-2 text-xs font-bold uppercase tracking-wide text-tinta-rotulo">Entrou</th>
            <th class="titulo px-3 py-2 text-xs font-bold uppercase tracking-wide text-tinta-rotulo">Situação</th>
            <th class="titulo px-3 py-2 text-right text-xs font-bold uppercase tracking-wide text-tinta-rotulo">Ações</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="p in data.participantes" :key="p.id" class="border-b border-linha last:border-0">
            <td class="px-4 py-3 font-mono text-xs text-acao">
              {{ p.codigo }}
              <span v-if="p.cortesia" class="selo-neutro ml-1">CORTESIA</span>
            </td>
            <td class="px-3 py-3">
              <p v-if="p.nome" class="font-medium text-tinta">{{ p.nome }}</p>
              <p v-else class="italic text-tinta-fraca">sem nome — clique em nomear</p>
              <p class="text-xs text-tinta-fraca">
                {{ [p.documento, p.email].filter(Boolean).join(' · ') }}
              </p>
            </td>
            <td class="px-3 py-3 text-tinta-suave">
              {{ p.setor }}
              <span class="block text-xs text-tinta-fraca">
                {{ p.lote }}<template v-if="p.tipo"> · {{ p.tipo }}</template>
              </span>
            </td>
            <td class="px-3 py-3 text-tinta-suave">
              {{ p.comprador ?? '—' }}
              <NuxtLink v-if="p.pedidoId" :to="`/admin/evento/${id}/vendas?pedido=${p.pedidoId}`"
                        class="block font-mono text-xs text-acao hover:underline">
                {{ p.pedido }}
              </NuxtLink>
            </td>
            <td class="px-3 py-3 text-xs text-tinta-suave">
              <template v-if="p.entrouEm">
                {{ new Date(p.entrouEm).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) }}
                <span v-if="p.validadoPor" class="block text-tinta-fraca">por {{ p.validadoPor }}</span>
              </template>
              <template v-else>—</template>
            </td>
            <td class="px-3 py-3">
              <span :class="SELO[p.status] ?? 'selo-neutro'">{{ p.status.toUpperCase() }}</span>
            </td>
            <td class="px-3 py-3 text-right">
              <button type="button" class="px-2 text-sm disabled:opacity-30"
                      :class="p.nome ? 'text-tinta-fraca hover:text-acao' : 'font-bold text-acao'"
                      :disabled="p.status === 'usado' || p.status === 'cancelado'"
                      :title="p.status === 'usado' ? 'Já entrou: o portador não muda mais' : ''"
                      @click="abrir(p)">
                {{ p.nome ? 'Editar' : 'Nomear' }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="data.paginas > 1" class="mt-4 flex items-center justify-center gap-2">
      <button type="button" class="btn-secundario py-1.5 text-sm" :disabled="data.pagina <= 1"
              @click="pagina = data.pagina - 1">Anterior</button>
      <span class="text-sm text-tinta-suave">{{ data.pagina }} / {{ data.paginas }}</span>
      <button type="button" class="btn-secundario py-1.5 text-sm" :disabled="data.pagina >= data.paginas"
              @click="pagina = data.pagina + 1">Próxima</button>
    </div>

    <ModalLateral v-if="form.aberto" :titulo="`Nomear ${form.codigo}`" @fechar="form.aberto = false">
      <div class="grid gap-3">
        <div>
          <label class="rotulo">Nome de quem vai usar</label>
          <input v-model="form.nome" class="campo" placeholder="Nome completo">
        </div>
        <div>
          <label class="rotulo">Documento</label>
          <input v-model="form.documento" class="campo" placeholder="CPF ou RG">
          <p class="mt-1 text-xs text-tinta-fraca">
            É o que a portaria confere quando o ingresso exige documento.
          </p>
        </div>
        <div>
          <label class="rotulo">E-mail (opcional)</label>
          <input v-model="form.email" type="email" class="campo">
        </div>
      </div>
      <template #acoes>
        <button type="button" class="btn-secundario" @click="form.aberto = false">Cancelar</button>
        <button type="button" class="btn-primario" :disabled="salvando" @click="salvar">Salvar</button>
      </template>
    </ModalLateral>
  </div>

  <p v-else-if="pending" class="card mt-6 text-tinta-suave">Carregando…</p>

  <div v-else class="card mt-6">
    <p class="rotulo-kpi text-erro">Não foi possível carregar os participantes</p>
    <p class="mt-1 text-sm text-tinta-suave">
      {{ (falha as any)?.data?.statusMessage || (falha as any)?.message || 'Erro desconhecido.' }}
    </p>
    <button type="button" class="btn-secundario mt-3" @click="refresh()">Tentar de novo</button>
  </div>
</template>
