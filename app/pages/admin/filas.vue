<script setup lang="ts">
/**
 * Filas — "o que o comprador pagou e ainda não recebeu".
 *
 * A rota de diagnóstico (`/api/admin/filas`) existia há duas rodadas e nunca
 * teve tela: a única forma de ler a saúde das duas filas de fundo era um
 * `curl` com a sessão na mão. Quem abre o painel às 21h com fila no portão não
 * faz isso, então na prática a resposta continuava sendo o telefone tocando.
 *
 * Três decisões desta tela:
 *
 * - **O número que manda é o de GENTE, não o de linha de tabela.** "3 itens na
 *   fila" é o tamanho do trabalho; `perdidos` é quanta gente pagou e não vai
 *   receber nada até alguém mandar de novo. É o único número aqui que aparece
 *   em vermelho e em corpo de KPI, porque é o único que custa cliente.
 *
 * - **A frase do servidor é a frase da tela.** O veredito vem pronto de
 *   `vereditoDaFila()` (`server/utils/envio.ts`); esta tela não recalcula
 *   "está parado?" por conta própria. Tela que repete a decisão do servidor é
 *   tela que um dia diverge dele — e aí duas telas do mesmo sistema discordam
 *   sobre se o cliente recebeu.
 *
 * - **A tela diz o que NÃO consegue fazer.** A fila de estorno tem botão de
 *   empurrão porque existe rota pra isso (`POST /api/admin/financeiro/
 *   estornos`, que já nasceu com `limite` justamente pra isso). A de e-mail
 *   não tem — o reenvio de e-mail é por pedido, na tela de vendas do evento.
 *   Desenhar um botão que não funciona é pior do que não ter botão: ele
 *   ensina o operador a achar que já tentou.
 *
 * Quem entra: a rota está em `SO_DO_MASTER` (`server/utils/papeis.ts`), e a
 * página sem classificação segue a MESMA régua — só o master. Não há lista de
 * permissão duplicada aqui de propósito.
 */
definePageMeta({ layout: 'admin' })

const { data, pending, error: falha, refresh } = await useFetch<any>('/api/admin/filas')

const motivoDaFalha = computed(() =>
  (falha.value as any)?.data?.statusMessage
  ?? (falha.value as any)?.statusMessage
  ?? 'Não consegui ler o estado das filas.')

/**
 * A tela se atualiza sozinha.
 *
 * Painel de saúde que só mostra a foto do instante em que alguém abriu é
 * painel que mente em silêncio: a pessoa deixa a aba aberta no telão da
 * bilheteria e o número congela. O intervalo é o mesmo da varredura da fila de
 * e-mail (15 s) — atualizar mais rápido do que o trabalhador trabalha só
 * gastaria banco sem trocar de resposta.
 *
 * Só no navegador (`onMounted`): no servidor não existe relógio de tela, e um
 * `setInterval` na renderização ficaria rodando sem ninguém pra ver.
 */
const AUTO_MS = 15_000
const atualizadoEm = ref<Date | null>(null)
let relogio: ReturnType<typeof setInterval> | null = null

async function atualizar() {
  await refresh()
  atualizadoEm.value = new Date()
}

onMounted(() => {
  atualizadoEm.value = new Date()
  relogio = setInterval(() => {
    // Aba escondida não precisa de dado fresco, e o navegador estrangula o
    // relógio dela de qualquer jeito: sem esta guarda, voltar pra aba depois
    // de uma hora dispara uma rajada de chamadas de uma vez.
    if (document.visibilityState === 'visible') void atualizar()
  }, AUTO_MS)
})
onBeforeUnmount(() => { if (relogio) clearInterval(relogio) })

/* ------------------------------------------------------- o empurrão na fila */

/**
 * Quais filas têm como ser empurradas daqui, e por qual porta.
 *
 * `POST /api/admin/financeiro/estornos` com `limite` é a rota que já existe
 * pra isso — ela recorta a fila pela organização da sessão, respeita a mesma
 * reserva atômica do trabalhador de fundo e não alcança o que está em
 * 'falhou' (linha em erro permanente é por id, com gente olhando, senão vira
 * laço contra o gateway).
 *
 * A fila de e-mail não aparece aqui porque não existe rota de empurrão pra
 * ela: o reenvio é por pedido (`POST /api/admin/evento/:id/reenviar`), na tela
 * de vendas do evento.
 */
const EMPURRAO: Record<string, { rota: string; rotulo: string }> = {
  estorno: { rota: '/api/admin/financeiro/estornos', rotulo: 'Empurrar a fila agora' },
}

