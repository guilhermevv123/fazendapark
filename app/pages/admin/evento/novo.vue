<script setup lang="ts">
/**
 * Criar evento — cinco passos, na mesma ordem e com os mesmos blocos do
 * painel de origem: Dados básicos → Descrição → Setores, lotes e tipos →
 * Preços e quantidades → Datas e horários.
 *
 * Conferido de verdade em 21/09/2026, passo a passo, no painel da Zig do
 * próprio parque (sem publicar nada): o passo 1 leva TAMBÉM "Onde vai
 * acontecer" e "Contato de suporte" (obrigatório), e o passo 2 é só a
 * descrição. Antes isto morava aqui com os dois blocos no passo 2, por
 * dedução de arquivo de tradução — e a equipe, que já conhece o painel de
 * lá, procurava o endereço no passo errado.
 *
 * Tudo fica em memória até o último passo, e o evento inteiro (com setor,
 * lote e tipo) é gravado numa transação só. Criar o rascunho já no passo 1
 * encheria o banco de evento pela metade de quem fechou a aba no meio.
 *
 * Preços ficam no passo 4, separados dos setores do passo 3, porque é assim
 * que o produtor pensa: primeiro "quais áreas eu vendo", depois "quanto custa
 * cada uma". Misturar os dois numa tela só é o que faz alguém errar preço de
 * lote inteiro sem perceber.
 */
definePageMeta({ layout: false })

const PASSOS = [
  'Dados básicos', 'Descrição do evento', 'Setores, lotes e tipos',
  'Preços e quantidades', 'Datas e horários',
]
const passo = ref(1)
const salvando = ref(false)
const erro = ref('')
const erros = ref<string[]>([])

/* ------------------------------------------------------------- estado --- */
const f = reactive({
  orgId: '',
  nome: '',
  slug: '',
  faixaEtaria: 18,
  privado: false,
  categoria: '',
  subcategorias: [] as string[],
  banner: '',
  thumb: '',

  descricao: '',
  online: false,
  linkTransmissao: '',
  local: { nome: '', cep: '', endereco: '', numero: '', bairro: '', cidade: '', estado: '', complemento: '' },
  suporteTipo: 'whatsapp' as 'whatsapp' | 'telefone' | 'email',
  suporteValor: '',

  setores: [] as Setor[],

  /** "Nomenclatura do bilhete": como o site e os e-mails chamam o que se compra */
  substantivo: 'Ingressos',
  /** o painel de origem publica no clique final; aqui é escolha, e o padrão é o seguro */
  publicarAoCriar: false,

  taxaBps: 1000,
  modoTaxaOnline: 'repassar' as 'repassar' | 'absorver',
  modoTaxaPdv: 'absorver' as 'repassar' | 'absorver',
  maxPorCliente: null as number | null,
  minutosDeReserva: 20,

  inicioData: '', inicioHora: '20:00',
  fimData: '', fimHora: '23:59',
  fuso: 'America/Bahia',
  esconderFim: false,
  encerramento: 'inicio' as 'inicio' | 'minutos' | 'data',
  encerraMinutos: 60,
  encerraData: '', encerraHora: '',
  porDias: false,
  sessoes: [] as { titulo: string; data: string; inicio: string; fim: string }[],
})

type Tipo = { nome: string; quantidade: number; descontoBps: number; exigeDocumento: boolean }
type Lote = { nome: string; faceCents: number; quantidade: number; minPorCompra: number; maxPorCompra: number; tipos: Tipo[] }
type Setor = { nome: string; tipo: string; descricao: string; capacidade: number | null; indiceSessao: number | null; lotes: Lote[] }

const { data: orgs } = await useFetch<any>('/api/admin/organizacoes')
watchEffect(() => { if (!f.orgId && orgs.value?.length) f.orgId = orgs.value[0].id })

/* --------------------------------------------------------------- slug --- */
const slugTocado = ref(false)
const paraSlug = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70)
watch(() => f.nome, (v) => { if (!slugTocado.value) f.slug = paraSlug(v) })

/* ----------------------------------------------------------- endereço --- */
const buscandoCep = ref(false)
async function buscarCep() {
  const cep = f.local.cep.replace(/\D/g, '')
  if (cep.length !== 8) return
  buscandoCep.value = true
  try {
    const r: any = await $fetch(`https://viacep.com.br/ws/${cep}/json/`)
    if (r.erro) return
    f.local.endereco = r.logradouro || f.local.endereco
    f.local.bairro = r.bairro || f.local.bairro
    f.local.cidade = r.localidade || f.local.cidade
    f.local.estado = r.uf || f.local.estado
  } catch {
    // CEP é conveniência: se o serviço cair, a pessoa digita. Bloquear o
    // cadastro por causa de um serviço de terceiro seria pior que o problema.
  } finally { buscandoCep.value = false }
}

/* ------------------------------------------------------------- setores -- */
function novoSetor() {
  f.setores.push({
    nome: '', tipo: 'ingresso', descricao: '', capacidade: null, indiceSessao: null,
    lotes: [{ nome: '1º lote', faceCents: 0, quantidade: 100, minPorCompra: 1, maxPorCompra: 6, tipos: [] }],
  })
}
function novoLote(s: Setor) {
  s.lotes.push({
    nome: `${s.lotes.length + 1}º lote`, faceCents: 0, quantidade: 100,
    minPorCompra: 1, maxPorCompra: 6, tipos: [],
  })
}
function novoTipo(l: Lote) {
  l.tipos.push({ nome: l.tipos.length ? 'Meia-entrada' : 'Inteira', quantidade: l.quantidade, descontoBps: l.tipos.length ? 5000 : 0, exigeDocumento: !!l.tipos.length })
}

