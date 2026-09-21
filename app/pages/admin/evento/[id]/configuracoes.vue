<script setup lang="ts">
/**
 * Configurações do evento — o cadastro que o assistente de criação preencheu,
 * agora editável.
 *
 * Organizado em blocos na mesma ordem dos passos da criação, de propósito:
 * quem criou o evento na semana passada procura o campo onde ele estava.
 *
 * O salvar manda SÓ o que mudou. Mandar o formulário inteiro faria dois
 * operadores em abas diferentes sobrescreverem o trabalho um do outro — quem
 * salvasse por último devolveria os campos do outro pro valor que ele viu ao
 * abrir a tela.
 */
definePageMeta({ layout: 'admin' })

const route = useRoute()
const id = route.params.id as string

const { data, refresh, pending, error: falha } = await useFetch<any>(
  `/api/admin/evento/${id}/configuracoes`)

const erro = ref('')
const aviso = ref('')
const salvando = ref(false)

// Os dois conversores nascem ANTES de quem os usa: `carregar()` roda na mesma
// linha do watch (`immediate: true`), e um `const` declarado depois ainda está
// na zona morta — a tela inteira caía em 500 antes de pintar um pixel.
const paraCampo = (iso: string | null) => {
  if (!iso) return ''
  const d = new Date(iso)
  // toISOString devolve UTC e o input datetime-local é hora local: sem este
  // deslocamento, um evento das 18h aparece como 21h no formulário.
  const off = d.getTimezoneOffset() * 60_000
  return new Date(d.getTime() - off).toISOString().slice(0, 16)
}
const deCampo = (v: string) => (v ? new Date(v).toISOString() : null)

/** cópia editável + o original, pra saber o que mudou */
const f = reactive<any>({})
const original = ref<any>({})
function carregar() {
  if (!data.value) return
  const d = { ...data.value }
  d.comecaEm = paraCampo(d.comecaEm)
  d.terminaEm = paraCampo(d.terminaEm)
  d.vendaAte = paraCampo(d.vendaAte)
  d.tags = (d.tags ?? []).join(', ')
  Object.assign(f, d)
  original.value = { ...d }
}
watch(data, carregar, { immediate: true })

const CAMPOS_DATA = ['comecaEm', 'terminaEm', 'vendaAte']
const SO_LEITURA = ['id', 'organizacao', 'fuso', 'moeda', 'criadoEm', 'atualizadoEm',
                    'jaVendeu', 'pedidosPagos', 'ingressos', 'lat', 'lng',
                    'subcategorias', 'giroAutomatico']

const mudou = computed(() => {
  for (const k of Object.keys(f)) {
    if (SO_LEITURA.includes(k)) continue
    if (JSON.stringify(f[k]) !== JSON.stringify(original.value[k])) return true
  }
  return false
})

async function salvar() {
  erro.value = ''
  aviso.value = ''
  const corpo: any = {}
  for (const k of Object.keys(f)) {
    if (SO_LEITURA.includes(k)) continue
    if (JSON.stringify(f[k]) === JSON.stringify(original.value[k])) continue
    if (CAMPOS_DATA.includes(k)) corpo[k] = deCampo(f[k])
    else if (k === 'tags') {
      corpo.tags = String(f.tags || '').split(',').map((t: string) => t.trim()).filter(Boolean)
    } else corpo[k] = f[k]
  }
  if (!Object.keys(corpo).length) return

  salvando.value = true
  try {
    await $fetch(`/api/admin/evento/${id}/configuracoes`, { method: 'PATCH', body: corpo })
    await refresh()
    aviso.value = 'Salvo.'
    setTimeout(() => { aviso.value = '' }, 2500)
  } catch (e: any) {
    erro.value = e?.data?.statusMessage || 'Não foi possível salvar.'
  } finally {
    salvando.value = false
  }
}

function desfazer() {
  Object.assign(f, original.value)
  erro.value = ''
}

