<script setup lang="ts">
/**
 * Promoters / Divulgadores.
 *
 * Cada um tem um link com o código dele; a venda que entra por ali fica
 * atribuída. O ranking é por **faturamento**, não por número de pedidos: dez
 * vendas de meia-entrada e duas de camarote não têm o mesmo peso, e ordenar
 * por quantidade coloca o promoter errado no topo da lista de comissão.
 */
definePageMeta({ layout: 'admin' })

const route = useRoute()
const id = route.params.id as string

const { data, refresh, pending, error: falha } = await useFetch<any>(
  `/api/admin/evento/${id}/promoters`)

const reais = (c: number) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
const erro = ref('')
const salvando = ref(false)

async function chamar(metodo: 'POST' | 'PATCH' | 'DELETE', body: any) {
  erro.value = ''
  salvando.value = true
  try {
    await $fetch(`/api/admin/evento/${id}/promoters`, { method: metodo, body })
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
  aberto: false, id: '', nome: '', email: '', telefone: '',
  codigo: '', comissao: 0, ativo: true,
})
function abrir(p?: any) {
  Object.assign(form, {
    aberto: true,
    id: p?.id ?? '',
    nome: p?.nome ?? '',
    email: p?.email ?? '',
    telefone: p?.telefone ?? '',
    codigo: p?.codigo ?? '',
    comissao: p ? p.comissaoBps / 100 : 0,
    ativo: p?.ativo ?? true,
  })
}
async function salvar() {
  const comum = {
    nome: form.nome,
    email: form.email || null,
    telefone: form.telefone || null,
    comissaoBps: Math.round(form.comissao * 100),
    ativo: form.ativo,
  }
  const ok = form.id
    ? await chamar('PATCH', { id: form.id, campos: comum })
    : await chamar('POST', { ...comum, codigo: form.codigo || null })
  if (ok) form.aberto = false
}

const confirmando = ref('')
async function apagar(pid: string) {
  if (confirmando.value !== pid) { confirmando.value = pid; return }
  confirmando.value = ''
  await chamar('DELETE', { id: pid })
}

const copiado = ref('')
async function copiarLink(p: any) {
  const url = `${window.location.origin}${p.link}`
  try {
    await navigator.clipboard.writeText(url)
    copiado.value = p.id
    setTimeout(() => { if (copiado.value === p.id) copiado.value = '' }, 2000)
  } catch { erro.value = 'O navegador bloqueou a cópia. Selecione o link à mão.' }
}

const totais = computed(() => {
  const l = data.value?.promoters ?? []
  return {
    faturado: l.reduce((s: number, p: any) => s + p.faturadoCents, 0),
    comissao: l.reduce((s: number, p: any) => s + p.comissaoCents, 0),
    ingressos: l.reduce((s: number, p: any) => s + p.ingressos, 0),
  }
})

useHead({ title: 'Promoters' })
</script>

