<script setup lang="ts">
/**
 * Conferência de caixa.
 *
 * A decisão que manda nesta tela: **o valor esperado fica escondido até o
 * operador digitar o que contou.** Quem vê o alvo antes digita o alvo, e a
 * conferência vira cópia — o sistema passa a confirmar a si mesmo e a
 * diferença de caixa nunca mais aparece.
 *
 * Depois de fechar, tudo fica visível: o esperado, o contado e a diferença,
 * congelados. É o que o gerente lê no dia seguinte.
 */
definePageMeta({ layout: 'admin' })

const route = useRoute()
const id = route.params.id as string

const { data: lista, refresh: recarregarLista } = await useFetch<any>(
  () => `/api/admin/evento/${id}/pdv`)

const turnoId = ref(String(route.query.turno ?? ''))

/** o caixa aberto é o palpite certo quando ninguém escolheu nenhum */
watchEffect(() => {
  if (turnoId.value || !lista.value) return
  const aberto = lista.value.turnos.find((t: any) => t.status === 'aberto')
  if (aberto) turnoId.value = aberto.id
})

const { data, refresh } = await useFetch<any>(
  () => `/api/admin/evento/${id}/pdv/turno?turno=${turnoId.value}`,
  { immediate: false, watch: [turnoId] })

watch(turnoId, (v) => { if (v) refresh() }, { immediate: true })

/**
 * O que o operador contou, em centavos INTEIROS, pela máscara do `CampoMoeda`.
 *
 * Era texto livre reinterpretado no envio, e a reinterpretação tirava TODO
 * ponto antes de converter: quem contasse a gaveta e digitasse "500.00" no
 * teclado numérico mandava 50000 reais. A conferência acusava uma falta de
 * R$ 49.500,00 numa gaveta certinha — e a diferença de caixa é justamente o
 * número que esta tela existe pra dizer.
 *
 * `contou` separa "ainda não digitou nada" de "contou zero": sem ele o botão
 * de fechar ficava preso quando a gaveta realmente zerou.
 */
const contadoCents = ref(0)
const contou = ref(false)
const observacao = ref('')
const fechando = ref(false)
const erro = ref('')
const resultado = ref<any>(null)

/** a gaveta só revela o esperado depois que o operador se compromete */
const revelou = ref(false)

const mov = reactive({ tipo: 'sangria', valorCents: 0, motivo: '' })
const movendo = ref(false)

/**
 * Cancelamento: qual venda está com o formulário aberto, e o que o operador
 * precisa fazer depois de confirmar.
 *
 * O aviso fica na tela até ele fechar. É ali que aparece "devolva R$ 90,00" —
 * a única parte do cancelamento que acontece fora do sistema, e a que o caixa
 * cobra de volta no fim da noite se ninguém fizer.
 */
const cancelando = ref('')
const motivoCancelamento = ref('')
const enviandoCancelamento = ref(false)
const avisoCancelamento = ref('')

function abrirCancelamento(pedidoId: string) {
  cancelando.value = pedidoId
  motivoCancelamento.value = ''
  erro.value = ''
}

async function confirmarCancelamento(pedidoId: string) {
  if (motivoCancelamento.value.trim().length < 3) {
    erro.value = 'Diga por que está cancelando — pelo menos 3 letras.'
    return
  }
  enviandoCancelamento.value = true; erro.value = ''
  try {
    const r: any = await $fetch(`/api/admin/evento/${id}/pdv/cancelamento`, {
      method: 'POST',
      body: { pedidoId, motivo: motivoCancelamento.value.trim() },
    })
    avisoCancelamento.value = r.aviso
    cancelando.value = ''
    motivoCancelamento.value = ''
    await refresh()
  } catch (e: any) {
    erro.value = e?.data?.message ?? e?.statusMessage ?? 'Não deu pra cancelar a venda.'
  } finally { enviandoCancelamento.value = false }
}

// `reais` e `dataHora` vêm de `app/composables/formato.ts`.
const quando = dataHora
const FORMA_NOME: Record<string, string> = {
  dinheiro: 'Dinheiro', debito: 'Débito', credito: 'Crédito', pix: 'Pix',
}

