<script setup lang="ts">
/**
 * O rodapé do site de vendas — o `SiteFooter` do sistema do parque, agora com QUEM VENDE.
 *
 * O site vendia sem razão social, CNPJ, endereço, contato, termos, privacidade e arrependimento
 * (auditoria PROD-08; Decreto 7.962/2013, arts. 2º e 5º; CDC art. 49; LGPD). Os dados da empresa
 * vêm do banco (`/api/organizacao-publica`), preenchidos pelo master em Configurações — **nada
 * aqui é escrito à mão**: linha sem dado não aparece (nunca "a preencher" pro público, nunca um
 * número inventado). Os links de termos, privacidade e cancelamento ficam sempre: as páginas
 * existem e explicam o que vale mesmo com o cadastro incompleto.
 *
 * `cidade` continua vindo da home (a cidade do evento em destaque), pra quem já usava assim.
 */
import { formatarDocumento, linhaDeContatoOuNada, linhasDoEndereco } from '~/composables/dadosDaEmpresa'

defineProps<{ cidade?: string }>()
const ano = new Date().getFullYear()

const { data: empresa } = useFetch<any>('/api/organizacao-publica', { key: 'organizacao-publica' })

const nomeLegal = computed(() => empresa.value?.razaoSocial ?? empresa.value?.nome ?? 'Conquista Park')
const documento = computed(() => {
  const d = empresa.value?.documento
  if (!d) return null
  return `${String(d).length === 11 ? 'CPF' : 'CNPJ'} ${formatarDocumento(d)}`
})
const endereco = computed(() => linhasDoEndereco(empresa.value?.endereco))
const email = computed(() => linhaDeContatoOuNada('email', empresa.value?.email))
const telefone = computed(() => linhaDeContatoOuNada('telefone', empresa.value?.telefone))

const LEGAIS = [
  { para: '/termos', texto: 'Termos de uso e de compra' },
  { para: '/privacidade', texto: 'Privacidade (LGPD)' },
  { para: '/cancelamento', texto: 'Cancelamento e reembolso' },
]
</script>

<template>
  <footer class="bg-ink-950 text-white print:hidden" data-parte="rodape-publico">
    <div class="mx-auto grid max-w-6xl gap-10 px-4 py-12 sm:px-6 md:grid-cols-[1.3fr_1fr_1fr]">
      <div class="grid content-start gap-4">
        <LogoMarca clara class="h-10" />
        <p class="max-w-xs text-sm leading-6 text-ink-300">
          Parque aquático para passar o dia em família. Compre o ingresso pelo
          site e entre com o QR Code no celular.
        </p>
      </div>

      <div class="grid content-start gap-3">
        <p class="text-xs font-semibold uppercase tracking-[0.14em] text-ink-300">Visite</p>
        <p v-if="cidade" class="flex gap-2 text-sm leading-6 text-ink-200">
          <svg class="mt-1 size-4 shrink-0 text-pool-400" viewBox="0 0 24 24" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0" />
            <circle cx="12" cy="10" r="3" />
          </svg>
          <span>{{ cidade }}</span>
        </p>
        <NuxtLink to="/#ingressos" class="w-fit py-1 text-sm text-ink-200 transition-colors hover:text-white">
          Ingressos e datas
        </NuxtLink>
        <NuxtLink v-for="l in LEGAIS" :key="l.para" :to="l.para"
                  class="w-fit py-1 text-sm text-ink-200 transition-colors hover:text-white">
          {{ l.texto }}
        </NuxtLink>
      </div>

      <!-- Atendimento: só aparece o que o master cadastrou. Sem nenhum canal, a coluna some e a
           página de cancelamento explica o caminho (ver /cancelamento). -->
      <div v-if="email || telefone" class="grid content-start gap-3" data-parte="atendimento">
        <p class="text-xs font-semibold uppercase tracking-[0.14em] text-ink-300">Atendimento</p>
        <a v-if="email" :href="email.href" class="w-fit break-all py-1 text-sm text-ink-200 transition-colors hover:text-white">
          {{ email.texto }}
        </a>
        <a v-if="telefone" :href="telefone.href" class="w-fit py-1 text-sm text-ink-200 transition-colors hover:text-white">
          {{ telefone.texto }}
        </a>
      </div>
    </div>

    <div class="border-t border-white/10">
      <div class="mx-auto flex max-w-6xl flex-col gap-3 px-4 py-5 text-xs leading-5 text-ink-300 sm:flex-row sm:items-end sm:justify-between sm:px-6">
        <!-- quem vende (Decreto 7.962/2013, art. 2º): nome empresarial, documento e endereço -->
        <div data-parte="quem-vende">
          <p>© {{ ano }} {{ nomeLegal }}<template v-if="documento"> · {{ documento }}</template></p>
          <p v-for="(l, i) in endereco" :key="i">{{ l }}</p>
        </div>
        <NuxtLink to="/entrar" class="w-fit shrink-0 py-1 transition-colors hover:text-white">Área da equipe</NuxtLink>
      </div>
    </div>
  </footer>
</template>
