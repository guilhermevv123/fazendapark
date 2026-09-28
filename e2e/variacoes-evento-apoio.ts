/**
 * Apoio da bateria de VARIAÇÕES de dentro do evento (`variacoes-evento.e2e.ts`, rodada final V-EVT,
 * 28/09) — o que `evento-apoio.ts` não tem:
 *
 *  - o prefixo ZZVAREVT em tudo que a rodada cria (evento, guichê, cupom, divulgador), pra achar e
 *    esconder depois sem mexer no dado de ninguém;
 *  - SQL direto no banco de E2E, só pra VOLUME que a tela não cria em tempo útil (mais pedidos que o
 *    limite do extrato) e pra CONFERIR o que o servidor gravou quando não há rota que mostre.
 *
 * A trava do SQL é dura: o endereço vem do `.env.e2e` (nunca do ambiente, que pode estar apontando
 * pro banco real) e qualquer banco cujo nome não termine em `_e2e` é recusado antes de conectar.
 */
import { readFileSync } from 'node:fs'
import pg from 'pg'
import { type APIRequestContext } from '@playwright/test'
import { unico } from './apoio'
import { corpo, criarEvento } from './evento-apoio'

/** o prefixo de tudo que esta rodada cria */
export const PREFIXO = 'ZZVAREVT'

function urlDoBancoE2e(): string {
  const env = readFileSync(new URL('../.env.e2e', import.meta.url), 'utf8')
  const m = env.match(/^DATABASE_URL=(.*)$/m)
  if (!m) throw new Error('SQL recusado: .env.e2e sem DATABASE_URL')
  const url = m[1].trim().replace(/^"|"$/g, '')
  const banco = new URL(url).pathname.replace(/^\//, '')
  if (!banco.endsWith('_e2e')) {
    throw new Error(`SQL recusado: o banco "${banco}" não termina em _e2e — a bateria só escreve no banco de E2E`)
  }
  return url
}

/** um comando SQL no banco de E2E (e só nele) */
export async function sqlE2e<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
  const c = new pg.Client({ connectionString: urlDoBancoE2e() })
  await c.connect()
  try {
    return (await c.query(sql, params)).rows as T[]
  } finally {
    await c.end()
  }
}

/** evento da rodada (com o prefixo), escondido no `afterAll` por `esconderEventosDaRodada` */
export function eventoDaRodada(api: APIRequestContext, opcoes: Parameters<typeof criarEvento>[1] = {}) {
  return criarEvento(api, { nome: unico(`${PREFIXO} EV`), ...opcoes })
}

/** um guichê com o prefixo da rodada e o caixa aberto por quem é a `api` */
export async function balcaoDaRodada(api: APIRequestContext, eventoId: string, fundoCents = 0) {
  const nome = unico(`${PREFIXO} Guichê`)
  const ponto = await corpo(await api.post(`/api/admin/evento/${eventoId}/pdv`, {
    data: { nome, formas: ['dinheiro', 'debito', 'credito', 'pix'] },
  }))
  const turno = await corpo(await api.post(`/api/admin/evento/${eventoId}/pdv/turno`, {
    data: { pontoId: ponto.id, fundoCents },
  }))
  return { nome, pontoId: ponto.id as string, turnoId: turno.turnoId as string }
}

/** código de cupom da rodada (maiúsculas e dígitos, até 32) */
export const cupomDaRodada = () =>
  `${PREFIXO}${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 4).toUpperCase()}`

/** "AAAA-MM-DDTHH:mm" do campo datetime-local, no relógio da Bahia, daqui a `dias` dias */
export function campoDataHora(dias: number, hora = '10:00'): string {
  const d = new Date(Date.now() - 3 * 3_600_000 + dias * 86_400_000).toISOString().slice(0, 10)
  return `${d}T${hora}`
}

/** o próximo sábado a pelo menos `minimo` dias daqui (dia da Bahia, AAAA-MM-DD) */
export function proximoSabado(minimo = 10): string {
  for (let i = minimo; i < minimo + 7; i++) {
    const d = new Date(Date.now() - 3 * 3_600_000 + i * 86_400_000)
    if (d.getUTCDay() === 6) return d.toISOString().slice(0, 10)
  }
  throw new Error('sem sábado na semana?')
}
