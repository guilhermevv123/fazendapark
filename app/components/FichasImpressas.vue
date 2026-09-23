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

/**
 * Imprime as fichas (uma por ingresso, com o QR) e NADA mais da tela.
 *
 * Mora aqui, e não em cada tela, porque agora são três lugares que imprimem a
 * mesma ficha: o recibo do balcão, a reimpressão pela lista do caixa e a
 * reimpressão pela ficha do pedido em Vendas. Três cópias da mesma regra de
 * impressão divergem na primeira bobina diferente.
 *
 * Duas coisas aqui só existem por causa da térmica:
 *   • o `@page` de 80mm entra num <style> só ANTES do print e sai no
 *     `afterprint`, pra o borderô e o resto do sistema seguirem em A4;
 *   • os QRs precisam ter carregado: o print congela a página no instante da
 *     chamada, e imagem que ainda baixa sai como um quadrado vazio.
 */
async function imprimir() {
  await nextTick()
  const imgs = Array.from(document.querySelectorAll<HTMLImageElement>('.fichas-impressao img'))
  await Promise.all(imgs.map((i) => i.complete
    ? null
    : new Promise((ok) => { i.onload = i.onerror = () => ok(null) })))
  const estilo = document.createElement('style')
  estilo.textContent = '@page { size: 80mm auto; margin: 0 }'
  document.head.appendChild(estilo)
  document.documentElement.classList.add('imprimindo-fichas')
  const fim = () => {
    estilo.remove()
    document.documentElement.classList.remove('imprimindo-fichas')
    window.removeEventListener('afterprint', fim)
  }
  window.addEventListener('afterprint', fim)
  setTimeout(fim, 60_000) // Safari nem sempre dispara o afterprint
  window.print()
}

defineExpose({ imprimir })
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
