<script setup lang="ts">
/**
 * Financeiro da organização — o caixa somando todos os eventos.
 *
 * A pergunta desta tela não é a mesma do financeiro de dentro do evento.
 * Lá é "quanto sobra deste show"; aqui é "quanto a produtora tem pra receber
 * no total, e o que ainda está preso em evento que não acabou".
 *
 * Por isso o retido vem em destaque e por evento: é o dinheiro que existe,
 * está contado, e ainda não pode ser gasto.
 */
definePageMeta({ layout: 'admin' })

const { data, pending, error: falha, refresh } = await useFetch<any>('/api/admin/financeiro')
// o MESMO `auth-eu` do layout: uma ida ao servidor pras duas telas
const { data: eu } = await useFetch<any>('/api/auth/eu', { key: 'auth-eu' })

// dinheiro e data vêm de `app/composables/formato.ts` — a conta de centavo e
// o corte do dia moram num lugar só.
const brl = reais

const SELO: Record<string, string> = {
  concluida: 'selo-ok', solicitada: 'selo-alerta', processando: 'selo-alerta',
  falhou: 'selo-erro', cancelada: 'selo-neutro',
}
const FORMA: Record<string, string> = {
  pix: 'Pix', credito: 'Cartão de crédito', debito: 'Cartão de débito',
  dinheiro: 'Dinheiro', cortesia: 'Cortesia',
}

const picoMes = computed(() =>
  (data.value?.porMes ?? []).reduce((m: number, x: any) => Math.max(m, x.faceCents), 0))

/** eventos com dinheiro em jogo primeiro — o resto é ruído nesta tela */
const comMovimento = computed(() =>
  (data.value?.eventos ?? []).filter((e: any) => e.faceCents > 0 || e.transferidoCents > 0))

function exportar() {
  const cab = ['Evento', 'Situação', 'Termina', 'Pedidos', 'Face', 'Taxa', 'Estornado',
               'Líquido', 'Na plataforma', 'Recebido direto', 'Transferido', 'Em curso',
               'Retido', 'Disponível']
  const l = comMovimento.value.map((e: any) => [
    e.nome, e.status, dataCurta(e.termina, ''),
    String(e.pedidos), brl(e.faceCents), brl(e.taxaCents), brl(e.estornadoCents),
    brl(e.liquidoCents), brl(e.naPlataformaCents), brl(e.recebidoDiretoCents),
    brl(e.transferidoCents), brl(e.emCursoCents),
    brl(e.retidoCents), brl(e.disponivelCents),
  ])
  const csv = [cab, ...l]
    .map((r) => r.map((c: string) => `"${String(c).replace(/"/g, '""')}"`).join(';'))
    .join('\r\n')
  const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = 'financeiro-organizacao.csv'
  a.click()
  URL.revokeObjectURL(url)
}

/* ---------------------------------------------------- enviar os saques */
/**
 * O pedido de saque (no financeiro do evento) só GRAVA a linha como
 * 'solicitada', de propósito — quem tira o dinheiro da plataforma é
 * `POST /api/admin/payout/executar`. Nenhuma tela chamava essa rota, e o
 * pedido ficava "solicitada" pra sempre com o produtor esperando o pix.
 *
 * Quem pode: master e financeiro — a mesma régua de `utils/papeis.ts`
 * (`/api/admin/payout` é área `dinheiro`). Esconder o botão é conforto; quem
 * tranca é o servidor.
 */
const podeEnviar = computed(() =>
  ['master', 'financeiro'].includes(String(eu.value?.usuario?.papel ?? '')))

/** o que a fila tem pra andar — 'processando' entra porque a rota também confere quem está em voo */
const pendentes = computed(() => (data.value?.transferencias ?? [])
  .filter((t: any) => t.status === 'solicitada' || t.status === 'processando'))

