<script setup lang="ts">
/**
 * Financeiro da organização — o caixa somando todos os eventos.
 *
 * A pergunta desta tela não é a mesma do financeiro de dentro do evento. Lá é "quanto sobra deste
 * show"; aqui é "quanto a produtora tem pra receber no total, o que ainda está preso em evento que
 * não acabou, e o que já saiu".
 *
 * ## O redesenho de 27/09 (auditoria FIN-01…FIN-10, propostas 11–14)
 *
 *   · o topo diz PARA ONDE FOI o líquido numa barra só: transferido, em curso, disponível, retido e
 *     recebido direto — as partes somam o total (e o saldo devedor aparece em vermelho, com nome,
 *     quando um estorno depois do saque deixou a conta negativa: FIN-03);
 *   · "Entrada por mês" é líquido ou cobrado (chip), com mês zero no lugar e o ano no eixo (FIN-01,
 *     FIN-04, FIN-08), dentro de um PERÍODO que vai na URL (FIN-05);
 *   · o botão de enviar conta só o que ele envia — PIX solicitado; conta bancária aparece à parte
 *     como transferência manual, com valor (FIN-02);
 *   · o histórico de transferências tem páginas e selo em português (FIN-07); CSV pelo `baixarCsv`
 *     (FIN-06); quem vê o botão é a régua de `papeis.ts`, não uma lista na tela (FIN-09); os avisos
 *     do gateway que chegaram e não foram aplicados ganham bloco próprio (FIN-10).
 *
 * Os números são os mesmos de antes (`saldoParaSaque`, `liquido.ts`): o saldo não tem período —
 * é o estado de agora; o período vale pro FLUXO (entrada, como entrou, transferências).
 */
import { baixarCsv } from '~/composables/baixarCsv'
import { useConsultaNaUrl } from '~/composables/consultaNaUrl'
import { centavosParaPlanilha } from '~/composables/painelPlanilha'
import { ehPapel, papelPode, type Papel } from '~~/server/utils/papeis'
import { ehChavePeriodo, problemaNoPeriodo, rotuloDoPeriodo, type ChavePeriodo } from '~/composables/painelPeriodo'
import { detalheDoPonto, escolherPasso, serieContinua, type Passo } from '~/composables/painelGrafico'
import PainelKpi from '~/components/painel/Kpi.vue'
import PainelGraficoBarras from '~/components/painel/GraficoBarras.vue'
import PainelPeriodo from '~/components/painel/Periodo.vue'
import PainelVazio from '~/components/painel/Vazio.vue'
import PainelFalha from '~/components/painel/Falha.vue'
import PainelBarraEmpilhada from '~/components/painel/BarraEmpilhada.vue'
import PainelEsqueleto from '~/components/painel/Esqueleto.vue'

definePageMeta({ layout: 'admin' })

// a URL é a fonte do recorte; `atual` é a última pedida enquanto a navegação anda (consultaNaUrl.ts)
const consulta = useConsultaNaUrl()
/**
 * O padrão desta tela é "Tudo" (a Visão geral abre em 30 dias): o saldo é acumulado por natureza,
 * e com o fluxo também desde o começo o total líquido, a soma das barras e "como entrou" falam da
 * mesma população ao abrir. Os atalhos estão ali pra aproximar.
 */
const PADRAO: ChavePeriodo = 'tudo'

/* ------------------------------------------------------------- o recorte */

const texto = (v: unknown) => (typeof v === 'string' && v ? v : null)
const filtro = computed(() => {
  const q = consulta.atual.value
  const de0 = texto(q.de)
  const ate0 = texto(q.ate)
  const aMao = !!(de0 || ate0) && !problemaNoPeriodo(de0, ate0)
  const pagina = Math.max(1, Math.trunc(Number(q.pagina ?? 1)) || 1)
  return {
    de: aMao ? de0 : null,
    ate: aMao ? ate0 : null,
    periodo: aMao ? null : (ehChavePeriodo(q.periodo) ? q.periodo : PADRAO) as ChavePeriodo | null,
    pagina,
  }
})
const params = computed(() => {
  const f = filtro.value
  const p: Record<string, string | number> = {}
  if (f.periodo) p.periodo = f.periodo
  if (f.de) p.de = f.de
  if (f.ate) p.ate = f.ate
  if (f.pagina > 1) p.pagina = f.pagina
  return p
})

const { data, pending, error: falha, refresh } = await useFetch<any>('/api/admin/financeiro', { query: params })
// o MESMO `auth-eu` do layout: uma ida ao servidor pras duas telas
const { data: eu } = await useFetch<any>('/api/auth/eu', { key: 'auth-eu' })
const papel = computed<Papel | null>(() => {
  const p = eu.value?.usuario?.papel
  return ehPapel(p) ? p : null
})
/**
 * FIN-09: quem pode mandar dinheiro embora é a régua de `utils/papeis.ts` (`/api/admin/payout` é
 * área `dinheiro`), não uma segunda lista escrita aqui. Esconder o botão é conforto; quem tranca é
 * o servidor.
 */
const podeEnviar = computed(() => !!papel.value && papelPode(papel.value, 'dinheiro'))

function irPara(mudanca: Partial<{ periodo: string | null; de: string | null; ate: string | null; pagina: number }>) {
  const f = { ...filtro.value, pagina: 1, ...mudanca }
  const query: Record<string, string> = {}
  if (f.de || f.ate) {
    if (f.de) query.de = f.de
    if (f.ate) query.ate = f.ate
  } else if (f.periodo && f.periodo !== PADRAO) {
    query.periodo = f.periodo
  }
  if (f.pagina > 1) query.pagina = String(f.pagina)
  return consulta.escrever(query)
}
const escolherPeriodo = (chave: string) => irPara({ periodo: chave, de: null, ate: null })
const escolherDatas = (p: { de: string | null; ate: string | null }) => irPara({ periodo: null, de: p.de, ate: p.ate })
const irParaPagina = (n: number) => irPara({ pagina: n })

