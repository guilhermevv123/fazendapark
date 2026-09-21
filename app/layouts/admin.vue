<script setup lang="ts">
/**
 * Shell do painel: nav lateral fixa de 220px + barra de topo de 59px.
 * As medidas e cores vieram do getComputedStyle do painel de origem, não de
 * estimativa por print — ver comentário no tailwind.config.js.
 */
const route = useRoute()
const eventoId = computed(() => route.params.id as string | undefined)
const base = computed(() => (eventoId.value ? `/admin/evento/${eventoId.value}` : '/admin'))

const { data: evento } = await useFetch<any>(
  () => (eventoId.value ? `/api/admin/evento/${eventoId.value}/resumo` : ''),
  { immediate: !!eventoId.value, watch: [eventoId] })

// Mesma `key` do middleware de rota: o Nuxt reaproveita a resposta em vez de
// bater na rota duas vezes por navegação.
const { data: eu } = await useFetch<any>('/api/auth/eu', { key: 'auth-eu' })

const iniciais = computed(() => {
  const n = eu.value?.usuario?.nome
  if (!n) return 'DT'
  const partes = n.trim().split(/\s+/)
  return ((partes[0]?.[0] ?? '') + (partes.length > 1 ? partes.at(-1)![0] : '')).toUpperCase()
})

const menuAberto = ref(false)
async function sair() {
  await $fetch('/api/auth/sair', { method: 'POST' })
  // Recarrega de verdade em vez de navegar: `navigateTo` manteria em memória
  // o cache do useFetch com o usuário antigo, e a tela de login apareceria
  // com o nome de quem acabou de sair no canto.
  window.location.href = '/entrar'
}

/**
 * O menu é em GRUPOS: o item de primeiro nível abre a lista de telas daquele
 * assunto em vez de navegar direto. Sem isso, "Ingressos" e "Financeiro"
 * viram uma tela só com dez abas, e a pessoa perde de vista que cortesia,
 * cupom e promoter são coisas diferentes que moram no mesmo assunto.
 */
// A lista das telas do evento mora em composables/menuDoEvento.ts, junto com
// a barra de abas que mostra as mesmas telas no alto da página.
type Item = GrupoDoEvento

const itens = computed<Item[]>(() => eventoId.value
  ? menuDoEvento(eventoId.value)
  : [
      { nome: 'Eventos', icone: 'calendario', para: '/admin' },
      { nome: 'Organizações', icone: 'pessoas', para: '/admin/organizacoes' },
      { nome: 'Equipe', icone: 'pessoas', para: '/admin/equipe' },
      { nome: 'Financeiro', icone: 'financeiro', para: '/admin/financeiro' },
      { nome: 'Configurações', icone: 'config', para: '/admin/configuracoes' },
      { nome: 'Suporte', icone: 'suporte', para: '/admin/suporte' },
    ])

const ativo = (para: string) => route.path === para || route.path.startsWith(para + '/')

/**
 * Grupo aberto. Abre sozinho quando a rota atual está dentro dele — senão,
 * chegar por link direto mostra o menu fechado na página em que se está.
 */
const abertos = ref<string[]>([])
watchEffect(() => {
  for (const i of itens.value) {
    if (i.filhos?.some((f) => ativo(f.para)) && !abertos.value.includes(i.nome)) {
      abertos.value.push(i.nome)
    }
  }
})
function alternar(i: Item) {
  if (!i.filhos) return navigateTo(i.para)
  const k = abertos.value.indexOf(i.nome)
  if (k >= 0) abertos.value.splice(k, 1)
  else abertos.value.push(i.nome)
}

const trilha = computed(() => {
  const t: { texto: string; para?: string }[] = [{ texto: 'EVENTOS', para: '/admin' }]
  if (evento.value?.nome) t.push({ texto: evento.value.nome.toUpperCase(), para: `${base.value}/dashboard` })
  const ultima = route.path.split('/').filter(Boolean).pop()
  // 'admin' e o próprio id não são página: viram ruído na trilha.
  if (ultima && ultima !== 'admin' && ultima !== eventoId.value) {
    t.push({ texto: ultima.replace(/-/g, ' ').toUpperCase() })
  }
  return t
})

const situacao: Record<string, { texto: string; classe: string }> = {
  ativo: { texto: 'PUBLICADO', classe: 'selo-ok' },
  rascunho: { texto: 'RASCUNHO', classe: 'selo-neutro' },
  pausado: { texto: 'PAUSADO', classe: 'selo-alerta' },
  encerrado: { texto: 'ENCERRADO', classe: 'selo-neutro' },
}
</script>

