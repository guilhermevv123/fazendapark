<script lang="ts">
/** quanto tempo o mesmo QR precisa SUMIR do quadro pra valer de novo */
export const JANELA_DE_REPETICAO_MS = 2500

/**
 * A decisão do "é o mesmo QR de antes?" — pura, pra teste
 * (`app/composables/leitor-entrada.test.ts`).
 *
 * Com a leitura em andamento (`pausada`), a câmera continua olhando e RENOVA
 * o `visto` do código que está no quadro, mas não dispara nada. Antes o laço
 * simplesmente pulava o quadro enquanto pausado: com 4G lento a resposta
 * levava mais que 2,5 s, o `visto` envelhecia com o QR parado na frente da
 * lente, e no instante em que a pausa acabava o mesmo QR saía de novo — um
 * "já utilizado" piscando por cima do "pode entrar" da mesma pessoa.
 */
export function decidirLeitura(
  ultimo: { texto: string; visto: number }, texto: string, agora: number, pausada: boolean,
): { emitir: boolean; ultimo: { texto: string; visto: number } } {
  if (!texto) return { emitir: false, ultimo }
  const mesmo = texto === ultimo.texto
  if (pausada) {
    // Só renova o que já está sendo lido. Código NOVO durante a pausa não
    // entra na memória: senão, ao despausar, ele contaria como repetido e a
    // segunda pessoa da fila não seria lida.
    return { emitir: false, ultimo: mesmo ? { texto, visto: agora } : ultimo }
  }
  const repetido = mesmo && agora - ultimo.visto < JANELA_DE_REPETICAO_MS
  return { emitir: !repetido, ultimo: { texto, visto: agora } }
}
</script>

<script setup lang="ts">
/**
 * A câmera do celular como leitor de QR — o modo "aparelho na mão" da portaria.
 *
 * Existe AO LADO do campo de código da tela de validação, não no lugar dele: o
 * campo é o modo "coletor" (leitor USB ou Bluetooth é um teclado, digita e dá
 * Enter), e este é o modo "câmera". Os dois entregam o mesmo texto pra mesma
 * função `ler()` da tela, então a decisão (assinatura, uso único, offline) é
 * uma só — quem muda é só como o texto chega.
 *
 * Como decodifica:
 *   • `BarcodeDetector` quando o navegador tem (Chrome no Android): usa o
 *     decodificador nativo do aparelho, é rápido e quase não gasta bateria.
 *   • `jsQR` quando não tem (iPhone, Chrome de computador): lê o quadro num
 *     canvas reduzido. Carregado só aqui, sob demanda — quem opera com leitor
 *     USB nunca baixa esse pedaço.
 *
 * O mesmo QR na frente da câmera NÃO dispara duas leituras. Esse era o risco
 * real: a câmera vê o código 8 vezes por segundo, e o segundo disparo seria um
 * "já utilizado" piscando por cima do "pode entrar". Enquanto o código continuar
 * à vista, conta como a mesma apresentação; só vale de novo depois de ele
 * sumir do quadro por 2,5 segundos.
 *
 * A câmera funciona sem rede (é só `getUserMedia`); a decisão offline é da tela.
 */
const props = defineProps<{
  pausada?: boolean
  /**
   * O veredito da última leitura, pintado em cima da própria imagem: quem
   * aponta o celular pro QR olha pro quadro, não pro cartão lá embaixo.
   * `chave` muda a cada leitura, pra duas respostas iguais seguidas
   * repintarem.
   */
  veredito?: { chave: number; titulo: string; detalhe: string; classe: string } | null
}>()
const emit = defineEmits<{ ler: [texto: string] }>()

const video = ref<HTMLVideoElement | null>(null)
const mostrando = ref(false)
let apagar: ReturnType<typeof setTimeout> | undefined
// Só reage a leitura NOVA: o veredito que já estava na tela quando a câmera
// abriu não é desta apresentação.
watch(() => props.veredito?.chave, (novo, antigo) => {
  if (novo === undefined || novo === antigo) return
  mostrando.value = true
  clearTimeout(apagar)
  apagar = setTimeout(() => { mostrando.value = false }, 2200)
})
const erro = ref('')
const pronta = ref(false)
/** `null` = o aparelho não tem lanterna; senão, ligada ou não */
const lanterna = ref<boolean | null>(null)

let stream: MediaStream | null = null
let encerrada = false
let ultimo = { texto: '', visto: 0 }

function fechar() {
  encerrada = true
  clearTimeout(apagar)
  stream?.getTracks().forEach((t) => t.stop())
  stream = null
}

