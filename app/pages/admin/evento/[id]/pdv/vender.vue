<script setup lang="ts">
/**
 * Balcão — a tela de vender no guichê.
 *
 * É a única tela do painel usada com fila na frente, e isso muda todas as
 * decisões:
 *
 *  - alvo grande. O operador toca, não mira com o mouse;
 *  - o preço do balcão aparece no próprio botão do ingresso. Preço que só
 *    aparece no carrinho é preço que o operador fala errado pro cliente;
 *  - o troco é gigante e calculado enquanto se digita. É o número que o
 *    operador confere em voz alta, e errar 10 reais cinquenta vezes é o
 *    fechamento torto da noite;
 *  - depois de vender, a tela mostra os códigos e volta pro zero sozinha —
 *    carrinho que fica cheio é a venda do próximo cliente contaminada.
 */
definePageMeta({ layout: 'admin' })

const route = useRoute()
const id = route.params.id as string
const turnoId = computed(() => String(route.query.turno ?? ''))

const { data: cat } = await useFetch<any>(() => `/api/admin/evento/${id}/pdv/catalogo`)
const { data: turno, refresh: recarregarTurno } = await useFetch<any>(
  () => `/api/admin/evento/${id}/pdv/turno?turno=${turnoId.value}`,
  { immediate: !!turnoId.value, watch: [turnoId] })

const FORMA_NOME: Record<string, string> = {
  dinheiro: 'Dinheiro', debito: 'Débito', credito: 'Crédito', pix: 'Pix',
}

/** carrinho: chave = lote|tipo, pra o mesmo lote com tipos diferentes não somar junto */
const carrinho = ref<any[]>([])
const forma = ref('')

/**
 * O que o cliente entregou, em centavos INTEIROS, pela máscara do `CampoMoeda`.
 *
 * Era texto livre reinterpretado na hora de calcular o troco, e a
 * reinterpretação (`Number(texto.replace(/\./g, '').replace(',', '.')) * 100`)
 * apagava TODO ponto antes de converter: "8.15" digitado no teclado numérico
 * virava 815 reais em vez de 8 reais e 15. O troco gigante desta tela — o
 * número que o operador confere em voz alta com fila na frente — saía cem
 * vezes maior, e nada avisava.
 *
 * Com centavos inteiros na mão, os botões de nota e o "certo" viram soma de
 * inteiro: não existe mais ida e volta por texto pra perder centavo.
 */
const recebidoCents = ref(0)
const comprador = reactive({ nome: '', email: '', documento: '' })
const vendendo = ref(false)
const erro = ref('')
const recibo = ref<any>(null)

/**
 * Desfazer, no próprio recibo.
 *
 * O erro do balcão aparece em segundos — quantidade digitada errada, cliente
 * que desiste vendo o total, cartão passado na maquininha errada. Se o
 * desfazer só existisse na tela de conferência, o operador com fila na frente
 * "consertaria" no papel e o caixa fecharia torto.
 */
const cancelandoRecibo = ref(false)
const motivoCancelamento = ref('')
const enviandoCancelamento = ref(false)

async function cancelarVenda() {
  if (motivoCancelamento.value.trim().length < 3) {
    erro.value = 'Diga por que está cancelando — pelo menos 3 letras.'
    return
  }
  enviandoCancelamento.value = true; erro.value = ''
  try {
    const r: any = await $fetch(`/api/admin/evento/${id}/pdv/cancelamento`, {
      method: 'POST',
      body: { pedidoId: recibo.value.pedidoId, motivo: motivoCancelamento.value.trim() },
    })
    // o recibo continua na tela, agora marcado como cancelado: é o papel que
    // o operador mostra pro cliente que está do outro lado do balcão
    recibo.value = { ...recibo.value, cancelada: true, avisoCancelamento: r.aviso }
    cancelandoRecibo.value = false
    motivoCancelamento.value = ''
    await recarregarTurno()
  } catch (e: any) {
    erro.value = e?.data?.message ?? e?.statusMessage ?? 'Não deu pra cancelar a venda.'
  } finally { enviandoCancelamento.value = false }
}

function fecharRecibo() {
  recibo.value = null
  cancelandoRecibo.value = false
  motivoCancelamento.value = ''
  erro.value = ''
}

