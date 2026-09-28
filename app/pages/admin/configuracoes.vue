<script setup lang="ts">
/**
 * Dados e cobrança — o cadastro da organização, os dados da empresa que o site mostra e a ligação
 * com o Asaas.
 *
 * A chave do Asaas tem campo de escrita e nenhum de leitura: ela entra, não sai. A tela mostra só o
 * fim dela pra conferência ("…4f9c2a"), que é o que alguém compara com o painel do Asaas pra ter
 * certeza de que é a certa.
 *
 * ## Dados da empresa (27/09 — auditoria PROD-08)
 *
 * O Decreto 7.962/2013 (comércio eletrônico) pede que a página de venda mostre quem vende: razão
 * social, CNPJ, endereço e um canal de atendimento. Esses dados moram AQUI, preenchidos pelo master,
 * e o rodapé do site, os Termos, a Privacidade e a página de Cancelamento leem do banco
 * (`/api/organizacao-publica`). Nada é inventado: campo vazio aparece como "a preencher" nesta tela e
 * o site simplesmente não mostra a linha.
 */
import {
  documentoDaEmpresaValido, ehDocumentoDeExemplo, formatarCep, formatarDocumento, formatarTelefoneBR,
  linhasDoEndereco, mascaraDocumento, somenteDigitos,
} from '~/composables/dadosDaEmpresa'
import PainelFalha from '~/components/painel/Falha.vue'
import { onBeforeRouteLeave } from 'vue-router'

definePageMeta({ layout: 'admin' })

const { data, refresh, pending, error: falha } = await useFetch<any>('/api/admin/organizacao')

const erro = ref('')
const aviso = ref('')
const salvando = ref(false)

const f = reactive({
  nome: '', documento: '', ambienteAsaas: 'sandbox', carteiraAsaas: '',
  razaoSocial: '', enderecoLinha: '', enderecoBairro: '', enderecoCidade: '', enderecoUf: '', enderecoCep: '',
  emailAtendimento: '', telefoneAtendimento: '', encarregadoDados: '',
})

/** para onde a cobrança VAI (prefixo da chave), não o que o `<select>` diz — ORG-01 */
const ambienteMostrado = computed(() => data.value?.ambienteEfetivo ?? data.value?.ambienteAsaas)
const chaveNova = ref('')
const trocandoChave = ref(false)
/** "Remover" a chave em dois passos: apagar a credencial de cobrança num clique solto não tem desfazer. */
const confirmandoRemocao = ref(false)

/**
 * A chave colada conta quando a pessoa está TROCANDO uma existente — ou
 * quando ainda não existe nenhuma. Só `trocandoChave` deixava a PRIMEIRA
 * chave de fora: com `temChave: false` o campo aparece aberto, mas colar não
 * habilitava Salvar, e trocar pra Produção mandava o PATCH sem ela (422).
 */
const chaveParaEnviar = computed(() =>
  (trocandoChave.value || !data.value?.temChave) && chaveNova.value.trim().length >= 20
    ? chaveNova.value.trim()
    : null)
/** CFG-01: colou pedaço de chave — o Salvar não acendia e ninguém dizia por quê */
const chaveCurta = computed(() => {
  const t = chaveNova.value.trim()
  return t.length > 0 && t.length < 20
})

/** o que veio do servidor, na forma do formulário (a comparação de "mudou" é com isto) */
function doServidor(d: any) {
  return {
    nome: d.nome ?? '', documento: d.documento ? mascaraDocumento(d.documento) : '',
    ambienteAsaas: d.ambienteAsaas, carteiraAsaas: d.carteiraAsaas ?? '',
    razaoSocial: d.razaoSocial ?? '',
    enderecoLinha: d.endereco?.linha ?? '', enderecoBairro: d.endereco?.bairro ?? '',
    enderecoCidade: d.endereco?.cidade ?? '', enderecoUf: d.endereco?.uf ?? '',
    enderecoCep: d.endereco?.cep ? formatarCep(d.endereco.cep) : '',
    emailAtendimento: d.emailAtendimento ?? '',
    telefoneAtendimento: d.telefoneAtendimento ? formatarTelefoneBR(d.telefoneAtendimento) : '',
    encarregadoDados: d.encarregadoDados ?? '',
  }
}
const original = computed(() => (data.value ? doServidor(data.value) : null))
watch(data, (d) => { if (d) Object.assign(f, doServidor(d)) }, { immediate: true })

