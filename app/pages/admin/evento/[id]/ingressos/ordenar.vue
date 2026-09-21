<script setup lang="ts">
/**
 * Ordenar setores (e os lotes dentro de cada um).
 *
 * Esta ordem é a da PÁGINA DE VENDA. O que está em cima é o que a maioria
 * compra — mover o camarote para o topo muda o mix de venda do evento inteiro.
 *
 * Subir/descer em botão, não arrastar. Arrastar exige mouse preciso, quebra no
 * celular e é inacessível por teclado; aqui a mesma ação funciona nos três. E o
 * salvar é explícito: reordenar a cada clique gravaria cinco vezes uma ordem
 * intermediária que a pessoa nem quis.
 */
definePageMeta({ layout: 'admin' })

const route = useRoute()
const id = route.params.id as string

const { data, refresh, pending, error: falha } = await useFetch<any>(
  `/api/admin/evento/${id}/ingressos`)

const erro = ref('')
const salvo = ref('')
const salvando = ref(false)

/** Cópia local que a pessoa mexe. O servidor só vê no "Salvar ordem". */
const setores = ref<any[]>([])
watchEffect(() => {
  if (data.value) setores.value = JSON.parse(JSON.stringify(data.value.setores))
})

/** Compara com o que veio do servidor: sem mudança, o botão não faz nada. */
const mudou = computed(() => {
  if (!data.value) return false
  const antes = data.value.setores.map((s: any) => s.id).join()
  const agora = setores.value.map((s) => s.id).join()
  if (antes !== agora) return true
  return setores.value.some((s, i) => {
    const o = data.value.setores[i]
    return s.lotes.map((l: any) => l.id).join() !== o.lotes.map((l: any) => l.id).join()
  })
})

function mover(lista: any[], i: number, passo: number) {
  const j = i + passo
  if (j < 0 || j >= lista.length) return
  const [x] = lista.splice(i, 1)
  lista.splice(j, 0, x)
  salvo.value = ''
}

async function salvar() {
  erro.value = ''
  salvo.value = ''
  salvando.value = true
  try {
    // Setores primeiro, depois os lotes de cada um. Em pedidos separados de
    // propósito: cada lista é validada inteira contra o evento, e um setor com
    // id estranho não pode gravar a ordem dos lotes dos outros.
    await $fetch(`/api/admin/evento/${id}/ordenar`, {
      method: 'PATCH', body: { o: 'setor', ids: setores.value.map((s) => s.id) },
    })
    for (const s of setores.value) {
      if (s.lotes.length < 2) continue
      await $fetch(`/api/admin/evento/${id}/ordenar`, {
        method: 'PATCH',
        body: { o: 'lote', setorId: s.id, ids: s.lotes.map((l: any) => l.id) },
      })
    }
    await refresh()
    salvo.value = 'Ordem salva. É assim que a página de venda vai mostrar.'
  } catch (e: any) {
    erro.value = e?.data?.statusMessage || 'Não foi possível salvar a ordem.'
  } finally {
    salvando.value = false
  }
}

function desfazer() {
  setores.value = JSON.parse(JSON.stringify(data.value.setores))
  salvo.value = ''
}

const ROTULO_TIPO: Record<string, string> = {
  ingresso: 'Ingresso', passaporte: 'Passaporte / combo', mesa: 'Mesa', camarote: 'Camarote',
}

useHead({ title: 'Ordenar setores' })
</script>

