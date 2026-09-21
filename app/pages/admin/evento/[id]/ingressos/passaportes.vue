<script setup lang="ts">
/**
 * Passaportes e grupos.
 *
 * O que separa um passaporte de um ingresso comum são dois números que o
 * schema não tinha até agora:
 *
 *   admite            quantas PESSOAS entram por unidade (mesa de 4 = 4)
 *   sessõesCobertas   quantas SESSÕES a unidade vale (passaporte de 3 dias = 3)
 *
 * Sem os dois, os três tipos são a mesma coisa pro sistema: a portaria conta 1
 * entrada onde deveria contar 4, e o parque lota com o painel mostrando
 * metade. A conta de "lugares de verdade" no rodapé é exatamente unidades ×
 * admite — é ela que responde quantas pessoas cabem, não o estoque.
 */
definePageMeta({ layout: 'admin' })

const route = useRoute()
const id = route.params.id as string

const { data, refresh, pending, error: falha } = await useFetch<any>(
  `/api/admin/evento/${id}/ingressos`)

const reais = (c: number) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
const erro = ref('')
const salvando = ref(false)

/** Só os setores que não são ingresso simples. */
const grupos = computed(() =>
  (data.value?.setores ?? []).filter((s: any) => s.tipo !== 'ingresso'))

const ROTULO: Record<string, string> = {
  passaporte: 'Passaporte / combo', mesa: 'Mesa', camarote: 'Camarote',
}

/** Lugares de verdade: cada unidade vendida leva `admite` pessoas. */
function lugares(s: any) {
  const un = s.lotes.reduce((n: number, l: any) => n + l.quantidade, 0)
  const vendidas = s.lotes.reduce((n: number, l: any) => n + l.vendidos + l.reservados, 0)
  return { unidades: un, vendidas, pessoas: un * s.admite, pessoasVendidas: vendidas * s.admite }
}

const totalPessoas = computed(() =>
  grupos.value.reduce((n: number, s: any) => n + lugares(s).pessoas, 0))

async function salvarCampo(setorId: string, campos: any) {
  erro.value = ''
  salvando.value = true
  try {
    await $fetch(`/api/admin/evento/${id}/ingressos`, {
      method: 'PATCH', body: { o: 'setor', id: setorId, campos },
    })
    await refresh()
  } catch (e: any) {
    erro.value = e?.data?.statusMessage || 'Não foi possível salvar.'
  } finally {
    salvando.value = false
  }
}

const form = reactive({ aberto: false, id: '', admite: 1, sessoesCobertas: null as number | null, descricao: '' })
function abrir(s: any) {
  Object.assign(form, {
    aberto: true, id: s.id, admite: s.admite, sessoesCobertas: s.sessoesCobertas,
    descricao: s.descricao ?? '',
  })
}
async function salvar() {
  await salvarCampo(form.id, {
    admite: form.admite,
    sessoesCobertas: form.sessoesCobertas || null,
    descricao: form.descricao || null,
  })
  if (!erro.value) form.aberto = false
}

useHead({ title: 'Passaportes e grupos' })
</script>