const resolvido = computed(() => ({ de: data.value?.filtro?.de ?? null, ate: data.value?.filtro?.ate ?? null }))
const nomeDoRecorte = computed(() => rotuloDoPeriodo(resolvido.value.de, resolvido.value.ate))

/* ------------------------------------------------------ como cada coisa lê */

const brl = reais
const SITUACAO_DA_TRANSFERENCIA: Record<string, { texto: string; classe: string }> = {
  concluida: { texto: 'Concluída', classe: 'selo-ok' },
  solicitada: { texto: 'Solicitada', classe: 'selo-alerta' },
  processando: { texto: 'Processando', classe: 'selo-alerta' },
  falhou: { texto: 'Falhou', classe: 'selo-erro' },
  cancelada: { texto: 'Cancelada', classe: 'selo-neutro' },
}
const FORMA: Record<string, string> = {
  pix: 'PIX', credito: 'Cartão de crédito', debito: 'Cartão de débito',
  dinheiro: 'Dinheiro', cortesia: 'Cortesia',
}
const DESTINO: Record<string, string> = { pix: 'PIX', conta: 'Conta bancária' }
const n = (v: number | null | undefined) => Number(v ?? 0).toLocaleString('pt-BR')

const t = computed(() => data.value?.totais ?? {})

/** eventos com dinheiro em jogo primeiro — o resto é ruído nesta tela */
const comMovimento = computed(() =>
  (data.value?.eventos ?? []).filter((e: any) => e.faceCents > 0 || e.transferidoCents > 0 || e.liquidoCents > 0))

/* ------------------------------------------- para onde foi o líquido */

/**
 * As cinco partes somam o total líquido (proposta 12 — e a matriz: "Retido + Disponível +
 * Transferido + Em curso + Recebido direto = Total líquido"). Com saldo devedor, as partes passam do
 * total exatamente no valor que o evento deve — por isso ele aparece logo abaixo, em vermelho.
 */
const partes = computed(() => [
  { rotulo: 'Transferido', valor: Number(t.value.transferidoCents ?? 0), cor: '#16a34a', texto: brl(t.value.transferidoCents ?? 0), dica: 'já caiu na conta do produtor' },
  { rotulo: 'Em curso', valor: Number(t.value.emCursoCents ?? 0), cor: '#f29b0c', texto: brl(t.value.emCursoCents ?? 0), dica: 'saque pedido, ainda não concluído' },
  { rotulo: 'Disponível', valor: Number(t.value.disponivelCents ?? 0), cor: '#1789a1', texto: brl(t.value.disponivelCents ?? 0), dica: 'pode ser transferido agora' },
  { rotulo: 'Retido', valor: Number(t.value.retidoCents ?? 0), cor: '#9877c5', texto: brl(t.value.retidoCents ?? 0), dica: `libera ${data.value?.diasDeRetencao ?? 2} dias depois do fim do evento` },
  { rotulo: 'Recebido direto', valor: Number(t.value.recebidoDiretoCents ?? 0), cor: '#7b921b', texto: brl(t.value.recebidoDiretoCents ?? 0), dica: 'dinheiro no balcão, pix na sua chave ou Pix no Mercado Pago' },
])
const devedor = computed(() => Number(t.value.saldoDevedorCents ?? 0))

/* ------------------------------------------------------------- saques */

type Grupo = { pedidos: number; valorCents: number }
const somar = (lista: any[]): Grupo => ({ pedidos: lista.length, valorCents: lista.reduce((s, x) => s + Number(x.valorCents), 0) })
/**
 * FIN-02: o botão executa `SQL_FILA_DE_PAYOUTS` — só PIX 'solicitada'. A rota manda os grupos já
 * contados no banco (a lista de transferências é paginada e não serve de contagem); sem eles (uma
 * resposta antiga), a conta sai da própria lista, com a MESMA régua.
 */
const saques = computed(() => {
  const s = data.value?.saques
  if (s) return s as { enviaveis: Grupo; manuais: Grupo; emVoo: Grupo }
  const lista: any[] = data.value?.transferencias ?? []
  return {
    enviaveis: somar(lista.filter((x) => x.status === 'solicitada' && x.destinoTipo === 'pix')),
    manuais: somar(lista.filter((x) => x.status === 'solicitada' && x.destinoTipo !== 'pix')),
    emVoo: somar(lista.filter((x) => x.status === 'processando')),
  }
})

const enviando = ref(false)
const recadoEnvio = ref<{ tipo: 'ok' | 'aviso' | 'erro'; texto: string } | null>(null)

