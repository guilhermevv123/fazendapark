<script setup lang="ts">
/**
 * Pagar (055) — o atalho do fim do dia: encosta a pulseira → aparece o resumo de TUDO o que
 * o cliente consumiu (com dia e hora de cada pedido) e o total → marca como pagou na
 * maquininha → a conta fecha e a pulseira fica livre pra outro cliente.
 */
import { bip, useLeitorDePulseira } from '~/composables/comandaLeitor'
import { chamar, mensagemDoErro, sincronizar } from '~/composables/comandaOffline'
import { dataHora, reais } from '~/composables/formato'
import ComandaPagamento from '~/components/comanda/Pagamento.vue'

type Tela = 'ler' | 'resumo' | 'pagar' | 'pago'
const tela = ref<Tela>('ler')
const erro = ref('')
const aviso = ref('')
const dados = ref<any>(null)
const uid = ref('')
const aPagar = ref<any[]>([])
const troco = ref(0)

async function aoLer(lido: string) {
  if (tela.value === 'pagar') return
  erro.value = ''
  aviso.value = ''
  try {
    const r = await chamar<any>(`/api/comandas/pulseira/${encodeURIComponent(lido)}`)
    uid.value = lido
    if (r.tipo !== 'em_uso') {
      bip('erro')
      dados.value = null
      tela.value = 'ler'
      aviso.value = r.tipo === 'bloqueada' ? `Pulseira ${lido} está bloqueada.` : `A pulseira ${lido} não tem conta em aberto — nada a pagar.`
      return
    }
    dados.value = await chamar<any>(`/api/comandas/conta/${r.conta.id}`)
    bip('ok')
    tela.value = 'resumo'
  } catch (e) {
    bip('erro')
    erro.value = mensagemDoErro(e)
  }
}
useLeitorDePulseira(aoLer, computed(() => tela.value !== 'pagar'))

const conta = computed(() => dados.value?.conta)
const itens = computed(() => (dados.value?.itens ?? []).filter((i: any) => !i.cancelado))
const grupoAberto = computed(() => (dados.value?.grupo ?? []).filter((g: any) => g.id !== conta.value?.id && g.situacao === 'aberta' && g.faltaCents > 0))

function irPagar(junto = false) {
  const c = conta.value
  aPagar.value = [{ id: c.id, numero: c.numero, nome: c.nome, faltaCents: c.faltaCents },
    ...(junto ? grupoAberto.value.map((g: any) => ({ id: g.id, numero: g.numero, nome: g.nome, faltaCents: g.faltaCents })) : [])]
  tela.value = 'pagar'
}
async function fecharSemValor() {
  try {
    await chamar(`/api/comandas/conta/${conta.value.id}/pagar`, { method: 'POST', body: { pagamentos: [], fechar: true } })
    troco.value = 0
    tela.value = 'pago'
  } catch (e) { erro.value = mensagemDoErro(e) }
}
function pago(r: { trocoCents: number }) {
  bip('ok')
  troco.value = r.trocoCents
  tela.value = 'pago'
  sincronizar().catch(() => {})
}
function proximo() {
  dados.value = null
  aviso.value = ''
  tela.value = 'ler'
}
</script>