/* -------------------------------------------------------------- preço --- */
// `reais` vem de `app/composables/formato.ts`. A cópia que morava aqui era
// `(c / 100).toLocaleString('pt-BR', { style: 'currency' })`: divide centavo
// em float pra formatar e separa o `R$` com espaço FINO (U+00A0).
const taxaDe = (face: number) =>
  f.modoTaxaOnline === 'absorver' ? 0 : Math.round((face * f.taxaBps) / 10_000)
const totalDe = (face: number) => face + taxaDe(face)
const produtorRecebe = (face: number) =>
  f.modoTaxaOnline === 'absorver' ? face - Math.round((face * f.taxaBps) / 10_000) : face

/** Conta ao contrário: total redondo → face. */
function aplicarRedondo(l: Lote, totalCents: number) {
  if (f.modoTaxaOnline === 'absorver') { l.faceCents = totalCents; return }
  const den = 10_000 + f.taxaBps
  l.faceCents = Math.floor((totalCents * 10_000 + den / 2) / den)
}
const redondoAberto = ref<Lote | null>(null)
const redondoValor = ref(0)

/* --------------------------------------------------------------- dias --- */

/**
 * Uma sessão por dia entre o início e o fim.
 *
 * O laço antigo montava `new Date(data + 'T12:00')` e cortava com
 * `toISOString().slice(0, 10)`. O meio-dia era justamente o remendo que
 * escondia o erro: com o deslocamento de −3h o meio-dia local ainda cai no
 * mesmo dia em UTC, então no Brasil a conta "dava certo". Basta o navegador
 * estar num fuso adiantado (+13 em Auckland no verão, +14 em Kiritimati) pra
 * o meio-dia local virar a véspera em UTC e a grade inteira de sessões nascer
 * um dia atrás — sem erro, sem log, só a data errada na tela.
 *
 * Aqui quem conta dia é `diaLocalMais`, que lê o relógio local, e a parada é
 * por comparação de `YYYY-MM-DD`, que é exata como texto.
 */
watch(() => [f.porDias, f.inicioData, f.fimData], () => {
  if (!f.porDias || !f.inicioData || !f.fimData) return
  if (f.sessoes.length) return
  const inicio = paraData(f.inicioData)
  const fim = paraData(f.fimData)
  if (!inicio || !fim) return // data pela metade não vira grade de sessão
  const ultimo = diaLocal(fim)
  const dias: string[] = []
  for (let i = 0; i <= 60; i++) {
    const dia = diaLocalMais(i, inicio)
    if (dia > ultimo) break
    dias.push(dia)
  }
  f.sessoes = dias.map((data) => ({
    titulo: diaDaSemana(data),
    data, inicio: f.inicioHora, fim: f.fimHora,
  }))
})

/* ------------------------------------------------------------ validar --- */
function validar(p: number): string[] {
  const e: string[] = []
  if (p === 1) {
    if (!f.orgId) e.push('Escolha a organização vinculada.')
    if (f.nome.trim().length < 3) e.push('O nome do evento precisa de pelo menos 3 letras.')
    if (!f.slug) e.push('O caminho da página de vendas não pode ficar vazio.')
    if (f.online && !/^https?:\/\//.test(f.linkTransmissao)) {
      e.push('Evento online precisa do link de transmissão.')
    }
    if (!f.online && !f.local.cidade.trim()) e.push('Evento presencial precisa da cidade.')
    if (f.suporteValor.trim().length < 5) e.push('Informe um contato de suporte ao cliente.')
  }
  if (p === 3) {
    if (!f.setores.length) e.push('Crie pelo menos um setor.')
    f.setores.forEach((s, i) => {
      if (!s.nome.trim()) e.push(`Setor ${i + 1}: falta o nome.`)
      if (!s.lotes.length) e.push(`"${s.nome || `Setor ${i + 1}`}": crie pelo menos um lote.`)
      const soma = s.lotes.reduce((a, l) => a + l.quantidade, 0)
      if (s.capacidade && soma > s.capacidade) {
        e.push(`"${s.nome}": os lotes somam ${soma} para uma capacidade de ${s.capacidade}.`)
      }
    })
  }
  if (p === 4) {
    f.setores.forEach((s) => s.lotes.forEach((l) => {
      if (l.quantidade < 1) e.push(`"${s.nome} · ${l.nome}": a quantidade tem que ser pelo menos 1.`)
      if (l.minPorCompra > l.maxPorCompra) {
        e.push(`"${s.nome} · ${l.nome}": o mínimo por compra passou do máximo.`)
      }
      const somaTipos = l.tipos.reduce((a, t) => a + t.quantidade, 0)
      if (somaTipos > l.quantidade) {
        e.push(`"${s.nome} · ${l.nome}": os tipos somam ${somaTipos} de ${l.quantidade}.`)
      }
    }))
  }
  if (p === 5) {
    if (!f.inicioData) e.push('Informe a data de início.')
    if (!f.fimData) e.push('Informe a data de término.')
    if (f.inicioData && f.fimData) {
      // `paraData` e não `new Date(...)`: é a mesma porta que o resto da tela
      // usa, e ela é quem sabe que data sem hora é dia de calendário LOCAL.
      const ini = paraData(`${f.inicioData}T${f.inicioHora}`)
      const fim = paraData(`${f.fimData}T${f.fimHora}`)
      if (ini && fim && fim <= ini) e.push('O término tem que ser depois do início.')
    }
    if (f.encerramento === 'data' && !f.encerraData) {
      e.push('Informe a data de encerramento das vendas.')
    }
  }
  return e
}