async function enviarSaques() {
  // trava de duplo clique ANTES do confirm: o segundo clique não abre outra pergunta
  if (enviando.value) return
  const { pedidos: qtd, valorCents } = saques.value.enviaveis
  if (!qtd) return
  const manuais = saques.value.manuais
  const pergunta = `Enviar ${qtd} ${qtd === 1 ? 'saque PIX pendente' : 'saques PIX pendentes'} (${brl(valorCents)}) agora?\n\n`
    + 'O dinheiro sai da plataforma para a conta de cada beneficiário. Isso não pode ser desfeito por aqui.'
    + (manuais.pedidos
      ? `\n\n${manuais.pedidos} ${manuais.pedidos === 1 ? 'saque' : 'saques'} para conta bancária (${brl(manuais.valorCents)}) não saem por este botão: a transferência é feita à mão no painel do Asaas.`
      : '')
  if (!confirm(pergunta)) return

  enviando.value = true
  recadoEnvio.value = null
  try {
    const r = await $fetch<any>('/api/admin/payout/executar', { method: 'POST', body: {} })
    // A frase é a da rota (`mensagemDoOperador`): ela já diz o que saiu, o que
    // voltou pra fila e o que precisa de mão humana. A tela não reescreve.
    const simulado = r?.simulado
      ? ' (pagamento simulado nesta máquina — nenhuma transferência de verdade saiu)'
      : ''
    const algoDeuErrado = Number(r?.falhados ?? 0) + Number(r?.semDesfecho ?? 0)
      + Number(r?.devolvidos ?? 0) > 0
    recadoEnvio.value = {
      tipo: algoDeuErrado ? 'aviso' : 'ok',
      texto: `${r?.mensagem ?? 'Fila de saques executada.'}${simulado}`,
    }
  } catch (e: any) {
    // 503 = Asaas não configurado: a rota manda o recado pronto, com o que fazer
    recadoEnvio.value = {
      tipo: 'erro',
      texto: e?.data?.statusMessage || e?.statusMessage
        || 'Não foi possível enviar os saques agora. Confira a conexão e tente de novo.',
    }
  } finally {
    enviando.value = false
    // recarrega mesmo no erro: parte da fila pode ter andado antes da falha
    await refresh()
  }
}

/* -------------------------------------------- avisos do gateway (FIN-10) */

const { data: entregas, refresh: recarregarEntregas } = await useFetch<any>('/api/admin/financeiro/entregas', {
  key: 'financeiro-entregas', query: { limite: 20 },
})
const reprocessando = ref<string | null>(null)
const recadoEntregas = ref<{ tipo: 'ok' | 'erro'; texto: string } | null>(null)
async function reprocessar(id?: string) {
  if (reprocessando.value) return
  reprocessando.value = id ?? 'todas'
  recadoEntregas.value = null
  try {
    const r = await $fetch<any>('/api/admin/financeiro/entregas', { method: 'POST', body: id ? { id } : {} })
    recadoEntregas.value = { tipo: r?.ok === false ? 'erro' : 'ok', texto: r?.aviso ?? 'Pronto.' }
  } catch (e: any) {
    recadoEntregas.value = { tipo: 'erro', texto: e?.data?.statusMessage || e?.statusMessage || 'Não deu pra reprocessar agora.' }
  } finally {
    reprocessando.value = null
    await Promise.all([recarregarEntregas(), refresh()])
  }
}

/* ------------------------------------------------------------ o gráfico */

const campoGrafico = ref<'liquidoCents' | 'cobradoCents'>('liquidoCents')
const faixaDoGrafico = computed(() => {
  const f = data.value?.filtro ?? {}
  const dias: any[] = data.value?.porDia ?? []
  const de = f.de ?? f.primeiroDia ?? dias[0]?.dia ?? null
  const ate = f.ate ?? f.hoje ?? dias[dias.length - 1]?.dia ?? null
  return de && ate && de <= ate ? { de: String(de).slice(0, 10), ate: String(ate).slice(0, 10) } : null
})
const passo = computed<Passo>(() => (faixaDoGrafico.value ? escolherPasso(faixaDoGrafico.value.de, faixaDoGrafico.value.ate) : 'mes'))
const CAMPOS = ['cobradoCents', 'liquidoCents', 'pedidos']
/**
 * A série vem do `porDia` em qualquer passo — `serieContinua` soma os dias dentro da semana ou do
 * mês. O `porMes` da rota começa no dia 1º, e com o período começando no meio do mês a primeira
 * barra ficaria de fora do recorte.
 */
const serie = computed(() => {
  const fx = faixaDoGrafico.value
  return fx ? serieContinua(data.value?.porDia ?? [], fx.de, fx.ate, passo.value, CAMPOS) : []
})
const pontos = computed(() => serie.value.map((p) => ({
  chave: p.chave,
  valor: Number(p[campoGrafico.value]),
  extra: `${n(Number(p.pedidos))} ${Number(p.pedidos) === 1 ? 'pedido' : 'pedidos'}`,
})))
const tituloDoGrafico = computed(() => ({ dia: 'Entrada por dia', semana: 'Entrada por semana', mes: 'Entrada por mês' })[passo.value])
const temEntrada = computed(() => pontos.value.some((p) => p.valor > 0))

/* ------------------------------------------------------ transferências */

const totalTransferencias = computed(() => Number(data.value?.transferenciasTotal ?? data.value?.transferencias?.length ?? 0))
const porPagina = computed(() => Number(data.value?.porPagina ?? 25))
const paginaAtual = computed(() => Number(data.value?.pagina ?? 1))
const ultimaPagina = computed(() => Math.max(1, Math.ceil(totalTransferencias.value / porPagina.value)))
const faixaDaPagina = computed(() => {
  const ini = (paginaAtual.value - 1) * porPagina.value + 1
  const fim = Math.min(totalTransferencias.value, ini + (data.value?.transferencias?.length ?? 0) - 1)
  return totalTransferencias.value ? `${n(ini)}–${n(fim)} de ${n(totalTransferencias.value)}` : ''
})

/* ------------------------------------------------------------ planilhas */

