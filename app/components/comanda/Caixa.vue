<script setup lang="ts">
/**
 * O caixa (055) — a versão completa, pensada pro computador com o leitor USB.
 *
 * Encostou a pulseira (ou buscou por nome, telefone, número da conta ou da pulseira): abre a
 * conta inteira, com tudo o que dá pra corrigir, e o botão de fechar. Pulseira livre abre conta
 * nova. No fim do turno, "Fechar meu caixa" faz a conferência às cegas do dinheiro.
 */
import { bip, useLeitorDePulseira } from '~/composables/comandaLeitor'
import { chamar, estado, mensagemDoErro, sincronizar } from '~/composables/comandaOffline'
import { dataHora, reais } from '~/composables/formato'
import CampoMoeda from '~/components/CampoMoeda.vue'
import ComandaAbrirConta from '~/components/comanda/AbrirConta.vue'
import ComandaConta from '~/components/comanda/Conta.vue'
import ComandaPagamento from '~/components/comanda/Pagamento.vue'


/** dentro da Gestão: sem o título grande (a Gestão já diz onde você está) */
defineProps<{ embutido?: boolean }>()
const erro = ref('')
const contaId = ref<string | null>(null)
const abrirUid = ref<string | null>(null)
const aPagar = ref<any[] | null>(null)
const grupoAberto = ref<any[]>([])
const pago = ref<{ trocoCents: number } | null>(null)
const ruim = ref('')
const contaRef = ref<InstanceType<typeof ComandaConta> | null>(null)

function limpar() {
  contaId.value = null
  abrirUid.value = null
  aPagar.value = null
  pago.value = null
  ruim.value = ''
  erro.value = ''
}

async function aoLer(uid: string) {
  limpar()
  try {
    const r = await chamar<any>(`/api/comandas/pulseira/${encodeURIComponent(uid)}`)
    bip(['em_uso', 'livre', 'nao_cadastrada'].includes(r.tipo) ? 'ok' : 'erro')
    if (r.tipo === 'em_uso') contaId.value = r.conta.id
    else if (r.tipo === 'livre' || r.tipo === 'nao_cadastrada') abrirUid.value = uid
    else ruim.value = `Pulseira ${uid}: ${r.tipo === 'bloqueada' ? 'BLOQUEADA' : 'descartada'}${r.motivo ? ' — ' + r.motivo : ''}.`
  } catch (e) {
    bip('erro')
    erro.value = mensagemDoErro(e)
  }
}
useLeitorDePulseira(aoLer, computed(() => !aPagar.value))

/* ------------------------------------------------------------------ busca */

const busca = ref('')
const achadas = ref<any[]>([])
let espera: ReturnType<typeof setTimeout> | undefined
watch(busca, (t) => {
  clearTimeout(espera)
  if (t.trim().length < 2) { achadas.value = []; return }
  espera = setTimeout(async () => {
    try { achadas.value = (await chamar<any>('/api/comandas/gestao/contas', { query: { q: t.trim(), situacao: 'aberta' } })).contas } catch { achadas.value = [] }
  }, 300)
})
// a lista da esquerda: as contas abertas (da cópia que o tablet já tem), filtradas na hora
const abertas = computed(() => {
  const t = busca.value.trim().toLowerCase()
  const todas = estado.value?.contas ?? []
  if (!t) return todas
  return todas.filter((c) => c.nome.toLowerCase().includes(t) || c.responsavelNome.toLowerCase().includes(t)
    || String(c.numero) === t || (c.pulseira ?? '').includes(t))
})
const listaDaEsquerda = computed(() => {
  const ids = new Set(abertas.value.map((c) => c.id))
  return [...abertas.value, ...achadas.value.filter((c) => !ids.has(c.id))]
})
function abrirDaBusca(id: string) {
  limpar()
  contaId.value = id
}

/* ------------------------------------------------------------------ fechar */

function fechar(conta: any, grupo: any[]) {
  aPagar.value = [{ id: conta.id, numero: conta.numero, nome: conta.nome, faltaCents: conta.faltaCents }]
  grupoAberto.value = grupo.filter((g) => g.id !== conta.id && g.situacao === 'aberta' && g.faltaCents > 0)
}
async function fecharSemValor() {
  try {
    await chamar(`/api/comandas/conta/${aPagar.value![0].id}/pagar`, { method: 'POST', body: { pagamentos: [], fechar: true } })
    pago.value = { trocoCents: 0 }
    aPagar.value = null
  } catch (e) { erro.value = mensagemDoErro(e) }
}
function aoPagar(r: { trocoCents: number }) {
  bip('ok')
  pago.value = r
  aPagar.value = null
  contaRef.value?.carregar()
  sincronizar().catch(() => {})
}