function avancar() {
  erro.value = ''
  erros.value = validar(passo.value)
  if (erros.value.length) return
  if (passo.value < PASSOS.length) { passo.value++; window.scrollTo({ top: 0 }); return }
  publicar()
}
function voltar() { erros.value = []; passo.value--; window.scrollTo({ top: 0 }) }
const sair = () => navigateTo('/admin')

/* ------------------------------------------------------------ gravar ---- */

/**
 * Data + hora digitadas (relógio de quem está criando o evento) → o instante
 * que o servidor guarda. `deCampoDataHora` mora em `app/composables/formato.ts`
 * e é o único lugar do projeto que faz esta conversão: sem a hora, o
 * `new Date('2026-10-17')` que existia aqui nasceria meia-noite UTC e o evento
 * começaria às 21h do dia ANTERIOR.
 */
const iso = (data: string, hora: string) =>
  deCampoDataHora(`${data}T${hora || '00:00'}`)

async function publicar() {
  salvando.value = true
  erro.value = ''
  try {
    const corpo: any = {
      orgId: f.orgId,
      nome: f.nome.trim(),
      slug: f.slug,
      descricao: f.descricao || undefined,
      inicio: iso(f.inicioData, f.inicioHora),
      fim: iso(f.fimData, f.fimHora),
      fuso: f.fuso,
      esconderFim: f.esconderFim,
      encerraVendasEm: f.encerramento === 'data' ? iso(f.encerraData, f.encerraHora || '23:59') : null,
      encerraVendasMinutosApos: f.encerramento === 'minutos' ? f.encerraMinutos : (f.encerramento === 'inicio' ? 0 : null),
      faixaEtaria: f.faixaEtaria,
      substantivo: f.substantivo.trim() || 'Ingressos',
      categoria: f.categoria || undefined,
      subcategorias: f.subcategorias,
      online: f.online,
      linkTransmissao: f.online ? f.linkTransmissao : undefined,
      local: f.online ? {} : { ...f.local, estado: f.local.estado || undefined },
      banner: f.banner || undefined,
      thumb: f.thumb || undefined,
      suporte: f.suporteValor ? { tipo: f.suporteTipo, valor: f.suporteValor.trim() } : null,
      taxaBps: f.taxaBps,
      modoTaxaOnline: f.modoTaxaOnline,
      modoTaxaPdv: f.modoTaxaPdv,
      maxPorCliente: f.maxPorCliente,
      minutosDeReserva: f.minutosDeReserva,
      privado: f.privado,
      sessoes: f.porDias
        ? f.sessoes.map((s) => ({
            titulo: s.titulo || undefined,
            inicio: iso(s.data, s.inicio),
            fim: iso(s.data, s.fim),
          }))
        : [],
      setores: f.setores.map((s) => ({
        nome: s.nome.trim(), tipo: s.tipo,
        descricao: s.descricao || undefined,
        capacidade: s.capacidade,
        indiceSessao: f.porDias ? s.indiceSessao : null,
        lotes: s.lotes.map((l) => ({
          nome: l.nome.trim(), faceCents: l.faceCents, quantidade: l.quantidade,
          minPorCompra: l.minPorCompra, maxPorCompra: l.maxPorCompra,
          tipos: l.tipos.map((t) => ({
            nome: t.nome.trim(), quantidade: t.quantidade,
            descontoBps: t.descontoBps, exigeDocumento: t.exigeDocumento,
          })),
        })),
      })),
    }
    const r: any = await $fetch('/api/admin/evento', { method: 'POST', body: corpo })
    if (f.publicarAoCriar) {
      // O evento JÁ existe (rascunho). Se publicar falhar, ficar aqui deixaria a
      // pessoa apertar "Criar" de novo e ganhar um evento repetido — então ela
      // vai pra Configurações do evento, onde o status se muda à mão.
      try {
        await $fetch(`/api/admin/evento/${r.id}/configuracoes`, {
          method: 'PATCH', body: { status: 'ativo' } })
      } catch {
        await navigateTo(`/admin/evento/${r.id}/configuracoes`)
        return
      }
    }
    await navigateTo(`/admin/evento/${r.id}/ingressos`)
  } catch (e: any) {
    erro.value = e?.data?.statusMessage || 'Não foi possível criar o evento.'
    const campos = e?.data?.data?.fieldErrors
    if (campos) erros.value = Object.entries(campos).map(([k, v]: any) => `${k}: ${v.join(', ')}`)
  } finally { salvando.value = false }
}

useHead({ title: 'Criar evento' })
</script>

