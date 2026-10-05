<script setup lang="ts">
/**
 * Os ingressos do comprador. Sem login: o código do pedido é a credencial.
 *
 * Um ingresso por bloco, QR grande, e o código legível embaixo — porque
 * quando a internet da portaria cai (e cai), o que salva a fila é o operador
 * conseguir digitar o código à mão.
 *
 * `reais` e `dataHora` vêm de `app/composables/formato.ts`. A cópia local que
 * existia aqui montava o `R$` com `toLocaleString('pt-BR', { style:
 * 'currency' })`, que separa o símbolo com espaço FINO (U+00A0): duas strings
 * idênticas na tela que não são iguais na comparação.
 */
import { dataNoFuso, falhaDaConsulta, situacaoDoPedido } from '~/composables/carrinhoDaVitrine'

const route = useRoute()
const code = String(route.params.code ?? '')

// B22: o código vai CODIFICADO. Cru, `/ingressos/..%2Fadmin%2Fclientes` virava
// `/api/pedido/../admin/clientes` no SSR — `/api/admin/clientes` com o cookie
// de quem abriu o link.
const { data, error, refresh } = await useFetch<any>(`/api/pedido/${encodeURIComponent(code)}`)

/**
 * B10: "Pedido não encontrado" só pro 404 — e aí a resposta é 404 de verdade
 * (`app/error.vue`). Com o banco fora do ar a página dizia que o pedido que a
 * pessoa PAGOU não existe.
 */
const falha = computed(() => falhaDaConsulta(error.value))
if (falha.value === 'nao_encontrado') {
  throw createError({ statusCode: 404, statusMessage: 'Pedido não encontrado', fatal: true })
}
const tentando = ref(false)
async function tentarDeNovo() {
  tentando.value = true
  try { await refresh() } finally { tentando.value = false }
}

/** B24: a data no fuso do EVENTO, não no do navegador de quem abriu. */
const quando = (v: any) => dataNoFuso(v, data.value?.fuso)

/**
 * B01/B10: o selo, se os ingressos aparecem e o que dizer no lugar deles. Todo
 * status que não fosse 'pago' lia "ainda não foi pago" — inclusive o estorno
 * PARCIAL, cujos ingressos continuam valendo.
 */
const situacao = computed(() => situacaoDoPedido(data.value?.status, {
  estornadoCents: data.value?.estornadoCents, pagoSemIngresso: data.value?.pagoSemIngresso,
}))

const estado: Record<string, { t: string; c: string }> = {
  valido: { t: 'VÁLIDO', c: 'selo-ok' },
  usado: { t: 'JÁ UTILIZADO', c: 'selo-neutro' },
  cancelado: { t: 'CANCELADO', c: 'selo-erro' },
  transferido: { t: 'TRANSFERIDO', c: 'selo-neutro' },
}

/**
 * O que aparece no lugar do QR quando a API manda `qr: null`. A API só manda
 * QR de ingresso que ENTRA por este pedido: o cancelado não entra, e o
 * transferido é de outra pessoa agora (mostrar o QR dele aqui deixava o
 * remetente e o destinatário entrarem os dois).
 */
/*
 * Reagendar (dono, 30/09): só no ingresso que ainda ENTRA,
 * antes de o dia começar, e fora do convite da casa. Quem decide de verdade é
 * a rota (`server/utils/reagendamento.ts`); aqui é só não oferecer botão que
 * vai dar "não pode".
 */
const podeTrocar = (t: any) => t.status === 'valido' && !t.cortesia
  && !!data.value?.evento?.inicio && new Date(data.value.evento.inicio).getTime() > Date.now()

const SEM_QR: Record<string, string> = {
  cancelado: 'Ingresso cancelado',
  transferido: 'Ingresso transferido para outra pessoa',
  usado: 'Ingresso já utilizado',
}

