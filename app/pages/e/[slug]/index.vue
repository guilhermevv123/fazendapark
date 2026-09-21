<script setup lang="ts">
/**
 * Página pública de compra.
 *
 * Duas decisões de produto contra o que a plataforma de origem faz hoje:
 *  1. O preço mostrado é o TOTAL que sai do bolso, com a taxa já dentro e
 *     discriminada embaixo. Descobrir a taxa só no fim do checkout é o que
 *     produz boa parte do abandono (no painel deles: 29%).
 *  2. O resumo acompanha a rolagem no celular. Ninguém rola de volta pra
 *     conferir o total antes de pagar.
 *
 * As regras do carrinho (teto, mínimo, declaração de meia) NÃO moram aqui:
 * moram em `app/composables/carrinhoDaVitrine.ts`, que é testável. Regra
 * dentro de `<script setup>` não tem como ficar vermelha num teste, e as três
 * juntas são o que separa uma compra que passa de um 409 com o cartão na mão.
 */
import { MOTIVOS, CHAVES_DE_MOTIVO } from '~~/server/utils/meia-entrada'
import {
  ajustarQuantidade, chaveDaLinha, impedimentoDaLinha, minimoDaLinha,
  pedeDeclaracaoDeMeia, pendenciasDoCarrinho, tetoDaLinha, totaisDoCarrinho,
  VERSAO_DO_CARRINHO, type DeclaracaoDeMeia, type LinhaDoPedido,
} from '~/composables/carrinhoDaVitrine'

const route = useRoute()
const { data, error } = await useFetch<any>(`/api/e/${route.params.slug}`)

/**
 * `reais` e `paraData` vêm de `app/composables/formato.ts`. A cópia local que
 * existia aqui usava `toLocaleString('pt-BR', { style: 'currency' })`, que
 * separa o `R$` com espaço FINO (U+00A0) — duas strings idênticas na tela que
 * não são iguais na comparação. Uma formatação só, pro painel e pra vitrine.
 */
const quandoPorExtenso = (v: any) => {
  const d = paraData(v)
  return d
    ? d.toLocaleString('pt-BR', {
        day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
      })
    : '—'
}

/* ------------------------------------------------------------- carrinho --- */
/** quantidade por linha, com a chave `loteId|tipoId` */
const quantidades = ref<Record<string, number>>({})
/** declaração de meia-entrada por linha, mesma chave */
const declaracoes = ref<Record<string, DeclaracaoDeMeia>>({})

const quantidade = (lote: any, v: any) => quantidades.value[chaveDaLinha(lote.id, v.tipoId)] ?? 0

/**
 * Esta linha é meia-entrada — ou seja, precisa do motivo antes de seguir?
 *
 * Quem responde é o SERVIDOR, em `ehMeia`, que sai da coluna gerada
 * `ticket_types.kind` (db/015) — a mesma régua que o checkout usa pra exigir o
 * motivo. `pedeDeclaracaoDeMeia` fica só como rede pra payload de build
 * antiga: ela deduzia "é meia" de `exigeDocumento`, e errava no ingresso de
 * preço cheio COM documento (nominal, `discount_bps = 0`). O resultado medido
 * era a tela pedir o motivo, o comprador escolher, e o checkout devolver 422
 * `meia_em_inteira` no último clique — a tela então reenviava sem a declaração
 * e a compra passava, mas depois de um formulário que nunca precisou existir.
 */
const pedeMeia = (v: any): boolean =>
  typeof v?.ehMeia === 'boolean' ? v.ehMeia : pedeDeclaracaoDeMeia(v)

function ajustar(lote: any, v: any, delta: number) {
  const k = chaveDaLinha(lote.id, v.tipoId)
  const novo = ajustarQuantidade(quantidades.value[k] ?? 0, delta, lote, v)
  if (novo === 0) {
    delete quantidades.value[k]
    delete declaracoes.value[k]
  } else {
    quantidades.value[k] = novo
    // A declaração nasce vazia junto com a primeira unidade: é ela que o
    // bloco de meia-entrada edita, e `v-model` em objeto que ainda não existe
    // não grava nada (e não avisa).
    if (pedeMeia(v) && !declaracoes.value[k]) {
      declaracoes.value[k] = { motivo: '', documento: '' }
    }
  }
  quantidades.value = { ...quantidades.value }
  declaracoes.value = { ...declaracoes.value }
}

