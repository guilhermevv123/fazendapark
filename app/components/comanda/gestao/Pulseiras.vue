<script setup lang="ts">
/**
 * Pulseiras (055): cadastro (encoste uma por uma no leitor do computador — cada leitura
 * cadastra na hora) e a situação de cada uma: livre, em uso (em que conta), bloqueada, descartada.
 * A pulseira não guarda nada: só um número. Quando a conta é paga, ela fica livre de novo.
 */
import { bip, useLeitorDePulseira } from '~/composables/comandaLeitor'
import { chamar, mensagemDoErro } from '~/composables/comandaOffline'
import { dataHora } from '~/composables/formato'

const d = ref<any>(null)
const busca = ref('')
const erro = ref('')
const cadastrando = ref(true)
const ultimas = ref<{ uid: string; jaExistia: boolean; em: Date }[]>([])

async function carregar() {
  try { d.value = await chamar<any>('/api/comandas/pulseiras', { query: { q: busca.value } }); erro.value = '' } catch (e) { erro.value = mensagemDoErro(e) }
}
onMounted(carregar)
let espera: ReturnType<typeof setTimeout> | undefined
watch(busca, () => { clearTimeout(espera); espera = setTimeout(carregar, 300) })

async function cadastrar(uid: string) {
  try {
    const r = await chamar<any>('/api/comandas/pulseiras', { method: 'POST', body: { uid } })
    bip(r.jaExistia ? 'erro' : 'ok')
    ultimas.value = [{ uid, jaExistia: r.jaExistia, em: new Date() }, ...ultimas.value].slice(0, 20)
    carregar()
  } catch (e) { bip('erro'); erro.value = mensagemDoErro(e) }
}
useLeitorDePulseira((uid) => { if (cadastrando.value) cadastrar(uid); else busca.value = uid })

async function acao(p: any, a: string) {
  const motivo = a === 'desbloquear' ? '' : (a === 'bloquear' ? 'perdida' : 'estragada')
  try {
    await chamar('/api/comandas/pulseiras', { method: 'POST', body: { id: p.id, acao: a, motivo } })
    carregar()
  } catch (e) { erro.value = mensagemDoErro(e) }
}
const SIT: Record<string, [string, string]> = { livre: ['Livre', 'selo-ok'], em_uso: ['Em uso', 'selo-alerta'], bloqueada: ['Bloqueada', 'selo-erro'], descartada: ['Descartada', 'selo-neutro'] }
</script>

<template>
  <div class="space-y-4">
    <div v-if="d" class="grid grid-cols-2 gap-3 md:grid-cols-5">
      <div class="card p-4"><p class="rotulo-kpi">Total</p><p class="numero-kpi">{{ d.totais.total }}</p></div>
      <div class="card p-4"><p class="rotulo-kpi">Livres</p><p class="numero-kpi text-ok">{{ d.totais.livre }}</p></div>
      <div class="card p-4"><p class="rotulo-kpi">Em uso</p><p class="numero-kpi">{{ d.totais.em_uso }}</p></div>
      <div class="card p-4"><p class="rotulo-kpi">Bloqueadas</p><p class="numero-kpi">{{ d.totais.bloqueada }}</p></div>
      <div class="card p-4"><p class="rotulo-kpi">Descartadas</p><p class="numero-kpi">{{ d.totais.descartada }}</p></div>
    </div>

    <div class="card space-y-3 p-5">
      <div class="flex flex-wrap items-center gap-2">
        <button type="button" class="chip" :class="cadastrando ? 'chip-ativo' : ''" @click="cadastrando = true">Leitor cadastra</button>
        <button type="button" class="chip" :class="!cadastrando ? 'chip-ativo' : ''" @click="cadastrando = false">Leitor só procura</button>
      </div>
      <p v-if="cadastrando" class="faixa-aviso">Encoste as pulseiras novas no leitor, uma por uma. Cada uma é cadastrada na hora.</p>
      <ul v-if="ultimas.length" class="text-sm">
        <li v-for="u in ultimas" :key="u.uid + u.em.getTime()">{{ u.em.toLocaleTimeString('pt-BR') }} · <b>{{ u.uid }}</b> — {{ u.jaExistia ? 'já estava cadastrada' : 'cadastrada ✓' }}</li>
      </ul>
    </div>

    <p v-if="erro" class="faixa-erro">{{ erro }}</p>
    <div class="card overflow-x-auto p-5">
      <input v-model="busca" class="campo mb-3" placeholder="Procurar número da pulseira">
      <table class="w-full min-w-[620px] text-sm">
        <thead class="text-left text-ink-600"><tr><th class="py-2">Número</th><th>Situação</th><th>Conta agora</th><th>Usos</th><th>Cadastrada</th><th /></tr></thead>
        <tbody class="divide-y divide-linha">
          <tr v-for="p in d?.pulseiras" :key="p.id">
            <td class="py-2 font-mono font-semibold">{{ p.uid }}</td>
            <td><span :class="SIT[p.situacao][1]">{{ SIT[p.situacao][0] }}</span><span v-if="p.motivo" class="ml-1 text-xs text-ink-600">{{ p.motivo }}</span></td>
            <td><NuxtLink v-if="p.conta" :to="`/admin/comandas/conta/${p.conta.id}`" class="font-semibold text-acao">nº {{ p.conta.numero }} · {{ p.conta.nome }}</NuxtLink><span v-else>—</span></td>
            <td>{{ p.usos }}</td>
            <td>{{ dataHora(p.criadoEm) }}</td>
            <td class="text-right">
              <button v-if="p.situacao === 'livre'" type="button" class="btn-secundario text-sm" @click="acao(p, 'bloquear')">Bloquear</button>
              <button v-if="p.situacao === 'livre'" type="button" class="btn-secundario ml-1 text-sm" @click="acao(p, 'descartar')">Descartar</button>
              <button v-if="['bloqueada', 'descartada'].includes(p.situacao)" type="button" class="btn-secundario text-sm" @click="acao(p, 'desbloquear')">Liberar</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