<template>
  <NuxtLayout name="criacao" :passos="PASSOS" :passo="passo"
              :pode-voltar="passo > 1" :salvando="salvando"
              :rotulo-avancar="passo === PASSOS.length ? (f.publicarAoCriar ? 'Criar e publicar' : 'Criar evento') : 'Prosseguir'"
              @voltar="voltar" @avancar="avancar" @sair="sair">

    <div v-if="erros.length || erro"
         class="rounded-card border border-erro bg-erro-claro px-4 py-3 text-sm text-erro">
      <p v-if="erro" class="font-semibold">{{ erro }}</p>
      <ul v-if="erros.length" class="list-disc space-y-0.5 pl-5">
        <li v-for="(x, i) in erros" :key="i">{{ x }}</li>
      </ul>
    </div>

    <!-- ============================================ 1. DADOS BÁSICOS ==== -->
    <template v-if="passo === 1">
      <section class="card">
        <h2 class="titulo-bloco">Informações Básicas</h2>
        <p class="apoio-bloco">
          Seja inventivo ao escolher o nome do seu evento e explique aos participantes por que
          não podem perder essa experiência única.
        </p>
        <hr class="my-4 border-linha">

        <div class="grid gap-4 lg:grid-cols-2">
          <div>
            <label for="nome" class="rotulo">Nome do Evento</label>
            <input id="nome" v-model="f.nome" class="campo" placeholder="Nome do Evento">
          </div>
          <div>
            <label for="slug" class="rotulo">Caminho para a página de vendas</label>
            <div class="flex">
              <span class="flex items-center rounded-l-card border border-r-0 border-linha-campo bg-fundo-cinza px-3 text-sm text-tinta-suave">
                /e/
              </span>
              <input id="slug" v-model="f.slug" class="campo rounded-l-none"
                     placeholder="slug-do-evento"
                     @input="slugTocado = true; f.slug = paraSlug(($event.target as HTMLInputElement).value)">
            </div>
          </div>
        </div>

        <div class="mt-4 grid gap-4 lg:grid-cols-3">
          <div>
            <label for="org" class="rotulo">Organização vinculada</label>
            <select id="org" v-model="f.orgId" class="campo">
              <option value="" disabled>Organização</option>
              <option v-for="o in orgs ?? []" :key="o.id" :value="o.id">{{ o.nome }}</option>
            </select>
          </div>
          <div>
            <label for="idade" class="rotulo">Faixa etária</label>
            <select id="idade" v-model.number="f.faixaEtaria" class="campo">
              <option :value="0">Livre</option>
              <option v-for="n in [10, 12, 14, 16, 18]" :key="n" :value="n">{{ n }} anos</option>
            </select>
          </div>
          <div>
            <label for="moeda" class="rotulo">Moeda</label>
            <select id="moeda" class="campo" disabled>
              <option>Real (R$)</option>
            </select>
          </div>
        </div>

        <p class="mt-4 text-sm text-tinta-suave">
          Marque a caixa 'Privado' para restringir o acesso ao evento apenas para aqueles que possuem o link.
        </p>
        <label class="mt-1 flex items-center gap-2 text-tinta-corpo">
          <input v-model="f.privado" type="checkbox"> Privado
        </label>
      </section>

      <section class="card">
        <h2 class="titulo-bloco">Categorização</h2>
        <p class="apoio-bloco">
          Ajude os participantes a encontrarem seu evento de maneira fácil e rápida: categorize-o com clareza.
        </p>
        <hr class="my-4 border-linha">
        <div class="grid gap-4 lg:grid-cols-2">
          <div>
            <label for="cat" class="rotulo">Categoria</label>
            <select id="cat" v-model="f.categoria" class="campo">
              <option value="">Categorias</option>
              <option v-for="c in ['Show', 'Festa', 'Festival', 'Teatro', 'Esporte', 'Curso', 'Corporativo', 'Parque']"
                      :key="c" :value="c">{{ c }}</option>
            </select>
          </div>
          <div>
            <label for="sub" class="rotulo">Subcategoria</label>
            <input id="sub" class="campo" placeholder="Digite e pressione Enter"
                   :disabled="!f.categoria"
                   @keydown.enter.prevent="(e) => {
                     const v = (e.target as HTMLInputElement).value.trim()
                     if (v && !f.subcategorias.includes(v)) f.subcategorias.push(v)
                     ;(e.target as HTMLInputElement).value = ''
                   }">
            <div v-if="f.subcategorias.length" class="mt-2 flex flex-wrap gap-1.5">
              <span v-for="(s, i) in f.subcategorias" :key="s" class="selo-neutro">
                {{ s }}
                <button type="button" class="ml-1" @click="f.subcategorias.splice(i, 1)">×</button>
              </span>
            </div>
          </div>
        </div>
      </section>

      <section class="card">
        <h2 class="titulo-bloco">Imagens do evento (Opcional)</h2>
        <p class="apoio-bloco">
          Enriqueça seu evento com fotos impactantes e conquiste a atenção imediata dos participantes.
        </p>
        <hr class="my-4 border-linha">
        <div class="grid gap-4 lg:grid-cols-2">
          <div>
            <label for="banner" class="rotulo">Banner (1080 × 1350)</label>
            <input id="banner" v-model="f.banner" class="campo" placeholder="https://…">
          </div>
          <div>
            <label for="thumb" class="rotulo">Miniatura (300 × 230)</label>
            <input id="thumb" v-model="f.thumb" class="campo" placeholder="https://…">
          </div>
        </div>
        <p class="mt-2 text-xs text-tinta-fraca">
          Formatos aceitos: JPG, PNG e WebP. Tamanho máximo: até 700KB.
        </p>
      </section>

      <section class="card">
        <h2 class="titulo-bloco">Onde vai acontecer o seu evento</h2>
        <p class="apoio-bloco">
          Garanta que seu evento seja facilmente localizado e acessível a todos.
        </p>
        <hr class="my-4 border-linha">

        <p class="rotulo">Modalidade do evento</p>
        <div class="mb-4 flex gap-2">
          <button type="button" :class="!f.online ? 'chip-ativo' : 'chip'" @click="f.online = false">
            Presencial
          </button>
          <button type="button" :class="f.online ? 'chip-ativo' : 'chip'" @click="f.online = true">
            Online
          </button>
        </div>

        <div v-if="f.online">
          <label for="link" class="rotulo">Link de transmissão</label>
          <input id="link" v-model="f.linkTransmissao" class="campo" placeholder="https://…">
        </div>

        <div v-else class="grid gap-4 lg:grid-cols-3">
          <div class="lg:col-span-2">
            <label for="ln" class="rotulo">Nome Fantasia (opcional)</label>
            <input id="ln" v-model="f.local.nome" class="campo" placeholder="Ex: Casa A">
          </div>
          <div>
            <label for="cep" class="rotulo">CEP</label>
            <input id="cep" v-model="f.local.cep" class="campo" placeholder="00000-000"
                   inputmode="numeric" @blur="buscarCep">
            <p v-if="buscandoCep" class="mt-1 text-xs text-tinta-fraca">Buscando CEP…</p>
          </div>
          <div class="lg:col-span-2">
            <label for="rua" class="rotulo">Rua / avenida / logradouro</label>
            <input id="rua" v-model="f.local.endereco" class="campo">
          </div>
          <div>
            <label for="num" class="rotulo">Número</label>
            <input id="num" v-model="f.local.numero" class="campo">
          </div>
          <div>
            <label for="bai" class="rotulo">Bairro</label>
            <input id="bai" v-model="f.local.bairro" class="campo">
          </div>
          <div>
            <label for="cid" class="rotulo">Cidade</label>
            <input id="cid" v-model="f.local.cidade" class="campo">
          </div>
          <div>
            <label for="uf" class="rotulo">Estado</label>
            <input id="uf" v-model="f.local.estado" maxlength="2" class="campo uppercase">
          </div>
          <div class="lg:col-span-3">
            <label for="comp" class="rotulo">Complemento (opcional)</label>
            <input id="comp" v-model="f.local.complemento" class="campo">
          </div>
        </div>
      </section>

      <section class="card">
        <h2 class="titulo-bloco">Contato de suporte ao cliente</h2>
        <p class="apoio-bloco">
          Este contato é para quem comprou o ingresso e precisa de suporte em relação ao evento.
        </p>
        <hr class="my-4 border-linha">
        <div class="grid gap-4 lg:grid-cols-3">
          <div>
            <label for="stipo" class="rotulo">Tipo de contato</label>
            <select id="stipo" v-model="f.suporteTipo" class="campo">
              <option value="whatsapp">WhatsApp</option>
              <option value="telefone">Telefone</option>
              <option value="email">E-mail</option>
            </select>
          </div>
          <div class="lg:col-span-2">
            <label for="sval" class="rotulo">Contato</label>
            <input id="sval" v-model="f.suporteValor" class="campo"
                   :placeholder="f.suporteTipo === 'email' ? 'suporte@empresa.com.br' : '(00) 00000-0000'">
          </div>
        </div>
      </section>
    </template>

    <!-- ========================================= 2. DESCRIÇÃO ========== -->
    <template v-if="passo === 2">
      <section class="card">
        <h2 class="titulo-bloco">Descrição do evento (Opcional)</h2>
        <p class="apoio-bloco">
          Detalhe sobre o que se trata o evento e dê o máximo de informação útil para o seu
          participante. Esse campo afeta o posicionamento do evento nos buscadores.
        </p>
        <hr class="my-4 border-linha">
        <textarea v-model="f.descricao" rows="8" class="campo"
                  placeholder="O que vai acontecer, quem toca, o que está incluso, o que levar…"></textarea>
        <p class="mt-1 text-xs text-tinta-fraca">{{ f.descricao.length }} caracteres</p>
      </section>
    </template>

    <!-- ================================ 3. SETORES, LOTES E TIPOS ====== -->
    <template v-if="passo === 3">
      <section class="card">
        <h2 class="titulo-bloco">Setores, lotes e tipos</h2>
        <p class="apoio-bloco">
          Setor é onde a pessoa fica. Lote é a leva que você coloca à venda. Tipo é inteira,
          meia ou promocional dentro do lote. Os preços entram no próximo passo.
        </p>
        <hr class="my-4 border-linha">

        <p v-if="!f.setores.length" class="py-8 text-center text-tinta-suave">
          Nenhum setor ainda.
        </p>

        <div v-for="(s, i) in f.setores" :key="i" class="mb-4 rounded-card border border-linha p-4">
          <div class="flex items-center gap-3">
            <p class="titulo font-semibold text-tinta">Setor {{ i + 1 }}</p>
            <button type="button" class="ml-auto text-sm text-tinta-fraca hover:text-erro"
                    @click="f.setores.splice(i, 1)">Remover setor</button>
          </div>

          <div class="mt-3 grid gap-4 lg:grid-cols-4">
            <div class="lg:col-span-2">
              <label class="rotulo">Nome do setor</label>
              <input v-model="s.nome" class="campo" placeholder="Ex: Entrada individual sábado">
            </div>
            <div>
              <label class="rotulo">Tipo</label>
              <select v-model="s.tipo" class="campo">
                <option value="ingresso">Ingresso</option>
                <option value="passaporte">Passaporte / combo</option>
                <option value="mesa">Mesa</option>
                <option value="camarote">Camarote</option>
              </select>
            </div>
            <div>
              <label class="rotulo">Capacidade (opcional)</label>
              <input v-model.number="s.capacidade" type="number" min="1" class="campo tabular-nums"
                     placeholder="sem teto">
            </div>
          </div>

          <div class="mt-4">
            <p class="rotulo">Lotes deste setor</p>
            <div v-for="(l, j) in s.lotes" :key="j"
                 class="mb-2 flex flex-wrap items-center gap-3 rounded-card bg-fundo px-3 py-2">
              <input v-model="l.nome" class="campo max-w-[200px]" placeholder="Nome do lote">
              <span class="text-sm text-tinta-suave">
                {{ l.tipos.length ? `${l.tipos.length} tipo(s)` : 'sem tipos' }}
              </span>
              <button type="button" class="btn-secundario ml-auto py-1.5 text-sm" @click="novoTipo(l)">
                + Tipo
              </button>
              <button type="button" class="text-sm text-tinta-fraca hover:text-erro"
                      @click="s.lotes.splice(j, 1)">Remover</button>

              <ul v-if="l.tipos.length" class="w-full space-y-2 pt-1">
                <li v-for="(t, k) in l.tipos" :key="k" class="flex flex-wrap items-center gap-2 pl-4">
                  <input v-model="t.nome" class="campo max-w-[180px]" placeholder="Inteira">
                  <label class="flex items-center gap-1 text-sm text-tinta-suave">
                    desconto
                    <input :value="t.descontoBps / 100" type="number" min="0" max="100"
                           class="campo w-20 tabular-nums"
                           @input="t.descontoBps = Math.round(Number(($event.target as HTMLInputElement).value) * 100)">%
                  </label>
                  <label class="flex items-center gap-1 text-sm text-tinta-suave">
                    <input v-model="t.exigeDocumento" type="checkbox"> exige documento
                  </label>
                  <button type="button" class="text-sm text-tinta-fraca hover:text-erro"
                          @click="l.tipos.splice(k, 1)">Remover</button>
                </li>
              </ul>
            </div>
            <button type="button" class="btn-secundario py-1.5 text-sm" @click="novoLote(s)">
              + Lote
            </button>
          </div>
        </div>

        <button type="button" class="btn-primario" @click="novoSetor">+ Adicionar setor</button>
      </section>
    </template>

    <!-- ==================================== 4. PREÇOS E QUANTIDADES ==== -->
    <template v-if="passo === 4">
      <section class="card">
        <h2 class="titulo-bloco">Nomenclatura do bilhete</h2>
        <p class="apoio-bloco">Como o site e os e-mails chamam o que a pessoa compra.</p>
        <hr class="my-4 border-linha">
        <div class="max-w-sm">
          <label for="substantivo" class="rotulo">Nome</label>
          <input id="substantivo" v-model="f.substantivo" maxlength="40" class="campo" placeholder="Ingressos">
        </div>
        <p class="mt-2 text-xs text-tinta-fraca">
          Ex.: Ingressos, Bilhetes, Passaportes. Aparece na página de vendas como
          “Escolha seus {{ (f.substantivo.trim() || 'Ingressos').toLowerCase() }}”.
        </p>
      </section>

      <section class="card">
        <h2 class="titulo-bloco">Política de taxas</h2>
        <p class="apoio-bloco">
          Repassar significa que a taxa entra por cima e o comprador paga. Absorver significa
          que ela sai do que você recebe.
        </p>
        <hr class="my-4 border-linha">
        <div class="grid gap-4 lg:grid-cols-4">
          <div>
            <label class="rotulo">Taxa de serviço (%)</label>
            <input :value="(f.taxaBps / 100).toFixed(2)" type="number" min="0" max="50" step="0.01"
                   class="campo tabular-nums"
                   @input="f.taxaBps = Math.round(Number(($event.target as HTMLInputElement).value) * 100)">
          </div>
          <div>
            <label class="rotulo">Online</label>
            <select v-model="f.modoTaxaOnline" class="campo">
              <option value="repassar">Repassar</option>
              <option value="absorver">Absorver</option>
            </select>
          </div>
          <div>
            <label class="rotulo">PDV / bilheteria</label>
            <select v-model="f.modoTaxaPdv" class="campo">
              <option value="repassar">Repassar</option>
              <option value="absorver">Absorver</option>
            </select>
          </div>
          <div>
            <label class="rotulo">Limite por cliente no evento</label>
            <input v-model.number="f.maxPorCliente" type="number" min="1" class="campo tabular-nums"
                   placeholder="sem limite">
          </div>
        </div>
        <p class="mt-2 text-xs text-tinta-fraca">
          Configurações específicas de ingresso ou setor podem sobrepor essa regra.
        </p>
      </section>

      <section v-for="(s, i) in f.setores" :key="i" class="card">
        <h2 class="titulo-bloco">{{ s.nome || `Setor ${i + 1}` }}</h2>
        <hr class="my-4 border-linha">

        <div v-for="(l, j) in s.lotes" :key="j"
             class="mb-3 rounded-card border border-linha p-4 last:mb-0">
          <div class="flex flex-wrap items-end gap-4">
            <div class="min-w-[160px] flex-1">
              <label class="rotulo">Lote</label>
              <input v-model="l.nome" class="campo">
            </div>
            <div class="w-36">
              <label class="rotulo">Valor de face</label>
              <CampoMoeda v-model="l.faceCents" />
            </div>
            <div class="w-28">
              <label class="rotulo">Quantidade</label>
              <input v-model.number="l.quantidade" type="number" min="1" class="campo tabular-nums">
            </div>
            <div class="w-24">
              <label class="rotulo">Mín. compra</label>
              <input v-model.number="l.minPorCompra" type="number" min="1" max="50" class="campo tabular-nums">
            </div>
            <div class="w-24">
              <label class="rotulo">Máx. compra</label>
              <input v-model.number="l.maxPorCompra" type="number" min="1" max="50" class="campo tabular-nums">
            </div>
            <button type="button" class="btn-secundario"
                    @click="redondoAberto = redondoAberto === l ? null : l; redondoValor = totalDe(l.faceCents)">
              Preço redondo
            </button>
          </div>

          <!-- as quatro pontas do dinheiro -->
          <dl class="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
            <div><dt class="text-xs text-tinta-fraca">Face</dt>
              <dd class="tabular-nums text-tinta">{{ reais(l.faceCents) }}</dd></div>
            <div><dt class="text-xs text-tinta-fraca">Taxa</dt>
              <dd class="tabular-nums text-tinta-suave">{{ reais(taxaDe(l.faceCents)) }}</dd></div>
            <div><dt class="text-xs text-tinta-fraca">Comprador paga</dt>
              <dd class="titulo font-semibold tabular-nums text-tinta">{{ reais(totalDe(l.faceCents)) }}</dd></div>
            <div><dt class="text-xs text-tinta-fraca">Produção recebe</dt>
              <dd class="tabular-nums text-ok">{{ reais(produtorRecebe(l.faceCents)) }}</dd></div>
          </dl>

          <div v-if="redondoAberto === l" class="mt-3 rounded-card bg-acao-fraco p-3">
            <p class="text-sm font-medium text-tinta">Quero que o comprador pague um valor redondo</p>
            <div class="mt-2 flex flex-wrap items-end gap-3">
              <div class="w-36">
                <label class="rotulo">Comprador paga</label>
                <CampoMoeda v-model="redondoValor" />
              </div>
              <button type="button" class="btn-primario"
                      @click="aplicarRedondo(l, redondoValor); redondoAberto = null">
                Aplicar
              </button>
            </div>
          </div>

          <ul v-if="l.tipos.length" class="mt-3 space-y-1.5 border-t border-linha pt-3">
            <li v-for="(t, k) in l.tipos" :key="k" class="flex flex-wrap items-center gap-3 text-sm">
              <span class="min-w-[120px] font-medium text-tinta">{{ t.nome }}</span>
              <label class="flex items-center gap-1 text-tinta-suave">
                quantidade
                <input v-model.number="t.quantidade" type="number" min="1"
                       class="campo w-24 tabular-nums">
              </label>
              <span class="ml-auto tabular-nums text-tinta-suave">
                {{ reais(Math.round(l.faceCents * (1 - t.descontoBps / 10000))) }} +
                {{ reais(taxaDe(Math.round(l.faceCents * (1 - t.descontoBps / 10000)))) }} =
              </span>
              <span class="titulo font-semibold tabular-nums text-tinta">
                {{ reais(totalDe(Math.round(l.faceCents * (1 - t.descontoBps / 10000)))) }}
              </span>
            </li>
          </ul>
        </div>
      </section>

      <section class="card">
        <h2 class="titulo-bloco">Limite do tempo de compra</h2>
        <hr class="my-4 border-linha">
        <div class="w-48">
          <label class="rotulo">Minutos para concluir o pagamento</label>
          <input v-model.number="f.minutosDeReserva" type="number" min="5" max="120"
                 class="campo tabular-nums">
        </div>
        <p class="mt-2 text-xs text-tinta-fraca">
          Passado esse tempo sem pagamento, o ingresso volta para o estoque.
        </p>
      </section>
    </template>

    <!-- ======================================= 5. DATAS E HORÁRIOS ===== -->
    <template v-if="passo === 5">
      <section class="card">
        <h2 class="titulo-bloco">Realização do evento</h2>
        <p class="apoio-bloco">
          Registre a data e horário de início, fim e o fuso horário do evento.
        </p>
        <hr class="my-4 border-linha">
        <div class="grid gap-4 lg:grid-cols-4">
          <div>
            <label for="di" class="rotulo">Início do evento</label>
            <input id="di" v-model="f.inicioData" type="date" class="campo">
          </div>
          <div>
            <label for="hi" class="rotulo">Horário de início</label>
            <input id="hi" v-model="f.inicioHora" type="time" class="campo">
          </div>
          <div>
            <label for="df" class="rotulo">Término do evento</label>
            <input id="df" v-model="f.fimData" type="date" class="campo">
          </div>
          <div>
            <label for="hf" class="rotulo">Horário de término</label>
            <input id="hf" v-model="f.fimHora" type="time" class="campo">
          </div>
          <div class="lg:col-span-2">
            <label for="fuso" class="rotulo">Fuso horário</label>
            <select id="fuso" v-model="f.fuso" class="campo">
              <option value="America/Bahia">Brasília / Bahia (GMT-3)</option>
              <option value="America/Manaus">Manaus (GMT-4)</option>
              <option value="America/Rio_Branco">Rio Branco (GMT-5)</option>
              <option value="America/Noronha">Fernando de Noronha (GMT-2)</option>
            </select>
          </div>
          <label class="flex items-end gap-2 pb-2 text-sm text-tinta-corpo lg:col-span-2">
            <input v-model="f.esconderFim" type="checkbox"> Não mostrar o horário de término
          </label>
        </div>
      </section>

      <section class="card">
        <h2 class="titulo-bloco">Encerramento das vendas</h2>
        <p class="apoio-bloco">
          Quando as vendas param no site. Não impacta a venda em bilheteria (PDV).
        </p>
        <hr class="my-4 border-linha">
        <div class="space-y-2">
          <label class="flex items-center gap-2 text-tinta-corpo">
            <input v-model="f.encerramento" type="radio" value="inicio">
            Encerrar quando o evento começar
          </label>
          <label class="flex flex-wrap items-center gap-2 text-tinta-corpo">
            <input v-model="f.encerramento" type="radio" value="minutos">
            Encerrar
            <input v-model.number="f.encerraMinutos" type="number" min="0" max="10080"
                   class="campo w-24 tabular-nums" :disabled="f.encerramento !== 'minutos'">
            minutos depois do início
          </label>
          <label class="flex flex-wrap items-center gap-2 text-tinta-corpo">
            <input v-model="f.encerramento" type="radio" value="data">
            Encerrar em
            <input v-model="f.encerraData" type="date" class="campo w-40"
                   :disabled="f.encerramento !== 'data'">
            <input v-model="f.encerraHora" type="time" class="campo w-28"
                   :disabled="f.encerramento !== 'data'">
          </label>
        </div>
      </section>

      <section class="card">
        <h2 class="titulo-bloco">Dias do evento</h2>
        <p class="apoio-bloco">
          Configure a oferta de ingressos por dia do evento.
        </p>
        <hr class="my-4 border-linha">
        <label class="flex items-center gap-2 text-tinta-corpo">
          <input v-model="f.porDias" type="checkbox"> Vender ingressos por dias e sessões
        </label>

        <div v-if="f.porDias" class="mt-4 space-y-2">
          <div v-for="(s, i) in f.sessoes" :key="i" class="flex flex-wrap items-end gap-3">
            <div class="min-w-[160px] flex-1">
              <label class="rotulo">Nome da sessão</label>
              <input v-model="s.titulo" class="campo">
            </div>
            <div>
              <label class="rotulo">Data</label>
              <input v-model="s.data" type="date" class="campo">
            </div>
            <div>
              <label class="rotulo">Início</label>
              <input v-model="s.inicio" type="time" class="campo">
            </div>
            <div>
              <label class="rotulo">Fim</label>
              <input v-model="s.fim" type="time" class="campo">
            </div>
            <button type="button" class="pb-2 text-sm text-tinta-fraca hover:text-erro"
                    @click="f.sessoes.splice(i, 1)">Remover</button>
          </div>
          <button type="button" class="btn-secundario"
                  @click="f.sessoes.push({ titulo: '', data: f.inicioData, inicio: f.inicioHora, fim: f.fimHora })">
            + Sessão
          </button>

          <div v-if="f.sessoes.length && f.setores.length" class="mt-4">
            <p class="rotulo">Qual sessão cada setor atende</p>
            <div v-for="(s, i) in f.setores" :key="i" class="mt-2 flex items-center gap-3">
              <span class="min-w-[180px] text-sm text-tinta">{{ s.nome || `Setor ${i + 1}` }}</span>
              <select v-model="s.indiceSessao" class="campo max-w-xs">
                <option :value="null">Todas as sessões</option>
                <option v-for="(x, k) in f.sessoes" :key="k" :value="k">
                  {{ x.titulo || x.data }}
                </option>
              </select>
            </div>
          </div>
        </div>
      </section>

      <!-- conferência final -->
      <section class="card border-acao/40">
        <h2 class="titulo-bloco">Confira antes de criar</h2>
        <hr class="my-4 border-linha">
        <dl class="grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
          <div class="flex justify-between"><dt class="text-tinta-suave">Evento</dt>
            <dd class="text-tinta">{{ f.nome || '—' }}</dd></div>
          <div class="flex justify-between"><dt class="text-tinta-suave">Endereço da página</dt>
            <dd class="text-tinta">/e/{{ f.slug }}</dd></div>
          <div class="flex justify-between"><dt class="text-tinta-suave">Setores</dt>
            <dd class="text-tinta">{{ f.setores.length }}</dd></div>
          <div class="flex justify-between"><dt class="text-tinta-suave">Lotes</dt>
            <dd class="text-tinta">{{ f.setores.reduce((a, s) => a + s.lotes.length, 0) }}</dd></div>
          <div class="flex justify-between"><dt class="text-tinta-suave">Ingressos à venda</dt>
            <dd class="tabular-nums text-tinta">
              {{ f.setores.reduce((a, s) => a + s.lotes.reduce((b, l) => b + l.quantidade, 0), 0) }}
            </dd></div>
          <div class="flex justify-between"><dt class="text-tinta-suave">Visibilidade</dt>
            <dd class="text-tinta">{{ f.privado ? 'Privado (só com link)' : 'Público' }}</dd></div>
        </dl>
        <label class="mt-4 flex items-start gap-2.5 text-sm text-tinta">
          <input v-model="f.publicarAoCriar" type="checkbox" class="mt-1 h-4 w-4 accent-pool-600">
          <span>Publicar assim que criar</span>
        </label>
        <p class="mt-2 text-sm text-tinta-suave">
          <template v-if="f.publicarAoCriar">
            O evento fica <strong>publicado</strong> na hora: a página de vendas abre e ele
            entra na lista do site.
          </template>
          <template v-else>
            O evento nasce como <strong>rascunho</strong>. Publicar é um passo separado — assim
            a página de vendas só abre quando você conferir tudo.
          </template>
        </p>
      </section>
    </template>
  </NuxtLayout>
</template>