<template>
  <div v-if="data">
    <div class="flex flex-wrap items-start justify-between gap-3 py-5">
      <div>
        <h1 class="titulo text-2xl font-bold text-tinta">Ordenar setores</h1>
        <p class="mt-1 text-tinta-suave">
          A ordem daqui é a ordem da página de venda. O que está em cima é o que mais sai.
        </p>
      </div>
      <div class="flex gap-2">
        <button type="button" class="btn-secundario" :disabled="!mudou" @click="desfazer">Desfazer</button>
        <button type="button" class="btn-primario" :disabled="!mudou || salvando" @click="salvar">
          Salvar ordem
        </button>
      </div>
    </div>

    <AbasSecao :evento-id="id" />

    <p v-if="erro" class="mt-4 rounded-card border border-erro bg-erro-claro px-3 py-2 text-sm text-erro">
      {{ erro }}
    </p>
    <p v-if="salvo" class="mt-4 flex items-center gap-2 rounded-card border border-ok bg-ok-claro px-3 py-2 text-sm text-ok">
      <IconeMenu nome="check" :tamanho="16" /> {{ salvo }}
    </p>
    <p v-if="mudou && !salvo" class="mt-4 rounded-card border border-alerta bg-alerta-claro px-3 py-2 text-sm text-alerta">
      Ordem alterada e ainda não salva.
    </p>

    <p v-if="!setores.length" class="card mt-5 py-12 text-center text-tinta-suave">
      Nenhum setor para ordenar.
    </p>

    <ol v-else class="mt-5 space-y-3">
      <li v-for="(s, i) in setores" :key="s.id" class="card p-0">
        <header class="flex flex-wrap items-center gap-3 px-4 py-3">
          <span class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-acao-fraco
                       text-xs font-bold tabular-nums text-acao">{{ i + 1 }}</span>
          <div class="min-w-0">
            <h2 class="titulo font-bold text-tinta">{{ s.nome }}</h2>
            <p class="text-xs text-tinta-fraca">
              {{ ROTULO_TIPO[s.tipo] }} · {{ s.lotes.length }} lote(s)
            </p>
          </div>
          <div class="ml-auto flex items-center gap-1">
            <button type="button" class="rounded border border-linha-forte p-1.5 text-tinta-suave
                                         hover:bg-fundo-cinza disabled:opacity-30"
                    :disabled="i === 0" aria-label="Subir setor" @click="mover(setores, i, -1)">
              <IconeMenu nome="baixo" :tamanho="16" class="rotate-180" />
            </button>
            <button type="button" class="rounded border border-linha-forte p-1.5 text-tinta-suave
                                         hover:bg-fundo-cinza disabled:opacity-30"
                    :disabled="i === setores.length - 1" aria-label="Descer setor"
                    @click="mover(setores, i, 1)">
              <IconeMenu nome="baixo" :tamanho="16" />
            </button>
          </div>
        </header>

        <ol v-if="s.lotes.length" class="border-t border-linha bg-fundo-cinza/40">
          <li v-for="(l, j) in s.lotes" :key="l.id"
              class="flex items-center gap-3 border-b border-linha px-4 py-2 pl-12 text-sm last:border-0">
            <span class="tabular-nums text-xs text-tinta-fraca">{{ j + 1 }}.</span>
            <span class="font-medium text-tinta">{{ l.nome }}</span>
            <span v-if="!l.visivel" class="selo-neutro">OCULTO</span>
            <span class="text-xs text-tinta-fraca">
              {{ (l.totalCents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) }}
            </span>
            <div class="ml-auto flex items-center gap-1">
              <button type="button" class="rounded border border-linha-forte p-1 text-tinta-suave
                                           hover:bg-white disabled:opacity-30"
                      :disabled="j === 0" aria-label="Subir lote" @click="mover(s.lotes, j, -1)">
                <IconeMenu nome="baixo" :tamanho="14" class="rotate-180" />
              </button>
              <button type="button" class="rounded border border-linha-forte p-1 text-tinta-suave
                                           hover:bg-white disabled:opacity-30"
                      :disabled="j === s.lotes.length - 1" aria-label="Descer lote"
                      @click="mover(s.lotes, j, 1)">
                <IconeMenu nome="baixo" :tamanho="14" />
              </button>
            </div>
          </li>
        </ol>
      </li>
    </ol>
  </div>

  <p v-else-if="pending" class="card mt-6 text-tinta-suave">Carregando…</p>

  <div v-else class="card mt-6">
    <p class="rotulo-kpi text-erro">Não foi possível carregar os setores</p>
    <p class="mt-1 text-sm text-tinta-suave">
      {{ (falha as any)?.data?.statusMessage || (falha as any)?.message || 'Erro desconhecido.' }}
    </p>
    <button type="button" class="btn-secundario mt-3" @click="refresh()">Tentar de novo</button>
  </div>
</template>
