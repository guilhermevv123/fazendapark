<script setup lang="ts">
/**
 * Clientes — a base de quem compra.
 *
 * O ingresso já leva nome, CPF e e-mail; o formulário do site (checkout) soma
 * onde a pessoa mora, a idade, o Instagram e se aceita receber novidades. Esta
 * tela é onde isso vira uso: achar alguém, ver o que comprou, e tirar uma lista
 * pra falar com quem interessa (follow-up, remarketing) — sem ter que garimpar
 * pedido por pedido.
 *
 * O recorte vive na URL: o operador manda o link do que está vendo.
 *
 * Dois cuidados que não são visuais:
 * - o CPF aparece mascarado na lista; inteiro só na ficha, que é uma pessoa por
 *   vez;
 * - "aceita novidades" é o consentimento da pessoa (LGPD). Quem vai mandar
 *   divulgação filtra por ele — a planilha exportada respeita o mesmo filtro.
 */
import { baixarCsv } from '~/composables/baixarCsv'

definePageMeta({ layout: 'admin' })

const route = useRoute()

const busca = ref(String(route.query.q ?? ''))
/** "UF|Cidade" num campo só: é o valor do `<select>`; a URL guarda os dois separados */
const local = ref(route.query.uf && route.query.cidade ? `${route.query.uf}|${route.query.cidade}` : '')
const faixa = ref(String(route.query.faixa ?? ''))
const situacao = ref(String(route.query.situacao ?? ''))
const novidades = ref(route.query.novidades === '1')
const completo = ref(route.query.cadastro === '1')
const ordem = ref(String(route.query.ordem ?? 'recentes'))
const pagina = ref(Number(route.query.pagina) || 1)

/** O recorte que a lista e a planilha compartilham — sem página nem ordem. */
const recorte = computed(() => {
  const [uf, cidade] = local.value ? local.value.split('|') : ['', '']
  return {
    q: busca.value.trim() || undefined,
    uf: uf || undefined, cidade: cidade || undefined,
    faixa: faixa.value || undefined,
    situacao: situacao.value || undefined,
    novidades: novidades.value ? '1' : undefined,
    cadastro: completo.value ? '1' : undefined,
  }
})

const params = computed(() => ({
  ...recorte.value,
  ordem: ordem.value !== 'recentes' ? ordem.value : undefined,
  pagina: pagina.value > 1 ? String(pagina.value) : undefined,
}))

const { data, pending, error: falha, refresh } = await useFetch<any>(
  '/api/admin/clientes', { query: params })

watch(params, (p) => {
  navigateTo({ query: Object.fromEntries(Object.entries(p).filter(([, v]) => v)) },
    { replace: true })
})
// mudou o recorte ou a ordem: a página 3 do recorte antigo não existe mais
watch([busca, local, faixa, situacao, novidades, completo, ordem], () => { pagina.value = 1 })

const temFiltro = computed(() => Object.values(recorte.value).some(Boolean))
function limpar() {
  busca.value = ''; local.value = ''; faixa.value = ''; situacao.value = ''
  novidades.value = false; completo.value = false
}

const total = computed(() => data.value?.paginacao?.total ?? 0)
const porPagina = computed(() => data.value?.paginacao?.porPagina ?? 50)
const primeiro = computed(() => (total.value ? (pagina.value - 1) * porPagina.value + 1 : 0))
const ultimo = computed(() => Math.min(total.value, pagina.value * porPagina.value))
const temProxima = computed(() => ultimo.value < total.value)
// `?pagina=99` velho na URL: o servidor devolve a janela vazia com o total certo,
// e a tela volta pra última página que existe em vez de dizer "nenhum cliente"
watch(data, (d) => {
  const t = d?.paginacao?.total ?? 0
  if (d && !d.itens.length && t > 0 && pagina.value > 1) {
    pagina.value = Math.ceil(t / porPagina.value)
  }
})

const FAIXAS = [
  ['ate17', 'Até 17'], ['18a24', '18 a 24'], ['25a34', '25 a 34'],
  ['35a44', '35 a 44'], ['45a59', '45 a 59'], ['60mais', '60 ou mais'],
] as const