/** o documento só como o banco guarda (dígitos e letras do CNPJ alfanumérico) — pra comparar */
const docCru = (v: string) => v.toUpperCase().replace(/[^0-9A-Z]/g, '')
const CAMPOS_DE_TEXTO = ['nome', 'razaoSocial', 'enderecoLinha', 'enderecoBairro', 'enderecoCidade', 'enderecoUf',
  'emailAtendimento', 'encarregadoDados', 'carteiraAsaas'] as const
const mudancas = computed(() => {
  const o = original.value
  if (!o) return {}
  const corpo: Record<string, any> = {}
  for (const k of CAMPOS_DE_TEXTO) {
    if (f[k].trim() !== o[k].trim()) corpo[k] = f[k].trim() || null
  }
  if (corpo.nome === null) delete corpo.nome // nome não se apaga: a rota exige
  if (docCru(f.documento) !== docCru(o.documento)) corpo.documento = docCru(f.documento) || null
  if (somenteDigitos(f.enderecoCep) !== somenteDigitos(o.enderecoCep)) corpo.enderecoCep = somenteDigitos(f.enderecoCep) || null
  if (somenteDigitos(f.telefoneAtendimento) !== somenteDigitos(o.telefoneAtendimento)) {
    corpo.telefoneAtendimento = somenteDigitos(f.telefoneAtendimento) || null
  }
  if (f.ambienteAsaas !== o.ambienteAsaas) corpo.ambienteAsaas = f.ambienteAsaas
  if (chaveParaEnviar.value) corpo.chaveAsaas = chaveParaEnviar.value
  return corpo
})
const mudou = computed(() => Object.keys(mudancas.value).length > 0)

/**
 * Edição que ainda não foi salva (matriz da auditoria, "F5 — edição não salva": perdia calada).
 * Conta também a chave colada pela metade — ela não vira mudança (`chaveParaEnviar` é nula), mas
 * sumir com o F5 é perder o que a pessoa colou.
 */
const naoSalvo = computed(() => !salvando.value && (mudou.value || chaveNova.value.trim().length > 0))
const PERGUNTA_AO_SAIR = 'Tem alteração não salva em Dados e cobrança. Sair mesmo assim?'
/** F5, fechar a aba, digitar outro endereço: o navegador pergunta (a frase é a dele) */
function avisarAntesDeDescarregar(e: BeforeUnloadEvent) {
  if (!naoSalvo.value) return
  e.preventDefault()
  e.returnValue = ''
}
onMounted(() => window.addEventListener('beforeunload', avisarAntesDeDescarregar))
onBeforeUnmount(() => window.removeEventListener('beforeunload', avisarAntesDeDescarregar))
/** clique no menu do painel com edição pendente: a mesma pergunta, dentro do painel */
onBeforeRouteLeave(() => (naoSalvo.value && !window.confirm(PERGUNTA_AO_SAIR) ? false : undefined))

/**
 * CFG-02 e o resto do formato, conferidos ANTES de mandar (a rota confere de novo e é quem decide —
 * isto aqui é pra frase aparecer ao lado do campo, na hora).
 */
const problemas = computed(() => {
  const p: Record<string, string> = {}
  if (f.documento.trim() && !documentoDaEmpresaValido(f.documento)) p.documento = 'O número não confere (dígito verificador errado). Copie do cartão do CNPJ.'
  if (f.enderecoUf.trim() && !/^[A-Za-z]{2}$/.test(f.enderecoUf.trim())) p.enderecoUf = 'Duas letras (ex.: BA).'
  const cep = somenteDigitos(f.enderecoCep)
  if (f.enderecoCep.trim() && cep.length !== 8) p.enderecoCep = 'São 8 números (ex.: 45000-000).'
  const tel = somenteDigitos(f.telefoneAtendimento)
  if (f.telefoneAtendimento.trim() && !/^\d{10,11}$/.test(tel)) p.telefoneAtendimento = 'Com DDD, só números (ex.: (73) 99999-9999).'
  if (f.emailAtendimento.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.emailAtendimento.trim())) p.emailAtendimento = 'E-mail em formato errado.'
  if (!f.nome.trim() || f.nome.trim().length < 2) p.nome = 'O nome precisa de pelo menos 2 letras.'
  return p
})
const temProblema = computed(() => Object.keys(problemas.value).length > 0)

