<script setup lang="ts">
/**
 * A tela de quem recebeu o ingresso.
 *
 * Quem abre isso não tem conta e não sabe o que é a plataforma: chegou por um
 * link no WhatsApp de um amigo. Então a tela responde, nesta ordem, as três
 * perguntas que a pessoa tem — que evento é, quem mandou, e o que eu faço
 * agora — e só depois pede alguma coisa.
 *
 * O estado recusado é tão importante quanto o aceite: link vencido, já aceito
 * ou cancelado precisa dizer o que aconteceu e o que fazer, senão a pessoa
 * fica clicando achando que é a internet dela.
 */
import { dataNoFuso, falhaDaConsulta } from '~/composables/carrinhoDaVitrine'

const route = useRoute()
const code = String(route.params.code ?? '')
// B22: o token vai CODIFICADO (cru, `..%2F` subia de pasta no SSR)
const rota = `/api/transferencia/${encodeURIComponent(code)}`

const { data, refresh, error } = await useFetch<any>(rota)

/**
 * B10: "Link não encontrado" só pro 404 — e aí a resposta é 404 de verdade
 * (`app/error.vue`). Com o banco fora do ar a pessoa lia que o link que o
 * amigo mandou não existe.
 */
const falha = computed(() => falhaDaConsulta(error.value))
if (falha.value === 'nao_encontrado') {
  throw createError({ statusCode: 404, statusMessage: 'Transferência não encontrada', fatal: true })
}
const tentando = ref(false)
async function tentarDeNovo() {
  tentando.value = true
  try { await refresh() } finally { tentando.value = false }
}

const nome = ref('')
const documento = ref('')
const erro = ref('')
/** o servidor recusou o CPF (B33) — o campo fica marcado */
const erroNoCpf = ref(false)
const aceitando = ref(false)
const pronto = ref<any>(null)

watch(data, (d) => { if (d?.para?.nome && !nome.value) nome.value = d.para.nome }, { immediate: true })

async function aceitar() {
  aceitando.value = true; erro.value = ''; erroNoCpf.value = false
  try {
    pronto.value = await $fetch(rota, {
      method: 'POST',
      body: { nome: nome.value.trim(), documento: documento.value.trim() || null },
    })
    await refresh()
  } catch (e: any) {
    erro.value = e?.data?.message ?? e?.statusMessage ?? 'Não deu pra aceitar agora.'
    erroNoCpf.value = e?.data?.data?.campo === 'documento'
  } finally { aceitando.value = false }
}

/** B24: no fuso do EVENTO — o SSR e o celular de outro fuso escreviam horas diferentes. */
const quando = (v: string | null) => (v ? dataNoFuso(v, data.value?.evento?.fuso) : '')

/**
 * O QR de quem recebeu. Aparece AQUI, na página da transferência, e não no
 * pedido de quem mandou: o destinatário não tem pedido, e o pedido do outro
 * mostraria a compra inteira dele. O token deste link é a credencial — o mesmo
 * modelo do código do pedido pra quem compra. A API só libera o id depois do
 * aceite e enquanto esta transferência estiver em vigor.
 */
const qrSrc = computed(() => data.value?.ingresso?.qrDisponivel && data.value.ingresso.id
  ? `/api/ingresso/${data.value.ingresso.id}/qr.png?transferencia=${encodeURIComponent(code)}`
  : null)

const SITUACAO: Record<string, string> = {
  usado: 'Este ingresso já foi usado na entrada.',
  cancelado: 'Este ingresso foi cancelado e não vale mais na entrada.',
}

const RECADO: Record<string, string> = {
  concluido: 'Esta transferência já foi aceita. O ingresso está no seu nome — o QR está logo abaixo.',
  cancelado: 'Quem enviou cancelou esta transferência. O ingresso voltou pra pessoa anterior.',
  expirado: 'O prazo pra aceitar venceu. Peça pra quem enviou mandar de novo — leva um minuto.',
}
</script>

