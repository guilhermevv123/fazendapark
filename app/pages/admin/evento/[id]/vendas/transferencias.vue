<script setup lang="ts">
/**
 * Ingressos transferidos.
 *
 * A tela existe pra responder a pergunta do balcão: "esse ingresso é dessa
 * pessoa mesmo?". Por isso a busca aceita e-mail, código do ingresso e código
 * do pedido — quem pergunta tem um desses três na mão, nunca os outros dois.
 */
definePageMeta({ layout: 'admin' })

const route = useRoute()
const id = route.params.id as string

const busca = ref('')
const filtro = ref('')
const { data, refresh, pending, error: falha } = await useFetch<any>(
  () => `/api/admin/evento/${id}/transferencias`,
  { query: { busca, status: filtro } })

const erro = ref('')
const aviso = ref('')
/**
 * Erro do cancelamento aparece NO painel de confirmação. No alto da página
 * ele ficava atrás do fundo do painel: "Cancelar transferência" parecia não
 * fazer nada, e o atendente clicava de novo com o cliente no telefone.
 */
const erroCancelamento = ref('')
const salvando = ref(false)

const aberta = ref<any>(null)
const cancelando = ref<any>(null)
const enviando = ref(false)
const novo = reactive({ codigo: '', paraNome: '', paraEmail: '', paraTelefone: '', paraDocumento: '' })
const ultimoLink = ref('')

// `reais` e `dataHora` vêm de `app/composables/formato.ts` — centavo e dia
// formatados num lugar só, no fuso de quem está lendo.
const quando = dataHora

const COR: Record<string, string> = {
  aguardando: 'selo-alerta',
  concluido: 'selo-ok',
  cancelado: 'selo-neutro',
  expirado: 'selo-neutro',
}

async function permitir(v: boolean) {
  salvando.value = true; erro.value = ''
  try {
    await $fetch(`/api/admin/evento/${id}/transferencias`, { method: 'PATCH', body: { permitir: v } })
    await refresh()
    aviso.value = v
      ? 'Transferência liberada — os participantes já podem passar ingresso adiante.'
      : 'Transferência desligada. As que já estão aguardando seguem valendo até vencer.'
  } catch (e: any) { erro.value = e?.data?.message ?? e?.statusMessage ?? 'Não deu pra salvar.' }
  finally { salvando.value = false }
}

async function enviar() {
  enviando.value = true; erro.value = ''; ultimoLink.value = ''
  try {
    const r: any = await $fetch(`/api/admin/evento/${id}/transferencias`, {
      method: 'POST',
      body: {
        codigo: novo.codigo.trim(),
        paraNome: novo.paraNome.trim(),
        paraEmail: novo.paraEmail.trim(),
        paraTelefone: novo.paraTelefone.trim() || null,
        paraDocumento: novo.paraDocumento.trim() || null,
      },
    })
    ultimoLink.value = r.transferencia.link
    aviso.value = `Transferência criada. Mande o link para ${novo.paraNome}.`
    Object.assign(novo, { codigo: '', paraNome: '', paraEmail: '', paraTelefone: '', paraDocumento: '' })
    await refresh()
  } catch (e: any) { erro.value = e?.data?.message ?? e?.statusMessage ?? 'Não deu pra enviar.' }
  finally { enviando.value = false }
}

async function confirmarCancelamento() {
  const alvo = cancelando.value
  salvando.value = true; erroCancelamento.value = ''
  try {
    const r: any = await $fetch(`/api/admin/evento/${id}/transferencias`, {
      method: 'PATCH', body: { transferenciaId: alvo.id, acao: 'cancelar' },
    })
    aviso.value = r.devolvido
      ? `Cancelada. O ingresso voltou para ${r.titular}.`
      : 'Cancelada. O ingresso continua com quem já era o titular.'
    cancelando.value = null
    aberta.value = null
    await refresh()
  } catch (e: any) {
    erroCancelamento.value = e?.data?.message ?? e?.statusMessage ?? 'Não deu pra cancelar.'
  }
  finally { salvando.value = false }
}

