<script setup lang="ts">
/**
 * Financeiro › Transferências.
 *
 * As quatro caixas respondem, nesta ordem, as quatro perguntas do produtor:
 * o que é meu, o que ainda não posso sacar (e até quando), o que já saiu, e o
 * que dá pra sacar agora.
 *
 * A segunda caixa é a que existe em todo painel e some em quase todos: "valor
 * retido" sem "liberado em" é o que faz o produtor ligar. O dinheiro do
 * ingresso só libera depois que o evento acontece — antes disso, cancelar o
 * evento significa devolver tudo, e quem liberou antes devolve do próprio
 * bolso.
 */
definePageMeta({ layout: 'admin' })

const route = useRoute()
const id = route.params.id as string

const { data, refresh, pending, error: falha } = await useFetch<any>(
  `/api/admin/evento/${id}/financeiro`)

const reais = (c: number) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
const dataHora = (d: string) =>
  new Date(d).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })

const erro = ref('')
const salvando = ref(false)

/* --------------------------------------------------------------- filtros */
const busca = ref('')
const filtroStatus = ref('')
const filtroDestino = ref('')

const lista = computed(() => {
  let l = data.value?.transferencias ?? []
  const b = busca.value.trim().toLowerCase()
  if (b) l = l.filter((t: any) =>
    t.beneficiario.toLowerCase().includes(b) ||
    t.codigo.toLowerCase().includes(b) ||
    (t.pedidoPor ?? '').toLowerCase().includes(b))
  if (filtroStatus.value) l = l.filter((t: any) => t.status === filtroStatus.value)
  if (filtroDestino.value) l = l.filter((t: any) => t.destinoTipo === filtroDestino.value)
  return l
})

const SELO: Record<string, string> = {
  solicitada: 'selo-alerta', processando: 'selo-alerta',
  concluida: 'selo-ok', falhou: 'selo-erro', cancelada: 'selo-neutro',
}

/* ------------------------------------------------------------- nova saída */
const form = reactive({
  aberto: false, beneficiario: '', documento: '',
  destinoTipo: 'pix' as 'pix' | 'conta', destino: '',
  valorCents: 0, observacao: '',
})
function abrir() {
  Object.assign(form, {
    aberto: true, beneficiario: '', documento: '', destinoTipo: 'pix',
    destino: '', valorCents: data.value?.resumo.disponivelCents ?? 0, observacao: '',
  })
}
async function pedir() {
  erro.value = ''
  salvando.value = true
  try {
    await $fetch(`/api/admin/evento/${id}/financeiro`, {
      method: 'POST',
      body: {
        beneficiario: form.beneficiario,
        documento: form.documento || null,
        destinoTipo: form.destinoTipo,
        destino: form.destino,
        valorCents: form.valorCents,
        observacao: form.observacao || null,
      },
    })
    await refresh()
    form.aberto = false
  } catch (e: any) {
    erro.value = e?.data?.statusMessage || 'Não foi possível pedir a transferência.'
  } finally {
    salvando.value = false
  }
}

/* ------------------------------------------------------------- exportação */
/**
 * CSV com `;` e BOM: é o que o Excel em português abre sem pedir assistente de
 * importação. Com vírgula e sem BOM, R$ 1.234,56 vira duas colunas e acento
 * vira caractere quebrado — e a pessoa refaz na mão.
 */
