<script setup lang="ts">
/**
 * `<PainelFalha>` — quando a tela não carregou, dizer POR QUÊ e oferecer a saída que funciona.
 *
 * Antes toda tela de dinheiro mostrava a mesma coisa pra qualquer erro: a frase crua e um "Tentar
 * de novo" (auditoria GER-01). Pra 403 o botão repetia a recusa pra sempre; pra sessão expirada
 * (401) ele também, em vez de levar ao login. Três casos, três saídas:
 *
 *   · 401 → "sua sessão terminou" + Entrar de novo (volta pra esta tela depois: `?de=`);
 *   · 403 → a frase do servidor (que diz o papel e o que pedir) + Voltar aos eventos, SEM retry;
 *   · 400/422 (o pedido está errado — data torta colada no link) → a frase + Limpar o filtro, quando a
 *     tela passa `limpar`: repetir o mesmo pedido errado daria o mesmo erro;
 *   · o resto → a frase + Tentar de novo.
 */
const props = defineProps<{ falha: any; oQue: string; tentar?: () => unknown; limpar?: () => unknown }>()
const route = useRoute()

const status = computed(() => Number(props.falha?.statusCode ?? props.falha?.status ?? props.falha?.data?.statusCode ?? 0))
const frase = computed(() => props.falha?.data?.statusMessage || props.falha?.statusMessage
  || 'O servidor não respondeu. Confira a internet e tente de novo.')
const paraEntrar = computed(() => `/entrar?de=${encodeURIComponent(route.fullPath ?? route.path ?? '/admin')}`)
</script>

<template>
  <div class="card mt-4 flex flex-col items-start gap-3 sm:flex-row sm:items-center" role="alert" data-parte="falha">
    <span class="grid size-12 shrink-0 place-items-center rounded-2xl"
          :class="status === 403 ? 'bg-sun-100 text-sun-800' : 'bg-danger-100 text-danger-700'">
      <IconeMenu :nome="status === 401 ? 'sair' : status === 403 ? 'cracha' : 'suporte'" :tamanho="24" />
    </span>
    <div class="min-w-0 flex-1">
      <template v-if="status === 401">
        <p class="titulo text-base font-semibold text-ink-900">Sua sessão terminou</p>
        <p class="mt-0.5 text-sm text-ink-700">Entre de novo para ver {{ oQue }}. Você volta direto para esta tela.</p>
      </template>
      <template v-else-if="status === 403">
        <p class="titulo text-base font-semibold text-ink-900">{{ oQue[0]?.toUpperCase() + oQue.slice(1) }} não é do seu acesso</p>
        <p class="mt-0.5 text-sm text-ink-700" data-parte="falha-frase">{{ frase }}</p>
      </template>
      <template v-else>
        <p class="titulo text-base font-semibold text-danger-700">Não foi possível carregar {{ oQue }}</p>
        <p class="mt-0.5 text-sm text-ink-700" data-parte="falha-frase">{{ frase }}</p>
      </template>
    </div>
    <NuxtLink v-if="status === 401" :to="paraEntrar" class="btn-primario shrink-0" data-acao="entrar-de-novo">Entrar de novo</NuxtLink>
    <NuxtLink v-else-if="status === 403" to="/admin" class="btn-secundario shrink-0">Voltar aos eventos</NuxtLink>
    <button v-else-if="limpar && (status === 400 || status === 422)" type="button" class="btn-secundario shrink-0"
            data-acao="limpar-filtro" @click="limpar()">Limpar o filtro</button>
    <button v-else-if="tentar" type="button" class="btn-secundario shrink-0" data-acao="tentar-de-novo" @click="tentar()">Tentar de novo</button>
  </div>
</template>
