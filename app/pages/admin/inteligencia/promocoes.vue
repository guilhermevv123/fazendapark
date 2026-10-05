<script setup lang="ts">
/**
 * Inteligência → Promoções: o programa de fidelidade "Volte Mais" (pedido do dono, 05/10).
 *
 * 05/10 (037): "o cliente compra o primeiro ingresso; os próximos com metade do preço, e 10% na
 * consumação". Depois (042): "de forma PERMANENTE" — sem limite de retornos e sem data de fim
 * (o regulamento diz que o parque encerra avisando com 30 dias). Os 10% do bar viram um CUPOM com
 * QR que o caixa confere e dá baixa (Caixa do bar, /admin/consumacao). Cada regra é um campo aqui.
 *
 * Nasce DESLIGADO. Ligar exige a data de início. O regulamento que aparece aqui é o MESMO que o
 * cliente lê antes de pagar (utils/fidelidade-texto.ts). A conta do desconto acontece só no
 * servidor, no checkout, com a trava do CPF.
 */
import { regulamentoDaFidelidade, type ProgramaDeFidelidade } from '~~/server/utils/fidelidade-texto'

definePageMeta({ layout: 'admin' })
useHead({ title: 'Promoções' })

const { data, pending, error: falha, refresh } = await useFetch<{
  programa: ProgramaDeFidelidade; existe: boolean; regulamentoPadrao: string
  numeros: { retornosPagos: number; retornosAguardando: number; descontoCents: number; faturadoCents: number; clientes: number } | null
  eventos: { id: string; name: string; dia: string }[]
}>('/api/admin/inteligencia/promocoes')

// o formulário trabalha em % e em números da tela; o banco, em bps
const f = reactive({
  nome: 'Volte Mais', ativo: false, desconto: 50, permanente: true, retornos: 2, prazo: null as number | null, ingressos: 1,
  consumacaoUsos: 1, consumacaoDiaTodo: false,
  conta_visita: 'entrada' as 'entrada' | 'compra', dias: [0, 1, 2, 3, 4, 5, 6] as number[], vale_feriado: true,
  eventos_fora: [] as string[], vale_visita_anterior: false, consumacao: 10,
  vigencia_inicio: '', vigencia_fim: '', regulamentoProprio: false, regulamento: '',
})
function carregar(p: ProgramaDeFidelidade) {
  Object.assign(f, {
    nome: p.nome, ativo: p.ativo, desconto: p.desconto_bps / 100, permanente: p.retornos == null, retornos: p.retornos ?? 2,
    prazo: p.prazo_dias, consumacaoUsos: p.consumacao_usos ?? 1, consumacaoDiaTodo: !!p.consumacao_dia_todo,
    ingressos: p.ingressos_por_compra, conta_visita: p.conta_visita, dias: [...p.dias_semana], vale_feriado: p.vale_feriado,
    eventos_fora: [...p.eventos_fora], vale_visita_anterior: p.vale_visita_anterior, consumacao: p.consumacao_bps / 100,
    vigencia_inicio: p.vigencia_inicio ?? '', vigencia_fim: p.vigencia_fim ?? '',
    regulamentoProprio: !!p.regulamento, regulamento: p.regulamento ?? '',
  })
}
watch(() => data.value?.programa, (p) => { if (p) carregar(p) }, { immediate: true })

const comoPrograma = computed<ProgramaDeFidelidade>(() => ({
  id: data.value?.programa.id ?? '', org_id: data.value?.programa.org_id ?? '', nome: f.nome.trim() || 'Volte Mais',
  ativo: f.ativo, desconto_bps: Math.round(Number(f.desconto) * 100), retornos: f.permanente ? null : Number(f.retornos),
  consumacao_usos: Number(f.consumacaoUsos) || 1, consumacao_dia_todo: f.consumacaoDiaTodo,
  prazo_dias: f.prazo ? Number(f.prazo) : null, ingressos_por_compra: Number(f.ingressos), conta_visita: f.conta_visita,
  dias_semana: [...f.dias].sort(), vale_feriado: f.vale_feriado, eventos_fora: f.eventos_fora,
  vale_visita_anterior: f.vale_visita_anterior, consumacao_bps: Math.round(Number(f.consumacao) * 100),
  vigencia_inicio: f.vigencia_inicio || null, vigencia_fim: f.vigencia_fim || null,
  regulamento: f.regulamentoProprio && f.regulamento.trim() ? f.regulamento.trim() : null,
}))
const regulamentoAoVivo = computed(() => regulamentoDaFidelidade(comoPrograma.value))

const DIAS = [{ v: 5, n: 'Sexta' }, { v: 6, n: 'Sábado' }, { v: 0, n: 'Domingo' }, { v: 1, n: 'Segunda' },
  { v: 2, n: 'Terça' }, { v: 3, n: 'Quarta' }, { v: 4, n: 'Quinta' }]

