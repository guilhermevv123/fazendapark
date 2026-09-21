<script setup lang="ts">
/**
 * Leitor de entrada — a tela que roda com gente na fila.
 *
 * Três decisões que vieram de como a porta funciona de verdade:
 *
 * 1. O campo de código NUNCA perde o foco. Leitor de código de barras é um
 *    teclado: ele digita e dá Enter. Se o foco escapar pra outro lugar (um
 *    clique, um alerta), a próxima leitura some no vazio e o operador só
 *    descobre quando a fila para.
 *
 * 2. A resposta é GRANDE e colorida. Quem opera olha a tela de relance com o
 *    celular na mão; um texto de 14px dizendo "já usado" não é lido a tempo.
 *
 * 3. "Só conferir" existe porque perguntar é diferente de deixar entrar. O
 *    operador precisa poder checar um ingresso sem queimá-lo.
 *
 * ## E a quarta, que muda o resto: o 4G cai
 *
 * O parque fica na Bahia. Quando a rede some, o portão não pode parar — e é
 * por isso que esta tela guarda três coisas no próprio aparelho:
 *
 *   • a LISTA de ingressos do evento, baixada quando havia rede;
 *   • a FILA das passagens que aconteceram sem rede;
 *   • o ID DO APARELHO, que é o que explica depois por que o mesmo ingresso
 *     entrou por dois portões.
 *
 * Com rede, nada muda: quem decide é o servidor, que é o único que enxerga os
 * dois portões ao mesmo tempo. Sem rede, a decisão é local, contra a lista, e
 * a passagem entra na fila com um `id` criado AQUI. Esse id é o que faz a
 * sincronização ser idempotente: mandar a mesma fila duas vezes não conta a
 * pessoa duas vezes (`ON CONFLICT (id) DO NOTHING`, em utils/catraca.ts).
 *
 * O que esta tela NÃO faz: fingir que está online. Toda resposta decidida
 * localmente vem marcada como tal, porque a diferença importa — "pode entrar
 * (offline)" quer dizer "ainda não foi conferido com os outros portões".
 */
definePageMeta({ layout: 'admin' })

const route = useRoute()
const id = route.params.id as string

const codigo = ref('')
const gate = ref('')
const apenasConsultar = ref(false)
const lendo = ref(false)
const campo = ref<HTMLInputElement | null>(null)

/** o que a portaria pede quando o ingresso é meia (migração 015) */
type Meia = { motivo: string; rotulo: string; documento: string; numero: string | null }

/** o retrato do público — um objeto, uma consulta (ver `publico` abaixo) */
type Publico = {
  pessoas: number; entradas: number; ingressos: number
  offline: number; aptos: number; comparecimentoPct: number
}

type Resposta = {
  ok: boolean; resultado: string; mensagem: string; consulta?: boolean
  titular?: string | null; entrouEm?: string | null
  portao?: string | null; operadorEntrada?: string | null
  local?: boolean; pessoas?: number
  /** só nas respostas do SERVIDOR: a decisão local não sabe contar o parque */
  publico?: Publico
  ingresso?: {
    titular: string | null; setor: string; lote: string; tipo: string | null
    meia?: Meia | null
  }
}
const ultima = ref<Resposta | null>(null)
const historico = ref<(Resposta & { codigo: string; quando: Date })[]>([])

const { data, refresh } = await useFetch<any>(`/api/admin/evento/${id}/checkins`)

/* ----------------------------------------------------------- estado offline */

type IngressoLocal = {
  codigo: string; status: string; titular: string | null
  setor: string; lote: string; tipo: string | null; pessoas: number
  /** a meia desce com a lista: é no apagão que o operador mais precisa dela */
  meia?: Meia | null
  sessaoInicio: string | null; sessaoFim: string | null
  /** marcado por ESTE aparelho enquanto estava sem rede */
  usadoAqui?: { em: string; gate: string | null }
}
type Passagem = { id: string; qr: string; gate: string | null; em: string; offline: boolean }

const CHAVE_LISTA = `dt_portaria_lista_${id}`
const CHAVE_FILA = `dt_portaria_fila_${id}`
const CHAVE_APARELHO = 'dt_portaria_aparelho'