<template>
  <div class="min-h-screen">
    <!-- ============================================================ menu -->
    <nav class="fixed inset-y-0 left-0 z-20 flex w-menu flex-col bg-menu text-white">
      <div class="flex h-[59px] items-center px-4">
        <NuxtLink to="/admin" class="titulo text-xl font-black tracking-tight">
          diamond<span class="font-normal opacity-70">.tickets</span>
        </NuxtLink>
      </div>

      <NuxtLink v-if="eventoId" to="/admin"
                class="flex items-center gap-3 px-4 py-3 text-[15px] text-white/80 hover:text-white">
        <IconeMenu nome="voltar" /> Voltar
      </NuxtLink>

      <ul class="mt-1 flex-1 overflow-y-auto">
        <li v-for="i in itens" :key="i.para">
          <component :is="i.filhos ? 'button' : 'NuxtLink'"
                     :to="i.filhos ? undefined : i.para"
                     :type="i.filhos ? 'button' : undefined"
                     class="flex h-[51px] w-full items-center gap-3 border-l-2 pl-3 pr-4 text-left text-[15px] transition-colors"
                     :class="ativo(i.para)
                       ? 'border-menu-ativo bg-white/10 text-white'
                       : 'border-transparent text-white/85 hover:bg-white/5 hover:text-white'"
                     @click="i.filhos && alternar(i)">
            <IconeMenu :nome="i.icone" />
            <span class="flex-1 truncate">{{ i.nome }}</span>
            <IconeMenu v-if="i.filhos" nome="seta" :tamanho="16"
                       class="opacity-50 transition-transform"
                       :class="abertos.includes(i.nome) && 'rotate-90'" />
          </component>

          <!-- filhos do grupo: fundo mais escuro, o ativo em barra branca -->
          <ul v-if="i.filhos && abertos.includes(i.nome)" class="bg-black/15">
            <li v-for="f in i.filhos" :key="f.para">
              <NuxtLink :to="f.para"
                        class="flex h-[44px] items-center border-l-2 pl-[46px] pr-4 text-[15px] transition-colors"
                        :class="route.path === f.para
                          ? 'border-white bg-white/10 text-white'
                          : 'border-transparent text-white/70 hover:bg-white/5 hover:text-white'">
                {{ f.nome }}
              </NuxtLink>
            </li>
          </ul>
        </li>
      </ul>

      <p class="px-4 py-4 text-xs text-white/40">1.0.0</p>
    </nav>

    <!-- ========================================================== conteúdo -->
    <div class="pl-menu">
      <header class="flex h-[59px] items-center gap-3 px-6">
        <nav class="flex min-w-0 items-center gap-2 text-sm">
          <template v-for="(t, i) in trilha" :key="i">
            <span v-if="i" class="text-tinta-fraca">/</span>
            <NuxtLink v-if="t.para" :to="t.para" class="truncate font-medium text-acao hover:underline">
              {{ t.texto }}
            </NuxtLink>
            <span v-else class="truncate text-tinta-suave">{{ t.texto }}</span>
          </template>
        </nav>
        <span v-if="evento?.status" :class="situacao[evento.status]?.classe ?? 'selo-neutro'">
          {{ situacao[evento.status]?.texto ?? evento.status.toUpperCase() }}
        </span>

        <div class="ml-auto flex items-center gap-4 text-tinta-suave">
          <button type="button" class="hover:text-tinta" aria-label="Notificações">
            <IconeMenu nome="sino" />
          </button>
          <NuxtLink to="/admin/suporte" class="hover:text-tinta" aria-label="Suporte">
            <IconeMenu nome="chat" />
          </NuxtLink>
          <div class="relative">
            <button type="button"
                    class="flex items-center gap-2 rounded-full border border-linha bg-white py-1 pl-1 pr-3"
                    @click="menuAberto = !menuAberto">
              <span class="flex h-7 w-7 items-center justify-center rounded-full bg-menu text-xs font-bold text-white">
                {{ iniciais }}
              </span>
              <span class="text-sm text-tinta">{{ eu?.usuario?.nome ?? 'Entrar' }}</span>
            </button>

            <div v-if="menuAberto"
                 class="absolute right-0 top-full z-20 mt-1 w-56 rounded-card border border-linha bg-white py-1 shadow-lg">
              <template v-if="eu?.usuario">
                <p class="px-3 py-2 text-xs text-tinta-fraca">
                  {{ eu.usuario.email }}<br>
                  <span class="text-tinta-suave">acesso: {{ eu.usuario.papel }}</span>
                </p>
                <hr class="border-linha">
                <button type="button"
                        class="w-full px-3 py-2 text-left text-sm text-tinta hover:bg-fundo-cinza"
                        @click="sair">
                  Sair
                </button>
              </template>
              <NuxtLink v-else to="/entrar"
                        class="block px-3 py-2 text-sm text-tinta hover:bg-fundo-cinza">
                Entrar
              </NuxtLink>
            </div>
          </div>
        </div>
      </header>

      <main class="px-6 pb-12">
        <slot />
      </main>
    </div>
  </div>
</template>