/* ---------------------------------------------- quem é o dono da ficha --- */
/**
 * O convite não tem comprador — e "Comprador:" vazio é pior que nada.
 *
 * `cortesias.post.ts` grava o pedido SEM `customer_id`: quem recebe o convite
 * não preencheu formulário nenhum, o nome dele está no INGRESSO. Desde que a
 * rota parou de dar 404 nesse pedido, a ficha abre — e abria com o rótulo
 * "Comprador" em cima de nada. Medido no convite (1440×900): `textContent`
 * `""`, `offsetHeight` 0. Rótulo sem valor não é um detalhe de layout: quem lê
 * conclui que o sistema perdeu o dado dele, e liga pra bilheteria por causa
 * disso.
 *
 * Então a palavra muda com o que a linha é. Num convite quem importa é quem
 * RECEBEU; e se não houver nome em lugar nenhum (balcão sem cadastro, pedido
 * ainda não pago), o bloco inteiro some — ausência é ausência.
 */
const pessoa = computed<{ rotulo: string; nome: string } | null>(() => {
  const comprador = data.value?.comprador?.nome
  if (comprador) return { rotulo: 'Comprador', nome: comprador }
  const titular = data.value?.ingressos?.find((t: any) => t.titular)?.titular
  if (!titular) return null
  return { rotulo: data.value?.cortesia ? 'Convidado' : 'Titular', nome: titular }
})

/* ------------------------------------------- pedido ainda não pago ------- */
/**
 * Quem cai aqui com o pedido em aberto fechou a aba do pagamento (ou pagou por
 * outro aparelho). O que ele precisa é a MESMA coisa daquela tela: o
 * copia-e-cola, o prazo e a certeza de que a página se atualiza sozinha. Sem
 * isso, o caminho dele é ligar pra bilheteria.
 */
const copiado = ref(false)
const restante = ref(0)
/** o relógio já contou uma vez (no navegador): antes disso "0" não quer dizer vencido */
const relogioLigado = ref(false)
let timerContagem: any, timerVigia: any

/**
 * B20: o prazo venceu — a varredura cancela a cobrança no gateway, então o QR
 * e o copia-e-cola SOMEM (pagar um PIX cancelado é dinheiro que não chega).
 */
const prazoVencido = computed(() => relogioLigado.value && restante.value <= 0)
/** ainda pode mudar sozinho: a página segue consultando */
const emAberto = (status: any) => status === 'aguardando_pagamento' || status === 'em_analise'

const relogio = computed(() => {
  const m = Math.floor(restante.value / 60), s = restante.value % 60
  return `${m}:${String(s).padStart(2, '0')}`
})

async function copiarPix() {
  try {
    await navigator.clipboard.writeText(data.value.pagamento.pixPayload)
    copiado.value = true
    setTimeout(() => (copiado.value = false), 2500)
  } catch { /* sem permissão de área de transferência: o texto está na tela */ }
}

onMounted(() => {
  if (!emAberto(data.value?.status)) return

  // em análise o relógio da reserva não se aplica (o pedido não vence enquanto
  // a operadora analisa) — só a consulta segue
  if (data.value.status === 'aguardando_pagamento' && data.value.expiraEm) {
    const fim = new Date(data.value.expiraEm).getTime()
    const tick = () => { restante.value = Math.max(0, Math.floor((fim - Date.now()) / 1000)) }
    tick()
    relogioLigado.value = true
    timerContagem = setInterval(tick, 1000)
  }
  // O `catch` não é mudo: uma consulta que falha em silêncio aqui é a tela que
  // fica em "aguardando" pra sempre depois de o pagamento já ter caído.
  timerVigia = setInterval(async () => {
    try {
      await refresh()
      if (!emAberto(data.value?.status)) {
        clearInterval(timerVigia); clearInterval(timerContagem)
      }
    } catch (e: any) {
      console.error('[ingressos] não deu pra reconsultar o pedido', e?.data ?? e)
    }
  }, 6000)
})
onUnmounted(() => { clearInterval(timerVigia); clearInterval(timerContagem) })

useHead(() => ({ title: data.value ? `Pedido ${data.value.pedido}` : 'Meus ingressos' }))
</script>

