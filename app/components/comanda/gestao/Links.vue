<script setup lang="ts">
/**
 * Funcionários do app do tablet (055). Cada funcionário recebe um CÓDIGO só dele (o QR do
 * crachá) e um PIN: com os dois, o app do tablet (`app-tablet/`) abre Atender, Pagar e as
 * contas de hoje — nada do resto do sistema. Código e PIN só aparecem na hora de criar (o
 * banco guarda o hash): perdeu, gera outro, e o antigo para de funcionar.
 *
 * Até 28/11/2026 o código era um LINK aberto no navegador (`/comanda/<código>`); a página
 * saiu e só o app entra. A tabela continua `comanda_links` (o código é o segredo do link).
 */
import QRCode from 'qrcode'
import { chamar, mensagemDoErro } from '~/composables/comandaOffline'
import { dataHora } from '~/composables/formato'

const links = ref<any[]>([])
const erro = ref('')
async function carregar() {
  try { links.value = (await chamar<any>('/api/comandas/gestao/links')).links; erro.value = '' } catch (e) { erro.value = mensagemDoErro(e) }
}
onMounted(carregar)

const nome = ref('')
const salvando = ref(false)
/** o código recém-criado, para imprimir o crachá ou copiar (só agora) */
const novo = ref<{ nome: string; codigo: string; qr: string; pin: string } | null>(null)
const copiado = ref(false)

async function acao(corpo: Record<string, unknown>, nomeDoLink?: string) {
  erro.value = ''
  salvando.value = true
  try {
    const r = await chamar<any>('/api/comandas/gestao/links', { method: 'POST', body: corpo })
    if (r.segredo) {
      const qr = await QRCode.toDataURL(r.segredo, { margin: 1, width: 320 }).catch(() => '')
      novo.value = { nome: nomeDoLink ?? '', codigo: r.segredo, qr, pin: r.pin }
      copiado.value = false
    }
    await carregar()
    return r
  } catch (e) { erro.value = mensagemDoErro(e) } finally { salvando.value = false }
}
async function criar() {
  const n = nome.value.trim()
  if (await acao({ acao: 'criar', nome: n }, n)) nome.value = ''
}
const confirmando = ref<{ id: string; acao: 'novo_segredo' | 'desligar'; nome: string } | null>(null)
async function confirmar() {
  const c = confirmando.value
  if (!c) return
  await acao({ acao: c.acao, id: c.id }, c.nome)
  confirmando.value = null
}
async function copiar() {
  if (!novo.value) return
  try { await navigator.clipboard.writeText(novo.value.codigo); copiado.value = true } catch { copiado.value = false }
}
const whatsapp = computed(() => novo.value
  ? `https://wa.me/?text=${encodeURIComponent(`Olá, ${novo.value.nome}! Este é o seu código para entrar no app das comandas do parque. No tablet, abra o app, toque em "cole o seu código de acesso" e cole este código. Não compartilhe com ninguém. O PIN eu te passo pessoalmente.\n${novo.value.codigo}`)}`
  : '')
</script>

