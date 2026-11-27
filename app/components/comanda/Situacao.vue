<script setup lang="ts">
/**
 * A faixa de cima das telas da comanda (055), dentro do painel: a hora, a internet e os
 * pedidos guardados no tablet esperando a rede. É também quem RODA a sincronia (a cada 6 s):
 * sobe a fila e baixa a cópia nova do cardápio e das contas abertas (`comandaOffline.ts`).
 *
 * As telas só aparecem depois da primeira cópia (da rede ou guardada no tablet): o slot
 * recebe o estado pronto. Sem acesso à comanda, mostra o porquê.
 */
import {
  estado, estadoGuardado, faixaLarga, mensagemDoErro, noAppDoTablet, online, pendentes, problemas, sincronizar, ultimaSincronia,
} from '~/composables/comandaOffline'

/** dentro da Gestão: a faixa (online, hora, quem está) só aparece se tiver problema */
const props = defineProps<{ discreta?: boolean }>()
const route = useRoute()
const VERSAO_DO_APP = String(useRuntimeConfig().app?.buildId ?? '')
const bloqueio = ref('')
const agora = ref(new Date())
let relogio: ReturnType<typeof setInterval> | undefined
let laco: ReturnType<typeof setInterval> | undefined

async function rodar() {
  try {
    await sincronizar()
    bloqueio.value = ''
  } catch (e: any) {
    const status = Number(e?.statusCode ?? e?.status ?? e?.response?.status ?? 0)
    if (status === 401) {
      // no app do tablet não existe /entrar: o app volta pra tela de login dele
      if (noAppDoTablet.value) {
        window.dispatchEvent(new Event('comanda:sair'))
        return
      }
      window.location.href = `/entrar?de=${encodeURIComponent(route.fullPath)}`
      return
    }
    bloqueio.value = mensagemDoErro(e, 'Você não tem acesso às comandas.')
  }
}

onMounted(async () => {
  estado.value = estado.value ?? estadoGuardado()
  relogio = setInterval(() => { agora.value = new Date() }, 15_000)
  await rodar()
  laco = setInterval(rodar, 6000)
  window.addEventListener('online', rodar)
  // a tela da comanda abre sem internet (service worker só de /admin/comandas)
  if ('serviceWorker' in navigator) {
    if (!noAppDoTablet.value) navigator.serviceWorker.register(`/sw-comandas.js?v=${VERSAO_DO_APP}`, { scope: '/admin/comandas' }).catch(() => {})
  }
})
onBeforeUnmount(() => {
  clearInterval(relogio)
  clearInterval(laco)
  window.removeEventListener('online', rodar)
})

const dia = computed(() => {
  const t = agora.value.toLocaleDateString('pt-BR', { timeZone: 'America/Bahia', weekday: 'long', day: '2-digit', month: 'long' })
  return t.charAt(0).toUpperCase() + t.slice(1)
})
const hora = computed(() => agora.value.toLocaleTimeString('pt-BR', { timeZone: 'America/Bahia', hour: '2-digit', minute: '2-digit' }))
const NIVEL: Record<string, string> = { atendente: 'Atendente', caixa: 'Caixa', gerente: 'Gerente' }
const sincronizouHa = computed(() => {
  if (!ultimaSincronia.value) return ''
  const s = Math.round((agora.value.getTime() - new Date(ultimaSincronia.value).getTime()) / 1000)
  return s < 60 ? 'agora' : `há ${Math.round(s / 60)} min`
})
</script>

<template>
  <div class="space-y-4">
    <div v-if="!props.discreta || !online || pendentes || problemas" data-parte="situacao-comanda"
         class="card mx-auto flex w-full flex-wrap items-center justify-between gap-x-6 gap-y-2 px-5 py-3 text-sm"
         :class="faixaLarga ? '' : 'max-w-4xl'">
      <div class="flex flex-wrap items-center gap-2">
        <span data-parte="internet" class="selo" :class="online ? 'selo-ok' : 'selo-erro'">
          <span class="h-2 w-2 rounded-full" :class="online ? 'bg-success-600' : 'bg-danger-600 animate-pulse'" />
          {{ online ? 'Online' : 'SEM INTERNET' }}
        </span>
        <span v-if="online && sincronizouHa" class="text-xs text-ink-600">atualizado {{ sincronizouHa }}</span>
        <span v-if="pendentes" class="selo-alerta" data-parte="na-fila">{{ pendentes }} pedido(s) guardado(s) no tablet</span>
        <span v-if="problemas" class="selo-erro">{{ problemas }} com problema</span>
      </div>
      <div class="flex items-baseline gap-2">
        <span class="hidden text-ink-600 sm:inline">{{ dia }}</span>
        <span class="text-lg font-bold tabular-nums text-ink-900">{{ hora }}</span>
      </div>
      <!-- no app do tablet o nome já está no cabeçalho -->
      <div v-if="estado && !noAppDoTablet" class="flex items-center gap-2">
        <span class="flex h-8 w-8 items-center justify-center rounded-full bg-acao-claro text-sm font-bold text-acao">{{ estado.eu.nome.charAt(0).toUpperCase() }}</span>
        <span class="leading-tight"><span class="block font-semibold text-ink-900">{{ estado.eu.nome }}</span>
          <span class="block text-xs text-ink-600">{{ NIVEL[estado.eu.nivel] ?? estado.eu.nivel }}</span></span>
      </div>
    </div>
    <p v-if="!online" class="faixa-erro font-semibold">
      Sem internet: pode continuar lançando pedidos. Eles ficam guardados neste tablet e sobem sozinhos quando a internet voltar.
    </p>
    <div v-if="bloqueio" class="card mx-auto max-w-lg p-6 text-center">
      <p class="titulo-bloco">Sem acesso às comandas</p>
      <p class="apoio-bloco">{{ bloqueio }}</p>
    </div>
    <div v-else-if="!estado" class="py-20 text-center text-ink-600">Carregando…</div>
    <slot v-else />
  </div>
</template>
