<script setup lang="ts">
/**
 * Checkout: identificação + pagamento.
 *
 * Fica numa página só de propósito. Cada passo extra de wizard derruba
 * conversão, e aqui só há dois blocos: quem é você, e como paga.
 */
const route = useRoute()
const slug = route.params.slug as string

const reais = (c: number) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })

const carrinho = ref<any>(null)
const etapa = ref<'dados' | 'pix' | 'pago'>('dados')
const erro = ref('')
const enviando = ref(false)
const pedido = ref<any>(null)
const copiado = ref(false)
const restante = ref(0)

const form = reactive({ nome: '', email: '', documento: '', telefone: '', cupom: '' })

onMounted(() => {
  const cru = sessionStorage.getItem('dt:carrinho')
  if (!cru) return navigateTo(`/e/${slug}`)
  const c = JSON.parse(cru)
  if (c.slug !== slug || !c.itens?.length) return navigateTo(`/e/${slug}`)
  carrinho.value = c
})

function mascaraCpf(v: string) {
  const d = v.replace(/\D/g, '').slice(0, 11)
  return d.replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})(\d)/, '$1.$2')
          .replace(/(\d{3})(\d{1,2})$/, '$1-$2')
}
function mascaraTel(v: string) {
  const d = v.replace(/\D/g, '').slice(0, 11)
  if (d.length <= 10) return d.replace(/(\d{2})(\d)/, '($1) $2').replace(/(\d{4})(\d)/, '$1-$2')
  return d.replace(/(\d{2})(\d)/, '($1) $2').replace(/(\d{5})(\d)/, '$1-$2')
}

async function pagar() {
  erro.value = ''
  enviando.value = true
  try {
    const r = await $fetch<any>('/api/checkout', {
      method: 'POST',
      body: {
        eventSlug: slug,
        itens: carrinho.value.itens,
        comprador: {
          nome: form.nome.trim(),
          email: form.email.trim(),
          documento: form.documento.replace(/\D/g, ''),
          telefone: form.telefone.replace(/\D/g, '') || undefined,
        },
        cupom: form.cupom.trim() || undefined,
        forma: 'pix',
      },
    })
    pedido.value = r
    sessionStorage.removeItem('dt:carrinho')
    if (r.status === 'pago') { etapa.value = 'pago'; return }
    etapa.value = 'pix'
    comecarContagem(r.expiraEm)
    vigiarPagamento(r.pedidoId)
  } catch (e: any) {
    // A mensagem do servidor é a útil ("Lote esgotado", "Cupom inválido").
    // Trocar por "erro ao processar" esconde justamente o que resolve.
    erro.value = e?.data?.statusMessage || e?.statusMessage || 'Não foi possível concluir. Tente de novo.'
  } finally {
    enviando.value = false
  }
}

let timerContagem: any, timerVigia: any
function comecarContagem(expiraEm: string) {
  const fim = new Date(expiraEm).getTime()
  const tick = () => { restante.value = Math.max(0, Math.floor((fim - Date.now()) / 1000)) }
  tick()
  timerContagem = setInterval(tick, 1000)
}
const relogio = computed(() => {
  const m = Math.floor(restante.value / 60), s = restante.value % 60
  return `${m}:${String(s).padStart(2, '0')}`
})

/**
 * Pergunta ao servidor se o PIX caiu. O webhook é quem manda; isto só olha.
 *
 * O catch NÃO é mudo de propósito. Um `catch {}` aqui já transformou um erro
 * 500 do servidor numa tela que fica girando pra sempre: o comprador pagou,
 * o ingresso foi emitido, e a página nunca mudou — sem nada no console, sem
 * teste vermelho, sem exceção. Falha de rede é normal e se resolve no próximo
 * tick; falha que se repete precisa aparecer pra alguém.
 */
