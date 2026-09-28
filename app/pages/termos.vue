<script setup lang="ts">
/**
 * /termos — Termos de uso e de compra do site de vendas.
 *
 * TEXTO MODELO (27/09/2026, auditoria PROD-08): escrito em português claro a partir do que o
 * sistema faz de verdade (PIX e cartão pelo Asaas, reserva por minutos, ingresso com QR Code,
 * meia-entrada com documento na portaria, devolução automática em evento cancelado). **Precisa da
 * revisão do dono ou de um advogado antes de valer.** Os dados da empresa vêm do banco
 * (`/api/organizacao-publica`) — linha sem dado não aparece; nada é inventado.
 */
import { resumoDaEmpresa } from '~/composables/dadosDaEmpresa'

const { data: empresa } = await useFetch<any>('/api/organizacao-publica', { key: 'organizacao-publica' })
const quem = computed(() => resumoDaEmpresa(empresa.value))

useHead({ title: 'Termos de uso e de compra' })
useSeoMeta({ description: 'As regras da compra de ingressos pelo site: pagamento, entrega, meia-entrada, cancelamento e privacidade.' })
</script>

<template>
  <div class="min-h-screen bg-canvas">
    <CabecalhoPublico largura="max-w-3xl">
      <NuxtLink to="/#ingressos" class="rounded-lg px-3 py-2 font-semibold text-ink-700 transition-colors hover:bg-ink-100 hover:text-ink-900">
        Ingressos
      </NuxtLink>
    </CabecalhoPublico>

    <main class="mx-auto max-w-3xl px-4 pb-16 pt-8 sm:px-6">
      <p class="text-[13px] font-semibold uppercase tracking-[0.14em] text-pool-700">Regras do site</p>
      <h1 class="titulo mt-2 text-3xl font-semibold text-ink-900 sm:text-4xl">Termos de uso e de compra</h1>
      <p class="mt-3 text-[15px] leading-7 text-ink-700">
        Estas regras valem para toda compra de ingresso feita neste site. Ao pagar, você concorda com elas.
        Em caso de dúvida, fale com o atendimento — os contatos estão no fim da página.
      </p>

      <article class="mt-8 grid gap-4 text-[15px] leading-7 text-ink-800">
        <section class="card" data-parte="quem-vende">
          <h2 class="titulo text-lg font-semibold text-ink-900">1. Quem vende</h2>
          <dl class="mt-3 grid gap-2 text-sm">
            <div v-if="quem.nomeLegal" class="grid gap-0.5 sm:grid-cols-[9rem_1fr]">
              <dt class="font-semibold text-ink-700">Empresa</dt>
              <dd>{{ quem.nomeLegal }}<template v-if="quem.nomeFantasia"> ({{ quem.nomeFantasia }})</template></dd>
            </div>
            <div v-if="quem.documento" class="grid gap-0.5 sm:grid-cols-[9rem_1fr]">
              <dt class="font-semibold text-ink-700">{{ quem.documento.rotulo }}</dt>
              <dd class="tabular-nums">{{ quem.documento.texto }}</dd>
            </div>
            <div v-if="quem.endereco.length" class="grid gap-0.5 sm:grid-cols-[9rem_1fr]">
              <dt class="font-semibold text-ink-700">Endereço</dt>
              <dd><span v-for="(l, i) in quem.endereco" :key="i" class="block">{{ l }}</span></dd>
            </div>
            <div v-for="c in quem.canais" :key="c.href" class="grid gap-0.5 sm:grid-cols-[9rem_1fr]">
              <dt class="font-semibold text-ink-700">{{ c.rotulo }}</dt>
              <dd><a :href="c.href" class="font-semibold text-pool-700 underline-offset-2 hover:underline">{{ c.texto }}</a></dd>
            </div>
          </dl>
          <p class="mt-3 text-sm text-ink-700">
            O pagamento é processado pelo Asaas, instituição de pagamento que recebe o PIX e o cartão em nosso nome.
          </p>
        </section>

        <section class="card">
          <h2 class="titulo text-lg font-semibold text-ink-900">2. O que você compra</h2>
          <p class="mt-2">
            Um ingresso digital para o evento e a data escolhidos, com um QR Code. Cada QR Code dá direito a uma
            entrada e deixa de valer depois de lido na portaria. Guarde o ingresso no celular (ou impresso) e não
            compartilhe o QR Code: quem apresentar primeiro, entra.
          </p>
        </section>

        <section class="card">
          <h2 class="titulo text-lg font-semibold text-ink-900">3. Preço, taxa e pagamento</h2>
          <ul class="mt-2 list-disc space-y-1 pl-5">
            <li>O valor total — ingressos, taxa de serviço (quando houver) e descontos — aparece antes de você pagar.</li>
            <li>Pagamento por PIX ou cartão de crédito. Os dados do cartão são digitados na página segura do Asaas e não ficam guardados no nosso sistema.</li>
            <li>Ao iniciar o pagamento, os ingressos ficam reservados por alguns minutos. Sem pagamento nesse prazo, a reserva cai e os ingressos voltam à venda.</li>
            <li>A compra só vale depois que o pagamento é confirmado.</li>
          </ul>
        </section>

        <section class="card">
          <h2 class="titulo text-lg font-semibold text-ink-900">4. Entrega do ingresso</h2>
          <p class="mt-2">
            Com o pagamento confirmado, o ingresso aparece na tela e é enviado para o e-mail informado na compra.
            Confira o e-mail antes de pagar. Se não receber, fale com o atendimento com o código do pedido em mãos.
          </p>
        </section>

        <section class="card">
          <h2 class="titulo text-lg font-semibold text-ink-900">5. Meia-entrada</h2>
          <p class="mt-2">
            Quem compra meia-entrada precisa ter direito ao benefício (Lei nº 12.933/2013 e demais leis aplicáveis) e
            apresentar, na entrada, o documento que comprova esse direito. Sem o documento, a entrada com
            meia-entrada pode ser recusada. Veja o que fazer em
            <NuxtLink to="/cancelamento" class="font-semibold text-pool-700 underline-offset-2 hover:underline">Cancelamento e reembolso</NuxtLink>.
          </p>
        </section>

        <section class="card">
          <h2 class="titulo text-lg font-semibold text-ink-900">6. Desistência, cancelamento e adiamento</h2>
          <p class="mt-2">
            Você pode desistir da compra feita pelo site em até 7 dias (Código de Defesa do Consumidor, art. 49),
            pedindo até 7 dias antes da data do evento.
            Se o evento for cancelado, o valor é devolvido. Se for adiado, o ingresso vale para a nova data — e quem
            não puder ir pode pedir o reembolso. Prazos, meios de devolução e como pedir estão em
            <NuxtLink to="/cancelamento" class="font-semibold text-pool-700 underline-offset-2 hover:underline">Cancelamento e reembolso</NuxtLink>.
          </p>
        </section>

        <section class="card">
          <h2 class="titulo text-lg font-semibold text-ink-900">7. No dia</h2>
          <ul class="mt-2 list-disc space-y-1 pl-5">
            <li>Apresente o QR Code na portaria. Menores de idade seguem a faixa etária informada na página do evento.</li>
            <li>Siga as orientações da equipe e as regras de segurança do parque.</li>
          </ul>
        </section>

        <section class="card">
          <h2 class="titulo text-lg font-semibold text-ink-900">8. Seus dados</h2>
          <p class="mt-2">
            Como usamos os dados que você informa na compra, e como pedir acesso, correção ou exclusão, está na
            <NuxtLink to="/privacidade" class="font-semibold text-pool-700 underline-offset-2 hover:underline">Política de privacidade</NuxtLink>.
          </p>
        </section>

        <section class="card">
          <h2 class="titulo text-lg font-semibold text-ink-900">9. Leis que valem</h2>
          <p class="mt-2">
            Estas regras seguem o Código de Defesa do Consumidor, o Decreto nº 7.962/2013 (comércio eletrônico) e a
            Lei Geral de Proteção de Dados (Lei nº 13.709/2018). Nada aqui tira direito que a lei garante a você.
          </p>
        </section>

        <p class="text-sm text-ink-700">Última atualização: 27 de setembro de 2026.</p>
      </article>
    </main>

    <RodapePublico />
  </div>
</template>