const aberto = computed(() => data.value?.turno?.status === 'aberto')

async function registrarMovimento() {
  if (mov.valorCents <= 0) {
    erro.value = 'Diga quanto saiu ou entrou na gaveta antes de registrar.'
    return
  }
  movendo.value = true; erro.value = ''
  try {
    await $fetch(`/api/admin/evento/${id}/pdv/gaveta`, {
      method: 'POST',
      body: {
        turnoId: turnoId.value, tipo: mov.tipo,
        valorCents: mov.valorCents, motivo: mov.motivo.trim() || null,
      },
    })
    mov.valorCents = 0; mov.motivo = ''
    await refresh()
  } catch (e: any) { erro.value = e?.data?.message ?? e?.statusMessage ?? 'Não deu pra registrar.' }
  finally { movendo.value = false }
}

async function fechar() {
  fechando.value = true; erro.value = ''
  try {
    const r: any = await $fetch(`/api/admin/evento/${id}/pdv/turno`, {
      method: 'PATCH',
      body: {
        turnoId: turnoId.value,
        contadoCents: contadoCents.value,
        observacao: observacao.value.trim() || null,
      },
    })
    resultado.value = r
    revelou.value = true
    await Promise.all([refresh(), recarregarLista()])
  } catch (e: any) { erro.value = e?.data?.message ?? e?.statusMessage ?? 'Não deu pra fechar.' }
  finally { fechando.value = false }
}
</script>

