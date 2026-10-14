<script setup lang="ts">
/**
 * /conectar-whatsapp/<token> — o link que o dono manda pra quem tem o celular do WhatsApp do parque
 * quando a sessão cai ("logged out from another device"): abre, lê o QR com o WhatsApp e pronto.
 * O QR vale ~2 min, então a página pede um novo sozinha enquanto estiver desconectada e confere o
 * estado a cada poucos segundos. Servidor: server/utils/conectar-whatsapp.ts.
 */
const route = useRoute()
const token = encodeURIComponent(String(route.params.token ?? ''))
useHead({ title: 'Conectar o WhatsApp', meta: [{ name: 'robots', content: 'noindex' }] })

type Estado = { estado: 'conectado' | 'conectando' | 'desconectado'; qrcode: string | null; numero: string | null }
const info = ref<Estado | null>(null)
const falha = ref<'link' | 'servico' | null>(null)
const gerando = ref(false)
let qrGeradoEm = 0
let tique: ReturnType<typeof setInterval> | null = null
let ocupado = false

function classificar(e: any) {
  falha.value = (e?.statusCode ?? e?.response?.status) === 404 ? 'link' : 'servico'
}

async function ler() {
  try {
    info.value = await $fetch<Estado>(`/api/conectar-whatsapp/${token}`, { retry: 0 })
    falha.value = null
  } catch (e) { classificar(e) }
}

async function novoQr() {
  gerando.value = true
  try {
    info.value = await $fetch<Estado>(`/api/conectar-whatsapp/${token}/qr`, { method: 'POST', retry: 0 })
    qrGeradoEm = Date.now()
    falha.value = null
  } catch (e) { classificar(e) } finally { gerando.value = false }
}

async function rodada() {
  if (ocupado || falha.value === 'link') return
  ocupado = true
  try {
    await ler()
    const i = info.value
    // sem QR na tela, ou com mais de 90 s (o do WhatsApp morre aos ~120): pede outro
    if (i && i.estado !== 'conectado' && (!i.qrcode || Date.now() - qrGeradoEm > 90_000)) await novoQr()
  } finally { ocupado = false }
}

onMounted(() => { rodada(); tique = setInterval(rodada, 4000) })
onBeforeUnmount(() => { if (tique) clearInterval(tique) })
</script>

<template>
  <main class="min-h-dvh bg-sun-50 px-4 py-6">
    <div class="mx-auto grid w-full max-w-md gap-4">
      <div v-if="falha === 'link'" class="card text-center" role="alert" data-parte="link-invalido">
        <p class="titulo text-xl font-semibold text-tinta">Link não encontrado</p>
        <p class="mt-1 text-sm text-tinta-suave">Peça um link novo a quem te mandou este.</p>
      </div>

      <template v-else>
        <header class="text-center">
          <p class="titulo text-2xl font-extrabold text-tinta">WhatsApp do Conquista Park</p>
          <p v-if="info?.numero" class="mt-1 text-sm text-tinta-suave">Número {{ info.numero }}</p>
        </header>

        <div v-if="info?.estado === 'conectado'" class="card text-center" role="status" data-parte="conectado">
          <p class="titulo text-xl font-semibold text-success-600">WhatsApp conectado ✓</p>
          <p class="mt-1 text-sm text-tinta-suave">Pronto. O atendimento e o envio de ingressos já voltaram. Pode fechar esta página.</p>
        </div>

        <template v-else>
          <div class="card grid justify-items-center gap-3 text-center" data-parte="qr">
            <img v-if="info?.qrcode" :src="info.qrcode" alt="QR Code do WhatsApp" width="280" height="280"
                 class="h-auto w-full max-w-[280px] rounded-lg bg-white">
            <p v-else class="py-16 text-sm text-tinta-suave" role="status">Gerando o QR Code…</p>
            <button type="button" class="btn btn-primario" :disabled="gerando" @click="novoQr">
              {{ gerando ? 'Gerando…' : 'Gerar outro QR Code' }}
            </button>
          </div>

          <ol class="card grid gap-2 text-sm text-tinta-corpo" data-parte="passos">
            <li><strong>1.</strong> No celular do número do parque, abra o <strong>WhatsApp</strong>.</li>
            <li><strong>2.</strong> Toque em <strong>Configurações</strong> (ou nos ⋮) → <strong>Aparelhos conectados</strong>.</li>
            <li><strong>3.</strong> Toque em <strong>Conectar um aparelho</strong> e aponte a câmera para o QR Code acima.</li>
            <li><strong>4.</strong> Espere esta página mostrar “conectado”. Não precisa fazer mais nada.</li>
          </ol>
          <p class="text-center text-xs text-tinta-suave">O QR Code renova sozinho. Use a câmera do WhatsApp, não a do celular.</p>
        </template>

        <p v-if="falha === 'servico'" class="text-center text-sm text-danger-600" role="alert">
          Não consegui falar com o serviço do WhatsApp agora. Tentando de novo…
        </p>
      </template>
    </div>
  </main>
</template>