const exportarAberto = ref(false)
const PLANILHAS = computed(() => {
  const d = data.value
  if (!d) return []
  return [
    {
      nome: 'Por evento', arquivo: 'por-evento',
      cab: ['Evento', 'Situação', 'Termina', 'Pedidos', 'Face (R$)', 'Taxa (R$)', 'Estornado (R$)', 'Líquido (R$)',
        'Na plataforma (R$)', 'Recebido direto (R$)', 'Transferido (R$)', 'Em curso (R$)', 'Retido (R$)',
        'Disponível (R$)', 'Saldo devedor (R$)'],
      linhas: comMovimento.value.map((e: any) => [
        e.nome, e.status, dataCurta(e.termina, ''), e.pedidos,
        centavosParaPlanilha(e.faceCents), centavosParaPlanilha(e.taxaCents), centavosParaPlanilha(e.estornadoCents),
        centavosParaPlanilha(e.liquidoCents), centavosParaPlanilha(e.naPlataformaCents), centavosParaPlanilha(e.recebidoDiretoCents),
        centavosParaPlanilha(e.transferidoCents), centavosParaPlanilha(e.emCursoCents), centavosParaPlanilha(e.retidoCents),
        centavosParaPlanilha(e.disponivelCents), centavosParaPlanilha(e.saldoDevedorCents ?? 0)]),
    },
    {
      nome: 'Entrada por dia', arquivo: 'entrada-por-dia', cab: ['Dia', 'Pedidos', 'Cobrado (R$)', 'Líquido (R$)'],
      linhas: (faixaDoGrafico.value
        ? serieContinua(d.porDia ?? [], faixaDoGrafico.value.de, faixaDoGrafico.value.ate, 'dia', CAMPOS)
        : []).map((p) => [dataCurta(p.chave), Number(p.pedidos), centavosParaPlanilha(Number(p.cobradoCents)), centavosParaPlanilha(Number(p.liquidoCents))]),
    },
    {
      nome: 'Como entrou', arquivo: 'como-entrou', cab: ['Forma', 'Pedidos', 'Cobrado (R$)', 'Líquido (R$)'],
      linhas: (d.porForma ?? []).map((f: any) => [FORMA[f.forma] ?? 'Não informada', f.pedidos,
        centavosParaPlanilha(f.cobradoCents), centavosParaPlanilha(f.liquidoCents ?? 0)]),
    },
    {
      nome: 'Transferências (esta página)', arquivo: 'transferencias',
      cab: ['Código', 'Beneficiário', 'Evento', 'Destino', 'Pedido em', 'Pedido por', 'Valor (R$)', 'Situação'],
      linhas: (d.transferencias ?? []).map((x: any) => [x.codigo, x.beneficiario, x.evento ?? '', DESTINO[x.destinoTipo] ?? x.destinoTipo ?? '',
        dataCurta(x.solicitadaEm, ''), x.pedidoPor ?? '', centavosParaPlanilha(x.valorCents),
        SITUACAO_DA_TRANSFERENCIA[x.status]?.texto ?? x.status]),
    },
  ]
})
function exportar(p: { arquivo: string; cab: string[]; linhas: (string | number)[][] }) {
  exportarAberto.value = false
  const f = data.value?.filtro ?? {}
  const sufixo = f.de || f.ate ? `${f.de ?? 'inicio'}-a-${f.ate ?? 'hoje'}` : 'todo-o-periodo'
  baixarCsv(`financeiro-${p.arquivo}-${sufixo}`, p.cab, p.linhas)
}

useHead({ title: 'Financeiro' })
</script>

