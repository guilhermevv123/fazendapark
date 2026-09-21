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
const route = useRoute()
const code = route.params.code as string

const { data, error, refresh } = await useFetch<any>(`/api/pedido/${code}`)

const quando = (v: any) => {
  const d = paraData(v)
  return d
    ? d.toLocaleString('pt-BR', {
        day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
      })
    : '—'
}

const estado: Record<string, { t: string; c: string }> = {
  valido: { t: 'VÁLIDO', c: 'selo-ok' },
  usado: { t: 'JÁ UTILIZADO', c: 'selo-neutro' },
  cancelado: { t: 'CANCELADO', c: 'selo-erro' },
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
let timerContagem: any, timerVigia: any

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
  if (data.value?.status !== 'aguardando_pagamento') return

  if (data.value.expiraEm) {
    const fim = new Date(data.value.expiraEm).getTime()
    const tick = () => { restante.value = Math.max(0, Math.floor((fim - Date.now()) / 1000)) }
    tick()
    timerContagem = setInterval(tick, 1000)
  }
  // O `catch` não é mudo: uma consulta que falha em silêncio aqui é a tela que
  // fica em "aguardando" pra sempre depois de o pagamento já ter caído.
  timerVigia = setInterval(async () => {
    try {
      await refresh()
      if (data.value?.status !== 'aguardando_pagamento') {
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
      <p v-if="error" class="card py-12 text-center text-tinta-suave">
        Pedido não encontrado. Confira o código.
      </p>

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
            <p class="text-xs text-tinta-fraca">{{ data.cortesia ? 'Entrada' : 'Total pago' }}</p>
            <p class="font-medium tabular-nums text-tinta">
              {{ data.cortesia ? 'Cortesia' : reais(data.totalCents) }}
            </p>
          </div>
          <span class="ml-auto" :class="data.status === 'pago' ? 'selo-ok' : 'selo-alerta'">
            {{ data.status === 'pago' ? 'PAGO' : data.status.replace(/_/g, ' ').toUpperCase() }}
          </span>
        </div>

        <!-- pedido ainda não pago -->
        <div v-if="data.status !== 'pago'" class="card mt-4">
          <p class="text-tinta-corpo">
            Este pedido ainda não foi pago, então os ingressos não foram emitidos.
          </p>

          <div v-if="data.pagamento?.pixQrBase64 || data.pagamento?.pixPayload" class="mt-4">
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

          <article v-for="(t, i) in data.ingressos" :key="t.id"
                   class="card flex flex-col gap-4 sm:flex-row sm:items-center">
            <!-- O primeiro QR carrega `eager`: é ele que a portaria lê, e é o
                 que precisa estar pronto antes de a pessoa chegar na catraca.
                 Do segundo em diante vale adiar — pedido de 10 ingressos são
                 10 PNGs, e os de baixo esperam a rolagem sem prejudicar
                 ninguém. `lazy` no primeiro já rendeu `complete: false` com a
                 rota devolvendo 200 na medição do navegador. -->
            <img :src="`/api/ingresso/${t.id}/qr.png?pedido=${data.pedido}`"
                 :alt="`QR do ingresso ${t.codigo}`"
                 class="mx-auto h-40 w-40 shrink-0 rounded-card border border-linha bg-white p-1 sm:mx-0"
                 :loading="i === 0 ? 'eager' : 'lazy'" decoding="async">

            <div class="min-w-0 flex-1">
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0">
                  <p class="titulo text-base font-semibold text-tinta">
                    {{ t.tipo ?? 'Ingresso' }} {{ i + 1 }}/{{ data.ingressos.length }}
                  </p>
                  <p class="text-sm text-tinta-suave">{{ t.setor }}<template v-if="t.lote"> · {{ t.lote }}</template></p>
                  <p v-if="t.sessao" class="text-sm text-tinta-suave">{{ t.sessao }}</p>
                </div>
                <div class="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                  <!-- CORTESIA só no convite de verdade. A régua vem da API
                       (origem do pedido), nunca do valor: o ingresso que a
                       pessoa comprou com o cupom dela fechou em zero igual, e
                       escrever CORTESIA nele é dizer que lhe deram esmola. -->
                  <span v-if="t.cortesia" class="selo-neutro"
                        title="Convite da casa: você não paga nada por esta entrada.">
                    CORTESIA
                  </span>
                  <span :class="estado[t.status]?.c ?? 'selo-neutro'">
                    {{ estado[t.status]?.t ?? t.status.toUpperCase() }}
                  </span>
                </div>
              </div>

              <dl class="mt-3 border-t border-linha pt-3 text-sm">
                <div class="flex justify-between gap-3">
                  <dt class="text-tinta-fraca">Código</dt>
                  <dd class="font-mono font-medium tracking-wider text-tinta">{{ t.codigo }}</dd>
                </div>
                <div v-if="t.titular" class="mt-1 flex justify-between gap-3">
                  <dt class="text-tinta-fraca">Titular</dt>
                  <dd class="truncate text-tinta-corpo">{{ t.titular }}</dd>
                </div>
                <div v-if="t.usadoEm" class="mt-1 flex justify-between gap-3">
                  <dt class="text-tinta-fraca">Entrada em</dt>
                  <dd class="text-tinta-corpo">{{ quando(t.usadoEm) }}</dd>
                </div>
              </dl>
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
