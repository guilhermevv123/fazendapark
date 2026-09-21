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
const recebido = ref('')
const comprador = reactive({ nome: '', email: '', documento: '' })
const vendendo = ref(false)
const erro = ref('')
const recibo = ref<any>(null)

const reais = (c: number) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })

const totalCents = computed(() =>
  carrinho.value.reduce((s, i) => s + i.precoCents * i.quantidade, 0))

const recebidoCents = computed(() =>
  Math.round(Number(String(recebido.value).replace(/\./g, '').replace(',', '.') || 0) * 100))

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
  recebido.value = ''
  comprador.nome = ''; comprador.email = ''; comprador.documento = ''
  erro.value = ''
}

/** notas que o operador recebe de verdade — evita digitar com fila na frente */
const NOTAS = [500, 1000, 2000, 5000, 10000, 20000]
function nota(c: number) {
  recebido.value = ((recebidoCents.value + c) / 100).toFixed(2).replace('.', ',')
}

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
        <h1 class="titulo text-2xl font-bold text-tinta">Balcão</h1>
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
      <NuxtLink :to="`/admin/evento/${id}/pdv`" class="font-bold text-acao underline">
        Abra um caixa
      </NuxtLink>
      para começar.
    </p>

    <p v-else-if="turno && turno.turno.status !== 'aberto'" class="faixa-erro mt-4">
      Este caixa já foi fechado em {{ new Date(turno.turno.fechouEm).toLocaleString('pt-BR') }}.
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
                <p class="titulo font-bold text-tinta">{{ l.nome }}</p>
                <p class="numero-kpi mt-1">{{ reais(l.balcaoCents) }}</p>
                <p class="mt-1 text-xs text-tinta-fraca">{{ l.disponivel }} disponíveis</p>
              </button>
              <!-- um botão por tipo (inteira, meia…) -->
              <button v-for="t in l.tipos" :key="t.id" type="button"
                      class="card text-left transition-colors hover:border-acao hover:bg-acao-fraco"
                      :disabled="Math.min(l.disponivel, t.disponivel) <= 0" @click="juntar(l, t)">
                <p class="titulo font-bold text-tinta">{{ l.nome }}</p>
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
          <summary class="cursor-pointer text-sm font-bold text-tinta">
            {{ cat.bloqueados.length }} ingresso(s) não vendem no balcão
          </summary>
          <ul class="mt-3 space-y-1 text-sm text-tinta-suave">
            <li v-for="b in cat.bloqueados" :key="b.id">
              <span class="font-bold text-tinta">{{ b.setor }} — {{ b.nome }}:</span> {{ b.motivo }}
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
              <p class="truncate text-sm font-bold text-tinta">{{ i.nome }}</p>
              <p class="text-xs text-tinta-fraca">{{ reais(i.precoCents) }} cada</p>
            </div>
            <div class="flex items-center gap-1">
              <button type="button" class="h-9 w-9 rounded-card border border-linha-forte text-lg font-bold"
                      @click="menos(i)">−</button>
              <span class="w-8 text-center font-bold tabular-nums">{{ i.quantidade }}</span>
              <button type="button" class="h-9 w-9 rounded-card border border-linha-forte text-lg font-bold"
                      :disabled="i.quantidade >= i.teto"
                      @click="i.quantidade++">+</button>
            </div>
            <span class="w-20 text-right font-bold tabular-nums">
              {{ reais(i.precoCents * i.quantidade) }}
            </span>
          </li>
        </ul>

        <div v-if="carrinho.length" class="mt-4 border-t border-linha pt-3">
          <div class="flex items-baseline justify-between">
            <span class="rotulo-kpi">Total</span>
            <span class="titulo text-3xl font-bold text-tinta tabular-nums">{{ reais(totalCents) }}</span>
          </div>

          <label class="rotulo mt-4">Como pagou</label>
          <div class="grid grid-cols-2 gap-2">
            <button v-for="f in formasDoPonto" :key="f" type="button"
                    :class="forma === f ? 'chip-ativo' : 'chip'" @click="forma = f">
              {{ FORMA_NOME[f] ?? f }}
            </button>
          </div>

          <template v-if="forma === 'dinheiro'">
            <label class="rotulo mt-4">Recebeu quanto</label>
            <input v-model="recebido" class="campo text-xl tabular-nums" inputmode="decimal"
                   placeholder="0,00">
            <div class="mt-2 flex flex-wrap gap-1">
              <button v-for="n in NOTAS" :key="n" type="button"
                      class="chip px-3 py-1 text-sm" @click="nota(n)">+{{ reais(n) }}</button>
              <button type="button" class="chip px-3 py-1 text-sm"
                      @click="recebido = (totalCents / 100).toFixed(2).replace('.', ',')">certo</button>
              <button type="button" class="chip px-3 py-1 text-sm" @click="recebido = ''">limpar</button>
            </div>
            <div class="mt-3 rounded-card p-3"
                 :class="trocoCents < 0 ? 'bg-erro-claro' : 'bg-ok-claro'">
              <p class="text-xs font-bold uppercase"
                 :class="trocoCents < 0 ? 'text-erro' : 'text-ok'">
                {{ trocoCents < 0 ? 'Falta receber' : 'Troco' }}
              </p>
              <p class="titulo text-3xl font-bold tabular-nums"
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
            <summary class="cursor-pointer text-sm font-bold text-tinta">
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
         @click.self="recibo = null">
      <div class="w-full max-w-md rounded-card bg-fundo-card p-5">
        <p class="selo-ok">Venda registrada</p>
        <h2 class="titulo mt-2 text-xl font-bold text-tinta">Pedido {{ recibo.pedido }}</h2>

        <dl class="mt-4 space-y-1 text-sm">
          <div class="flex justify-between">
            <dt class="text-tinta-suave">Total</dt>
            <dd class="font-bold tabular-nums">{{ reais(recibo.totalCents) }}</dd>
          </div>
          <div class="flex justify-between">
            <dt class="text-tinta-suave">Forma</dt>
            <dd class="font-bold">{{ FORMA_NOME[recibo.forma] ?? recibo.forma }}</dd>
          </div>
          <div v-if="recibo.trocoCents !== null" class="flex justify-between">
            <dt class="text-tinta-suave">Recebeu</dt>
            <dd class="font-bold tabular-nums">{{ reais(recibo.recebidoCents) }}</dd>
          </div>
        </dl>

        <div v-if="recibo.trocoCents" class="mt-3 rounded-card bg-ok-claro p-3 text-center">
          <p class="text-xs font-bold uppercase text-ok">Troco a devolver</p>
          <p class="titulo text-4xl font-bold text-ok tabular-nums">{{ reais(recibo.trocoCents) }}</p>
        </div>

        <ul class="mt-4 space-y-1 border-t border-linha pt-3 text-sm">
          <li v-for="t in recibo.ingressos" :key="t.id" class="flex justify-between gap-2">
            <span class="truncate text-tinta-suave">{{ t.setor }} — {{ t.lote }}</span>
            <span class="font-bold tabular-nums">{{ t.codigo }}</span>
          </li>
        </ul>

        <div class="mt-5 flex gap-2">
          <button type="button" class="btn-secundario flex-1" @click="imprimir">Imprimir</button>
          <button type="button" class="btn-primario flex-1" @click="recibo = null">Próximo cliente</button>
        </div>
      </div>
    </div>
  </div>
</template>
