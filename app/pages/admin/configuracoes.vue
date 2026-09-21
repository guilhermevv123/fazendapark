<script setup lang="ts">
/**
 * Configurações da organização — cadastro e a ligação com o Asaas.
 *
 * A chave do Asaas tem campo de escrita e nenhum de leitura: ela entra, não
 * sai. A tela mostra só o fim dela pra conferência ("…4f9c2a"), que é o que
 * alguém compara com o painel do Asaas pra ter certeza de que é a certa.
 */
definePageMeta({ layout: 'admin' })

const { data, refresh, pending, error: falha } = await useFetch<any>('/api/admin/organizacao')

const erro = ref('')
const aviso = ref('')
const salvando = ref(false)

const f = reactive({ nome: '', documento: '', ambienteAsaas: 'sandbox', carteiraAsaas: '' })
const chaveNova = ref('')
const trocandoChave = ref(false)

watch(data, (d) => {
  if (!d) return
  Object.assign(f, {
    nome: d.nome ?? '', documento: d.documento ?? '',
    ambienteAsaas: d.ambienteAsaas, carteiraAsaas: d.carteiraAsaas ?? '',
  })
}, { immediate: true })

const mudou = computed(() => {
  if (!data.value) return false
  return f.nome !== (data.value.nome ?? '')
    || f.documento !== (data.value.documento ?? '')
    || f.ambienteAsaas !== data.value.ambienteAsaas
    || f.carteiraAsaas !== (data.value.carteiraAsaas ?? '')
    || (trocandoChave.value && chaveNova.value.length >= 20)
})

