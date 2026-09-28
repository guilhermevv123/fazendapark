<script setup lang="ts">
/**
 * /privacidade — Política de privacidade (LGPD) do site de vendas.
 *
 * TEXTO MODELO (27/09/2026, auditoria PROD-08): diz quem é o controlador, que dados o cadastro da
 * compra coleta (o formulário de `pagamento.vue`, campo a campo), pra quê, com quem é dividido,
 * por quanto tempo fica e como a pessoa exerce os direitos do art. 18 da LGPD. **Precisa da
 * revisão do dono ou de um advogado antes de valer** — sobretudo os prazos de guarda, que são os
 * da lei e não uma rotina de exclusão que o sistema já rode sozinho. Os dados da empresa vêm do
 * banco (`/api/organizacao-publica`); linha sem dado não aparece.
 */
import { resumoDaEmpresa } from '~/composables/dadosDaEmpresa'

const { data: empresa } = await useFetch<any>('/api/organizacao-publica', { key: 'organizacao-publica' })
const quem = computed(() => resumoDaEmpresa(empresa.value))

const DADOS = [
  { o: 'Nome, e-mail e CPF', pra: 'identificar a compra, emitir e enviar o ingresso, e achar o seu pedido quando você pede ajuda.' },
  { o: 'Telefone (WhatsApp)', pra: 'falar com você sobre a compra e o evento (avisos de mudança, problemas no pagamento).' },
  { o: 'Data de nascimento', pra: 'conferir a faixa etária do evento e o direito a benefícios por idade.' },
  { o: 'Endereço (CEP, rua, número, bairro, cidade e estado)', pra: 'completar o cadastro e entender de onde vem o nosso público.' },
  { o: 'Instagram (opcional)', pra: 'falar com você por lá, se você aceitar receber novidades.' },
  { o: 'Senha', pra: 'guardada cifrada (ninguém consegue lê-la de volta), para um acesso futuro à sua conta.' },
  { o: 'Declaração de meia-entrada', pra: 'registrar o motivo do benefício, que é conferido na portaria (Lei nº 12.933/2013).' },
  { o: 'Dados do pedido', pra: 'ingressos, valores, forma de pagamento, data e a leitura do QR Code na entrada.' },
]

useHead({ title: 'Política de privacidade' })
useSeoMeta({ description: 'Quais dados o site coleta na compra, para quê, com quem são compartilhados e como exercer os seus direitos pela LGPD.' })
</script>

