<script setup lang="ts">
/**
 * Auditoria — a tela que responde "quem mexeu nisso?".
 *
 * A tabela de auditoria tinha 900 linhas e nenhuma tela. Registro que
 * ninguém consegue abrir não protege ninguém: quando o produtor liga
 * perguntando quem cancelou um ingresso ou quem mudou o preço do lote, o
 * suporte abria o psql — ou dava de ombros.
 *
 * Três decisões desta tela:
 *
 * - **O recorte mora na URL.** Quem achou o ato quer mandar o link pro sócio,
 *   não descrever o caminho por telefone.
 *
 * - **A coluna do meio é "o que mudou", não "o registro".** Despejar o JSON
 *   cru faz quem lê caçar a diferença entre dois blocos quase iguais. Aqui
 *   cada campo aparece como `antes → depois`, e o JSON inteiro fica a um
 *   clique pra quem precisar conferir.
 *
 * - **A tela ADMITE o que não sabe.** As linhas antigas não registraram
 *   autor, e a faixa em cima diz quantas são. Sem isso, um filtro por pessoa
 *   voltando vazio seria lido como "ela não fez nada" quando o certo é "não
 *   foi anotado".
 */
definePageMeta({ layout: 'admin' })

const route = useRoute()

/** o recorte vive na URL: filtro que some ao atualizar não serve pra conferência */
const de = ref(String(route.query.de ?? ''))
const ate = ref(String(route.query.ate ?? ''))
const pessoa = ref(String(route.query.pessoa ?? ''))
const ato = ref(String(route.query.ato ?? ''))
const entidade = ref(String(route.query.entidade ?? ''))
const busca = ref(String(route.query.busca ?? ''))

const params = computed(() => ({
  de: de.value || undefined, ate: ate.value || undefined,
  pessoa: pessoa.value || undefined, ato: ato.value || undefined,
  entidade: entidade.value || undefined, busca: busca.value || undefined,
}))

const { data, pending, error: falha, refresh } = await useFetch<any>(
  '/api/admin/auditoria', { query: params })

watch(params, (p) => {
  navigateTo({ query: Object.fromEntries(Object.entries(p).filter(([, v]) => v)) },
    { replace: true })
})

const recusado = computed(() => (falha.value as any)?.statusCode === 403)
const motivoDaFalha = computed(() =>
  (falha.value as any)?.data?.statusMessage
  ?? (falha.value as any)?.statusMessage
  ?? 'Não consegui carregar a auditoria.')

const temFiltro = computed(() =>
  !!(de.value || ate.value || pessoa.value || ato.value || entidade.value || busca.value))

function limpar() {
  de.value = ''; ate.value = ''; pessoa.value = ''
  ato.value = ''; entidade.value = ''; busca.value = ''
}

/* ------------------------------------------------------------ período */

/**
 * `toISOString` fica de fora de propósito: ele converte pra UTC antes de
 * cortar, e às 21h de Brasília "hoje" já virou amanhã — o atalho traria o dia
 * errado justo no horário em que a bilheteria trabalha.
 */
const isoLocal = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

const ATALHOS = { hoje: 'Hoje', ontem: 'Ontem', semana: '7 dias', mes: 'Este mês', tudo: 'Tudo' } as const
type Atalho = keyof typeof ATALHOS

function faixaDo(qual: Atalho): [string, string] {
  const hoje = new Date()
  if (qual === 'tudo') return ['', '']
  if (qual === 'hoje') return [isoLocal(hoje), isoLocal(hoje)]
  if (qual === 'ontem') {
    const o = new Date(hoje); o.setDate(o.getDate() - 1)
    return [isoLocal(o), isoLocal(o)]
  }
  if (qual === 'semana') {
    const o = new Date(hoje); o.setDate(o.getDate() - 6)
    return [isoLocal(o), isoLocal(hoje)]
  }
  return [isoLocal(new Date(hoje.getFullYear(), hoje.getMonth(), 1)), isoLocal(hoje)]
}

function periodo(qual: Atalho) {
  const [d, a] = faixaDo(qual)
  de.value = d; ate.value = a
}

const atalhoAtivo = computed<Atalho | null>(() => {
  for (const k of Object.keys(ATALHOS) as Atalho[]) {
    const [d, a] = faixaDo(k)
    if (d === de.value && a === ate.value) return k
  }
  return null
})

/* ------------------------------------------------------- como cada coisa lê */

const brl = (c: number) => (c / 100).toLocaleString('pt-BR',
  { style: 'currency', currency: 'BRL' })