function vigiarPagamento(id: string) {
  let seguidas = 0
  timerVigia = setInterval(async () => {
    try {
      const r = await $fetch<any>(`/api/pedido/${id}`)
      seguidas = 0
      if (r.status === 'pago') {
        etapa.value = 'pago'
        pedido.value = { ...pedido.value, ...r }
        clearInterval(timerVigia); clearInterval(timerContagem)
      } else if (['expirado', 'cancelado', 'falhou'].includes(r.status)) {
        erro.value = 'Este pedido expirou. Refaça a compra.'
        clearInterval(timerVigia); clearInterval(timerContagem)
      }
    } catch (e: any) {
      console.error('[pagamento] consulta do pedido falhou', e?.data ?? e)
      if (++seguidas >= 3) {
        erro.value = 'Não estamos conseguindo confirmar o pagamento automaticamente. '
          + 'Se você já pagou, guarde o número do pedido e atualize a página.'
      }
    }
  }, 4000)
}
onUnmounted(() => { clearInterval(timerVigia); clearInterval(timerContagem) })

async function copiarPix() {
  try {
    await navigator.clipboard.writeText(pedido.value.pagamento.pixPayload)
    copiado.value = true
    setTimeout(() => (copiado.value = false), 2500)
  } catch { /* sem permissão de área de transferência: o texto está na tela */ }
}

/** Só aparece com o gateway simulado (nunca em produção). */
async function simularPagamento() {
  await $fetch('/api/dev/pagar', { method: 'POST', body: { pedido: pedido.value.pedidoId } })
}

useHead({ title: 'Pagamento' })
</script>