/** máscara enquanto digita — a vírgula e o ponto aparecem sozinhos */
function aoDigitarDocumento(ev: Event) {
  f.documento = mascaraDocumento((ev.target as HTMLInputElement).value)
}
function aoSairDoCep() { if (somenteDigitos(f.enderecoCep).length === 8) f.enderecoCep = formatarCep(f.enderecoCep) }
function aoSairDoTelefone() { f.telefoneAtendimento = formatarTelefoneBR(f.telefoneAtendimento) }
function aoSairDaUf() { f.enderecoUf = f.enderecoUf.trim().toUpperCase() }

/** o que o site mostra hoje, montado com as MESMAS funções do rodapé */
const previa = computed(() => {
  const nomeLegal = f.razaoSocial.trim() || f.nome.trim()
  const doc = documentoDaEmpresaValido(f.documento) && !ehDocumentoDeExemplo(f.documento) ? formatarDocumento(f.documento) : ''
  const endereco = linhasDoEndereco({
    linha: f.enderecoLinha.trim() || null, bairro: f.enderecoBairro.trim() || null, cidade: f.enderecoCidade.trim() || null,
    uf: f.enderecoUf.trim().toUpperCase() || null, cep: somenteDigitos(f.enderecoCep) || null,
  })
  return { nomeLegal, doc, endereco }
})
const vazios = computed(() => [
  !f.razaoSocial.trim() && 'razão social', (!f.documento.trim() || ehDocumentoDeExemplo(f.documento)) && 'CNPJ',
  !(f.enderecoLinha.trim() && f.enderecoCidade.trim()) && 'endereço',
  !(f.emailAtendimento.trim() || f.telefoneAtendimento.trim()) && 'um canal de atendimento',
].filter(Boolean) as string[])

async function salvar() {
  if (temProblema.value || !mudou.value || salvando.value) return
  erro.value = ''
  aviso.value = ''
  salvando.value = true
  try {
    await $fetch('/api/admin/organizacao', { method: 'PATCH', body: mudancas.value })
    chaveNova.value = ''
    trocandoChave.value = false
    await refresh()
    aviso.value = 'Salvo.'
    setTimeout(() => { aviso.value = '' }, 2500)
  } catch (e: any) {
    erro.value = e?.data?.statusMessage || 'Não foi possível salvar.'
  } finally {
    salvando.value = false
  }
}

async function removerChave() {
  // primeiro clique só arma; o segundo remove
  if (!confirmandoRemocao.value) { confirmandoRemocao.value = true; return }
  confirmandoRemocao.value = false
  erro.value = ''
  salvando.value = true
  try {
    await $fetch('/api/admin/organizacao', {
      method: 'PATCH', body: { chaveAsaas: null, ambienteAsaas: 'sandbox' },
    })
    await refresh()
    aviso.value = 'Chave removida. A organização voltou pro ambiente de testes.'
  } catch (e: any) {
    erro.value = e?.data?.statusMessage || 'Não foi possível remover.'
  } finally {
    salvando.value = false
  }
}

useHead({ title: 'Dados e cobrança' })
</script>

