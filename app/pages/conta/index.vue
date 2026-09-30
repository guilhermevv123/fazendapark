<script setup lang="ts">
/**
 * "Minha conta" de quem compra (034): os ingressos comprados COM a conta e os dados dela.
 *
 * Tudo é lido no navegador, depois de montar — o HTML que o servidor manda é o mesmo pra todo
 * mundo (sem nome, sem CPF), e o cache no caminho não tem o que entregar de um pro outro.
 *
 * `?volta=/e/<evento>/pagamento` é quem veio do checkout pelo "Editar": a tela mostra o caminho
 * de volta pra compra (o carrinho continua na aba).
 */
import { dataNoFuso, situacaoDoPedido } from '~/composables/carrinhoDaVitrine'
import {
  cpfLegivel, mascaraCep, mascaraTel, useContaDoCliente, type ContaNaTela,
} from '~/composables/contaDoCliente'
import { UFS } from '~~/server/utils/cadastro'

const route = useRoute()
const { estado, abrir, garantir, sair } = useContaDoCliente()
const conta = computed(() => estado.value.conta)

/** Só caminho DESTE site, e nunca uma rota da API (mesma régua do servidor: `destinoSeguroDoCliente`). */
const volta = computed(() => {
  const v = String(route.query.volta ?? '')
  return v.startsWith('/') && !v.startsWith('//') && !v.startsWith('/api/') ? v : null
})

const aba = ref<'ingressos' | 'dados'>(route.query.aba === 'dados' ? 'dados' : 'ingressos')

/* ------------------------------------------------------------ ingressos */
const pedidos = ref<any[] | null>(null)
const falhaDosPedidos = ref('')
async function buscarPedidos() {
  falhaDosPedidos.value = ''
  try {
    pedidos.value = (await $fetch<any>('/api/conta/ingressos')).pedidos ?? []
  } catch (e: any) {
    console.error('[conta] não deu pra listar os pedidos', e?.data ?? e)
    falhaDosPedidos.value = 'Não deu pra carregar os seus ingressos agora. Confira a internet e tente de novo.'
  }
}
const proximos = computed(() => (pedidos.value ?? []).filter((p) => !passou(p)))
const anteriores = computed(() => (pedidos.value ?? []).filter((p) => passou(p)))
function passou(p: any) {
  const inicio = new Date(p.evento?.inicio ?? 0).getTime()
  // o evento de hoje continua em "próximos" até o dia virar
  return Number.isFinite(inicio) && inicio + 24 * 3600_000 < Date.now()
}

/* ------------------------------------------------- confirmar o e-mail (035) */
const reenvio = ref<{ enviando: boolean; recado: string; erro: boolean }>({ enviando: false, recado: '', erro: false })
async function reenviarConfirmacao() {
  reenvio.value = { enviando: true, recado: '', erro: false }
  try {
    const r = await $fetch<any>('/api/conta/email/reenviar', { method: 'POST' })
    reenvio.value = {
      enviando: false, erro: false,
      recado: r.jaConfirmado ? 'Seu e-mail já está confirmado.' : `Mandamos o link para ${r.email}. Confira também o spam.`,
    }
  } catch (e: any) {
    reenvio.value = { enviando: false, erro: true, recado: e?.data?.statusMessage || 'Não deu pra mandar agora. Tente de novo.' }
  }
}

/* ---------------------------------------------------------------- dados */
const dados = reactive({
  nome: '', email: '', telefone: '', instagram: '', cep: '', cidade: '', estado: '', aceitaNovidades: false,
})
const salvando = ref(false)
const salvo = ref(false)
const erro = ref('')
const campoComErro = ref('')
const marca = (campo: string) => (campoComErro.value === campo ? 'ring-2 ring-danger-600' : '')
const invalido = (campo: string) => (campoComErro.value === campo ? 'true' : undefined)

function copiarDaConta(c: ContaNaTela) {
  Object.assign(dados, {
    nome: c.nome, email: c.email, telefone: mascaraTel(c.telefone), instagram: c.instagram ? `@${c.instagram}` : '',
    cep: mascaraCep(c.endereco?.cep ?? ''), cidade: c.endereco?.cidade ?? '', estado: c.endereco?.estado ?? '',
    aceitaNovidades: c.aceitaNovidades,
  })
}