const quandoLegivel = (d: string) => new Date(d).toLocaleString('pt-BR', {
  day: '2-digit', month: '2-digit', year: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
})

/** nome de coluna/campo como o operador fala, não como o banco guarda */
const ENTIDADE_LEGIVEL: Record<string, string> = {
  order: 'Pedido', pedido: 'Pedido', ingresso: 'Ingresso', ticket: 'Ingresso',
  lote: 'Lote', tipo: 'Tipo de ingresso', setor: 'Setor', sector: 'Setor',
  evento: 'Evento', event: 'Evento', payout: 'Transferência', turno: 'Turno de caixa',
  organizacao: 'Organização', usuario: 'Pessoa da equipe',
}
const entidadeLegivel = (e: string) => ENTIDADE_LEGIVEL[e] ?? e

const ACAO_LEGIVEL: Record<string, string> = {
  pago: 'pagamento confirmado', falhou: 'pedido falhou', editado: 'editado',
  apagado: 'apagado', criado: 'criado', cortesia: 'cortesia emitida',
  cortesia_cancelada: 'cortesia cancelada', venda_balcao: 'venda no balcão',
  aberto: 'caixa aberto', fechado: 'caixa fechado', sangria: 'sangria',
  suprimento: 'suprimento', solicitada: 'transferência solicitada',
  transferencia_enviada: 'transferência de ingresso enviada',
  transferencia_aceita: 'transferência de ingresso aceita',
  transferencia_cancelada: 'transferência de ingresso cancelada',
  transferencia_permissao: 'permissão de transferência',
  mapa_gerado: 'mapa de assentos gerado',
}
const acaoLegivel = (a: string) => ACAO_LEGIVEL[a] ?? a.replace(/_/g, ' ')

/** ato que mexe em dinheiro ou tira alguém de dentro pede leitura, não só listagem */
const ACAO_GRAVE = new Set([
  'apagado', 'falhou', 'cortesia_cancelada', 'transferencia_cancelada', 'sangria', 'solicitada',
])

/**
 * Valor de campo em texto. `*Cents` vira moeda porque o número cru (`85000`)
 * é justamente onde alguém lê oitocentos e cinquenta mil.
 */