const lista = ref<IngressoLocal[]>([])
const listaEm = ref<string | null>(null)
const fila = ref<Passagem[]>([])
const aparelho = ref('')
const online = ref(true)
const sincronizando = ref(false)
const baixando = ref(false)
const avisoLocal = ref('')
/**
 * O retrato do público — UM objeto, vindo de UMA consulta
 * (`retratoDoPublico`/`SQL_PUBLICO`, em server/utils/catraca.ts).
 *
 * Os três cards de cima saíam de dois lugares e se contradiziam na cara do
 * operador: "Pessoas dentro = 2 (em 2 passagens)" ao lado de "Já entraram = 0
 * (de 392 aptos)" e "Comparecimento = 0%". Um contava o LIVRO de passagens
 * (`entries`) e os outros dois contavam o carimbo do ingresso
 * (`tickets.status = 'usado'`), que é trava e não ledger — ele volta atrás em
 * cancelamento e nunca existiu para a passagem retroativa da migração 013.
 *
 * Agora os três leem daqui. Sem rede eles mostram "—" juntos: não saber é
 * honesto, discordar não.
 *
 * Quem escreve aqui são os DOIS caminhos que falam com o servidor: a
 * sincronização (`sincronizar`) e cada leitura registrada (`ler`). Ficar só na
 * sincronização foi um furo medido em 21/09: com rede boa ela roda uma vez, na
 * montagem, e os três números congelavam na abertura da tela enquanto a porta
 * seguia deixando gente entrar — servidor com `pessoas = 1`, tela mostrando
 * `0`. O quarto card (do log do leitor) continuava andando ao lado, que é a
 * discordância de sempre por outro caminho.
 */
const publico = ref<Publico | null>(null)
/** aparelho que sincronizou com o relógio fora da janela do evento */
const avisoRelogio = ref<{ passagens: number; dispositivo: string | null
                           motivo: string; piorEnviado: string | null } | null>(null)
const conflitos = ref<any[]>([])
const swPronto = ref<'sim' | 'nao' | 'indisponivel'>('indisponivel')

const mapa = computed(() => {
  const m = new Map<string, IngressoLocal>()
  for (const i of lista.value) m.set(i.codigo, i)
  return m
})

/** uuid mesmo fora de contexto seguro — tablet do parque roda em http na LAN,
 *  e ali `crypto.randomUUID` não existe. Sem id não há idempotência. */
function novoId(): string {
  try {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  } catch { /* segue pro plano B */ }
  const h = '0123456789abcdef'
  let s = ''
  for (let i = 0; i < 36; i++) {
    s += i === 8 || i === 13 || i === 18 || i === 23 ? '-'
      : i === 14 ? '4'
      : i === 19 ? h[8 + Math.floor(Math.random() * 4)]
      : h[Math.floor(Math.random() * 16)]
  }
  return s
}

function guardar(chave: string, valor: unknown) {
  try { localStorage.setItem(chave, JSON.stringify(valor)) } catch (e: any) {
    // Cota estourada com 20 mil ingressos é possível. O operador precisa saber
    // AGORA, não descobrir no apagão — uma fila que não persiste some no F5.
    avisoLocal.value = 'Não foi possível guardar os dados no aparelho '
      + '(memória do navegador cheia). Sem rede, este leitor não vai funcionar.'
  }
}
function recuperar<T>(chave: string, padrao: T): T {
  try {
    const cru = localStorage.getItem(chave)
    return cru ? JSON.parse(cru) as T : padrao
  } catch { return padrao }
}

/* ------------------------------------------------------------- ciclo de vida */

// Gate fica no navegador: é propriedade do PORTÃO, não do usuário. O mesmo
// login opera a portaria norte hoje e a sul amanhã, e o servidor não tem como
// adivinhar em qual das duas aquele tablet está.
onMounted(async () => {
  gate.value = localStorage.getItem(`dt_gate_${id}`) ?? ''

  aparelho.value = localStorage.getItem(CHAVE_APARELHO) ?? ''
  if (!aparelho.value) {
    aparelho.value = novoId().slice(0, 8)
    try { localStorage.setItem(CHAVE_APARELHO, aparelho.value) } catch { /* aba anônima */ }
  }

  const guardada = recuperar<{ em: string; ingressos: IngressoLocal[] } | null>(CHAVE_LISTA, null)
  if (guardada) { lista.value = guardada.ingressos; listaEm.value = guardada.em }
  fila.value = recuperar<Passagem[]>(CHAVE_FILA, [])

  online.value = navigator.onLine
  window.addEventListener('online', aoVoltarRede)
  window.addEventListener('offline', () => { online.value = false })

  await registrarWorker()
  if (online.value) sincronizar({ comLista: true })

  campo.value?.focus()
})

onBeforeUnmount(() => {
  window.removeEventListener('online', aoVoltarRede)
})

function aoVoltarRede() {
  online.value = true
  sincronizar({ comLista: lista.value.length === 0 })
}

watch(gate, (v) => {
  try { localStorage.setItem(`dt_gate_${id}`, v) } catch { /* aba anônima */ }
})