// `reais` e `dataHora` vêm de `app/composables/formato.ts`.
const totalCents = computed(() =>
  carrinho.value.reduce((s, i) => s + i.precoCents * i.quantidade, 0))

const trocoCents = computed(() =>
  forma.value === 'dinheiro' ? recebidoCents.value - totalCents.value : 0)

/** algum item do carrinho é meia que pede documento? então o campo vira obrigatório */
const exigeDocumento = computed(() => carrinho.value.some((i) => i.exigeDocumento))

const formasDoPonto = computed<string[]>(() => turno.value?.turno?.formas ?? [])

const podeVender = computed(() =>
  carrinho.value.length > 0
  && !!forma.value
  && (forma.value !== 'dinheiro' || recebidoCents.value >= totalCents.value)
  && (!exigeDocumento.value || comprador.documento.replace(/\D/g, '').length === 11)
  && turno.value?.turno?.status === 'aberto')

function chave(lote: any, tipo: any) { return `${lote.id}|${tipo?.id ?? ''}` }

function juntar(lote: any, tipo: any = null) {
  const k = chave(lote, tipo)
  const achou = carrinho.value.find((i) => i.chave === k)
  const teto = tipo ? Math.min(lote.disponivel, tipo.disponivel) : lote.disponivel
  if (achou) {
    if (achou.quantidade >= teto) { erro.value = `Só restam ${teto} de ${lote.nome}.`; return }
    achou.quantidade++
    return
  }
  carrinho.value.push({
    chave: k,
    lotId: lote.id,
    ticketTypeId: tipo?.id ?? null,
    nome: tipo ? `${lote.nome} — ${tipo.nome}` : lote.nome,
    setor: lote.setor,
    precoCents: tipo ? tipo.balcaoCents : lote.balcaoCents,
    exigeDocumento: !!tipo?.exigeDocumento,
    quantidade: 1,
    teto,
  })
}

function menos(i: any) {
  i.quantidade--
  if (i.quantidade <= 0) carrinho.value = carrinho.value.filter((x) => x.chave !== i.chave)
}

function limpar() {
  carrinho.value = []
  forma.value = ''
  recebidoCents.value = 0
  comprador.nome = ''; comprador.email = ''; comprador.documento = ''
  erro.value = ''
}

/** notas que o operador recebe de verdade — evita digitar com fila na frente */
const NOTAS = [500, 1000, 2000, 5000, 10000, 20000]
/** soma de inteiro: a nota entra no valor, não num texto que depois é relido */
function nota(c: number) { recebidoCents.value += c }

async function vender() {
  vendendo.value = true; erro.value = ''
  try {
    const doc = comprador.documento.replace(/\D/g, '')
    const r: any = await $fetch(`/api/admin/evento/${id}/pdv/venda`, {
      method: 'POST',
      body: {
        turnoId: turnoId.value,
        itens: carrinho.value.map((i) => ({
          lotId: i.lotId, ticketTypeId: i.ticketTypeId, quantidade: i.quantidade,
        })),
        forma: forma.value,
        recebidoCents: forma.value === 'dinheiro' ? recebidoCents.value : null,
        comprador: (comprador.nome || comprador.email || doc)
          ? {
              nome: comprador.nome.trim() || null,
              email: comprador.email.trim() || null,
              documento: doc || null,
            }
          : null,
      },
    })
    recibo.value = r
    limpar()
    await recarregarTurno()
  } catch (e: any) {
    erro.value = e?.data?.message ?? e?.statusMessage ?? 'Não deu pra registrar a venda.'
  } finally { vendendo.value = false }
}

function imprimir() { window.print() }
</script>