async function salvar() {
  erro.value = ''
  aviso.value = ''
  salvando.value = true
  try {
    const corpo: any = {}
    if (f.nome !== (data.value.nome ?? '')) corpo.nome = f.nome
    if (f.documento !== (data.value.documento ?? '')) corpo.documento = f.documento || null
    if (f.ambienteAsaas !== data.value.ambienteAsaas) corpo.ambienteAsaas = f.ambienteAsaas
    if (f.carteiraAsaas !== (data.value.carteiraAsaas ?? '')) corpo.carteiraAsaas = f.carteiraAsaas || null
    if (trocandoChave.value && chaveNova.value.length >= 20) corpo.chaveAsaas = chaveNova.value.trim()

    await $fetch('/api/admin/organizacao', { method: 'PATCH', body: corpo })
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

useHead({ title: 'Configurações' })
</script>

<template>
  <div v-if="data">
    <div class="flex flex-wrap items-start justify-between gap-3 py-5">
      <div>
        <h1 class="titulo text-2xl font-bold text-tinta">Configurações</h1>
        <p class="mt-1 text-tinta-suave">Cadastro da organização e a ligação com o Asaas.</p>
      </div>
      <button type="button" class="btn-primario" :disabled="salvando || !mudou" @click="salvar">
        {{ salvando ? 'Salvando…' : 'Salvar' }}
      </button>
    </div>

    <p v-if="erro" class="rounded-card border border-erro bg-erro-claro px-3 py-2 text-sm text-erro">
      {{ erro }}
    </p>
    <p v-if="aviso" class="rounded-card border border-ok bg-ok-claro px-3 py-2 text-sm text-ok">
      {{ aviso }}
    </p>

    <div class="mt-4 grid gap-4 lg:grid-cols-3">
      <div class="grid content-start gap-4 lg:col-span-2">
        <section class="card">
          <h2 class="titulo text-base font-bold text-tinta">Organização</h2>
          <div class="mt-3 grid gap-3 sm:grid-cols-2">
            <div class="sm:col-span-2">
              <label class="rotulo">Nome</label>
              <input v-model="f.nome" class="campo">
            </div>
            <div>
              <label class="rotulo">CNPJ ou CPF</label>
              <input v-model="f.documento" class="campo">
            </div>
            <div>
              <label class="rotulo">Endereço na plataforma</label>
              <input :value="data.slug" class="campo font-mono" disabled>
            </div>
          </div>
        </section>

        <section class="card">
          <div class="flex items-center justify-between">
            <h2 class="titulo text-base font-bold text-tinta">Recebimento — Asaas</h2>
            <span :class="data.ambienteAsaas === 'production' ? 'selo-ok' : 'selo-alerta'">
              {{ data.ambienteAsaas === 'production' ? 'PRODUÇÃO' : 'TESTES' }}
            </span>
          </div>
          <p class="mt-1 text-sm text-tinta-suave">
            É por aqui que o PIX e o cartão do comprador entram. Em testes, nada é cobrado
            de verdade.
          </p>

          <div class="mt-3 grid gap-3">
            <div>
              <label class="rotulo">Ambiente</label>
              <select v-model="f.ambienteAsaas" class="campo">
                <option value="sandbox">Testes (sandbox) — ninguém é cobrado</option>
                <option value="production">Produção — cobra de verdade</option>
              </select>
            </div>

            <div>
              <label class="rotulo">Chave de API</label>
              <div v-if="data.temChave && !trocandoChave"
                   class="flex flex-wrap items-center gap-3 rounded-card border border-linha bg-fundo-cinza px-3 py-2">
                <span class="font-mono text-sm text-tinta">
                  configurada · termina em <strong>{{ data.chaveFinal }}</strong>
                </span>
                <button type="button" class="btn-secundario py-1 text-sm"
                        @click="trocandoChave = true">Trocar</button>
                <button type="button" class="px-2 text-sm text-erro hover:underline"
                        :disabled="salvando" @click="removerChave">Remover</button>
              </div>
              <div v-else>
                <input v-model="chaveNova" type="password" autocomplete="off" class="campo font-mono"
                       placeholder="$aact_…">
                <div class="mt-2 flex items-center gap-2">
                  <button v-if="data.temChave" type="button" class="btn-secundario py-1 text-sm"
                          @click="trocandoChave = false; chaveNova = ''">Cancelar troca</button>
                  <p class="text-xs text-tinta-fraca">
                    A chave entra e não sai: nenhuma tela consegue ler ela de volta.
                  </p>
                </div>
              </div>
            </div>

            <div>
              <label class="rotulo">Carteira (walletId) — opcional</label>
              <input v-model="f.carteiraAsaas" class="campo font-mono"
                     placeholder="para split de recebimento">
            </div>
          </div>

          <p v-if="f.ambienteAsaas === 'production' && !data.temChave && !chaveNova"
             class="mt-3 rounded-card border border-alerta bg-alerta-claro px-3 py-2 text-sm text-alerta">
            Produção sem chave gera cobrança de verdade que nunca confirma —
            o comprador paga e não recebe o ingresso. Informe a chave junto com a troca.
          </p>
        </section>
      </div>

      <div class="grid content-start gap-4">
        <section class="card">
          <h2 class="titulo text-base font-bold text-tinta">Em números</h2>
          <dl class="mt-3 grid grid-cols-2 gap-y-2 text-sm text-tinta-suave">
            <dt>Eventos</dt><dd class="text-right text-tinta">{{ data.eventos }}</dd>
            <dt>Pessoas com acesso</dt><dd class="text-right text-tinta">{{ data.pessoas }}</dd>
            <dt>Clientes na base</dt><dd class="text-right text-tinta">{{ data.clientes }}</dd>
            <dt>Desde</dt>
            <dd class="text-right text-tinta">
              {{ new Date(data.criadoEm).toLocaleDateString('pt-BR') }}
            </dd>
          </dl>
          <NuxtLink to="/admin/equipe" class="btn-secundario mt-4 w-full justify-center">
            Gerenciar equipe
          </NuxtLink>
        </section>

        <section class="card text-sm text-tinta-suave">
          <h2 class="titulo text-base font-bold text-tinta">Por que a chave não aparece</h2>
          <p class="mt-2">
            Chave que uma tela consegue mostrar é chave que fica no cache do navegador,
            no log do servidor e no print que alguém manda no grupo. Aqui ela entra
            uma vez e só o fim dela volta, o suficiente pra você conferir no painel
            do Asaas que é a certa.
          </p>
        </section>
      </div>
    </div>
  </div>

  <p v-else-if="pending" class="card mt-6 text-tinta-suave">Carregando…</p>

  <div v-else class="card mt-6">
    <p class="rotulo-kpi text-erro">Não foi possível carregar</p>
    <p class="mt-1 text-sm text-tinta-suave">
      {{ (falha as any)?.data?.statusMessage || (falha as any)?.message || 'Erro desconhecido.' }}
    </p>
    <button type="button" class="btn-secundario mt-3" @click="refresh()">Tentar de novo</button>
  </div>
</template>