/** (73) 99826-0963 — só formata o que tem cara de telefone; o resto passa como veio */
function telefoneBonito(t: string | null | undefined): string {
  const d = (t ?? '').replace(/\D/g, '')
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`
  return t ?? ''
}
/** o link do WhatsApp só quando o número é de celular/fixo brasileiro completo */
function linkWhatsapp(t: string | null | undefined): string | null {
  const d = (t ?? '').replace(/\D/g, '')
  return d.length === 10 || d.length === 11 ? `https://wa.me/55${d}` : null
}
const cepBonito = (c: string | null | undefined) =>
  c && c.length === 8 ? `${c.slice(0, 5)}-${c.slice(5)}` : (c ?? '')
const cpfBonito = (c: string | null | undefined) => {
  const d = (c ?? '').replace(/\D/g, '')
  return d.length === 11 ? `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}` : (c ?? '')
}

/* ---------------------------------------------------------------- ficha */

const fichaId = ref<string | null>(null)
const ficha = ref<any>(null)
const fichaErro = ref('')

async function abrirFicha(id: string) {
  fichaId.value = id
  ficha.value = null
  fichaErro.value = ''
  try {
    ficha.value = await $fetch<any>(`/api/admin/clientes/${id}`)
  } catch (e: any) {
    fichaErro.value = e?.data?.statusMessage || 'Não consegui abrir a ficha. Tente de novo.'
  }
}
function fecharFicha() { fichaId.value = null; ficha.value = null }

const ROTULO_STATUS: Record<string, string> = {
  pago: 'Pago', aguardando_pagamento: 'Aguardando pagamento', em_analise: 'Em análise',
  expirado: 'Expirou sem pagar', cancelado: 'Cancelado', falhou: 'Pagamento falhou',
  estornado: 'Estornado', estornado_parcial: 'Estornado em parte',
}
const ROTULO_CANAL: Record<string, string> = { online: 'Site', bilheteria: 'Bilheteria', cortesia: 'Cortesia' }

/* ----------------------------------------------------------- planilha */

const exportando = ref(false)
const avisoExport = ref('')
const erroExport = ref('')

async function exportar() {
  exportando.value = true
  avisoExport.value = ''
  erroExport.value = ''
  try {
    const r = await $fetch<any>('/api/admin/clientes/exportar', { query: recorte.value })
    baixarCsv(`clientes-${diaLocal()}`,
      ['Nome', 'E-mail', 'Celular', 'Instagram', 'Cidade', 'UF', 'Idade', 'Aceita novidades',
       'Cliente desde', 'Pedidos', 'Total pago', 'Última compra'],
      r.linhas.map((c: any) => [
        c.nome, c.email, telefoneBonito(c.telefone), c.instagram ? `@${c.instagram}` : '',
        c.cidade ?? '', c.estado ?? '', c.idade ?? '', c.aceitaNovidades ? 'Sim' : 'Não',
        dataCurta(c.clienteDesde), c.pedidos, reais(c.gastoCents), dataCurta(c.ultimaCompraEm, ''),
      ]))
    avisoExport.value = `Planilha com ${r.total} cliente${r.total === 1 ? '' : 's'} baixada. `
      + 'A exportação fica registrada na Auditoria.'
  } catch (e: any) {
    erroExport.value = e?.data?.statusMessage || 'Não consegui gerar a planilha. Tente de novo.'
  } finally { exportando.value = false }
}

useHead({ title: 'Clientes' })
</script>

