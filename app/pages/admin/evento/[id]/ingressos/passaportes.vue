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
import { estoqueSemLimite } from '~~/server/utils/estoque-sem-limite'
import { ultimoDadoBom } from '~/composables/ultimoDadoBom'
definePageMeta({ layout: 'admin' })

const route = useRoute()
const id = route.params.id as string

// o recarregar que falha depois de gravar não apaga a tela (#77) — ver `ultimoDadoBom`
const bom = ultimoDadoBom<any>()
const { data, refresh, pending, error: falha } = await useFetch<any>(
  `/api/admin/evento/${id}/ingressos`, { default: bom.default })
bom.guardar(data)

// `reais` é o de app/composables/formato.ts (ADM-48): uma escrita de dinheiro só no projeto
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
  // lote sem teto: "quantas pessoas cabem" não tem número — conta só quem já comprou
  const semLimite = s.lotes.some((l: any) => estoqueSemLimite(l.quantidade))
  return { unidades: un, vendidas, pessoas: un * s.admite, pessoasVendidas: vendidas * s.admite, semLimite }
}

const semLimiteGeral = computed(() => grupos.value.some((s: any) => lugares(s).semLimite))
const totalPessoas = computed(() =>
  grupos.value.reduce((n: number, s: any) => n + (semLimiteGeral.value ? lugares(s).pessoasVendidas : lugares(s).pessoas), 0))

async function salvarCampo(setorId: string, campos: any) {
  erro.value = ''
  salvando.value = true
  try {
    await $fetch(`/api/admin/evento/${id}/ingressos`, {
      method: 'PATCH', body: { o: 'setor', id: setorId, campos },
    })
  } catch (e: any) {
    erro.value = e?.data?.statusMessage || 'Não foi possível salvar.'
    return false
  } finally {
    salvando.value = false
  }
  // já gravou: a falha do recarregar (que o `refresh()` do Nuxt 4 não lança) não é "não salvou"
  await refresh()
  return true
}

const form = reactive({ aberto: false, id: '', admite: 1, sessoesCobertas: null as number | null, descricao: '' })
function abrir(s: any) {
  Object.assign(form, {
    aberto: true, id: s.id, admite: s.admite, sessoesCobertas: s.sessoesCobertas,
    descricao: s.descricao ?? '',
  })
}
/**
 * Mudar "Pessoas por unidade" com unidade já vendida muda a conta da PORTARIA (#99, 28/09): ela lê
 * o número do setor na hora da entrada (`sectors.admits`, em `catraca.ts`), então a mesa de 4 já
 * vendida passa a entrar com 2. A janela gravava em silêncio; agora diz antes do Salvar.
 */
const avisoDoAdmite = computed(() => {
  const s = grupos.value.find((g: any) => g.id === form.id)
  const novo = Number(form.admite)
  if (!form.aberto || !s || !Number.isInteger(novo) || novo < 1 || novo === s.admite) return ''
  const { vendidas } = lugares(s)
  if (!vendidas) return ''
  return `Já saíram ${vendidas} unidade(s) deste setor. Com ${novo} pessoa(s) por unidade, a portaria `
    + `passa a contar ${vendidas * novo} pessoa(s) nelas (hoje conta ${vendidas * s.admite}) — `
    + 'inclusive nas que já foram vendidas.'
})

async function salvar() {
  // campo apagado: o `v-model.number` dá "" e o servidor respondia "formato errado"
  if (form.admite === ('' as any) || form.admite == null) {
    erro.value = 'Preencha "Pessoas por unidade": de 1 a 100 (mesa de 4 → 4).'
    return
  }
  const ok = await salvarCampo(form.id, {
    admite: form.admite,
    sessoesCobertas: form.sessoesCobertas || null,
    descricao: form.descricao || null,
  })
  if (!ok) return
  form.aberto = false
  if (falha.value) erro.value = 'Salvo, mas a tela não recarregou. Atualize a página para ver como ficou.'
}

useHead({ title: 'Passaportes e grupos' })
</script>

<template>
  <div v-if="data">
    <div class="flex flex-wrap items-start justify-between gap-3 py-5">
      <div>
        <h1 class="titulo text-2xl font-semibold text-tinta">Passaportes e grupos</h1>
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
        <h2 class="titulo text-base font-semibold uppercase tracking-wide text-acao">{{ s.nome }}</h2>
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
          <p class="numero-kpi mt-1">{{ lugares(s).semLimite ? 'Sem limite' : lugares(s).unidades }}</p>
        </div>
        <div>
          <p class="rotulo-kpi">Unidades saídas</p>
          <p class="numero-kpi mt-1">{{ lugares(s).vendidas }}</p>
        </div>
        <div>
          <p class="rotulo-kpi">Pessoas que cabem</p>
          <p class="numero-kpi mt-1 text-acao">{{ lugares(s).semLimite ? 'Sem limite' : lugares(s).pessoas }}</p>
          <p class="mt-1 text-xs text-tinta-fraca">{{ lugares(s).semLimite ? `${s.admite} por unidade` : `${lugares(s).unidades} × ${s.admite}` }}</p>
        </div>
        <div>
          <p class="rotulo-kpi">Pessoas já vendidas</p>
          <p class="numero-kpi mt-1">{{ lugares(s).pessoasVendidas }}</p>
        </div>
      </div>

      <div v-if="s.lotes.length" class="overflow-x-auto">
        <table class="w-full border-collapse text-sm">
        <thead>
          <tr class="border-y border-linha bg-fundo-cinza/60 text-left">
            <th class="titulo px-4 py-2 text-xs font-semibold uppercase tracking-wide text-tinta-rotulo">Lote</th>
            <th class="titulo px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-tinta-rotulo">Comprador paga</th>
            <th class="titulo px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-tinta-rotulo">Por pessoa</th>
            <th class="titulo px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-tinta-rotulo">Unidades</th>
            <th class="titulo px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-tinta-rotulo">Pessoas</th>
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
              {{ estoqueSemLimite(l.quantidade) ? 'Sem limite' : `${l.disponivel} de ${l.quantidade}` }}
            </td>
            <td class="px-3 py-2.5 text-right tabular-nums text-acao">{{ estoqueSemLimite(l.quantidade) ? 'Sem limite' : l.quantidade * s.admite }}</td>
          </tr>
        </tbody>
      </table>
      </div>
      <p v-else class="px-4 py-4 text-sm text-tinta-fraca">Nenhum lote neste setor.</p>
    </section>

    <div v-if="grupos.length"
         class="sticky bottom-0 mt-4 flex flex-wrap items-center gap-x-8 rounded-card bg-acao px-5 py-3 text-white">
      <p class="titulo text-base font-semibold">
        {{ semLimiteGeral ? 'Pessoas já vendidas em passaportes e grupos' : 'Pessoas em passaportes e grupos' }}: <span class="tabular-nums">{{ totalPessoas }}</span>
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
          <p v-if="avisoDoAdmite" class="faixa-aviso mt-2 text-sm" role="status" data-parte="aviso-admite">
            {{ avisoDoAdmite }}
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
      <!-- a recusa do servidor aparece DENTRO da janela: a faixa do alto da página fica atrás do
           painel, e a janela aberta parecia não ter feito nada -->
      <p v-if="erro" class="mt-3 rounded-card border border-erro bg-erro-claro px-3 py-2 text-sm text-erro"
         role="alert" data-parte="erro-na-janela">
        {{ erro }}
      </p>
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