/**
 * O service worker é o que faz a PÁGINA abrir sem rede — sem ele, o F5 no
 * meio do apagão mostra a tela de erro do navegador e some com tudo.
 * Registrar pode falhar (http sem TLS fora de localhost, navegador antigo,
 * modo anônimo): isso não pode derrubar o leitor, só muda o que a faixa de
 * estado promete.
 */
async function registrarWorker() {
  if (!('serviceWorker' in navigator)) { swPronto.value = 'indisponivel'; return }
  try {
    await navigator.serviceWorker.register('/sw-portaria.js')
    swPronto.value = 'sim'
  } catch {
    swPronto.value = 'nao'
  }
}

/* ------------------------------------------------------------------ leitura */

/** separa o código do QR assinado; o resto é código digitado à mão */
function codigoDoQr(bruto: string): { codigo: string; eventoDoQr: string | null } {
  const partes = bruto.trim().split(':')
  if (partes.length === 4 && partes[0] === 'DT1') {
    return { codigo: partes[2], eventoDoQr: partes[1] }
  }
  return { codigo: bruto.trim().toUpperCase(), eventoDoQr: null }
}

/**
 * A decisão sem servidor. Confere contra a lista baixada — que é uma prova
 * mais forte que a assinatura do QR, porque além de dizer que o ingresso é
 * legítimo diz de qual evento ele é e em que estado está. A chave que assina
 * o QR não sai do servidor, então conferir assinatura aqui seria impossível
 * de qualquer jeito.
 */
function validarLocal(bruto: string, idPassagem: string = novoId()): Resposta {
  const { codigo: cod, eventoDoQr } = codigoDoQr(bruto)
  const base = { local: true, ok: false }

  if (!lista.value.length) {
    return { ...base, resultado: 'invalido',
             mensagem: 'Sem rede e sem lista baixada neste aparelho. Chame o supervisor.' }
  }
  if (eventoDoQr && eventoDoQr !== id) {
    return { ...base, resultado: 'evento_errado', mensagem: 'Ingresso é de outro evento' }
  }

  const t = mapa.value.get(cod)
  if (!t) return { ...base, resultado: 'invalido', mensagem: 'Ingresso inválido' }
  if (t.status === 'cancelado') {
    return { ...base, resultado: 'cancelado', mensagem: 'Ingresso cancelado' }
  }
  if (t.status === 'usado' || t.usadoAqui) {
    return { ...base, resultado: 'ja_usado', mensagem: 'Este ingresso já entrou',
             titular: t.titular, entrouEm: t.usadoAqui?.em ?? null,
             portao: t.usadoAqui?.gate ?? null }
  }
  if (t.sessaoInicio) {
    // a mesma folga de 2h do servidor: chegar cedo é normal
    const agora = Date.now()
    const abre = new Date(t.sessaoInicio).getTime() - 2 * 3600_000
    const fecha = new Date(t.sessaoFim ?? t.sessaoInicio).getTime() + 2 * 3600_000
    if (agora < abre || agora > fecha) {
      return { ...base, resultado: 'fora_da_sessao', mensagem: 'Fora do horário desta sessão' }
    }
  }

  // A meia sai da lista baixada, igual ao resto: sem rede o operador continua
  // precisando saber QUAL papel pedir, e é justamente no apagão que ele não
  // tem como perguntar a ninguém.
  const dados = { titular: t.titular, setor: t.setor, lote: t.lote, tipo: t.tipo,
                  meia: t.meia ?? null }

  if (apenasConsultar.value) {
    return { local: true, ok: true, resultado: 'ok', mensagem: 'Válido (não marcado)',
             consulta: true, ingresso: dados }
  }

  // Passou: entra na fila com id criado AQUI, e o ingresso fica marcado no
  // aparelho pra que o mesmo QR não passe duas vezes NESTE portão. Os outros
  // portões só saberão quando a rede voltar — e aí o servidor mostra o
  // conflito em vez de escondê-lo.
  const em = new Date().toISOString()
  t.usadoAqui = { em, gate: gate.value || null }
  fila.value = [...fila.value, { id: idPassagem, qr: bruto.trim(), gate: gate.value || null,
                                 em, offline: true }]
  guardar(CHAVE_FILA, fila.value)
  guardar(CHAVE_LISTA, { em: listaEm.value, ingressos: lista.value })

  return { local: true, ok: true, resultado: 'ok', mensagem: 'Liberado (sem rede)',
           pessoas: t.pessoas, ingresso: dados }
}