const enviando = ref(false)
const recadoEnvio = ref<{ tipo: 'ok' | 'aviso' | 'erro'; texto: string } | null>(null)

async function enviarSaques() {
  // trava de duplo clique ANTES do confirm: o segundo clique não abre outra pergunta
  if (enviando.value) return
  const n = pendentes.value.length
  const soma = pendentes.value.reduce((a: number, t: any) => a + t.valorCents, 0)
  const pergunta = `Enviar ${n} ${n === 1 ? 'saque pendente' : 'saques pendentes'} (${brl(soma)}) agora?\n\n`
    + 'O dinheiro sai da plataforma para a conta de cada beneficiário. '
    + 'Isso não pode ser desfeito por aqui.'
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

useHead({ title: 'Financeiro' })
</script>

<template>
  <div v-if="data">
    <div class="flex flex-wrap items-start justify-between gap-3 py-5">
      <div>
        <h1 class="titulo text-2xl font-semibold text-tinta">Financeiro</h1>
        <p class="mt-1 text-tinta-suave">
          O caixa somando todos os eventos. O dinheiro de cada um libera
          {{ data.diasDeRetencao }} dias depois de ele terminar.
        </p>
      </div>
      <div class="flex flex-wrap gap-2">
        <button type="button" class="btn-secundario" @click="exportar">
          <IconeMenu nome="exportar" :tamanho="18" /> Exportar
        </button>
        <button v-if="podeEnviar" type="button" class="btn-primario" data-acao="enviar-saques"
                :disabled="enviando || !pendentes.length"
                :title="pendentes.length ? '' : 'Nenhum saque esperando envio'"
                @click="enviarSaques">
          {{ enviando ? 'Enviando…' : `Enviar saques pendentes (${pendentes.length})` }}
        </button>
      </div>
    </div>

    <p v-if="recadoEnvio" role="status" data-parte="recado-envio" class="mb-4"
       :class="recadoEnvio.tipo === 'erro' ? 'faixa-erro'
         : recadoEnvio.tipo === 'aviso'
           ? 'rounded-xl bg-alerta-claro px-4 py-3 text-sm leading-6 text-alerta ring-1 ring-inset ring-alerta/30'
           : 'rounded-xl bg-ok-claro px-4 py-3 text-sm leading-6 text-ok ring-1 ring-inset ring-ok/30'">
      {{ recadoEnvio.texto }}
    </p>

    <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <div class="card">
        <p class="rotulo-kpi">Total líquido</p>
        <p class="numero-kpi mt-1">{{ brl(data.totais.liquidoCents) }}</p>
        <!--
          A legenda tinha ficado descrevendo a conta ANTIGA (`face − estorno`),
          que utils/liquido.ts aposentou. O numero ja estava certo e a frase
          nao — que e pior que os dois errados, porque ninguem confere um
          numero que a legenda explica.
        -->
        <!-- div, não p: o navegador fecha um <p> sozinho ao ver bloco dentro -->
        <div v-if="data.totais.recebidoDiretoCents" class="mt-2 space-y-0.5 text-xs">
          <p class="flex justify-between text-tinta-fraca">
            <span>na plataforma</span>
            <span class="tabular-nums text-tinta">{{ brl(data.totais.naPlataformaCents) }}</span>
          </p>
          <p class="flex justify-between text-tinta-fraca">
            <span>recebido direto por você</span>
            <span class="tabular-nums text-tinta">{{ brl(data.totais.recebidoDiretoCents) }}</span>
          </p>
        </div>
        <p v-else class="mt-1 text-xs text-tinta-fraca">
          o que sobra das vendas pagas depois da taxa de serviço e dos estornos
        </p>
      </div>
      <div class="card">
        <p class="rotulo-kpi">Retido</p>
        <p class="numero-kpi mt-1" :class="data.totais.retidoCents ? 'text-alerta' : ''">
          {{ brl(data.totais.retidoCents) }}
        </p>
        <p class="mt-1 text-xs text-tinta-fraca">preso em evento que ainda não terminou</p>
      </div>
      <div class="card">
        <p class="rotulo-kpi">Transferido</p>
        <p class="numero-kpi mt-1">{{ brl(data.totais.transferidoCents) }}</p>
        <p class="mt-1 text-xs text-tinta-fraca">
          {{ brl(data.totais.emCursoCents) }} em curso
        </p>
      </div>
      <div class="card">
        <p class="rotulo-kpi">Disponível</p>
        <p class="numero-kpi mt-1" :class="data.totais.disponivelCents ? 'text-ok' : ''">
          {{ brl(data.totais.disponivelCents) }}
        </p>
        <p class="mt-1 text-xs text-tinta-fraca">
          só o que passou pela plataforma, já descontado o que está solicitado
        </p>
      </div>
    </div>

    <!-- O recebido direto NÃO é saldo: é dinheiro que já está com o produtor
         (espécie na gaveta, pix na chave dele). Nomeado aqui, com a mesma
         frase do financeiro do evento e do borderô, pra ninguém somar o
         líquido e achar que a plataforma deve a diferença. -->
    <p v-if="data.totais.recebidoDiretoCents" class="mt-3 text-sm text-tinta-suave"
       data-parte="recebido-direto">
      <strong class="text-tinta">{{ brl(data.totais.recebidoDiretoCents) }}</strong>
      recebidos direto (dinheiro no balcão ou pix na sua chave) já estão com você e não
      entram no saldo a transferir.
    </p>

    <div v-if="data.porMes.length" class="card mt-4">
      <p class="rotulo-kpi">Entrada por mês</p>
      <div class="mt-3 flex items-end gap-2" style="height: 110px">
        <div v-for="m in [...data.porMes].reverse()" :key="m.mes" class="flex-1"
             :title="`${mesAno(m.mes)} — ${m.pedidos} pedidos, ${brl(m.faceCents)}`">
          <div class="rounded-t bg-acao"
               :style="{ height: `${picoMes ? Math.max((m.faceCents / picoMes) * 96, 2) : 2}px` }" />
        </div>
      </div>
      <div class="mt-1 flex gap-2 text-center text-xs text-tinta-fraca">
        <span v-for="m in [...data.porMes].reverse()" :key="m.mes" class="flex-1">
          {{ mesCurto(m.mes) }}
        </span>
      </div>
    </div>

    <p v-if="!comMovimento.length" class="card mt-4 py-12 text-center text-tinta-suave">
      Nenhum evento com movimento financeiro ainda.
    </p>

    <div v-else class="card mt-4 overflow-x-auto p-0">
      <p class="titulo border-b border-linha px-4 py-3 text-sm font-semibold text-tinta-rotulo">
        Por evento
      </p>
      <table class="w-full min-w-[900px] border-collapse text-sm">
        <thead>
          <tr class="border-b border-linha bg-fundo-cinza/60 text-left">
            <th class="titulo px-4 py-2 text-xs font-semibold uppercase tracking-wide text-tinta-rotulo">Evento</th>
            <th class="titulo px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-tinta-rotulo">Líquido</th>
            <th class="titulo px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-tinta-rotulo">Transferido</th>
            <th class="titulo px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-tinta-rotulo">Retido</th>
            <th class="titulo px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-tinta-rotulo">Disponível</th>
            <th class="titulo px-4 py-2 text-right text-xs font-semibold uppercase tracking-wide text-tinta-rotulo"></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="e in comMovimento" :key="e.id" class="border-b border-linha last:border-0">
            <td class="px-4 py-3">
              <p class="font-medium text-tinta">{{ e.nome }}</p>
              <p class="text-xs text-tinta-fraca">
                {{ e.pedidos }} pedidos ·
                <template v-if="e.liberado">liberado</template>
                <template v-else>
                  libera em {{ dataCurta(e.liberaEm) }}
                </template>
              </p>
            </td>
            <td class="px-3 py-3 text-right font-medium tabular-nums text-tinta">
              {{ brl(e.liquidoCents) }}
              <span v-if="e.recebidoDiretoCents" class="block text-xs font-normal text-tinta-fraca">
                {{ brl(e.recebidoDiretoCents) }} direto com você
              </span>
            </td>
            <td class="px-3 py-3 text-right tabular-nums text-tinta-suave">
              {{ brl(e.transferidoCents) }}
              <span v-if="e.emCursoCents" class="block text-xs text-alerta">
                +{{ brl(e.emCursoCents) }} em curso
              </span>
            </td>
            <td class="px-3 py-3 text-right tabular-nums"
                :class="e.retidoCents ? 'text-alerta' : 'text-tinta-fraca'">
              {{ brl(e.retidoCents) }}
            </td>
            <td class="px-3 py-3 text-right tabular-nums"
                :class="e.disponivelCents ? 'text-ok' : 'text-tinta-fraca'">
              {{ brl(e.disponivelCents) }}
            </td>
            <td class="px-4 py-3 text-right">
              <NuxtLink :to="`/admin/evento/${e.id}/financeiro`"
                        class="text-sm text-acao hover:underline">Abrir</NuxtLink>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="mt-4 grid gap-3 lg:grid-cols-3">
      <div v-if="data.porForma.length" class="card">
        <p class="rotulo-kpi">Como entrou</p>
        <table class="mt-3 w-full text-sm">
          <tbody>
            <tr v-for="f in data.porForma" :key="f.forma" class="border-b border-linha last:border-0">
              <td class="py-2 text-tinta">{{ FORMA[f.forma] ?? f.forma }}</td>
              <td class="py-2 text-right text-xs tabular-nums text-tinta-fraca">{{ f.pedidos }}</td>
              <td class="py-2 text-right tabular-nums text-tinta">{{ brl(f.cobradoCents) }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="card p-0 lg:col-span-2">
        <p class="titulo border-b border-linha px-4 py-3 text-sm font-semibold text-tinta-rotulo">
          Transferências
        </p>
        <p v-if="!data.transferencias.length" class="px-4 py-8 text-center text-sm text-tinta-suave">
          Nenhuma transferência pedida ainda.
        </p>
        <table v-else class="w-full text-sm">
          <tbody>
            <tr v-for="t in data.transferencias" :key="t.id"
                class="border-b border-linha last:border-0">
              <td class="px-4 py-2.5">
                <p class="text-tinta">{{ t.beneficiario }}</p>
                <p class="font-mono text-xs text-tinta-fraca">{{ t.codigo }}</p>
              </td>
              <td class="px-3 py-2.5 text-xs text-tinta-suave">
                {{ t.evento ?? '—' }}
                <span class="block text-tinta-fraca">
                  {{ dataCurta(t.solicitadaEm) }}
                  <template v-if="t.pedidoPor"> · {{ t.pedidoPor }}</template>
                </span>
              </td>
              <td class="px-3 py-2.5 text-right font-medium tabular-nums text-tinta">
                {{ brl(t.valorCents) }}
              </td>
              <td class="px-4 py-2.5 text-right">
                <span :class="SELO[t.status] ?? 'selo-neutro'">{{ t.status.toUpperCase() }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>

  <p v-else-if="pending" class="card mt-6 text-tinta-suave">Carregando…</p>

  <div v-else class="card mt-6">
    <p class="rotulo-kpi text-erro">Não foi possível carregar o financeiro</p>
    <p class="mt-1 text-sm text-tinta-suave">
      {{ (falha as any)?.data?.statusMessage || (falha as any)?.message || 'Erro desconhecido.' }}
    </p>
    <button type="button" class="btn-secundario mt-3" @click="refresh()">Tentar de novo</button>
  </div>
</template>
