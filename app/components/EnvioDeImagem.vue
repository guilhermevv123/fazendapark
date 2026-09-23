<script setup lang="ts">
/**
 * Área de envio de imagem: clique ou arraste, com prévia no FORMATO em que a
 * imagem aparece pro público (capa larga, miniatura quadrada).
 *
 * Substitui o campo "https://…" (dono, 22/09: "não existe o cara colocar a
 * URL"). Quem opera um parque tem a foto no celular ou no computador, não um
 * link. O componente só ESCOLHE e confere o arquivo; quem sobe é a tela:
 *   - na criação o evento ainda não existe (a rota de upload precisa do id),
 *     então a tela guarda o File e sobe depois de gravar o evento;
 *   - nas configurações a tela sobe na hora.
 *
 * A conferência daqui (tipo e 8MB) é a mesma de `imagem.post.ts`: recusar no
 * navegador poupa esperar um upload inteiro pra ouvir "não".
 */
const props = defineProps<{
  rotulo: string
  /** a frase de medida, ex. "1600 × 900, horizontal" */
  medida: string
  /** proporção CSS da prévia, ex. "16 / 9" ou "1 / 1" */
  proporcao: string
  /** o que já está salvo (URL do bucket) — ou nada */
  url?: string | null
  /** arquivo escolhido e ainda não enviado (criação) */
  arquivo?: File | null
  enviando?: boolean
}>()
const emit = defineEmits<{ escolher: [File]; remover: [] }>()

const TIPOS = ['image/jpeg', 'image/png', 'image/webp']
const MAXIMO = 8 * 1024 * 1024

const entrada = ref<HTMLInputElement | null>(null)
const arrastando = ref(false)
const aviso = ref('')

// prévia do arquivo local: URL de objeto, revogada ao trocar/desmontar pra
// não vazar memória a cada foto escolhida
const previaLocal = ref<string | null>(null)
watch(() => props.arquivo, (a) => {
  if (previaLocal.value) URL.revokeObjectURL(previaLocal.value)
  previaLocal.value = a ? URL.createObjectURL(a) : null
}, { immediate: true })
onBeforeUnmount(() => { if (previaLocal.value) URL.revokeObjectURL(previaLocal.value) })

const previa = computed(() => previaLocal.value || props.url || null)

function conferir(a: File | undefined | null) {
  aviso.value = ''
  if (!a) return
  if (!TIPOS.includes(a.type)) { aviso.value = 'Envie uma foto em JPG, PNG ou WEBP.'; return }
  if (a.size > MAXIMO) { aviso.value = `A foto tem ${(a.size / 1024 / 1024).toFixed(1).replace('.', ',')}MB — o máximo é 8MB.`; return }
  emit('escolher', a)
}

function aoEscolher(ev: Event) {
  const input = ev.target as HTMLInputElement
  conferir(input.files?.[0])
  // escolher o MESMO arquivo de novo tem que disparar `change` outra vez
  input.value = ''
}
function aoSoltar(ev: DragEvent) {
  arrastando.value = false
  conferir(ev.dataTransfer?.files?.[0])
}
const abrir = () => { if (!props.enviando) entrada.value?.click() }
</script>

<template>
  <div>
    <p class="rotulo">{{ rotulo }}</p>
    <div class="relative overflow-hidden rounded-2xl transition-colors"
         :class="previa
           ? 'ring-1 ring-ink-200'
           : arrastando
             ? 'border-2 border-dashed border-pool-600 bg-pool-50'
             : 'border-2 border-dashed border-ink-300 bg-fundo-cinza hover:border-pool-500 hover:bg-pool-50/60'"
         :style="{ aspectRatio: proporcao }"
         @dragover.prevent="arrastando = true"
         @dragleave.prevent="arrastando = false"
         @drop.prevent="aoSoltar">
      <!-- vazia: a área inteira é o botão -->
      <button v-if="!previa" type="button"
              class="flex size-full flex-col items-center justify-center gap-2 p-4 text-center"
              :aria-label="`${rotulo}: escolher imagem`" @click="abrir">
        <span class="grid size-12 place-items-center rounded-full bg-white text-pool-700 shadow-sm ring-1 ring-pool-200"
              :class="arrastando && 'animate-pop'">
          <IconeMenu nome="mais" :tamanho="24" />
        </span>
        <span class="titulo text-[15px] font-semibold text-tinta">
          {{ arrastando ? 'Solte a imagem aqui' : 'Clique ou arraste a imagem' }}
        </span>
        <span class="text-[12.5px] text-tinta-suave">{{ medida }} · JPG, PNG ou WEBP até 8MB</span>
      </button>

      <!-- com imagem: a prévia no formato real, e as duas ações por cima -->
      <template v-else>
        <img :src="previa" :alt="`Prévia: ${rotulo}`" class="size-full object-cover">
        <div class="absolute inset-x-0 bottom-0 flex items-center justify-end gap-2 bg-gradient-to-t from-ink-950/70 to-transparent p-2.5 pt-8">
          <span v-if="arquivo && !enviando" class="mr-auto rounded-md bg-white/90 px-2 py-0.5 text-[11.5px] font-semibold text-tinta">
            Sobe ao criar o evento
          </span>
          <button type="button" class="btn bg-white px-3 py-1.5 text-[13px] text-tinta shadow-sm hover:bg-ink-50"
                  :disabled="enviando" @click="abrir">
            Trocar
          </button>
          <button type="button" class="btn bg-white/15 px-3 py-1.5 text-[13px] text-white ring-1 ring-inset ring-white/60 hover:bg-white/25"
                  :disabled="enviando" @click="aviso = ''; emit('remover')">
            Remover
          </button>
        </div>
        <div v-if="enviando" class="absolute inset-0 grid place-items-center bg-white/70 text-sm font-semibold text-pool-800" role="status">
          Enviando…
        </div>
      </template>

      <input ref="entrada" type="file" accept="image/jpeg,image/png,image/webp" class="hidden" @change="aoEscolher">
    </div>
    <p v-if="aviso" class="mt-1.5 text-[13px] font-medium text-erro" role="alert">{{ aviso }}</p>
  </div>
</template>