/* ------------------------------------------------------------------ fechar meu caixa */

const meuCaixa = ref<any>(null)
const contado = ref(0)
const obs = ref('')
const fechamento = ref<any>(null)
async function verMeuCaixa() {
  limpar()
  fechamento.value = null
  contado.value = 0
  try { meuCaixa.value = await chamar<any>('/api/comandas/caixa') } catch (e) { erro.value = mensagemDoErro(e) }
}
async function fecharMeuCaixa() {
  try {
    fechamento.value = await chamar<any>('/api/comandas/caixa', { method: 'POST', body: { contadoCents: contado.value, observacao: obs.value } })
  } catch (e) { erro.value = mensagemDoErro(e) }
}
</script>

<template>
  <div class="space-y-4">
    <div class="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 v-if="!embutido" class="titulo text-2xl font-bold">Caixa</h1>
        <p class="text-sm text-ink-600">Encoste a pulseira no leitor ou escolha a conta na lista.</p>
      </div>
      <button type="button" class="btn-secundario" data-acao="fechar-meu-caixa" @click="verMeuCaixa">Fechar meu caixa</button>
    </div>

    <div class="grid gap-4 lg:grid-cols-[320px_1fr]">
      <aside class="space-y-3">
        <div class="card flex items-center gap-3 p-4">
          <span class="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-acao-claro text-acao">
            <svg viewBox="0 0 24 24" class="h-6 w-6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 8.3a6 6 0 010 7.4M9.5 6a10 10 0 010 12M13 3.8a14 14 0 010 16.4" /></svg>
          </span>
          <div>
            <p class="font-semibold">Leitor pronto</p>
            <p class="text-xs text-ink-600">Pulseira nova é cadastrada na primeira leitura.</p>
          </div>
        </div>

        <div class="card p-4">
          <label class="block">
            <span class="rotulo">Buscar</span>
            <input v-model="busca" class="campo" placeholder="Nome, telefone ou nº da conta">
          </label>
          <div class="mt-3 flex items-center justify-between text-xs font-bold uppercase tracking-wider text-ink-600">
            <span>Contas abertas</span><span>{{ estado?.contas.length ?? 0 }}</span>
          </div>
          <ul class="mt-2 max-h-[60vh] space-y-1.5 overflow-y-auto">
            <li v-for="c in listaDaEsquerda" :key="c.id">
              <button type="button" class="flex w-full items-center justify-between gap-2 rounded-card border px-3 py-2.5 text-left transition"
                      :class="contaId === c.id ? 'border-acao bg-acao-fraco' : 'border-linha hover:border-acao'" @click="abrirDaBusca(c.id)">
                <span class="min-w-0">
                  <span class="block truncate font-semibold">{{ c.nome }}</span>
                  <span class="block text-xs text-ink-600">Conta nº {{ c.numero }}<span v-if="c.pulseira"> · pulseira {{ c.pulseira }}</span></span>
                </span>
                <span class="titulo shrink-0 font-semibold tabular-nums">{{ reais(c.totalCents) }}</span>
              </button>
            </li>
          </ul>
          <p v-if="!listaDaEsquerda.length" class="mt-2 text-sm text-ink-600">{{ busca ? 'Nenhuma conta aberta encontrada.' : 'Nenhuma conta aberta agora.' }}</p>
        </div>
      </aside>

      <section class="min-w-0 space-y-4">
        <p v-if="erro" class="faixa-erro">{{ erro }}</p>
        <p v-if="ruim" class="faixa-erro">{{ ruim }}</p>

        <div v-if="pago" class="card p-6 text-center">
          <p class="titulo text-2xl font-bold text-ok">Conta paga ✓ — pulseira liberada</p>
          <p v-if="pago.trocoCents" class="titulo mt-1 text-3xl font-bold text-acao">Troco: {{ reais(pago.trocoCents) }}</p>
        </div>

        <template v-if="aPagar">
          <div v-if="grupoAberto.length" class="faixa-aviso flex flex-wrap items-center justify-between gap-2">
            <span>O grupo tem mais {{ grupoAberto.length }} conta(s) aberta(s): {{ grupoAberto.map((g) => `${g.nome} (${reais(g.faltaCents)})`).join(', ') }}.</span>
            <button type="button" class="btn-secundario" @click="aPagar = [...aPagar!, ...grupoAberto.map((g) => ({ id: g.id, numero: g.numero, nome: g.nome, faltaCents: g.faltaCents }))]; grupoAberto = []">Pagar tudo junto</button>
          </div>
          <div v-if="aPagar.length === 1 && aPagar[0].faltaCents <= 0" class="card space-y-3 p-6 text-center">
            <p class="titulo text-xl font-bold">Nada a pagar</p>
            <button type="button" class="btn-primario w-full" @click="fecharSemValor">Fechar conta e liberar pulseira</button>
          </div>
          <ComandaPagamento v-else :contas="aPagar" @pago="aoPagar" @voltar="aPagar = null" />
        </template>
        <ComandaConta v-else-if="contaId" :id="contaId" ref="contaRef" :itens-do-cardapio="estado?.itens" @fechar="fechar" />
        <ComandaAbrirConta v-else-if="abrirUid" :uid="abrirUid" :limite-padrao-cents="estado?.config.limitePadraoCents ?? 0"
                           :gerente="estado?.eu.nivel === 'gerente'" @aberta="(c) => { abrirUid = null; contaId = c.id }" @voltar="limpar" />

        <div v-else-if="meuCaixa" class="card space-y-4 p-5">
          <p class="titulo-bloco">Fechar meu caixa</p>
          <p class="text-sm text-ink-600">Desde {{ dataHora(meuCaixa.desde) }} · {{ meuCaixa.pagamentos }} pagamento(s) recebido(s) por você.</p>
          <div class="grid grid-cols-3 gap-3">
            <div class="rounded-card bg-fundo-cinza p-3"><p class="rotulo-kpi">Pix</p><p class="numero-kpi">{{ reais(meuCaixa.pixCents) }}</p></div>
            <div class="rounded-card bg-fundo-cinza p-3"><p class="rotulo-kpi">Débito</p><p class="numero-kpi">{{ reais(meuCaixa.debitoCents) }}</p></div>
            <div class="rounded-card bg-fundo-cinza p-3"><p class="rotulo-kpi">Crédito</p><p class="numero-kpi">{{ reais(meuCaixa.creditoCents) }}</p></div>
          </div>
          <p class="text-sm text-ink-700">Confira esses três valores com o relatório da maquininha.</p>
          <template v-if="!fechamento">
            <label class="block"><span class="rotulo">Conte o DINHEIRO da gaveta e digite ({{ meuCaixa.pagamentosEmDinheiro }} pagamento(s) em dinheiro)</span><CampoMoeda v-model="contado" /></label>
            <input v-model="obs" class="campo" placeholder="Observação (opcional)">
            <div class="flex gap-2">
              <button type="button" class="btn-secundario" @click="meuCaixa = null">Voltar</button>
              <button type="button" class="btn-primario" @click="fecharMeuCaixa">Fechar caixa</button>
            </div>
          </template>
          <div v-else class="rounded-card bg-fundo-cinza p-4">
            <p>Contado: <b>{{ reais(fechamento.contadoCents) }}</b> · Esperado: <b>{{ reais(fechamento.esperadoCents) }}</b></p>
            <p class="titulo mt-1 text-xl font-bold" :class="fechamento.diferencaCents === 0 ? 'text-ok' : 'text-erro'">
              {{ fechamento.diferencaCents === 0 ? 'Bateu certinho ✓' : fechamento.diferencaCents > 0 ? `Sobrou ${reais(fechamento.diferencaCents)}` : `Faltou ${reais(-fechamento.diferencaCents)}` }}
            </p>
          </div>
        </div>

        <div v-else-if="!pago" class="card flex flex-col items-center gap-3 p-12 text-center">
          <span class="flex h-16 w-16 items-center justify-center rounded-full bg-acao-claro text-acao">
            <svg viewBox="0 0 24 24" class="h-8 w-8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 8.3a6 6 0 010 7.4M9.5 6a10 10 0 010 12M13 3.8a14 14 0 010 16.4" /></svg>
          </span>
          <p class="titulo text-xl font-semibold">Encoste a pulseira do cliente</p>
          <p class="max-w-sm text-sm text-ink-600">A conta abre aqui com tudo o que ele consumiu, com dia e hora. Para fechar, marque como ele pagou na maquininha — a pulseira é liberada na hora.</p>
        </div>
      </section>
    </div>
  </div>
</template>
