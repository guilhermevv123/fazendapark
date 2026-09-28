<script setup lang="ts">
/**
 * /cancelamento — desistência (arrependimento), cancelamento, adiamento e meia-entrada.
 *
 * TEXTO MODELO (27/09/2026, auditoria PROD-08): o direito de arrependimento do CDC (art. 49 — 7
 * dias da compra feita fora do estabelecimento, com devolução de tudo o que foi pago) e os meios
 * pra exercê-lo que o Decreto 7.962/2013 (art. 5º) exige que fiquem claros. **Precisa da revisão do
 * dono ou de um advogado antes de valer.** O canal de atendimento vem do banco; sem ele, a página
 * mostra o contato de suporte dos eventos publicados (o que a equipe digitou no painel) e, sem
 * nenhum dos dois, manda procurar a bilheteria — nunca inventa um telefone.
 *
 * As condições da desistência são as que o SISTEMA aplica (`avaliarArrependimento`, em
 * `server/utils/cancelamento.ts`): compra pela internet, até 7 dias da compra E com mais de 7 dias
 * para o evento. A segunda condição é regra do negócio, não do art. 49 — está escrita aqui porque
 * é o que acontece de fato no atendimento; se o dono (ou o advogado) tirar a regra, a página e a
 * função mudam juntas. Ver o relatório da frota (27/09), "Decisão do dono".
 */
import { resumoDaEmpresa } from '~/composables/dadosDaEmpresa'

const { data: empresa } = await useFetch<any>('/api/organizacao-publica', { key: 'organizacao-publica' })
const quem = computed(() => resumoDaEmpresa(empresa.value))

useHead({ title: 'Cancelamento e reembolso' })
useSeoMeta({ description: 'Como desistir da compra em até 7 dias, o que acontece se o evento for cancelado ou adiado, e a meia-entrada na portaria.' })
</script>