async function salvar() {
  erro.value = ''
  campoComErro.value = ''
  salvo.value = false
  salvando.value = true
  try {
    const r = await $fetch<any>('/api/conta/eu', {
      method: 'PATCH',
      body: {
        nome: dados.nome, email: dados.email, telefone: dados.telefone,
        instagram: dados.instagram || null,
        endereco: dados.cidade || dados.estado || dados.cep
          ? { cep: dados.cep, cidade: dados.cidade, estado: dados.estado }
          : null,
        aceitaNovidades: dados.aceitaNovidades,
      },
    })
    estado.value = { ...estado.value, conta: r.conta }
    copiarDaConta(r.conta)
    salvo.value = true
  } catch (e: any) {
    erro.value = e?.data?.statusMessage || 'Não deu pra salvar agora. Confira a internet e tente de novo.'
    campoComErro.value = e?.data?.data?.campo || ''
    if (e?.data?.data?.tipo === 'conta' && e?.statusCode === 401) {
      estado.value = { ...estado.value, conta: null }
      abrir('entrar', 'Sua sessão terminou. Entre de novo para salvar.')
    }
  } finally { salvando.value = false }
}

async function buscarCep() {
  const cep = dados.cep.replace(/\D/g, '')
  if (cep.length !== 8) return
  try {
    const r: any = await $fetch(`https://viacep.com.br/ws/${cep}/json/`)
    if (dados.cep.replace(/\D/g, '') !== cep || r?.erro) return
    dados.cidade = r.localidade || dados.cidade
    dados.estado = r.uf || dados.estado
  } catch { /* sem CEP, a pessoa digita a cidade */ }
}

async function sairDaConta() {
  await sair()
  pedidos.value = null
  navigateTo('/')
}

onMounted(async () => {
  const s = await garantir(null)
  if (!s.conta) return void abrir('entrar', 'Entre para ver os seus ingressos.')
})
// a conta entrou (agora, ou pela janela): carrega o que é dela
watch(conta, (c) => {
  if (!c) return
  copiarDaConta(c)
  if (pedidos.value === null) void buscarPedidos()
}, { immediate: true })

const statusDoPedido = (p: any) => situacaoDoPedido(p.status)
const quando = (p: any) => dataNoFuso(p.evento?.inicio, p.evento?.fuso)

useHead({ title: 'Minha conta' })
</script>

