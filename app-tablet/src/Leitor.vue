<script setup lang="ts">
/**
 * "Leitor": testar a leitura de pulseira no tablet e acertar o NFC embutido.
 *
 * Encostar uma pulseira aqui só MOSTRA o número (não abre conta, não lança nada): serve pra
 * conferir se o NFC do tablet dá o mesmo número que o leitor USB. Se não der, troca a ordem.
 */
import { useLeitorDePulseira } from '~/composables/comandaLeitor'
import { nfc, trocarOrdem, type OrdemDosBytes } from './nfc'

defineEmits<{ fechar: [] }>()

const lidas = ref<{ numero: string; de: string; em: string }[]>([])
useLeitorDePulseira((numero) => {
  const doNfc = nfc.ultima.value && nfc.ultima.value.numero === numero && Date.now() - nfc.ultima.value.em < 1500
  lidas.value = [{ numero, de: doNfc ? 'NFC do tablet' : 'Leitor USB', em: new Date().toLocaleTimeString('pt-BR') }, ...lidas.value].slice(0, 6)
})

const ORDENS: { id: OrdemDosBytes; nome: string }[] = [
  { id: 'invertida', nome: 'Padrão (invertida)' },
  { id: 'normal', nome: 'Normal' },
]
</script>

<template>
  <div class="space-y-4" data-tela="leitor">
    <div class="card space-y-1 p-5">
      <div class="flex items-center justify-between gap-3">
        <p class="titulo-bloco">Testar leitor de pulseira</p>
        <button type="button" class="btn-secundario min-h-[44px] px-4" @click="$emit('fechar')">Voltar ao atendimento</button>
      </div>
      <p class="text-sm text-ink-600">Encoste uma pulseira no tablet ou no leitor USB. Aqui ela só aparece na lista: nenhuma conta é aberta ou mexida.</p>
    </div>

    <div class="grid gap-4 md:grid-cols-2">
      <div class="card space-y-3 p-5">
        <p class="titulo-bloco">NFC do tablet</p>
        <p v-if="!nfc.existe.value" class="text-sm text-ink-600">Não encontrado. No navegador do PC isso é normal: o NFC embutido só funciona no app instalado no tablet. Use o leitor USB.</p>
        <p v-else-if="!nfc.ligado.value" class="faixa-erro text-sm">O NFC do tablet está desligado. Ligue em Configurações do Android → Conexões → NFC.</p>
        <p v-else class="selo-ok inline-block">Ligado: encoste a pulseira atrás do tablet</p>

        <div>
          <p class="text-sm font-semibold text-ink-700">Ordem do número</p>
          <p class="text-xs text-ink-600">Se o número do NFC do tablet sair diferente do leitor USB para a MESMA pulseira, troque aqui.</p>
          <div class="mt-2 inline-flex rounded-card bg-ink-50 p-1">
            <button v-for="o in ORDENS" :key="o.id" type="button"
                    class="min-h-[44px] rounded-card px-4 text-sm font-semibold"
                    :class="nfc.ordem.value === o.id ? 'bg-white text-acao shadow-sm' : 'text-ink-600'"
                    @click="trocarOrdem(o.id)">{{ o.nome }}</button>
          </div>
        </div>
      </div>

      <div class="card space-y-3 p-5">
        <p class="titulo-bloco">Leitor USB</p>
        <p class="text-sm text-ink-600">Ligue o leitor no tablet com o adaptador OTG. Ele funciona sozinho: encostou, ele "digita" o número da pulseira.</p>
      </div>
    </div>

    <div class="card overflow-hidden">
      <p class="titulo-bloco px-5 pt-5">Últimas leituras</p>
      <p v-if="!lidas.length" class="px-5 pb-5 pt-1 text-sm text-ink-600">Nenhuma ainda. Encoste uma pulseira.</p>
      <ul v-else class="mt-3 divide-y divide-linha">
        <li v-for="(l, i) in lidas" :key="i" class="flex items-center justify-between gap-3 px-5 py-3">
          <span class="font-mono text-xl font-bold tracking-wider text-ink-900">{{ l.numero }}</span>
          <span class="text-right text-sm text-ink-600">{{ l.de }}<br><span class="text-xs">{{ l.em }}</span></span>
        </li>
      </ul>
    </div>
  </div>
</template>