function exportar() {
  const cab = ['Código', 'Beneficiário', 'Documento', 'Pedido por', 'Data',
               'Valor', 'Destino', 'Tipo', 'Status']
  const linhas = lista.value.map((t: any) => [
    t.codigo, t.beneficiario, t.documento ?? '', t.pedidoPor ?? '',
    dataHora(t.pedidoEm), (t.valorCents / 100).toFixed(2).replace('.', ','),
    t.destino, t.destinoTipo, t.status,
  ])
  const csv = [cab, ...linhas]
    .map((l) => l.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(';'))
    .join('\r\n')
  const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = `transferencias-${id.slice(0, 8)}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

useHead({ title: 'Transferências' })
</script>

<template>
  <div v-if="data">
    <div class="flex flex-wrap items-start justify-between gap-3 py-5">
      <div>
        <h1 class="titulo text-2xl font-bold text-tinta">Transferências</h1>
        <p class="mt-1 text-tinta-suave">
          O dinheiro das vendas saindo para a conta da produção.
        </p>
      </div>
      <div class="flex gap-2">
        <button type="button" class="btn-secundario" @click="exportar">
          <IconeMenu nome="exportar" :tamanho="18" /> Exportar lista
        </button>
        <button type="button" class="btn-primario"
                :disabled="data.resumo.disponivelCents <= 0" @click="abrir">
          <IconeMenu nome="mais" :tamanho="18" /> Pedir transferência
        </button>
      </div>
    </div>

    <AbasSecao :evento-id="id" />

    <p v-if="erro" class="mt-4 rounded-card border border-erro bg-erro-claro px-3 py-2 text-sm text-erro">
      {{ erro }}
    </p>

    <!-- ========================================================== resumo -->
    <div class="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <div class="card">
        <p class="rotulo-kpi">Total líquido</p>
        <p class="numero-kpi mt-1">{{ reais(data.resumo.liquidoCents) }}</p>
        <p class="mt-1 text-xs text-tinta-fraca">
          face das vendas pagas, menos estorno — sem a taxa de serviço
        </p>
      </div>
      <div class="card" :class="data.resumo.retidoCents && 'border-alerta/50'">
        <p class="rotulo-kpi">Valor retido</p>
        <p class="numero-kpi mt-1" :class="data.resumo.retidoCents && 'text-alerta'">
          {{ reais(data.resumo.retidoCents) }}
        </p>
        <p class="mt-1 text-xs" :class="data.evento.liberado ? 'text-ok' : 'text-tinta-fraca'">
          <template v-if="data.evento.liberado">liberado desde {{ dataHora(data.evento.liberaEm) }}</template>
          <template v-else>
            libera em {{ new Date(data.evento.liberaEm).toLocaleDateString('pt-BR') }}
            ({{ data.evento.diasDeRetencao }} dias após o fim do evento)
          </template>
        </p>
      </div>
      <div class="card">
        <p class="rotulo-kpi">Transferido</p>
        <p class="numero-kpi mt-1">{{ reais(data.resumo.transferidoCents) }}</p>
        <p class="mt-1 text-xs text-tinta-fraca">
          {{ data.resumo.transferencias }} transferência(s)
          <template v-if="data.resumo.emCursoCents">
            · {{ reais(data.resumo.emCursoCents) }} em curso
          </template>
        </p>
      </div>
      <div class="card" :class="data.resumo.disponivelCents > 0 && 'border-ok/50'">
        <p class="rotulo-kpi">Disponível para transferir</p>
        <p class="numero-kpi mt-1" :class="data.resumo.disponivelCents > 0 && 'text-ok'">
          {{ reais(data.resumo.disponivelCents) }}
        </p>
        <p class="mt-1 text-xs text-tinta-fraca">
          já descontado o que está solicitado
        </p>
      </div>
    </div>

    <!-- ========================================================= filtros -->
    <div class="card mt-4 flex flex-wrap items-end gap-3">
      <div class="min-w-[220px] flex-1">
        <label for="q" class="rotulo">Buscar</label>
        <input id="q" v-model="busca" class="campo" placeholder="beneficiário, código ou quem pediu">
      </div>
      <div>
        <label for="st" class="rotulo">Status</label>
        <select id="st" v-model="filtroStatus" class="campo">
          <option value="">Todos</option>
          <option value="solicitada">Solicitada</option>
          <option value="processando">Processando</option>
          <option value="concluida">Concluída</option>
          <option value="falhou">Falhou</option>
          <option value="cancelada">Cancelada</option>
        </select>
      </div>
      <div>
        <label for="dt" class="rotulo">Destino</label>
        <select id="dt" v-model="filtroDestino" class="campo">
          <option value="">Todos</option>
          <option value="pix">Pix</option>
          <option value="conta">Conta bancária</option>
        </select>
      </div>
      <p class="pb-2 text-sm text-tinta-suave">{{ lista.length }} resultado(s)</p>
    </div>

    <!-- ========================================================== tabela -->
    <p v-if="!lista.length" class="card mt-4 py-12 text-center text-tinta-suave">
      <template v-if="data.transferencias.length">Nenhuma transferência com esses filtros.</template>
      <template v-else>Nenhuma transferência ainda.</template>
    </p>

    <div v-else class="card mt-4 overflow-x-auto p-0">
      <table class="w-full min-w-[960px] border-collapse text-sm">
        <thead>
          <tr class="border-b border-linha bg-fundo-cinza/60 text-left">
            <th class="titulo px-4 py-2 text-xs font-bold uppercase tracking-wide text-tinta-rotulo">Beneficiário</th>
            <th class="titulo px-3 py-2 text-xs font-bold uppercase tracking-wide text-tinta-rotulo">Pedido feito por</th>
            <th class="titulo px-3 py-2 text-xs font-bold uppercase tracking-wide text-tinta-rotulo">Data</th>
            <th class="titulo px-3 py-2 text-right text-xs font-bold uppercase tracking-wide text-tinta-rotulo">Valor</th>
            <th class="titulo px-3 py-2 text-xs font-bold uppercase tracking-wide text-tinta-rotulo">Destino</th>
            <th class="titulo px-3 py-2 text-xs font-bold uppercase tracking-wide text-tinta-rotulo">Status</th>
            <th class="titulo px-3 py-2 text-xs font-bold uppercase tracking-wide text-tinta-rotulo">Detalhes</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="t in lista" :key="t.id" class="border-b border-linha last:border-0">
            <td class="px-4 py-3">
              <p class="font-medium text-tinta">{{ t.beneficiario }}</p>
              <p class="font-mono text-xs text-tinta-fraca">{{ t.codigo }}</p>
            </td>
            <td class="px-3 py-3 text-tinta-suave">
              {{ t.pedidoPor ?? '—' }}
              <span v-if="t.pedidoPorEmail" class="block text-xs text-tinta-fraca">{{ t.pedidoPorEmail }}</span>
            </td>
            <td class="px-3 py-3 text-xs text-tinta-suave">
              {{ dataHora(t.pedidoEm) }}
              <span v-if="t.processadoEm" class="block text-tinta-fraca">
                processada {{ dataHora(t.processadoEm) }}
              </span>
            </td>
            <td class="px-3 py-3 text-right">
              <span class="titulo font-bold tabular-nums text-tinta">{{ reais(t.valorCents) }}</span>
              <span v-if="t.taxaCents" class="block text-xs tabular-nums text-tinta-fraca">
                taxa {{ reais(t.taxaCents) }}
              </span>
            </td>
            <td class="px-3 py-3">
              <span class="selo-neutro">{{ t.destinoTipo === 'pix' ? 'PIX' : 'CONTA' }}</span>
              <span class="block font-mono text-xs text-tinta-fraca">{{ t.destino }}</span>
            </td>
            <td class="px-3 py-3">
              <span :class="SELO[t.status] ?? 'selo-neutro'">{{ t.status.toUpperCase() }}</span>
            </td>
            <td class="px-3 py-3 text-xs text-tinta-suave">
              <p v-if="t.erro" class="text-erro">{{ t.erro }}</p>
              <p v-if="t.observacao">{{ t.observacao }}</p>
              <p v-if="t.idNoGateway" class="font-mono text-tinta-fraca">{{ t.idNoGateway }}</p>
              <p v-if="!t.erro && !t.observacao && !t.idNoGateway" class="text-tinta-fraca">—</p>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- ===================================================== pedir saída -->
    <ModalLateral v-if="form.aberto" titulo="Pedir transferência" @fechar="form.aberto = false">
      <p class="mb-3 rounded-card bg-acao-fraco px-3 py-2 text-sm text-tinta-suave">
        Disponível agora:
        <strong class="text-tinta">{{ reais(data.resumo.disponivelCents) }}</strong>
      </p>

      <div class="grid gap-3">
        <div>
          <label class="rotulo">Beneficiário</label>
          <input v-model="form.beneficiario" class="campo" placeholder="Nome de quem recebe">
        </div>
        <div>
          <label class="rotulo">CPF / CNPJ (opcional)</label>
          <input v-model="form.documento" class="campo" placeholder="só números">
        </div>
        <div>
          <label class="rotulo">Tipo de destino</label>
          <select v-model="form.destinoTipo" class="campo">
            <option value="pix">Chave Pix</option>
            <option value="conta">Conta bancária</option>
          </select>
        </div>
        <div>
          <label class="rotulo">{{ form.destinoTipo === 'pix' ? 'Chave Pix' : 'Banco, agência e conta' }}</label>
          <input v-model="form.destino" class="campo"
                 :placeholder="form.destinoTipo === 'pix' ? 'e-mail, CPF, telefone ou aleatória' : '001 / 1234 / 56789-0'">
        </div>
        <div>
          <label class="rotulo">Valor</label>
          <CampoMoeda v-model="form.valorCents" />
          <p v-if="form.valorCents > data.resumo.disponivelCents" class="mt-1 text-xs text-erro">
            Acima do disponível.
          </p>
        </div>
        <div>
          <label class="rotulo">Observação (opcional)</label>
          <textarea v-model="form.observacao" rows="2" class="campo"
                    placeholder="Repasse parcial, adiantamento…" />
        </div>
      </div>

      <p class="mt-3 text-xs text-tinta-fraca">
        O pedido fica registrado com o seu nome e é processado em seguida. Nada sai da conta
        neste clique.
      </p>

      <template #acoes>
        <button type="button" class="btn-secundario" @click="form.aberto = false">Cancelar</button>
        <button type="button" class="btn-primario"
                :disabled="salvando || !form.beneficiario || !form.destino
                  || form.valorCents <= 0 || form.valorCents > data.resumo.disponivelCents"
                @click="pedir">
          Pedir transferência
        </button>
      </template>
    </ModalLateral>
  </div>

  <p v-else-if="pending" class="card mt-6 text-tinta-suave">Carregando…</p>

  <div v-else class="card mt-6">
    <p class="rotulo-kpi text-erro">Não foi possível carregar o financeiro</p>
    <p class="mt-1 text-sm text-tinta-suave">
      {{ (falha as any)?.data?.statusMessage || (falha as any)?.message || 'Erro desconhecido.' }}
    </p>
    <button type="button" class="btn-secundario mt-3" @click="refresh()">Tentar de novo</button>
  </div>
</template>