const salvando = ref(false)
const erro = ref('')
const aviso = ref('')
async function salvar() {
  erro.value = ''; aviso.value = ''
  if (f.ativo && !f.vigencia_inicio) {
    erro.value = 'Pra ligar, preencha a data de início (o fim pode ficar em branco: vale por tempo indeterminado).'
    return
  }
  salvando.value = true
  try {
    await $fetch('/api/admin/inteligencia/promocoes', { method: 'POST', body: { programa: { ...comoPrograma.value } } })
    aviso.value = f.ativo ? `"${f.nome}" está LIGADO: vale na próxima compra de quem já visitou.` : 'Salvo (desligado: ninguém recebe o desconto até ligar).'
    await refresh()
  } catch (e: any) {
    erro.value = e?.data?.statusMessage || e?.statusMessage || 'Não consegui salvar agora.'
  } finally {
    salvando.value = false
  }
}

const { data: baixas } = await useFetch<{ baixas: any[] }>('/api/admin/consumacao', { key: 'promo-baixas' })

const reais = (c: number) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
const dataBR = (iso: string) => iso.split('-').reverse().join('/')
</script>

<template>
  <div>
    <header class="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 class="titulo text-2xl font-semibold text-tinta">Promoções</h1>
        <p class="apoio-bloco">Fidelidade: o cliente paga a 1ª visita inteira e volta com desconto — em todas as próximas visitas (permanente) ou só nas que você escolher.</p>
      </div>
      <span :class="data?.programa.ativo ? 'selo-ok' : 'selo-neutro'" data-parte="situacao-promocao">
        {{ data?.programa.ativo ? 'LIGADA' : 'DESLIGADA' }}
      </span>
    </header>

    <div v-if="falha" class="faixa-erro mt-5" role="alert">
      {{ falha.data?.statusMessage || falha.statusMessage || 'Não consegui ler a promoção agora.' }}
      <button type="button" class="btn-secundario mt-3" @click="refresh()">Tentar de novo</button>
    </div>
    <div v-else-if="pending && !data" class="card mt-5 h-40 animate-pulse bg-fundo-cinza" aria-busy="true" />

    <template v-else-if="data">
      <!-- ========================================================== números -->
      <section v-if="data.numeros" class="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Números da promoção" data-parte="numeros-promocao">
        <div class="card"><p class="text-xs font-semibold uppercase tracking-wide text-tinta-fraca">Retornos pagos</p>
          <p class="titulo mt-1 text-2xl font-semibold tabular-nums text-tinta">{{ data.numeros.retornosPagos }}</p>
          <p class="text-xs text-tinta-suave">{{ data.numeros.retornosAguardando }} aguardando pagamento</p></div>
        <div class="card"><p class="text-xs font-semibold uppercase tracking-wide text-tinta-fraca">Clientes que voltaram</p>
          <p class="titulo mt-1 text-2xl font-semibold tabular-nums text-tinta">{{ data.numeros.clientes }}</p></div>
        <div class="card"><p class="text-xs font-semibold uppercase tracking-wide text-tinta-fraca">Vendido nos retornos</p>
          <p class="titulo mt-1 text-2xl font-semibold tabular-nums text-tinta">{{ reais(data.numeros.faturadoCents) }}</p></div>
        <div class="card"><p class="text-xs font-semibold uppercase tracking-wide text-tinta-fraca">Desconto concedido</p>
          <p class="titulo mt-1 text-2xl font-semibold tabular-nums text-tinta">{{ reais(data.numeros.descontoCents) }}</p></div>
      </section>

      <form class="mt-5 grid gap-5 xl:grid-cols-[1.3fr_1fr]" data-parte="form-promocao" @submit.prevent="salvar">
        <div class="grid content-start gap-5">
          <section class="card grid gap-4">
            <label class="flex items-center gap-3 text-base font-semibold text-tinta">
              <input v-model="f.ativo" type="checkbox" class="h-5 w-5" data-parte="ligar-promocao"> Promoção ligada
            </label>
            <div>
              <label for="p-nome" class="rotulo">Nome que o cliente vê</label>
              <input id="p-nome" v-model="f.nome" class="campo" maxlength="60">
            </div>
            <div class="grid gap-4 sm:grid-cols-2">
              <div>
                <label for="p-inicio" class="rotulo">Vigência — início</label>
                <input id="p-inicio" v-model="f.vigencia_inicio" type="date" class="campo">
              </div>
              <div>
                <label for="p-fim" class="rotulo">Vigência — fim (opcional)</label>
                <input id="p-fim" v-model="f.vigencia_fim" type="date" class="campo" :min="f.vigencia_inicio">
              </div>
            </div>
            <p class="text-xs text-tinta-suave">
              Fim em branco = por tempo indeterminado. O regulamento já avisa que o parque pode encerrar o programa
              com 30 dias de antecedência, e que compra já feita mantém o desconto.
            </p>
          </section>

          <section class="card grid gap-4">
            <h2 class="titulo text-lg font-semibold text-tinta">O benefício</h2>
            <label class="flex items-start gap-2 text-sm text-tinta-corpo">
              <input v-model="f.permanente" type="checkbox" class="mt-1" data-parte="permanente">
              <span><strong>Permanente</strong> — o desconto vale em TODAS as próximas visitas, sem limite.</span>
            </label>
            <div class="grid gap-4 sm:grid-cols-3">
              <div>
                <label for="p-desc" class="rotulo">Desconto no ingresso (%)</label>
                <input id="p-desc" v-model.number="f.desconto" type="number" min="1" max="100" step="1" class="campo">
              </div>
              <div v-if="!f.permanente">
                <label for="p-ret" class="rotulo">Quantos retornos</label>
                <input id="p-ret" v-model.number="f.retornos" type="number" min="1" max="50" class="campo">
              </div>
              <div>
                <label for="p-cons" class="rotulo">Na consumação (%)</label>
                <input id="p-cons" v-model.number="f.consumacao" type="number" min="0" max="100" class="campo">
              </div>
            </div>
            <div class="grid gap-4 sm:grid-cols-2">
              <div>
                <label for="p-ing" class="rotulo">Ingressos com desconto por compra</label>
                <input id="p-ing" v-model.number="f.ingressos" type="number" min="1" max="20" class="campo">
                <p class="mt-1 text-xs text-tinta-suave">1 = só o do titular. Mais que 1 = leva a família junto.</p>
              </div>
              <div>
                <label for="p-prazo" class="rotulo">Prazo pra voltar (dias depois da 1ª visita)</label>
                <input id="p-prazo" v-model.number="f.prazo" type="number" min="1" max="730" class="campo" placeholder="vazio = sem prazo">
              </div>
            </div>
          </section>

          <section v-if="f.consumacao > 0" class="card grid gap-4" data-parte="cupom-do-bar">
            <h2 class="titulo text-lg font-semibold text-tinta">Cupom do bar ({{ f.consumacao }}%)</h2>
            <p class="text-sm text-tinta-corpo">
              Cada retorno ganha um <strong>cupom com QR</strong> — no ingresso, no e-mail e pra baixar como imagem. No bar,
              a atendente aponta a câmera do celular pro QR (ou digita o código de 6 letras em
              <NuxtLink to="/admin/consumacao" class="font-semibold text-acao underline">Caixa do bar</NuxtLink>), vê
              <strong>VÁLIDO</strong> ou <strong>JÁ USADO</strong>, dá a baixa e aplica os {{ f.consumacao }}% na Zig.
              Só vale no dia da visita; se a entrada na portaria não aparecer, ela confere o documento antes de liberar.
            </p>
            <fieldset>
              <legend class="rotulo">Quantas vezes por visita</legend>
              <label class="flex items-start gap-2 text-sm text-tinta-corpo">
                <input v-model="f.consumacaoDiaTodo" type="radio" :value="false" class="mt-1">
                <span><input v-model.number="f.consumacaoUsos" type="number" min="1" max="20" class="campo inline-block w-20 py-1"
                             :disabled="f.consumacaoDiaTodo" aria-label="Usos por visita">
                  {{ f.consumacaoUsos === 1 ? 'vez (recomendado: a atendente dá a baixa numa conta e acabou)' : 'vezes no dia' }}</span>
              </label>
              <label class="mt-2 flex items-start gap-2 text-sm text-tinta-corpo">
                <input v-model="f.consumacaoDiaTodo" type="radio" :value="true" class="mt-1">
                <span><strong>O dia todo</strong> — a 1ª baixa ativa o cupom; nas outras compras do dia ele aparece ATIVO (verde).</span>
              </label>
            </fieldset>
          </section>

          <section class="card grid gap-4">
            <h2 class="titulo text-lg font-semibold text-tinta">Quem ganha e quando vale</h2>
            <fieldset>
              <legend class="rotulo">O que conta como "já visitou"</legend>
              <label class="flex items-start gap-2 text-sm text-tinta-corpo">
                <input v-model="f.conta_visita" type="radio" value="entrada" class="mt-1">
                <span><strong>Entrada na portaria</strong> (recomendado) — só ganha quem realmente veio. Comprar e pedir reembolso não gera desconto.</span>
              </label>
              <label class="mt-2 flex items-start gap-2 text-sm text-tinta-corpo">
                <input v-model="f.conta_visita" type="radio" value="compra" class="mt-1">
                <span><strong>Compra paga</strong> — ganha ao pagar a 1ª compra, mesmo antes de vir.</span>
              </label>
            </fieldset>
            <label class="flex items-start gap-2 text-sm text-tinta-corpo">
              <input v-model="f.vale_visita_anterior" type="checkbox" class="mt-1">
              <span>Quem já visitou <strong>antes</strong> da vigência também ganha (senão, só conta a visita a partir do início).</span>
            </label>
            <fieldset>
              <legend class="rotulo">Dias em que o desconto vale (dia do evento)</legend>
              <div class="flex flex-wrap gap-3">
                <label v-for="d in DIAS" :key="d.v" class="flex items-center gap-2 text-sm text-tinta-corpo">
                  <input v-model="f.dias" type="checkbox" :value="d.v"> {{ d.n }}
                </label>
              </div>
              <label class="mt-2 flex items-center gap-2 text-sm text-tinta-corpo">
                <input v-model="f.vale_feriado" type="checkbox"> Vale em feriado nacional
              </label>
              <p class="mt-1 text-xs text-tinta-suave">Dica: deixar só a sexta enche o dia mais fraco.</p>
            </fieldset>
            <fieldset v-if="data.eventos.length">
              <legend class="rotulo">Eventos em que NÃO vale</legend>
              <div class="grid max-h-56 gap-1.5 overflow-auto pr-1">
                <label v-for="e in data.eventos" :key="e.id" class="flex items-center gap-2 text-sm text-tinta-corpo">
                  <input v-model="f.eventos_fora" type="checkbox" :value="e.id"> {{ dataBR(e.dia) }} · {{ e.name }}
                </label>
              </div>
            </fieldset>
            <p class="text-xs text-tinta-suave">Meia-entrada e cupom não acumulam com a promoção (a meia já é metade do preço).</p>
          </section>
        </div>

        <aside class="grid content-start gap-5">
          <section class="card" data-parte="regulamento">
            <h2 class="titulo text-lg font-semibold text-tinta">Regulamento</h2>
            <p class="apoio-bloco">O cliente lê isto antes de pagar. Sai pronto das regras ao lado.</p>
            <pre v-if="!f.regulamentoProprio" class="mt-3 whitespace-pre-wrap rounded-md bg-fundo-cinza p-3 text-xs leading-5 text-tinta-corpo">{{ regulamentoAoVivo }}</pre>
            <textarea v-else v-model="f.regulamento" class="campo mt-3 min-h-[260px] text-xs" maxlength="6000" />
            <label class="mt-3 flex items-center gap-2 text-sm text-tinta-corpo">
              <input v-model="f.regulamentoProprio" type="checkbox" @change="f.regulamentoProprio && !f.regulamento && (f.regulamento = regulamentoAoVivo)">
              Escrever o regulamento à mão
            </label>
          </section>

          <section class="card grid gap-3">
            <p v-if="erro" class="faixa-erro" role="alert">{{ erro }}</p>
            <p v-if="aviso" class="rounded-xl bg-success-50 px-4 py-3 text-sm text-success-800 ring-1 ring-inset ring-success-600/30" role="status" data-parte="recado-promocao">{{ aviso }}</p>
            <button type="submit" class="btn-primario w-full" :disabled="salvando" data-parte="salvar-promocao">
              {{ salvando ? 'Salvando…' : f.ativo ? 'Salvar e deixar ligada' : 'Salvar (desligada)' }}
            </button>
          </section>

          <section class="card" data-parte="baixas-do-bar">
            <div class="flex items-center justify-between gap-3">
              <h2 class="titulo text-lg font-semibold text-tinta">Baixas no bar</h2>
              <NuxtLink to="/admin/consumacao" class="text-sm font-semibold text-acao underline">Abrir Caixa do bar</NuxtLink>
            </div>
            <p v-if="!baixas?.baixas?.length" class="mt-2 text-sm text-tinta-suave">Nenhum cupom usado ainda.</p>
            <ul v-else class="mt-2 divide-y divide-linha text-sm">
              <li v-for="b in baixas.baixas" :key="b.id" class="flex items-center justify-between gap-3 py-2">
                <span class="min-w-0">
                  <span class="block truncate font-medium text-tinta">{{ b.titular ?? '—' }}</span>
                  <span class="block text-xs text-tinta-fraca">{{ b.em }} · {{ b.codigo }} · {{ String(b.por || 'caixa').replace(/\s*<[^>]*>\s*$/, '') }}<template v-if="b.semEntrada"> · <strong class="text-alerta">sem entrada</strong></template></span>
                </span>
                <span class="shrink-0 font-semibold text-ok">{{ Number(b.consumacaoBps) / 100 }}%</span>
              </li>
            </ul>
            <p class="mt-2 text-xs text-tinta-suave">Confira com o relatório de descontos da Zig no fim do dia.</p>
          </section>
        </aside>
      </form>
    </template>
  </div>
</template>
