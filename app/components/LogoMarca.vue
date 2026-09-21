<script setup lang="ts">
/**
 * A logo do Conquista Park — o vetor da marca, o mesmo arquivo do site do parque
 * (`public/brand/`, copiado byte a byte do repositório `sistemapark`).
 *
 * `clara` é a versão toda branca, pra fundo escuro (o painel roxo do login).
 *
 * O TAMANHO não tem valor padrão aqui — quem usa escreve `class="h-9"`. Não é
 * descuido: um `h-10` de padrão brigaria com o `h-8` de quem usa, e entre duas
 * classes de altura vence a que o Tailwind escreveu por último no CSS (a maior),
 * não a que está no atributo. O sistema do parque resolve isso com
 * `tailwind-merge`; aqui a saída sem dependência é não ter padrão. O `w-auto` é
 * fixo porque o `width` do `<img>` (que reserva o espaço antes de a imagem
 * chegar, senão a página pula) vale como largura de 302px se o CSS não disser
 * o contrário.
 */
defineProps<{ clara?: boolean }>()
</script>

<template>
  <img
    :src="clara ? '/brand/conquista-park-branca.svg' : '/brand/conquista-park.svg'"
    alt="Conquista Park"
    width="302"
    height="122"
    draggable="false"
    class="w-auto select-none"
  >
</template>
