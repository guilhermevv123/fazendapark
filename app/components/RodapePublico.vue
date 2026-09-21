<script setup lang="ts">
/**
 * O rodapé do site de vendas — o `SiteFooter` do sistema do parque, sem o que
 * ainda não tem dado real por trás (telefone, WhatsApp, CNPJ e as páginas de
 * política ficam de fora até o dono entregar o texto: melhor um rodapé curto
 * que um número inventado ou um termo que descreve outro produto).
 *
 * Só a home usa. As telas de compra (vitrine, pagamento, ingressos) seguem com
 * o cabeçalho enxuto e sem rodapé: no meio de uma compra, link pra fora é rota
 * de fuga.
 */
defineProps<{ cidade?: string }>()
const ano = new Date().getFullYear()
</script>

<template>
  <footer class="bg-ink-950 text-white print:hidden">
    <div class="mx-auto grid max-w-6xl gap-10 px-4 py-12 sm:px-6 md:grid-cols-[1.4fr_1fr]">
      <div class="grid content-start gap-4">
        <LogoMarca clara class="h-10" />
        <p class="max-w-xs text-sm leading-6 text-ink-300">
          Parque aquático para passar o dia em família. Compre o ingresso pelo
          site e entre com o QR Code no celular.
        </p>
      </div>
      <div class="grid content-start gap-3">
        <p class="text-xs font-semibold uppercase tracking-[0.14em] text-ink-400">Visite</p>
        <p v-if="cidade" class="flex gap-2 text-sm leading-6 text-ink-300">
          <svg class="mt-1 size-4 shrink-0 text-pool-400" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0" />
            <circle cx="12" cy="10" r="3" />
          </svg>
          <span>{{ cidade }}</span>
        </p>
        <NuxtLink to="/#ingressos" class="text-sm text-ink-300 transition-colors hover:text-white">
          Ingressos e datas
        </NuxtLink>
      </div>
    </div>
    <div class="border-t border-white/10">
      <div class="mx-auto flex max-w-6xl flex-col gap-2 px-4 py-5 text-xs text-ink-400 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <p>© {{ ano }} Conquista Park</p>
        <NuxtLink to="/entrar" class="w-fit transition-colors hover:text-white">Área da equipe</NuxtLink>
      </div>
    </div>
  </footer>
</template>