<template>
  <div class="mx-auto max-w-4xl space-y-4">
    <div>
      <h1 class="titulo text-2xl font-bold">Pagar</h1>
      <p class="text-sm text-ink-600">Encoste a pulseira para ver tudo o que o cliente consumiu e fechar a conta.</p>
    </div>
    <p v-if="erro" class="faixa-erro">{{ erro }}</p>

    <!-- LER -->
    <section v-if="tela === 'ler'" class="space-y-3">
      <div class="card flex flex-col items-center gap-3 p-12 text-center">
        <div class="flex h-24 w-24 animate-pulse items-center justify-center rounded-full bg-acao-claro text-acao">
          <svg viewBox="0 0 24 24" class="h-12 w-12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M6 8.3a6 6 0 010 7.4M9.5 6a10 10 0 010 12M13 3.8a14 14 0 010 16.4" /></svg>
        </div>
        <p class="titulo text-2xl font-bold">Encoste a pulseira do cliente</p>
      </div>
      <p v-if="aviso" class="faixa-aviso text-center text-base">{{ aviso }}</p>
    </section>

    <!-- RESUMO -->
    <section v-else-if="tela === 'resumo' && conta" class="space-y-4">
      <div class="card p-5">
        <div class="flex flex-wrap items-start justify-between gap-2">
          <div>
            <p class="text-sm font-semibold text-ink-600">Conta nº {{ conta.numero }} · pulseira {{ uid }}</p>
            <p class="titulo text-3xl font-bold">{{ conta.nome }}</p>
            <p v-if="conta.nome !== conta.responsavelNome" class="text-ink-700">grupo de <b>{{ conta.responsavelNome }}</b></p>
            <p class="text-sm text-ink-600">Aberta {{ dataHora(conta.abertaEm) }}</p>
          </div>
          <span v-if="conta.situacao !== 'aberta'" class="selo-alerta">{{ conta.situacao }}</span>
        </div>
      </div>

      <div class="card p-5">
        <p class="titulo-bloco">O que foi consumido</p>
        <ul class="mt-2 divide-y divide-linha">
          <li v-for="i in itens" :key="i.id" class="flex items-start justify-between gap-3 py-2.5">
            <div>
              <p class="font-semibold">{{ i.quantidade }}× {{ i.nome }}</p>
              <p class="text-xs text-ink-600">{{ dataHora(i.feitoEm) }}<span v-if="i.cliente"> · para {{ i.cliente }}</span><span v-if="i.mesa"> · {{ i.mesa }}</span><span v-if="i.ponto"> · {{ i.ponto }}</span></p>
            </div>
            <p class="titulo font-semibold tabular-nums">{{ reais(i.subtotalCents) }}</p>
          </li>
        </ul>
        <p v-if="!itens.length" class="py-3 text-sm text-ink-600">Nenhum consumo nesta conta.</p>
        <div class="mt-3 space-y-1 border-t border-linha pt-3">
          <p v-if="conta.descontoCents" class="flex justify-between text-ok"><span>Desconto</span><span>− {{ reais(conta.descontoCents) }}</span></p>
          <p v-if="conta.pagoCents" class="flex justify-between text-ink-700"><span>Já pago</span><span>− {{ reais(conta.pagoCents) }}</span></p>
          <p class="flex items-baseline justify-between"><span class="text-lg font-semibold">Total a pagar</span><span class="titulo text-4xl font-bold text-acao">{{ reais(conta.faltaCents) }}</span></p>
        </div>
      </div>

      <div v-if="grupoAberto.length" class="faixa-aviso">
        O grupo tem mais {{ grupoAberto.length }} conta(s) aberta(s): {{ grupoAberto.map((g: any) => `${g.nome} (${reais(g.faltaCents)})`).join(', ') }}.
      </div>

      <template v-if="conta.situacao === 'aberta'">
        <div v-if="!dados.pode.fechar" class="faixa-aviso">Para fechar, mande o cliente ao caixa.</div>
        <div v-else class="grid gap-3 sm:grid-cols-2">
          <button type="button" class="btn-secundario min-h-[64px] text-lg" @click="proximo">Voltar</button>
          <button v-if="conta.faltaCents > 0" type="button" data-acao="pagar" class="btn-primario min-h-[64px] text-xl" @click="irPagar(false)">Pagar {{ reais(conta.faltaCents) }}</button>
          <button v-else type="button" class="btn-primario min-h-[64px] text-lg" @click="fecharSemValor">Fechar conta (nada a pagar)</button>
          <button v-if="grupoAberto.length" type="button" class="btn-secundario min-h-[56px] sm:col-span-2" @click="irPagar(true)">Pagar o grupo todo junto</button>
        </div>
      </template>
      <button v-else type="button" class="btn-secundario min-h-[56px] w-full" @click="proximo">Voltar</button>
    </section>

    <!-- PAGAR -->
    <ComandaPagamento v-else-if="tela === 'pagar'" :contas="aPagar" @pago="pago" @voltar="tela = 'resumo'" />

    <!-- PAGO -->
    <section v-else-if="tela === 'pago'" class="space-y-4">
      <div class="card p-8 text-center">
        <div class="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-success-100 text-ok">
          <svg viewBox="0 0 24 24" class="h-10 w-10" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M20 6L9 17l-5-5" /></svg>
        </div>
        <p class="titulo mt-3 text-3xl font-bold">Conta paga</p>
        <p v-if="troco" class="titulo mt-2 text-4xl font-bold text-acao">Troco: {{ reais(troco) }}</p>
        <p class="mt-2 text-lg">Pulseira liberada — pode recolher e usar em outro cliente.</p>
      </div>
      <button type="button" class="btn-primario min-h-[64px] w-full text-xl" @click="proximo">Próximo cliente</button>
    </section>
  </div>
</template>