<template>
  <div>
    <div class="flex flex-wrap items-start justify-between gap-3 py-5">
      <div>
        <h1 class="titulo text-2xl font-bold text-tinta">Conferência de caixa</h1>
        <p class="mt-1 text-tinta-suave">
          Conte o dinheiro da gaveta, digite o que contou, e o sistema mostra a diferença.
        </p>
      </div>
      <NuxtLink :to="`/admin/evento/${id}/pdv`" class="btn-secundario">Pontos de venda</NuxtLink>
    </div>

    <AbasSecao :evento-id="id" />

    <p v-if="erro" class="faixa-erro mt-4">{{ erro }}</p>

    <!-- o que fazer com o dinheiro depois de cancelar: fica até o operador
         fechar, porque é a parte que acontece fora do sistema -->
    <div v-if="avisoCancelamento"
         class="card mt-4 flex flex-wrap items-center justify-between gap-3 border-alerta bg-alerta-claro">
      <div>
        <p class="rotulo-kpi">Venda cancelada</p>
        <p class="mt-1 text-sm text-tinta-corpo">{{ avisoCancelamento }}</p>
      </div>
      <button type="button" class="btn-secundario" @click="avisoCancelamento = ''">Entendi</button>
    </div>

    <!-- escolher o caixa -->
    <section v-if="lista" class="card mt-4">
      <label class="rotulo">Qual caixa</label>
      <select v-model="turnoId" class="campo">
        <option value="">Escolha…</option>
        <option v-for="t in lista.turnos" :key="t.id" :value="t.id">
          {{ t.ponto }} — {{ t.operador }} — abriu {{ quando(t.abriuEm) }}
          {{ t.status === 'aberto' ? '(aberto)' : '(fechado)' }}
        </option>
      </select>
    </section>

    <p v-if="!turnoId" class="card mt-4 text-center text-tinta-suave">
      Escolha um caixa acima para conferir.
    </p>

    <div v-else-if="data" class="mt-4 grid gap-4 lg:grid-cols-[1fr_380px]">
      <!-- o extrato -->
      <section>
        <div class="card">
          <header class="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h2 class="titulo text-lg font-bold text-tinta">{{ data.turno.ponto }}</h2>
              <p class="text-sm text-tinta-suave">
                {{ data.turno.operador }} · abriu {{ quando(data.turno.abriuEm) }}
                <template v-if="data.turno.fechouEm"> · fechou {{ quando(data.turno.fechouEm) }}</template>
              </p>
            </div>
            <span :class="aberto ? 'selo-ok' : 'selo-neutro'">
              {{ aberto ? 'Aberto' : 'Fechado' }}
            </span>
          </header>

          <dl class="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <dt class="text-xs text-tinta-fraca">Fundo de troco</dt>
              <dd class="numero-kpi">{{ reais(data.contagem.aberturaCents) }}</dd>
            </div>
            <div>
              <dt class="text-xs text-tinta-fraca">Vendas em dinheiro</dt>
              <dd class="numero-kpi">{{ reais(data.contagem.dinheiroCents) }}</dd>
            </div>
            <div>
              <dt class="text-xs text-tinta-fraca">Cartão e pix</dt>
              <dd class="numero-kpi">{{ reais(data.contagem.eletronicoCents) }}</dd>
              <dd class="text-xs text-tinta-fraca">não está na gaveta</dd>
            </div>
            <div>
              <dt class="text-xs text-tinta-fraca">Ingressos emitidos</dt>
              <dd class="numero-kpi">{{ data.contagem.ingressos }}</dd>
              <dd class="text-xs text-tinta-fraca">{{ data.contagem.pedidos }} venda(s)</dd>
            </div>
          </dl>

          <div v-if="data.contagem.sangriaCents || data.contagem.suprimentoCents
                     || data.contagem.cancelamentos.length"
               class="mt-4 flex flex-wrap gap-4 border-t border-linha pt-3 text-sm">
            <span>Sangrias: <strong class="tabular-nums">−{{ reais(data.contagem.sangriaCents) }}</strong></span>
            <span>Suprimentos: <strong class="tabular-nums">+{{ reais(data.contagem.suprimentoCents) }}</strong></span>
            <span v-if="data.contagem.devolvidoDinheiroCents">
              Devolvido em cancelamento:
              <strong class="tabular-nums text-alerta">−{{ reais(data.contagem.devolvidoDinheiroCents) }}</strong>
              <span class="text-tinta-fraca"> (já fora das vendas acima)</span>
            </span>
            <span v-if="data.contagem.devolvidoEletronicoCents">
              Estornado em cartão/pix:
              <strong class="tabular-nums">−{{ reais(data.contagem.devolvidoEletronicoCents) }}</strong>
            </span>
          </div>
        </div>

        <!-- por forma -->
        <div v-if="data.contagem.porForma.length" class="card mt-4">
          <h3 class="rotulo-kpi">Por forma de pagamento</h3>
          <table class="mt-3 w-full text-sm">
            <tbody>
              <tr v-for="f in data.contagem.porForma" :key="f.forma" class="border-t border-linha">
                <td class="py-2">{{ FORMA_NOME[f.forma] ?? f.forma }}</td>
                <td class="py-2 text-right text-tinta-suave">{{ f.pedidos }} venda(s)</td>
                <td class="py-2 text-right font-bold tabular-nums">{{ reais(f.totalCents) }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- movimentos -->
        <div v-if="data.movimentos.length" class="card mt-4">
          <h3 class="rotulo-kpi">Entradas e saídas da gaveta</h3>
          <table class="mt-3 w-full text-sm">
            <tbody>
              <tr v-for="m in data.movimentos" :key="m.id" class="border-t border-linha">
                <td class="py-2">
                  <span :class="m.tipo === 'sangria' ? 'selo-alerta' : 'selo-ok'">
                    {{ m.tipo === 'sangria' ? 'Sangria' : 'Suprimento' }}
                  </span>
                </td>
                <td class="py-2 text-tinta-suave">{{ m.motivo || '—' }}</td>
                <td class="py-2 text-xs text-tinta-fraca tabular-nums">{{ quando(m.em) }} · {{ m.por }}</td>
                <td class="py-2 text-right font-bold tabular-nums">
                  {{ m.tipo === 'sangria' ? '−' : '+' }}{{ reais(m.valorCents) }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- vendas -->
        <div v-if="data.vendas.length" class="card mt-4 overflow-hidden p-0">
          <header class="border-b border-linha p-4">
            <h3 class="rotulo-kpi">Vendas deste caixa</h3>
          </header>
          <div class="max-h-96 overflow-auto">
            <table class="w-full text-sm">
              <thead class="sticky top-0 bg-fundo-cinza text-left text-xs uppercase text-tinta-suave">
                <tr>
                  <th class="px-4 py-2">Pedido</th>
                  <th class="px-4 py-2">Cliente</th>
                  <th class="px-4 py-2">Forma</th>
                  <th class="px-4 py-2 text-right">Ingressos</th>
                  <th class="px-4 py-2 text-right">Total</th>
                  <th class="px-4 py-2 text-right">Troco</th>
                  <th v-if="aberto" class="px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                <template v-for="v in data.vendas" :key="v.id">
                  <tr class="border-t border-linha">
                    <td class="px-4 py-2 font-bold tabular-nums">{{ v.codigo }}</td>
                    <td class="px-4 py-2">{{ v.comprador }}</td>
                    <td class="px-4 py-2">{{ FORMA_NOME[v.forma] ?? v.forma }}</td>
                    <td class="px-4 py-2 text-right tabular-nums">{{ v.ingressos }}</td>
                    <td class="px-4 py-2 text-right font-bold tabular-nums">{{ reais(v.totalCents) }}</td>
                    <td class="px-4 py-2 text-right tabular-nums text-tinta-suave">
                      {{ v.trocoCents ? reais(v.trocoCents) : '—' }}
                    </td>
                    <td v-if="aberto" class="px-4 py-2 text-right">
                      <button type="button" class="text-sm font-bold text-erro underline"
                              @click="abrirCancelamento(v.id)">
                        Cancelar
                      </button>
                    </td>
                  </tr>
                  <!-- o motivo é obrigatório: é ele que vira o rastro -->
                  <tr v-if="cancelando === v.id" class="border-t border-linha bg-erro-claro">
                    <td colspan="7" class="px-4 py-3">
                      <label class="rotulo">Por que está cancelando a venda {{ v.codigo }}?</label>
                      <div class="flex flex-wrap items-center gap-2">
                        <input v-model="motivoCancelamento" class="campo flex-1"
                               placeholder="Ex.: operador digitou 3 em vez de 2">
                        <button type="button" class="btn-erro" :disabled="enviandoCancelamento"
                                @click="confirmarCancelamento(v.id)">
                          {{ enviandoCancelamento ? 'Cancelando…' : `Cancelar ${reais(v.totalCents)}` }}
                        </button>
                        <button type="button" class="btn-secundario" @click="cancelando = ''">
                          Voltar
                        </button>
                      </div>
                      <p class="mt-2 text-xs text-tinta-corpo">
                        Os {{ v.ingressos }} ingresso(s) desta venda deixam de valer na portaria.
                        Ingresso que já entrou no parque não deixa cancelar.
                      </p>
                    </td>
                  </tr>
                </template>
              </tbody>
            </table>
          </div>
        </div>

        <!-- cancelamentos -->
        <div v-if="data.contagem.cancelamentos.length" class="card mt-4">
          <h3 class="rotulo-kpi">Vendas canceladas neste caixa</h3>
          <p class="mt-1 text-xs text-tinta-fraca">
            O valor já saiu das vendas acima. Em dinheiro, saiu também da gaveta —
            por isso o esperado do fechamento não desconta de novo.
          </p>
          <table class="mt-3 w-full text-sm">
            <tbody>
              <tr v-for="k in data.contagem.cancelamentos" :key="k.id" class="border-t border-linha">
                <td class="py-2 font-bold tabular-nums">{{ k.pedido }}</td>
                <td class="py-2">
                  <span :class="k.saiuDaGaveta ? 'selo-alerta' : 'selo-neutro'">
                    {{ k.saiuDaGaveta ? 'Saiu da gaveta' : 'Estorno' }}
                  </span>
                  <span v-if="k.estorno === 'falhou'" class="selo-erro ml-1">estorno não saiu</span>
                </td>
                <td class="py-2 text-tinta-suave">{{ k.motivo }}</td>
                <td class="py-2 text-xs text-tinta-fraca tabular-nums">
                  {{ quando(k.em) }} · {{ k.por ?? '—' }}
                </td>
                <td class="py-2 text-right font-bold tabular-nums">−{{ reais(k.totalCents) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- fechar -->
      <aside class="h-fit lg:sticky lg:top-4">
        <!-- gaveta, só com o caixa aberto -->
        <section v-if="aberto" class="card">
          <h2 class="rotulo-kpi">Mexer na gaveta</h2>
          <p class="mt-1 text-xs text-tinta-fraca">
            Registre antes de tirar ou pôr dinheiro. Sem isso, o caixa fecha com
            uma diferença do tamanho exato do que foi movido.
          </p>
          <div class="mt-3 grid grid-cols-2 gap-2">
            <button type="button" :class="mov.tipo === 'sangria' ? 'chip-ativo' : 'chip'"
                    @click="mov.tipo = 'sangria'">Sangria (sai)</button>
            <button type="button" :class="mov.tipo === 'suprimento' ? 'chip-ativo' : 'chip'"
                    @click="mov.tipo = 'suprimento'">Suprimento (entra)</button>
          </div>
          <label for="mov-valor" class="rotulo mt-2">Quanto</label>
          <CampoMoeda id="mov-valor" v-model="mov.valorCents" />
          <input v-model="mov.motivo" class="campo mt-2" placeholder="Motivo (recolhido pelo gerente)">
          <button type="button" class="btn-secundario mt-2 w-full" :disabled="movendo"
                  @click="registrarMovimento">
            {{ movendo ? 'Registrando…' : 'Registrar' }}
          </button>
        </section>

        <!-- a conferência -->
        <section v-if="aberto" class="card mt-4">
          <h2 class="rotulo-kpi">Fechar o caixa</h2>
          <p class="mt-1 text-xs text-tinta-fraca">
            Conte o dinheiro da gaveta agora e digite o total. O valor esperado
            aparece depois — conferir sabendo a resposta não confere nada.
          </p>

          <label for="contado" class="rotulo mt-4">Quanto tem na gaveta</label>
          <CampoMoeda id="contado" v-model="contadoCents" @input="contou = true" />

          <label class="rotulo mt-3">Observação</label>
          <textarea v-model="observacao" class="campo" rows="2"
                    placeholder="Ex.: faltou nota de 5, cliente pagou com nota rasgada" />

          <button type="button" class="btn-erro mt-4 w-full py-3"
                  :disabled="fechando || !contou" @click="fechar">
            {{ fechando ? 'Fechando…' : 'Conferir e fechar o caixa' }}
          </button>
        </section>

        <!-- resultado do fechamento -->
        <section v-if="resultado || (!aberto && data.turno.contadoCents !== null)" class="card mt-4">
          <h2 class="rotulo-kpi">Resultado da conferência</h2>
          <dl class="mt-3 space-y-2 text-sm">
            <div class="flex justify-between">
              <dt class="text-tinta-suave">O sistema esperava</dt>
              <dd class="font-bold tabular-nums">
                {{ reais(resultado?.contagem.esperadoCents ?? data.turno.esperadoNoFechamentoCents) }}
              </dd>
            </div>
            <div class="flex justify-between">
              <dt class="text-tinta-suave">O operador contou</dt>
              <dd class="font-bold tabular-nums">
                {{ reais(resultado?.contadoCents ?? data.turno.contadoCents) }}
              </dd>
            </div>
          </dl>
          <div class="mt-3 rounded-card p-4 text-center"
               :class="(resultado?.diferencaCents ?? (data.turno.contadoCents - data.turno.esperadoNoFechamentoCents)) === 0
                 ? 'bg-ok-claro'
                 : (resultado?.diferencaCents ?? (data.turno.contadoCents - data.turno.esperadoNoFechamentoCents)) > 0
                   ? 'bg-alerta-claro' : 'bg-erro-claro'">
            <p class="text-xs font-bold uppercase">
              {{ resultado?.situacao ?? (data.turno.contadoCents === data.turno.esperadoNoFechamentoCents
                ? 'bate' : data.turno.contadoCents > data.turno.esperadoNoFechamentoCents ? 'sobra' : 'falta') }}
            </p>
            <p class="titulo text-3xl font-bold tabular-nums">
              {{ reais(Math.abs(resultado?.diferencaCents
                ?? (data.turno.contadoCents - data.turno.esperadoNoFechamentoCents))) }}
            </p>
          </div>
          <p v-if="data.turno.observacao" class="mt-3 text-sm text-tinta-suave">
            “{{ data.turno.observacao }}”
          </p>
        </section>
      </aside>
    </div>
  </div>
</template>
