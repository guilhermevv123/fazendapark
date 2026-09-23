<script setup lang="ts">
/**
 * Participantes — a lista da portaria.
 *
 * É lista de INGRESSOS, não de pedidos: um pedido de 6 é uma linha em Vendas e
 * seis pessoas aqui. E é onde se NOMEIA o ingresso em branco — quem compra 6
 * recebe 5 sem nome, e é esse preenchimento que transforma a compra numa lista
 * de entrada com documento.
 */
definePageMeta({ layout: 'admin' })

const route = useRoute()
const router = useRouter()
const id = route.params.id as string

/* ===========================================================================
 * O filtro mora na URL
 * ========================================================================
 * Regra da casa: "o operador precisa mandar o link do que está vendo". Aqui
 * ela custou mais do que um link perdido — foi ela que deixou o defeito da
 * nota do KPI (logo abaixo) invisível: a tela filtrada não tinha endereço,
 * então não dava pra abrir de novo nem pra medir do lado de fora.
 *
 * Sem parâmetro nenhum a tela é exatamente a de antes; quem chega com
 * `?setor=…` já pinta filtrado no PRIMEIRO desenho (o `useFetch` lê estes
 * mesmos refs no servidor), em vez de mostrar o total do evento e corrigir
 * depois que o JavaScript acorda.
 */
const naUrl = (chave: string) => {
  const v = route.query[chave]
  return String((Array.isArray(v) ? v[0] : v) ?? '')
}

const busca = ref(naUrl('busca'))
const status = ref(naUrl('status'))
const setor = ref(naUrl('setor'))
const pagina = ref(Math.max(1, Number(naUrl('pagina')) || 1))

// Debounce: sem ele, cada tecla dispara uma consulta e a resposta da 3ª letra
// pode chegar depois da 5ª, repintando a tela com um resultado velho.
// Começa com o que veio da URL, senão o primeiro desenho ignora a busca do link.
const buscaDebounce = ref(busca.value)
let timer: any
watch(busca, (v) => {
  clearTimeout(timer)
  timer = setTimeout(() => { buscaDebounce.value = v; pagina.value = 1 }, 300)
})
watch([status, setor], () => { pagina.value = 1 })

// `replace` e não `push`: filtrar não é navegar, e encher o histórico faz o
// botão "voltar" do navegador percorrer cada tecla digitada na busca.
watch([buscaDebounce, status, setor, pagina], () => {
  const query: Record<string, string> = {}
  if (buscaDebounce.value) query.busca = buscaDebounce.value
  if (status.value) query.status = status.value
  if (setor.value) query.setor = setor.value
  if (pagina.value > 1) query.pagina = String(pagina.value)
  router.replace({ query })
})

/**
 * Tem recorte ligado? `pagina` fica de fora de propósito: o rodapé conta a
 * consulta inteira, não a página, então virar de página não muda os números
 * dos KPIs.
 */
const filtrando = computed(() =>
  Boolean(buscaDebounce.value || status.value || setor.value))

const { data, refresh, pending, error: falha } = await useFetch<any>(
  () => `/api/admin/evento/${id}/participantes`,
  { query: { busca: buscaDebounce, status, setor, pagina } })

const erro = ref('')
const salvando = ref(false)

const form = reactive({ aberto: false, id: '', codigo: '', nome: '', email: '', documento: '' })
function abrir(p: any) {
  erro.value = ''
  Object.assign(form, {
    aberto: true, id: p.id, codigo: p.codigo,
    nome: p.nome ?? '', email: p.email ?? '', documento: p.documento ?? '',
  })
}
async function salvar() {
  erro.value = ''
  salvando.value = true
  try {
    await $fetch(`/api/admin/evento/${id}/participantes`, {
      method: 'PATCH',
      body: { id: form.id, nome: form.nome || null, email: form.email || null,
              documento: form.documento || null },
    })
    await refresh()
    form.aberto = false
  } catch (e: any) {
    // aparece DENTRO do painel de nomear: no alto da página ficava atrás do
    // fundo do painel, e o "Salvar" parecia simplesmente não funcionar
    erro.value = e?.data?.message || e?.data?.statusMessage || 'Não foi possível salvar.'
  } finally {
    salvando.value = false
  }
}

const SELO: Record<string, string> = {
  valido: 'selo-ok', usado: 'selo-neutro', cancelado: 'selo-erro', transferido: 'selo-alerta',
}

/* ===========================================================================
 * Três jeitos de entrar sem pagar — e três selos, porque são coisas diferentes
 * ======================================================================== */
