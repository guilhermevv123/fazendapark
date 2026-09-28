<script setup lang="ts">
/**
 * Organização — a conta de produtor desta sessão (no menu o nome é singular:
 * o parque é uma organização só, com vários eventos).
 *
 * A rota recorta pela organização da sessão, de propósito (ver o comentário em
 * server/api/admin/organizacoes.get.ts — ela já devolveu a lista inteira do banco
 * pra qualquer login). Por isso a tela é um CARTÃO da organização, e não mais uma
 * tabela com busca e chips (auditoria ORG-02): busca e filtro sobre uma linha só
 * eram controle sem efeito, e ainda moravam fora da URL. Se um dia a sessão
 * enxergar mais de uma organização, cada uma vira um cartão igual a este.
 *
 * Os números são os MESMOS da Visão geral com "Tudo" (e do Financeiro): cobrado é
 * o que os compradores pagaram nos pedidos vivos; líquido é `SQL_LIQUIDO` — o que
 * sobra pro produtor depois da taxa da plataforma e do que voltou. Mesmo nome,
 * mesma conta, em qualquer tela.
 */
import PainelFalha from '~/components/painel/Falha.vue'
import PainelKpi from '~/components/painel/Kpi.vue'
import PainelVazio from '~/components/painel/Vazio.vue'
import { ehDocumentoDeExemplo } from '~/composables/dadosDaEmpresa'

definePageMeta({ layout: 'admin' })

const { data, pending, error: falha, refresh } = await useFetch<any[]>('/api/admin/organizacoes')

/**
 * A situação de cobrança pelo ambiente EFETIVO (prefixo da chave): o `<select>`
 * cru já pintou "EM TESTES" numa conta cobrando de verdade (ORG-01).
 */
function situacao(o: any): { t: string; c: string; frase: string } {
  if (!o.temAsaas) return { t: 'SEM COBRANÇA', c: 'selo-erro', frase: 'Sem chave do Asaas — nenhuma cobrança sai daqui.' }
  return (o.ambienteEfetivo ?? o.ambienteAsaas) === 'production'
    ? { t: 'RECEBENDO', c: 'selo-ok', frase: 'A cobrança vai para a conta de produção do Asaas.' }
    : { t: 'EM TESTES', c: 'selo-alerta', frase: 'Chave de testes (sandbox): ninguém é cobrado de verdade.' }
}

/** documento como a pessoa lê — o de exemplo da instalação não é documento de ninguém */
function documentoLegivel(d: string | null | undefined): string | null {
  if (!d || ehDocumentoDeExemplo(d)) return null
  const x = d.replace(/[^0-9A-Za-z]/g, '').toUpperCase()
  if (x.length === 14) return `${x.slice(0, 2)}.${x.slice(2, 5)}.${x.slice(5, 8)}/${x.slice(8, 12)}-${x.slice(12)}`
  if (x.length === 11) return `${x.slice(0, 3)}.${x.slice(3, 6)}.${x.slice(6, 9)}-${x.slice(9)}`
  return d
}

useHead({ title: 'Organização' })
</script>

<template>
  <div v-if="data">
    <div class="flex flex-wrap items-start justify-between gap-3 py-5">
      <div>
        <h1 class="titulo text-2xl font-semibold text-tinta">Organização</h1>
        <p class="mt-1 text-tinta-suave">
          A conta do parque: eventos, equipe e dinheiro num lugar só.
        </p>
      </div>
      <NuxtLink to="/admin/configuracoes" class="btn-secundario min-h-[40px]" data-acao="editar">
        <IconeMenu nome="lapis" :tamanho="16" /> Editar em Dados e cobrança
      </NuxtLink>
    </div>

    <PainelVazio v-if="!data.length" icone="config" titulo="Nenhuma organização no seu acesso"
                 texto="A sessão não está ligada a nenhuma conta de produtor. Entre de novo ou fale com quem administra o painel." />

    <section v-for="o in data" :key="o.id" class="card grid gap-5" data-parte="organizacao">
      <header class="flex flex-wrap items-start justify-between gap-3">
        <div class="min-w-0">
          <p class="titulo text-xl font-semibold text-ink-900">{{ o.nome }}</p>
          <p class="mt-0.5 font-mono text-xs text-tinta-fraca">/{{ o.slug }}</p>
          <p class="mt-1 text-sm text-tinta-suave" data-parte="documento">
            <template v-if="documentoLegivel(o.documento)">CNPJ/CPF {{ documentoLegivel(o.documento) }}</template>
            <template v-else>CNPJ/CPF a preencher em Dados e cobrança</template>
          </p>
        </div>
        <div class="grid justify-items-end gap-1 text-right">
          <span :class="situacao(o).c" data-parte="selo-situacao">{{ situacao(o).t }}</span>
          <p class="max-w-xs text-xs text-tinta-suave">{{ situacao(o).frase }}</p>
        </div>
      </header>

      <p v-if="o.ambienteDivergente" class="faixa-erro text-sm" data-parte="ambiente-divergente">
        A chave gravada e o ambiente marcado discordam — a cobrança vai para
        {{ o.ambienteEfetivo === 'production' ? 'PRODUÇÃO' : 'TESTES' }}. Corrija em Dados e cobrança.
      </p>

      <div class="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <PainelKpi rotulo="Líquido do produtor" :valor="reais(o.liquidoCents)" tom="grape" icone="financeiro" compacto destaque
                   data-kpi="liquido">
          desde o começo, depois da taxa e das devoluções
        </PainelKpi>
        <PainelKpi rotulo="Total cobrado" :valor="reais(o.faturadoCents)" tom="pool" icone="vendas" compacto
                   data-kpi="cobrado">
          o que os compradores pagaram
        </PainelKpi>
        <PainelKpi rotulo="Eventos" :valor="o.eventos.toLocaleString('pt-BR')" tom="sun" icone="calendario" compacto
                   data-kpi="eventos">
          {{ o.eventosAtivos ? `${o.eventosAtivos} publicado${o.eventosAtivos > 1 ? 's' : ''}` : 'nenhum publicado' }}
        </PainelKpi>
        <PainelKpi rotulo="Pessoas na equipe" :valor="o.pessoas.toLocaleString('pt-BR')" tom="citrus" icone="pessoas" compacto
                   data-kpi="pessoas">
          com acesso ativo ao painel
        </PainelKpi>
      </div>

      <footer class="flex flex-wrap gap-2 border-t border-linha pt-4">
        <NuxtLink :to="{ path: '/admin/relatorios', query: { periodo: 'tudo' } }" class="btn-secundario min-h-[40px]">
          Ver na Visão geral
        </NuxtLink>
        <NuxtLink to="/admin/financeiro" class="btn-secundario min-h-[40px]">Financeiro</NuxtLink>
        <NuxtLink to="/admin/equipe" class="btn-secundario min-h-[40px]">Equipe</NuxtLink>
      </footer>
    </section>
  </div>

  <p v-else-if="pending" class="card mt-6 text-tinta-suave">Carregando…</p>

  <!-- GER-01: 403 diz o motivo sem "Tentar de novo"; sessão vencida leva ao login -->
  <PainelFalha v-else :falha="falha" o-que="a organização" :tentar="refresh" />
</template>