const empurrando = ref('')
const aviso = ref('')
const erroDoEmpurrao = ref('')

async function empurrar(nome: string) {
  const porta = EMPURRAO[nome]
  if (!porta || empurrando.value) return
  empurrando.value = nome
  aviso.value = ''
  erroDoEmpurrao.value = ''
  try {
    const r = await $fetch<any>(porta.rota, { method: 'POST', body: { limite: 20 } })
    aviso.value = r?.aviso ?? 'Fila varrida.'
    await atualizar()
  } catch (e: any) {
    erroDoEmpurrao.value = e?.data?.statusMessage
      || 'Não consegui varrer a fila agora. Tente de novo; se repetir, olhe o último erro abaixo.'
  } finally {
    empurrando.value = ''
  }
}

/* ------------------------------------------------------------ como cada coisa lê */

/**
 * Dinheiro e hora saem do formatador único (`app/composables/formato.ts`).
 * Cópia local de `R$` é como as outras telas ganharam o espaço fino (U+00A0) e
 * a divisão em float; cópia local de data é como elas ganharam o dia errado
 * às 21h.
 */
const quando = (d: string | Date | null) => dataHora(d)

/** "3 min", "2h 10 min" — o mesmo vocabulário do servidor, pra tempo que ele não mandou pronto. */
function tempo(segundos: number | null | undefined): string {
  if (segundos === null || segundos === undefined) return '—'
  const s = Math.max(0, Math.round(segundos))
  if (s < 90) return `${s}s`
  const min = Math.round(s / 60)
  if (min < 90) return `${min} min`
  const h = Math.floor(min / 60)
  return `${h}h${min % 60 ? ` ${min % 60} min` : ''}`
}

/** Gente que pagou e não recebeu, somando as duas filas — o número do dia. */
const pessoasSemReceber = computed(() =>
  (data.value?.filas ?? []).reduce((s: number, f: any) => s + Number(f.perdidos ?? 0), 0))

useHead({ title: 'Filas' })
</script>

