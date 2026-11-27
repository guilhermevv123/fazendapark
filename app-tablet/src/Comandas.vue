<script setup lang="ts">
/**
 * O app do tablet das Comandas (055): login e as telas do funcionário (Atender, Pagar e as
 * contas de hoje). Substitui a página `/comanda/<link>` do navegador, que saiu.
 *
 * O login é o MESMO do sistema: o e-mail e a senha que o gerente cria em Configurações →
 * Equipe (`POST /api/auth/entrar`, a sessão de sempre, no cookie). Quem pode usar as comandas,
 * e com que nível, o gerente dá em Comandas → Configurações → Equipe e regras; sem isso o
 * porteiro (`server/middleware/04.comandas.ts`) recusa e o app diz o porquê.
 *
 * As telas são as mesmas do site (`~/components/comanda/*`), com `noAppDoTablet` ligado.
 */
import { chamar, faixaLarga, mensagemDoErro, noAppDoTablet } from '~/composables/comandaOffline'
import CriarSenha from '~/components/CriarSenha.vue'
import ComandaSituacao from '~/components/comanda/Situacao.vue'
import ComandaAtender from '~/components/comanda/Atender.vue'
import ComandaPagar from '~/components/comanda/Pagar.vue'
import ComandaHoje from '~/components/comanda/Hoje.vue'
import LogoMarca from '~/components/LogoMarca.vue'
import OndasMarca from '~/components/OndasMarca.vue'
import Leitor from './Leitor.vue'
import { nfc } from './nfc'

noAppDoTablet.value = true
const route = useRoute()

/* ------------------------------------------------------------------ login */
const CHAVE_EMAIL = 'cp_comanda_email'
function lerEmail() { try { return localStorage.getItem(CHAVE_EMAIL) ?? '' } catch { return '' } }

/** 'conferindo': abrindo o app, vendo se a sessão do sistema ainda vale */
const etapa = ref<'conferindo' | 'login' | 'senha_nova' | 'dentro'>('conferindo')
const email = ref(lerEmail())
const senha = ref('')
const senhaProvisoria = ref('')
const erro = ref('')
const entrando = ref(false)
const quem = ref('')
const NIVEL: Record<string, string> = { atendente: 'Atendente', caixa: 'Caixa', gerente: 'Gerente' }
const nivel = ref('')

/** Com a sessão do sistema aberta, confere o acesso às comandas e entra. */
async function abrirComandas() {
  try {
    const e = await chamar<any>('/api/comandas/estado')
    quem.value = e.eu?.nome ?? ''
    nivel.value = NIVEL[e.eu?.nivel] ?? ''
    erro.value = ''
    etapa.value = 'dentro'
  } catch (e: any) {
    const status = Number(e?.statusCode ?? e?.status ?? e?.response?.status ?? 0)
    etapa.value = 'login'
    // 401 ao abrir o app = não tem sessão ainda: só mostra o login, sem erro
    if (status !== 401) erro.value = mensagemDoErro(e, 'Não consegui abrir as comandas agora. Veja a internet e tente de novo.')
  }
}

async function entrar() {
  if (entrando.value) return
  erro.value = ''
  entrando.value = true
  try {
    const r = await $fetch<any>('/api/auth/entrar', { method: 'POST', body: { email: email.value.trim(), senha: senha.value } })
    try { localStorage.setItem(CHAVE_EMAIL, email.value.trim()) } catch { /* sem storage */ }
    if (r?.trocarSenha) {
      // primeira entrada com a senha que o gerente sorteou: cria a própria antes de usar
      senhaProvisoria.value = senha.value
      quem.value = r.usuario?.nome ?? ''
      etapa.value = 'senha_nova'
    } else {
      await abrirComandas()
    }
  } catch (e: any) {
    erro.value = mensagemDoErro(e, 'Não consegui entrar agora. Veja a internet e tente de novo.')
  } finally {
    senha.value = ''
    entrando.value = false
  }
}

