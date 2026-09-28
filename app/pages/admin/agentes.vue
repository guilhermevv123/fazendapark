<script setup lang="ts">
/**
 * Atendimento IA — o que a Sofia está fazendo no WhatsApp e no Instagram.
 *
 * Pedido do dono (27/09): "um painel dentro do sistema pra ver tudo que os agentes estão
 * fazendo: qual agente está conversando, a última conversa, um resumo rapidinho".
 *
 * De onde vem: a automação (n8n) grava cada turno da conversa em `fp_conversas` com a INTENÇÃO
 * que o classificador deu, e cada intenção é atendida por um agente diferente — é isso que vira
 * "quem está atendendo" (vocabulário em `server/utils/agentes-rotulos.ts`). A tela fala só com
 * `/api/admin/agentes/*` (área `agentes`, só master); o servidor é quem guarda o token da
 * automação. O resumo é escrito pela IA sob demanda e fica guardado até a conversa andar.
 *
 * Tudo que é recorte mora na URL (canal, situação, busca, aba e a conversa aberta): F5 volta
 * exatamente onde estava, e o link do que se está vendo pode ser mandado pra alguém.
 */
import {
  canalDoContato, contatoLegivel, rotuloDaIntencao, ROTULO_DO_CANAL, SENTIMENTO, SITUACAO_DO_RESUMO,
} from '~~/server/utils/agentes-rotulos'
import { useConsultaNaUrl } from '~/composables/consultaNaUrl'

definePageMeta({ layout: 'admin' })
useHead({ title: 'Atendimento IA' })

// os refs são a fonte; a URL vai atrás. Canal + busca em sequência rápida perdia a busca da URL
// (o `navigateTo` da segunda troca era engolido pelo middleware da primeira) — ver consultaNaUrl.ts
const consulta = useConsultaNaUrl()
const naAbertura = consulta.atual.value
const aba = ref(String(naAbertura.aba ?? 'conversas') === 'casos' ? 'casos' : 'conversas')
const canal = ref(String(naAbertura.canal ?? ''))
const recorte = ref(String(naAbertura.recorte ?? ''))
const busca = ref(String(naAbertura.q ?? ''))
const tipoCaso = ref(String(naAbertura.tipo ?? ''))
const aberto = ref(String(naAbertura.contato ?? ''))

watch([aba, canal, recorte, busca, tipoCaso, aberto], () => {
  consulta.escrever({
    aba: aba.value !== 'conversas' ? aba.value : null,
    canal: canal.value,
    recorte: recorte.value,
    q: busca.value.trim(),
    tipo: tipoCaso.value,
    contato: aberto.value,
  })
})
// e o caminho contrário: a URL mudou por fora (clique em "Atendimento IA" no menu, link colado) →
// os filtros acompanham. A busca compara aparada: o espaço que a pessoa acabou de digitar fica.
watch(consulta.atual, (q) => {
  const texto = (v: unknown) => (typeof v === 'string' ? v : '')
  const abaDaUrl = texto(q.aba) === 'casos' ? 'casos' : 'conversas'
  if (aba.value !== abaDaUrl) aba.value = abaDaUrl
  if (canal.value !== texto(q.canal)) canal.value = texto(q.canal)
  if (recorte.value !== texto(q.recorte)) recorte.value = texto(q.recorte)
  if (busca.value.trim() !== texto(q.q)) busca.value = texto(q.q)
  if (tipoCaso.value !== texto(q.tipo)) tipoCaso.value = texto(q.tipo)
  if (aberto.value !== texto(q.contato)) aberto.value = texto(q.contato)
})

const { data, pending, error: falha, refresh } = await useFetch<any>('/api/admin/agentes')

// ------------------------------------------------------------ atualização sozinha
/** 30 s com a aba à vista; escondida, não gasta a automação à toa. */
const atualizadoEm = ref(Date.now())
watch(data, () => { atualizadoEm.value = Date.now() })
const agora = ref(Date.now())
/** "há 5 min" muda entre o servidor e o navegador: antes de montar, só hora absoluta (igual nos dois) */
const montado = ref(false)
let relogio: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  montado.value = true
  agora.value = Date.now()
  relogio = setInterval(() => {
    agora.value = Date.now()
    if (document.visibilityState === 'visible' && !pending.value && agora.value - atualizadoEm.value > 30_000) refresh()
  }, 5_000)
})
onBeforeUnmount(() => clearInterval(relogio))

const visao = computed(() => data.value?.visao ?? null)
const saude = computed(() => data.value?.saude ?? null)
const k = computed(() => visao.value?.kpis ?? {})