<template>
  <div class="min-h-screen bg-canvas">
    <CabecalhoPublico largura="max-w-3xl">
      <NuxtLink to="/#ingressos" class="rounded-lg px-3 py-2 font-semibold text-ink-700 transition-colors hover:bg-ink-100 hover:text-ink-900">
        Ingressos
      </NuxtLink>
    </CabecalhoPublico>

    <main class="mx-auto max-w-3xl px-4 pb-16 pt-8 sm:px-6">
      <p class="text-[13px] font-semibold uppercase tracking-[0.14em] text-pool-700">Seus direitos na compra</p>
      <h1 class="titulo mt-2 text-3xl font-semibold text-ink-900 sm:text-4xl">Cancelamento e reembolso</h1>

      <!-- o resumo que responde a pergunta de quem chegou aqui com pressa -->
      <div class="mt-6 grid gap-3 sm:grid-cols-3">
        <div class="rounded-2xl bg-pool-700 p-5 text-white shadow-card">
          <p class="titulo text-[34px] font-semibold leading-none tabular-nums">7 dias</p>
          <p class="mt-2 text-sm leading-6 text-pool-50">para desistir da compra feita pelo site, com devolução de tudo o que você pagou — pedindo até 7 dias antes do evento.</p>
        </div>
        <div class="rounded-2xl bg-grape-700 p-5 text-white shadow-card">
          <p class="titulo text-[22px] font-semibold leading-tight">Evento cancelado</p>
          <p class="mt-2 text-sm leading-6 text-grape-50">o valor volta pelo mesmo meio de pagamento, sem você precisar pedir.</p>
        </div>
        <div class="rounded-2xl bg-sun-300 p-5 text-ink-950 shadow-card">
          <p class="titulo text-[22px] font-semibold leading-tight">Evento adiado</p>
          <p class="mt-2 text-sm leading-6 text-ink-900">o ingresso vale na nova data — ou você pede o reembolso.</p>
        </div>
      </div>

      <article class="mt-6 grid gap-4 text-[15px] leading-7 text-ink-800">
        <section class="card" data-parte="arrependimento">
          <h2 class="titulo text-lg font-semibold text-ink-900">Desistir em até 7 dias (direito de arrependimento)</h2>
          <p class="mt-2">
            Quem compra pela internet pode desistir da compra em até <strong>7 dias corridos, contados da data da
            compra</strong> (Código de Defesa do Consumidor, art. 49). Não é preciso explicar o motivo.
          </p>
          <p class="mt-2" data-parte="condicoes">
            Para dar tempo de o ingresso voltar à venda, o pedido de desistência precisa chegar <strong>até 7 dias antes
            da data do evento</strong>. Compra feita na bilheteria (presencial) não entra nessa regra — fale com a
            bilheteria.
          </p>
          <ul class="mt-2 list-disc space-y-1 pl-5">
            <li>Devolvemos <strong>tudo</strong> o que foi pago, inclusive a taxa de serviço, pelo mesmo meio de pagamento: PIX volta por PIX; no cartão, pedimos o estorno à operadora do cartão, e ele aparece na fatura conforme o prazo do banco.</li>
            <li>O pedido precisa chegar antes do uso do ingresso: ingresso já lido na portaria foi usado.</li>
            <li>Quando o pedido chega, confirmamos o recebimento e os ingressos da compra deixam de valer.</li>
          </ul>
        </section>

        <section class="card" data-parte="como-pedir">
          <h2 class="titulo text-lg font-semibold text-ink-900">Como pedir</h2>
          <p class="mt-2">Mande o <strong>código do pedido</strong> (está no e-mail do ingresso), o nome e o CPF usados na compra:</p>
          <ul v-if="quem.canais.length" class="mt-3 grid gap-2">
            <li v-for="c in quem.canais" :key="c.href">
              <a :href="c.href"
                 class="flex min-h-[44px] items-center gap-3 rounded-xl bg-pool-50 px-4 py-2.5 font-semibold text-pool-900 ring-1 ring-inset ring-pool-200 transition-colors hover:bg-pool-100">
                <span class="text-sm font-semibold text-pool-700">{{ c.rotulo }}</span>
                <span class="break-all">{{ c.texto }}</span>
              </a>
            </li>
          </ul>
          <p v-else class="faixa-aviso mt-3">
            Procure o atendimento na bilheteria do parque, com o código do pedido.
          </p>
          <p v-if="quem.canaisSaoDosEventos" class="mt-2 text-sm text-ink-700">
            É o contato de atendimento dos eventos à venda.
          </p>
        </section>

        <section class="card">
          <h2 class="titulo text-lg font-semibold text-ink-900">Se o evento for cancelado ou adiado</h2>
          <ul class="mt-2 list-disc space-y-1 pl-5">
            <li><strong>Cancelado</strong>: todos os ingressos deixam de valer e o valor pago é devolvido pelo mesmo meio de pagamento, sem você precisar pedir.</li>
            <li><strong>Adiado</strong>: o ingresso vale para a nova data, sem troca. Se você não puder ir na nova data, peça o reembolso pelos contatos acima.</li>
          </ul>
        </section>

        <section class="card" data-parte="meia-entrada">
          <h2 class="titulo text-lg font-semibold text-ink-900">Meia-entrada: leve o documento</h2>
          <p class="mt-2">
            A meia-entrada é um direito de quem se enquadra na lei (Lei nº 12.933/2013 e demais leis aplicáveis) — e
            ele é conferido <strong>na portaria</strong>: leve o documento que comprova o benefício (carteira de
            estudante, documento com foto e data de nascimento, etc.). Sem o documento, a entrada com meia-entrada
            pode ser recusada.
          </p>
          <p class="mt-2">
            Comprou meia e percebeu que não vai ter o documento? Dentro dos 7 dias da compra (e até 7 dias antes do
            evento), você pode desistir e comprar de novo o ingresso certo.
          </p>
        </section>

        <p class="text-sm text-ink-700">
          Última atualização: 27 de setembro de 2026. Veja também os
          <NuxtLink to="/termos" class="font-semibold text-pool-700 underline-offset-2 hover:underline">Termos de uso e de compra</NuxtLink>
          e a
          <NuxtLink to="/privacidade" class="font-semibold text-pool-700 underline-offset-2 hover:underline">Política de privacidade</NuxtLink>.
        </p>
      </article>
    </main>

    <RodapePublico />
  </div>
</template>