<template>
  <div v-if="data">
    <div class="flex flex-wrap items-start justify-between gap-3 py-5">
      <div>
        <h1 class="titulo text-2xl font-bold text-tinta">Passaportes e grupos</h1>
        <p class="mt-1 text-tinta-suave">
          Setores que não valem uma pessoa por uma sessão: mesa, camarote e passaporte de vários dias.
        </p>
      </div>
      <NuxtLink :to="`/admin/evento/${id}/ingressos`" class="btn-secundario">
        <IconeMenu nome="mais" :tamanho="18" /> Criar setor
      </NuxtLink>
    </div>

    <AbasSecao :evento-id="id" />

    <p v-if="erro" class="mt-4 rounded-card border border-erro bg-erro-claro px-3 py-2 text-sm text-erro">
      {{ erro }}
    </p>

    <div class="mt-5 rounded-card border border-acao/30 bg-acao-fraco px-4 py-3 text-sm text-tinta-corpo">
      <strong class="text-tinta">Por que isso importa:</strong>
      uma mesa de 4 vendida é <em>uma</em> unidade de estoque e <em>quatro</em> pessoas na portaria.
      Quem conta só o estoque descobre a diferença na fila.
    </div>

    <p v-if="!grupos.length" class="card mt-4 py-12 text-center text-tinta-suave">
      Nenhum passaporte, mesa ou camarote neste evento.<br>
      <NuxtLink :to="`/admin/evento/${id}/ingressos`" class="text-acao hover:underline">
        Crie um setor com esse tipo na tela de ingressos.
      </NuxtLink>
    </p>

    <section v-for="s in grupos" :key="s.id" class="card mt-4 p-0">
      <header class="flex flex-wrap items-center gap-3 border-b border-linha px-4 py-3">
        <h2 class="titulo text-base font-bold uppercase tracking-wide text-acao">{{ s.nome }}</h2>
        <span class="selo-neutro">{{ ROTULO[s.tipo] ?? s.tipo }}</span>
        <button type="button" class="p-1 text-tinta-fraca hover:text-acao"
                :aria-label="`Configurar ${s.nome}`" @click="abrir(s)">
          <IconeMenu nome="lapis" :tamanho="16" />
        </button>
        <p class="ml-auto text-sm text-tinta-suave">
          <strong class="text-tinta">{{ s.admite }}</strong> pessoa(s) por unidade
          <template v-if="s.sessoesCobertas">
            · vale <strong class="text-tinta">{{ s.sessoesCobertas }}</strong> sessão(ões)
          </template>
        </p>
      </header>

      <div class="grid gap-4 p-4 sm:grid-cols-4">
        <div>
          <p class="rotulo-kpi">Unidades à venda</p>
          <p class="numero-kpi mt-1">{{ lugares(s).unidades }}</p>
        </div>
        <div>
          <p class="rotulo-kpi">Unidades saídas</p>
          <p class="numero-kpi mt-1">{{ lugares(s).vendidas }}</p>
        </div>
        <div>
          <p class="rotulo-kpi">Pessoas que cabem</p>
          <p class="numero-kpi mt-1 text-acao">{{ lugares(s).pessoas }}</p>
          <p class="mt-1 text-xs text-tinta-fraca">{{ lugares(s).unidades }} × {{ s.admite }}</p>
        </div>
        <div>
          <p class="rotulo-kpi">Pessoas já vendidas</p>
          <p class="numero-kpi mt-1">{{ lugares(s).pessoasVendidas }}</p>
        </div>
      </div>

      <table v-if="s.lotes.length" class="w-full border-collapse text-sm">
        <thead>
          <tr class="border-y border-linha bg-fundo-cinza/60 text-left">
            <th class="titulo px-4 py-2 text-xs font-bold uppercase tracking-wide text-tinta-rotulo">Lote</th>
            <th class="titulo px-3 py-2 text-right text-xs font-bold uppercase tracking-wide text-tinta-rotulo">Comprador paga</th>
            <th class="titulo px-3 py-2 text-right text-xs font-bold uppercase tracking-wide text-tinta-rotulo">Por pessoa</th>
            <th class="titulo px-3 py-2 text-right text-xs font-bold uppercase tracking-wide text-tinta-rotulo">Unidades</th>
            <th class="titulo px-3 py-2 text-right text-xs font-bold uppercase tracking-wide text-tinta-rotulo">Pessoas</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="l in s.lotes" :key="l.id" class="border-b border-linha last:border-0">
            <td class="px-4 py-2.5 font-medium text-tinta">{{ l.nome }}</td>
            <td class="px-3 py-2.5 text-right tabular-nums text-tinta">{{ reais(l.totalCents) }}</td>
            <td class="px-3 py-2.5 text-right tabular-nums text-tinta-suave">
              {{ reais(Math.round(l.totalCents / s.admite)) }}
            </td>
            <td class="px-3 py-2.5 text-right tabular-nums text-tinta-suave">
              {{ l.disponivel }} de {{ l.quantidade }}
            </td>
            <td class="px-3 py-2.5 text-right tabular-nums text-acao">{{ l.quantidade * s.admite }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else class="px-4 py-4 text-sm text-tinta-fraca">Nenhum lote neste setor.</p>
    </section>

    <div v-if="grupos.length"
         class="sticky bottom-0 mt-4 flex flex-wrap items-center gap-x-8 rounded-card bg-acao px-5 py-3 text-white">
      <p class="titulo text-base font-bold">
        Pessoas em passaportes e grupos: <span class="tabular-nums">{{ totalPessoas }}</span>
      </p>
      <p class="text-sm opacity-90">
        {{ grupos.length }} setor(es) fora do ingresso simples
      </p>
    </div>

    <ModalLateral v-if="form.aberto" titulo="Configurar grupo" @fechar="form.aberto = false">
      <div class="grid gap-3">
        <div>
          <label class="rotulo">Pessoas por unidade</label>
          <input v-model.number="form.admite" type="number" min="1" max="100" class="campo tabular-nums">
          <p class="mt-1 text-xs text-tinta-fraca">
            Mesa de 4 → 4. Passaporte individual → 1. É o número que a portaria usa pra contar entrada.
          </p>
        </div>
        <div>
          <label class="rotulo">Sessões cobertas (opcional)</label>
          <input v-model.number="form.sessoesCobertas" type="number" min="1" max="365"
                 class="campo tabular-nums" placeholder="só uma">
          <p class="mt-1 text-xs text-tinta-fraca">
            Passaporte de 3 dias → 3. Em branco vale para uma sessão só.
          </p>
        </div>
        <div>
          <label class="rotulo">Descrição (opcional)</label>
          <textarea v-model="form.descricao" rows="3" class="campo"
                    placeholder="O que está incluso: mesa, cadeiras, entrada preferencial…" />
        </div>
      </div>
      <template #acoes>
        <button type="button" class="btn-secundario" @click="form.aberto = false">Cancelar</button>
        <button type="button" class="btn-primario" :disabled="salvando" @click="salvar">Salvar</button>
      </template>
    </ModalLateral>
  </div>

  <p v-else-if="pending" class="card mt-6 text-tinta-suave">Carregando…</p>

  <div v-else class="card mt-6">
    <p class="rotulo-kpi text-erro">Não foi possível carregar</p>
    <p class="mt-1 text-sm text-tinta-suave">
      {{ (falha as any)?.data?.statusMessage || (falha as any)?.message || 'Erro desconhecido.' }}
    </p>
    <button type="button" class="btn-secundario mt-3" @click="refresh()">Tentar de novo</button>
  </div>
</template>