<template>
  <div class="min-h-screen">
    <header class="bg-menu text-white">
      <div class="mx-auto flex max-w-2xl items-center gap-3 px-4 py-3">
        <NuxtLink :to="`/e/${slug}`" class="titulo text-lg font-black tracking-tight">
          diamond<span class="font-normal opacity-70">.tickets</span>
        </NuxtLink>
      </div>
    </header>

    <div class="mx-auto max-w-2xl px-4 py-6">
      <!-- ---------------------------------------------- dados do comprador -->
      <section v-if="etapa === 'dados'">
        <NuxtLink :to="`/e/${slug}`" class="text-sm text-acao hover:underline">← Voltar</NuxtLink>
        <h1 class="titulo mt-3 text-2xl font-bold text-tinta">Finalizar compra</h1>

        <div v-if="carrinho" class="card mt-4">
          <p class="rotulo-kpi">Resumo</p>
          <div class="mt-2 flex items-baseline justify-between">
            <span class="text-tinta-corpo">
              {{ carrinho.totais.n }} {{ carrinho.totais.n === 1 ? 'ingresso' : 'ingressos' }}
            </span>
            <span class="titulo text-2xl font-black tabular-nums text-tinta">
              {{ reais(carrinho.totais.total) }}
            </span>
          </div>
          <p v-if="carrinho.totais.taxa" class="mt-1 text-xs text-tinta-fraca">
            {{ reais(carrinho.totais.face) }} de ingressos + {{ reais(carrinho.totais.taxa) }} de taxa de serviço
          </p>
        </div>

        <form class="mt-5 space-y-4" @submit.prevent="pagar">
          <div>
            <label for="nome" class="rotulo">Nome completo</label>
            <input id="nome" v-model="form.nome" required minlength="3" autocomplete="name" class="campo">
          </div>
          <div>
            <label for="email" class="rotulo">E-mail</label>
            <input id="email" v-model="form.email" type="email" required autocomplete="email" class="campo">
            <p class="mt-1 text-xs text-tinta-fraca">É pra onde vão os ingressos.</p>
          </div>
          <div class="grid gap-4 sm:grid-cols-2">
            <div>
              <label for="cpf" class="rotulo">CPF</label>
              <input id="cpf" :value="form.documento" required inputmode="numeric" class="campo tabular-nums"
                     @input="form.documento = mascaraCpf(($event.target as HTMLInputElement).value)">
            </div>
            <div>
              <label for="tel" class="rotulo">Celular</label>
              <input id="tel" :value="form.telefone" inputmode="numeric" autocomplete="tel"
                     class="campo tabular-nums"
                     @input="form.telefone = mascaraTel(($event.target as HTMLInputElement).value)">
            </div>
          </div>
          <div>
            <label for="cupom" class="rotulo">Cupom (opcional)</label>
            <input id="cupom" v-model="form.cupom" class="campo uppercase">
          </div>

          <p v-if="erro" class="rounded-card border border-erro bg-erro-claro px-3 py-2 text-sm text-erro">
            {{ erro }}
          </p>

          <button type="submit" :disabled="enviando" class="btn-primario w-full py-3">
            {{ enviando ? 'Gerando cobrança…' : 'Pagar com PIX' }}
          </button>
        </form>
      </section>

      <!-- ------------------------------------------------------------ PIX -->
      <section v-else-if="etapa === 'pix'">
        <h1 class="titulo text-2xl font-bold text-tinta">Pague com PIX</h1>
        <p class="mt-1 text-tinta-suave">
          Pedido <span class="font-medium text-tinta">{{ pedido.pedido }}</span> ·
          <span class="font-medium tabular-nums text-tinta">{{ reais(pedido.totalCents) }}</span>
        </p>

        <div class="card mt-4 text-center">
          <img v-if="pedido.pagamento.pixQrBase64"
               :src="`data:image/png;base64,${pedido.pagamento.pixQrBase64}`"
               alt="QR Code do PIX" class="mx-auto h-56 w-56">
          <p v-else class="py-8 text-sm text-tinta-suave">
            O QR está sendo gerado. Use o código copia e cola abaixo.
          </p>

          <div v-if="pedido.pagamento.pixPayload" class="mt-4">
            <p class="break-all rounded-card bg-fundo-cinza p-3 text-left font-mono text-[11px] text-tinta-corpo">
              {{ pedido.pagamento.pixPayload }}
            </p>
            <button type="button" class="btn-secundario mt-3 w-full py-2.5" @click="copiarPix">
              {{ copiado ? 'Copiado!' : 'Copiar código PIX' }}
            </button>
          </div>

          <p v-if="restante > 0" class="mt-4 text-sm text-tinta-suave">
            Seus ingressos estão reservados por
            <span class="font-bold tabular-nums text-acao">{{ relogio }}</span>
          </p>
          <p v-else class="mt-4 text-sm font-medium text-erro">Tempo esgotado</p>
        </div>

        <p class="mt-3 text-center text-sm text-tinta-suave">
          Assim que o pagamento cair, esta tela muda sozinha.
        </p>
        <p v-if="erro" class="mt-3 rounded-card border border-erro bg-erro-claro px-3 py-2 text-sm text-erro">
          {{ erro }}
        </p>

        <!-- Só existe com o gateway de mentira; em produção nem é renderizado
             porque o checkout nunca devolve `simulado`. -->
        <div v-if="pedido.simulado" class="mt-6 rounded-card border border-dashed border-alerta bg-alerta-claro p-3 text-center">
          <p class="text-xs font-bold uppercase text-alerta">Ambiente de teste</p>
          <button type="button" class="btn-secundario mt-2" @click="simularPagamento">
            Simular PIX recebido
          </button>
        </div>
      </section>

      <!-- ----------------------------------------------------------- pago -->
      <section v-else>
        <div class="card border-ok/40 bg-ok-claro text-center">
          <span class="mx-auto mb-2 flex h-12 w-12 items-center justify-center rounded-full bg-ok text-white">
            <IconeMenu nome="check" :tamanho="26" />
          </span>
          <p class="text-xs font-bold uppercase tracking-wide text-ok">Pagamento confirmado</p>
          <h1 class="titulo mt-1 text-2xl font-bold text-tinta">Ingressos emitidos</h1>
          <p class="mt-2 text-tinta-corpo">
            Pedido <span class="font-medium">{{ pedido.pedido }}</span>.
            Enviamos tudo para <span class="font-medium">{{ form.email }}</span>.
          </p>
          <NuxtLink :to="`/ingressos/${pedido.pedido}`" class="btn-primario mt-5 px-6 py-3">
            Ver meus ingressos
          </NuxtLink>
        </div>
      </section>
    </div>
  </div>
</template>