<template>
  <div class="min-h-screen bg-canvas">
    <CabecalhoPublico largura="max-w-3xl">
      <NuxtLink to="/#ingressos" class="rounded-lg px-3 py-2 font-semibold text-ink-700 transition-colors hover:bg-ink-100 hover:text-ink-900">
        Ingressos
      </NuxtLink>
    </CabecalhoPublico>

    <main class="mx-auto max-w-3xl px-4 pb-16 pt-8 sm:px-6">
      <p class="text-[13px] font-semibold uppercase tracking-[0.14em] text-grape-700">LGPD — Lei nº 13.709/2018</p>
      <h1 class="titulo mt-2 text-3xl font-semibold text-ink-900 sm:text-4xl">Política de privacidade</h1>
      <p class="mt-3 text-[15px] leading-7 text-ink-700">
        Aqui está, sem letra miúda, o que fazemos com os dados que você informa ao comprar um ingresso.
      </p>

      <article class="mt-8 grid gap-4 text-[15px] leading-7 text-ink-800">
        <section class="card" data-parte="controlador">
          <h2 class="titulo text-lg font-semibold text-ink-900">1. Quem cuida dos seus dados</h2>
          <p class="mt-2">
            O controlador dos dados — quem decide como eles são usados — é a empresa que vende os ingressos:
          </p>
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
            <div v-if="quem.encarregado" class="grid gap-0.5 sm:grid-cols-[9rem_1fr]">
              <dt class="font-semibold text-ink-700">Encarregado de dados</dt>
              <dd>{{ quem.encarregado }}</dd>
            </div>
          </dl>
        </section>

        <section class="card">
          <h2 class="titulo text-lg font-semibold text-ink-900">2. Que dados coletamos e para quê</h2>
          <ul class="mt-3 grid gap-2">
            <li v-for="d in DADOS" :key="d.o" class="rounded-xl bg-ink-50 px-4 py-3 text-sm">
              <strong class="text-ink-900">{{ d.o }}</strong> — {{ d.pra }}
            </li>
          </ul>
          <p class="mt-3 text-sm">
            Os dados do cartão de crédito são digitados na página do Asaas, nosso intermediador de pagamento, e
            não ficam guardados no nosso sistema. Este site não usa cookies de publicidade nem de rastreamento. O
            carrinho e o formulário ficam guardados só no seu navegador, nesta aba, para você não perder a compra se
            a página recarregar — a senha nunca fica guardada ali.
          </p>
        </section>

        <section class="card">
          <h2 class="titulo text-lg font-semibold text-ink-900">3. Com base em quê (base legal)</h2>
          <ul class="mt-2 list-disc space-y-1 pl-5">
            <li><strong>Para vender e entregar o ingresso</strong> — execução do contrato de compra (LGPD, art. 7º, V).</li>
            <li><strong>Meia-entrada, notas e registros fiscais</strong> — cumprimento de obrigação legal (art. 7º, II).</li>
            <li><strong>Evitar fraude e compra abusiva</strong> — legítimo interesse, no limite do necessário (art. 7º, IX).</li>
            <li>
              <strong>Novidades e ofertas</strong> por WhatsApp, e-mail e Instagram — <strong>só com o seu consentimento</strong>
              (art. 7º, I): a caixa "Quero receber novidades" nasce desmarcada. Você pode desistir a qualquer momento,
              pelo atendimento, sem prejuízo da compra.
            </li>
          </ul>
        </section>

        <section class="card">
          <h2 class="titulo text-lg font-semibold text-ink-900">4. Com quem compartilhamos</h2>
          <p class="mt-2">Só com quem precisa, e só o necessário para o serviço funcionar:</p>
          <ul class="mt-2 list-disc space-y-1 pl-5">
            <li>o Asaas, que processa o PIX e o cartão;</li>
            <li>os serviços que hospedam o site e enviam o e-mail com o ingresso;</li>
            <li>o serviço público ViaCEP, que recebe o CEP digitado para completar o endereço;</li>
            <li>autoridades, quando a lei obrigar.</li>
          </ul>
          <p class="mt-2">Não vendemos nem alugamos os seus dados.</p>
        </section>

        <section class="card">
          <h2 class="titulo text-lg font-semibold text-ink-900">5. Por quanto tempo guardamos</h2>
          <ul class="mt-2 list-disc space-y-1 pl-5">
            <li>Dados do pedido e do pagamento: pelo prazo que as leis fiscais e de defesa do consumidor exigem (em geral, 5 anos).</li>
            <li>Cadastro: enquanto você tiver relação com o parque, ou até pedir a exclusão — menos o que a lei manda guardar.</li>
            <li>Consentimento para novidades: até você retirá-lo.</li>
          </ul>
        </section>

        <section class="card" data-parte="direitos">
          <h2 class="titulo text-lg font-semibold text-ink-900">6. Seus direitos e como pedir</h2>
          <p class="mt-2">Pela LGPD (art. 18), você pode pedir, de graça:</p>
          <ul class="mt-2 list-disc space-y-1 pl-5">
            <li>a confirmação de que tratamos dados seus, e uma cópia deles;</li>
            <li>a correção de dado incompleto, errado ou desatualizado;</li>
            <li>a anonimização, o bloqueio ou a exclusão do que for desnecessário ou tratado em desacordo com a lei;</li>
            <li>a portabilidade dos dados para outro fornecedor;</li>
            <li>a lista de com quem compartilhamos;</li>
            <li>a retirada do consentimento para novidades, e a exclusão dos dados tratados com base nele.</li>
          </ul>
          <div class="faixa-aviso mt-4">
            <p class="font-semibold">Como pedir</p>
            <template v-if="quem.canais.length">
              <p class="mt-1">
                Fale com a gente
                <template v-for="(c, i) in quem.canais" :key="c.href">
                  {{ i ? ' ou ' : 'por ' }}<a :href="c.href" class="font-semibold underline underline-offset-2">{{ c.rotulo.toLowerCase() }} {{ c.texto }}</a>
                </template>,
                dizendo o seu nome, o CPF da compra e o que você quer. Respondemos em até 15 dias.
              </p>
            </template>
            <p v-else class="mt-1">
              Fale com o atendimento do parque na bilheteria, dizendo o seu nome, o CPF da compra e o que você quer.
              Respondemos em até 15 dias.
            </p>
            <p class="mt-2">
              Se não ficar satisfeito, você pode reclamar à Autoridade Nacional de Proteção de Dados (ANPD), em gov.br/anpd.
            </p>
          </div>
        </section>

        <section class="card">
          <h2 class="titulo text-lg font-semibold text-ink-900">7. Segurança</h2>
          <p class="mt-2">
            O acesso ao painel da equipe é individual e limitado ao que cada função precisa; a senha do cadastro é
            guardada cifrada; a lista completa de clientes só é vista pela administração, e toda exportação dela fica
            registrada com quem exportou.
          </p>
        </section>

        <p class="text-sm text-ink-700">
          Última atualização: 27 de setembro de 2026. Veja também os
          <NuxtLink to="/termos" class="font-semibold text-pool-700 underline-offset-2 hover:underline">Termos de uso e de compra</NuxtLink>.
        </p>
      </article>
    </main>

    <RodapePublico />
  </div>
</template>