<template>
  <div v-if="data">
    <div class="flex flex-wrap items-start justify-between gap-3 py-5">
      <div>
        <h1 class="titulo text-2xl font-semibold text-tinta">Promoters / Divulgadores</h1>
        <p class="mt-1 text-tinta-suave">
          Cada um com seu link. A venda que entra por ele fica atribuída e gera comissão sobre a face.
        </p>
      </div>
      <button type="button" class="btn-primario" @click="abrir()">
        <IconeMenu nome="mais" :tamanho="18" /> Cadastrar divulgador
      </button>
    </div>

    <AbasSecao :evento-id="id" />

    <p v-if="erro" class="mt-4 rounded-card border border-erro bg-erro-claro px-3 py-2 text-sm text-erro">
      {{ erro }}
    </p>

    <p v-if="!data.promoters.length" class="card mt-5 py-12 text-center text-tinta-suave">
      Nenhum divulgador cadastrado.
    </p>

    <div v-else class="card mt-5 overflow-x-auto p-0">
      <table class="w-full min-w-[920px] border-collapse text-sm">
        <thead>
          <tr class="border-b border-linha bg-fundo-cinza/60 text-left">
            <th class="titulo px-4 py-2 text-xs font-semibold uppercase tracking-wide text-tinta-rotulo">Divulgador</th>
            <th class="titulo px-3 py-2 text-xs font-semibold uppercase tracking-wide text-tinta-rotulo">Link</th>
            <th class="titulo px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-tinta-rotulo">Ingressos</th>
            <th class="titulo px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-tinta-rotulo">Faturado</th>
            <th class="titulo px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-tinta-rotulo">Comissão</th>
            <th class="titulo px-3 py-2 text-xs font-semibold uppercase tracking-wide text-tinta-rotulo">Situação</th>
            <th class="titulo px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-tinta-rotulo">Ações</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="p in data.promoters" :key="p.id" class="border-b border-linha last:border-0">
            <td class="px-4 py-3">
              <p class="font-medium text-tinta">{{ p.nome }}</p>
              <p class="text-xs text-tinta-fraca">
                {{ [p.email, p.telefone].filter(Boolean).join(' · ') || 'sem contato' }}
              </p>
            </td>
            <td class="px-3 py-3">
              <button type="button" class="flex items-center gap-2 text-acao hover:underline"
                      @click="copiarLink(p)">
                <span class="font-mono text-xs">{{ p.codigo }}</span>
                <IconeMenu :nome="copiado === p.id ? 'check' : 'copia'" :tamanho="14" />
              </button>
              <span v-if="copiado === p.id" class="text-xs text-ok">link copiado</span>
            </td>
            <td class="px-3 py-3 text-right tabular-nums text-tinta">
              {{ p.ingressos }}
              <span class="block text-xs text-tinta-fraca">{{ p.pedidos }} pedido(s)</span>
            </td>
            <td class="px-3 py-3 text-right">
              <span class="titulo font-semibold tabular-nums text-tinta">{{ reais(p.faturadoCents) }}</span>
            </td>
            <td class="px-3 py-3 text-right">
              <span class="tabular-nums" :class="p.comissaoCents ? 'text-alerta' : 'text-tinta-fraca'">
                {{ reais(p.comissaoCents) }}
              </span>
              <span class="block text-xs text-tinta-fraca">{{ (p.comissaoBps / 100).toFixed(1) }}%</span>
            </td>
            <td class="px-3 py-3">
              <span :class="p.ativo ? 'selo-ok' : 'selo-neutro'">{{ p.ativo ? 'ATIVO' : 'INATIVO' }}</span>
            </td>
            <td class="px-3 py-3">
              <div class="flex items-center justify-end gap-1">
                <button type="button" class="p-1 text-tinta-fraca hover:text-acao"
                        :title="p.ativo ? 'Desativar' : 'Ativar'"
                        @click="chamar('PATCH', { id: p.id, campos: { ativo: !p.ativo } })">
                  <IconeMenu :nome="p.ativo ? 'check' : 'fechar'" :tamanho="16" />
                </button>
                <button type="button" class="p-1 text-tinta-fraca hover:text-acao"
                        title="Editar" @click="abrir(p)">
                  <IconeMenu nome="lapis" :tamanho="16" />
                </button>
                <button type="button" class="p-1 disabled:opacity-30"
                        :class="confirmando === p.id ? 'text-erro' : 'text-tinta-fraca hover:text-erro'"
                        :disabled="!p.podeApagar"
                        :title="p.podeApagar
                          ? (confirmando === p.id ? 'Clique de novo para confirmar' : 'Apagar')
                          : 'Divulgador com venda: desative em vez de apagar'"
                        @click="apagar(p.id)">
                  <IconeMenu nome="lixo" :tamanho="16" />
                </button>
              </div>
            </td>
          </tr>
        </tbody>
        <tfoot>
          <tr class="border-t-2 border-linha-forte bg-fundo-cinza/60">
            <td class="px-4 py-3 font-semibold text-tinta" colspan="2">Total</td>
            <td class="px-3 py-3 text-right font-semibold tabular-nums text-tinta">{{ totais.ingressos }}</td>
            <td class="px-3 py-3 text-right font-semibold tabular-nums text-tinta">{{ reais(totais.faturado) }}</td>
            <td class="px-3 py-3 text-right font-semibold tabular-nums text-alerta">{{ reais(totais.comissao) }}</td>
            <td colspan="2" />
          </tr>
        </tfoot>
      </table>
    </div>

    <ModalLateral v-if="form.aberto" :titulo="form.id ? 'Editar divulgador' : 'Cadastrar divulgador'"
                  @fechar="form.aberto = false">
      <div class="grid gap-3">
        <div>
          <label class="rotulo">Nome</label>
          <input v-model="form.nome" class="campo" placeholder="Nome de quem divulga">
        </div>
        <div class="grid gap-3 sm:grid-cols-2">
          <div>
            <label class="rotulo">E-mail (opcional)</label>
            <input v-model="form.email" type="email" class="campo" placeholder="para mandar o link">
          </div>
          <div>
            <label class="rotulo">Telefone (opcional)</label>
            <input v-model="form.telefone" class="campo" placeholder="(73) 90000-0000">
          </div>
        </div>
        <div v-if="!form.id">
          <label class="rotulo">Código do link (opcional)</label>
          <input v-model="form.codigo" class="campo uppercase" placeholder="derivado do nome">
          <p class="mt-1 text-xs text-tinta-fraca">
            É o que vai no link. Depois de criado não muda — o link já está circulando.
          </p>
        </div>
        <p v-else class="rounded-card bg-fundo-cinza px-3 py-2 text-sm text-tinta-suave">
          Código: <strong class="text-tinta font-mono">{{ form.codigo }}</strong>
        </p>
        <div>
          <label class="rotulo">Comissão (%)</label>
          <input v-model.number="form.comissao" type="number" min="0" max="100" step="0.5"
                 class="campo tabular-nums">
          <p class="mt-1 text-xs text-tinta-fraca">
            Calculada sobre o valor de face, não sobre o total — a taxa de serviço não é
            receita da produção.
          </p>
        </div>
        <label class="flex items-center gap-2 text-sm text-tinta-corpo">
          <input v-model="form.ativo" type="checkbox"> Ativo
        </label>
      </div>
      <template #acoes>
        <button type="button" class="btn-secundario" @click="form.aberto = false">Cancelar</button>
        <button type="button" class="btn-primario" :disabled="salvando" @click="salvar">
          {{ form.id ? 'Salvar' : 'Cadastrar' }}
        </button>
      </template>
    </ModalLateral>
  </div>

  <p v-else-if="pending" class="card mt-6 text-tinta-suave">Carregando…</p>

  <div v-else class="card mt-6">
    <p class="rotulo-kpi text-erro">Não foi possível carregar os divulgadores</p>
    <p class="mt-1 text-sm text-tinta-suave">
      {{ (falha as any)?.data?.statusMessage || (falha as any)?.message || 'Erro desconhecido.' }}
    </p>
    <button type="button" class="btn-secundario mt-3" @click="refresh()">Tentar de novo</button>
  </div>
</template>