async function ler() {
  const c = codigo.value.trim()
  if (!c || lendo.value) return
  lendo.value = true
  /**
   * UM id por passagem FÍSICA, criado antes de saber se vai ter rede.
   *
   * Online, é ele que o servidor grava no livro (`entradaId`). Se a resposta
   * morrer no caminho — o 4G do parque cai entre o INSERT e o recibo — a
   * decisão cai pro aparelho, e é o MESMO id que vai pra fila. Aí a
   * sincronização bate no `ON CONFLICT (id) DO NOTHING` e devolve `repetida`:
   * uma pessoa, uma linha.
   *
   * Com dois ids diferentes pra mesma passagem (era assim: um `novoId()` no
   * `entradaId` e outro dentro de `validarLocal`) o `ON CONFLICT` nunca
   * dispara. Medido contra o servidor: uma mesa de 4 lida uma vez virou
   * **8 pessoas** no relatório de público, e o cliente apareceu no painel
   * "entradas repetidas" como se tivesse fraudado a catraca. Nada lança
   * exceção, nada aparece no console — só o número fica errado.
   */
  const idPassagem = novoId()
  try {
    if (!online.value) {
      ultima.value = validarLocal(c, idPassagem)
    } else {
      try {
        ultima.value = await $fetch<Resposta>('/api/checkin', {
          method: 'POST',
          body: { qr: c, eventId: id, gate: gate.value || undefined,
                  apenasConsultar: apenasConsultar.value,
                  entradaId: idPassagem, deviceId: aparelho.value },
        })
        // O retrato do público vem DENTRO da resposta da porta (o mesmo
        // `SQL_PUBLICO` da sincronização), então os três cards do topo andam a
        // cada leitura sem uma segunda ida à rede — que num portão com 4G ruim
        // é justamente o que não dá pra gastar. A consulta ("só conferir") não
        // traz retrato: ela não mexe em nada.
        if (ultima.value?.publico) publico.value = ultima.value.publico
        // Só repinta os contadores quando alguém realmente entrou — recontar a
        // cada leitura recusada bate no banco no pior momento possível.
        if (ultima.value?.ok && !ultima.value.consulta) refresh()
      } catch (e: any) {
        // 400/403/404 são resposta do servidor: ele está no ar e disse não.
        // Repetir a decisão localmente aqui seria contrariar quem sabe mais.
        // Só a FALHA DE REDE (sem status) vira validação local.
        if (e?.statusCode || e?.response?.status) {
          ultima.value = { ok: false, resultado: 'invalido',
                           mensagem: e?.data?.statusMessage || e?.statusMessage || 'Falha ao ler' }
        } else {
          online.value = false
          // MESMO id da tentativa online: o servidor pode ter gravado antes de
          // a resposta se perder, e é o id que decide se isto é a mesma pessoa
          // ou uma segunda.
          ultima.value = validarLocal(c, idPassagem)
        }
      }
    }
    if (ultima.value) {
      historico.value.unshift({ ...ultima.value, codigo: c, quando: new Date() })
      historico.value = historico.value.slice(0, 12)
    }
  } finally {
    codigo.value = ''
    lendo.value = false
    // nextTick: o input só volta a existir depois do repintar
    nextTick(() => campo.value?.focus())
  }
}

/* ------------------------------------------------------------ sincronização */

const ultimoEnvio = ref<{ aplicadas: number; repetidas: number; conflitos: number;
                          recusadas: number; cancelados: number } | null>(null)

/**
 * Quantas passagens cabem num envio.
 *
 * O servidor recusa remessa acima de `LIMITE_FILA` (500, em
 * `server/utils/catraca.ts`) e a recusa é **400** — e 400 não tira nada da
 * fila. Mandando a fila inteira de uma vez, o portão que passou a manhã sem
 * rede trava de vez: todo envio volta 400, a fila nunca esvazia, e a tela diz
 * "atualize a página", que não resolve nada. Medido nesta instalação:
 * 501 itens = HTTP 400, 500 itens = HTTP 200.
 *
 * Abaixo do teto de propósito: quem escrever `LIMITE_FILA = 400` amanhã não
 * quebra o portão.
 */
const LOTE_FILA = 400