/**
 * A declaração desta linha. É um GETTER PURO: quem cria o objeto é `ajustar`,
 * quando a linha entra no carrinho. Criar aqui dentro seria escrever num `ref`
 * durante o render — o caminho curto pro laço de renderização.
 */
const SEM_DECLARACAO: DeclaracaoDeMeia = { motivo: '', documento: '' }
const declaracao = (lote: any, v: any): DeclaracaoDeMeia =>
  declaracoes.value[chaveDaLinha(lote.id, v.tipoId)] ?? SEM_DECLARACAO

/** As linhas escolhidas, no formato que atravessa pro pagamento. */
const linhas = computed<LinhaDoPedido[]>(() => {
  const saida: LinhaDoPedido[] = []
  for (const setor of data.value?.setores ?? []) {
    for (const lote of setor.lotes) {
      for (const v of lote.variacoes) {
        const k = chaveDaLinha(lote.id, v.tipoId)
        const n = quantidades.value[k] ?? 0
        if (n <= 0) continue
        saida.push({
          loteId: lote.id,
          tipoId: v.tipoId ?? null,
          quantidade: n,
          nome: v.nome ?? lote.nome,
          setor: setor.nome,
          unitFaceCents: v.faceCents,
          unitTaxaCents: v.taxaCents,
          unitTotalCents: v.totalCents,
          pedeMeia: pedeMeia(v),
          declaracao: declaracoes.value[k] ?? null,
        })
      }
    }
  }
  return saida
})

const totais = computed(() => totaisDoCarrinho(linhas.value))

/**
 * O teto do PEDIDO inteiro, somando todas as linhas.
 *
 * O teto por linha (`maxPorCompra`) não fecha esta conta: num evento com
 * `events.max_per_order = 6`, 6 inteiras e 6 meias passam cada uma no seu
 * teto, o botão "Pagar" acendia, e o comprador só lia "Cada pedido leva no
 * máximo 6 ingressos e você escolheu 12" depois de digitar nome, e-mail e CPF
 * — medido no navegador. O número vem do servidor (`evento.maxPorPedido`), que
 * é o MESMO que o checkout confere, padrão incluído.
 */
const excedeuOPedido = computed(() => {
  const teto = Number(data.value?.evento?.maxPorPedido ?? 0)
  return teto > 0 && totais.value.n > teto
})
const pendencias = computed(() => {
  const saida = pendenciasDoCarrinho(linhas.value)
  if (excedeuOPedido.value) {
    const teto = Number(data.value.evento.maxPorPedido)
    saida.push(`Cada pedido leva no máximo ${teto} ingressos e você escolheu ${totais.value.n}. `
      + `Tire ${totais.value.n - teto} da lista — ou faça o resto em outra compra.`)
  }
  return saida
})
const podePagar = computed(() =>
  totais.value.n > 0 && !pendencias.value.length && data.value?.evento?.vendasAbertas)

/**
 * A situação vem pronta do servidor (ver server/api/e/[slug].get.ts). A tela
 * só traduz: decidir disponibilidade no navegador é como a vitrine passa a
 * discordar do estoque.
 */
const ROTULO: Record<string, string> = {
  esgotado: 'Esgotado', encerrado: 'Encerrado', em_breve: 'Em breve',
  fechado: 'Vendas fechadas', ultimas: 'Últimas unidades', disponivel: '',
}
/** Amarelo só na urgência real; o resto é selo neutro. */
const SELO: Record<string, string> = {
  ultimas: 'selo-alerta', esgotado: 'selo-neutro', encerrado: 'selo-neutro',
  em_breve: 'selo-neutro', fechado: 'selo-neutro',
}
const aVenda = (lote: any) => lote.situacao === 'disponivel' || lote.situacao === 'ultimas'

/**
 * Quem apertou o teto desta linha, em texto — ou '' quando foi a prateleira.
 *
 * `tetoPor` vem do servidor (`tetoDeCompra`, em server/api/e/[slug].get.ts) e é
 * uma PALAVRA, não a configuração do produtor. Existe porque `maxPorCompra`
 * deixou de ser só estoque: ele agora já desconta o teto do pedido e os tetos
 * por CPF que o checkout confere. Sem esta frase o número cai e ninguém
 * descobre por quê — e, pior, `impedimentoDaLinha` culparia o ESTOQUE.
 */
