/**
 * Apoio das baterias do EVENTO (frota F3, 28/09) — `evento.e2e.ts` (computador) e
 * `evento.celular.e2e.ts` (portaria e balcão no celular).
 *
 * Mesmo contrato de `apoio.ts`: nada aqui fala com o banco. O terreno de cada caso (evento, lote,
 * venda de balcão, cortesia) nasce pela MESMA API que a tela chamaria, com a sessão guardada pelo
 * `preparo` — e os QR vêm de `GET /api/pedido/:id`, a rota da página do comprador.
 *
 * Efeitos que ficam no banco de E2E (nunca no real — `travaDeBase`): eventos "ZZE2E F3 …" da
 * organização do seed, com as vendas de balcão, cortesias, cupons e leituras de cada caso. Nenhum
 * e-mail sai (sem SMTP_URL o transporte é o simulado, que grava .eml na pasta temporária) e nenhum
 * pagamento passa pelo Asaas (balcão não usa gateway).
 */
import { expect, request as novoRequest, type APIRequestContext, type Page } from '@playwright/test'
import { BASE, hidratada, sessao, unico, type Papel } from './apoio'

/** A API como um papel — o cookie do `preparo` e a origem que a trava de CSRF confere. */
export async function apiComo(papel: Papel): Promise<APIRequestContext> {
  return novoRequest.newContext({
    baseURL: BASE, storageState: sessao(papel), extraHTTPHeaders: { origin: BASE },
  })
}

/** corpo JSON de uma resposta, falhando com o texto do servidor quando o status não é o esperado */
export async function corpo(r: { status(): number; text(): Promise<string> }, esperado = 200) {
  const texto = await r.text()
  expect(r.status(), texto.slice(0, 400)).toBe(esperado)
  try { return JSON.parse(texto) } catch { return texto }
}

/**
 * Abre e espera hidratar. O `nuxt dev` às vezes reotimiza dependência e RECARREGA a página no meio
 * da primeira carga (o `preparo` documenta): se a hidratação não chega em 60 s, recarrega uma vez —
 * o que se mede é a tela, não o humor do compilador.
 */
export async function abrir(page: Page, caminho: string) {
  await page.goto(caminho)
  try {
    await hidratada(page, 60_000)
  } catch {
    await page.reload()
    await hidratada(page)
  }
  await page.waitForLoadState('networkidle').catch(() => {})
}

/** o texto de uma página sem os espaços duplos (e sem o espaço fino do toLocaleString) */
export const limpo = (t: string | null | undefined) => String(t ?? '').replace(/[\s ]+/g, ' ').trim()

export interface Lote { id: string; nome: string; faceCents: number; tipos: { id: string; nome: string; exigeDocumento: boolean }[] }
export interface EventoDeTeste {
  id: string; slug: string; nome: string
  setorId: string
  /** o lote de 3 tipos (inteira, meia de estudante com documento) — o que o balcão vende */
  lote: Lote
  /** segundo lote, só online — o do "preço redondo" e do "ordenar" */
  loteRedondo: Lote
  inteira: string; meia: string
}

/**
 * Um evento de teste da organização do master, publicado, daqui a `emDias` dias, SEM sessão (a
 * portaria não tem janela de horário pra conferir — o leitor valida agora), taxa de 10% repassada
 * no site e absorvida no balcão.
 */
export async function criarEvento(api: APIRequestContext, opcoes: {
  nome?: string; emDias?: number; publicar?: boolean; semLote?: boolean
} = {}): Promise<EventoDeTeste> {
  const eu = await corpo(await api.get('/api/auth/eu'))
  const inicio = new Date(Date.now() + (opcoes.emDias ?? 3) * 86_400_000)
  inicio.setUTCHours(13, 0, 0, 0)
  const fim = new Date(inicio.getTime() + 8 * 3_600_000)
  const nome = opcoes.nome ?? unico('ZZE2E F3')
  const setores = opcoes.semLote ? [] : [{
    nome: 'Piscinas',
    lotes: [
      {
        nome: '1º lote', faceCents: 3000, quantidade: 300, canais: ['online', 'bilheteria', 'cortesia'],
        tipos: [
          { nome: 'Inteira', quantidade: 300 },
          { nome: 'Meia', quantidade: 300, descontoBps: 5000, exigeDocumento: true },
        ],
      },
      { nome: 'Lote redondo', faceCents: 1000, quantidade: 50, canais: ['online'] },
    ],
  }]
  const criado = await corpo(await api.post('/api/admin/evento', {
    data: {
      orgId: eu.usuario.orgId, nome, inicio: inicio.toISOString(), fim: fim.toISOString(),
      taxaBps: 1000, modoTaxaOnline: 'repassar', modoTaxaPdv: 'absorver',
      local: { nome: 'Parque E2E', cidade: 'Vitória da Conquista', estado: 'BA' },
      publicar: opcoes.publicar ?? !opcoes.semLote, setores,
    },
  }))
  const ing = await corpo(await api.get(`/api/admin/evento/${criado.id}/ingressos`))
  const setor = ing.setores[0]
  const achaLote = (n: string) => setor?.lotes.find((l: any) => l.nome === n)
  const lote = achaLote('1º lote')
  return {
    id: criado.id, slug: criado.slug, nome,
    setorId: setor?.id, lote, loteRedondo: achaLote('Lote redondo'),
    inteira: lote?.tipos.find((t: any) => t.nome === 'Inteira')?.id,
    meia: lote?.tipos.find((t: any) => t.nome === 'Meia')?.id,
  }
}

