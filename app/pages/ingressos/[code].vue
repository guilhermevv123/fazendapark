<script setup lang="ts">
/**
 * Os ingressos do comprador. Sem login: o código do pedido é a credencial.
 *
 * Um ingresso por bloco, QR grande, e o código legível embaixo — porque
 * quando a internet da portaria cai (e cai), o que salva a fila é o operador
 * conseguir digitar o código à mão.
 */
const route = useRoute()
const code = route.params.code as string

const { data, error, refresh } = await useFetch<any>(`/api/pedido/${code}`)

const reais = (c: number) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
const quando = (d: string) => new Date(d).toLocaleString('pt-BR', {
  day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
})

const estado: Record<string, { t: string; c: string }> = {
  valido: { t: 'VÁLIDO', c: 'selo-ok' },
  usado: { t: 'JÁ UTILIZADO', c: 'selo-neutro' },
  cancelado: { t: 'CANCELADO', c: 'selo-erro' },
}

useHead(() => ({ title: data.value ? `Pedido ${data.value.pedido}` : 'Meus ingressos' }))
</script>

<template>
  <div class="min-h-screen">
    <header class="bg-menu text-white print:hidden">
      <div class="mx-auto flex max-w-3xl items-center gap-3 px-4 py-3">
        <span class="titulo text-lg font-black tracking-tight">
          diamond<span class="font-normal opacity-70">.tickets</span>
        </span>
        <button type="button" class="ml-auto text-sm text-white/80 hover:text-white" @click="refresh()">
          Atualizar
        </button>
      </div>
    </header>

    <div class="mx-auto max-w-3xl px-4 py-6">
      <p v-if="error" class="card py-12 text-center text-tinta-suave">
        Pedido não encontrado. Confira o código.
      </p>

      <template v-else-if="data">
        <h1 class="titulo text-2xl font-bold text-tinta">{{ data.evento.nome }}</h1>
        <p class="mt-1 text-tinta-suave">
          {{ quando(data.evento.inicio) }}
          <template v-if="data.evento.local"> · {{ data.evento.local }}</template>
        </p>

        <div class="card mt-4 flex flex-wrap items-center gap-x-6 gap-y-2">
          <div>
            <p class="text-xs text-tinta-fraca">Pedido</p>
            <p class="font-medium tabular-nums text-tinta">{{ data.pedido }}</p>
          </div>
          <div>
            <p class="text-xs text-tinta-fraca">Comprador</p>
            <p class="font-medium text-tinta">{{ data.comprador.nome }}</p>
          </div>
          <div>
            <p class="text-xs text-tinta-fraca">Total pago</p>
            <p class="font-medium tabular-nums text-tinta">{{ reais(data.totalCents) }}</p>
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
          <div v-if="data.pagamento?.pixQrBase64" class="mt-4 text-center">
            <img :src="`data:image/png;base64,${data.pagamento.pixQrBase64}`"
                 alt="QR Code do PIX" class="mx-auto h-52 w-52">
            <p class="mt-2 text-sm text-tinta-suave">Pague o PIX acima para receber seus ingressos.</p>
          </div>
        </div>

        <!-- ingressos -->
        <section v-else class="mt-4 space-y-4">
          <article v-for="(t, i) in data.ingressos" :key="t.id"
                   class="card flex flex-col gap-4 sm:flex-row sm:items-center">
            <img :src="`/api/ingresso/${t.id}/qr.png?pedido=${data.pedido}`"
                 :alt="`QR do ingresso ${t.codigo}`"
                 class="mx-auto h-40 w-40 shrink-0 rounded-card border border-linha bg-white p-1 sm:mx-0"
                 loading="lazy">

            <div class="min-w-0 flex-1">
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0">
                  <p class="titulo text-base font-bold text-tinta">
                    {{ t.tipo ?? 'Ingresso' }} {{ i + 1 }}/{{ data.ingressos.length }}
                  </p>
                  <p class="text-sm text-tinta-suave">{{ t.setor }}<template v-if="t.lote"> · {{ t.lote }}</template></p>
                  <p v-if="t.sessao" class="text-sm text-tinta-suave">{{ t.sessao }}</p>
                </div>
                <span :class="estado[t.status]?.c ?? 'selo-neutro'">
                  {{ estado[t.status]?.t ?? t.status.toUpperCase() }}
                </span>
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
