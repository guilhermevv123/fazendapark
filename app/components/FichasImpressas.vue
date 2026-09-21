<script setup lang="ts">
/**
 * As fichas do balcão: uma por ingresso, impressas na hora da venda.
 *
 * Cada ficha leva o QR do ingresso (a mesma imagem que o comprador vê na página
 * dele), o que foi comprado e o código em letras — pra digitar no leitor se o
 * QR estiver amassado ou sujo. É isto que a portaria lê: o QR carrega a
 * assinatura do ingresso, e quem decide se ele ainda vale é o servidor, no
 * momento da leitura (uso único).
 *
 * Só existe na IMPRESSÃO. Na tela as fichas ficam escondidas, montadas fora do
 * app (Teleport pro <body>) pra que a impressão possa esconder o app inteiro e
 * sobrar só elas. As regras moram em `base.css` (`.fichas-impressao`, `.ficha*`)
 * e só valem com `html.imprimindo-fichas`, que o PDV liga durante o print:
 * nenhuma outra impressão do sistema (borderô, relatórios) é afetada.
 *
 * Papel: bobina térmica de 80mm (a do cupom). Uma ficha por página, pra a
 * guilhotina cortar entre elas. Sem cor e sem logo em imagem: a térmica é preto
 * e branco, e um logo colorido sai como uma mancha.
 */
defineProps<{
  evento: string
  pedido: string
  ingressos: { id: string; codigo: string; lote: string; setor: string; tipo?: string | null }[]
}>()
</script>

<template>
  <Teleport to="body">
    <div class="fichas-impressao" aria-hidden="true">
      <section v-for="t in ingressos" :key="t.id" class="ficha">
        <p class="ficha-marca">Conquista Park</p>
        <p class="ficha-evento">{{ evento }}</p>
        <img class="ficha-qr" width="200" height="200" alt=""
             :src="`/api/ingresso/${t.id}/qr.png?pedido=${pedido}`">
        <p class="ficha-codigo">{{ t.codigo }}</p>
        <p class="ficha-item">{{ t.setor }}</p>
        <p class="ficha-item">{{ t.lote }}<template v-if="t.tipo"> · {{ t.tipo }}</template></p>
        <p class="ficha-rodape">Pedido {{ pedido }} · uso único · apresente na entrada</p>
      </section>
    </div>
  </Teleport>
</template>
