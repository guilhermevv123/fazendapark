<script setup lang="ts">
// A janela de entrar / criar a conta do cliente (034): uma só pro site inteiro, e só existe
// aberta — o painel da equipe nunca carrega o código dela.
const { janela } = useContaDoCliente()
</script>

<template>
  <NuxtLayout>
    <NuxtPage />
  </NuxtLayout>
  <LazyJanelaDaConta v-if="janela.aberta" />
</template>