function valorLegivel(campo: string, v: unknown): string {
  if (v === null || v === undefined || v === '') return '—'
  if (typeof v === 'boolean') return v ? 'sim' : 'não'
  if (typeof v === 'number' && /cents$/i.test(campo)) return brl(v)
  if (typeof v === 'number' && /bps$/i.test(campo)) return `${(v / 100).toLocaleString('pt-BR')}%`
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

const CAMPO_LEGIVEL: Record<string, string> = {
  faceCents: 'valor de face', totalCents: 'total', valorCents: 'valor',
  trocoCents: 'troco', fundoCents: 'fundo de caixa', contadoCents: 'contado',
  esperadoCents: 'esperado', diferencaCents: 'diferença', descontoBps: 'desconto',
  visivel: 'visível', quantidade: 'quantidade', motivo: 'motivo', forma: 'forma',
  ponto: 'ponto de venda', por: 'por', ingressos: 'ingressos', codigo: 'código',
}
const campoLegivel = (c: string) => CAMPO_LEGIVEL[c] ?? c

/**
 * O que mudou, campo a campo.
 *
 * A redução mora AQUI, na leitura, e não na gravação: o registro guarda os
 * dois estados inteiros de propósito, porque o campo que ficou igual costuma
 * ser o que identifica a coisa (o código do ingresso) e é por ele que alguém
 * procura. Quem reduz é a tela, que pode mudar de ideia; a linha, não.
 *
 * O que mudou sobe; o que ficou igual desce e fica apagado, como contexto.
 */
function mudancas(l: any): {
  campo: string; antes: string; depois: string
  so: 'antes' | 'depois' | null; mudou: boolean
}[] {
  const antes = l.antes ?? {}
  const depois = l.depois ?? {}
  const umLadoSo = l.antes && l.depois ? null : (l.antes ? 'antes' : 'depois')
  const chaves = [...new Set([...Object.keys(antes), ...Object.keys(depois)])]

  return chaves
    .map((k) => ({
      campo: campoLegivel(k),
      antes: valorLegivel(k, antes[k]),
      depois: valorLegivel(k, depois[k]),
      so: umLadoSo as 'antes' | 'depois' | null,
      mudou: umLadoSo
        ? true
        : JSON.stringify(antes[k] ?? null) !== JSON.stringify(depois[k] ?? null),
    }))
    .sort((a, b) => Number(b.mudou) - Number(a.mudou))
}

/**
 * As opções dos dois `<select>`, com rótulo que dá pra distinguir.
 *
 * Os mapas acima traduzem o valor cru do banco pra palavra do operador — e aí
 * `ingresso`, `Ingresso` e `ticket` viram TRÊS opções escritas "Ingresso", com
 * contagens diferentes e nenhuma forma de saber qual é qual. Medido no banco
 * agora: `Ingresso (4)`, `Ingresso (1)` e `Ingresso (1)` no mesmo select, e
 * `sector` e `setor` os dois como "Setor". Escolher uma esconde as outras em
 * silêncio, que é exatamente o defeito que a tradução tentava evitar.
 *
 * A regra: rótulo que aparece uma vez só fica limpo; rótulo repetido carrega o
 * valor cru atrás, porque aí a diferença precisa estar na tela. Consertar a
 * origem (um vocabulário só) é serviço dos 26 arquivos que gravam — enquanto
 * isso, a tela mostra o que existe em vez de esconder.
 */
function comRotuloUnico(
  lista: { valor: string; atos: number }[],
  legivel: (v: string) => string,
) {
  const quantos = new Map<string, number>()
  for (const x of lista) quantos.set(legivel(x.valor), (quantos.get(legivel(x.valor)) ?? 0) + 1)
  return lista.map((x) => {
    const r = legivel(x.valor)
    return { ...x, rotulo: (quantos.get(r) ?? 0) > 1 ? `${r} · ${x.valor}` : r }
  })
}

const opcoesEntidades = computed(() =>
  comRotuloUnico(data.value?.opcoes?.entidades ?? [], entidadeLegivel))
const opcoesAtos = computed(() =>
  comRotuloUnico(data.value?.opcoes?.atos ?? [], acaoLegivel))

/** id do registro aberto no detalhe; um por vez pra não virar parede de JSON */
const aberto = ref<number | null>(null)
const alternar = (id: number) => { aberto.value = aberto.value === id ? null : id }
const cru = (l: any) => JSON.stringify({ antes: l.antes, depois: l.depois }, null, 2)

/* ------------------------------------------------------------------- CSV */

function exportar() {
  baixarCsv(
    `auditoria${de.value ? `-${de.value}` : ''}${ate.value ? `-a-${ate.value}` : ''}`,
    ['Quando', 'Quem', 'E-mail', 'IP', 'O que', 'Id', 'Ato', 'Antes', 'Depois'],
    (data.value?.linhas ?? []).map((l: any) => [
      quandoLegivel(l.quando),
      l.autor?.nome ?? 'não registrado',
      l.autor?.email ?? '',
      l.ip ?? '',
      entidadeLegivel(l.entidade),
      l.entidadeId ?? '',
      acaoLegivel(l.acao),
      l.antes ? JSON.stringify(l.antes) : '',
      l.depois ? JSON.stringify(l.depois) : '',
    ]))
}

useHead({ title: 'Auditoria' })
</script>

<template>
  <div>
    <div class="flex flex-wrap items-start justify-between gap-3 py-5">
      <div>
        <h1 class="titulo text-2xl font-bold text-tinta">Auditoria</h1>
        <p class="mt-1 text-tinta-suave">
          Quem fez, o que mudou e quando. Cada ato que mexe em dinheiro ou em ingresso.
        </p>
      </div>
      <!-- O arquivo leva as linhas QUE ESTÃO NA LISTA, e a lista tem teto.
           Num período grande o CSV sai com 200 de 5.000 e ninguém descobre:
           ele é aberto no Excel longe daqui, sem a tela do lado pra
           desmentir. Quando o recorte estoura, o botão diz o tamanho do que
           está levando. -->
      <button type="button" class="btn-secundario" :disabled="!data?.linhas?.length"
              :title="data?.truncado
                ? `O arquivo leva os ${data.linhas.length} atos da lista, não os ${data.total} do período — aperte o período pra levar o resto.`
                : ''"
              @click="exportar">
        <IconeMenu nome="exportar" :tamanho="18" />
        {{ data?.truncado ? `Exportar ${data.linhas.length} de ${data.total}` : 'Exportar' }}
      </button>
    </div>

    <!-- recorte -->
    <div class="card">
      <div class="flex flex-wrap items-end gap-3">
        <label class="block">
          <span class="rotulo">De</span>
          <input v-model="de" type="date" class="campo w-40">
        </label>
        <label class="block">
          <span class="rotulo">Até</span>
          <input v-model="ate" type="date" class="campo w-40">
        </label>
        <label class="block">
          <span class="rotulo">Pessoa</span>
          <select v-model="pessoa" class="campo w-56">
            <option value="">Qualquer pessoa</option>
            <option v-for="x in data?.opcoes?.pessoas ?? []" :key="x.id" :value="x.id">
              {{ x.nome }} ({{ x.atos }})
            </option>
            <option value="sem-autor">— sem autor registrado —</option>
          </select>
        </label>
        <label class="block">
          <span class="rotulo">Ato</span>
          <select v-model="ato" class="campo w-56">
            <option value="">Todos os atos</option>
            <option v-for="x in opcoesAtos" :key="x.valor" :value="x.valor">
              {{ x.rotulo }} ({{ x.atos }})
            </option>
          </select>
        </label>
        <label class="block">
          <span class="rotulo">O que</span>
          <select v-model="entidade" class="campo w-48">
            <option value="">Tudo</option>
            <option v-for="x in opcoesEntidades" :key="x.valor" :value="x.valor">
              {{ x.rotulo }} ({{ x.atos }})
            </option>
          </select>
        </label>
        <label class="block">
          <span class="rotulo">Código ou id</span>
          <input v-model.lazy="busca" type="search" class="campo w-56"
                 placeholder="ex.: DT-4K9XQ2">
        </label>
        <button v-if="temFiltro" type="button" class="btn-secundario" @click="limpar">
          Limpar filtros
        </button>
      </div>

      <div class="mt-3 flex flex-wrap items-center gap-2 border-t border-linha pt-3">
        <span class="text-xs text-tinta-fraca">Período:</span>
        <button v-for="(rotulo, chave) in ATALHOS" :key="chave" type="button"
                :class="atalhoAtivo === chave ? 'chip-ativo' : 'chip'"
                @click="periodo(chave)">
          {{ rotulo }}
        </button>
      </div>
    </div>

    <div v-if="falha" class="faixa-erro mt-4">
      {{ motivoDaFalha }}
      <button v-if="!recusado" type="button" class="underline" @click="refresh()">
        Tentar de novo
      </button>
    </div>

    <template v-if="data">
      <!-- o tamanho do recorte, e o tamanho do que ele não sabe -->
      <div class="mt-4 grid gap-3 sm:grid-cols-3">
        <div class="card">
          <p class="rotulo-kpi">Atos no período</p>
          <p class="numero-kpi mt-1">{{ data.total.toLocaleString('pt-BR') }}</p>
          <p v-if="data.truncado" class="mt-1 text-xs text-alerta">
            mostrando os {{ data.linhas.length }} mais recentes — aperte o período pra ver o resto
          </p>
          <p v-else class="mt-1 text-xs text-tinta-fraca">todos estão na lista abaixo</p>
        </div>
        <!-- o número é o do RECORTE, como os outros dois do lado. Já foi o
             tamanho de `opcoes.pessoas`, que é a lista do filtro e cobre a
             organização inteira: num período sem nenhum ato a tela dizia
             "0 atos" e "3 pessoas" lado a lado. -->
        <div class="card">
          <p class="rotulo-kpi">Pessoas no período</p>
          <p class="numero-kpi mt-1">{{ data.pessoas.toLocaleString('pt-BR') }}</p>
          <p class="mt-1 text-xs text-tinta-fraca">com ao menos um ato neste recorte</p>
        </div>
        <div class="card">
          <p class="rotulo-kpi">Sem autor registrado</p>
          <p class="numero-kpi mt-1" :class="data.semAutor ? 'text-alerta' : ''">
            {{ data.semAutor.toLocaleString('pt-BR') }}
          </p>
          <p class="mt-1 text-xs text-tinta-fraca">
            atos gravados antes de o registro passar a exigir quem fez
          </p>
        </div>
      </div>

      <div v-if="data.semAutor" class="faixa-aviso mt-3">
        {{ data.semAutor.toLocaleString('pt-BR') }} destes atos não anotaram quem fez.
        Filtrar por pessoa não alcança nenhum deles — vazio aqui significa
        “não foi anotado”, não “ninguém fez”.
      </div>

      <!-- as linhas -->
      <p v-if="!data.linhas.length" class="card mt-4 py-12 text-center text-tinta-suave">
        {{ temFiltro ? 'Nenhum ato neste recorte.' : 'Nenhum ato registrado ainda.' }}
      </p>

      <div v-else class="card mt-4 overflow-x-auto p-0">
        <table class="w-full min-w-[900px] border-collapse text-sm">
          <thead>
            <tr class="border-b border-linha bg-fundo-cinza/60 text-left">
              <th class="titulo px-4 py-2 text-xs font-bold uppercase tracking-wide text-tinta-rotulo">Quando</th>
              <th class="titulo px-3 py-2 text-xs font-bold uppercase tracking-wide text-tinta-rotulo">Quem</th>
              <th class="titulo px-3 py-2 text-xs font-bold uppercase tracking-wide text-tinta-rotulo">O que</th>
              <th class="titulo px-3 py-2 text-xs font-bold uppercase tracking-wide text-tinta-rotulo">Mudou</th>
              <th class="titulo px-4 py-2 text-right text-xs font-bold uppercase tracking-wide text-tinta-rotulo">Registro</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="l in data.linhas" :key="l.id">
              <tr class="border-b border-linha align-top">
                <td class="whitespace-nowrap px-4 py-3 tabular-nums text-tinta-suave">
                  {{ quandoLegivel(l.quando) }}
                </td>
                <td class="px-3 py-3">
                  <span v-if="l.autor" class="font-medium text-tinta">{{ l.autor.nome }}</span>
                  <span v-else class="text-alerta">não registrado</span>
                  <span v-if="l.autor?.removido" class="selo-alerta ml-1">saiu da equipe</span>
                  <span v-if="l.ip" class="block text-xs text-tinta-fraca">{{ l.ip }}</span>
                </td>
                <td class="px-3 py-3">
                  <!-- Uma cor só por elemento. Escrito como `class="text-tinta"`
                       fixo mais `:class="... 'text-erro'"` condicional, quem
                       ganha é a ORDEM DO CSS gerado, não a ordem no atributo:
                       medido no navegador, o vermelho do ato grave saía
                       #171719 — o `font-medium` aplicava e a cor não, sem erro
                       no console e sem teste vermelho. -->
                  <span class="block"
                        :class="ACAO_GRAVE.has(l.acao) ? 'font-medium text-erro' : 'text-tinta'">
                    {{ acaoLegivel(l.acao) }}
                  </span>
                  <span class="block text-xs text-tinta-fraca">
                    {{ entidadeLegivel(l.entidade) }}
                    <template v-if="l.entidadeId"> · {{ l.entidadeId.slice(0, 8) }}</template>
                  </span>
                </td>
                <td class="px-3 py-3">
                  <span v-if="!mudancas(l).length" class="text-tinta-fraca">—</span>
                  <span v-for="m in mudancas(l)" :key="m.campo" class="block">
                    <span :class="m.mudou ? 'text-tinta-suave' : 'text-tinta-fraca'">
                      {{ m.campo }}:
                    </span>
                    <template v-if="m.so === 'depois'">
                      <span class="text-tinta"> {{ m.depois }}</span>
                    </template>
                    <template v-else-if="m.so === 'antes'">
                      <span class="text-tinta line-through"> {{ m.antes }}</span>
                    </template>
                    <template v-else-if="m.mudou">
                      <span class="text-tinta-fraca line-through"> {{ m.antes }}</span>
                      <span class="font-medium text-tinta"> → {{ m.depois }}</span>
                    </template>
                    <!-- ficou igual: entra como contexto, não como mudança -->
                    <template v-else>
                      <span class="text-tinta-fraca"> {{ m.depois }}</span>
                    </template>
                  </span>
                </td>
                <td class="px-4 py-3 text-right">
                  <button type="button" class="text-acao hover:underline"
                          @click="alternar(l.id)">
                    {{ aberto === l.id ? 'fechar' : 'ver' }}
                  </button>
                </td>
              </tr>
              <tr v-if="aberto === l.id" class="border-b border-linha bg-fundo-cinza/40">
                <td colspan="5" class="px-4 py-3">
                  <span class="block text-xs text-tinta-fraca">
                    registro #{{ l.id }}
                    <template v-if="l.entidadeId"> · {{ l.entidade }} {{ l.entidadeId }}</template>
                    <template v-if="l.autor?.email"> · {{ l.autor.email }}</template>
                  </span>
                  <pre class="mt-2 overflow-x-auto text-xs text-tinta-corpo">{{ cru(l) }}</pre>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
    </template>

    <p v-else-if="pending" class="card mt-4 py-12 text-center text-tinta-suave">Carregando…</p>
  </div>
</template>