<template>
  <div>
    <div class="flex flex-wrap items-start justify-between gap-3 py-5">
      <div>
        <h1 class="titulo text-2xl font-semibold text-tinta">Clientes</h1>
        <p class="mt-1 text-tinta-suave">
          Quem já comprou ou tentou comprar — e como falar com essa pessoa.
        </p>
      </div>
      <button type="button" class="btn-secundario" :disabled="exportando || !total" @click="exportar">
        <IconeMenu nome="exportar" :tamanho="18" />
        {{ exportando ? 'Gerando…' : `Exportar ${total.toLocaleString('pt-BR')} ${total === 1 ? 'cliente' : 'clientes'}` }}
      </button>
    </div>

    <p v-if="avisoExport" class="faixa-aviso mb-3">{{ avisoExport }}</p>
    <p v-if="erroExport" class="faixa-erro mb-3">{{ erroExport }}</p>

    <template v-if="data">
      <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div class="card">
          <p class="rotulo-kpi">Clientes</p>
          <p class="numero-kpi mt-1">{{ data.resumo.total.toLocaleString('pt-BR') }}</p>
          <p class="mt-1 text-xs text-tinta-fraca">todos que passaram por aqui</p>
        </div>
        <div class="card">
          <p class="rotulo-kpi">Já compraram</p>
          <p class="numero-kpi mt-1">{{ data.resumo.compraram.toLocaleString('pt-BR') }}</p>
          <p class="mt-1 text-xs text-tinta-fraca">
            {{ data.resumo.total - data.resumo.compraram }} só tentaram
          </p>
        </div>
        <div class="card">
          <p class="rotulo-kpi">Cadastro completo</p>
          <p class="numero-kpi mt-1">{{ data.resumo.comCadastro.toLocaleString('pt-BR') }}</p>
          <p class="mt-1 text-xs text-tinta-fraca">
            preencheram o formulário do site · {{ data.resumo.comInstagram }} com Instagram
          </p>
        </div>
        <div class="card">
          <p class="rotulo-kpi">Aceitam novidades</p>
          <p class="numero-kpi mt-1">{{ data.resumo.aceitamNovidades.toLocaleString('pt-BR') }}</p>
          <p class="mt-1 text-xs text-tinta-fraca">podem receber divulgação</p>
        </div>
      </div>

      <!-- recorte -->
      <div class="card mt-4">
        <div class="flex flex-wrap items-end gap-3">
          <label class="block min-w-[14rem] flex-1">
            <span class="rotulo">Buscar</span>
            <input v-model.lazy="busca" type="search" class="campo"
                   placeholder="nome, e-mail, CPF, celular ou @instagram">
          </label>
          <label class="block">
            <span class="rotulo">Cidade</span>
            <select v-model="local" class="campo w-52">
              <option value="">Todas</option>
              <option v-for="c in data.cidades" :key="`${c.estado}|${c.cidade}`" :value="`${c.estado}|${c.cidade}`">
                {{ c.cidade }} — {{ c.estado }} ({{ c.clientes }})
              </option>
            </select>
          </label>
          <label class="block">
            <span class="rotulo">Idade</span>
            <select v-model="faixa" class="campo w-40">
              <option value="">Todas</option>
              <option v-for="f in FAIXAS" :key="f[0]" :value="f[0]">{{ f[1] }}</option>
            </select>
          </label>
          <label class="block">
            <span class="rotulo">Situação</span>
            <select v-model="situacao" class="campo w-44">
              <option value="">Todos</option>
              <option value="compraram">Já compraram</option>
              <option value="so_tentaram">Só tentaram</option>
            </select>
          </label>
          <label class="block">
            <span class="rotulo">Ordenar por</span>
            <select v-model="ordem" class="campo w-44">
              <option value="recentes">Mais recentes</option>
              <option value="nome">Nome</option>
              <option value="gasto">Quem mais gastou</option>
              <option value="compras">Mais compras</option>
            </select>
          </label>
        </div>

        <div class="mt-3 flex flex-wrap items-center gap-2 border-t border-linha pt-3">
          <button type="button" :class="novidades ? 'chip-ativo' : 'chip'" @click="novidades = !novidades">
            Aceitam novidades
          </button>
          <button type="button" :class="completo ? 'chip-ativo' : 'chip'" @click="completo = !completo">
            Cadastro completo
          </button>
          <button v-if="temFiltro" type="button" class="btn-secundario py-1.5" @click="limpar">
            Limpar filtros
          </button>
          <span class="text-xs text-tinta-fraca">
            Pra mandar divulgação, use só quem aceita novidades.
          </span>
        </div>
      </div>

      <p v-if="!data.itens.length" class="card mt-4 py-12 text-center text-tinta-suave">
        <template v-if="temFiltro">Nenhum cliente com esses filtros.</template>
        <template v-else>Ainda não há clientes. Eles aparecem aqui a partir da primeira compra.</template>
      </p>

      <div v-else class="card mt-4 p-0">
        <div class="overflow-x-auto">
          <table class="w-full min-w-[56rem] text-sm">
            <thead>
              <tr class="border-b border-linha text-left text-xs text-tinta-fraca">
                <th class="px-4 py-3 font-semibold">Cliente</th>
                <th class="px-3 py-3 font-semibold">Contato</th>
                <th class="px-3 py-3 font-semibold">Onde mora</th>
                <th class="px-3 py-3 text-right font-semibold">Idade</th>
                <th class="px-3 py-3 text-right font-semibold">Compras</th>
                <th class="px-4 py-3 text-right font-semibold">Última compra</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="c in data.itens" :key="c.id"
                  class="cursor-pointer border-b border-linha align-top last:border-0 hover:bg-fundo-cinza"
                  tabindex="0" @click="abrirFicha(c.id)" @keydown.enter="abrirFicha(c.id)">
                <td class="px-4 py-3">
                  <p class="font-medium text-tinta">{{ c.nome }}</p>
                  <p class="text-xs text-tinta-fraca">{{ c.email }}</p>
                  <p class="mt-1 flex flex-wrap gap-1">
                    <span v-if="c.cadastrado" class="selo-neutro">Cadastro completo</span>
                    <span v-if="c.aceitaNovidades" class="selo-ok">Aceita novidades</span>
                  </p>
                </td>
                <td class="px-3 py-3 text-tinta-suave">
                  <p v-if="c.telefone" class="tabular-nums">{{ telefoneBonito(c.telefone) }}</p>
                  <p v-if="c.instagram" class="text-xs">@{{ c.instagram }}</p>
                  <p v-if="!c.telefone && !c.instagram" class="text-tinta-fraca">—</p>
                </td>
                <td class="px-3 py-3 text-tinta-suave">
                  <template v-if="c.cidade">{{ c.cidade }} — {{ c.estado }}</template>
                  <template v-else><span class="text-tinta-fraca">—</span></template>
                </td>
                <td class="px-3 py-3 text-right tabular-nums text-tinta-suave">
                  {{ c.idade ?? '—' }}
                </td>
                <td class="px-3 py-3 text-right tabular-nums">
                  <template v-if="c.pedidos">
                    <p class="font-medium text-tinta">{{ reais(c.gastoCents) }}</p>
                    <p class="text-xs text-tinta-fraca">{{ c.pedidos }} {{ c.pedidos === 1 ? 'pedido' : 'pedidos' }}</p>
                  </template>
                  <span v-else class="text-tinta-fraca">só tentou</span>
                </td>
                <td class="px-4 py-3 text-right tabular-nums text-tinta-suave">
                  {{ dataCurta(c.ultimaCompraEm, '—') }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="flex flex-wrap items-center justify-between gap-2 border-t border-linha px-4 py-3">
          <p class="text-xs text-tinta-fraca">
            {{ primeiro.toLocaleString('pt-BR') }}–{{ ultimo.toLocaleString('pt-BR') }}
            de {{ total.toLocaleString('pt-BR') }}
          </p>
          <div class="flex gap-2">
            <button type="button" class="btn-secundario py-1.5" :disabled="pagina <= 1 || pending"
                    @click="pagina -= 1">Anterior</button>
            <button type="button" class="btn-secundario py-1.5" :disabled="!temProxima || pending"
                    @click="pagina += 1">Próxima</button>
          </div>
        </div>
      </div>
    </template>

    <p v-else-if="pending" class="card mt-6 text-tinta-suave">Carregando…</p>

    <div v-else class="card mt-6">
      <p class="rotulo-kpi text-erro">Não foi possível carregar os clientes</p>
      <p class="mt-1 text-sm text-tinta-suave">
        {{ (falha as any)?.data?.statusMessage || (falha as any)?.message || 'Erro desconhecido.' }}
      </p>
      <button type="button" class="btn-secundario mt-3" @click="refresh()">Tentar de novo</button>
    </div>

    <!-- ficha -->
    <ModalLateral v-if="fichaId" :titulo="ficha?.nome ?? 'Cliente'" largura="max-w-xl" @fechar="fecharFicha">
      <p v-if="fichaErro" class="faixa-erro">{{ fichaErro }}</p>
      <p v-else-if="!ficha" class="text-tinta-suave">Carregando…</p>

      <div v-else class="space-y-5 text-sm">
        <section>
          <p class="rotulo-kpi">Contato</p>
          <dl class="mt-2 grid grid-cols-[7rem_1fr] gap-y-1.5 text-tinta-suave">
            <dt>E-mail</dt>
            <dd class="break-all text-tinta">{{ ficha.email }}</dd>
            <dt>Celular</dt>
            <dd class="text-tinta">
              <template v-if="ficha.telefone">
                <span class="tabular-nums">{{ telefoneBonito(ficha.telefone) }}</span>
                <a v-if="linkWhatsapp(ficha.telefone)" :href="linkWhatsapp(ficha.telefone)!"
                   target="_blank" rel="noopener" class="ml-2 text-acao hover:underline">WhatsApp</a>
              </template>
              <template v-else>—</template>
            </dd>
            <dt>Instagram</dt>
            <dd class="text-tinta">
              <a v-if="ficha.instagram" :href="`https://instagram.com/${ficha.instagram}`"
                 target="_blank" rel="noopener" class="text-acao hover:underline">@{{ ficha.instagram }}</a>
              <template v-else>—</template>
            </dd>
          </dl>
        </section>

        <section>
          <p class="rotulo-kpi">Documento e idade</p>
          <dl class="mt-2 grid grid-cols-[7rem_1fr] gap-y-1.5 text-tinta-suave">
            <dt>CPF</dt>
            <dd class="tabular-nums text-tinta">{{ cpfBonito(ficha.cpf) || '—' }}</dd>
            <dt>Nascimento</dt>
            <dd class="text-tinta">
              <template v-if="ficha.nascimento">
                {{ dataCurta(ficha.nascimento) }} · {{ ficha.idade }} anos
              </template>
              <template v-else>—</template>
            </dd>
          </dl>
        </section>

        <section>
          <p class="rotulo-kpi">Onde mora</p>
          <p v-if="!ficha.endereco.cidade" class="mt-2 text-tinta-fraca">Não informou.</p>
          <p v-else class="mt-2 text-tinta">
            <template v-if="ficha.endereco.rua">
              {{ ficha.endereco.rua }}<template v-if="ficha.endereco.numero">, {{ ficha.endereco.numero }}</template>
              <template v-if="ficha.endereco.complemento"> — {{ ficha.endereco.complemento }}</template><br>
            </template>
            <template v-if="ficha.endereco.bairro">{{ ficha.endereco.bairro }} · </template>
            {{ ficha.endereco.cidade }} — {{ ficha.endereco.estado }}
            <template v-if="ficha.endereco.cep"><br><span class="tabular-nums text-tinta-suave">CEP {{ cepBonito(ficha.endereco.cep) }}</span></template>
          </p>
        </section>

        <section>
          <p class="rotulo-kpi">Cadastro e consentimento</p>
          <dl class="mt-2 grid grid-cols-[7rem_1fr] gap-y-1.5 text-tinta-suave">
            <dt>Novidades</dt>
            <dd class="text-tinta">
              <span v-if="ficha.aceitaNovidades" class="selo-ok">Aceita</span>
              <span v-else class="selo-neutro">Não aceitou</span>
              <span v-if="ficha.aceitaNovidadesEm" class="ml-2 text-xs text-tinta-fraca">
                desde {{ dataCurta(ficha.aceitaNovidadesEm) }}
              </span>
            </dd>
            <dt>Cadastro</dt>
            <dd class="text-tinta">
              <template v-if="ficha.cadastradoEm">Completo em {{ dataCurta(ficha.cadastradoEm) }}</template>
              <template v-else>Só os dados do ingresso</template>
            </dd>
            <dt>Senha</dt>
            <dd class="text-tinta">{{ ficha.temSenha ? 'Criou uma senha' : 'Não criou' }}</dd>
            <dt>Cliente desde</dt>
            <dd class="text-tinta">{{ dataCurta(ficha.criadoEm) }}</dd>
          </dl>
        </section>

        <section>
          <p class="rotulo-kpi">Pedidos ({{ ficha.pedidos.length }})</p>
          <p v-if="!ficha.pedidos.length" class="mt-2 text-tinta-fraca">Nenhum pedido.</p>
          <table v-else class="mt-2 w-full">
            <tbody>
              <tr v-for="o in ficha.pedidos" :key="o.id" class="border-b border-linha align-top last:border-0">
                <td class="py-2 pr-2">
                  <p class="font-mono text-xs text-tinta">{{ o.codigo }}</p>
                  <p class="text-xs text-tinta-fraca">{{ o.evento ?? 'Evento removido' }}</p>
                </td>
                <td class="py-2 pr-2 text-xs text-tinta-suave">
                  {{ ROTULO_STATUS[o.situacao] ?? o.situacao }}
                  <span class="block text-tinta-fraca">{{ ROTULO_CANAL[o.canal] ?? o.canal }} · {{ dataCurta(o.criadoEm) }}</span>
                </td>
                <td class="py-2 text-right tabular-nums text-tinta">{{ reais(o.totalCents) }}</td>
              </tr>
            </tbody>
          </table>
        </section>
      </div>

      <template #acoes>
        <button type="button" class="btn-secundario" @click="fecharFicha">Fechar</button>
      </template>
    </ModalLateral>
  </div>
</template>