<template>
  <div class="pb-10">
    <!-- ================================================================ topo -->
    <div class="flex flex-wrap items-start justify-between gap-3 py-5">
      <div class="min-w-0">
        <h1 class="titulo text-2xl font-semibold text-ink-900 sm:text-[28px]">Financeiro</h1>
        <p class="mt-1 text-[15px] text-ink-700">
          O caixa somando todos os eventos. O dinheiro de cada um libera
          {{ data?.diasDeRetencao ?? 2 }} dias depois de ele terminar.
        </p>
      </div>
      <div class="relative">
        <button type="button" class="btn-secundario min-h-[40px]" :disabled="!data" :aria-expanded="exportarAberto"
                data-acao="exportar" @click="exportarAberto = !exportarAberto">
          <IconeMenu nome="exportar" :tamanho="18" /> Exportar planilhas <IconeMenu nome="baixo" :tamanho="14" />
        </button>
        <div v-if="exportarAberto" class="absolute right-0 z-20 mt-2 w-72 rounded-2xl bg-white p-2 shadow-pop ring-1 ring-ink-200">
          <p class="px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-ink-600">Um arquivo por tabela</p>
          <button v-for="p in PLANILHAS" :key="p.arquivo" type="button"
                  class="flex min-h-[40px] w-full items-center justify-between gap-3 rounded-xl px-3 text-left text-sm font-medium text-ink-900 hover:bg-pool-50"
                  :data-planilha="p.arquivo" @click="exportar(p)">
            {{ p.nome }} <span class="text-xs font-normal text-ink-600">{{ n(p.linhas.length) }} linhas</span>
          </button>
        </div>
      </div>
    </div>

    <p v-if="recadoEnvio" role="status" data-parte="recado-envio" class="mb-4"
       :class="recadoEnvio.tipo === 'erro' ? 'faixa-erro' : recadoEnvio.tipo === 'aviso' ? 'faixa-aviso'
         : 'rounded-xl bg-success-50 px-4 py-3 text-sm leading-6 text-success-800 ring-1 ring-inset ring-success-600/30'">
      {{ recadoEnvio.texto }}
    </p>

    <PainelFalha v-if="falha" :falha="falha" o-que="o financeiro" :tentar="refresh" />
    <PainelEsqueleto v-else-if="!data && pending" />

    <template v-else-if="data">
      <!-- ============================================== o saldo (é de AGORA) -->
      <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <PainelKpi rotulo="Total líquido" :valor="brl(t.liquidoCents ?? 0)" tom="grape" icone="carteira" destaque data-kpi="liquido">
          <!-- div, não p: o navegador fecha um <p> sozinho ao ver bloco dentro -->
          <div class="grid gap-0.5 tabular-nums">
            <div class="flex justify-between gap-3"><span>na plataforma</span><span>{{ brl(t.naPlataformaCents ?? 0) }}</span></div>
            <div class="flex justify-between gap-3"><span>recebido direto por você</span><span>{{ brl(t.recebidoDiretoCents ?? 0) }}</span></div>
          </div>
        </PainelKpi>
        <PainelKpi rotulo="Disponível" :valor="brl(t.disponivelCents ?? 0)" tom="ok" icone="check" data-kpi="disponivel">
          pode ser transferido agora — já descontado o que está pedido
        </PainelKpi>
        <PainelKpi rotulo="Retido" :valor="brl(t.retidoCents ?? 0)" tom="sun" icone="calendario" data-kpi="retido">
          preso em evento que ainda não terminou (ou terminou há menos de {{ data.diasDeRetencao }} dias)
        </PainelKpi>
        <PainelKpi rotulo="Transferido" :valor="brl(t.transferidoCents ?? 0)" tom="pool" icone="financeiro" data-kpi="transferido">
          <template v-if="t.emCursoCents">+ {{ brl(t.emCursoCents) }} em curso</template>
          <template v-else>nada em curso agora</template>
        </PainelKpi>
      </div>

      <section class="card mt-4" aria-labelledby="titulo-destino">
        <h2 id="titulo-destino" class="titulo text-lg font-semibold text-ink-900">Para onde foi o líquido</h2>
        <p class="mb-4 text-sm text-ink-700">As partes somam o total líquido de {{ brl(t.liquidoCents ?? 0) }}. Saldo é de agora: não muda com o período.</p>
        <PainelBarraEmpilhada :partes="partes" rotulo-acessivel="Para onde foi o líquido" />

        <!-- FIN-03: a conta negativa não some num zero -->
        <p v-if="devedor" class="mt-4 flex items-start gap-2 rounded-xl bg-danger-50 px-4 py-3 text-sm text-danger-800 ring-1 ring-inset ring-danger-600/30"
           role="alert" data-parte="saldo-devedor">
          <IconeMenu nome="voltar" :tamanho="18" class="mt-0.5 shrink-0" />
          <span>
            <strong class="tabular-nums">Saldo devedor −{{ brl(devedor) }}</strong> — houve devolução ao comprador depois do saque, e o
            que já foi transferido passou do que ficou na plataforma. Enquanto a conta do evento estiver negativa, ele não libera saque novo.
          </span>
        </p>

        <!-- O recebido direto NÃO é saldo: é dinheiro que já está com o produtor
             (espécie na gaveta, pix na chave dele). Nomeado aqui, com a mesma
             frase do financeiro do evento e do borderô, pra ninguém somar o
             líquido e achar que a plataforma deve a diferença. -->
        <p v-if="t.recebidoDiretoCents" class="mt-4 text-sm text-ink-700" data-parte="recebido-direto">
          <strong class="text-ink-900">{{ brl(t.recebidoDiretoCents) }}</strong>
          recebidos direto (dinheiro no balcão, pix na sua chave ou Pix no Mercado Pago) já estão com você e não
          entram no saldo a transferir.
        </p>
      </section>

      <!-- =============================================== o fluxo (tem período) -->
      <div class="card mt-4 grid gap-4">
        <PainelPeriodo :periodo="filtro.periodo" :de="resolvido.de" :ate="resolvido.ate" :carregando="pending"
                       @escolher="escolherPeriodo" @datas="escolherDatas" />
        <p class="flex flex-wrap items-baseline gap-x-2 text-ink-800" data-parte="no-periodo">
          Entrou {{ resolvido.de || resolvido.ate ? `em ${nomeDoRecorte}` : 'desde o começo' }}:
          <strong class="titulo text-xl tabular-nums text-grape-800">{{ brl(data.noPeriodo?.liquidoCents ?? 0) }}</strong> líquidos
          <span class="text-sm text-ink-600">
            de {{ brl(data.noPeriodo?.cobradoCents ?? 0) }} cobrados em {{ n(data.noPeriodo?.pedidos ?? 0) }} pedidos
          </span>
        </p>
      </div>

      <section v-if="pontos.length" class="card mt-4" aria-labelledby="titulo-entrada">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 id="titulo-entrada" class="titulo text-lg font-semibold text-ink-900">{{ tituloDoGrafico }}</h2>
            <p class="text-sm text-ink-700">
              {{ campoGrafico === 'liquidoCents' ? 'Líquido do produtor' : 'Total cobrado do comprador' }}, pelo dia do pagamento.
            </p>
          </div>
          <div class="flex gap-2" role="group" aria-label="O que o gráfico mostra">
            <button type="button" class="min-h-[40px] sm:min-h-0" :class="campoGrafico === 'liquidoCents' ? 'chip-ativo' : 'chip'"
                    :aria-pressed="campoGrafico === 'liquidoCents'" @click="campoGrafico = 'liquidoCents'">Líquido</button>
            <button type="button" class="min-h-[40px] sm:min-h-0" :class="campoGrafico === 'cobradoCents' ? 'chip-ativo' : 'chip'"
                    :aria-pressed="campoGrafico === 'cobradoCents'" @click="campoGrafico = 'cobradoCents'">Cobrado</button>
          </div>
        </div>
        <div class="mt-5">
          <PainelGraficoBarras v-if="temEntrada" :pontos="pontos" :passo="passo" :formatar="brl"
                               :cor="campoGrafico === 'liquidoCents' ? '#583c8d' : '#1789a1'"
                               :rotulo-acessivel="`${tituloDoGrafico}, ${nomeDoRecorte}`" />
          <p v-else class="py-8 text-center text-sm text-ink-700">Nenhuma venda paga nesse período.</p>
        </div>
      </section>

      <!-- ================================= como entrou + saques (grade que se ajusta) -->
      <div class="mt-4 grid gap-4" :class="data.porForma?.length ? 'lg:grid-cols-2' : ''">
        <section v-if="data.porForma?.length" class="card" aria-labelledby="titulo-forma">
          <h2 id="titulo-forma" class="titulo text-lg font-semibold text-ink-900">Como entrou</h2>
          <p class="text-sm text-ink-700">No período, por forma de pagamento.</p>
          <table class="mt-3 w-full text-sm">
            <thead>
              <tr class="border-b border-ink-200 text-left text-xs font-semibold uppercase tracking-wide text-ink-600">
                <th class="py-2 font-semibold">Forma</th><th class="py-2 text-right font-semibold">Pedidos</th>
                <th class="py-2 text-right font-semibold">Cobrado</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="f in data.porForma" :key="f.forma ?? 'sem'" class="border-b border-ink-100 last:border-0" data-parte="linha-forma">
                <td class="py-2.5 font-medium text-ink-900">{{ FORMA[f.forma] ?? 'Não informada' }}</td>
                <td class="py-2.5 text-right tabular-nums text-ink-800">{{ n(f.pedidos) }}</td>
                <td class="py-2.5 text-right tabular-nums text-ink-900">{{ brl(f.cobradoCents) }}</td>
              </tr>
            </tbody>
          </table>
        </section>

        <section class="card" aria-labelledby="titulo-saques" data-parte="saques">
          <h2 id="titulo-saques" class="titulo text-lg font-semibold text-ink-900">Saques esperando</h2>
          <p class="text-sm text-ink-700">O pedido de saque é feito no financeiro de cada evento; o envio sai daqui.</p>
          <ul class="mt-3 grid gap-2">
            <li class="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-pool-50 px-4 py-3" data-parte="saques-pix">
              <div>
                <p class="font-semibold text-ink-900">PIX</p>
                <p class="text-sm text-ink-700">
                  <template v-if="saques.enviaveis.pedidos">
                    {{ n(saques.enviaveis.pedidos) }} {{ saques.enviaveis.pedidos === 1 ? 'saque pedido' : 'saques pedidos' }} ·
                    <strong class="tabular-nums text-ink-900">{{ brl(saques.enviaveis.valorCents) }}</strong>
                  </template>
                  <template v-else>Nenhum saque esperando envio.</template>
                </p>
              </div>
              <button v-if="podeEnviar" type="button" class="btn-primario min-h-[40px]" data-acao="enviar-saques"
                      :disabled="enviando || !saques.enviaveis.pedidos"
                      :title="saques.enviaveis.pedidos ? '' : 'Nenhum saque esperando envio'"
                      @click="enviarSaques">
                {{ enviando ? 'Enviando…' : `Enviar saques pendentes (${saques.enviaveis.pedidos})` }}
              </button>
            </li>
            <li v-if="saques.manuais.pedidos" class="rounded-xl bg-sun-50 px-4 py-3" data-parte="saques-manuais">
              <p class="font-semibold text-ink-900">Conta bancária — transferência manual</p>
              <p class="text-sm text-ink-700">
                {{ n(saques.manuais.pedidos) }} {{ saques.manuais.pedidos === 1 ? 'saque' : 'saques' }} ·
                <strong class="tabular-nums text-ink-900">{{ brl(saques.manuais.valorCents) }}</strong>
                — não sai pelo botão: é transferido à mão no painel do Asaas.
              </p>
            </li>
            <li v-if="saques.emVoo.pedidos" class="rounded-xl bg-ink-50 px-4 py-3" data-parte="saques-em-voo">
              <p class="font-semibold text-ink-900">Processando no banco</p>
              <p class="text-sm text-ink-700">
                {{ n(saques.emVoo.pedidos) }} · <strong class="tabular-nums text-ink-900">{{ brl(saques.emVoo.valorCents) }}</strong>
                — já saiu da plataforma; o envio confere a situação de novo.
              </p>
            </li>
          </ul>
        </section>
      </div>

      <!-- =============================================== avisos do gateway -->
      <section v-if="entregas?.total" class="card mt-4 ring-1 ring-sun-300" aria-labelledby="titulo-entregas" data-parte="entregas">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 id="titulo-entregas" class="titulo text-lg font-semibold text-ink-900">
              {{ n(entregas.total) }} {{ entregas.total === 1 ? 'aviso de pagamento chegou e não foi aplicado' : 'avisos de pagamento chegaram e não foram aplicados' }}
            </h2>
            <p class="text-sm text-ink-700">O gateway já mexeu nesse dinheiro e o sistema ainda não registrou. A varredura tenta de novo sozinha; aqui dá pra forçar.</p>
          </div>
          <button type="button" class="btn-secundario min-h-[40px]" :disabled="!!reprocessando" @click="reprocessar()">
            {{ reprocessando === 'todas' ? 'Tentando…' : 'Tentar todos agora' }}
          </button>
        </div>
        <p v-if="recadoEntregas" class="mt-3" :class="recadoEntregas.tipo === 'erro' ? 'faixa-erro' : 'faixa-aviso'" role="status">{{ recadoEntregas.texto }}</p>
        <div class="relative mt-3 overflow-x-auto">
          <table class="w-full text-sm">
            <tbody>
              <tr v-for="e in entregas.entregas" :key="e.id" class="border-b border-ink-100 last:border-0">
                <td class="py-2.5">
                  <p class="font-medium text-ink-900">{{ e.evento }} <span v-if="e.pedido" class="font-mono text-xs text-ink-600">· {{ e.pedido }}</span></p>
                  <p class="text-xs text-ink-600">{{ dataHora(e.chegouEm) }} · {{ n(e.tentativas) }} {{ e.tentativas === 1 ? 'tentativa' : 'tentativas' }}<template v-if="e.erro"> · {{ e.erro }}</template></p>
                </td>
                <td class="px-3 py-2.5 text-right tabular-nums text-ink-900">{{ e.valorCents ? brl(e.valorCents) : '—' }}</td>
                <td class="py-2.5 text-right">
                  <button type="button" class="btn-secundario min-h-[40px]" :disabled="!!reprocessando || e.esgotada" @click="reprocessar(e.id)">
                    {{ reprocessando === e.id ? 'Tentando…' : e.esgotada ? 'Precisa de gente' : 'Tentar agora' }}
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- ================================================== transferências -->
      <section class="card mt-4 p-0" aria-labelledby="titulo-transferencias">
        <div class="flex flex-wrap items-baseline justify-between gap-2 border-b border-ink-200 px-4 py-3 sm:px-5">
          <h2 id="titulo-transferencias" class="titulo text-lg font-semibold text-ink-900">Transferências</h2>
          <p v-if="faixaDaPagina" class="text-sm text-ink-700" data-parte="faixa-da-pagina">{{ faixaDaPagina }}</p>
        </div>
        <p v-if="!data.transferencias.length" class="px-4 py-8 text-center text-sm text-ink-700">
          Nenhuma transferência pedida {{ resolvido.de || resolvido.ate ? 'nesse período' : 'ainda' }}.
        </p>
        <template v-else>
          <!-- celular: uma linha por transferência, valor ao lado do nome (a tabela cortava o valor) -->
          <ul class="sm:hidden">
            <li v-for="x in data.transferencias" :key="`c-${x.id}`" class="border-b border-ink-100 px-4 py-3 last:border-0" data-parte="cartao-transferencia">
              <div class="flex items-start justify-between gap-3">
                <p class="min-w-0 font-medium text-ink-900">{{ x.beneficiario }}</p>
                <p class="shrink-0 whitespace-nowrap font-semibold tabular-nums text-ink-900">{{ brl(x.valorCents) }}</p>
              </div>
              <div class="mt-1 flex items-center justify-between gap-3">
                <p class="min-w-0 text-xs text-ink-600">
                  <span class="font-mono">{{ x.codigo }}</span> · {{ DESTINO[x.destinoTipo] ?? x.destinoTipo }} ·
                  {{ x.evento ?? '—' }} · {{ dataCurta(x.solicitadaEm) }}
                </p>
                <span class="shrink-0" :class="SITUACAO_DA_TRANSFERENCIA[x.status]?.classe ?? 'selo-neutro'">
                  {{ SITUACAO_DA_TRANSFERENCIA[x.status]?.texto ?? x.status }}
                </span>
              </div>
            </li>
          </ul>
          <div class="relative hidden overflow-x-auto sm:block">
            <table class="w-full text-sm">
              <thead>
                <tr class="border-b border-ink-200 text-left text-xs font-semibold uppercase tracking-wide text-ink-600">
                  <th class="px-5 py-2 font-semibold">Beneficiário</th>
                  <th class="px-3 py-2 font-semibold">Evento e pedido</th>
                  <th class="px-3 py-2 text-right font-semibold">Valor</th>
                  <th class="px-5 py-2 text-right font-semibold">Situação</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="x in data.transferencias" :key="x.id" class="border-b border-ink-100 last:border-0" data-parte="linha-transferencia">
                  <td class="px-5 py-2.5">
                    <p class="font-medium text-ink-900">{{ x.beneficiario }}</p>
                    <p class="text-xs text-ink-600"><span class="font-mono">{{ x.codigo }}</span> · {{ DESTINO[x.destinoTipo] ?? x.destinoTipo }}</p>
                  </td>
                  <td class="px-3 py-2.5 text-xs text-ink-700">
                    {{ x.evento ?? '—' }}
                    <span class="block text-ink-600">{{ dataCurta(x.solicitadaEm) }}<template v-if="x.pedidoPor"> · {{ x.pedidoPor }}</template></span>
                  </td>
                  <td class="whitespace-nowrap px-3 py-2.5 text-right font-semibold tabular-nums text-ink-900">{{ brl(x.valorCents) }}</td>
                  <td class="px-5 py-2.5 text-right">
                    <span :class="SITUACAO_DA_TRANSFERENCIA[x.status]?.classe ?? 'selo-neutro'" data-parte="situacao-transferencia">
                      {{ SITUACAO_DA_TRANSFERENCIA[x.status]?.texto ?? x.status }}
                    </span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>
        <div v-if="ultimaPagina > 1" class="flex items-center justify-between gap-3 border-t border-ink-200 px-4 py-3 sm:px-5" data-parte="paginas">
          <button type="button" class="btn-secundario min-h-[40px]" :disabled="paginaAtual <= 1" @click="irParaPagina(paginaAtual - 1)">Anterior</button>
          <span class="text-sm text-ink-700">página {{ paginaAtual }} de {{ ultimaPagina }}</span>
          <button type="button" class="btn-secundario min-h-[40px]" :disabled="paginaAtual >= ultimaPagina" @click="irParaPagina(paginaAtual + 1)">Próxima</button>
        </div>
      </section>

      <!-- ======================================================= por evento -->
      <PainelVazio v-if="!comMovimento.length" class="mt-4" icone="financeiro" titulo="Nenhum evento com movimento financeiro ainda."
                   texto="O dinheiro aparece aqui depois da primeira venda paga. Publique um evento e acompanhe as vendas na Visão geral.">
        <NuxtLink to="/admin" class="btn-primario min-h-[40px]">Ver os eventos</NuxtLink>
      </PainelVazio>

      <section v-else class="card mt-4 p-0" aria-labelledby="titulo-por-evento">
        <h2 id="titulo-por-evento" class="titulo border-b border-ink-200 px-4 py-3 text-lg font-semibold text-ink-900 sm:px-5">Por evento</h2>
        <!-- celular: um bloco por evento com os quatro números (a tabela cortava o disponível) -->
        <ul class="sm:hidden">
          <li v-for="e in comMovimento" :key="`c-${e.id}`" class="border-b border-ink-100 px-4 py-3 last:border-0" data-parte="cartao-evento">
            <NuxtLink :to="`/admin/evento/${e.id}/financeiro`" class="font-semibold text-ink-900 hover:text-pool-700 hover:underline">{{ e.nome }}</NuxtLink>
            <p class="text-xs text-ink-600">
              {{ n(e.pedidos) }} {{ e.pedidos === 1 ? 'pedido' : 'pedidos' }} ·
              <template v-if="e.liberado">liberado</template>
              <template v-else>libera em {{ dataCurta(e.liberaEm) }}</template>
            </p>
            <dl class="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <div><dt class="text-xs text-ink-600">Líquido</dt><dd class="font-semibold tabular-nums text-grape-800">{{ brl(e.liquidoCents) }}</dd></div>
              <div><dt class="text-xs text-ink-600">Disponível</dt><dd class="tabular-nums" :class="e.disponivelCents ? 'font-semibold text-success-700' : 'text-ink-700'">{{ brl(e.disponivelCents) }}</dd></div>
              <div>
                <dt class="text-xs text-ink-600">Transferido</dt>
                <dd class="tabular-nums text-ink-800">{{ brl(e.transferidoCents) }}<span v-if="e.emCursoCents" class="block text-xs text-sun-700">+{{ brl(e.emCursoCents) }} em curso</span></dd>
              </div>
              <div><dt class="text-xs text-ink-600">Retido</dt><dd class="tabular-nums" :class="e.retidoCents ? 'text-sun-700' : 'text-ink-700'">{{ brl(e.retidoCents) }}</dd></div>
            </dl>
            <p v-if="e.recebidoDiretoCents" class="mt-1 text-xs text-ink-600">{{ brl(e.recebidoDiretoCents) }} recebidos direto, com você</p>
            <p v-if="e.saldoDevedorCents" class="mt-1 text-xs font-semibold text-danger-700">deve −{{ brl(e.saldoDevedorCents) }}</p>
          </li>
        </ul>
        <div class="relative hidden overflow-x-auto sm:block">
          <table class="w-full border-collapse text-sm">
            <thead>
              <tr class="border-b border-ink-200 text-left text-xs font-semibold uppercase tracking-wide text-ink-600">
                <th class="px-5 py-2 font-semibold">Evento</th>
                <th class="px-3 py-2 text-right font-semibold">Líquido</th>
                <th class="px-3 py-2 text-right font-semibold">Transferido</th>
                <th class="px-3 py-2 text-right font-semibold">Retido</th>
                <th class="px-3 py-2 text-right font-semibold">Disponível</th>
                <th class="px-5 py-2"><span class="sr-only">Abrir</span></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="e in comMovimento" :key="e.id" class="border-b border-ink-100 last:border-0" data-parte="linha-evento">
                <td class="px-5 py-3">
                  <p class="font-medium text-ink-900">{{ e.nome }}</p>
                  <p class="text-xs text-ink-600">
                    {{ n(e.pedidos) }} {{ e.pedidos === 1 ? 'pedido' : 'pedidos' }} ·
                    <template v-if="e.liberado">liberado</template>
                    <template v-else>libera em {{ dataCurta(e.liberaEm) }}</template>
                  </p>
                  <p v-if="e.saldoDevedorCents" class="text-xs font-semibold text-danger-700" data-parte="deve">deve −{{ brl(e.saldoDevedorCents) }}</p>
                </td>
                <td class="px-3 py-3 text-right font-semibold tabular-nums text-grape-800">
                  {{ brl(e.liquidoCents) }}
                  <span v-if="e.recebidoDiretoCents" class="block text-xs font-normal text-ink-600">{{ brl(e.recebidoDiretoCents) }} direto com você</span>
                </td>
                <td class="px-3 py-3 text-right tabular-nums text-ink-800">
                  {{ brl(e.transferidoCents) }}
                  <span v-if="e.emCursoCents" class="block text-xs text-sun-700">+{{ brl(e.emCursoCents) }} em curso</span>
                </td>
                <td class="px-3 py-3 text-right tabular-nums" :class="e.retidoCents ? 'text-sun-700' : 'text-ink-500'">{{ brl(e.retidoCents) }}</td>
                <td class="px-3 py-3 text-right tabular-nums" :class="e.disponivelCents ? 'font-semibold text-success-700' : 'text-ink-500'">{{ brl(e.disponivelCents) }}</td>
                <td class="px-5 py-3 text-right">
                  <NuxtLink :to="`/admin/evento/${e.id}/financeiro`" class="inline-flex min-h-[40px] items-center font-semibold text-pool-700 hover:underline" data-acao="abrir-evento">Abrir</NuxtLink>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </template>
  </div>
</template>