<template>
  <div class="min-h-screen">
    <CabecalhoPublico largura="max-w-3xl">
      <button type="button"
              class="rounded-lg px-3 py-2 text-sm font-semibold text-ink-700 transition-colors hover:bg-ink-100 hover:text-ink-900"
              @click="refresh()">
        Atualizar
      </button>
    </CabecalhoPublico>

    <div class="mx-auto max-w-3xl px-4 py-6">
      <!-- B10: o 404 da primeira carga já saiu como página de erro (HTTP 404);
           aqui fica o que NÃO é "não existe" — e o "Atualizar" que voltou 404 -->
      <div v-if="falha" class="card py-10 text-center" role="alert">
        <template v-if="falha === 'nao_encontrado'">
          <p class="titulo text-xl font-semibold text-tinta">Pedido não encontrado</p>
          <p class="mt-2 text-tinta-suave">
            Confira o código do pedido: ele está no e-mail da compra e começa com PED-.
          </p>
        </template>
        <template v-else>
          <p class="titulo text-xl font-semibold text-tinta">A bilheteria não respondeu agora</p>
          <p class="mt-2 text-tinta-suave">
            {{ falha === 'freio'
                 ? 'Muitas consultas seguidas deste aparelho. Espere alguns minutos e tente de novo.'
                 : 'O seu pedido continua guardado — quem não respondeu foi o nosso sistema. Tente de novo em alguns instantes.' }}
          </p>
          <button type="button" class="btn-primario mt-6 px-5" :disabled="tentando" @click="tentarDeNovo">
            {{ tentando ? 'Tentando…' : 'Tentar de novo' }}
          </button>
        </template>
      </div>

      <template v-else-if="data">
        <h1 class="titulo text-2xl font-semibold text-tinta">{{ data.evento.nome }}</h1>
        <p class="mt-1 text-tinta-suave">
          {{ quando(data.evento.inicio) }}
          <template v-if="data.evento.local"> · {{ data.evento.local }}</template>
        </p>

        <div class="card mt-4 flex flex-wrap items-center gap-x-6 gap-y-2">
          <div>
            <p class="text-xs text-tinta-fraca">Pedido</p>
            <p class="font-medium tabular-nums text-tinta">{{ data.pedido }}</p>
          </div>
          <!-- "Comprador" só quando existe um; no convite o nome é o de quem
               RECEBEU, e sem nome nenhum o bloco não aparece. -->
          <div v-if="pessoa">
            <p class="text-xs text-tinta-fraca">{{ pessoa.rotulo }}</p>
            <p class="font-medium text-tinta">{{ pessoa.nome }}</p>
          </div>
          <div>
            <!-- "Total pago" só no que foi pago: no pendente, no expirado e no
                 recusado a palavra "pago" é mentira -->
            <p class="text-xs text-tinta-fraca">{{ data.cortesia ? 'Entrada' : situacao.rotuloDoTotal }}</p>
            <p class="font-medium tabular-nums text-tinta">
              {{ data.cortesia ? 'Cortesia' : reais(data.totalCents) }}
            </p>
          </div>
          <span class="ml-auto" :class="situacao.selo.classe">{{ situacao.selo.texto }}</span>
        </div>

        <!-- pedido sem a venda de pé: pendente, em análise, expirado, cancelado,
             recusado, devolvido, contestado — cada um dizendo o que houve (B10) -->
        <div v-if="!situacao.vivo" class="card mt-4">
          <!-- PIX pago depois do prazo e sem lugar: "ainda não foi pago" seria
               mentira pra quem pagou (ver `pagoSemIngresso` na API). -->
          <div v-if="data.pagoSemIngresso">
            <p class="font-semibold text-tinta">Recebemos o seu pagamento.</p>
            <p class="mt-1 text-tinta-corpo">
              Ele chegou depois do prazo da reserva e, nesse meio-tempo, os ingressos dessa opção
              foram vendidos. Você não precisa pagar de novo: a bilheteria vai resolver com você —
              outro ingresso ou a devolução do valor. Guarde o pedido
              <strong class="text-tinta">{{ data.pedido }}</strong>.
            </p>
          </div>
          <p v-else class="text-tinta-corpo">{{ situacao.frase }}</p>

          <!-- B20: o prazo venceu — o QR e o copia-e-cola somem -->
          <div v-if="data.status === 'aguardando_pagamento' && prazoVencido"
               class="mt-4 rounded-xl bg-fundo-cinza px-4 py-4 text-center">
            <p class="font-semibold text-tinta">O prazo deste pagamento venceu</p>
            <p class="mt-1 text-sm text-tinta-suave">
              A cobrança foi cancelada e não pode mais ser paga. Se você pagou nos últimos minutos,
              espere nesta página: a confirmação ainda pode chegar.
            </p>
          </div>

          <!-- B08: cartão pendente — a fatura do Asaas abre de qualquer aparelho -->
          <div v-else-if="data.status === 'aguardando_pagamento' && data.pagamento?.forma === 'credito'" class="mt-4">
            <a v-if="data.pagamento.linkFatura" :href="data.pagamento.linkFatura"
               target="_blank" rel="noopener" class="btn-cta w-full py-3">
              Pagar com cartão
            </a>
            <p v-else class="faixa-aviso">
              O link do cartão não está disponível. Guarde o pedido
              <strong class="text-tinta">{{ data.pedido }}</strong> e fale com a bilheteria — a reserva
              continua de pé até o prazo abaixo.
            </p>
            <p class="mt-3 text-center text-sm text-tinta-suave">
              O cartão é digitado no ambiente seguro do Asaas. Depois de pagar, volte para esta página:
              ela se atualiza sozinha.
            </p>
          </div>

          <div v-else-if="data.status === 'aguardando_pagamento'
                          && (data.pagamento?.pixQrBase64 || data.pagamento?.pixPayload)" class="mt-4">
            <img v-if="data.pagamento.pixQrBase64"
                 :src="`data:image/png;base64,${data.pagamento.pixQrBase64}`"
                 alt="QR Code do PIX" class="mx-auto h-52 w-52 max-w-full">
            <p v-if="data.pagamento.pixPayload"
               class="mt-3 break-all rounded-card bg-fundo-cinza p-3 text-left font-mono text-[11px] text-tinta-corpo">
              {{ data.pagamento.pixPayload }}
            </p>
            <button v-if="data.pagamento.pixPayload" type="button"
                    class="btn-secundario mt-3 w-full py-2.5" @click="copiarPix">
              {{ copiado ? 'Copiado!' : 'Copiar código PIX' }}
            </button>
            <p class="mt-3 text-center text-sm text-tinta-suave">
              Pague o PIX acima e espere aqui: a página se atualiza sozinha.
            </p>
          </div>

          <p v-if="data.status === 'aguardando_pagamento' && restante > 0"
             class="mt-3 text-center text-sm text-tinta-suave">
            Reserva garantida por <span class="font-semibold tabular-nums text-acao">{{ relogio }}</span>
          </p>
        </div>

        <!-- ingressos -->
        <section v-else class="mt-4 space-y-4">
          <!-- B01: estorno PARCIAL — quanto voltou, e os ingressos seguem valendo -->
          <p v-if="situacao.frase" class="faixa-aviso" role="status">{{ situacao.frase }}</p>
          <!--
            Onde mais o ingresso está. Quem paga online espera o e-mail em
            segundos; quando ele não aparece, a pessoa não sabe se o problema
            é a compra ou a caixa de entrada — e liga pra bilheteria
            perguntando se o pagamento passou. Dizer aqui pra onde foi, e que
            ESTE link vale sozinho, responde a ligação antes dela acontecer.

            O e-mail chega mascarado da API de propósito: o código do pedido é
            a credencial desta página, e quem chutar um código não descobre de
            quem ele é.

            NÃO diz "mandamos", diz "se não chegou". A diferença não é estilo:
            esta tela não sabe se o e-mail saiu. Ela lê `/api/pedido/:code`, que
            não consulta `email_sends` — então afirmar o envio seria afirmar o
            que não foi conferido, e está errado em três casos reais: pedido
            pago ANTES desta entrega existir (medido: 60 pedidos pagos neste
            banco, todos com e-mail no cadastro e ZERO linha na fila), envio que
            terminou em `falhou`, e pagamento com `paid_at` velho, que o gatilho
            da 018 ignora de propósito. Os três levam a pessoa a esta página
            justamente porque nada chegou — e ler "também mandamos" aqui é o
            sistema mentindo na cara de quem já está reclamando. Para afirmar,
            a rota precisa devolver o estado do envio.

            Fica DENTRO desta seção e não entre ela e o bloco de cima: `v-else`
            precisa ser irmão imediato do `v-if`, e um elemento no meio quebra
            a cadeia inteira — a tela do pedido não pago some sem erro nenhum.
          -->
          <p v-if="data.comprador.email" class="faixa-aviso print:hidden">
            Guarde este link: ele é o próprio ingresso e vale sozinho, sem depender de e-mail.
            Se a confirmação não chegou em
            <strong class="text-tinta">{{ data.comprador.email }}</strong>, procure por
            <strong class="text-tinta">Conquista Park</strong> no spam — ou peça o reenvio na
            bilheteria com o pedido <strong class="text-tinta">{{ data.pedido }}</strong>.
          </p>

          <!-- O ingresso como bilhete (dono, 28/09): a imagem do evento em cima, o QR grande no meio,
               as informações embaixo. Usado/cancelado/transferido: o QR some e o aviso fica no lugar dele. -->
          <article v-for="(t, i) in data.ingressos" :key="t.id" data-parte="bilhete"
                   class="mx-auto w-full max-w-md overflow-hidden rounded-3xl bg-white shadow-card ring-1 ring-ink-200/70 print:break-inside-avoid print:shadow-none">
            <div class="relative h-36 bg-gradient-to-br from-pool-600 via-pool-700 to-grape-700 sm:h-44">
              <img v-if="data.evento.banner" :src="data.evento.banner" alt=""
                   class="absolute inset-0 h-full w-full object-cover" :loading="i === 0 ? 'eager' : 'lazy'">
              <div class="absolute inset-0 bg-gradient-to-t from-ink-950/80 via-ink-950/25 to-transparent" />
              <div class="absolute inset-x-0 bottom-0 p-4 text-white">
                <p class="titulo text-lg font-semibold leading-snug">{{ data.evento.nome }}</p>
                <p class="text-sm text-white/85">{{ quando(data.evento.inicio) }}</p>
              </div>
              <span class="absolute right-3 top-3 rounded-md bg-white/90 px-2 py-0.5 text-xs font-semibold tabular-nums text-ink-800">
                {{ i + 1 }}/{{ data.ingressos.length }}
              </span>
            </div>

            <!-- o picote do bilhete -->
            <div class="relative h-0 border-t-2 border-dashed border-ink-200" aria-hidden="true">
              <span class="absolute -left-3 -top-3 size-6 rounded-full bg-fundo" />
              <span class="absolute -right-3 -top-3 size-6 rounded-full bg-fundo" />
            </div>

            <div class="flex flex-col items-center px-6 pb-2 pt-6">
              <!-- O primeiro QR carrega `eager`: é ele que a portaria lê, e é o
                   que precisa estar pronto antes de a pessoa chegar na catraca.
                   Do segundo em diante vale adiar — pedido de 10 ingressos são
                   10 PNGs, e os de baixo esperam a rolagem sem prejudicar
                   ninguém. `lazy` no primeiro já rendeu `complete: false` com a
                   rota devolvendo 200 na medição do navegador. -->
              <img v-if="t.qr" :src="`/api/ingresso/${t.id}/qr.png?pedido=${encodeURIComponent(data.pedido)}`"
                   :alt="`QR do ingresso ${t.codigo}`"
                   class="h-56 w-56 rounded-2xl border border-linha bg-white p-2"
                   :loading="i === 0 ? 'eager' : 'lazy'" decoding="async">
              <p v-else
                 class="flex h-56 w-56 flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-linha p-4 text-center font-semibold text-tinta-suave">
                <template v-if="t.reagendadoPara">
                  <span class="titulo text-lg text-tinta">REAGENDADO</span>
                  <span class="text-sm font-medium">Este ingresso foi trocado por outro dia.</span>
                  <NuxtLink :to="`/ingressos/${t.reagendadoPara}`" class="btn-primario mt-1 px-3 py-2 text-sm">
                    Ver o ingresso novo
                  </NuxtLink>
                </template>
                <template v-else>
                  <span class="titulo text-lg text-tinta">{{ estado[t.status]?.t ?? 'SEM QR' }}</span>
                  <span class="text-sm font-medium">{{ SEM_QR[t.status] ?? 'Ingresso sem QR' }}</span>
                </template>
              </p>
              <p v-if="t.codigo" class="mt-3 font-mono text-base font-semibold tracking-[0.18em] text-tinta"
                 data-parte="codigo-do-ingresso">{{ t.codigo }}</p>
              <div class="mt-2 flex flex-wrap items-center justify-center gap-1.5">
                <!-- CORTESIA só no convite de verdade. A régua vem da API
                     (origem do pedido), nunca do valor: o ingresso que a
                     pessoa comprou com o cupom dela fechou em zero igual, e
                     escrever CORTESIA nele é dizer que lhe deram esmola. -->
                <span v-if="t.cortesia" class="selo-neutro"
                      title="Convite da casa: você não paga nada por esta entrada.">
                  CORTESIA
                </span>
                <!-- Volte Mais (037): o retorno com desconto — o caixa do bar confere o selo e um documento -->
                <span v-if="data.fidelidade && !t.reagendadoPara" class="selo-ok" data-parte="selo-fidelidade"
                      :title="`Retorno ${data.fidelidade.nome}: mostre este ingresso e um documento com foto no caixa.`">
                  {{ data.fidelidade.nome.toUpperCase() }}<template v-if="data.fidelidade.consumacaoPct"> · {{ data.fidelidade.consumacaoPct }}% NA CONSUMAÇÃO</template>
                </span>
                <span v-if="t.reagendadoPara" class="selo-neutro">REAGENDADO</span>
                <span v-else :class="estado[t.status]?.c ?? 'selo-neutro'">
                  {{ estado[t.status]?.t ?? t.status.toUpperCase() }}
                </span>
              </div>
            </div>

            <dl class="mx-6 mb-6 mt-4 grid gap-2 border-t border-linha pt-4 text-sm">
              <div class="flex justify-between gap-3">
                <dt class="text-tinta-fraca">Ingresso</dt>
                <dd class="text-right font-medium text-tinta">{{ t.tipo ?? 'Ingresso' }}</dd>
              </div>
              <div class="flex justify-between gap-3">
                <dt class="text-tinta-fraca">Setor</dt>
                <dd class="text-right text-tinta-corpo">{{ t.setor }}<template v-if="t.lote"> · {{ t.lote }}</template></dd>
              </div>
              <div v-if="t.sessao" class="flex justify-between gap-3">
                <dt class="text-tinta-fraca">Sessão</dt>
                <dd class="text-right text-tinta-corpo">{{ t.sessao }}</dd>
              </div>
              <div v-if="data.evento.local" class="flex justify-between gap-3">
                <dt class="text-tinta-fraca">Local</dt>
                <dd class="text-right text-tinta-corpo">{{ data.evento.local }}</dd>
              </div>
              <div v-if="t.titular" class="flex justify-between gap-3">
                <dt class="text-tinta-fraca">Titular</dt>
                <dd class="truncate text-right text-tinta-corpo">{{ t.titular }}</dd>
              </div>
              <div v-if="t.usadoEm" class="flex justify-between gap-3">
                <dt class="text-tinta-fraca">Entrada em</dt>
                <dd class="text-right text-tinta-corpo">{{ quando(t.usadoEm) }}</dd>
              </div>
              <div class="flex justify-between gap-3">
                <dt class="text-tinta-fraca">Pedido</dt>
                <dd class="text-right font-medium tabular-nums text-tinta">{{ data.pedido }}</dd>
              </div>
            </dl>

            <!-- Reagendar no pé do bilhete (dono, 30/09). "Pedir reembolso" saiu (dono, 05/10: o
                 parque não faz reembolso pelo site); o reagendar abre "em manutenção" enquanto a
                 rota estiver desligada (REAGENDAR_LIGADO, server/utils/reagendamento.ts). -->
            <div v-if="podeTrocar(t)" data-parte="acoes-do-ingresso" class="mx-6 mb-6 grid print:hidden">
              <NuxtLink :to="`/reagendar/${t.id}`" class="btn-primario justify-center text-sm">
                Reagendar
              </NuxtLink>
            </div>
          </article>

          <p class="text-center text-sm text-tinta-fraca print:hidden">
            Guarde este link. Na portaria, apresente o QR — ou informe o código, se a leitura falhar.
          </p>
        </section>
      </template>
    </div>
  </div>
</template>