<template>
  <div class="space-y-4">
    <p v-if="erro" class="faixa-erro">{{ erro }}</p>

    <div class="card space-y-3 p-5">
      <div>
        <p class="titulo-bloco">Cadastrar funcionário no app do tablet</p>
        <p class="text-sm text-ink-600">O funcionário entra no <b>app do tablet</b> lendo o QR do crachá dele e digitando um PIN de 4 números que só ele sabe. No app ele vê só <b>Atender</b>, <b>Pagar</b> e as <b>contas de hoje</b>: nada de relatórios, caixa, configurações ou o resto do sistema. Tudo que ele fizer fica com o nome dele.</p>
      </div>
      <form class="flex flex-wrap gap-2" @submit.prevent="criar">
        <input v-model="nome" class="campo min-w-[220px] flex-1" placeholder="Nome do funcionário (ex.: João do bar)" maxlength="60" aria-label="Nome do funcionário">
        <button type="submit" class="btn-primario" :disabled="nome.trim().length < 2 || salvando">Criar acesso</button>
      </form>
    </div>

    <div v-if="novo" class="card space-y-3 border-l-4 border-l-acao p-5" data-parte="link-novo">
      <p class="titulo-bloco">Acesso de {{ novo.nome }}</p>
      <p class="text-sm text-ink-600">Imprima o QR no crachá do funcionário (ou mande o código) e passe o PIN <b>pessoalmente</b>, nunca junto com o código. Por segurança, código e PIN <b>só aparecem esta vez</b>. Se perder, gere novos na lista abaixo.</p>
      <div v-if="novo.qr" class="flex flex-wrap items-center gap-4">
        <img :src="novo.qr" :alt="`QR do crachá de ${novo.nome}`" class="h-40 w-40 rounded-card ring-1 ring-linha" data-parte="qr-cracha">
        <a :href="novo.qr" :download="`cracha-${novo.nome}.png`" class="btn-secundario inline-flex items-center">Baixar QR do crachá</a>
      </div>
      <div class="flex items-center gap-3 rounded-card bg-ink-50 px-4 py-3">
        <span class="text-sm font-semibold text-ink-700">PIN de {{ novo.nome }}</span>
        <span class="font-mono text-3xl font-bold tracking-[0.3em] text-ink-900">{{ novo.pin }}</span>
      </div>
      <div class="flex flex-wrap gap-2">
        <input :value="novo.codigo" readonly class="campo min-w-[260px] flex-1 font-mono text-sm" aria-label="Código do funcionário" @focus="($event.target as HTMLInputElement).select()">
        <button type="button" class="btn-primario" @click="copiar">{{ copiado ? 'Copiado ✓' : 'Copiar código' }}</button>
        <a :href="whatsapp" target="_blank" rel="noopener" class="btn-secundario inline-flex items-center">Enviar no WhatsApp</a>
      </div>
      <button type="button" class="text-sm font-semibold text-ink-600 hover:text-ink-900" @click="novo = null">Já copiei, fechar</button>
    </div>

    <div class="card overflow-hidden">
      <p class="titulo-bloco px-5 pt-5">Funcionários com acesso ({{ links.length }})</p>
      <p v-if="!links.length" class="px-5 pb-5 pt-1 text-sm text-ink-600">Nenhum funcionário ainda.</p>
      <table v-else class="mt-3 w-full text-sm">
        <thead class="border-y border-linha bg-ink-50 text-left text-xs uppercase tracking-wider text-ink-600">
          <tr><th class="px-5 py-2">Funcionário</th><th class="py-2">Situação</th><th class="py-2">Último uso</th><th class="py-2 text-right">Pedidos</th><th class="px-5 py-2" /></tr>
        </thead>
        <tbody class="divide-y divide-linha">
          <tr v-for="k in links" :key="k.id" :class="k.ativo ? '' : 'text-ink-600'">
            <td class="px-5 py-3"><span class="font-semibold text-ink-900">{{ k.nome }}</span><br><span class="text-xs text-ink-600">criado em {{ dataHora(k.criadoEm) }}</span></td>
            <td>
              <span v-if="k.ativo && !k.temPin" class="selo-alerta">Sem PIN: gere um novo</span>
              <span v-else-if="k.ativo && k.travado" class="selo-erro">Travado (PIN errado)</span>
              <span v-else :class="k.ativo ? 'selo-ok' : 'selo-neutro'">{{ k.ativo ? 'Ligado' : 'Desligado' }}</span>
            </td>
            <td>{{ k.ultimoUsoEm ? dataHora(k.ultimoUsoEm) : 'nunca usou' }}</td>
            <td class="text-right tabular-nums">{{ k.pedidos }}</td>
            <td class="px-5 text-right">
              <div v-if="confirmando?.id === k.id" class="flex flex-wrap items-center justify-end gap-2">
                <span class="text-xs">{{ confirmando.acao === 'desligar' ? 'Desligar? O tablet para de funcionar na hora.' : 'Gerar código e PIN novos? Os atuais param de funcionar.' }}</span>
                <button type="button" class="btn-secundario px-3 py-1.5 text-xs" @click="confirmando = null">Não</button>
                <button type="button" class="btn-primario px-3 py-1.5 text-xs" :disabled="salvando" @click="confirmar">Sim</button>
              </div>
              <div v-else class="flex justify-end gap-1">
                <button type="button" class="rounded-card px-3 py-1.5 text-xs font-semibold text-acao hover:bg-acao-claro"
                        @click="confirmando = { id: k.id, acao: 'novo_segredo', nome: k.nome }">{{ k.ativo ? 'Gerar código e PIN novos' : 'Religar com código novo' }}</button>
                <button v-if="k.ativo" type="button" class="rounded-card px-3 py-1.5 text-xs font-semibold text-danger-600 hover:bg-ink-50"
                        @click="confirmando = { id: k.id, acao: 'desligar', nome: k.nome }">Desligar</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