async function sair() {
  try { await $fetch('/api/auth/sair', { method: 'POST' }) } catch { /* sem rede: a sessão vence sozinha */ }
  quem.value = ''
  senhaProvisoria.value = ''
  erro.value = ''
  etapa.value = 'login'
}
// o servidor recusou no meio do turno (sessão vencida, acesso tirado): volta pro login
function recusado() {
  quem.value = ''
  etapa.value = 'login'
  erro.value = 'Sua entrada venceu. Entre de novo com o seu e-mail e senha.'
}

onMounted(() => {
  window.addEventListener('comanda:sair', recusado)
  abrirComandas()
})
onBeforeUnmount(() => window.removeEventListener('comanda:sair', recusado))

/* ------------------------------------------------------------------ abas */
const ABAS = [{ id: 'atender', nome: 'Atender' }, { id: 'pagar', nome: 'Pagar' }, { id: 'hoje', nome: 'Contas de hoje', curto: 'Hoje' }]
const aba = computed(() => ABAS.find((a) => a.id === route.query.aba)?.id ?? 'atender')
// o cabeçalho acompanha a largura da tela de baixo (o cardápio é largo), pra ficar alinhado
const coluna = computed(() => aba.value === 'atender' && faixaLarga.value ? 'max-w-6xl' : 'max-w-4xl')
/** tela "Leitor" (testar pulseira / acertar o NFC do tablet), no lugar do atendimento */
const vendoLeitor = ref(false)
</script>