/**
 * A API manda a diferença em três campos (`cortesia`, `gratuito`,
 * `origemNaoRegistrada`); esta tela mostrava UM selo e apagava os outros dois.
 * Medido no navegador (1440×900, `getComputedStyle`), antes:
 *
 *   - a venda que fechou em zero ficava **sem selo nenhum** (`<span>` nem
 *     existia, largura 0). O selo errado tinha sido removido e nada entrou no
 *     lugar: o operador deixou de saber que aquele ingresso saiu sem dinheiro;
 *   - o ingresso SEM PEDIDO recebia o selo IDÊNTICO ao da cortesia de verdade
 *     (`selo-neutro ml-1`, `rgb(90, 107, 132)`, 73.8px nas duas linhas) — a
 *     tela afirmava uma origem que ninguém consegue provar.
 *
 * Agora cada um tem nome próprio, e a ordem do `if` não é estética: ingresso
 * sem pedido também vem com `cortesia: true` (a régua da casa conta o caso
 * seguro), então ele precisa ser perguntado PRIMEIRO, senão volta a se
 * disfarçar de convite.
 *
 * O KPI "Cortesias" continua contando o sem-origem — é o mesmo número que
 * fecha com o borderô. Quem explica a diferença é a nota embaixo dele, não um
 * recorte escondido: total do rodapé que não bate com os selos de cima é
 * exatamente a contradição que esta tela já causou uma vez.
 */
interface Gratuidade { texto: string; classe: string; title: string }

function gratuidade(p: any): Gratuidade | null {
  if (p.origemNaoRegistrada) {
    return {
      texto: 'SEM ORIGEM', classe: 'selo-alerta',
      title: 'Entrou de graça, mas não tem pedido: não dá pra provar se foi cortesia '
        + 'ou venda. Conta no total de cortesias acima, pelo lado seguro.',
    }
  }
  if (p.cortesia) {
    return {
      texto: 'CORTESIA', classe: 'selo-neutro',
      title: 'Convite da casa: o pedido nasceu na rota de cortesia. Não passou por caixa.',
    }
  }
  if (p.gratuito) {
    return {
      texto: 'VENDA R$ 0', classe: 'selo-ok',
      title: 'Venda que fechou em zero — promoção de 100%, criança ou lote gratuito. '
        + 'Não é cortesia: tem pedido, comprador e aparece em Vendas.',
    }
  }
  return null
}

/** As linhas com o selo já resolvido: a tabela não decide isso três vezes por linha. */
const linhas = computed<any[]>(() =>
  (data.value?.participantes ?? []).map((p: any) => ({ ...p, gratuidade: gratuidade(p) })))

// data pelo formatador de `app/composables/formato.ts`, que lê o relógio
// local: a portaria confere entrada à noite, e um dia a mais na coluna
// "Entrou" é discussão no balcão.
const quando = dataHora