function porQueOTetoCaiu(lote: any, v: any): string {
  const por = v?.tetoPor ?? lote?.tetoPor
  const teto = tetoDaLinha(lote, v)
  if (por === 'pedido') return `Este evento leva no máximo ${teto} por pedido`
  if (por === 'cpf') return `Cada CPF leva no máximo ${teto} desta opção`
  return ''
}

/**
 * O que dizer embaixo do preço sobre teto e mínimo — ou '' quando não há o
 * que dizer. Botão travado sem motivo na tela vira chamado de "o site não
 * deixa comprar": o `+` de um lote com mínimo 4 e 2 compráveis fica desligado
 * pra sempre, e sem esta frase ninguém descobre por quê.
 *
 * A frase de `impedimentoDaLinha` (composable) culpa a PRATELEIRA — "e só
 * restam N". Ela só é verdade quando quem apertou o teto foi o estoque; num
 * lote com 500 lugares e teto de 2 por CPF ela dizia "só restam 2", que é
 * mentira sobre o estoque. Quem sabe o motivo verdadeiro é o servidor; o
 * composable segue mandando no botão, que é o que ele acerta.
 */
function observacaoDaLinha(lote: any, v: any): string {
  if (!aVenda(lote) || v.esgotado) return ''
  const min = minimoDaLinha(lote)
  const teto = tetoDaLinha(lote, v)
  const porque = porQueOTetoCaiu(lote, v)
  const impedimento = impedimentoDaLinha(lote, v)

  if (impedimento) {
    if (!porque) return impedimento
    return min > teto
      ? `${porque}, e o mínimo desta compra é ${min} — não dá para levar este agora`
      : porque
  }
  // Os dois recados juntos quando os dois valem: o "+" pula de 0 pro mínimo e
  // para no teto, e o comprador precisa das duas pontas pra entender o salto.
  if (porque) return min > 1 ? `Mínimo de ${min} por compra. ${porque}` : porque
  return min > 1 ? `Mínimo de ${min} por compra` : ''
}

function irParaPagamento() {
  if (!podePagar.value) return
  sessionStorage.setItem('dt:carrinho', JSON.stringify({
    versao: VERSAO_DO_CARRINHO,
    slug: route.params.slug,
    linhas: linhas.value,
    totais: totais.value,
  }))
  navigateTo(`/e/${route.params.slug}/pagamento`)
}

useHead(() => ({
  title: data.value?.evento ? `${data.value.evento.nome} — ingressos` : 'Ingressos',
}))
</script>