async function sincronizar({ comLista = false } = {}) {
  if (sincronizando.value) return
  sincronizando.value = true
  if (comLista) baixando.value = true
  // Limpo aqui e não no fim: um aviso levantado DURANTE a sincronização (cota
  // do navegador cheia, lista truncada) tem que sobreviver ao sucesso do
  // envio. Antes o aviso nunca era apagado e uma falha de dez segundos atrás
  // ficava na tela o evento inteiro.
  avisoLocal.value = ''
  // Pelo mesmo motivo do aviso acima: o relógio torto de DEZ minutos atrás não
  // pode ficar na tela o evento inteiro depois de o aparelho ser acertado.
  avisoRelogio.value = null
  const soma = { aplicadas: 0, repetidas: 0, conflitos: 0, recusadas: 0, cancelados: 0 }
  let baixarAgora = comLista
  try {
    // Uma volta por remessa, até a fila esvaziar. `comLista` só na primeira:
    // baixar 20 mil ingressos a cada remessa é o que transforma rede ruim em
    // rede parada.
    for (;;) {
      const enviada = fila.value.slice(0, LOTE_FILA)
      const antes = fila.value.length

      const r = await $fetch<any>('/api/portaria/sincronizar', {
        method: 'POST',
        body: { eventId: id, deviceId: aparelho.value, fila: enviada, comLista: baixarAgora },
      })
      online.value = true
      baixarAgora = false

      // Tira da fila exatamente o que o servidor confirmou ter recebido. O que
      // não voltou fica pra próxima — perder uma passagem aqui é perder uma
      // pessoa do relatório de público, e ninguém descobre depois.
      const respondidos = new Set<string>((r.itens ?? []).map((i: any) => i.id))
      fila.value = fila.value.filter((p) => !respondidos.has(p.id))
      guardar(CHAVE_FILA, fila.value)

      // O resumo é a soma de TODAS as remessas: o operador leu "1 registrada"
      // e tinha 900 na fila — o número da última remessa mente sobre o envio.
      for (const k of Object.keys(soma) as (keyof typeof soma)[]) {
        soma[k] += Number(r.resumo?.[k] ?? 0)
      }
      ultimoEnvio.value = { ...soma }
      publico.value = r.publico
      conflitos.value = r.conflitos ?? []

      // O relógio do aparelho. Somado entre as remessas: uma fila de 900
      // passagens vira três envios, e mostrar só o último diria "3 passagens
      // com hora errada" quando foram 900.
      if (r.relogio) {
        avisoRelogio.value = avisoRelogio.value
          ? { ...avisoRelogio.value,
              passagens: avisoRelogio.value.passagens + Number(r.relogio.passagens ?? 0) }
          : { passagens: Number(r.relogio.passagens ?? 0),
              dispositivo: r.relogio.dispositivo ?? null,
              motivo: r.relogio.motivo,
              piorEnviado: r.relogio.piorEnviado ?? null }
      }

      if (r.lista) {
        // A lista nova não pode apagar o que este aparelho marcou e ainda não
        // sincronizou: sem isto, baixar a lista no meio do apagão devolveria ao
        // estado "válido" um ingresso que já passou por aqui.
        const pendentes = new Set(fila.value.map((p) => codigoDoQr(p.qr).codigo))
        lista.value = r.lista.ingressos.map((i: IngressoLocal) =>
          pendentes.has(i.codigo)
            ? { ...i, usadoAqui: mapa.value.get(i.codigo)?.usadoAqui }
            : i)
        listaEm.value = r.lista.geradaEm
        guardar(CHAVE_LISTA, { em: listaEm.value, ingressos: lista.value })

        // O servidor corta a lista em 20 mil e MARCA o corte. Sem ler essa
        // marca, o tablet ficaria recusando ingresso bom no apagão sem que
        // ninguém soubesse por quê — a falha muda de sempre.
        if (r.lista.truncada) {
          avisoLocal.value = `A lista parou em ${lista.value.length} ingressos e este evento `
            + 'tem mais que isso. Sem rede, quem ficou de fora da lista será recusado — '
            + 'não opere este portão offline.'
        }
      }

      // Sai quando a fila acabou. O `>= antes` é o freio contra girar pra
      // sempre se uma remessa voltar 200 sem responder pelos itens dela.
      if (!fila.value.length || fila.value.length >= antes) break
    }
    refresh()
  } catch (e: any) {
    if (!e?.statusCode && !e?.response?.status) online.value = false
    else avisoLocal.value = e?.data?.statusMessage || 'Não foi possível sincronizar agora.'
  } finally {
    sincronizando.value = false
    baixando.value = false
  }
}

/* ------------------------------------------------------------------- visual */

const CLASSE: Record<string, string> = {
  ok: 'bg-ok text-white',
  ja_usado: 'bg-alerta text-white',
  invalido: 'bg-erro text-white',
  cancelado: 'bg-erro text-white',
  fora_da_sessao: 'bg-alerta text-white',
  evento_errado: 'bg-erro text-white',
}

const prontoParaApagao = computed(() =>
  lista.value.length > 0 && swPronto.value === 'sim')

const quando = (v: string | null | undefined) =>
  v ? new Date(v).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : ''

/** 0,5% e não "0.5%" — e sem casa decimal quando não precisa */
const pct = (v: number) => Number(v).toLocaleString('pt-BR', { maximumFractionDigits: 1 })

