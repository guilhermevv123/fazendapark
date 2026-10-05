<script setup lang="ts">
/**
 * Caixa do bar (042) — onde a atendente confere o cupom de consumação do Volte Mais quando a câmera
 * não ajuda: digita as 6 letras, vê VÁLIDO/JÁ USADO e dá a baixa. O caminho principal é a câmera
 * do celular no QR do cupom (abre `/consumo/<token>` já com o botão); esta tela é o plano B e a
 * lista do que já foi dado hoje.
 *
 * Moldura da portaria (sem a lateral do painel): quem fica no bar recebe um acesso de PORTARIA —
 * a mesma porta única de ler um código e responder (utils/papeis.ts).
 */
import CaixaDoCupom from '~/components/CaixaDoCupom.vue'
import type { CupomNoCaixa } from '~/composables/cupomImagem'

definePageMeta({ layout: 'portaria' })
useHead({ title: 'Caixa do bar' })

const codigo = ref('')
const cupom = ref<CupomNoCaixa | null>(null)
const erro = ref('')
const buscando = ref(false)
const { data: lista, refresh: releLista } = await useFetch<{ baixas: any[] }>('/api/admin/consumacao', { key: 'caixa-baixas' })

async function conferir() {
  const c = codigo.value.toUpperCase().replace(/[^A-Z0-9]/g, '')
  erro.value = ''
  cupom.value = null
  if (c.length !== 6) { erro.value = 'O código do cupom tem 6 letras/números (ex.: K7M2QX).'; return }
  buscando.value = true
  try {
    cupom.value = (await $fetch<{ cupom: CupomNoCaixa }>('/api/admin/consumacao', { query: { codigo: c } })).cupom
  } catch (e: any) {
    erro.value = e?.data?.statusMessage || e?.statusMessage || 'Não consegui conferir agora. Confira a internet.'
  } finally {
    buscando.value = false
  }
}
function atualizado(c: CupomNoCaixa) {
  cupom.value = c
  releLista()
}
function outro() {
  cupom.value = null
  codigo.value = ''
  erro.value = ''
}
</script>

<template>
  <div class="mx-auto grid w-full max-w-md gap-4 py-5">
    <header>
      <h1 class="titulo text-2xl font-semibold text-tinta">Caixa do bar</h1>
      <p class="mt-1 text-sm text-tinta-suave">
        Cupom de consumação do <strong>Volte Mais</strong>. O jeito mais rápido: aponte a câmera do celular pro QR do cupom
        do cliente — abre a página com o botão de dar baixa. Sem câmera, digite o código:
      </p>
    </header>

    <form class="card grid gap-3" data-parte="form-codigo" @submit.prevent="conferir">
      <label for="cx-codigo" class="rotulo">Código do cupom</label>
      <input id="cx-codigo" v-model="codigo" class="campo text-center font-mono text-2xl uppercase tracking-[0.3em]"
             maxlength="8" autocomplete="off" autocapitalize="characters" spellcheck="false" inputmode="text"
             placeholder="K7M2QX" data-parte="campo-codigo">
      <button type="submit" class="btn-primario w-full py-3 text-base" :disabled="buscando" data-parte="conferir-codigo">
        {{ buscando ? 'Conferindo…' : 'Conferir' }}
      </button>
      <p v-if="erro" class="faixa-erro" role="alert" data-parte="erro-codigo">{{ erro }}</p>
    </form>

    <template v-if="cupom">
      <CaixaDoCupom :cupom="cupom" @atualizado="atualizado" />
      <button type="button" class="btn-secundario w-full" data-parte="outro-cupom" @click="outro">Conferir outro cupom</button>
    </template>

    <section v-if="lista?.baixas?.length" class="card" data-parte="ultimas-baixas">
      <h2 class="titulo text-base font-semibold text-tinta">Últimas baixas</h2>
      <ul class="mt-2 divide-y divide-linha text-sm">
        <li v-for="b in lista.baixas" :key="b.id" class="flex items-center justify-between gap-3 py-2">
          <span class="min-w-0">
            <span class="block truncate font-medium text-tinta">{{ b.titular ?? '—' }}</span>
            <span class="block text-xs text-tinta-fraca">{{ b.em }} · {{ b.codigo }}<template v-if="b.semEntrada"> · liberado sem entrada</template></span>
          </span>
          <span class="shrink-0 font-semibold text-success-700">{{ Number(b.consumacaoBps) / 100 }}%</span>
        </li>
      </ul>
    </section>
  </div>
</template>
