<script setup lang="ts">
/**
 * Suporte — o que fazer quando algo dá errado no dia do evento.
 *
 * Não é uma caixa de "abrir chamado". No dia do evento ninguém abre chamado
 * e espera: precisa de resposta AGORA, e quase toda a resposta já está no
 * próprio sistema. Esta tela é o caminho mais curto até ela.
 *
 * As situações abaixo são as que efetivamente aparecem na porta e no
 * atendimento, cada uma com a tela que resolve. O link não é decorativo —
 * é o destino real.
 *
 * ## Por que esta tela pergunta o papel
 *
 * Ela é uma parede de ATALHOS, e atalho pra porta fechada é pior aqui do que
 * em qualquer outro lugar do painel: quem abre esta tela já está com problema
 * e com fila na frente. Medido no HTML servido a uma sessão de OPERAÇÃO,
 * antes deste filtro — quatro portas, e as quatro respondem 403 pra ela:
 *
 * | atalho oferecido                  | a rota por trás                    |
 * |-----------------------------------|------------------------------------|
 * | Abrir Equipe → `/admin/equipe`    | `GET /api/admin/equipe` → **403**  |
 * | Abrir Configurações               | `GET /api/admin/organizacao` → **403** |
 * | Abrir painel do evento (dashboard)| `GET .../dashboard` → **403**      |
 * | Abrir Financeiro                  | `GET .../financeiro` → **403**     |
 *
 * O texto de cada situação CONTINUA na tela: ele é a explicação do que está
 * acontecendo, e some seria trocar "não é o seu acesso" por "o sistema não
 * cobre o seu caso". O que some é o BOTÃO, que vira a frase de quem procurar.
 *
 * A régua é a `podeAbrirPagina` de `server/utils/papeis.ts` — a MESMA que
 * tranca a rota e que filtra a lateral. Uma segunda lista aqui envelheceria
 * sozinha. Esconder não é proteção: quem tranca é o `middleware/03.papel.ts`.
 */
import { ehPapel, podeAbrirPagina, type Papel } from '~~/server/utils/papeis'

definePageMeta({ layout: 'admin' })

const { data: eventos } = await useFetch<any>('/api/admin/eventos')

// mesma `key` do layout: nenhuma chamada a mais por navegação
const { data: eu } = await useFetch<any>('/api/auth/eu', { key: 'auth-eu' })
const papel = computed<Papel | null>(() => {
  const p = eu.value?.usuario?.papel
  return ehPapel(p) ? p : null
})
/** Enquanto o papel não chegou, nada é oferecido — listar por otimismo é o defeito. */
const podeAbrir = (para: string) => !!papel.value && podeAbrirPagina(papel.value, para)

/** o evento que está acontecendo, ou o próximo — é sobre ele que perguntam */
const foco = computed(() => {
  const l = eventos.value ?? []
  const agora = Date.now()
  const rolando = l.find((e: any) =>
    e.inicio && e.fim && new Date(e.inicio).getTime() <= agora && new Date(e.fim).getTime() >= agora)
  if (rolando) return rolando
  const futuros = l.filter((e: any) => e.inicio && new Date(e.inicio).getTime() > agora)
  return futuros.sort((a: any, b: any) =>
    new Date(a.inicio).getTime() - new Date(b.inicio).getTime())[0] ?? l[0] ?? null
})

const base = computed(() => (foco.value ? `/admin/evento/${foco.value.id}` : null))