useHead({ title: 'Leitor de entrada' })
</script>

<template>
  <div>
    <div class="flex flex-wrap items-start justify-between gap-3 py-5">
      <div>
        <h1 class="titulo text-2xl font-bold text-tinta">Leitor de entrada</h1>
        <p class="mt-1 text-tinta-suave">
          Leia o QR ou digite o código. O campo já fica no foco — pode apontar o leitor.
        </p>
      </div>
      <!-- o botão de histórico saiu: virou aba logo abaixo, e dois caminhos
           pro mesmo lugar na mesma altura da tela só fazem o operador
           hesitar -->
    </div>

    <AbasSecao :evento-id="id" />

    <!-- Faixa de estado da rede. Fica no topo e é a primeira coisa que o
         operador vê: trabalhar offline sem saber que está offline é como o
         erro vira discussão na porta. -->
    <div class="card mt-4 flex flex-wrap items-center gap-x-6 gap-y-2">
      <span class="flex items-center gap-2 font-bold"
            :class="online ? 'text-ok' : 'text-alerta'">
        <span class="h-2.5 w-2.5 rounded-full" :class="online ? 'bg-ok' : 'bg-alerta'" />
        {{ online ? 'Conectado' : 'Sem rede — validando pela lista do aparelho' }}
      </span>

      <span class="text-sm text-tinta-suave">
        Aparelho <strong class="font-mono text-tinta">{{ aparelho }}</strong>
      </span>

      <span class="text-sm text-tinta-suave">
        Lista:
        <strong class="text-tinta">{{ lista.length }}</strong> ingressos
        <template v-if="listaEm"> · baixada {{ quando(listaEm) }}</template>
        <template v-else> · <span class="text-erro">nunca baixada</span></template>
      </span>

      <span class="text-sm" :class="fila.length ? 'font-bold text-alerta' : 'text-tinta-suave'">
        Fila para enviar: {{ fila.length }}
      </span>

      <span class="flex-1" />

      <button type="button" class="btn-secundario py-1.5 text-sm"
              :disabled="sincronizando" @click="sincronizar({ comLista: true })">
        {{ baixando ? 'Baixando…' : 'Baixar lista' }}
      </button>
      <button type="button" class="btn-secundario py-1.5 text-sm"
              :disabled="sincronizando || !fila.length" @click="sincronizar()">
        {{ sincronizando ? 'Enviando…' : `Enviar fila (${fila.length})` }}
      </button>
    </div>

    <p v-if="avisoLocal" class="faixa-erro mt-3">{{ avisoLocal }}</p>

    <p v-else-if="!prontoParaApagao" class="faixa-aviso mt-3">
      <strong>Este aparelho ainda não aguenta ficar sem rede.</strong>
      <template v-if="!lista.length"> Toque em “Baixar lista” enquanto há sinal.</template>
      <template v-if="swPronto !== 'sim'">
        A tela só reabre offline em endereço seguro (https) — em rede aberta, não feche a aba.
      </template>
    </p>

    <!-- Relógio do aparelho fora da janela do evento. Fica GRANDE e em cima
         porque o estrago é silencioso: a passagem entra do mesmo jeito (a
         pessoa passou), mas com a hora do servidor — e o operador precisa
         saber qual tablet acertar antes que a noite inteira vá embora assim. -->
    <div v-if="avisoRelogio" class="card mt-3 border-alerta bg-alerta-claro">
      <p class="rotulo-kpi text-alerta">
        Relógio errado em {{ avisoRelogio.passagens }} passagem(ns)
        <template v-if="avisoRelogio.dispositivo">
          do aparelho <span class="font-mono">{{ avisoRelogio.dispositivo }}</span>
        </template>
      </p>
      <p class="mt-1 text-sm text-tinta-corpo">
        {{ avisoRelogio.motivo }}<template v-if="avisoRelogio.piorEnviado">
          — a pior marcava <strong>{{ quando(avisoRelogio.piorEnviado) }}</strong></template>.
        As entradas foram registradas com a <strong>hora do servidor</strong>; ninguém ficou de
        fora da contagem. Acerte a data e a hora desse aparelho antes do próximo apagão.
      </p>
    </div>

    <p v-if="ultimoEnvio" class="mt-3 text-sm text-tinta-suave">
      Último envio: {{ ultimoEnvio.aplicadas }} registrada(s),
      {{ ultimoEnvio.repetidas }} repetida(s),
      <span :class="ultimoEnvio.conflitos ? 'font-bold text-alerta' : ''">
        {{ ultimoEnvio.conflitos }} em conflito</span>,
      <span :class="ultimoEnvio.recusadas ? 'font-bold text-erro' : ''">
        {{ ultimoEnvio.recusadas }} recusada(s)</span>.
    </p>

    <!-- Os três primeiros cards saem do MESMO objeto (`publico`), que sai de
         uma consulta só. Antes um contava o livro de passagens e os outros
         dois o carimbo do ingresso, e a tela exibia "2 dentro" ao lado de
         "0 entraram" e "0%". "—" nos três quando ainda não houve conversa com
         o servidor: não saber é honesto, discordar não. O quarto card é outra
         pergunta — ele conta LEITURA, não pessoa, e por isso vem do log do
         leitor mesmo. -->
    <div class="mt-4 grid gap-3 sm:grid-cols-4">
      <div class="card">
        <p class="rotulo-kpi">Pessoas dentro</p>
        <p class="numero-kpi mt-1">{{ publico ? publico.pessoas : '—' }}</p>
        <p v-if="publico" class="mt-1 text-xs text-tinta-fraca">
          em {{ publico.entradas }} passagem(ns)
          <template v-if="publico.offline"> · {{ publico.offline }} sem rede</template>
        </p>
      </div>
      <div class="card">
        <p class="rotulo-kpi">Já entraram</p>
        <p class="numero-kpi mt-1">{{ publico ? publico.ingressos : '—' }}</p>
        <p v-if="publico" class="mt-1 text-xs text-tinta-fraca">
          de {{ publico.aptos }} ingressos aptos
        </p>
      </div>
      <div class="card">
        <p class="rotulo-kpi">Comparecimento</p>
        <p class="numero-kpi mt-1">{{ publico ? `${pct(publico.comparecimentoPct)}%` : '—' }}</p>
        <p class="mt-1 text-xs text-tinta-fraca">ingressos que passaram na porta</p>
      </div>
      <div v-if="data" class="card">
        <p class="rotulo-kpi">Recusadas</p>
        <p class="numero-kpi mt-1" :class="data.resumo.recusadas ? 'text-erro' : ''">
          {{ data.resumo.recusadas }}
        </p>
        <p class="mt-1 text-xs text-tinta-fraca">{{ data.resumo.leituras }} leituras no total</p>
      </div>
      <!-- O log do leitor é rota de /admin e o papel `portaria` leva 403 nela
           — medido: quem opera este leitor NUNCA vê o card de recusadas. Em
           vez de um "—" com desculpa, o quarto card passa a mostrar o número
           que a portaria tem direito de ver e de fato precisa: quantas
           passagens foram decididas sem rede e ainda vão ser conferidas. -->
      <div v-else class="card">
        <p class="rotulo-kpi">Passagens sem rede</p>
        <p class="numero-kpi mt-1">{{ publico ? publico.offline : '—' }}</p>
        <p class="mt-1 text-xs text-tinta-fraca">
          validadas pela lista do aparelho e conferidas depois
        </p>
      </div>
    </div>

    <div class="card mt-4">
      <form class="flex flex-wrap items-end gap-3" @submit.prevent="ler">
        <div class="min-w-[280px] flex-1">
          <label for="cod" class="rotulo">Código do ingresso</label>
          <input id="cod" ref="campo" v-model="codigo" autocomplete="off"
                 class="campo font-mono text-lg tracking-wider"
                 placeholder="CON-XXXX-XXXX ou leitura do QR">
        </div>
        <div class="w-40">
          <label for="gate" class="rotulo">Portão</label>
          <input id="gate" v-model="gate" class="campo" placeholder="Norte, VIP…">
        </div>
        <button type="submit" class="btn-primario h-[42px] px-8" :disabled="lendo || !codigo.trim()">
          {{ lendo ? 'Lendo…' : 'Ler' }}
        </button>
      </form>
      <label class="mt-3 flex items-center gap-2 text-sm text-tinta-suave">
        <input v-model="apenasConsultar" type="checkbox" class="h-4 w-4 accent-acao">
        Só conferir (não marca entrada)
      </label>
    </div>

    <div v-if="ultima" class="mt-4 rounded-card px-6 py-8 text-center entra-resposta"
         :class="CLASSE[ultima.resultado] ?? 'bg-erro text-white'">
      <p class="titulo text-4xl font-bold">
        {{ ultima.consulta ? 'VÁLIDO' : ultima.ok ? 'PODE ENTRAR' : 'BARRADO' }}
      </p>
      <p class="mt-2 text-lg opacity-95">{{ ultima.mensagem }}</p>
      <p v-if="ultima.ingresso" class="mt-3 text-lg">
        <strong>{{ ultima.ingresso.titular || 'sem nome' }}</strong>
        · {{ ultima.ingresso.setor }} · {{ ultima.ingresso.lote }}
        <template v-if="ultima.ingresso.tipo"> · {{ ultima.ingresso.tipo }}</template>
      </p>
      <p v-else-if="ultima.titular" class="mt-3 text-lg"><strong>{{ ultima.titular }}</strong></p>
      <p v-if="ultima.pessoas && ultima.pessoas > 1" class="mt-1 text-lg">
        {{ ultima.pessoas }} pessoas nesta entrada
      </p>

      <!-- MEIA-ENTRADA: o pedido de documento, do tamanho de quem lê de
           relance com fila na frente. Fundo branco dentro da faixa colorida
           porque é o que o operador tem que PARAR e ler — o resto do card ele
           só olha a cor. Sem isto a tela dizia "Meia-entrada" no nome do tipo
           e o operador ficava adivinhando qual papel pedir (migração 015). -->
      <div v-if="ultima.ingresso?.meia"
           class="mx-auto mt-4 max-w-xl rounded-card bg-white p-4 text-left text-tinta-corpo">
        <p class="titulo text-2xl font-bold text-tinta">
          MEIA-ENTRADA · {{ ultima.ingresso.meia.rotulo }}
        </p>
        <p class="rotulo mt-3">Peça este documento</p>
        <p class="text-lg font-bold text-tinta">{{ ultima.ingresso.meia.documento }}</p>
        <template v-if="ultima.ingresso.meia.numero">
          <p class="rotulo mt-3">Número declarado na compra — confira se bate</p>
          <p class="font-mono text-xl font-bold tracking-wide text-tinta">
            {{ ultima.ingresso.meia.numero }}
          </p>
        </template>
      </div>
      <!-- A recusa útil: além de "já entrou", QUANDO e ONDE. Sem isso a fila
           para com o cliente jurando que não entrou. -->
      <p v-if="ultima.entrouEm" class="mt-1 opacity-90">
        entrou em {{ new Date(ultima.entrouEm).toLocaleString('pt-BR') }}
        <template v-if="ultima.portao"> pelo portão {{ ultima.portao }}</template>
        <template v-if="ultima.operadorEntrada"> · liberado por {{ ultima.operadorEntrada }}</template>
      </p>
      <p v-if="ultima.local" class="mt-2 text-sm opacity-90">
        decidido no aparelho, sem rede — será conferido na sincronização
      </p>
    </div>

    <div v-if="conflitos.length" class="card mt-4 border-alerta">
      <p class="rotulo-kpi text-alerta">
        {{ conflitos.length }} ingresso(s) entraram mais de uma vez
      </p>
      <ul class="mt-2 space-y-1 text-sm">
        <li v-for="c in conflitos.slice(0, 5)" :key="c.ticketId" class="text-tinta-suave">
          <span class="font-mono text-tinta">{{ c.codigo }}</span>
          — {{ c.passagens }} passagens em {{ c.dispositivos }} aparelho(s)
          <span v-if="c.titular"> · {{ c.titular }}</span>
        </li>
      </ul>
      <NuxtLink :to="`/admin/evento/${id}/validacao/historico`"
                class="mt-2 inline-block text-sm font-bold text-acao">
        Ver todos no histórico
      </NuxtLink>
    </div>

    <div v-if="historico.length" class="card mt-4 p-0">
      <p class="titulo border-b border-linha px-4 py-3 text-sm font-bold text-tinta-rotulo">
        Últimas leituras nesta tela
      </p>
      <ul>
        <li v-for="(h, i) in historico" :key="i"
            class="flex items-center gap-3 border-b border-linha px-4 py-2 text-sm last:border-0">
          <span class="w-2.5 h-2.5 shrink-0 rounded-full"
                :class="h.ok ? 'bg-ok' : 'bg-erro'" />
          <span class="font-mono text-xs text-tinta-suave">{{ h.codigo }}</span>
          <span class="flex-1 text-tinta">{{ h.mensagem }}</span>
          <span v-if="h.local" class="selo-alerta">sem rede</span>
          <span class="text-xs text-tinta-fraca tabular-nums">
            {{ h.quando.toLocaleTimeString('pt-BR') }}
          </span>
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
/* Sem <Transition>: com a aba em segundo plano o Vue deixa a entrada parada
   em opacidade 0 (o rAF congela) e a resposta some da tela. Animação de
   montagem em CSS puro roda de qualquer jeito. */
@keyframes entra-resposta-kf {
  from { transform: scale(.97); opacity: 0 }
  to   { transform: none;       opacity: 1 }
}
.entra-resposta { animation: entra-resposta-kf .14s ease-out both }
</style>