/** um ponto de venda com caixa aberto pelo papel da `api` */
export async function abrirBalcao(api: APIRequestContext, eventoId: string, fundoCents = 0) {
  const ponto = await corpo(await api.post(`/api/admin/evento/${eventoId}/pdv`, {
    data: { nome: unico('ZZE2E Guichê'), formas: ['dinheiro', 'debito', 'credito', 'pix'] },
  }))
  const turno = await corpo(await api.post(`/api/admin/evento/${eventoId}/pdv/turno`, {
    data: { pontoId: ponto.id, fundoCents },
  }))
  return { pontoId: ponto.id as string, turnoId: turno.turnoId as string }
}

export interface ItemDeBalcao {
  lotId: string; ticketTypeId?: string | null; quantidade: number
  meia?: { motivo: string; documento?: string | null } | null
}

/** uma venda de balcão pela rota do guichê; devolve o pedido e os ingressos com o QR do comprador */
export async function venderNoBalcao(api: APIRequestContext, eventoId: string, turnoId: string,
  itens: ItemDeBalcao[], forma: 'dinheiro' | 'debito' | 'credito' | 'pix' = 'debito',
  extra: Record<string, unknown> = {}) {
  const venda = await corpo(await api.post(`/api/admin/evento/${eventoId}/pdv/venda`, {
    data: { turnoId, itens, forma, ...extra },
  }))
  return { pedidoId: venda.pedidoId as string, ...(await ingressosDoPedido(api, venda.pedidoId)) }
}

/** os ingressos de um pedido pela rota da página do comprador (é de lá que sai o QR) */
export async function ingressosDoPedido(api: APIRequestContext, pedidoId: string) {
  const p = await corpo(await api.get(`/api/pedido/${pedidoId}`))
  return {
    codigoPedido: String(p.pedido),
    ingressos: (p.ingressos as any[]).map((t) => ({
      id: String(t.id), codigo: String(t.codigo), qr: String(t.qr ?? ''), titular: t.titular as string | null,
    })),
  }
}

/** um arquivo baixado pelo `baixarCsv` (tira o BOM) */
export async function textoDoDownload(download: { path(): Promise<string | null> }) {
  const { readFile } = await import('node:fs/promises')
  const caminho = await download.path()
  if (!caminho) throw new Error('o download não gravou arquivo')
  return (await readFile(caminho, 'utf8')).replace(/^﻿/, '')
}

/** a página rola na horizontal? (o corpo inteiro, não a tabela dentro do cartão) */
export async function rolaNaHorizontal(page: Page) {
  return page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)
}

/** um CPF válido (dígitos verificadores certos) que não é de ninguém de propósito: começa com 9 */
export function cpfDeTeste(): string {
  const base = [9, ...Array.from({ length: 8 }, () => Math.floor(Math.random() * 10))]
  const dv = (d: number[]) => { const s = d.reduce((t, n, i) => t + n * (d.length + 1 - i), 0) % 11; return s < 2 ? 0 : 11 - s }
  const d1 = dv(base); const d2 = dv([...base, d1])
  return [...base, d1, d2].join('')
}

/** um código de cupom novo (maiúsculas e dígitos, sem espaço) */
export const codigoDeCupom = (prefixo = 'F3') =>
  `${prefixo}${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 4).toUpperCase()}`

/** dia AAAA-MM-DD daqui a `dias`, no relógio da Bahia (UTC−3, sem horário de verão) */
export function diaNaBahia(dias = 0): string {
  return new Date(Date.now() - 3 * 3_600_000 + dias * 86_400_000).toISOString().slice(0, 10)
}