<template>
  <div v-if="data" class="pb-10">
    <div class="flex flex-wrap items-start justify-between gap-3 py-5">
      <div>
        <h1 class="titulo text-2xl font-semibold text-ink-900 sm:text-[28px]">Dados e cobrança</h1>
        <p class="mt-1 text-[15px] text-ink-700">O cadastro da organização, os dados que o site mostra e a ligação com o Asaas.</p>
      </div>
      <button type="button" class="btn-primario min-h-[40px]" :disabled="salvando || !mudou || temProblema" data-acao="salvar" @click="salvar">
        {{ salvando ? 'Salvando…' : 'Salvar' }}
      </button>
    </div>

    <p v-if="erro" class="faixa-erro" role="alert" data-parte="erro">{{ erro }}</p>
    <p v-if="aviso" class="rounded-xl bg-success-50 px-4 py-3 text-sm text-success-800 ring-1 ring-inset ring-success-600/30" role="status">{{ aviso }}</p>

    <div class="mt-4 grid gap-4 lg:grid-cols-3">
      <div class="grid content-start gap-4 lg:col-span-2">
        <section class="card">
          <h2 class="titulo text-lg font-semibold text-ink-900">Organização</h2>
          <div class="mt-3 grid gap-3 sm:grid-cols-2">
            <div class="sm:col-span-2">
              <label class="rotulo" for="cfg-nome">Nome fantasia</label>
              <input id="cfg-nome" v-model="f.nome" class="campo" maxlength="160" :aria-invalid="!!problemas.nome">
              <p v-if="problemas.nome" class="mt-1 text-xs font-medium text-danger-700">{{ problemas.nome }}</p>
            </div>
            <div>
              <label class="rotulo" for="cfg-doc">
                CNPJ ou CPF <span v-if="!f.documento.trim()" class="selo-alerta ml-1 align-middle" data-parte="a-preencher">a preencher</span>
              </label>
              <input id="cfg-doc" :value="f.documento" class="campo font-mono" inputmode="text" autocomplete="off"
                     placeholder="00.000.000/0000-00" maxlength="18" :aria-invalid="!!problemas.documento"
                     data-parte="campo-documento" @input="aoDigitarDocumento">
              <p v-if="problemas.documento" class="mt-1 text-xs font-medium text-danger-700" data-parte="erro-documento">{{ problemas.documento }}</p>
              <p v-else-if="ehDocumentoDeExemplo(f.documento)" class="mt-1 text-xs font-medium text-sun-800" data-parte="documento-de-exemplo">
                Este é o CNPJ de exemplo que veio na instalação (é do Banco do Brasil). Troque pelo CNPJ da empresa —
                enquanto isso, o site não mostra CNPJ nenhum.
              </p>
            </div>
            <div>
              <label class="rotulo">Endereço na plataforma</label>
              <input :value="data.slug" class="campo font-mono" disabled>
            </div>
          </div>
        </section>

        <!-- ============================================ dados da empresa (PROD-08) -->
        <section class="card" data-parte="dados-da-empresa">
          <div class="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h2 class="titulo text-lg font-semibold text-ink-900">Dados da empresa no site</h2>
              <p class="mt-1 text-sm text-ink-700">
                O rodapé de toda página de venda, os Termos, a Privacidade e o Cancelamento mostram estes dados.
                O que ficar vazio o site não mostra — nada é inventado.
              </p>
            </div>
            <span v-if="vazios.length" class="selo-alerta" data-parte="faltam">faltam {{ vazios.length }}</span>
            <span v-else class="selo-ok">completo</span>
          </div>

          <div class="mt-4 grid gap-3 sm:grid-cols-6">
            <div class="sm:col-span-6">
              <label class="rotulo" for="cfg-razao">
                Razão social <span v-if="!f.razaoSocial.trim()" class="selo-alerta ml-1 align-middle" data-parte="a-preencher">a preencher</span>
              </label>
              <input id="cfg-razao" v-model="f.razaoSocial" class="campo" maxlength="200" placeholder="Como está no cartão do CNPJ">
            </div>
            <div class="sm:col-span-4">
              <label class="rotulo" for="cfg-linha">
                Endereço <span v-if="!f.enderecoLinha.trim()" class="selo-alerta ml-1 align-middle" data-parte="a-preencher">a preencher</span>
              </label>
              <input id="cfg-linha" v-model="f.enderecoLinha" class="campo" maxlength="200" placeholder="Rua, número e complemento">
            </div>
            <div class="sm:col-span-2">
              <label class="rotulo" for="cfg-bairro">Bairro</label>
              <input id="cfg-bairro" v-model="f.enderecoBairro" class="campo" maxlength="120">
            </div>
            <div class="sm:col-span-3">
              <label class="rotulo" for="cfg-cidade">
                Cidade <span v-if="!f.enderecoCidade.trim()" class="selo-alerta ml-1 align-middle" data-parte="a-preencher">a preencher</span>
              </label>
              <input id="cfg-cidade" v-model="f.enderecoCidade" class="campo" maxlength="120">
            </div>
            <div class="sm:col-span-1">
              <label class="rotulo" for="cfg-uf">UF</label>
              <input id="cfg-uf" v-model="f.enderecoUf" class="campo uppercase" maxlength="2" :aria-invalid="!!problemas.enderecoUf" @blur="aoSairDaUf">
              <p v-if="problemas.enderecoUf" class="mt-1 text-xs font-medium text-danger-700">{{ problemas.enderecoUf }}</p>
            </div>
            <div class="sm:col-span-2">
              <label class="rotulo" for="cfg-cep">CEP</label>
              <input id="cfg-cep" v-model="f.enderecoCep" class="campo" inputmode="numeric" maxlength="9" :aria-invalid="!!problemas.enderecoCep" @blur="aoSairDoCep">
              <p v-if="problemas.enderecoCep" class="mt-1 text-xs font-medium text-danger-700">{{ problemas.enderecoCep }}</p>
            </div>
            <div class="sm:col-span-3">
              <label class="rotulo" for="cfg-email">
                E-mail de atendimento <span v-if="!f.emailAtendimento.trim() && !f.telefoneAtendimento.trim()" class="selo-alerta ml-1 align-middle" data-parte="a-preencher">a preencher</span>
              </label>
              <input id="cfg-email" v-model="f.emailAtendimento" type="email" class="campo" maxlength="160" autocomplete="off" :aria-invalid="!!problemas.emailAtendimento">
              <p v-if="problemas.emailAtendimento" class="mt-1 text-xs font-medium text-danger-700">{{ problemas.emailAtendimento }}</p>
            </div>
            <div class="sm:col-span-3">
              <label class="rotulo" for="cfg-tel">Telefone ou WhatsApp de atendimento</label>
              <input id="cfg-tel" v-model="f.telefoneAtendimento" class="campo" inputmode="tel" maxlength="16" placeholder="(73) 99999-9999"
                     :aria-invalid="!!problemas.telefoneAtendimento" @blur="aoSairDoTelefone">
              <p v-if="problemas.telefoneAtendimento" class="mt-1 text-xs font-medium text-danger-700">{{ problemas.telefoneAtendimento }}</p>
            </div>
            <div class="sm:col-span-6">
              <label class="rotulo" for="cfg-lgpd">Encarregado dos dados pessoais (LGPD) — nome e como falar com ele</label>
              <input id="cfg-lgpd" v-model="f.encarregadoDados" class="campo" maxlength="200" placeholder="Ex.: Maria Souza — privacidade@seudominio.com.br">
              <p class="mt-1 text-xs text-ink-600">Aparece na página de Privacidade. Vazio, a página manda falar com o atendimento.</p>
            </div>
          </div>

          <!-- a prévia do rodapé, com as mesmas funções dele -->
          <div class="mt-4 rounded-xl bg-ink-50 px-4 py-3 text-sm text-ink-800" data-parte="previa">
            <p class="text-xs font-semibold uppercase tracking-wide text-ink-600">Como sai no rodapé do site</p>
            <p class="mt-1">
              © {{ new Date().getFullYear() }} {{ previa.nomeLegal || '—' }}<template v-if="previa.doc"> · {{ previa.doc }}</template>
            </p>
            <p v-for="l in previa.endereco" :key="l">{{ l }}</p>
            <p v-if="vazios.length" class="mt-2 text-xs text-sun-800">Falta preencher: {{ vazios.join(', ') }}. Enquanto isso, o site mostra só o que existe.</p>
          </div>
        </section>

        <section class="card">
          <div class="flex items-center justify-between">
            <h2 class="titulo text-lg font-semibold text-ink-900">Recebimento — Asaas</h2>
            <!-- o ambiente EFETIVO: o prefixo da chave é quem escolhe o gateway
                 (utils/asaas-ambiente.ts). O `<select>` cru já mostrou "TESTES"
                 em cima de chave de produção cobrando de verdade (ORG-01). -->
            <span data-parte="selo-ambiente" :class="ambienteMostrado === 'production' ? 'selo-ok' : 'selo-alerta'">
              {{ ambienteMostrado === 'production' ? 'PRODUÇÃO' : 'TESTES' }}
            </span>
          </div>
          <p class="mt-1 text-sm text-ink-700">
            É por aqui que o PIX e o cartão do comprador entram. Em testes, nada é cobrado
            de verdade.
          </p>
          <p v-if="data.ambienteDivergente" class="faixa-erro mt-3" role="alert" data-parte="ambiente-divergente">
            A chave gravada é de <strong>{{ ambienteMostrado === 'production' ? 'PRODUÇÃO' : 'TESTES' }}</strong>,
            mas o ambiente marcado é
            <strong>{{ data.ambienteAsaas === 'production' ? 'Produção' : 'Testes' }}</strong>.
            Hoje as cobranças vão para
            {{ ambienteMostrado === 'production' ? 'PRODUÇÃO — cobram de verdade' : 'TESTES — ninguém consegue pagar' }}.
            Cole a chave do ambiente certo (ou troque o ambiente) e salve.
          </p>

          <div class="mt-3 grid gap-3">
            <div>
              <label class="rotulo" for="cfg-ambiente">Ambiente</label>
              <select id="cfg-ambiente" v-model="f.ambienteAsaas" class="campo">
                <option value="sandbox">Testes (sandbox) — ninguém é cobrado</option>
                <option value="production">Produção — cobra de verdade</option>
              </select>
            </div>

            <div>
              <label class="rotulo" for="cfg-chave">Chave de API</label>
              <div v-if="data.temChave && !trocandoChave"
                   class="flex flex-wrap items-center gap-3 rounded-xl border border-ink-200 bg-ink-50 px-3 py-2">
                <span class="font-mono text-sm text-ink-900">
                  configurada · termina em <strong>{{ data.chaveFinal }}</strong>
                </span>
                <button type="button" class="btn-secundario min-h-[40px] py-1 text-sm"
                        @click="trocandoChave = true; confirmandoRemocao = false">Trocar</button>
                <button type="button" class="min-h-[40px] px-2 text-sm text-danger-700 hover:underline"
                        :class="confirmandoRemocao && 'font-semibold'"
                        :disabled="salvando" @click="removerChave">
                  {{ confirmandoRemocao ? 'Confirmar remoção' : 'Remover' }}
                </button>
                <button v-if="confirmandoRemocao" type="button" class="min-h-[40px] px-2 text-sm text-ink-600 hover:underline"
                        @click="confirmandoRemocao = false">Cancelar</button>
              </div>
              <div v-else>
                <input id="cfg-chave" v-model="chaveNova" type="password" autocomplete="off" class="campo font-mono"
                       placeholder="$aact_…" :aria-invalid="chaveCurta" data-parte="campo-chave">
                <p v-if="chaveCurta" class="mt-1 text-xs font-medium text-danger-700" data-parte="chave-curta">
                  Isso não parece a chave inteira: a do Asaas tem bem mais de 20 caracteres e começa com $aact_. Copie de novo, do começo ao fim.
                </p>
                <div class="mt-2 flex items-center gap-2">
                  <button v-if="data.temChave" type="button" class="btn-secundario min-h-[40px] py-1 text-sm"
                          @click="trocandoChave = false; chaveNova = ''">Cancelar troca</button>
                  <p class="text-xs text-ink-600">
                    A chave entra e não sai: nenhuma tela consegue ler ela de volta.
                  </p>
                </div>
              </div>
            </div>

            <div>
              <label class="rotulo" for="cfg-carteira">Carteira (walletId) — opcional</label>
              <input id="cfg-carteira" v-model="f.carteiraAsaas" class="campo font-mono" maxlength="80"
                     placeholder="para split de recebimento">
            </div>
          </div>

          <p v-if="f.ambienteAsaas === 'production' && !data.temChave && !chaveNova"
             class="faixa-aviso mt-3">
            Produção sem chave gera cobrança de verdade que nunca confirma —
            o comprador paga e não recebe o ingresso. Informe a chave junto com a troca.
          </p>
        </section>
      </div>

      <div class="grid content-start gap-4">
        <section class="card">
          <h2 class="titulo text-lg font-semibold text-ink-900">Em números</h2>
          <dl class="mt-3 grid grid-cols-2 gap-y-2 text-sm text-ink-700">
            <dt>Eventos</dt><dd class="text-right tabular-nums text-ink-900">{{ Number(data.eventos ?? 0).toLocaleString('pt-BR') }}</dd>
            <dt>Pessoas com acesso</dt><dd class="text-right tabular-nums text-ink-900">{{ Number(data.pessoas ?? 0).toLocaleString('pt-BR') }}</dd>
            <dt>Clientes na base</dt><dd class="text-right tabular-nums text-ink-900">{{ Number(data.clientes ?? 0).toLocaleString('pt-BR') }}</dd>
            <dt>Desde</dt><dd class="text-right text-ink-900">{{ dataCurta(data.criadoEm) }}</dd>
          </dl>
          <NuxtLink to="/admin/equipe" class="btn-secundario mt-4 min-h-[40px] w-full justify-center">
            Gerenciar equipe
          </NuxtLink>
        </section>

        <section class="card text-sm text-ink-700">
          <h2 class="titulo text-lg font-semibold text-ink-900">Por que a chave não aparece</h2>
          <p class="mt-2">
            Chave que uma tela consegue mostrar é chave que fica no cache do navegador,
            no log do servidor e no print que alguém manda no grupo. Aqui ela entra
            uma vez e só o fim dela volta, o suficiente pra você conferir no painel
            do Asaas que é a certa.
          </p>
        </section>

        <section class="card text-sm text-ink-700">
          <h2 class="titulo text-lg font-semibold text-ink-900">As páginas públicas</h2>
          <p class="mt-2">O texto é um modelo em português claro e precisa da revisão de vocês (ou de um advogado) antes de valer.</p>
          <ul class="mt-2 grid gap-1">
            <li><NuxtLink to="/termos" class="font-semibold text-pool-700 hover:underline">Termos de compra</NuxtLink></li>
            <li><NuxtLink to="/privacidade" class="font-semibold text-pool-700 hover:underline">Privacidade</NuxtLink></li>
            <li><NuxtLink to="/cancelamento" class="font-semibold text-pool-700 hover:underline">Cancelamento e meia-entrada</NuxtLink></li>
          </ul>
        </section>
      </div>
    </div>

    <!-- Com alteração pendente, o Salvar desce junto: no celular o formulário é uma coluna só, bem
         comprida, e o botão do topo ficava fora da tela — era preciso rolar tudo de volta pra salvar
         (matriz da auditoria, "Celular 375px — Salvar alcançável"). Grudado no pé da tela enquanto
         houver o que salvar. -->
    <div v-if="naoSalvo || salvando" data-parte="barra-salvar"
         class="sticky bottom-0 z-10 mt-6 flex items-center justify-between gap-3 rounded-t-xl border border-b-0 border-linha bg-white/95 px-4 py-3 shadow-[0_-8px_24px_-12px_rgb(18_15_29/0.25)] backdrop-blur">
      <p class="min-w-0 text-sm text-ink-700">
        <template v-if="temProblema">Corrija o que está marcado para salvar.</template>
        <template v-else-if="mudou">Alteração não salva.</template>
        <template v-else>A chave colada ainda não está inteira.</template>
      </p>
      <button type="button" class="btn-primario min-h-[40px] shrink-0" :disabled="salvando || !mudou || temProblema"
              data-acao="salvar-rodape" @click="salvar">
        {{ salvando ? 'Salvando…' : 'Salvar' }}
      </button>
    </div>
  </div>

  <p v-else-if="pending" class="card mt-6 text-ink-700">Carregando…</p>

  <PainelFalha v-else :falha="falha" o-que="os dados da organização" :tentar="refresh" />
</template>