function exportar() {
  // "Entrada gratuita" sai do MESMO lugar que o selo da tela: planilha que
  // discorda da tela sobre o mesmo ingresso é a discussão de sempre.
  const cab = ['Código', 'Portador', 'Documento', 'E-mail', 'Setor', 'Lote', 'Tipo',
               'Situação', 'Entrada gratuita', 'Entrou em', 'Pedido', 'Comprador']
  const corpo = linhas.value.map((p: any) => [
    p.codigo, p.nome ?? '', p.documento ?? '', p.email ?? '',
    p.setor, p.lote, p.tipo ?? '', p.status,
    p.gratuidade?.texto ?? '',
    dataHoraSegundo(p.entrouEm, ''),
    p.pedido ?? '', p.comprador ?? '',
  ])
  const csv = [cab, ...corpo]
    .map((l) => l.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(';'))
    .join('\r\n')
  const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = `participantes-${id.slice(0, 8)}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

useHead({ title: 'Participantes' })
</script>

<template>
  <div v-if="data">
    <div class="flex flex-wrap items-start justify-between gap-3 py-5">
      <div>
        <h1 class="titulo text-2xl font-semibold text-tinta">Participantes</h1>
        <p class="mt-1 text-tinta-suave">
          Um por ingresso, não por pedido. É esta lista que a portaria usa.
        </p>
      </div>
      <button type="button" class="btn-secundario" @click="exportar">
        <IconeMenu nome="exportar" :tamanho="18" /> Exportar página
      </button>
    </div>

    <AbasSecao :evento-id="id" />

    <div class="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <div class="card">
        <p class="rotulo-kpi">Ingressos no filtro</p>
        <p class="numero-kpi mt-1">{{ data.resumo.total }}</p>
      </div>
      <div class="card">
        <p class="rotulo-kpi">Já entraram</p>
        <p class="numero-kpi mt-1">{{ data.resumo.entraram }}</p>
      </div>
      <div class="card">
        <p class="rotulo-kpi">Cortesias</p>
        <p class="numero-kpi mt-1">{{ data.resumo.cortesias }}</p>
        <!-- O que este número tem dentro e não dá pra provar. Calar isso é o
             que transforma um total em certeza que ele não tem. -->
        <p v-if="data.resumo.cortesiasSemOrigem" class="mt-1 text-xs text-alerta">
          {{ data.resumo.cortesiasSemOrigem }} sem pedido — origem não registrada, conta aqui
          pelo lado seguro
        </p>
        <!--
          A nota fala pelo BORDERÔ, e o borderô conta o evento INTEIRO. Com um
          recorte ligado, os números daqui são do recorte — e a frase virava
          uma afirmação errada sobre a outra tela. Medido no navegador, evento
          de fixture com 5 cortesias (1 cancelada) e o filtro de setor ligado
          num setor que tem 2 (1 cancelada):

              a tela dizia  "1 cancelada(s) — o borderô mostra 1"
              o borderô diz  4

          Errado por 3, com as duas telas abertas lado a lado — que é
          exatamente a discussão com o sócio que esta nota nasceu pra evitar.
          Então a tela só empresta o número do borderô quando está olhando o
          mesmo conjunto que ele; filtrada, ela fala por si.
        -->
        <p v-if="data.resumo.cortesiasCanceladas" class="mt-1 text-xs text-tinta-fraca">
          <template v-if="filtrando">
            {{ data.resumo.cortesiasCanceladas }} cancelada(s) —
            {{ data.resumo.cortesias - data.resumo.cortesiasCanceladas }} ocupa(m) lugar
            dentro deste filtro
          </template>
          <template v-else>
            {{ data.resumo.cortesiasCanceladas }} cancelada(s) — o borderô mostra
            {{ data.resumo.cortesias - data.resumo.cortesiasCanceladas }}, que é o que ocupa lugar
          </template>
        </p>
      </div>
      <div class="card">
        <p class="rotulo-kpi">Vendas R$ 0</p>
        <p class="numero-kpi mt-1">{{ data.resumo.gratuitos }}</p>
        <p class="mt-1 text-xs text-tinta-fraca">
          promoção, criança ou lote gratuito — é venda, não cortesia
        </p>
      </div>
    </div>

    <div class="card mt-4 flex flex-wrap items-end gap-3">
      <div class="min-w-[240px] flex-1">
        <label for="q" class="rotulo">Buscar</label>
        <input id="q" v-model="busca" class="campo"
               placeholder="nome, documento, código, e-mail ou pedido">
      </div>
      <div>
        <label for="st" class="rotulo">Situação</label>
        <select id="st" v-model="status" class="campo">
          <option value="">Todas</option>
          <option value="valido">Válido</option>
          <option value="usado">Já entrou</option>
          <option value="cancelado">Cancelado</option>
          <option value="transferido">Transferido</option>
        </select>
      </div>
      <div>
        <label for="se" class="rotulo">Setor</label>
        <select id="se" v-model="setor" class="campo">
          <option value="">Todos</option>
          <option v-for="s in data.setores" :key="s.id" :value="s.id">{{ s.nome }}</option>
        </select>
      </div>
      <p class="pb-2 text-sm text-tinta-suave">
        página {{ data.pagina }} de {{ data.paginas }}
      </p>
    </div>

    <p v-if="!linhas.length" class="card mt-4 py-12 text-center text-tinta-suave">
      Nenhum participante com esses filtros.
    </p>

    <div v-else class="card mt-4 overflow-x-auto p-0">
      <table class="w-full min-w-[960px] border-collapse text-sm">
        <thead>
          <tr class="border-b border-linha bg-fundo-cinza/60 text-left">
            <th class="titulo px-4 py-2 text-xs font-semibold uppercase tracking-wide text-tinta-rotulo">Código</th>
            <th class="titulo px-3 py-2 text-xs font-semibold uppercase tracking-wide text-tinta-rotulo">Portador</th>
            <th class="titulo px-3 py-2 text-xs font-semibold uppercase tracking-wide text-tinta-rotulo">Setor / lote</th>
            <th class="titulo px-3 py-2 text-xs font-semibold uppercase tracking-wide text-tinta-rotulo">Comprador</th>
            <th class="titulo px-3 py-2 text-xs font-semibold uppercase tracking-wide text-tinta-rotulo">Entrou</th>
            <th class="titulo px-3 py-2 text-xs font-semibold uppercase tracking-wide text-tinta-rotulo">Situação</th>
            <th class="titulo px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-tinta-rotulo">Ações</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="p in linhas" :key="p.id" class="border-b border-linha last:border-0">
            <td class="px-4 py-3 font-mono text-xs text-acao">
              {{ p.codigo }}
              <!-- Três selos, três nomes: CORTESIA (convite da casa),
                   VENDA R$ 0 (promoção/criança/lote grátis) e SEM ORIGEM
                   (ingresso sem pedido, que ninguém consegue distinguir). -->
              <span v-if="p.gratuidade" :class="[p.gratuidade.classe, 'ml-1']"
                    :title="p.gratuidade.title">{{ p.gratuidade.texto }}</span>
            </td>
            <td class="px-3 py-3">
              <p v-if="p.nome" class="font-medium text-tinta">{{ p.nome }}</p>
              <p v-else class="italic text-tinta-fraca">sem nome — clique em nomear</p>
              <p class="text-xs text-tinta-fraca">
                {{ [p.documento, p.email].filter(Boolean).join(' · ') }}
              </p>
            </td>
            <td class="px-3 py-3 text-tinta-suave">
              {{ p.setor }}
              <span class="block text-xs text-tinta-fraca">
                {{ p.lote }}<template v-if="p.tipo"> · {{ p.tipo }}</template>
              </span>
            </td>
            <td class="px-3 py-3 text-tinta-suave">
              {{ p.comprador ?? '—' }}
              <NuxtLink v-if="p.pedidoId" :to="`/admin/evento/${id}/vendas?pedido=${p.pedidoId}`"
                        class="block font-mono text-xs text-acao hover:underline">
                {{ p.pedido }}
              </NuxtLink>
            </td>
            <td class="px-3 py-3 text-xs text-tinta-suave">
              <template v-if="p.entrouEm">
                {{ quando(p.entrouEm) }}
                <span v-if="p.validadoPor" class="block text-tinta-fraca">por {{ p.validadoPor }}</span>
              </template>
              <template v-else>—</template>
            </td>
            <td class="px-3 py-3">
              <span :class="SELO[p.status] ?? 'selo-neutro'">{{ p.status.toUpperCase() }}</span>
            </td>
            <td class="px-3 py-3 text-right">
              <button type="button" class="px-2 text-sm disabled:opacity-30"
                      :class="p.nome ? 'text-tinta-fraca hover:text-acao' : 'font-semibold text-acao'"
                      :disabled="p.status === 'usado' || p.status === 'cancelado'"
                      :title="p.status === 'usado' ? 'Já entrou: o portador não muda mais' : ''"
                      @click="abrir(p)">
                {{ p.nome ? 'Editar' : 'Nomear' }}
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="data.paginas > 1" class="mt-4 flex items-center justify-center gap-2">
      <button type="button" class="btn-secundario py-1.5 text-sm" :disabled="data.pagina <= 1"
              @click="pagina = data.pagina - 1">Anterior</button>
      <span class="text-sm text-tinta-suave">{{ data.pagina }} / {{ data.paginas }}</span>
      <button type="button" class="btn-secundario py-1.5 text-sm" :disabled="data.pagina >= data.paginas"
              @click="pagina = data.pagina + 1">Próxima</button>
    </div>

    <ModalLateral v-if="form.aberto" :titulo="`Nomear ${form.codigo}`" @fechar="form.aberto = false">
      <div class="grid gap-3">
        <p v-if="erro" class="rounded-card border border-erro bg-erro-claro px-3 py-2 text-sm text-erro">
          {{ erro }}
        </p>
        <div>
          <label class="rotulo">Nome de quem vai usar</label>
          <input v-model="form.nome" class="campo" placeholder="Nome completo">
        </div>
        <div>
          <label class="rotulo">Documento</label>
          <input v-model="form.documento" class="campo" placeholder="CPF (11 números) ou RG">
          <p class="mt-1 text-xs text-tinta-fraca">
            É o que a portaria confere quando o ingresso exige documento.
          </p>
        </div>
        <div>
          <label class="rotulo">E-mail (opcional)</label>
          <input v-model="form.email" type="email" class="campo">
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
    <p class="rotulo-kpi text-erro">Não foi possível carregar os participantes</p>
    <p class="mt-1 text-sm text-tinta-suave">
      {{ (falha as any)?.data?.statusMessage || (falha as any)?.message || 'Erro desconhecido.' }}
    </p>
    <button type="button" class="btn-secundario mt-3" @click="refresh()">Tentar de novo</button>
  </div>
</template>