const STATUS = [
  { v: 'rascunho', r: 'Rascunho — só quem tem login vê' },
  { v: 'ativo', r: 'Ativo — vendendo' },
  { v: 'oculto', r: 'Oculto — vende por link direto, não aparece na lista' },
  { v: 'adiado', r: 'Adiado' },
  { v: 'encerrado', r: 'Encerrado' },
  { v: 'cancelado', r: 'Cancelado' },
]

useHead({ title: 'Configurações do evento' })
</script>

<template>
  <div v-if="data">
    <div class="flex flex-wrap items-start justify-between gap-3 py-5">
      <div>
        <h1 class="titulo text-2xl font-bold text-tinta">Configurações do evento</h1>
        <p class="mt-1 text-tinta-suave">
          O mesmo cadastro da criação. Só o que você mudar é enviado.
        </p>
      </div>
      <div class="flex items-center gap-2">
        <a :href="`/e/${data.slug}`" target="_blank" rel="noopener" class="btn-secundario">
          Ver página pública
        </a>
        <button type="button" class="btn-secundario" :disabled="!mudou" @click="desfazer">
          Desfazer
        </button>
        <button type="button" class="btn-primario" :disabled="salvando || !mudou" @click="salvar">
          {{ salvando ? 'Salvando…' : 'Salvar' }}
        </button>
      </div>
    </div>

    <p v-if="erro" class="rounded-card border border-erro bg-erro-claro px-3 py-2 text-sm text-erro">
      {{ erro }}
    </p>
    <p v-if="aviso" class="rounded-card border border-ok bg-ok-claro px-3 py-2 text-sm text-ok">
      {{ aviso }}
    </p>

    <div class="mt-4 grid gap-4 lg:grid-cols-3">
      <div class="lg:col-span-2 grid gap-4">
        <section class="card">
          <h2 class="titulo text-base font-bold text-tinta">Dados básicos</h2>
          <div class="mt-3 grid gap-3 sm:grid-cols-2">
            <div class="sm:col-span-2">
              <label class="rotulo">Nome do evento</label>
              <input v-model="f.nome" class="campo">
            </div>
            <div class="sm:col-span-2">
              <label class="rotulo">Endereço público</label>
              <div class="flex items-center gap-1">
                <span class="shrink-0 text-sm text-tinta-fraca">/e/</span>
                <input v-model="f.slug" class="campo font-mono" :disabled="data.jaVendeu">
              </div>
              <p class="mt-1 text-xs" :class="data.jaVendeu ? 'text-alerta' : 'text-tinta-fraca'">
                <template v-if="data.jaVendeu">
                  Travado: já houve venda e mudar quebraria todo link divulgado.
                </template>
                <template v-else>Só letras minúsculas, números e hífen.</template>
              </p>
            </div>
            <div>
              <label class="rotulo">Situação</label>
              <select v-model="f.status" class="campo">
                <option v-for="s in STATUS" :key="s.v" :value="s.v">{{ s.r }}</option>
              </select>
            </div>
            <div>
              <label class="rotulo">Como chamar o ingresso</label>
              <input v-model="f.substantivo" class="campo" placeholder="Ingressos, Passaportes…">
            </div>
            <div class="sm:col-span-2">
              <label class="rotulo">Descrição</label>
              <textarea v-model="f.descricao" rows="6" class="campo"
                        placeholder="O que o público lê na página do evento." />
            </div>
          </div>
        </section>

        <section class="card">
          <h2 class="titulo text-base font-bold text-tinta">Datas e horários</h2>
          <div class="mt-3 grid gap-3 sm:grid-cols-2">
            <div>
              <label class="rotulo">Começa em</label>
              <input v-model="f.comecaEm" type="datetime-local" class="campo">
            </div>
            <div>
              <label class="rotulo">Termina em</label>
              <input v-model="f.terminaEm" type="datetime-local" class="campo">
            </div>
            <div>
              <label class="rotulo">Venda encerra em (data fixa)</label>
              <input v-model="f.vendaAte" type="datetime-local" class="campo">
            </div>
            <div>
              <label class="rotulo">…ou minutos após o início</label>
              <input v-model.number="f.vendaAteMinutos" type="number" min="0" class="campo"
                     placeholder="ex.: 120">
              <p class="mt-1 text-xs text-tinta-fraca">
                Preencher um zera o outro — as duas formas não convivem.
              </p>
            </div>
            <label class="flex items-center gap-2 text-sm text-tinta-suave">
              <input v-model="f.esconderFim" type="checkbox" class="h-4 w-4 accent-acao">
              Não mostrar a data de término ao público
            </label>
            <div>
              <label class="rotulo">Classificação etária</label>
              <input v-model.number="f.classificacao" type="number" min="0" max="21" class="campo">
              <p class="mt-1 text-xs text-tinta-fraca">0 = livre</p>
            </div>
          </div>
        </section>

        <section class="card">
          <h2 class="titulo text-base font-bold text-tinta">Local</h2>
          <label class="mt-3 flex items-center gap-2 text-sm text-tinta-suave">
            <input v-model="f.online" type="checkbox" class="h-4 w-4 accent-acao">
            Evento online
          </label>
          <div v-if="f.online" class="mt-3">
            <label class="rotulo">Link da transmissão</label>
            <input v-model="f.urlTransmissao" class="campo" placeholder="https://…">
          </div>
          <div v-else class="mt-3 grid gap-3 sm:grid-cols-6">
            <div class="sm:col-span-6">
              <label class="rotulo">Nome do local</label>
              <input v-model="f.local" class="campo" placeholder="Fazenda Park Hotel">
            </div>
            <div class="sm:col-span-2">
              <label class="rotulo">CEP</label>
              <input v-model="f.cep" class="campo">
            </div>
            <div class="sm:col-span-3">
              <label class="rotulo">Endereço</label>
              <input v-model="f.endereco" class="campo">
            </div>
            <div class="sm:col-span-1">
              <label class="rotulo">Número</label>
              <input v-model="f.numero" class="campo">
            </div>
            <div class="sm:col-span-2">
              <label class="rotulo">Bairro</label>
              <input v-model="f.bairro" class="campo">
            </div>
            <div class="sm:col-span-3">
              <label class="rotulo">Cidade</label>
              <input v-model="f.cidade" class="campo">
            </div>
            <div class="sm:col-span-1">
              <label class="rotulo">UF</label>
              <input v-model="f.uf" maxlength="2" class="campo uppercase">
            </div>
            <div class="sm:col-span-6">
              <label class="rotulo">Complemento</label>
              <input v-model="f.complemento" class="campo">
            </div>
          </div>
        </section>

        <section class="card">
          <h2 class="titulo text-base font-bold text-tinta">Imagens e categoria</h2>
          <div class="mt-3 grid gap-3 sm:grid-cols-2">
            <div class="sm:col-span-2">
              <label class="rotulo">Banner (URL)</label>
              <input v-model="f.banner" class="campo" placeholder="https://…">
            </div>
            <div class="sm:col-span-2">
              <label class="rotulo">Miniatura (URL)</label>
              <input v-model="f.thumb" class="campo" placeholder="https://…">
            </div>
            <div>
              <label class="rotulo">Categoria</label>
              <input v-model="f.categoria" class="campo" placeholder="Festa, Show, Esporte…">
            </div>
            <div>
              <label class="rotulo">Tags</label>
              <input v-model="f.tags" class="campo" placeholder="separadas por vírgula">
            </div>
          </div>
          <div v-if="f.banner" class="mt-3">
            <img :src="f.banner" alt="Prévia do banner"
                 class="max-h-44 w-full rounded-card border border-linha object-cover">
          </div>
        </section>
      </div>

      <div class="grid content-start gap-4">
        <section class="card">
          <h2 class="titulo text-base font-bold text-tinta">Taxa de serviço</h2>
          <div class="mt-3 grid gap-3">
            <div>
              <label class="rotulo">Percentual</label>
              <div class="flex items-center gap-2">
                <input :value="(f.taxaBps ?? 0) / 100" type="number" step="0.01" min="0" max="50"
                       class="campo"
                       @input="f.taxaBps = Math.round(Number(($event.target as HTMLInputElement).value) * 100)">
                <span class="text-tinta-suave">%</span>
              </div>
              <p class="mt-1 text-xs text-tinta-fraca">
                Guardado em pontos-base ({{ f.taxaBps }} bps) — nunca em decimal,
                pra não perder centavo no arredondamento.
              </p>
            </div>
            <div>
              <label class="rotulo">No site</label>
              <select v-model="f.modoTaxaOnline" class="campo">
                <option value="repassar">Repassar — o comprador paga por cima</option>
                <option value="absorver">Absorver — sai da face</option>
              </select>
            </div>
            <div>
              <label class="rotulo">Na bilheteria</label>
              <select v-model="f.modoTaxaPdv" class="campo">
                <option value="repassar">Repassar</option>
                <option value="absorver">Absorver</option>
              </select>
            </div>
          </div>
        </section>

        <section class="card">
          <h2 class="titulo text-base font-bold text-tinta">Venda</h2>
          <div class="mt-3 grid gap-3">
            <div>
              <label class="rotulo">Minutos de reserva no carrinho</label>
              <input v-model.number="f.minutosDeReserva" type="number" min="5" max="120" class="campo">
              <p class="mt-1 text-xs text-tinta-fraca">
                Quanto tempo o ingresso fica segurado enquanto o PIX não chega.
              </p>
            </div>
            <div>
              <label class="rotulo">Máximo por cliente</label>
              <input v-model.number="f.maxPorCliente" type="number" min="1" max="200" class="campo"
                     placeholder="sem limite">
            </div>
            <label class="flex items-center gap-2 text-sm text-tinta-suave">
              <input v-model="f.agruparPorSetor" type="checkbox" class="h-4 w-4 accent-acao">
              Agrupar ingressos por setor na página pública
            </label>
            <label class="flex items-center gap-2 text-sm text-tinta-suave">
              <input v-model="f.privado" type="checkbox" class="h-4 w-4 accent-acao">
              Evento privado (não listar publicamente)
            </label>
          </div>
        </section>

        <section class="card">
          <h2 class="titulo text-base font-bold text-tinta">Suporte ao comprador</h2>
          <div class="mt-3 grid gap-3">
            <div>
              <label class="rotulo">Canal</label>
              <select v-model="f.suporteTipo" class="campo">
                <option :value="null">Nenhum</option>
                <option value="whatsapp">WhatsApp</option>
                <option value="telefone">Telefone</option>
                <option value="email">E-mail</option>
              </select>
            </div>
            <div v-if="f.suporteTipo">
              <label class="rotulo">Contato</label>
              <input v-model="f.suporteValor" class="campo">
            </div>
          </div>
        </section>

        <section class="card text-sm">
          <h2 class="titulo text-base font-bold text-tinta">Ficha</h2>
          <dl class="mt-3 grid grid-cols-2 gap-y-2 text-tinta-suave">
            <dt>Organização</dt><dd class="text-right text-tinta">{{ data.organizacao }}</dd>
            <dt>Fuso</dt><dd class="text-right text-tinta">{{ data.fuso }}</dd>
            <dt>Moeda</dt><dd class="text-right text-tinta">{{ data.moeda }}</dd>
            <dt>Pedidos pagos</dt><dd class="text-right text-tinta">{{ data.pedidosPagos }}</dd>
            <dt>Ingressos</dt><dd class="text-right text-tinta">{{ data.ingressos }}</dd>
            <dt>Criado em</dt>
            <dd class="text-right text-tinta">
              {{ new Date(data.criadoEm).toLocaleDateString('pt-BR') }}
            </dd>
          </dl>
        </section>
      </div>
    </div>
  </div>

  <p v-else-if="pending" class="card mt-6 text-tinta-suave">Carregando…</p>

  <div v-else class="card mt-6">
    <p class="rotulo-kpi text-erro">Não foi possível carregar as configurações</p>
    <p class="mt-1 text-sm text-tinta-suave">
      {{ (falha as any)?.data?.statusMessage || (falha as any)?.message || 'Erro desconhecido.' }}
    </p>
    <button type="button" class="btn-secundario mt-3" @click="refresh()">Tentar de novo</button>
  </div>
</template>