<template>
  <div>
    <div class="flex flex-wrap items-start justify-between gap-3 py-5">
      <div>
        <h1 class="titulo text-2xl font-semibold text-tinta">Balcão</h1>
        <p v-if="turno?.turno" class="mt-1 text-tinta-suave">
          {{ turno.turno.ponto }} · operador {{ turno.turno.operador }} ·
          vendeu {{ reais(turno.contagem.pedidos ? turno.contagem.dinheiroCents + turno.contagem.eletronicoCents : 0) }}
          neste turno
        </p>
        <p v-else class="mt-1 text-tinta-suave">Escolha um caixa aberto para vender.</p>
      </div>
      <div class="flex gap-2">
        <NuxtLink :to="`/admin/evento/${id}/pdv`" class="btn-secundario">Pontos de venda</NuxtLink>
        <NuxtLink v-if="turnoId" :to="`/admin/evento/${id}/pdv/caixa?turno=${turnoId}`"
                  class="btn-secundario">Conferir e fechar</NuxtLink>
      </div>
    </div>

    <AbasSecao :evento-id="id" />

    <p v-if="!turnoId" class="card mt-4 text-center text-tinta-suave">
      Nenhum caixa escolhido.
      <NuxtLink :to="`/admin/evento/${id}/pdv`" class="font-semibold text-acao underline">
        Abra um caixa
      </NuxtLink>
      para começar.
    </p>

    <p v-else-if="turno && turno.turno.status !== 'aberto'" class="faixa-erro mt-4">
      Este caixa já foi fechado em {{ dataHora(turno.turno.fechouEm) }}.
      Abra um novo caixa para vender.
    </p>

    <div v-else-if="turno" class="mt-4 grid gap-4 lg:grid-cols-[1fr_380px]">
      <!-- catálogo -->
      <section>
        <div v-for="setor in [...new Set(cat?.lotes.map((l: any) => l.setor))]" :key="setor as string"
             class="mb-4">
          <h2 class="rotulo-kpi mb-2">{{ setor }}</h2>
          <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <template v-for="l in cat.lotes.filter((x: any) => x.setor === setor)" :key="l.id">
              <!-- lote inteiro, quando não tem tipos -->
              <button v-if="!l.tipos.length" type="button"
                      class="card text-left transition-colors hover:border-acao hover:bg-acao-fraco"
                      :disabled="l.disponivel <= 0" @click="juntar(l)">
                <p class="titulo font-semibold text-tinta">{{ l.nome }}</p>
                <p class="numero-kpi mt-1">{{ reais(l.balcaoCents) }}</p>
                <p class="mt-1 text-xs text-tinta-fraca">{{ l.disponivel }} disponíveis</p>
              </button>
              <!-- um botão por tipo (inteira, meia…) -->
              <button v-for="t in l.tipos" :key="t.id" type="button"
                      class="card text-left transition-colors hover:border-acao hover:bg-acao-fraco"
                      :disabled="Math.min(l.disponivel, t.disponivel) <= 0" @click="juntar(l, t)">
                <p class="titulo font-semibold text-tinta">{{ l.nome }}</p>
                <p class="text-sm text-tinta-suave">{{ t.nome }}</p>
                <p class="numero-kpi mt-1">{{ reais(t.balcaoCents) }}</p>
                <p class="mt-1 text-xs text-tinta-fraca">
                  {{ Math.min(l.disponivel, t.disponivel) }} disponíveis
                  <span v-if="t.exigeDocumento" class="selo-alerta ml-1">pede documento</span>
                </p>
              </button>
            </template>
          </div>
        </div>

        <details v-if="cat?.bloqueados.length" class="card">
          <summary class="cursor-pointer text-sm font-semibold text-tinta">
            {{ cat.bloqueados.length }} ingresso(s) não vendem no balcão
          </summary>
          <ul class="mt-3 space-y-1 text-sm text-tinta-suave">
            <li v-for="b in cat.bloqueados" :key="b.id">
              <span class="font-semibold text-tinta">{{ b.setor }} — {{ b.nome }}:</span> {{ b.motivo }}
            </li>
          </ul>
        </details>
      </section>

      <!-- carrinho -->
      <aside class="card h-fit lg:sticky lg:top-4">
        <h2 class="rotulo-kpi">Venda</h2>

        <p v-if="erro" class="faixa-erro mt-3">{{ erro }}</p>

        <p v-if="!carrinho.length" class="mt-4 text-sm text-tinta-suave">
          Toque nos ingressos ao lado para montar a venda.
        </p>

        <ul v-else class="mt-3 space-y-2">
          <li v-for="i in carrinho" :key="i.chave"
              class="flex items-center gap-2 border-b border-linha pb-2">
            <div class="min-w-0 flex-1">
              <p class="truncate text-sm font-semibold text-tinta">{{ i.nome }}</p>
              <p class="text-xs text-tinta-fraca">{{ reais(i.precoCents) }} cada</p>
            </div>
            <div class="flex items-center gap-1">
              <button type="button" class="h-9 w-9 rounded-card border border-linha-forte text-lg font-semibold"
                      @click="menos(i)">−</button>
              <span class="w-8 text-center font-semibold tabular-nums">{{ i.quantidade }}</span>
              <button type="button" class="h-9 w-9 rounded-card border border-linha-forte text-lg font-semibold"
                      :disabled="i.quantidade >= i.teto"
                      @click="i.quantidade++">+</button>
            </div>
            <span class="w-20 text-right font-semibold tabular-nums">
              {{ reais(i.precoCents * i.quantidade) }}
            </span>
          </li>
        </ul>

        <div v-if="carrinho.length" class="mt-4 border-t border-linha pt-3">
          <div class="flex items-baseline justify-between">
            <span class="rotulo-kpi">Total</span>
            <span class="titulo text-3xl font-semibold text-tinta tabular-nums">{{ reais(totalCents) }}</span>
          </div>

          <label class="rotulo mt-4">Como pagou</label>
          <div class="grid grid-cols-2 gap-2">
            <button v-for="f in formasDoPonto" :key="f" type="button"
                    :class="forma === f ? 'chip-ativo' : 'chip'" @click="forma = f">
              {{ FORMA_NOME[f] ?? f }}
            </button>
          </div>

          <template v-if="forma === 'dinheiro'">
            <label for="recebido" class="rotulo mt-4">Recebeu quanto</label>
            <CampoMoeda id="recebido" v-model="recebidoCents" />
            <div class="mt-2 flex flex-wrap gap-1">
              <button v-for="n in NOTAS" :key="n" type="button"
                      class="chip px-3 py-1 text-sm" @click="nota(n)">+{{ reais(n) }}</button>
              <button type="button" class="chip px-3 py-1 text-sm"
                      @click="recebidoCents = totalCents">certo</button>
              <button type="button" class="chip px-3 py-1 text-sm"
                      @click="recebidoCents = 0">limpar</button>
            </div>
            <div class="mt-3 rounded-card p-3"
                 :class="trocoCents < 0 ? 'bg-erro-claro' : 'bg-ok-claro'">
              <p class="text-xs font-semibold uppercase"
                 :class="trocoCents < 0 ? 'text-erro' : 'text-ok'">
                {{ trocoCents < 0 ? 'Falta receber' : 'Troco' }}
              </p>
              <p class="titulo text-3xl font-semibold tabular-nums"
                 :class="trocoCents < 0 ? 'text-erro' : 'text-ok'">
                {{ reais(Math.abs(trocoCents)) }}
              </p>
            </div>
          </template>

          <p v-else-if="forma && forma !== 'dinheiro'" class="faixa-aviso mt-3">
            Confirme que o pagamento em {{ FORMA_NOME[forma] }} foi aprovado na maquininha
            <strong>antes</strong> de emitir. O sistema registra a venda como paga na hora.
          </p>

          <details class="mt-4" :open="exigeDocumento">
            <summary class="cursor-pointer text-sm font-semibold text-tinta">
              Dados do cliente
              <span v-if="exigeDocumento" class="selo-alerta ml-1">obrigatório na meia</span>
              <span v-else class="font-normal text-tinta-fraca">(opcional)</span>
            </summary>
            <div class="mt-2 space-y-2">
              <input v-model="comprador.nome" class="campo" placeholder="Nome">
              <input v-model="comprador.documento" class="campo" inputmode="numeric"
                     placeholder="CPF (só números)">
              <input v-model="comprador.email" type="email" class="campo"
                     placeholder="E-mail (para reenviar o ingresso)">
            </div>
          </details>

          <div class="mt-4 flex gap-2">
            <button type="button" class="btn-secundario" @click="limpar">Limpar</button>
            <button type="button" class="btn-primario flex-1 py-3 text-lg"
                    :disabled="!podeVender || vendendo" @click="vender">
              {{ vendendo ? 'Registrando…' : `Vender ${reais(totalCents)}` }}
            </button>
          </div>
        </div>
      </aside>
    </div>

    <!-- recibo -->
    <div v-if="recibo" class="fixed inset-0 z-50 flex items-center justify-center bg-tinta/40 p-4"
         @click.self="fecharRecibo">
      <div class="max-h-full w-full max-w-md overflow-auto rounded-card bg-fundo-card p-5">
        <p :class="recibo.cancelada ? 'selo-erro' : 'selo-ok'">
          {{ recibo.cancelada ? 'Venda cancelada' : 'Venda registrada' }}
        </p>
        <h2 class="titulo mt-2 text-xl font-semibold text-tinta">Pedido {{ recibo.pedido }}</h2>

        <p v-if="erro" class="faixa-erro mt-3">{{ erro }}</p>

        <div v-if="recibo.cancelada" class="mt-3 rounded-card bg-alerta-claro p-3">
          <p class="text-xs font-semibold uppercase text-alerta">O que fazer agora</p>
          <p class="mt-1 text-sm text-tinta-corpo">{{ recibo.avisoCancelamento }}</p>
        </div>

        <dl class="mt-4 space-y-1 text-sm">
          <div class="flex justify-between">
            <dt class="text-tinta-suave">Total</dt>
            <dd class="font-semibold tabular-nums">{{ reais(recibo.totalCents) }}</dd>
          </div>
          <div class="flex justify-between">
            <dt class="text-tinta-suave">Forma</dt>
            <dd class="font-semibold">{{ FORMA_NOME[recibo.forma] ?? recibo.forma }}</dd>
          </div>
          <div v-if="recibo.trocoCents !== null" class="flex justify-between">
            <dt class="text-tinta-suave">Recebeu</dt>
            <dd class="font-semibold tabular-nums">{{ reais(recibo.recebidoCents) }}</dd>
          </div>
        </dl>

        <div v-if="recibo.trocoCents && !recibo.cancelada"
             class="mt-3 rounded-card bg-ok-claro p-3 text-center">
          <p class="text-xs font-semibold uppercase text-ok">Troco a devolver</p>
          <p class="titulo text-4xl font-semibold text-ok tabular-nums">{{ reais(recibo.trocoCents) }}</p>
        </div>

        <ul class="mt-4 space-y-1 border-t border-linha pt-3 text-sm">
          <li v-for="t in recibo.ingressos" :key="t.id" class="flex justify-between gap-2">
            <span class="truncate text-tinta-suave">{{ t.setor }} — {{ t.lote }}</span>
            <span class="font-semibold tabular-nums" :class="recibo.cancelada ? 'line-through text-tinta-fraca' : ''">
              {{ t.codigo }}
            </span>
          </li>
        </ul>

        <div class="mt-5 flex gap-2">
          <button v-if="!recibo.cancelada" type="button" class="btn-secundario flex-1"
                  @click="imprimir">Imprimir</button>
          <button type="button" class="btn-primario flex-1" @click="fecharRecibo">Próximo cliente</button>
        </div>

        <!-- desfazer: fica embaixo e discreto, mas na mesma tela em que o
             erro é percebido. O motivo é obrigatório porque é ele que sobra
             no rastro quando o gerente perguntar amanhã. -->
        <div v-if="!recibo.cancelada" class="mt-4 border-t border-linha pt-3">
          <button v-if="!cancelandoRecibo" type="button"
                  class="text-sm font-semibold text-erro underline"
                  @click="cancelandoRecibo = true">
            Cancelar esta venda
          </button>
          <template v-else>
            <label class="rotulo">Por que está cancelando?</label>
            <input v-model="motivoCancelamento" class="campo"
                   placeholder="Ex.: cliente desistiu no balcão">
            <p class="mt-2 text-xs text-tinta-corpo">
              Os {{ recibo.ingressos.length }} ingresso(s) deixam de valer na portaria e o
              valor sai da conferência deste caixa.
            </p>
            <div class="mt-3 flex gap-2">
              <button type="button" class="btn-secundario flex-1"
                      @click="cancelandoRecibo = false">Voltar</button>
              <button type="button" class="btn-erro flex-1" :disabled="enviandoCancelamento"
                      @click="cancelarVenda">
                {{ enviandoCancelamento ? 'Cancelando…' : `Cancelar ${reais(recibo.totalCents)}` }}
              </button>
            </div>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>