async function abrir() {
  erro.value = ''
  pronta.value = false
  if (!navigator.mediaDevices?.getUserMedia) {
    erro.value = 'A câmera só abre em conexão segura (https). Use o campo de código.'
    return
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } },
      audio: false,
    })
  } catch (e: any) {
    erro.value = e?.name === 'NotAllowedError'
      ? 'A câmera está bloqueada. Permita o uso dela nas configurações do navegador e tente de novo.'
      : e?.name === 'NotFoundError'
        ? 'Este aparelho não tem câmera. Use o campo de código.'
        : 'Não deu pra abrir a câmera. Feche outros apps que a estejam usando e tente de novo.'
    return
  }
  // Saiu do modo câmera enquanto o navegador perguntava a permissão.
  if (encerrada) { fechar(); return }

  const el = video.value
  if (!el) return
  el.srcObject = stream
  await el.play().catch(() => { /* o autoplay já cobre */ })
  const caps: any = stream.getVideoTracks()[0]?.getCapabilities?.() ?? {}
  lanterna.value = caps.torch ? false : null
  pronta.value = true
  varrer()
}

async function alternarLanterna() {
  const faixa = stream?.getVideoTracks()[0]
  if (!faixa) return
  const ligar = !lanterna.value
  try {
    await faixa.applyConstraints({ advanced: [{ torch: ligar } as any] })
    lanterna.value = ligar
  } catch { /* sem lanterna de verdade: o botão só não faz nada */ }
}

async function varrer() {
  const Nativo = (window as any).BarcodeDetector
  let detector: any = null
  let jsQR: any = null
  if (Nativo) {
    try { detector = new Nativo({ formats: ['qr_code'] }) } catch { detector = null }
  }
  if (!detector) {
    try {
      jsQR = (await import('jsqr')).default
    } catch {
      erro.value = 'Não deu pra carregar o leitor de câmera. Confira a rede e tente de novo.'
      return
    }
  }

  const tela = document.createElement('canvas')
  const ctx = tela.getContext('2d', { willReadFrequently: true })
  while (!encerrada) {
    await new Promise((r) => setTimeout(r, 140))
    const el = video.value
    // Pausada NÃO pula o quadro: ela ainda precisa renovar o "visto" do QR
    // que está na frente da lente (ver `decidirLeitura`).
    if (encerrada || !el || document.hidden || el.readyState < 2 || !el.videoWidth) continue

    let texto = ''
    try {
      if (detector) {
        texto = (await detector.detect(el))[0]?.rawValue ?? ''
      } else if (ctx) {
        // 640px de largura bastam pra um QR de ingresso e mantêm o celular frio.
        const w = Math.min(640, el.videoWidth)
        tela.width = w
        tela.height = Math.round(el.videoHeight * (w / el.videoWidth))
        ctx.drawImage(el, 0, 0, tela.width, tela.height)
        const img = ctx.getImageData(0, 0, tela.width, tela.height)
        texto = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' })?.data ?? ''
      }
    } catch { /* quadro ruim: o próximo resolve */ }
    if (!texto) continue

    const decisao = decidirLeitura(ultimo, texto, Date.now(), Boolean(props.pausada))
    ultimo = decisao.ultimo
    if (decisao.emitir) emit('ler', texto)
  }
}

onMounted(abrir)
onBeforeUnmount(fechar)
</script>

<template>
  <div class="mx-auto w-full max-w-md">
    <div class="relative aspect-[4/3] overflow-hidden rounded-2xl bg-ink-950 ring-1 ring-ink-200">
      <video ref="video" class="h-full w-full object-cover" playsinline muted autoplay />
      <div v-if="pronta" aria-hidden="true" class="pointer-events-none absolute inset-0 grid place-items-center">
        <div class="size-3/5 rounded-2xl border-2 border-white/80 shadow-[0_0_0_9999px_rgba(18,15,29,0.35)]" />
      </div>
      <p v-if="!pronta && !erro" class="absolute inset-0 grid place-items-center text-sm text-white/80">
        Abrindo a câmera…
      </p>
      <button v-if="lanterna !== null" type="button"
              class="absolute right-3 top-3 rounded-xl bg-white/90 px-3 py-1.5 text-sm font-semibold text-tinta"
              :aria-pressed="lanterna" @click="alternarLanterna">
        {{ lanterna ? 'Apagar lanterna' : 'Lanterna' }}
      </button>
      <!-- O veredito por cima da imagem, do tamanho de quem lê de relance. Sem
           <Transition>: com a aba escondida o Vue deixa o elemento em opacidade 0. -->
      <div v-if="mostrando && veredito" role="status"
           class="absolute inset-0 grid place-content-center gap-1 p-4 text-center text-white"
           :class="veredito.classe">
        <p class="titulo text-3xl font-semibold">{{ veredito.titulo }}</p>
        <p v-if="veredito.detalhe" class="text-base">{{ veredito.detalhe }}</p>
      </div>
    </div>
    <p v-if="erro" class="faixa-erro mt-3" role="alert">
      {{ erro }}
      <button type="button" class="font-semibold underline" @click="abrir">Tentar de novo</button>
    </p>
    <p v-else-if="pronta" class="mt-2 text-center text-sm text-tinta-suave">
      Aponte o QR do ingresso para o quadro.
    </p>
  </div>
</template>