<template>
  <div>
    <div class="flex flex-wrap items-start justify-between gap-3 py-5">
      <div>
        <h1 class="titulo text-2xl font-bold text-tinta">Filas</h1>
        <p class="mt-1 text-tinta-suave">
          O ingresso que o comprador pagou saiu? E o dinheiro que a gente mandou devolver,
          voltou? Esta tela responde antes de o telefone tocar.
        </p>
      </div>
      <div class="flex items-center gap-3">
        <span v-if="atualizadoEm" class="text-xs text-tinta-fraca">
          atualizado {{ quando(atualizadoEm) }} · sozinha a cada {{ AUTO_MS / 1000 }}s
        </span>
        <!-- Sem ícone de propósito: `IconeMenu` não tem desenho de "atualizar",
             e nome que não está no catálogo dele não estoura nada — renderiza
             um <path d=""> invisível, que é o mesmo bug calado da classe de
             CSS que não existe. -->
        <button type="button" class="btn-secundario" :disabled="pending" @click="atualizar">
          Atualizar
        </button>
      </div>
    </div>

    <div v-if="falha" class="faixa-erro">
      {{ motivoDaFalha }}
      <button type="button" class="underline" @click="atualizar">Tentar de novo</button>
    </div>

    <template v-if="data">
      <!-- O alarme em uma linha, antes de qualquer número.
           `ok` é o que um alarme externo lê, e ele é falso quando tem GENTE
           sem receber o que pagou — não quando tem aviso na tela. -->
      <div v-if="!data.ok" class="faixa-erro">
        <span class="block font-bold">
          Tem fila parada neste servidor.
        </span>
        <span v-if="pessoasSemReceber" class="mt-1 block">
          {{ pessoasSemReceber }} pedido(s) pararam de vez: quem pagou continua sem, e
          ninguém tenta de novo sozinho.
        </span>
        <span v-else class="mt-1 block">
          Nada parou de vez ainda — leia o diagnóstico de cada fila abaixo antes que pare.
        </span>
      </div>
      <div v-else class="faixa-aviso">
        As duas filas estão andando e não há ninguém esperando o que pagou.
      </div>

      <div v-if="aviso" class="faixa-aviso mt-3">{{ aviso }}</div>
      <div v-if="erroDoEmpurrao" class="faixa-erro mt-3">{{ erroDoEmpurrao }}</div>

      <div class="mt-4 grid gap-4 lg:grid-cols-2">
        <section v-for="f in data.filas" :key="f.nome" class="card">
          <div class="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h2 class="titulo text-lg font-bold text-tinta">{{ f.rotulo }}</h2>
              <p class="mt-0.5 text-xs text-tinta-fraca">fila “{{ f.nome }}”</p>
            </div>
            <span :class="f.parado ? 'selo-erro' : 'selo-ok'">
              {{ f.parado ? 'Parado' : 'Andando' }}
            </span>
          </div>

          <!-- a frase é do servidor; a tela não decide de novo -->
          <p class="mt-3 text-sm" :class="f.parado ? 'text-erro' : 'text-tinta-corpo'">
            {{ f.diagnostico }}
          </p>

          <!-- o custo em GENTE. Duas tentativas do mesmo comprador são duas
               linhas de fila e uma pessoa só do outro lado do balcão. -->
          <p v-if="f.custo" class="mt-2 text-sm font-bold text-erro">{{ f.custo }}</p>

          <dl class="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div>
              <dt class="rotulo-kpi">Esperando</dt>
              <dd class="numero-kpi mt-1">{{ f.naFila.toLocaleString('pt-BR') }}</dd>
              <dd class="mt-0.5 text-xs text-tinta-fraca">
                <template v-if="f.maduros">
                  {{ f.maduros }} já podia(m) ter saído
                  <template v-if="f.esperaDoMaisVelhoTexto">
                    · mais velho há {{ f.esperaDoMaisVelhoTexto }}
                  </template>
                </template>
                <template v-else>nada na vez de sair</template>
              </dd>
            </div>
            <div>
              <dt class="rotulo-kpi">Em andamento</dt>
              <dd class="numero-kpi mt-1">{{ f.emAndamento.toLocaleString('pt-BR') }}</dd>
              <dd class="mt-0.5 text-xs text-tinta-fraca">saindo agora</dd>
            </div>
            <!-- ESTE é o número que custa cliente: teto de tentativas
                 estourado, ninguém tenta de novo sozinho. Ele fica em
                 vermelho mesmo quando é zero? Não — zero aqui é notícia boa e
                 vermelho permanente é como se ensina alguém a ignorar a cor. -->
            <div>
              <dt class="rotulo-kpi" :class="f.perdidos ? 'text-erro' : ''">Pararam de vez</dt>
              <dd class="numero-kpi mt-1" :class="f.perdidos ? 'text-erro' : ''">
                {{ f.perdidos.toLocaleString('pt-BR') }}
              </dd>
              <dd class="mt-0.5 text-xs" :class="f.perdidos ? 'text-erro' : 'text-tinta-fraca'">
                {{ f.perdidos
                  ? 'pagaram e não receberam — só sai se alguém mandar'
                  : 'ninguém ficou pra trás' }}
              </dd>
            </div>
            <div>
              <dt class="rotulo-kpi">Saíram em 24 h</dt>
              <dd class="numero-kpi mt-1">{{ f.feitas24h.toLocaleString('pt-BR') }}</dd>
              <dd class="mt-0.5 text-xs text-tinta-fraca">
                {{ f.falharam }} tentativa(s) com falha
              </dd>
            </div>
          </dl>

          <!-- Dinheiro só aparece na fila que move dinheiro. Os dois números
               são separados de propósito: o preso ainda anda sozinho, o
               perdido não anda mais. Somar os dois contaria o mesmo estorno
               duas vezes e a conta pararia de bater com a do financeiro. -->
          <dl v-if="f.presoCents || f.perdidoCents"
              class="mt-3 flex flex-wrap gap-x-6 gap-y-2 border-t border-linha pt-3">
            <div v-if="f.presoCents">
              <dt class="rotulo">Preso na fila</dt>
              <dd class="tabular-nums text-tinta">{{ reais(f.presoCents) }}</dd>
            </div>
            <div v-if="f.perdidoCents">
              <dt class="rotulo text-erro">Não voltou pro cliente</dt>
              <dd class="tabular-nums font-bold text-erro">{{ reais(f.perdidoCents) }}</dd>
            </div>
          </dl>

          <p v-if="f.ultimoErro" class="mt-3 text-xs text-tinta-suave">
            <span class="font-bold">Último erro:</span> {{ f.ultimoErro }}
          </p>

          <!-- ================================================ o trabalhador -->
          <div class="mt-4 border-t border-linha pt-3">
            <div class="flex flex-wrap items-baseline justify-between gap-2">
              <span class="rotulo mb-0">Quem varre esta fila</span>
              <span v-if="!f.trabalhador" class="selo-erro">nunca subiu aqui</span>
              <span v-else-if="f.trabalhador.estado === 'desligado'" class="selo-alerta">
                desligado neste servidor
              </span>
            </div>

            <p v-if="!f.trabalhador" class="mt-1 text-sm text-erro">
              Nenhum processo carimbou esta fila neste servidor. Nada sai dela até um subir.
            </p>

            <dl v-else class="mt-2 grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3">
              <!-- Com UMA instância isto é `host:pid`. Com mais de uma, a
                   leitura (visão `worker_heartbeats`, migração 026) nomeia a
                   que está calada há mais tempo e diz quantas são — é por aqui
                   que a frota chega na tela sem esta página inventar consulta
                   própria ao banco. -->
              <div class="col-span-2 sm:col-span-3">
                <dt class="rotulo mb-0">Instância</dt>
                <dd class="break-all text-sm text-tinta-corpo">{{ f.trabalhador.instancia }}</dd>
              </div>
              <div>
                <dt class="rotulo mb-0">Sem carimbar há</dt>
                <!-- O destaque é do NÚMERO de silêncio, não da célula.
                     Medido na tela com a fila de estorno parada por dinheiro
                     que não voltou: a célula ganhava `font-bold` e o texto
                     "não carimba varredura" saía em negrito — cinza, mas
                     gritando, numa linha cujo recado é "aqui não tem nada pra
                     ver". Negrito em quem não prometeu falar é o mesmo alarme
                     falso da 026, só que desenhado. -->
                <dd class="tabular-nums text-sm"
                    :class="f.parado && f.trabalhador.carimbaVarredura
                      ? 'font-bold text-erro' : 'text-tinta-corpo'">
                  <!-- Fila que só registra o boot não carimba varredura: o
                       "bateu há" dela seria a idade do processo, e desenhar
                       esse número como batimento é acusar de silêncio quem
                       nunca prometeu falar. -->
                  <template v-if="f.trabalhador.carimbaVarredura">
                    {{ f.trabalhador.bateuHaTexto ?? '—' }}
                    <span v-if="f.trabalhador.varreDeSegundos" class="text-tinta-fraca">
                      (varre de {{ f.trabalhador.varreDeSegundos }}s)
                    </span>
                  </template>
                  <span v-else class="text-tinta-fraca">não carimba varredura</span>
                </dd>
              </div>
              <div>
                <dt class="rotulo mb-0">Subiu em</dt>
                <dd class="tabular-nums text-sm text-tinta-corpo">
                  {{ quando(f.trabalhador.subiuEm) }}
                </dd>
              </div>
              <div>
                <dt class="rotulo mb-0">Achou trabalho há</dt>
                <dd class="tabular-nums text-sm text-tinta-corpo">
                  {{ tempo(f.trabalhador.trabalhouHaSegundos) }}
                </dd>
              </div>
              <div class="col-span-2 sm:col-span-3">
                <dt class="rotulo mb-0">Desde que subiu</dt>
                <dd class="text-sm text-tinta-corpo">
                  {{ f.trabalhador.feitosDesdeOBoot.toLocaleString('pt-BR') }} entregue(s),
                  {{ f.trabalhador.falhosDesdeOBoot.toLocaleString('pt-BR') }} com falha
                  <template v-if="f.trabalhador.ultimoErro">
                    · {{ f.trabalhador.ultimoErro }}
                  </template>
                </dd>
              </div>
            </dl>
          </div>

          <!-- Instância que não existe mais (contêiner trocado numa queda
               seca, máquina desligada) fica na frota acusando: a saída limpa
               tira o processo sozinho, a queda seca NÃO — e é de propósito,
               senão morrer de vez seria a forma mais fácil de sumir do painel.
               Quem decide que aquela máquina não volta é gente, e a linha sai
               por um comando, não por esquecimento do banco. -->
          <p v-if="f.parado && f.trabalhador?.carimbaVarredura"
             class="mt-2 text-xs text-tinta-fraca">
            Se a instância acima não existe mais, tire a linha dela do painel:
            <code>DELETE FROM worker_heartbeat_instances WHERE instance = '…'</code>
          </p>

          <div class="mt-4 flex flex-wrap items-center gap-3">
            <button v-if="EMPURRAO[f.nome]" type="button" class="btn-secundario"
                    :disabled="!!empurrando" @click="empurrar(f.nome)">
              {{ empurrando === f.nome ? 'Varrendo…' : EMPURRAO[f.nome].rotulo }}
            </button>
            <p v-else class="text-xs text-tinta-fraca">
              Esta fila não tem empurrão de tela: o reenvio de e-mail é por pedido, em
              Vendas do evento → “mandar de novo”.
            </p>
          </div>
        </section>
      </div>
    </template>

    <p v-else-if="pending" class="card mt-4 py-12 text-center text-tinta-suave">Carregando…</p>
  </div>
</template>