<template>
  <div class="min-h-screen">
    <CabecalhoPublico largura="max-w-3xl">
      <NuxtLink to="/#ingressos" class="hidden rounded-lg px-3 py-2 font-semibold text-ink-700 transition-colors hover:bg-ink-100 hover:text-ink-900 sm:inline-flex">
        Ingressos
      </NuxtLink>
    </CabecalhoPublico>

    <main class="mx-auto max-w-3xl px-4 pb-16 pt-6 sm:px-6">
      <NuxtLink v-if="volta" :to="volta" class="text-sm font-semibold text-acao hover:underline">
        ← Voltar para a compra
      </NuxtLink>

      <div v-if="!estado.carregada" class="card mt-4 h-40 animate-pulse bg-ink-50" aria-busy="true" aria-label="Carregando" />

      <!-- ------------------------------------------------ fora da conta -->
      <section v-else-if="!conta" class="card mt-4 py-10 text-center">
        <h1 class="titulo text-2xl font-semibold text-tinta">Minha conta</h1>
        <p class="mx-auto mt-2 max-w-sm text-tinta-suave">
          Entre para ver os seus ingressos e os seus dados. Ainda não tem conta? Crie em menos de um minuto.
        </p>
        <div class="mx-auto mt-6 grid max-w-sm gap-2 sm:grid-cols-2">
          <button type="button" class="btn-cta py-3" @click="abrir('entrar', null)">Entrar</button>
          <button type="button" class="btn-secundario py-3" @click="abrir('criar', null)">Criar conta</button>
        </div>
      </section>

      <!-- ------------------------------------------------- dentro da conta -->
      <template v-else>
        <div class="mt-3 flex items-end justify-between gap-3">
          <div class="min-w-0">
            <p class="text-sm text-tinta-suave">Minha conta</p>
            <h1 class="titulo truncate text-2xl font-semibold text-tinta">Olá, {{ conta.primeiroNome }}</h1>
          </div>
          <button type="button" class="shrink-0 rounded-md px-3 py-2 text-sm font-semibold text-tinta-suave transition-colors hover:bg-ink-100 hover:text-tinta"
                  data-parte="sair-da-conta" @click="sairDaConta">
            Sair
          </button>
        </div>

        <!-- e-mail ainda não confirmado (035): não trava nada, mas é por ele que o ingresso chega -->
        <div v-if="conta.emailConfirmado === false" class="faixa-aviso mt-4" data-parte="confirmar-email">
          <p>
            <strong>Confirme o seu e-mail.</strong> Mandamos um link para <strong>{{ conta.email }}</strong> —
            é por esse e-mail que chegam os seus ingressos.
          </p>
          <p v-if="reenvio.recado" class="mt-1" :class="reenvio.erro ? 'font-semibold text-erro' : ''" role="status">
            {{ reenvio.recado }}
          </p>
          <button v-else type="button" class="mt-1 font-semibold text-acao underline" :disabled="reenvio.enviando"
                  data-parte="reenviar-confirmacao" @click="reenviarConfirmacao">
            {{ reenvio.enviando ? 'Enviando…' : 'Mandar o link de novo' }}
          </button>
        </div>

        <div class="mt-5 grid grid-cols-2 gap-1 rounded-xl bg-ink-100 p-1" role="tablist" aria-label="Minha conta">
          <button type="button" role="tab" :aria-selected="aba === 'ingressos'"
                  class="min-h-[42px] rounded-lg text-sm font-semibold transition-colors"
                  :class="aba === 'ingressos' ? 'bg-white text-tinta shadow-sm' : 'text-ink-600 hover:text-ink-900'"
                  @click="aba = 'ingressos'">
            Meus ingressos
          </button>
          <button type="button" role="tab" :aria-selected="aba === 'dados'"
                  class="min-h-[42px] rounded-lg text-sm font-semibold transition-colors"
                  :class="aba === 'dados' ? 'bg-white text-tinta shadow-sm' : 'text-ink-600 hover:text-ink-900'"
                  @click="aba = 'dados'">
            Meus dados
          </button>
        </div>

        <!-- ---------------------------------------------- meus ingressos -->
        <section v-if="aba === 'ingressos'" class="mt-5" data-parte="meus-ingressos">
          <div v-if="falhaDosPedidos" class="faixa-erro" role="alert">
            <p>{{ falhaDosPedidos }}</p>
            <button type="button" class="btn-secundario mt-2 py-2" @click="buscarPedidos">Tentar de novo</button>
          </div>
          <div v-else-if="pedidos === null" class="space-y-3" aria-busy="true" aria-label="Carregando os ingressos">
            <div class="card h-24 animate-pulse bg-ink-50" />
            <div class="card h-24 animate-pulse bg-ink-50" />
          </div>
          <div v-else-if="!pedidos.length" class="card py-10 text-center">
            <p class="titulo text-lg font-semibold text-tinta">Você ainda não tem ingressos</p>
            <p class="mt-1 text-sm text-tinta-suave">O que você comprar com esta conta aparece aqui, com o QR da entrada.</p>
            <NuxtLink to="/#ingressos" class="btn-cta mt-5 inline-flex px-6 py-3">Ver os eventos</NuxtLink>
          </div>
          <template v-else>
            <template v-for="grupo in [{ titulo: 'Próximos', lista: proximos }, { titulo: 'Anteriores', lista: anteriores }]" :key="grupo.titulo">
              <h2 v-if="grupo.lista.length" class="rotulo-kpi mb-2 mt-5 first:mt-0">{{ grupo.titulo }}</h2>
              <ul v-if="grupo.lista.length" class="space-y-3">
                <li v-for="p in grupo.lista" :key="p.codigo">
                  <NuxtLink :to="`/ingressos/${p.codigo}`"
                            class="card flex items-stretch gap-4 overflow-hidden p-0 transition-shadow hover:shadow-md">
                    <div class="w-24 shrink-0 bg-pool-100 sm:w-32">
                      <img v-if="p.evento.banner" :src="p.evento.banner" alt="" class="h-full w-full object-cover" loading="lazy">
                    </div>
                    <div class="min-w-0 flex-1 py-3 pr-4">
                      <p class="truncate font-semibold text-tinta">{{ p.evento.nome }}</p>
                      <p class="text-sm text-tinta-suave">{{ quando(p) }}</p>
                      <div class="mt-2 flex flex-wrap items-center gap-2 text-xs">
                        <span :class="statusDoPedido(p).selo.classe">{{ statusDoPedido(p).selo.texto }}</span>
                        <span v-if="p.ingressos" class="text-tinta-suave">
                          {{ p.ingressos }} {{ p.ingressos === 1 ? 'ingresso' : 'ingressos' }}
                          <template v-if="p.usados"> · {{ p.usados }} já {{ p.usados === 1 ? 'usado' : 'usados' }}</template>
                        </span>
                        <span class="text-tinta-fraca">· {{ p.totalCents ? reais(p.totalCents) : 'Grátis' }}</span>
                      </div>
                    </div>
                    <span class="grid shrink-0 place-items-center pr-4 text-acao" aria-hidden="true">
                      <svg viewBox="0 0 20 20" class="h-5 w-5" fill="currentColor"><path d="M7.3 4.3a1 1 0 0 1 1.4 0l5 5a1 1 0 0 1 0 1.4l-5 5a1 1 0 1 1-1.4-1.4L11.6 10 7.3 5.7a1 1 0 0 1 0-1.4z" /></svg>
                    </span>
                  </NuxtLink>
                </li>
              </ul>
            </template>
          </template>
        </section>

        <!-- -------------------------------------------------- meus dados -->
        <section v-else class="card mt-5" data-parte="meus-dados">
          <form class="space-y-4" novalidate @submit.prevent="salvar">
            <div>
              <label for="dados-nome" class="rotulo">Nome completo</label>
              <input id="dados-nome" v-model="dados.nome" autocomplete="name" maxlength="120" class="campo"
                     :class="marca('nome')" :aria-invalid="invalido('nome')">
            </div>
            <div class="grid gap-4 sm:grid-cols-2">
              <div>
                <span class="rotulo">CPF</span>
                <p class="campo cursor-not-allowed bg-ink-50 tabular-nums text-tinta-suave">{{ cpfLegivel(conta.cpf) }}</p>
                <p class="mt-1 text-xs text-tinta-fraca">O CPF não muda: ele identifica os seus ingressos.</p>
              </div>
              <div>
                <label for="dados-telefone" class="rotulo">Celular (WhatsApp)</label>
                <input id="dados-telefone" :value="dados.telefone" inputmode="numeric" autocomplete="tel"
                       class="campo tabular-nums" :class="marca('telefone')" :aria-invalid="invalido('telefone')"
                       @input="dados.telefone = mascaraTel(($event.target as HTMLInputElement).value)">
              </div>
            </div>
            <div>
              <label for="dados-email" class="rotulo">E-mail</label>
              <input id="dados-email" v-model="dados.email" type="email" autocomplete="email" maxlength="160"
                     class="campo" :class="marca('email')" :aria-invalid="invalido('email')">
              <p class="mt-1 text-xs text-tinta-fraca">É pra onde vão os ingressos.</p>
            </div>
            <div class="border-t border-linha pt-4">
              <p class="titulo text-base font-semibold text-tinta">Opcional</p>
            </div>
            <div>
              <label for="dados-instagram" class="rotulo">Instagram</label>
              <input id="dados-instagram" v-model="dados.instagram" placeholder="@seunome" autocapitalize="none"
                     maxlength="60" class="campo" :class="marca('instagram')" :aria-invalid="invalido('instagram')">
            </div>
            <div class="grid grid-cols-[1fr_5.5rem] gap-3 sm:grid-cols-[9rem_1fr_6rem]">
              <div class="col-span-2 sm:col-span-1">
                <label for="dados-cep" class="rotulo">CEP</label>
                <input id="dados-cep" :value="dados.cep" inputmode="numeric" placeholder="00000-000"
                       autocomplete="postal-code" class="campo tabular-nums" :class="marca('cep')"
                       :aria-invalid="invalido('cep')"
                       @input="dados.cep = mascaraCep(($event.target as HTMLInputElement).value); buscarCep()">
              </div>
              <div>
                <label for="dados-cidade" class="rotulo">Cidade</label>
                <input id="dados-cidade" v-model="dados.cidade" autocomplete="address-level2" maxlength="80"
                       class="campo" :class="marca('cidade')" :aria-invalid="invalido('cidade')">
              </div>
              <div>
                <label for="dados-estado" class="rotulo">UF</label>
                <select id="dados-estado" v-model="dados.estado" class="campo" :class="marca('estado')"
                        :aria-invalid="invalido('estado')">
                  <option value="">—</option>
                  <option v-for="uf in UFS" :key="uf" :value="uf">{{ uf }}</option>
                </select>
              </div>
            </div>
            <label class="flex items-start gap-2.5 text-sm text-tinta-corpo">
              <input v-model="dados.aceitaNovidades" type="checkbox" class="mt-1 h-4 w-4 accent-pool-600">
              <span>Quero receber novidades e ofertas do parque por WhatsApp, e-mail e Instagram.</span>
            </label>

            <p v-if="erro" class="faixa-erro" role="alert">{{ erro }}</p>
            <p v-else-if="salvo" class="rounded-card border border-ok/40 bg-ok-claro p-3 text-sm text-ok" role="status">
              Dados salvos.
            </p>
            <button type="submit" class="btn-primario w-full py-3 sm:w-auto sm:px-8" :disabled="salvando">
              {{ salvando ? 'Salvando…' : 'Salvar meus dados' }}
            </button>
          </form>
        </section>
      </template>
    </main>
  </div>
</template>
