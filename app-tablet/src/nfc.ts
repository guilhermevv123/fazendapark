/**
 * NFC do próprio tablet → mesmo número do leitor USB.
 *
 * O leitor USB das comandas (13,56 MHz, emulação de teclado) digita os 4 PRIMEIROS bytes do UID
 * como número decimal de 10 dígitos (formato "8H/10D", ex.: 0110264695). O Android entrega o
 * UID em bytes (`Tag.getId()`); aqui ele vira o MESMO número, pra que uma pulseira lida no
 * tablet e no leitor USB do caixa caia na mesma conta.
 *
 * A ordem dos bytes varia de leitor pra leitor. A maioria dos leitores de teclado manda o UID
 * invertido em relação ao Android, por isso o padrão é "invertida". Se o número do tablet não
 * bater com o do leitor USB, troca em "Leitor" (no topo do app), sem gerar outro APK.
 *
 * Funções puras (`numeroDaPulseira`) testadas em `nfc.test.ts`.
 */
import { Capacitor, registerPlugin } from '@capacitor/core'
import { ref } from 'vue'
import { EVENTO_DA_PULSEIRA } from '~/composables/comandaLeitor'

export type OrdemDosBytes = 'invertida' | 'normal'

/** hex do Android (ex.: "77819206") → número de 10 dígitos do leitor USB */
export function numeroDaPulseira(hex: string, ordem: OrdemDosBytes): string | null {
  const limpo = hex.replace(/[^0-9a-fA-F]/g, '')
  if (limpo.length < 8 || limpo.length % 2) return null
  const bytes = (limpo.slice(0, 8).match(/../g) ?? []).map((b) => parseInt(b, 16))
  const ordenados = ordem === 'invertida' ? [...bytes].reverse() : bytes
  const valor = ordenados.reduce((acc, b) => acc * 256 + b, 0)
  return String(valor).padStart(10, '0')
}

const CHAVE_ORDEM = 'cp_comanda_nfc_ordem'
function ordemGuardada(): OrdemDosBytes {
  try { return localStorage.getItem(CHAVE_ORDEM) === 'normal' ? 'normal' : 'invertida' } catch { return 'invertida' }
}

/** o que a tela "Leitor" mostra */
export const nfc = {
  /** este aparelho tem NFC embutido (só no app Android) */
  existe: ref(false),
  /** o NFC está ligado nas configurações do Android */
  ligado: ref(false),
  ordem: ref<OrdemDosBytes>(ordemGuardada()),
  /** última pulseira lida pelo NFC do tablet: o hex cru e o número que foi pro sistema */
  ultima: ref<{ hex: string; numero: string; em: number } | null>(null),
}

export function trocarOrdem(ordem: OrdemDosBytes) {
  nfc.ordem.value = ordem
  try { localStorage.setItem(CHAVE_ORDEM, ordem) } catch { /* sem storage */ }
}

interface LeitorNfcNativo {
  estado(): Promise<{ existe: boolean; ligado: boolean }>
  addListener(evento: 'pulseira', fn: (d: { hex: string }) => void): Promise<{ remove: () => Promise<void> }>
}
const LeitorNfc = registerPlugin<LeitorNfcNativo>('LeitorNfc')

export async function conferirNfc() {
  if (!Capacitor.isNativePlatform()) return
  try {
    const e = await LeitorNfc.estado()
    nfc.existe.value = e.existe
    nfc.ligado.value = e.ligado
  } catch { /* APK sem o plugin */ }
}

/** Liga a escuta do NFC do tablet (uma vez, no início do app). No navegador do PC não faz nada. */
export async function ligarNfc() {
  if (!Capacitor.isNativePlatform()) return
  await conferirNfc()
  // o NFC pode ser ligado com o app aberto: confere de novo quando o app volta pra frente
  document.addEventListener('visibilitychange', () => { if (!document.hidden) conferirNfc() })
  await LeitorNfc.addListener('pulseira', ({ hex }) => {
    const numero = numeroDaPulseira(hex, nfc.ordem.value)
    if (!numero) return
    nfc.ultima.value = { hex, numero, em: Date.now() }
    window.dispatchEvent(new CustomEvent(EVENTO_DA_PULSEIRA, { detail: { uid: numero } }))
  })
}