<template>
  <div class="min-h-screen bg-fundo-cinza px-4 py-10">
    <div class="mx-auto max-w-lg">
      <div class="flex justify-center">
        <LogoMarca class="h-12" />
      </div>

      <div v-if="falha" class="card mt-6 text-center" role="alert">
        <template v-if="falha === 'nao_encontrado'">
          <h1 class="titulo text-xl font-semibold text-tinta">Link não encontrado</h1>
          <p class="mt-2 text-tinta-suave">
            Confira se o endereço veio completo. Se veio por mensagem, às vezes a última parte
            do link fica de fora.
          </p>
        </template>
        <template v-else>
          <h1 class="titulo text-xl font-semibold text-tinta">A bilheteria não respondeu agora</h1>
          <p class="mt-2 text-tinta-suave">
            O ingresso continua reservado pra você — quem não respondeu foi o nosso sistema. Tente
            de novo em alguns instantes.
          </p>
          <button type="button" class="btn-primario mt-6 px-5" :disabled="tentando" @click="tentarDeNovo">
            {{ tentando ? 'Tentando…' : 'Tentar de novo' }}
          </button>
        </template>
      </div>

      <template v-else-if="data">
        <!-- acabou de aceitar -->
        <div v-if="pronto" class="card mt-6 text-center">
          <p class="text-4xl">🎟️</p>
          <h1 class="titulo mt-3 text-xl font-semibold text-tinta">Ingresso é seu, {{ pronto.titular }}</h1>
          <p class="mt-2 text-tinta-suave">
            Ele já está no seu nome para {{ data.evento.nome }}.
          </p>
          <img v-if="qrSrc" :src="qrSrc" :alt="`QR do ingresso ${pronto.ingresso}`"
               class="mx-auto mt-4 h-52 w-52 rounded-card border border-linha bg-white p-1"
               loading="eager" decoding="async">
          <p class="mt-4 rounded-sm border border-linha bg-fundo-cinza px-3 py-2 font-mono text-sm">
            {{ pronto.ingresso }}
          </p>
          <p class="mt-3 text-xs text-tinta-fraca">
            Guarde este link: é nele que o QR do seu ingresso fica. Na entrada, apresente o QR
            (ou informe o código, se a leitura falhar) com um documento seu. O código antigo, de
            quem enviou, deixou de valer.
          </p>
        </div>

        <!-- nada a fazer -->
        <div v-else-if="!data.podeAceitar" class="card mt-6 text-center">
          <h1 class="titulo text-xl font-semibold text-tinta">{{ data.statusTexto }}</h1>
          <!-- B33: o ingresso morreu antes do aceite (usado, cancelado) — o
               servidor diz por quê em `motivo`; sem ele a frase saía vazia -->
          <p class="mt-2 text-tinta-suave">
            {{ data.motivo
                 ? data.motivo
                 : data.ingresso.situacao && SITUACAO[data.ingresso.situacao]
                   ? SITUACAO[data.ingresso.situacao]
                   : data.status === 'concluido' && !data.ingresso.codigo
                     ? 'Esta transferência foi aceita, mas o ingresso já passou para outra pessoa.'
                     : RECADO[data.status] }}
          </p>
          <img v-if="qrSrc" :src="qrSrc" :alt="`QR do ingresso ${data.ingresso.codigo}`"
               class="mx-auto mt-4 h-52 w-52 rounded-card border border-linha bg-white p-1"
               loading="eager" decoding="async">
          <p v-if="data.ingresso.codigo" class="mt-4 font-mono text-sm text-tinta-corpo">
            {{ data.ingresso.codigo }}
          </p>
          <p v-if="qrSrc" class="mt-3 text-xs text-tinta-fraca">
            Na entrada, apresente o QR — ou informe o código, se a leitura falhar — com um documento seu.
          </p>
        </div>

        <!-- o aceite -->
        <template v-else>
          <div class="card mt-6">
            <p class="rotulo-kpi">Você recebeu um ingresso</p>
            <h1 class="titulo mt-2 text-2xl font-semibold text-tinta">{{ data.evento.nome }}</h1>
            <p class="mt-1 text-tinta-suave">
              {{ quando(data.ingresso.sessaoInicio ?? data.evento.comecaEm) }}
            </p>
            <p v-if="data.evento.local || data.evento.cidade" class="text-tinta-suave">
              {{ [data.evento.local, data.evento.cidade && `${data.evento.cidade}/${data.evento.estado}`]
                   .filter(Boolean).join(' · ') }}
            </p>

            <dl class="mt-5 space-y-2 border-t border-linha pt-4 text-sm">
              <div class="flex justify-between gap-4">
                <dt class="text-tinta-suave">Setor</dt>
                <dd class="text-tinta-corpo">{{ data.ingresso.setor }}</dd>
              </div>
              <div v-if="data.ingresso.assento" class="flex justify-between gap-4">
                <dt class="text-tinta-suave">Cadeira</dt>
                <dd class="text-tinta-corpo">{{ data.ingresso.assento }}</dd>
              </div>
              <div v-if="data.ingresso.tipo" class="flex justify-between gap-4">
                <dt class="text-tinta-suave">Tipo</dt>
                <dd class="text-tinta-corpo">{{ data.ingresso.tipo }}</dd>
              </div>
              <div class="flex justify-between gap-4">
                <dt class="text-tinta-suave">Enviado por</dt>
                <dd class="text-tinta-corpo">
                  {{ data.de.nome ?? 'quem comprou' }}
                  <span v-if="data.de.email" class="text-tinta-fraca">({{ data.de.email }})</span>
                </dd>
              </div>
            </dl>
          </div>

          <form class="card mt-4" @submit.prevent="aceitar">
            <h2 class="rotulo-kpi">Confirme quem vai usar</h2>
            <p class="mt-1 text-xs text-tinta-fraca">
              O nome aqui é o que a portaria vai conferir com o seu documento.
            </p>

            <label class="mt-4 block text-sm">
              <span class="text-tinta-suave">Nome completo</span>
              <input v-model="nome" class="campo mt-1 w-full" required maxlength="120">
            </label>

            <!-- B33: só números (a máscara com ponto e traço também passa); o
                 servidor confere os dígitos e recusa letra ou símbolo -->
            <label class="mt-3 block text-sm">
              <span class="text-tinta-suave">CPF <span class="text-tinta-fraca">(opcional)</span></span>
              <input v-model="documento" class="campo mt-1 w-full" maxlength="14"
                     inputmode="numeric" autocomplete="off" placeholder="000.000.000-00"
                     :aria-invalid="erroNoCpf ? 'true' : undefined">
              <span class="mt-1 block text-xs text-tinta-fraca">Só os 11 números. Deixe em branco se o evento não pedir.</span>
            </label>

            <p v-if="erro" class="faixa-erro mt-4" role="alert">
              {{ erro }}
            </p>

            <button class="btn-cta mt-5 w-full" :disabled="aceitando">
              {{ aceitando ? 'Aceitando…' : 'Aceitar ingresso' }}
            </button>
            <p class="mt-3 text-center text-xs text-tinta-fraca">
              Você tem até {{ quando(data.venceEm) }} pra aceitar.
            </p>
          </form>
        </template>
      </template>
    </div>
  </div>
</template>
