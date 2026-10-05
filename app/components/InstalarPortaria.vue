<script setup lang="ts">
/**
 * "Instalar o app da Portaria" (dono, 05/10): enquanto não há app na loja, a portaria vira app pela
 * TELA INICIAL do celular — abre em tela cheia, com o ícone da Portaria, e funciona sem internet
 * (service worker `sw-portaria.js`).
 *
 * - **Android (Chrome):** o navegador dispara `beforeinstallprompt`; guardamos o evento e o botão
 *   "Instalar" abre a janela nativa. Sem o evento (outro navegador, já instalado), sai o passo a
 *   passo pelo menu ⋮.
 * - **iPhone/iPad:** o Safari não tem botão de instalar — só o passo a passo (Compartilhar →
 *   Adicionar à Tela de Início). No iPhone o app instalado tem MEMÓRIA SEPARADA do Safari: a lista
 *   baixada no Safari não vai junto, então o aviso pede pra abrir pelo ícone e baixar lá.
 * - Já aberto como app (`display-mode: standalone` / `navigator.standalone`): não aparece.
 * - "Agora não" esconde por 7 dias neste aparelho.
 */
const CHAVE_ADIADO = 'dt_portaria_instalar_adiado'
const SETE_DIAS = 7 * 24 * 3600_000

const visivel = ref(false)
const plataforma = ref<'android' | 'ios' | 'outro'>('outro')
const passos = ref(false)
let pedido: any = null
const podeInstalarDireto = ref(false)

function jaInstalado(): boolean {
  try {
    return window.matchMedia('(display-mode: standalone)').matches || (navigator as any).standalone === true
  } catch { return false }
}

function detectar(): 'android' | 'ios' | 'outro' {
  const ua = navigator.userAgent || ''
  // iPad novo se apresenta como Mac — o toque denuncia
  if (/iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && (navigator as any).maxTouchPoints > 1)) return 'ios'
  if (/Android/i.test(ua)) return 'android'
  return 'outro'
}

function aoPedirInstalacao(e: Event) {
  e.preventDefault()
  pedido = e
  podeInstalarDireto.value = true
}
function aoInstalar() {
  visivel.value = false
}

onMounted(() => {
  if (jaInstalado()) return
  let adiado = 0
  try { adiado = Number(localStorage.getItem(CHAVE_ADIADO) ?? 0) } catch { /* aba anônima */ }
  if (adiado && Date.now() - adiado < SETE_DIAS) return
  plataforma.value = detectar()
  visivel.value = true
  window.addEventListener('beforeinstallprompt', aoPedirInstalacao)
  window.addEventListener('appinstalled', aoInstalar)
})
onBeforeUnmount(() => {
  window.removeEventListener('beforeinstallprompt', aoPedirInstalacao)
  window.removeEventListener('appinstalled', aoInstalar)
})

async function instalar() {
  if (!pedido) { passos.value = true; return }
  try {
    pedido.prompt()
    const escolha = await pedido.userChoice
    if (escolha?.outcome === 'accepted') visivel.value = false
  } catch { passos.value = true }
  pedido = null
  podeInstalarDireto.value = false
}

function adiar() {
  try { localStorage.setItem(CHAVE_ADIADO, String(Date.now())) } catch { /* aba anônima */ }
  visivel.value = false
}
</script>

<template>
  <section v-if="visivel" class="card mt-5 border-l-4 border-acao p-5" data-parte="instalar-portaria">
    <div class="flex items-start gap-3">
      <img src="/brand/icone-portaria-192.png" alt="" width="48" height="48" class="size-12 shrink-0 rounded-xl">
      <div class="min-w-0">
        <h2 class="titulo text-lg font-semibold text-tinta">Instale o app da Portaria</h2>
        <p class="mt-0.5 text-sm text-tinta-suave">
          Fica na tela inicial do celular, abre em tela cheia e continua lendo ingressos mesmo sem internet.
        </p>
      </div>
    </div>

    <div class="mt-4 flex flex-wrap gap-2">
      <button v-if="plataforma !== 'ios'" type="button" data-parte="botao-instalar"
              class="btn-primario px-5 py-3 text-base" @click="instalar">
        {{ podeInstalarDireto ? 'Instalar agora' : 'Como instalar' }}
      </button>
      <button v-else-if="!passos" type="button" data-parte="botao-instalar"
              class="btn-primario px-5 py-3 text-base" @click="passos = true">
        Como instalar no iPhone
      </button>
      <button type="button" class="rounded-md px-4 py-3 text-sm font-semibold text-ink-600 hover:bg-ink-100"
              data-parte="adiar-instalar" @click="adiar">
        Agora não
      </button>
    </div>

    <!-- iPhone: só existe o caminho do Compartilhar -->
    <ol v-if="passos && plataforma === 'ios'" class="mt-4 grid gap-3 text-[15px] text-tinta" data-parte="passos-iphone">
      <li class="flex items-start gap-3">
        <span class="grid size-7 shrink-0 place-items-center rounded-full bg-acao text-sm font-bold text-white">1</span>
        <span>Abra esta página no <strong>Safari</strong> e toque em
          <strong>Compartilhar</strong>
          <svg class="mb-1 inline size-5 text-acao" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
               stroke-linecap="round" stroke-linejoin="round" aria-label="ícone de compartilhar"><path d="M12 3v12M7 8l5-5 5 5" /><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" /></svg>
          (na barra de baixo).</span>
      </li>
      <li class="flex items-start gap-3">
        <span class="grid size-7 shrink-0 place-items-center rounded-full bg-acao text-sm font-bold text-white">2</span>
        <span>Role e toque em <strong>Adicionar à Tela de Início</strong>, depois em <strong>Adicionar</strong>.</span>
      </li>
      <li class="flex items-start gap-3">
        <span class="grid size-7 shrink-0 place-items-center rounded-full bg-acao text-sm font-bold text-white">3</span>
        <span>Abra pelo ícone <strong>Portaria</strong>, entre e <strong>abra o leitor do evento com internet</strong>
          antes de ir pro portão — no iPhone o app guarda a lista separada do Safari.</span>
      </li>
    </ol>

    <!-- Android sem o botão nativo (outro navegador, ou o Chrome ainda não ofereceu) -->
    <ol v-if="passos && plataforma !== 'ios'" class="mt-4 grid gap-3 text-[15px] text-tinta" data-parte="passos-android">
      <li class="flex items-start gap-3">
        <span class="grid size-7 shrink-0 place-items-center rounded-full bg-acao text-sm font-bold text-white">1</span>
        <span>Abra esta página no <strong>Chrome</strong> e toque no menu <strong>⋮</strong> (canto de cima).</span>
      </li>
      <li class="flex items-start gap-3">
        <span class="grid size-7 shrink-0 place-items-center rounded-full bg-acao text-sm font-bold text-white">2</span>
        <span>Toque em <strong>Instalar app</strong> (ou <strong>Adicionar à tela inicial</strong>) e confirme.</span>
      </li>
      <li class="flex items-start gap-3">
        <span class="grid size-7 shrink-0 place-items-center rounded-full bg-acao text-sm font-bold text-white">3</span>
        <span>Abra pelo ícone <strong>Portaria</strong> e abra o leitor do evento uma vez com internet.</span>
      </li>
    </ol>
  </section>
</template>