<template>
  <div v-if="error" class="mx-auto max-w-2xl px-4 py-24 text-center">
    <p class="titulo text-2xl font-bold text-tinta">Evento não encontrado</p>
    <p class="mt-2 text-tinta-suave">Confira o link ou fale com quem te mandou.</p>
  </div>

  <div v-else-if="data" class="min-h-screen pb-44 lg:pb-16">
    <header class="bg-menu text-white">
      <div class="mx-auto flex max-w-5xl items-center gap-3 px-4 py-3">
        <NuxtLink to="/" class="titulo text-lg font-black tracking-tight">
          diamond<span class="font-normal opacity-70">.tickets</span>
        </NuxtLink>
        <span class="ml-auto truncate text-sm text-white/80">{{ data.evento.organizacao }}</span>
      </div>
    </header>

    <main class="mx-auto max-w-5xl px-4">
      <!-- ======================================================= capa ---- -->
      <section class="card mt-6 overflow-hidden p-0">
        <div class="grid gap-0 md:grid-cols-[1fr_260px]">
          <div class="p-6 md:p-8">
            <span v-if="!data.evento.vendasAbertas" class="selo-neutro mb-3">VENDAS FECHADAS</span>
            <!-- por que fechou, em português: cancelado e adiado não são a
                 mesma notícia que "acabou o prazo" -->
            <p v-if="data.evento.avisoDeVenda" class="mb-3 text-sm text-tinta-suave">
              {{ data.evento.avisoDeVenda }}
            </p>
            <h1 class="titulo text-3xl font-black leading-tight text-tinta md:text-4xl">
              {{ data.evento.nome }}
            </h1>

            <dl class="mt-5 grid gap-3 text-[15px]">
              <div class="flex gap-3">
                <dt class="w-20 shrink-0 text-sm font-medium text-tinta-fraca">Quando</dt>
                <dd class="min-w-0 text-tinta-corpo">
                  {{ quandoPorExtenso(data.evento.inicio) }}
                  <span v-if="data.evento.fim" class="text-tinta-suave">
                    até {{ quandoPorExtenso(data.evento.fim) }}
                  </span>
                </dd>
              </div>
              <div v-if="!data.evento.local.online" class="flex gap-3">
                <dt class="w-20 shrink-0 text-sm font-medium text-tinta-fraca">Onde</dt>
                <dd class="min-w-0">
                  <span class="font-medium text-tinta">{{ data.evento.local.nome }}</span><br>
                  <span class="text-tinta-suave">
                    {{ data.evento.local.endereco }} — {{ data.evento.local.cidade }}/{{ data.evento.local.estado }}
                  </span>
                </dd>
              </div>
              <div v-if="data.evento.classificacao" class="flex gap-3">
                <dt class="w-20 shrink-0 text-sm font-medium text-tinta-fraca">Idade</dt>
                <dd class="text-tinta-corpo">{{ data.evento.classificacao }} anos</dd>
              </div>
            </dl>
          </div>

          <div class="flex items-center border-t border-linha bg-acao-fraco px-6 py-5 md:border-l md:border-t-0">
            <div class="w-full">
              <p class="text-sm font-medium text-tinta-suave">A partir de</p>
              <p class="titulo mt-1 text-3xl font-black text-tinta">
                {{ data.evento.aPartirDeCents != null ? reais(data.evento.aPartirDeCents) : '—' }}
              </p>
              <p class="mt-1 text-xs text-tinta-fraca">taxa de serviço já incluída</p>
            </div>
          </div>
        </div>
      </section>

      <!-- =================================================== seleção ----- -->
      <section class="mt-6 grid gap-6 lg:grid-cols-[1fr_320px]">
        <div class="min-w-0">
          <h2 class="titulo text-lg font-bold text-tinta">
            Escolha seus {{ data.evento.substantivo.toLowerCase() }}
          </h2>

          <div v-for="setor in data.setores" :key="setor.id" class="mt-4">
            <div class="flex flex-wrap items-baseline gap-2">
              <h3 class="titulo text-base font-bold text-tinta">{{ setor.nome }}</h3>
              <span v-if="setor.tipo === 'passaporte'" class="selo-neutro">COMBO</span>
            </div>
            <!-- A sessão é o DIA que o ingresso vale. Num parque que abre
                 sábado e domingo, esconder isso é o jeito mais barato de a
                 família chegar no dia errado. -->
            <p v-if="setor.sessao" class="mt-0.5 text-sm text-tinta-suave">
              {{ setor.sessao.titulo }} · {{ quandoPorExtenso(setor.sessao.inicio) }}
            </p>
            <p v-if="setor.descricao" class="mt-0.5 text-sm text-tinta-suave">{{ setor.descricao }}</p>

            <div v-for="lote in setor.lotes" :key="lote.id" class="card mt-2 p-0">
              <div v-for="(v, idx) in lote.variacoes" :key="v.tipoId ?? 'base'"
                   class="p-4" :class="idx > 0 ? 'border-t border-linha' : ''">
                <div class="flex items-center gap-3 sm:gap-4">
                  <div class="min-w-0 flex-1">
                    <p class="font-medium text-tinta">
                      {{ v.nome ?? lote.nome }}
                      <span v-if="v.exigeDocumento" class="text-xs font-normal text-tinta-fraca">
                        · com documento
                      </span>
                    </p>
                    <p v-if="idx === 0 && lote.descricao" class="mt-0.5 text-sm text-tinta-suave">
                      {{ lote.descricao }}
                    </p>
                    <!-- No celular a abertura do preço vai pra linha de baixo
                         (`block sm:inline`). Lado a lado em 375px o resultado
                         medido era "R$ 33,00 R$ 30,00 + R$ 3,00 de taxa"
                         quebrando no meio — três valores emendados, e o
                         comprador lê o preço errado antes de entender qual é
                         qual. `<span>` com display:block dentro de `<p>` é
                         válido; o que não pode é `<div>`/`<p>` aninhado. -->
                    <p class="mt-0.5">
                      <span class="titulo text-lg font-bold text-tinta">{{ reais(v.totalCents) }}</span>
                      <span v-if="v.taxaCents" class="block text-sm text-tinta-fraca sm:ml-2 sm:inline">
                        {{ reais(v.faceCents) }} + {{ reais(v.taxaCents) }} de taxa
                      </span>
                    </p>
                    <!-- Um selo por LINHA, e a linha é a variação: a meia pode
                         ter acabado dentro de um lote que ainda tem estoque, e
                         aí "Últimas unidades" nesta linha seria mentira. -->
                    <p v-if="v.esgotado || ROTULO[lote.situacao]" class="mt-1 flex flex-wrap items-center gap-2">
                      <span :class="v.esgotado ? 'selo-neutro' : SELO[lote.situacao]">
                        {{ v.esgotado ? 'Esgotado' : ROTULO[lote.situacao] }}
                      </span>
                      <span v-if="!v.esgotado && lote.situacao === 'em_breve' && lote.abreEm"
                            class="text-xs text-tinta-fraca">
                        abre em {{ quandoPorExtenso(lote.abreEm) }}
                      </span>
                    </p>
                    <p v-if="observacaoDaLinha(lote, v)" class="mt-1 text-xs text-tinta-fraca">
                      {{ observacaoDaLinha(lote, v) }}
                    </p>
                  </div>

                  <div v-if="aVenda(lote)" class="flex shrink-0 items-center gap-1">
                    <button type="button"
                            class="flex h-9 w-9 items-center justify-center rounded-card border border-linha-forte
                                   text-lg leading-none text-tinta hover:bg-fundo-cinza disabled:opacity-30"
                            :disabled="quantidade(lote, v) <= 0"
                            :aria-label="`Remover um ${v.nome ?? lote.nome}`"
                            @click="ajustar(lote, v, -1)">−</button>
                    <span class="w-8 text-center font-medium tabular-nums text-tinta">
                      {{ quantidade(lote, v) }}
                    </span>
                    <button type="button"
                            class="flex h-9 w-9 items-center justify-center rounded-card bg-acao text-lg
                                   leading-none text-white hover:bg-acao-escuro disabled:bg-tinta-fraca"
                            :disabled="!!impedimentoDaLinha(lote, v)
                                       || quantidade(lote, v) >= tetoDaLinha(lote, v)"
                            :aria-label="`Adicionar um ${v.nome ?? lote.nome}`"
                            @click="ajustar(lote, v, 1)">+</button>
                  </div>
                </div>

                <!-- ============================================ meia-entrada -->
                <!--
                  Meia-entrada é obrigação legal com comprovação NA ENTRADA, e
                  o motivo é o que diz à portaria qual papel pedir. Perguntar
                  aqui, e não depois, é o que evita o comprador preencher CPF e
                  cartão pra levar 422 na última tela. A lista de motivos vem de
                  server/utils/meia-entrada.ts — a mesma que o checkout usa pra
                  recusar.
                -->
                <div v-if="pedeMeia(v) && quantidade(lote, v) > 0"
                     class="mt-3 rounded-card border border-linha bg-fundo-cinza p-3">
                  <p class="text-xs font-bold text-tinta-rotulo">
                    Meia-entrada: quem tem direito?
                  </p>
                  <p class="mt-0.5 text-xs text-tinta-suave">
                    A portaria confere o documento deste motivo na entrada.
                  </p>
                  <div class="mt-2 grid gap-2 sm:grid-cols-2">
                    <div class="min-w-0">
                      <label :for="`motivo-${chaveDaLinha(lote.id, v.tipoId)}`" class="rotulo">Motivo</label>
                      <select :id="`motivo-${chaveDaLinha(lote.id, v.tipoId)}`"
                              v-model="declaracao(lote, v).motivo" class="campo">
                        <option value="">Escolha…</option>
                        <option v-for="chave in CHAVES_DE_MOTIVO" :key="chave" :value="chave">
                          {{ MOTIVOS[chave].rotulo }}
                        </option>
                      </select>
                    </div>
                    <div v-if="declaracao(lote, v).motivo && MOTIVOS[declaracao(lote, v).motivo]?.exigeNumero"
                         class="min-w-0">
                      <label :for="`doc-${chaveDaLinha(lote.id, v.tipoId)}`" class="rotulo">
                        Número do documento
                      </label>
                      <input :id="`doc-${chaveDaLinha(lote.id, v.tipoId)}`"
                             v-model="declaracao(lote, v).documento" class="campo"
                             autocomplete="off" maxlength="40">
                    </div>
                  </div>
                  <p v-if="declaracao(lote, v).motivo && MOTIVOS[declaracao(lote, v).motivo]"
                     class="mt-2 text-xs text-tinta-suave">
                    Leve na entrada: {{ MOTIVOS[declaracao(lote, v).motivo].documento }}.
                  </p>
                </div>
              </div>
            </div>
          </div>

          <div v-if="data.evento.descricao" class="card mt-6">
            <h2 class="titulo text-base font-bold text-tinta">Sobre o evento</h2>
            <p class="mt-2 whitespace-pre-line leading-relaxed text-tinta-corpo">
              {{ data.evento.descricao }}
            </p>
          </div>
        </div>

        <!-- resumo: fixo no desktop, barra no celular -->
        <aside class="hidden lg:block">
          <div class="card sticky top-6">
            <p class="rotulo-kpi">Seu pedido</p>

            <p v-if="!totais.n" class="mt-3 text-sm text-tinta-suave">
              Nenhum ingresso escolhido ainda.
            </p>

            <ul v-else class="mt-3 space-y-2 text-sm">
              <li v-for="l in linhas" :key="chaveDaLinha(l.loteId, l.tipoId)"
                  class="flex justify-between gap-3">
                <span class="min-w-0">
                  <span class="font-medium tabular-nums">{{ l.quantidade }}×</span>
                  <span class="text-tinta-corpo"> {{ l.nome }}</span>
                  <span class="block text-xs text-tinta-fraca">{{ l.setor }}</span>
                </span>
                <span class="shrink-0 tabular-nums text-tinta">
                  {{ reais(l.unitTotalCents * l.quantidade) }}
                </span>
              </li>
            </ul>

            <div v-if="totais.n" class="mt-4 border-t border-linha pt-3 text-sm">
              <div class="flex justify-between text-tinta-suave">
                <span>Ingressos</span><span class="tabular-nums">{{ reais(totais.face) }}</span>
              </div>
              <div v-if="totais.taxa" class="mt-1 flex justify-between text-tinta-suave">
                <span>Taxa de serviço</span><span class="tabular-nums">{{ reais(totais.taxa) }}</span>
              </div>
              <div class="mt-2 flex items-baseline justify-between border-t border-linha pt-2">
                <span class="titulo font-bold text-tinta">Total</span>
                <span class="titulo text-xl font-black tabular-nums text-tinta">{{ reais(totais.total) }}</span>
              </div>
            </div>

            <p v-if="pendencias.length" class="faixa-aviso mt-4">
              <span class="block font-bold text-tinta">Falta preencher para continuar:</span>
              <span v-for="p in pendencias" :key="p" class="mt-1 block">{{ p }}</span>
            </p>

            <button type="button" class="btn-primario mt-4 w-full py-3"
                    :disabled="!podePagar"
                    @click="irParaPagamento">
              {{ data.evento.vendasAbertas ? 'Ir para pagamento' : 'Vendas fechadas' }}
            </button>
          </div>
        </aside>
      </section>
    </main>

    <!-- barra do celular -->
    <div v-if="totais.n"
         class="fixed inset-x-0 bottom-0 z-20 border-t border-linha bg-white p-4 shadow-[0_-2px_12px_rgba(18,38,63,.08)] lg:hidden">
      <div class="mx-auto max-w-5xl">
        <p v-if="pendencias.length" class="faixa-aviso mb-3">{{ pendencias[0] }}</p>
        <div class="flex items-center gap-4">
          <div class="min-w-0 flex-1">
            <p class="text-xs text-tinta-fraca">
              {{ totais.n }} {{ totais.n === 1 ? 'ingresso' : 'ingressos' }}
            </p>
            <p class="titulo text-xl font-black tabular-nums text-tinta">{{ reais(totais.total) }}</p>
            <p v-if="totais.taxa" class="text-xs text-tinta-fraca">
              já com {{ reais(totais.taxa) }} de taxa
            </p>
          </div>
          <button type="button" class="btn-primario shrink-0 px-6 py-3"
                  :disabled="!podePagar" @click="irParaPagamento">
            Pagar
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