const FILTROS = [
  { v: '', nome: 'Todas' },
  { v: 'aguardando', nome: 'Aguardando' },
  { v: 'concluido', nome: 'Concluídas' },
  { v: 'cancelado', nome: 'Canceladas' },
  { v: 'expirado', nome: 'Expiradas' },
]

function copiar(link: string) {
  const url = `${window.location.origin}${link}`
  navigator.clipboard?.writeText(url)
  aviso.value = 'Link copiado.'
}
</script>

<template>
  <div v-if="data">
    <div class="flex flex-wrap items-start justify-between gap-3 py-5">
      <div>
        <h1 class="titulo text-2xl font-semibold text-tinta">Ingressos transferidos</h1>
        <p class="mt-1 text-tinta-suave">
          Quem passou o ingresso pra quem, e em que pé está cada troca.
        </p>
      </div>
    </div>

    <AbasSecao :evento-id="id" />

    <p v-if="erro" class="faixa-erro mt-4">
      {{ erro }}
    </p>
    <p v-else-if="aviso" class="faixa-aviso mt-4">
      {{ aviso }}
      <button v-if="ultimoLink" type="button" class="ml-2 font-semibold text-acao underline"
              @click="copiar(ultimoLink)">copiar link</button>
    </p>

    <!-- a chave geral -->
    <section class="card mt-5 flex flex-wrap items-center justify-between gap-4">
      <div>
        <h2 class="rotulo-kpi">Permitir transferência de ingressos</h2>
        <p class="mt-1 text-sm text-tinta-suave">
          Ligue para que os participantes possam passar o ingresso pra outra pessoa.
          Desligar não desfaz o que já foi transferido.
        </p>
      </div>
      <button type="button" :disabled="salvando"
              class="relative h-7 w-12 shrink-0 rounded-full transition-colors disabled:opacity-60"
              :class="data.evento.permite ? 'bg-acao' : 'bg-linha-forte'"
              :aria-pressed="data.evento.permite"
              @click="permitir(!data.evento.permite)">
        <span class="absolute top-1 h-5 w-5 rounded-full bg-white transition-all"
              :class="data.evento.permite ? 'left-6' : 'left-1'" />
      </button>
    </section>

    <!-- enviar uma na mão, do balcão -->
    <section v-if="data.evento.permite" class="card mt-4">
      <h2 class="rotulo-kpi">Transferir pelo balcão</h2>
      <p class="mt-1 text-xs text-tinta-fraca">
        Para quando a pessoa liga ou aparece na bilheteria. Gera o mesmo link de aceite.
      </p>
      <form class="mt-4 grid gap-3 md:grid-cols-5" @submit.prevent="enviar">
        <input v-model="novo.codigo" class="campo md:col-span-1" placeholder="Código do ingresso" required>
        <input v-model="novo.paraNome" class="campo md:col-span-1" placeholder="Nome de quem recebe" required>
        <input v-model="novo.paraEmail" type="email" class="campo md:col-span-1" placeholder="E-mail" required>
        <input v-model="novo.paraTelefone" class="campo md:col-span-1" placeholder="Telefone (opcional)">
        <button class="btn-primario md:col-span-1" :disabled="enviando">
          {{ enviando ? 'Enviando…' : 'Gerar transferência' }}
        </button>
      </form>
    </section>

    <!-- resumo -->
    <div class="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <div class="card">
        <p class="rotulo-kpi">Aguardando aceite</p>
        <p class="numero-kpi mt-1">{{ data.resumo.aguardando }}</p>
      </div>
      <div class="card">
        <p class="rotulo-kpi">Concluídas</p>
        <p class="numero-kpi mt-1">{{ data.resumo.concluido }}</p>
      </div>
      <div class="card">
        <p class="rotulo-kpi">Canceladas</p>
        <p class="numero-kpi mt-1">{{ data.resumo.cancelado }}</p>
      </div>
      <div class="card">
        <p class="rotulo-kpi">Vencidas sem aceite</p>
        <p class="numero-kpi mt-1">{{ data.resumo.expirado }}</p>
      </div>
    </div>

    <!-- lista -->
    <section class="card mt-4 overflow-hidden p-0">
      <header class="flex flex-wrap items-center gap-3 border-b border-linha p-4">
        <input v-model="busca" class="campo max-w-sm flex-1"
               placeholder="Busque por e-mail, nome, código do pedido ou do ingresso">
        <div class="flex flex-wrap gap-2">
          <button v-for="f in FILTROS" :key="f.v" type="button"
                  :class="filtro === f.v ? 'chip-ativo' : 'chip'" @click="filtro = f.v">
            {{ f.nome }}
          </button>
        </div>
      </header>

      <p v-if="!data.transferencias.length" class="p-6 text-center text-tinta-suave">
        {{ busca || filtro ? 'Nada com esse filtro.' : 'Nenhum ingresso foi transferido ainda.' }}
      </p>

      <div v-else class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="bg-fundo-cinza text-left text-xs uppercase text-tinta-suave">
            <tr>
              <th class="px-4 py-2 font-semibold">Cód. ingresso</th>
              <th class="px-4 py-2 font-semibold">Enviado por</th>
              <th class="px-4 py-2 font-semibold">Recebido por</th>
              <th class="px-4 py-2 font-semibold">Tipo</th>
              <th class="px-4 py-2 font-semibold">Quando</th>
              <th class="px-4 py-2 font-semibold">Status</th>
              <th class="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            <tr v-for="t in data.transferencias" :key="t.id" class="border-t border-linha">
              <td class="px-4 py-2.5 font-mono text-xs text-tinta-corpo">{{ t.ingresso.codigo }}</td>
              <td class="px-4 py-2.5">
                <p class="text-tinta-corpo">{{ t.de.nome ?? '—' }}</p>
                <p class="text-xs text-tinta-fraca">{{ t.de.email ?? 'sem e-mail no ingresso' }}</p>
              </td>
              <td class="px-4 py-2.5">
                <p class="text-tinta-corpo">{{ t.para.nome }}</p>
                <p class="text-xs text-tinta-fraca">{{ t.para.email }}</p>
              </td>
              <td class="px-4 py-2.5 text-tinta-suave">
                {{ t.ingresso.setor }}<span v-if="t.ingresso.assento"> · {{ t.ingresso.assento }}</span>
              </td>
              <td class="px-4 py-2.5 text-tinta-suave">
                {{ quando(t.aceitaEm ?? t.canceladaEm ?? t.criadaEm) }}
              </td>
              <td class="px-4 py-2.5">
                <span :class="COR[t.status]">{{ t.statusTexto }}</span>
              </td>
              <td class="px-4 py-2.5 text-right">
                <button type="button" class="text-sm font-semibold text-acao hover:underline"
                        @click="aberta = t">Detalhes</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- detalhes -->
    <ModalLateral v-if="aberta" titulo="Detalhes da transferência" @fechar="aberta = null">
      <div class="grid gap-3 sm:grid-cols-2">
        <div class="rounded-sm border border-linha p-3">
          <p class="rotulo-kpi">Setor</p>
          <p class="mt-1 text-tinta-corpo">{{ aberta.ingresso.setor }}</p>
        </div>
        <div class="rounded-sm border border-linha p-3">
          <p class="rotulo-kpi">Cadeira</p>
          <p class="mt-1 text-tinta-corpo">{{ aberta.ingresso.assento ?? 'não numerado' }}</p>
        </div>
        <div class="rounded-sm border border-linha p-3">
          <p class="rotulo-kpi">Sessão</p>
          <p class="mt-1 text-tinta-corpo">{{ aberta.ingresso.sessao ?? '—' }}</p>
        </div>
        <div class="rounded-sm border border-linha p-3">
          <p class="rotulo-kpi">Preço</p>
          <p class="mt-1 text-tinta-corpo">{{ reais(aberta.ingresso.precoCents) }}</p>
        </div>
      </div>

      <dl class="mt-5 space-y-3 text-sm">
        <div class="flex justify-between gap-4">
          <dt class="text-tinta-suave">Enviado por</dt>
          <dd class="text-right text-tinta-corpo">
            {{ aberta.de.nome ?? '—' }}<br>
            <span class="text-xs text-tinta-fraca">{{ aberta.de.email ?? '—' }}</span>
          </dd>
        </div>
        <div class="flex justify-between gap-4">
          <dt class="text-tinta-suave">Recebido por</dt>
          <dd class="text-right text-tinta-corpo">
            {{ aberta.para.nome }}<br>
            <span class="text-xs text-tinta-fraca">{{ aberta.para.email }}</span>
          </dd>
        </div>
        <div class="flex justify-between gap-4">
          <dt class="text-tinta-suave">Transferido em</dt>
          <dd class="text-tinta-corpo">{{ quando(aberta.criadaEm) }}</dd>
        </div>
        <div class="flex justify-between gap-4">
          <dt class="text-tinta-suave">Realizada em</dt>
          <dd class="text-tinta-corpo">{{ quando(aberta.aceitaEm) }}</dd>
        </div>
        <div v-if="aberta.status === 'aguardando'" class="flex justify-between gap-4">
          <dt class="text-tinta-suave">Vence em</dt>
          <dd class="text-tinta-corpo">{{ quando(aberta.venceEm) }}</dd>
        </div>
        <div class="flex justify-between gap-4">
          <dt class="text-tinta-suave">Quem no time enviou</dt>
          <dd class="text-tinta-corpo">{{ aberta.enviadoPor ?? 'pelo site' }}</dd>
        </div>
      </dl>

      <button v-if="aberta.status === 'aguardando' || aberta.status === 'concluido'"
              type="button" class="btn-erro mt-6 w-full"
              @click="cancelando = aberta; erroCancelamento = ''">
        Cancelar transferência
      </button>
    </ModalLateral>

    <!-- confirmação do cancelamento: diz o que acontece, não só "tem certeza?" -->
    <ModalLateral v-if="cancelando" titulo="Cancelar transferência" @fechar="cancelando = null">
      <p class="text-tinta-corpo">
        Ao cancelar,
        <strong>o ingresso volta para {{ cancelando.de.nome ?? 'o titular anterior' }}</strong>
        e só dá pra mudar a titularidade de novo repetindo o envio. Esta ação é irreversível.
      </p>
      <p v-if="erroCancelamento" class="faixa-erro mt-4">{{ erroCancelamento }}</p>
      <div class="mt-6 flex gap-3">
        <button type="button" class="btn-secundario flex-1" @click="cancelando = null">Fechar</button>
        <button type="button" class="btn-erro flex-1" :disabled="salvando"
                @click="confirmarCancelamento">
          {{ salvando ? 'Cancelando…' : 'Cancelar transferência' }}
        </button>
      </div>
    </ModalLateral>
  </div>

  <div v-else-if="pending" class="card mt-6 text-tinta-suave">Carregando…</div>

  <div v-else class="card mt-6">
    <p class="rotulo-kpi text-erro">Não foi possível carregar as transferências</p>
    <p class="mt-1 text-sm text-tinta-suave">
      {{ (falha as any)?.statusCode === 403
        ? 'Seu acesso não inclui as vendas deste evento.'
        : ((falha as any)?.data?.message || (falha as any)?.message || 'Confira a internet e tente de novo.') }}
    </p>
    <button type="button" class="btn-secundario mt-3" @click="refresh()">Tentar de novo</button>
  </div>
</template>