<template>
  <div class="min-h-screen bg-fundo-cinza" style="padding-top: env(safe-area-inset-top)">
    <!-- LOGIN: o mesmo desenho do /entrar do site (o roxo da logo de um lado, o formulário do outro) -->
    <div v-if="etapa !== 'dentro'" class="grid min-h-screen bg-white lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
      <aside class="relative isolate hidden overflow-hidden bg-grape-950 lg:block">
        <div aria-hidden="true"
             class="absolute -inset-[20%] -z-10 animate-drift bg-[radial-gradient(40%_34%_at_28%_32%,rgb(79_198_219/0.55),transparent_70%),radial-gradient(36%_30%_at_74%_66%,rgb(143_212_234/0.32),transparent_70%),radial-gradient(26%_22%_at_58%_18%,rgb(253_185_42/0.2),transparent_70%)] blur-2xl" />
        <div aria-hidden="true" class="absolute inset-0 -z-10 bg-[linear-gradient(180deg,transparent_35%,rgb(27_19_48/0.9)_100%)]" />
        <OndasMarca class="absolute inset-x-0 bottom-0 -z-10 h-64 w-full text-white/[0.08]" />
        <div class="flex h-full flex-col justify-between p-12 xl:p-16">
          <LogoMarca clara class="h-14 self-start" />
          <div>
            <p class="titulo text-[46px] font-semibold leading-[1.02] tracking-[-0.03em] text-white xl:text-[56px]">
              Encostou a pulseira,<br>
              <span class="text-pool-300">está na conta.</span>
            </p>
            <p class="mt-6 max-w-md text-[15px] leading-7 text-white/70">
              Comandas do Conquista Park: abrir conta, lançar pedido e fechar a conta do cliente, tudo pela pulseira.
            </p>
          </div>
          <p class="text-[13px] text-white/55">Acesso restrito à equipe.</p>
        </div>
      </aside>

      <main class="flex min-h-screen flex-col px-5 py-6 sm:px-10" style="padding-top: max(1.5rem, env(safe-area-inset-top))">
        <LogoMarca class="h-10 self-start lg:hidden" />
        <div class="mx-auto flex w-full max-w-[400px] flex-1 flex-col justify-center py-10">
      <div v-if="etapa === 'conferindo'" class="py-10 text-center text-ink-600">Abrindo…</div>

      <CriarSenha v-else-if="etapa === 'senha_nova'" :provisoria="senhaProvisoria" :nome="quem"
                  class="animate-rise-in" @pronto="abrirComandas" />

      <form v-else class="grid animate-rise-in gap-5" data-tela="login" @submit.prevent="entrar">
        <div>
          <h1 class="titulo text-[30px] font-semibold tracking-[-0.02em] text-ink-900">Entrar</h1>
          <p class="mt-1 text-[15px] text-ink-600">Use o e-mail e a senha do seu acesso de equipe.</p>
        </div>

        <p v-if="erro" class="faixa-erro" role="alert">{{ erro }}</p>

        <div>
          <label for="email" class="rotulo">E-mail</label>
          <input id="email" v-model="email" type="email" autocomplete="username" required
                 inputmode="email" autocapitalize="none" spellcheck="false"
                 class="campo min-h-[52px] text-base" placeholder="voce@conquistapark.com.br">
        </div>
        <div>
          <label for="senha" class="rotulo">Senha</label>
          <input id="senha" v-model="senha" type="password" autocomplete="current-password" required
                 class="campo min-h-[52px] text-base">
        </div>

        <button type="submit" class="btn-primario min-h-[56px] text-lg" :disabled="entrando || !email.trim() || !senha">
          {{ entrando ? 'Entrando…' : 'Entrar' }}
        </button>
        <p class="text-[13px] text-ink-600">Não tem acesso ou esqueceu a senha? Fale com o gerente.</p>
      </form>
        </div>
      </main>
    </div>

    <!-- COMANDAS -->
    <template v-else>
      <header class="sticky top-0 z-30 border-b border-linha bg-white/95 backdrop-blur">
        <div class="mx-auto px-4" :class="coluna">
          <div class="flex items-center justify-between gap-3 py-3">
            <div class="flex min-w-0 items-center gap-2.5">
              <LogoMarca class="h-9 shrink-0" />
              <span class="hidden h-7 w-px bg-linha sm:block" aria-hidden="true" />
              <span class="hidden text-sm font-semibold text-ink-700 sm:block">Comandas</span>
            </div>
            <!-- tablet: as abas ficam no meio do cabeçalho -->
            <nav class="hidden rounded-card bg-ink-50 p-1 md:flex" aria-label="Comandas">
              <RouterLink v-for="a in ABAS" :key="a.id" :to="{ query: a.id === 'atender' ? {} : { aba: a.id } }" @click="vendoLeitor = false"
                          class="flex min-h-[48px] items-center whitespace-nowrap rounded-card px-6 text-base font-semibold transition"
                          :class="aba === a.id ? 'bg-white text-acao shadow-sm' : 'text-ink-600 hover:text-ink-900'">{{ a.nome }}</RouterLink>
            </nav>
            <div class="flex shrink-0 items-center gap-2">
              <span class="hidden text-right leading-tight sm:block">
                <span class="block text-sm font-semibold text-ink-900">{{ quem }}</span>
                <span class="block text-xs text-ink-600">{{ nivel }}</span>
              </span>
              <button type="button" class="btn-secundario min-h-[44px] px-3 text-sm" data-acao="leitor"
                      :class="nfc.existe.value && !nfc.ligado.value ? 'ring-danger-600 text-danger-600' : ''"
                      @click="vendoLeitor = !vendoLeitor">{{ nfc.existe.value && !nfc.ligado.value ? 'NFC desligado' : 'Leitor' }}</button>
              <button type="button" class="btn-secundario min-h-[44px] px-3 text-sm" @click="sair">Sair</button>
            </div>
          </div>
          <!-- celular: as abas ganham uma linha só delas -->
          <nav class="mb-3 grid grid-cols-3 gap-1 rounded-card bg-ink-50 p-1 md:hidden" aria-label="Comandas">
            <RouterLink v-for="a in ABAS" :key="a.id" :to="{ query: a.id === 'atender' ? {} : { aba: a.id } }" @click="vendoLeitor = false"
                        class="flex min-h-[44px] items-center justify-center rounded-card text-[15px] font-semibold transition"
                        :class="aba === a.id ? 'bg-white text-acao shadow-sm' : 'text-ink-600'">{{ a.curto ?? a.nome }}</RouterLink>
          </nav>
        </div>
      </header>

      <main class="mx-auto px-3 py-4 sm:px-4 sm:py-5" :class="coluna">
        <Leitor v-if="vendoLeitor" @fechar="vendoLeitor = false" />
        <ComandaSituacao v-else>
          <ComandaAtender v-if="aba === 'atender'" />
          <ComandaPagar v-else-if="aba === 'pagar'" />
          <ComandaHoje v-else />
        </ComandaSituacao>
      </main>
    </template>
  </div>
</template>