const TODAS_AS_SITUACOES = computed(() => [
  {
    titulo: 'O cliente diz que pagou e não recebeu o ingresso',
    o_que: 'Procure pelo e-mail, CPF ou código do pedido. A ficha mostra o histórico bruto '
      + 'do gateway: ou tem o evento de pagamento, ou não tem. Se não tem, o dinheiro não '
      + 'entrou — mesmo que o comprovante pareça real.',
    acao: 'Abrir Vendas', para: base.value ? `${base.value}/vendas` : '/admin',
  },
  {
    titulo: 'Alguém está na porta e o QR não passa',
    o_que: 'Leia o histórico: o motivo da recusa fica registrado em cada leitura. '
      + '"Já entrou" é ingresso reaproveitado; "código inválido" costuma ser print do '
      + 'ingresso de outra pessoa.',
    acao: 'Ver histórico de leituras', para: base.value ? `${base.value}/validacao/historico` : '/admin',
  },
  {
    titulo: 'Comprou 6 e só tem o nome de quem pagou',
    o_que: 'Os outros 5 nascem em branco de propósito. Nomeie um por um na lista de '
      + 'participantes — é o que permite exigir documento na entrada.',
    acao: 'Abrir Participantes', para: base.value ? `${base.value}/vendas/participantes` : '/admin',
  },
  {
    titulo: 'Precisa liberar alguém sem cobrar',
    o_que: 'Cortesia é venda de preço zero: ocupa vaga no lote igual a um ingresso vendido. '
      + 'Se o setor estiver esgotado, a cortesia é recusada — e tem que ser, senão entra '
      + 'mais gente do que cabe.',
    acao: 'Emitir cortesia', para: base.value ? `${base.value}/ingressos/cortesias` : '/admin',
  },
  {
    titulo: 'O dinheiro da venda não aparece pra transferir',
    o_que: 'O valor só libera depois que o evento termina — antes disso, cancelar o evento '
      + 'significaria devolver tudo. A tela do financeiro mostra a data exata da liberação.',
    acao: 'Abrir Financeiro', para: base.value ? `${base.value}/financeiro` : '/admin/financeiro',
  },
  {
    titulo: 'Alguém da equipe saiu e ainda tem acesso',
    o_que: 'Desativar derruba as sessões abertas na hora — sem isso, o cookie antigo '
      + 'continuaria valendo por dias.',
    acao: 'Abrir Equipe', para: '/admin/equipe',
  },
  {
    titulo: 'Nenhuma cobrança está saindo',
    o_que: 'Confira o ambiente e a chave do Asaas. Em "testes", ninguém é cobrado de '
      + 'verdade; sem chave em produção, o comprador paga e a confirmação nunca chega.',
    acao: 'Abrir Configurações', para: '/admin/configuracoes',
  },
])

/**
 * A mesma lista, com a resposta de quem abre cada porta. O card fica; o botão
 * só existe quando o clique não termina em 403.
 */
const SITUACOES = computed(() => TODAS_AS_SITUACOES.value.map((s) => ({
  ...s, aberta: podeAbrir(s.para),
})))

useHead({ title: 'Suporte' })
</script>

<template>
  <div>
    <div class="py-5">
      <h1 class="titulo text-2xl font-bold text-tinta">Suporte</h1>
      <p class="mt-1 text-tinta-suave">
        O que fazer quando algo trava — e a tela que resolve cada caso.
      </p>
    </div>

    <div v-if="foco" class="card flex flex-wrap items-center justify-between gap-3">
      <div>
        <p class="rotulo-kpi">Evento em foco</p>
        <p class="titulo mt-1 text-lg font-bold text-tinta">{{ foco.nome }}</p>
        <p class="text-xs text-tinta-fraca">
          <template v-if="foco.inicio">
            {{ new Date(foco.inicio).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) }}
          </template>
          <template v-if="foco.cidade"> · {{ foco.cidade }}<template v-if="foco.estado">/{{ foco.estado }}</template></template>
        </p>
      </div>
      <!-- o painel do evento é a tela de faturamento do dia (área `dinheiro`):
           quem é de operação não abre, e o botão não é desenhado pra ela -->
      <NuxtLink v-if="podeAbrir(`/admin/evento/${foco.id}/dashboard`)"
                :to="`/admin/evento/${foco.id}/dashboard`" class="btn-secundario">
        Abrir painel do evento
      </NuxtLink>
    </div>

    <div class="mt-4 grid gap-3 lg:grid-cols-2">
      <article v-for="s in SITUACOES" :key="s.titulo" class="card flex flex-col">
        <h2 class="titulo text-base font-bold text-tinta">{{ s.titulo }}</h2>
        <p class="mt-2 flex-1 text-sm leading-relaxed text-tinta-suave">{{ s.o_que }}</p>
        <NuxtLink v-if="s.aberta" :to="s.para" class="btn-secundario mt-3 self-start">
          {{ s.acao }}
        </NuxtLink>
        <!-- porta fechada não vira botão morto: vira quem procurar -->
        <p v-else class="mt-3 text-xs text-tinta-fraca">
          Esta tela não faz parte do seu acesso. Peça a um master da sua organização.
        </p>
      </article>
    </div>

    <section class="card mt-4">
      <h2 class="titulo text-base font-bold text-tinta">Onde olhar quando nada explica</h2>
      <ul class="mt-3 grid gap-2 text-sm text-tinta-suave">
        <li>
          <strong class="text-tinta">Borderô</strong> — fecha a conta por lote, canal e forma de
          pagamento. Se a soma dos lotes não bate com o total, o problema está na venda,
          não no relatório.
        </li>
        <li>
          <strong class="text-tinta">Histórico de leituras</strong> — toda leitura vira linha,
          inclusive a recusada. É o único lugar onde aparece o que NÃO entrou.
        </li>
        <li>
          <strong class="text-tinta">Ficha do pedido</strong> — traz o histórico bruto do
          gateway, evento por evento, na ordem em que chegaram.
        </li>
      </ul>
    </section>
  </div>
</template>