// ------------------------------------------------------------------- formatos
const num = (n: unknown) => Number(n ?? 0).toLocaleString('pt-BR')
const fuso = 'America/Bahia'
const hora = (iso: string) =>
  new Intl.DateTimeFormat('pt-BR', { timeZone: fuso, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(iso))
function quando(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (!montado.value) return hora(iso)
  const min = Math.floor((agora.value - d.getTime()) / 60_000)
  if (min < 1) return 'agora'
  if (min < 60) return `há ${min} min`
  const hoje = new Intl.DateTimeFormat('pt-BR', { timeZone: fuso, dateStyle: 'short' })
  const hhmm = new Intl.DateTimeFormat('pt-BR', { timeZone: fuso, hour: '2-digit', minute: '2-digit' }).format(d)
  if (hoje.format(d) === hoje.format(new Date(agora.value))) return `hoje ${hhmm}`
  if (hoje.format(d) === hoje.format(new Date(agora.value - 86_400_000))) return `ontem ${hhmm}`
  return `${new Intl.DateTimeFormat('pt-BR', { timeZone: fuso, day: '2-digit', month: '2-digit' }).format(d)} ${hhmm}`
}
const seloDoTom: Record<string, string> = { ok: 'selo-ok', neutro: 'selo-neutro', alerta: 'selo-alerta', erro: 'selo-erro' }
/**
 * Iniciais do avatar pela primeira LETRA de cada nome. `p[0]` pegava meia letra quando o nome do
 * WhatsApp começa com emoji ("🌸Maria"): a metade de um par surrogate sai "�" e o servidor e o
 * navegador desenham diferente (erro de hidratação medido em 27/09).
 */
const iniciais = (nome: string | null | undefined, contato: string) =>
  (nome || '').trim().split(/\s+/).map((p) => p.match(/[\p{L}\p{N}]/u)?.[0] ?? '').filter(Boolean)
    .slice(0, 2).join('').toUpperCase() || contato.slice(-2)
const segundosDesde = computed(() => Math.max(0, Math.round((agora.value - atualizadoEm.value) / 1000)))

/** variação contra ontem, em palavras — número solto não diz se é bom ou ruim */
const deltaHoje = computed(() => {
  const h = Number(k.value.contatos_hoje ?? 0), o = Number(k.value.contatos_ontem ?? 0)
  if (!o) return h ? 'primeiro movimento desde ontem' : 'sem conversa ontem nem hoje'
  const p = Math.round(((h - o) / o) * 100)
  return p === 0 ? 'igual a ontem' : `${p > 0 ? '+' : ''}${p}% contra ontem (${num(o)})`
})

// ------------------------------------------------------------------- saúde
const fluxos = computed(() => (saude.value?.fluxos ?? []).filter((f: any) => !/API do painel/i.test(f.nome)))
const vitrine = computed(() => saude.value?.vitrine ?? null)
const pulso = computed(() => saude.value?.pulso ?? {})
/** Fluxo que atende cliente parado é a primeira coisa que o dono precisa ver. */
const fluxosDeAtendimento = ['Atendimento WhatsApp', 'Atendimento Instagram', 'Comentários Instagram', 'Follow-up de silêncio']
const alertasDeSaude = computed(() => {
  const a: string[] = []
  for (const f of fluxos.value) {
    if (!f.ativo && fluxosDeAtendimento.includes(f.nome)) a.push(`${f.nome} está DESLIGADO — ninguém responde nesse canal.`)
    if (f.erros_24h > 0) a.push(`${f.nome}: ${f.erros_24h} erro(s) nas últimas 24h.`)
  }
  const vig = fluxos.value.find((f: any) => /vigia/i.test(f.nome))
  if (vig && !vig.ativo) a.push('Vigia da conexão desligado: se o WhatsApp desconectar, ninguém é avisado.')
  return a
})

// ------------------------------------------------------------------ gráficos
const G = { w: 640, h: 200, e: 34, d: 8, t: 12, b: 26 }
const porDia = computed(() => {
  const dias: any[] = visao.value?.por_dia ?? []
  if (!dias.length) return null
  // a pilha WhatsApp+Instagram de um dia pode passar de `contatos` (mesma pessoa nos dois canais)
  const max = Math.max(1, ...dias.map((d) => Math.max(Number(d.contatos), Number(d.whatsapp ?? 0) + Number(d.instagram ?? 0))))
  const util = G.h - G.t - G.b
  const passo = (G.w - G.e - G.d) / dias.length
  const esc = (v: number) => (util * v) / max
  return {
    barras: dias.map((d, i) => {
      const wa = Number(d.whatsapp ?? 0), ig = Number(d.instagram ?? 0)
      const x = G.e + i * passo + passo * 0.18, w = passo * 0.64
      const hWa = esc(wa), hIg = esc(ig)
      const [, m, dd] = String(d.dia).slice(0, 10).split('-')
      return { x, w, yWa: G.h - G.b - hWa, hWa, yIg: G.h - G.b - hWa - hIg, hIg, rot: `${dd}/${m}`, d, total: Number(d.contatos) }
    }),
    grade: [0, 0.5, 1].map((f) => ({ y: G.h - G.b - util * f, rotulo: num(Math.round(max * f)) })),
  }
})
const horas = computed(() => {
  const h: any[] = visao.value?.horas_7d ?? []
  const mapa = new Map(h.map((x) => [Number(x.hora), Number(x.turnos)]))
  const lista = Array.from({ length: 24 }, (_, i) => ({ hora: i, turnos: mapa.get(i) ?? 0 }))
  const max = Math.max(1, ...lista.map((x) => x.turnos))
  const pico = lista.reduce((a, b) => (b.turnos > a.turnos ? b : a), lista[0])
  return { lista: lista.map((x) => ({ ...x, pct: (x.turnos / max) * 100 })), pico }
})
const assuntos = computed(() => {
  const l: any[] = visao.value?.intencoes_7d ?? []
  const total = l.reduce((s, x) => s + Number(x.turnos), 0) || 1
  return l.map((x) => ({ ...x, r: rotuloDaIntencao(x.intencao), pct: Math.round((Number(x.turnos) / total) * 100) }))
})

// ----------------------------------------------------------------- conversas
const conversas = computed<any[]>(() => (visao.value?.conversas ?? []).map((c: any) => ({
  ...c, r: rotuloDaIntencao(c.intencao), canalDe: c.canal || canalDoContato(c.contato),
})))
const filtradas = computed(() => {
  const q = busca.value.trim().toLowerCase()
  return conversas.value.filter((c) => {
    if (canal.value && c.canalDe !== canal.value) return false
    if (recorte.value === 'humano' && !c.humano_no_comando) return false
    if (recorte.value === 'caso' && !c.caso_aberto) return false
    if (recorte.value === 'compra' && !c.quis_comprar) return false
    if (recorte.value === 'barrada' && !c.bloqueios) return false
    if (q && !`${c.nome ?? ''} ${c.contato} ${c.ultima_mensagem ?? ''} ${c.ultima_resposta ?? ''}`.toLowerCase().includes(q)) return false
    return true
  })
})
/** 150 conversas numa tela só dava 15 mil pixels de rolagem: 25 por vez, "mostrar mais" soma 25 */
const POR_VEZ = 25
const quantasConversas = ref(POR_VEZ)
const quantosCasos = ref(POR_VEZ)
watch([canal, recorte, busca], () => { quantasConversas.value = POR_VEZ })
watch(tipoCaso, () => { quantosCasos.value = POR_VEZ })
const visiveis = computed(() => filtradas.value.slice(0, quantasConversas.value))

const RECORTES = [
  ['', 'Todas'], ['caso', 'Com reclamação aberta'], ['compra', 'Querem comprar'],
  ['humano', 'Humano no comando'], ['barrada', 'Resposta barrada'],
] as const
const contagem = (r: string) => conversas.value.filter((c) =>
  r === '' ? true : r === 'caso' ? c.caso_aberto : r === 'compra' ? c.quis_comprar : r === 'humano' ? c.humano_no_comando : c.bloqueios > 0).length

// ---------------------------------------------------------------------- casos
const TIPOS: Record<string, { texto: string; selo: string }> = {
  urgencia: { texto: 'Urgência', selo: 'selo-erro' },
  reclamacao: { texto: 'Reclamação', selo: 'selo-erro' },
  elogio: { texto: 'Elogio', selo: 'selo-ok' },
  sugestao: { texto: 'Sugestão', selo: 'selo-neutro' },
  nao_sabia: { texto: 'A Sofia não soube', selo: 'selo-alerta' },
}
const STATUS_CASO: Record<string, string> = { novo: 'Novo', avisado: 'Equipe avisada', resolvido: 'Resolvido' }
const casos = computed<any[]>(() => (visao.value?.casos ?? []).filter((c: any) => !tipoCaso.value || c.tipo === tipoCaso.value))
const contaTipo = (t: string) => (visao.value?.casos ?? []).filter((c: any) => !t || c.tipo === t).length

// ------------------------------------------------------------- a conversa aberta
const detalhe = ref<any>(null)
const carregandoDetalhe = ref(false)
const erroDetalhe = ref('')
async function abrir(contato: string) {
  aberto.value = contato
}
async function carregarDetalhe() {
  if (!aberto.value) { detalhe.value = null; return }
  carregandoDetalhe.value = true; erroDetalhe.value = ''
  try {
    detalhe.value = await $fetch('/api/admin/agentes/conversa', { query: { contato: aberto.value } })
  } catch (e: any) {
    detalhe.value = null
    erroDetalhe.value = e?.data?.statusMessage || e?.statusMessage || 'Não consegui abrir a conversa agora.'
  } finally { carregandoDetalhe.value = false }
}
// só no navegador: no servidor o `$fetch` sai sem o cookie da sessão (o `useFetch` repassa, o
// `$fetch` cru não) e a gaveta nasceria com "não consegui abrir" pra sumir na hidratação
onMounted(carregarDetalhe)
watch(aberto, carregarDetalhe)
const daLista = computed(() => conversas.value.find((c) => c.contato === aberto.value) ?? null)
const nomeAberto = computed(() => daLista.value?.nome || detalhe.value?.turnos?.findLast?.((t: any) => t.nome)?.nome || '')
const canalAberto = computed(() => canalDoContato(aberto.value))

const resumindo = ref(false)
const erroResumo = ref('')
async function resumir(forcar = false) {
  if (resumindo.value || !aberto.value) return
  resumindo.value = true; erroResumo.value = ''
  try {
    const r: any = await $fetch('/api/admin/agentes/resumo', { method: 'POST', body: { contato: aberto.value, forcar } })
    if (r?.erro) { erroResumo.value = r.erro; return }
    detalhe.value = { ...(detalhe.value ?? {}), resumo: { resumo: r.resumo, ate_id: r.ate_id, criado_em: r.criado_em ?? new Date().toISOString(), em_dia: true } }
    const c = conversas.value.find((x) => x.contato === aberto.value)
    if (c) { c.resumo = r.resumo; c.resumo_em_dia = true }
  } catch (e: any) {
    erroResumo.value = e?.data?.statusMessage || e?.statusMessage || 'A IA não respondeu agora — tente de novo.'
  } finally { resumindo.value = false }
}
const resumoAberto = computed(() => detalhe.value?.resumo?.resumo ?? null)
const linkWhats = computed(() => canalAberto.value === 'whatsapp' ? `https://wa.me/${aberto.value}` : '')
</script>

<template>
  <div>
    <header class="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 class="titulo text-2xl font-semibold text-tinta">Atendimento IA</h1>
        <p class="apoio-bloco">O que a Sofia está conversando no WhatsApp e no Instagram — ao vivo, sem abrir o celular.</p>
      </div>
      <div class="flex items-center gap-3">
        <p class="text-xs text-tinta-fraca" aria-live="polite">
          {{ pending ? 'atualizando…' : montado ? `atualizado há ${segundosDesde}s` : '' }}
        </p>
        <button type="button" class="btn-secundario" :disabled="pending" @click="refresh()">Atualizar</button>
      </div>
    </header>

    <!-- ============================================================ falhas -->
    <div v-if="falha" class="mt-5" :class="falha.statusCode === 503 ? 'faixa-aviso' : 'faixa-erro'" role="alert">
      <p class="font-semibold">{{ falha.statusCode === 503 ? 'Painel ainda não ligado neste servidor' : 'Não consegui ler o atendimento agora' }}</p>
      <p class="mt-1">{{ falha.data?.statusMessage || falha.statusMessage || 'Tente de novo em 1 minuto.' }}</p>
      <button v-if="falha.statusCode !== 503" type="button" class="btn-secundario mt-3" @click="refresh()">Tentar de novo</button>
    </div>

    <div v-else-if="!visao && pending" class="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-busy="true">
      <div v-for="i in 6" :key="i" class="card h-[118px] animate-pulse bg-fundo-cinza" />
    </div>

    <template v-else-if="visao">
      <!-- ========================================================= saúde -->
      <section class="mt-5 card" aria-labelledby="t-saude">
        <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
          <h2 id="t-saude" class="rotulo-kpi">Fluxos da automação</h2>
          <p v-if="data?.avisoSaude" class="text-xs text-alerta">{{ data.avisoSaude }}</p>
          <ul v-else class="flex flex-wrap gap-2">
            <li v-for="f in fluxos" :key="f.id">
              <span :class="f.ativo ? (f.erros_24h ? 'selo-alerta' : 'selo-ok') : (fluxosDeAtendimento.includes(f.nome) ? 'selo-erro' : 'selo-neutro')"
                    :title="f.erros_24h ? `${f.erros_24h} erro(s) nas últimas 24h` : (f.ativo ? 'ligado' : 'desligado')">
                <span class="size-1.5 rounded-full" :class="f.ativo ? 'bg-success-600' : 'bg-ink-400'" aria-hidden="true" />
                {{ f.nome }}{{ f.ativo ? '' : ' · desligado' }}{{ f.erros_24h ? ` · ${f.erros_24h} erro(s)` : '' }}
              </span>
            </li>
          </ul>
        </div>

        <div class="mt-4 grid gap-4 lg:grid-cols-[1.4fr_1fr]">
          <div class="rounded-xl bg-fundo-cinza p-4">
            <p class="text-xs font-semibold uppercase tracking-wide text-tinta-fraca">Vitrine do site (Zig) · o que a Sofia oferece</p>
            <template v-if="vitrine">
              <p v-if="vitrine.sem_evento" class="mt-1.5 text-sm text-tinta-corpo">
                <span class="selo-alerta">Nada à venda agora</span>
                <span class="ml-2">A venda online do próximo fim de semana ainda não abriu. A Sofia manda o link da página do parque, sem citar preço.</span>
              </p>
              <p v-else-if="!vitrine.ok" class="mt-1.5 text-sm text-tinta-corpo">
                <span class="selo-erro">Zig não respondeu</span>
                <span class="ml-2">A Sofia está usando a última leitura boa (ou o link da página do parque).</span>
              </p>
              <div v-else class="mt-1.5 text-sm text-tinta-corpo">
                <p class="font-semibold text-tinta">{{ vitrine.evento }} <span class="font-normal text-tinta-suave">· {{ vitrine.dias }}</span></p>
                <p v-if="vitrine.frase_preco" class="mt-0.5">Entrada: {{ vitrine.frase_preco }}</p>
                <p v-if="vitrine.frase_combo" class="mt-0.5">{{ vitrine.frase_combo }}</p>
              </div>
              <p class="mt-2 text-xs text-tinta-fraca">
                lido {{ quando(vitrine.lido_em) }}
                <template v-if="vitrine.link"> · <a :href="vitrine.link" target="_blank" rel="noopener" class="text-acao underline underline-offset-2">abrir o link que a Sofia manda</a></template>
              </p>
            </template>
            <p v-else class="mt-1.5 text-sm text-tinta-suave">Sem leitura da vitrine agora.</p>
          </div>
          <div class="rounded-xl bg-fundo-cinza p-4 text-sm text-tinta-corpo">
            <p class="text-xs font-semibold uppercase tracking-wide text-tinta-fraca">Pulso</p>
            <ul class="mt-1.5 space-y-1">
              <li>Última mensagem no WhatsApp: <b>{{ quando(pulso.whatsapp) }}</b></li>
              <li>Última mensagem no Instagram: <b>{{ quando(pulso.instagram) }}</b></li>
              <li>Retomadas automáticas (24h): <b>{{ num(pulso.follow_up_24h) }}</b></li>
              <li>Reclamações sem aviso à equipe (48h): <b>{{ num(pulso.casos_sem_aviso) }}</b></li>
            </ul>
          </div>
        </div>

        <ul v-if="alertasDeSaude.length" class="mt-4 space-y-2">
          <li v-for="a in alertasDeSaude" :key="a" class="faixa-erro">{{ a }}</li>
        </ul>
      </section>

      <!-- ========================================================== KPIs -->
      <div class="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <article class="card flex items-start justify-between">
          <div>
            <p class="rotulo-kpi">Pessoas atendidas hoje</p>
            <p class="numero-kpi mt-2">{{ num(k.contatos_hoje) }}</p>
            <p class="mt-1 text-sm text-tinta-suave">{{ num(k.turnos_hoje) }} respostas · {{ deltaHoje }}</p>
          </div>
          <span class="grid size-12 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-pool-500 to-pool-700 text-white shadow-sm"><IconeMenu nome="chat" /></span>
        </article>
        <article class="card flex items-start justify-between">
          <div>
            <p class="rotulo-kpi">Últimos 7 dias</p>
            <p class="numero-kpi mt-2">{{ num(k.contatos_7d) }}</p>
            <p class="mt-1 text-sm text-tinta-suave">WhatsApp {{ num(k.whatsapp_7d) }} · Instagram {{ num(k.instagram_7d) }} · {{ num(k.turnos_7d) }} respostas</p>
          </div>
          <span class="grid size-12 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-grape-500 to-grape-700 text-white shadow-sm"><IconeMenu nome="pessoas" /></span>
        </article>
        <article class="card flex items-start justify-between">
          <div>
            <p class="rotulo-kpi">Querem comprar (7 dias)</p>
            <p class="numero-kpi mt-2">{{ num(k.quer_comprar_7d) }}</p>
            <p class="mt-1 text-sm text-tinta-suave">pediram preço, link ou combo pra fechar</p>
          </div>
          <span class="grid size-12 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-sun-300 to-sun-500 text-ink-950 shadow-sm"><IconeMenu nome="ingresso" /></span>
        </article>
        <article class="card flex items-start justify-between">
          <div>
            <p class="rotulo-kpi">Reclamações (7 dias)</p>
            <p class="numero-kpi mt-2" :class="k.reclamacao_7d ? 'text-erro' : ''">{{ num(k.reclamacao_7d) }}</p>
            <p class="mt-1 text-sm text-tinta-suave">
              pessoas · a Sofia escuta e registra o caso
              <template v-if="k.urgencia_7d"> · <b class="font-semibold text-erro">{{ num(k.urgencia_7d) }} urgência(s)</b> com a equipe avisada</template>
            </p>
          </div>
          <span class="grid size-12 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-danger-600 to-danger-800 text-white shadow-sm"><IconeMenu nome="suporte" /></span>
        </article>
        <article class="card flex items-start justify-between">
          <div>
            <p class="rotulo-kpi">Respostas barradas (7 dias)</p>
            <p class="numero-kpi mt-2">{{ num(k.bloqueios_7d) }}</p>
            <p class="mt-1 text-sm text-tinta-suave">o guarda-corpo trocou por uma resposta segura</p>
          </div>
          <span class="grid size-12 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-citrus-400 to-citrus-600 text-white shadow-sm"><IconeMenu nome="check" /></span>
        </article>
        <article class="card flex items-start justify-between">
          <div>
            <p class="rotulo-kpi">Humano no comando agora</p>
            <p class="numero-kpi mt-2">{{ num(k.humano_no_comando) }}</p>
            <p class="mt-1 text-sm text-tinta-suave">conversas em que alguém da equipe respondeu e a Sofia pausou</p>
          </div>
          <span class="grid size-12 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-ink-500 to-ink-700 text-white shadow-sm"><IconeMenu nome="cracha" /></span>
        </article>
      </div>

      <!-- ====================================================== gráficos -->
      <div class="mt-4 grid gap-4 xl:grid-cols-[1.6fr_1fr]">
        <section class="card" aria-labelledby="t-dias">
          <header class="flex flex-wrap items-baseline justify-between gap-2">
            <h2 id="t-dias" class="rotulo-kpi">Pessoas atendidas por dia</h2>
            <p class="flex items-center gap-3 text-xs text-tinta-fraca">
              <span class="inline-flex items-center gap-1.5"><span class="size-2.5 rounded-sm bg-pool-600" aria-hidden="true" />WhatsApp</span>
              <span class="inline-flex items-center gap-1.5"><span class="size-2.5 rounded-sm bg-grape-500" aria-hidden="true" />Instagram</span>
              <span>últimos 14 dias</span>
            </p>
          </header>
          <div v-if="porDia" class="mt-3 overflow-x-auto">
            <svg :viewBox="`0 0 ${G.w} ${G.h}`" class="h-[220px] w-full min-w-[520px]" role="img"
                 aria-label="Pessoas atendidas por dia nos últimos 14 dias, WhatsApp e Instagram">
              <g v-for="(g, i) in porDia.grade" :key="i">
                <line :x1="G.e" :x2="G.w - G.d" :y1="g.y" :y2="g.y" stroke="#e2e0ea" stroke-dasharray="3 4" />
                <text :x="G.e - 6" :y="g.y + 4" text-anchor="end" font-size="10" fill="#716c87">{{ g.rotulo }}</text>
              </g>
              <g v-for="(b, i) in porDia.barras" :key="`b${i}`">
                <title>{{ b.rot }}: {{ b.total }} pessoas ({{ b.d.whatsapp }} WhatsApp, {{ b.d.instagram }} Instagram) · {{ b.d.turnos }} respostas</title>
                <rect :x="b.x" :y="b.yWa" :width="b.w" :height="Math.max(b.hWa, 0)" rx="2" fill="#1789a1" />
                <rect :x="b.x" :y="b.yIg" :width="b.w" :height="Math.max(b.hIg, 0)" rx="2" fill="#7a56ab" />
                <text v-if="b.total" :x="b.x + b.w / 2" :y="b.yIg - 4" text-anchor="middle" font-size="10" font-weight="600" fill="#2d293f">{{ b.total }}</text>
                <text :x="b.x + b.w / 2" :y="G.h - 8" text-anchor="middle" font-size="10" fill="#716c87">{{ b.rot }}</text>
              </g>
            </svg>
          </div>
          <p v-else class="py-12 text-center text-sm text-tinta-fraca">Nenhuma conversa nos últimos 14 dias.</p>
        </section>

        <section class="card" aria-labelledby="t-assuntos">
          <h2 id="t-assuntos" class="rotulo-kpi">Sobre o que falam (7 dias)</h2>
          <ul v-if="assuntos.length" class="mt-3 space-y-2.5">
            <li v-for="a in assuntos" :key="a.intencao">
              <div class="flex items-baseline justify-between gap-2 text-sm">
                <span class="font-semibold text-tinta">{{ a.r.assunto }} <span class="font-normal text-tinta-fraca">· {{ a.r.agente }}</span></span>
                <span class="tabular-nums text-tinta-suave">{{ num(a.contatos) }} pessoas</span>
              </div>
              <div class="mt-1 h-2 rounded-full bg-ink-100">
                <div class="h-2 rounded-full" :class="a.r.tom === 'erro' ? 'bg-danger-600' : a.r.tom === 'ok' ? 'bg-success-600' : a.r.tom === 'alerta' ? 'bg-warning-600' : 'bg-pool-600'"
                     :style="{ width: `${Math.max(a.pct, 2)}%` }" />
              </div>
            </li>
          </ul>
          <p v-else class="py-10 text-center text-sm text-tinta-fraca">Sem conversa nos últimos 7 dias.</p>
          <div class="mt-5 border-t border-linha pt-4">
            <p class="text-xs font-semibold uppercase tracking-wide text-tinta-fraca">Horário de pico · pico às {{ horas.pico.hora }}h</p>
            <div class="mt-2 flex h-14 items-end gap-[3px]" role="img" :aria-label="`Mensagens por hora do dia; pico às ${horas.pico.hora} horas`">
              <div v-for="h in horas.lista" :key="h.hora" class="flex-1 rounded-t-sm"
                   :class="h.hora === horas.pico.hora ? 'bg-pool-700' : 'bg-pool-300'"
                   :style="{ height: `${Math.max(h.pct, 3)}%` }" :title="`${h.hora}h: ${h.turnos} respostas`" />
            </div>
            <div class="mt-1 flex justify-between text-[10px] text-tinta-fraca"><span>0h</span><span>6h</span><span>12h</span><span>18h</span><span>23h</span></div>
          </div>
        </section>
      </div>

      <!-- ====================================================== abas -->
      <section class="mt-4 card p-0" aria-label="Conversas e casos">
        <div class="flex flex-wrap items-center gap-2 border-b border-linha px-4 pt-3" role="tablist">
          <button type="button" role="tab" :aria-selected="aba === 'conversas'" class="-mb-px border-b-2 px-3 pb-2.5 text-sm font-semibold"
                  :class="aba === 'conversas' ? 'border-pool-700 text-pool-800' : 'border-transparent text-tinta-suave hover:text-tinta'"
                  @click="aba = 'conversas'">Conversas <span class="ml-1 text-xs text-tinta-fraca">{{ conversas.length }}</span></button>
          <button type="button" role="tab" :aria-selected="aba === 'casos'" class="-mb-px border-b-2 px-3 pb-2.5 text-sm font-semibold"
                  :class="aba === 'casos' ? 'border-pool-700 text-pool-800' : 'border-transparent text-tinta-suave hover:text-tinta'"
                  @click="aba = 'casos'">Casos registrados <span class="ml-1 text-xs text-tinta-fraca">{{ (visao.casos ?? []).length }}</span></button>
        </div>

        <!-- ------------------------------------------------ conversas -->
        <div v-if="aba === 'conversas'" class="p-4">
          <div class="flex flex-wrap items-center gap-2">
            <input v-model="busca" type="search" class="campo max-w-xs" placeholder="Buscar nome, número ou mensagem" aria-label="Buscar conversa">
            <select v-model="canal" class="campo w-auto" aria-label="Canal">
              <option value="">Todos os canais</option>
              <option value="whatsapp">WhatsApp</option>
              <option value="instagram">Instagram</option>
            </select>
            <div class="flex flex-wrap gap-1.5">
              <button v-for="[v, t] in RECORTES" :key="v" type="button" :class="recorte === v ? 'chip-ativo' : 'chip'" @click="recorte = v">
                {{ t }} <span class="ml-1 tabular-nums opacity-70">{{ contagem(v) }}</span>
              </button>
            </div>
          </div>

          <ul v-if="filtradas.length" class="mt-3 divide-y divide-linha">
            <li v-for="c in visiveis" :key="c.contato">
              <button type="button" class="flex w-full items-start gap-3 rounded-xl px-2 py-3 text-left transition-colors hover:bg-fundo-cinza"
                      :aria-label="`Abrir conversa com ${c.nome || contatoLegivel(c.contato)}`" @click="abrir(c.contato)">
                <span class="grid size-10 shrink-0 place-items-center rounded-full text-sm font-semibold text-white"
                      :class="c.canalDe === 'instagram' ? 'bg-gradient-to-br from-grape-500 to-grape-700' : 'bg-gradient-to-br from-pool-500 to-pool-700'">
                  {{ iniciais(c.nome, c.contato) }}
                </span>
                <span class="min-w-0 flex-1">
                  <span class="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span class="truncate font-semibold text-tinta">{{ c.nome || contatoLegivel(c.contato) }}</span>
                    <span class="text-xs text-tinta-fraca">{{ ROTULO_DO_CANAL[c.canalDe as keyof typeof ROTULO_DO_CANAL] }}<template v-if="c.nome && c.canalDe === 'whatsapp'"> · {{ contatoLegivel(c.contato) }}</template></span>
                    <span :class="seloDoTom[c.r.tom]">{{ c.r.agente }}</span>
                    <span v-if="c.caso_aberto" class="selo-erro">reclamação aberta</span>
                    <span v-if="c.humano_no_comando" class="selo-neutro">humano no comando</span>
                    <span v-if="c.bloqueios" class="selo-alerta" :title="c.motivos || ''">{{ c.bloqueios }} barrada(s)</span>
                  </span>
                  <span class="mt-1 block truncate text-sm text-tinta-corpo"><b class="font-semibold">Cliente:</b> {{ c.ultima_mensagem || '—' }}</span>
                  <span class="block truncate text-sm text-tinta-suave"><b class="font-semibold">Sofia:</b> {{ c.ultima_resposta || '—' }}</span>
                  <span v-if="c.resumo?.resumo" class="mt-1 block text-xs text-tinta-fraca">Resumo: {{ c.resumo.resumo }}</span>
                </span>
                <span class="shrink-0 text-right text-xs text-tinta-fraca">
                  <span class="block">{{ quando(c.ultimo_em) }}</span>
                  <span class="block tabular-nums">{{ c.turnos }} {{ c.turnos === 1 ? 'resposta' : 'respostas' }}</span>
                </span>
              </button>
            </li>
          </ul>
          <div v-if="filtradas.length > visiveis.length" class="mt-3 flex items-center justify-center gap-3">
            <button type="button" class="btn-secundario" @click="quantasConversas += POR_VEZ">Mostrar mais {{ Math.min(POR_VEZ, filtradas.length - visiveis.length) }}</button>
            <span class="text-xs text-tinta-fraca">{{ visiveis.length }} de {{ filtradas.length }}</span>
          </div>
          <div v-if="!filtradas.length" class="py-12 text-center">
            <p class="text-sm font-semibold text-tinta">{{ conversas.length ? 'Nenhuma conversa nesse recorte.' : 'Nenhuma conversa nos últimos 7 dias.' }}</p>
            <button v-if="conversas.length" type="button" class="btn-secundario mt-3" @click="canal = ''; recorte = ''; busca = ''">Limpar filtros</button>
          </div>
        </div>

        <!-- ---------------------------------------------------- casos -->
        <div v-else class="p-4">
          <div class="flex flex-wrap gap-1.5">
            <button type="button" :class="!tipoCaso ? 'chip-ativo' : 'chip'" @click="tipoCaso = ''">Todos <span class="ml-1 opacity-70">{{ contaTipo('') }}</span></button>
            <button v-for="(t, v) in TIPOS" :key="v" type="button" :class="tipoCaso === v ? 'chip-ativo' : 'chip'" @click="tipoCaso = String(v)">
              {{ t.texto }} <span class="ml-1 opacity-70">{{ contaTipo(String(v)) }}</span>
            </button>
          </div>
          <p class="mt-2 text-xs text-tinta-fraca">"A Sofia não soube" é pergunta de cliente que ela não tinha como responder — cada uma é uma informação que falta no treinamento dela.</p>
          <ul v-if="casos.length" class="mt-3 divide-y divide-linha">
            <li v-for="c in casos.slice(0, quantosCasos)" :key="c.id" class="py-3">
              <div class="flex flex-wrap items-center gap-2">
                <span :class="TIPOS[c.tipo]?.selo ?? 'selo-neutro'">{{ TIPOS[c.tipo]?.texto ?? c.tipo }}</span>
                <span class="selo-neutro">{{ STATUS_CASO[c.status] ?? c.status }}</span>
                <span class="font-semibold text-tinta">{{ c.nome || contatoLegivel(c.contato) }}</span>
                <span class="text-xs text-tinta-fraca">{{ quando(c.mexido_em) }}</span>
                <button type="button" class="ml-auto text-sm font-semibold text-acao hover:underline" @click="abrir(c.contato)">Ver conversa</button>
              </div>
              <p v-if="c.assunto" class="mt-1 text-sm font-semibold text-tinta-corpo">{{ c.assunto }}</p>
              <p v-if="c.relato" class="mt-0.5 text-sm text-tinta-suave">{{ c.relato }}</p>
            </li>
          </ul>
          <div v-if="casos.length > quantosCasos" class="mt-3 flex items-center justify-center gap-3">
            <button type="button" class="btn-secundario" @click="quantosCasos += POR_VEZ">Mostrar mais {{ Math.min(POR_VEZ, casos.length - quantosCasos) }}</button>
            <span class="text-xs text-tinta-fraca">{{ Math.min(quantosCasos, casos.length) }} de {{ casos.length }}</span>
          </div>
          <p v-if="!casos.length" class="py-12 text-center text-sm text-tinta-fraca">Nenhum caso desse tipo nos últimos 30 dias.</p>
        </div>
      </section>
    </template>

    <!-- ============================================== a conversa aberta -->
    <ModalLateral v-if="aberto" :titulo="nomeAberto || contatoLegivel(aberto)" largura="max-w-2xl" @fechar="aberto = ''">
      <div class="flex flex-wrap items-center gap-2 text-sm">
        <span class="selo-neutro">{{ ROTULO_DO_CANAL[canalAberto] }}</span>
        <span class="text-tinta-suave">{{ contatoLegivel(aberto) }}</span>
        <span v-if="daLista" :class="seloDoTom[daLista.r.tom]">{{ daLista.r.agente }}</span>
        <span v-if="daLista?.humano_no_comando" class="selo-neutro">humano no comando</span>
        <a v-if="linkWhats" :href="linkWhats" target="_blank" rel="noopener" class="btn-secundario ml-auto">Abrir no WhatsApp</a>
      </div>

      <section class="mt-4 rounded-2xl bg-fundo-cinza p-4" aria-labelledby="t-resumo">
        <div class="flex items-center justify-between gap-2">
          <h3 id="t-resumo" class="text-sm font-semibold text-tinta">Resumo da conversa</h3>
          <button type="button" class="btn-secundario" :disabled="resumindo || carregandoDetalhe || !detalhe?.turnos?.length"
                  @click="resumir(!!resumoAberto)">
            {{ resumindo ? 'Resumindo…' : resumoAberto ? (detalhe?.resumo?.em_dia ? 'Refazer' : 'Atualizar resumo') : 'Gerar resumo' }}
          </button>
        </div>
        <p v-if="erroResumo" class="faixa-erro mt-3">{{ erroResumo }}</p>
        <div v-if="resumoAberto" class="mt-2 space-y-2 text-sm text-tinta-corpo">
          <p>{{ resumoAberto.resumo }}</p>
          <div class="flex flex-wrap gap-2">
            <span v-if="resumoAberto.situacao" :class="seloDoTom[SITUACAO_DO_RESUMO[resumoAberto.situacao]?.tom ?? 'neutro']">{{ SITUACAO_DO_RESUMO[resumoAberto.situacao]?.texto ?? resumoAberto.situacao }}</span>
            <span v-if="resumoAberto.sentimento" class="selo-neutro">{{ SENTIMENTO[resumoAberto.sentimento] ?? resumoAberto.sentimento }}</span>
          </div>
          <p v-if="resumoAberto.quer"><b class="font-semibold">Quer:</b> {{ resumoAberto.quer }}</p>
          <p v-if="resumoAberto.proximo_passo && resumoAberto.proximo_passo !== 'nada'"><b class="font-semibold">Próximo passo:</b> {{ resumoAberto.proximo_passo }}</p>
          <p v-if="resumoAberto.alerta" class="faixa-erro">{{ resumoAberto.alerta }}</p>
          <p class="text-xs text-tinta-fraca">
            escrito pela IA {{ quando(detalhe?.resumo?.criado_em) }}{{ detalhe?.resumo?.em_dia === false ? ' · a conversa andou depois disso' : '' }}
          </p>
        </div>
        <p v-else-if="!resumindo" class="mt-2 text-sm text-tinta-suave">Clique em "Gerar resumo" pra IA ler a conversa e dizer em 2 frases o que a pessoa quer e como terminou.</p>
      </section>

      <p v-if="erroDetalhe" class="faixa-erro mt-4">{{ erroDetalhe }}</p>
      <div v-else-if="carregandoDetalhe && !detalhe" class="mt-4 space-y-2" aria-busy="true">
        <div v-for="i in 4" :key="i" class="h-12 animate-pulse rounded-xl bg-fundo-cinza" />
      </div>

      <template v-if="detalhe">
        <section v-if="detalhe.casos?.length" class="mt-4">
          <h3 class="text-sm font-semibold text-tinta">Casos desta pessoa</h3>
          <ul class="mt-2 space-y-2">
            <li v-for="c in detalhe.casos" :key="c.id" class="rounded-xl p-3 ring-1 ring-inset ring-linha">
              <div class="flex flex-wrap items-center gap-2">
                <span :class="TIPOS[c.tipo]?.selo ?? 'selo-neutro'">{{ TIPOS[c.tipo]?.texto ?? c.tipo }}</span>
                <span class="selo-neutro">{{ STATUS_CASO[c.status] ?? c.status }}</span>
                <span class="text-xs text-tinta-fraca">{{ quando(c.atualizado_em || c.criado_em) }}</span>
              </div>
              <p v-if="c.assunto" class="mt-1 text-sm font-semibold text-tinta-corpo">{{ c.assunto }}</p>
              <p v-if="c.relato" class="mt-0.5 text-sm text-tinta-suave">{{ c.relato }}</p>
            </li>
          </ul>
        </section>

        <section class="mt-4">
          <h3 class="text-sm font-semibold text-tinta">Conversa <span class="font-normal text-tinta-fraca">· {{ detalhe.turnos?.length ?? 0 }} respostas</span></h3>
          <ol v-if="detalhe.turnos?.length" class="mt-2 space-y-3">
            <li v-for="t in detalhe.turnos" :key="t.id" class="space-y-1.5">
              <div v-if="t.mensagem" class="max-w-[85%] rounded-2xl rounded-tl-md bg-fundo-cinza px-3.5 py-2.5 text-sm text-tinta-corpo">
                <p class="whitespace-pre-line break-words">{{ t.mensagem }}</p>
                <p class="mt-1 text-[11px] text-tinta-fraca">{{ hora(t.criado_em) }}</p>
              </div>
              <div v-if="t.resposta" class="ml-auto max-w-[85%] rounded-2xl rounded-tr-md bg-pool-50 px-3.5 py-2.5 text-sm text-tinta-corpo ring-1 ring-inset ring-pool-100">
                <p class="whitespace-pre-line break-words">{{ t.resposta }}</p>
                <p class="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-tinta-fraca">
                  <span>{{ rotuloDaIntencao(t.intencao).agente }}</span>
                  <span v-if="t.bloqueada" class="selo-alerta" :title="t.motivos || ''">resposta original barrada{{ t.motivos ? `: ${t.motivos}` : '' }}</span>
                </p>
              </div>
            </li>
          </ol>
          <p v-else class="mt-2 text-sm text-tinta-suave">Nenhuma mensagem registrada com esse contato.</p>
        </section>
      </template>
    </ModalLateral>
  </div>
</template>
