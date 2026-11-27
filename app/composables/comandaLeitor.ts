/**
 * O leitor de pulseira USB (055) — ele é um TECLADO: encostou a pulseira, ele digita o
 * número (ex.: 0110264695) e aperta Enter, tudo em poucos milissegundos.
 *
 * Esta escuta separa o leitor de uma pessoa digitando pela VELOCIDADE: o leitor manda cada
 * tecla em menos de ~50 ms; ninguém digita 10 números assim. Só vale a sequência rápida
 * terminada em Enter. Se o foco estava num campo (a busca, o nome do cliente), os números que
 * o leitor despejou ali são tirados de volta — a leitura não suja o que a pessoa escrevia.
 *
 * A mesma pulseira lida de novo em menos de 2 s é ignorada (encostou e tremeu).
 */
import { onBeforeUnmount, onMounted, type Ref } from 'vue'

export const GAP_DO_LEITOR_MS = 60
export const REPETICAO_MS = 2000

export interface Tecla { tecla: string; em: number }

/** Decide, pelo histórico de teclas até o Enter, se foi o leitor. Puro, pra teste. */
export function leituraDoLeitor(teclas: Tecla[], enterEm: number): string | null {
  if (teclas.length < 6 || teclas.length > 24) return null
  if (enterEm - teclas[teclas.length - 1].em > GAP_DO_LEITOR_MS * 2) return null
  for (let i = 1; i < teclas.length; i++) {
    if (teclas[i].em - teclas[i - 1].em > GAP_DO_LEITOR_MS) return null
  }
  const uid = teclas.map((t) => t.tecla).join('')
  return /^[0-9A-Za-z]+$/.test(uid) ? uid : null
}

export function useLeitorDePulseira(aoLer: (uid: string) => void, ativo?: Ref<boolean>) {
  let teclas: Tecla[] = []
  let ultimo = { uid: '', em: 0 }

  function tecla(e: KeyboardEvent) {
    if (ativo && !ativo.value) return
    const agora = performance.now()
    if (e.key === 'Enter') {
      const uid = leituraDoLeitor(teclas, agora)
      const qtd = teclas.length
      teclas = []
      if (!uid) return
      e.preventDefault()
      e.stopPropagation()
      // o leitor digitou dentro de um campo: devolve o campo como estava
      const alvo = e.target as HTMLInputElement | null
      if (alvo && (alvo.tagName === 'INPUT' || alvo.tagName === 'TEXTAREA') && typeof alvo.value === 'string'
        && alvo.value.endsWith(uid)) {
        alvo.value = alvo.value.slice(0, alvo.value.length - qtd)
        alvo.dispatchEvent(new Event('input', { bubbles: true }))
      }
      const now = Date.now()
      if (uid === ultimo.uid && now - ultimo.em < REPETICAO_MS) return
      ultimo = { uid, em: now }
      aoLer(uid)
      return
    }
    if (e.key.length !== 1 || !/[0-9A-Za-z]/.test(e.key)) { teclas = []; return }
    const anterior = teclas[teclas.length - 1]
    if (anterior && agora - anterior.em > GAP_DO_LEITOR_MS) teclas = []
    teclas.push({ tecla: e.key, em: agora })
    if (teclas.length > 30) teclas = teclas.slice(-30)
  }

  onMounted(() => window.addEventListener('keydown', tecla, true))
  onBeforeUnmount(() => window.removeEventListener('keydown', tecla, true))
}

/* ------------------------------------------------------------------ bip e vibração */

let audio: AudioContext | null = null

/** Bip curto = deu certo; dois bips graves = erro. O atendente não precisa olhar a tela. */
export function bip(tipo: 'ok' | 'erro' = 'ok') {
  try {
    audio = audio ?? new (window.AudioContext || (window as any).webkitAudioContext)()
    const tocar = (freq: number, ini: number, dur: number) => {
      const o = audio!.createOscillator()
      const g = audio!.createGain()
      o.frequency.value = freq
      o.type = 'square'
      g.gain.setValueAtTime(0.06, audio!.currentTime + ini)
      g.gain.exponentialRampToValueAtTime(0.0001, audio!.currentTime + ini + dur)
      o.connect(g).connect(audio!.destination)
      o.start(audio!.currentTime + ini)
      o.stop(audio!.currentTime + ini + dur)
    }
    if (tipo === 'ok') tocar(1760, 0, 0.09)
    else { tocar(330, 0, 0.14); tocar(260, 0.18, 0.2) }
    navigator.vibrate?.(tipo === 'ok' ? 60 : [120, 80, 120])
  } catch { /* sem som: a tela continua dizendo */ }
}
