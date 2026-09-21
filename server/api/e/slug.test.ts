/**
 * Teste da vitrine pública — a tela que o comprador vê antes de confiar dinheiro
 * na gente.
 *
 * POR QUE ELE EXISTE: a vitrine mentia de quatro jeitos diferentes, e nenhum
 * deles lançava exceção, sujava console ou deixava teste vermelho.
 *
 *   1. Lote esgotado continuava com teto de compra cheio — dava pra montar 6
 *      ingressos de um lote com zero em estoque e levar 409 depois do CPF.
 *   2. O setor mostrava todos os lotes ao mesmo tempo. "1º lote / 2º lote" só
 *      significa alguma coisa se o 2º abrir quando o 1º acabar, e isso ninguém
 *      calculava — nem por esgotamento, nem por data.
 *   3. O "a partir de" da home saía de um SELECT próprio, sem olhar estoque e
 *      sem enxergar meia-entrada: anunciava um preço de lote esgotado e
 *      discordava da página do evento sobre o mesmo evento.
 *   4. Evento privado aparecia na listagem e evento oculto abria por link.
 *
 * O teste é de HTTP e vai ao banco de propósito: o que precisa ficar travado é
 * a resposta que sai na rede, não uma cópia da regra em memória.
 *
 * Fixture com ids próprios, apagada no afterAll. NUNCA toca no evento semeado.
 * Sem servidor de dev no ar, PULA em vez de falhar.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const BASE = process.env.BASE_TESTE ?? 'http://localhost:3100'

/** ids fixos: o teste limpa exatamente o que criou, nunca "por nome". */
const ORG = '00000000-0000-4000-8000-0000000e5e01'
const EV_PUB = '00000000-0000-4000-8000-0000000e5e02'
const EV_PRIV = '00000000-0000-4000-8000-0000000e5e03'
const EV_OCULTO = '00000000-0000-4000-8000-0000000e5e04'
const EV_FECHADO = '00000000-0000-4000-8000-0000000e5e05'
const EV_SEM_GIRO = '00000000-0000-4000-8000-0000000e5e06'
const EV_TRAVA = '00000000-0000-4000-8000-0000000e5e07'

const SETOR_GIRO = '00000000-0000-4000-8000-0000000e5e10'
const SETOR_ESGOTADO = '00000000-0000-4000-8000-0000000e5e11'
const SETOR_CANAL = '00000000-0000-4000-8000-0000000e5e12'
const SETOR_SEM_GIRO = '00000000-0000-4000-8000-0000000e5e13'
const SETOR_FECHADO = '00000000-0000-4000-8000-0000000e5e14'
const SETOR_TRAVA = '00000000-0000-4000-8000-0000000e5e15'

const L1 = '00000000-0000-4000-8000-0000000e5e21'
const L2 = '00000000-0000-4000-8000-0000000e5e22'
const L3 = '00000000-0000-4000-8000-0000000e5e23'
const L_SEM_ESTOQUE = '00000000-0000-4000-8000-0000000e5e24'
const L_CARO = '00000000-0000-4000-8000-0000000e5e25'
const L_SO_BILHETERIA = '00000000-0000-4000-8000-0000000e5e26'
const L_AGORA = '00000000-0000-4000-8000-0000000e5e27'
const L_TAMBEM = '00000000-0000-4000-8000-0000000e5e28'
const L_AGENDADO = '00000000-0000-4000-8000-0000000e5e29'
const L_NO_FECHADO = '00000000-0000-4000-8000-0000000e5e2a'
const L_SO_PRATELEIRA = '00000000-0000-4000-8000-0000000e5e2b'
const L_DEPOIS = '00000000-0000-4000-8000-0000000e5e2c'

const T_INTEIRA = '00000000-0000-4000-8000-0000000e5e31'
const T_MEIA = '00000000-0000-4000-8000-0000000e5e32'
const T_UNICO = '00000000-0000-4000-8000-0000000e5e33'

const SLUG_PUB = 'zz-vitrine-teste'
const SLUG_PRIV = 'zz-privado-teste'
const SLUG_OCULTO = 'zz-oculto-teste'
const SLUG_FECHADO = 'zz-fechado-teste'
const SLUG_SEM_GIRO = 'zz-sem-giro-teste'
const SLUG_TRAVA = 'zz-trava-teste'

/**
 * Preços da fixture, com taxa de 10% repassada. São escolhidos pra que cada
 * mentira possível tenha um número DIFERENTE: o "a partir de" denuncia sozinho
 * qual trava caiu.
 */
const TOTAL_L1 = 1100          // 1º lote, inteira — o preço honesto
const TOTAL_L1_MEIA = 550      // meia do 1º lote, esgotada
const TOTAL_L2 = 2200          // 2º lote, abre quando o 1º acabar
const TOTAL_L3 = 3300          // 3º lote
const TOTAL_SEM_ESTOQUE = 550  // lote esgotado do camarote
const TOTAL_SO_BILHETERIA = 110 // lote que não é vendido online
const TOTAL_SO_PRATELEIRA = 770 // lote com lugar livre e variação esgotada
const TOTAL_DEPOIS = 2750       // o lote que vem depois dele

let noAr = false

async function sql(texto: string, par: any[] = []) {
  const { q } = await import('../../utils/db')
  return q<any>(texto, par)
}

const vitrine = (slug: string) => fetch(`${BASE}/api/e/${slug}`)
const listagem = () => fetch(`${BASE}/api/eventos-publicos`).then((r) => r.json())

const setorDe = (v: any, nome: string) => v.setores.find((s: any) => s.nome === nome)
const situacoes = (v: any, nome: string) =>
  (setorDe(v, nome)?.lotes ?? []).map((l: any) => l.situacao)

/**
 * Deixa a fixture no estado inicial. Chamada por todo teste que mexe em
 * estoque ou data: teste que depende da ordem em que o vizinho rodou é teste
 * que fica verde por acaso.
 */
async function semear() {
  await sql(`UPDATE lots SET sold = 2, reserved = 0, expires_at = NULL WHERE id = $1`, [L1])
  await sql(`UPDATE lots SET sold = 0, reserved = 0, expires_at = NULL WHERE id = ANY($1::uuid[])`,
    [[L2, L3, L_CARO]])
  await sql(`UPDATE ticket_types SET sold = 0 WHERE id = $1`, [T_INTEIRA])
  await sql(`UPDATE ticket_types SET sold = 2 WHERE id = $1`, [T_MEIA])
  await sql(`UPDATE events SET status = 'oculto' WHERE id = $1`, [EV_OCULTO])
  // lote com prateleira sobrando (50 − 10) e a única variação zerada (10 de 10)
  await sql(`UPDATE lots SET sold = 10, reserved = 0, expires_at = NULL WHERE id = $1`,
    [L_SO_PRATELEIRA])
  await sql(`UPDATE lots SET sold = 0, reserved = 0, expires_at = NULL WHERE id = $1`, [L_DEPOIS])
  await sql(`UPDATE ticket_types SET sold = quantity WHERE id = $1`, [T_UNICO])
}

beforeAll(async () => {
  try {
    noAr = (await fetch(`${BASE}/api/eventos-publicos`, { signal: AbortSignal.timeout(2500) })).ok
  } catch { noAr = false }
  if (!noAr) return

  await sql(
    `INSERT INTO organizations (id, name, slug)
     VALUES ($1,'ZZ VITRINE TESTE','zz-vitrine-teste-org')
     ON CONFLICT (id) DO NOTHING`, [ORG])

  const evento = (id: string, nome: string, slug: string, extra: Record<string, any>) => sql(
    `INSERT INTO events (id, org_id, name, slug, status, starts_at, ends_at,
                         fee_bps, fee_mode_online, is_private, auto_rotate_lots,
                         sales_end_minutes_after, city, state)
     VALUES ($1,$2,$3,$4,$5, now() + interval '30 days', now() + interval '31 days',
             1000,'repassar',$6,$7,$8,'Ubatã','BA')
     ON CONFLICT (id) DO NOTHING`,
    [id, ORG, nome, slug, extra.status ?? 'ativo', extra.privado ?? false,
     extra.giro ?? true, extra.minutosDepois ?? null])

  await evento(EV_PUB, 'ZZ VITRINE TESTE', SLUG_PUB, {})
  await evento(EV_PRIV, 'ZZ PRIVADO TESTE', SLUG_PRIV, { privado: true })
  await evento(EV_OCULTO, 'ZZ OCULTO TESTE', SLUG_OCULTO, { status: 'oculto' })
  await evento(EV_SEM_GIRO, 'ZZ SEM GIRO TESTE', SLUG_SEM_GIRO, { giro: false })
  await evento(EV_TRAVA, 'ZZ TRAVA TESTE', SLUG_TRAVA, {})

  // Começou faz 2 horas e a venda fechava 1 minuto depois do início: é o
  // encerramento "X minutos após", que o schema guarda em minutos justamente
  // pra sobreviver a remarcação de data.
  await sql(
    `INSERT INTO events (id, org_id, name, slug, status, starts_at, ends_at,
                         fee_bps, fee_mode_online, sales_end_minutes_after, city, state)
     VALUES ($1,$2,'ZZ FECHADO TESTE',$3,'ativo',
             now() - interval '2 hours', now() + interval '2 hours',
             1000,'repassar',1,'Ubatã','BA')
     ON CONFLICT (id) DO NOTHING`, [EV_FECHADO, ORG, SLUG_FECHADO])

  const setor = (id: string, eventoId: string, nome: string, ordem: number) => sql(
    `INSERT INTO sectors (id, event_id, name, sort_order)
     VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING`, [id, eventoId, nome, ordem])

  await setor(SETOR_GIRO, EV_PUB, 'ZZ PISTA', 1)
  await setor(SETOR_ESGOTADO, EV_PUB, 'ZZ CAMAROTE', 2)
  await setor(SETOR_CANAL, EV_PUB, 'ZZ BILHETERIA', 3)
  await setor(SETOR_SEM_GIRO, EV_SEM_GIRO, 'ZZ SOLTO', 1)
  // O evento fechado PRECISA de lote: sem ele o teste de "vendas fechadas"
  // varre uma lista vazia e fica verde com a trava arrancada.
  await setor(SETOR_FECHADO, EV_FECHADO, 'ZZ PISTA FECHADA', 1)
  await setor(SETOR_TRAVA, EV_TRAVA, 'ZZ PISTA TRAVA', 1)

  const lote = (
    id: string, setorId: string, nome: string, preco: number, ordem: number,
    qtd: number, vendidos: number, canais = '{online}', abre: string | null = null,
  ) => sql(
    `INSERT INTO lots (id, sector_id, name, price_cents, sort_order, quantity, sold,
                       max_per_order, channels, starts_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,6,$8::text[],$9)
     ON CONFLICT (id) DO NOTHING`,
    [id, setorId, nome, preco, ordem, qtd, vendidos, canais, abre])

  // 1º lote: 22 lugares, 2 vendidos. Resta 20 — bem acima do limiar de
  // "últimas unidades", pra o teste distinguir 'disponivel' de 'ultimas'.
  await lote(L1, SETOR_GIRO, '1º LOTE', 1000, 1, 22, 2)
  await lote(L2, SETOR_GIRO, '2º LOTE', 2000, 2, 10, 0)
  await lote(L3, SETOR_GIRO, '3º LOTE', 3000, 3, 10, 0)
  await lote(L_SEM_ESTOQUE, SETOR_ESGOTADO, 'CAMAROTE PROMO', 500, 1, 5, 5)
  await lote(L_CARO, SETOR_ESGOTADO, 'CAMAROTE', 4000, 2, 50, 0)
  await lote(L_SO_BILHETERIA, SETOR_CANAL, 'SÓ NO GUICHÊ', 100, 1, 50, 0, '{bilheteria}')
  await lote(L_AGORA, SETOR_SEM_GIRO, 'LOTE A', 1000, 1, 50, 0)
  await lote(L_TAMBEM, SETOR_SEM_GIRO, 'LOTE B', 2000, 2, 50, 0)
  await lote(L_NO_FECHADO, SETOR_FECHADO, 'LOTE DO FECHADO', 1000, 1, 50, 0)
  // 50 lugares, 10 vendidos: a PRATELEIRA do lote ainda tem 40. A única
  // variação dele (T_UNICO) está zerada — ninguém consegue comprar nada.
  await lote(L_SO_PRATELEIRA, SETOR_TRAVA, '1º LOTE TRAVA', 700, 1, 50, 10)
  await lote(L_DEPOIS, SETOR_TRAVA, '2º LOTE TRAVA', 2500, 2, 50, 0)
  await sql(
    `INSERT INTO lots (id, sector_id, name, price_cents, sort_order, quantity, sold,
                       max_per_order, starts_at)
     VALUES ($1,$2,'LOTE AGENDADO',3000,3,50,0,6, now() + interval '10 days')
     ON CONFLICT (id) DO NOTHING`, [L_AGENDADO, SETOR_SEM_GIRO])

  await sql(
    `INSERT INTO ticket_types (id, lot_id, name, quantity, sold, discount_bps, sort_order)
     VALUES ($1,$2,'Inteira',20,0,0,1), ($3,$2,'Meia',2,2,5000,2)
     ON CONFLICT (id) DO NOTHING`, [T_INTEIRA, L1, T_MEIA])

  await sql(
    `INSERT INTO ticket_types (id, lot_id, name, quantity, sold, discount_bps, sort_order)
     VALUES ($1,$2,'Inteira',10,10,0,1)
     ON CONFLICT (id) DO NOTHING`, [T_UNICO, L_SO_PRATELEIRA])

  await semear()
}, 30_000)

afterAll(async () => {
  if (!noAr) return
  // ON DELETE CASCADE leva evento, setor, lote e tipo junto.
  await sql(`DELETE FROM organizations WHERE id = $1`, [ORG])
})

describe('vitrine pública', () => {
  it('a fixture está no ar (senão o resto ficaria verde à toa)', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar em ' + BASE + ')')
    const r = await vitrine(SLUG_PUB)
    expect(r.status).toBe(200)
    const v = await r.json()
    expect(v.setores.length, 'a fixture não subiu').toBeGreaterThan(0)
  }, 20_000)

  it('lote sem estoque aparece como esgotado e com teto de compra zero', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    await semear()
    const v = await vitrine(SLUG_PUB).then((r) => r.json())

    const camarote = setorDe(v, 'ZZ CAMAROTE')
    const promo = camarote.lotes.find((l: any) => l.id === L_SEM_ESTOQUE)

    expect(promo.situacao).toBe('esgotado')
    // ← a trava: teto cheio aqui é o que deixava a tela montar 6 ingressos de
    //   um lote com zero em estoque
    expect(promo.maxPorCompra).toBe(0)
    for (const variacao of promo.variacoes) {
      expect(variacao.esgotado).toBe(true)
      expect(variacao.maxPorCompra).toBe(0)
    }
  }, 20_000)

  it('variação sem estoque não fica comprável dentro de lote com estoque', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    await semear()
    const v = await vitrine(SLUG_PUB).then((r) => r.json())
    const primeiro = setorDe(v, 'ZZ PISTA').lotes.find((l: any) => l.id === L1)

    expect(primeiro.situacao).toBe('disponivel')
    const meia = primeiro.variacoes.find((x: any) => x.tipoId === T_MEIA)
    const inteira = primeiro.variacoes.find((x: any) => x.tipoId === T_INTEIRA)

    // a meia acabou (2 de 2) mesmo com o lote inteiro cheio
    expect(meia.esgotado).toBe(true)
    expect(meia.maxPorCompra).toBe(0)
    expect(inteira.esgotado).toBe(false)
    expect(inteira.maxPorCompra).toBeGreaterThan(0)
  }, 20_000)

  it('o setor vende um lote por vez e vira sozinho quando o lote acaba', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    await semear()

    // --- começo: só o 1º lote está à venda
    let v = await vitrine(SLUG_PUB).then((r) => r.json())
    expect(situacoes(v, 'ZZ PISTA')).toEqual(['disponivel', 'em_breve', 'em_breve'])
    expect(v.evento.aPartirDeCents).toBe(TOTAL_L1)

    // --- 1º lote esgota: o 2º assume sem ninguém mexer em nada
    await sql(`UPDATE lots SET sold = quantity WHERE id = $1`, [L1])
    v = await vitrine(SLUG_PUB).then((r) => r.json())
    // 10 lugares restantes no 2º lote → faixa "últimas", nunca o número
    expect(situacoes(v, 'ZZ PISTA')).toEqual(['esgotado', 'ultimas', 'em_breve'])
    expect(v.evento.aPartirDeCents).toBe(TOTAL_L2)

    // --- 2º lote vence pela data: o 3º assume
    await sql(`UPDATE lots SET expires_at = now() - interval '1 hour' WHERE id = $1`, [L2])
    v = await vitrine(SLUG_PUB).then((r) => r.json())
    expect(situacoes(v, 'ZZ PISTA')).toEqual(['esgotado', 'encerrado', 'ultimas'])
    expect(v.evento.aPartirDeCents).toBe(TOTAL_L3)

    await semear()
  }, 30_000)

  it('sem giro automático cada lote responde por si', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    const v = await vitrine(SLUG_SEM_GIRO).then((r) => r.json())
    // ← se o giro rodasse com a chave desligada, B viraria 'em_breve' e o
    //   produtor perderia o controle lote a lote que a coluna `visible` dá
    expect(situacoes(v, 'ZZ SOLTO')).toEqual(['disponivel', 'disponivel', 'em_breve'])
  }, 20_000)

  it('o "a partir de" nunca anuncia preço que ninguém consegue comprar', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    await semear()
    const v = await vitrine(SLUG_PUB).then((r) => r.json())

    expect(v.evento.aPartirDeCents).toBe(TOTAL_L1)
    // os três preços menores que existem no evento e que NÃO estão à venda
    expect(v.evento.aPartirDeCents).not.toBe(TOTAL_L1_MEIA)      // meia esgotada
    expect(v.evento.aPartirDeCents).not.toBe(TOTAL_SEM_ESTOQUE)  // lote esgotado
    expect(v.evento.aPartirDeCents).not.toBe(TOTAL_SO_BILHETERIA) // fora do canal
  }, 20_000)

  it('home e página do evento dão a MESMA resposta sobre o mesmo evento', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    await semear()

    const naHome = (await listagem()).eventos.find((e: any) => e.slug === SLUG_PUB)
    const naPagina = await vitrine(SLUG_PUB).then((r) => r.json())
    expect(naHome, 'evento público sumiu da home').toBeTruthy()
    // ← duas implementações da mesma regra é como as telas passam a discordar:
    //   a home anunciava a face sem desconto e sem olhar estoque
    expect(naHome.aPartirDeCents).toBe(naPagina.evento.aPartirDeCents)

    // e continuam iguais depois que o lote vigente vira
    await sql(`UPDATE lots SET sold = quantity WHERE id = $1`, [L1])
    const depoisHome = (await listagem()).eventos.find((e: any) => e.slug === SLUG_PUB)
    const depoisPagina = await vitrine(SLUG_PUB).then((r) => r.json())
    expect(depoisHome.aPartirDeCents).toBe(TOTAL_L2)
    expect(depoisHome.aPartirDeCents).toBe(depoisPagina.evento.aPartirDeCents)

    await semear()
  }, 30_000)

  it('lote que só é vendido no guichê não aparece na vitrine online', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    const v = await vitrine(SLUG_PUB).then((r) => r.json())
    // o checkout online recusa esse lote por canal; mostrar é montar uma
    // compra que morre no 409
    expect(setorDe(v, 'ZZ BILHETERIA')).toBeUndefined()
  }, 20_000)

  it('evento não publicado não abre nem por link direto', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    await semear()

    expect((await vitrine(SLUG_OCULTO)).status).toBe(404)
    const lista = await listagem()
    expect(lista.eventos.some((e: any) => e.slug === SLUG_OCULTO)).toBe(false)

    await sql(`UPDATE events SET status = 'rascunho' WHERE id = $1`, [EV_OCULTO])
    expect((await vitrine(SLUG_OCULTO)).status).toBe(404)

    await semear()
  }, 20_000)

  it('evento privado some da listagem e continua abrindo por link', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    const lista = await listagem()
    // ← listar é vazar a pré-venda fechada pra quem não foi convidado
    expect(lista.eventos.some((e: any) => e.slug === SLUG_PRIV)).toBe(false)
    // ...e 404 aqui mataria o único jeito de entrar numa pré-venda fechada
    expect((await vitrine(SLUG_PRIV)).status).toBe(200)
  }, 20_000)

  it('venda que fecha X minutos após o início fecha de verdade', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    const v = await vitrine(SLUG_FECHADO).then((r) => r.json())

    // ← ler só `sales_end_at` deixava o evento vendendo depois de fechado
    expect(v.evento.vendasAbertas).toBe(false)
    expect(v.evento.avisoDeVenda).toBeTruthy()

    // Sem esta conferência o laço abaixo varre uma lista vazia e o teste fica
    // VERDE com a trava arrancada — foi exatamente o que aconteceu: o evento
    // fechado não tinha setor nenhum, e "todo lote fecha" nunca foi exercido.
    const lotes = v.setores.flatMap((s: any) => s.lotes)
    expect(lotes.length, 'fixture do evento fechado ficou sem lote').toBeGreaterThan(0)

    for (const lote of lotes) {
      expect(lote.situacao).toBe('fechado')
      // ← teto cheio num evento fechado é a mesma mentira do lote esgotado:
      //   a tela monta 6 ingressos e o checkout responde 409 depois do CPF
      expect(lote.maxPorCompra).toBe(0)
      for (const variacao of lote.variacoes) expect(variacao.maxPorCompra).toBe(0)
    }

    const lista = await listagem()
    expect(lista.eventos.some((e: any) => e.slug === SLUG_FECHADO)).toBe(false)
  }, 20_000)

  it('lote sem variação pra vender não segura o lote seguinte', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    await semear()

    const v = await vitrine(SLUG_TRAVA).then((r) => r.json())
    const lotes = setorDe(v, 'ZZ PISTA TRAVA').lotes

    // O 1º lote tem 40 lugares livres na prateleira e a única variação zerada.
    // Olhar só `quantity − sold − reserved` o deixava 'disponivel' pra sempre:
    // vigente eterno, 2º lote preso em 'em breve', e ninguém conseguindo
    // comprar coisa nenhuma no evento.
    expect(lotes.map((l: any) => l.situacao)).toEqual(['esgotado', 'disponivel'])
    expect(lotes[0].maxPorCompra).toBe(0)
    for (const variacao of lotes[0].variacoes) expect(variacao.esgotado).toBe(true)

    // e o preço anunciado é o do lote que realmente vende, nos dois lugares
    expect(v.evento.aPartirDeCents).toBe(TOTAL_DEPOIS)
    expect(v.evento.aPartirDeCents).not.toBe(TOTAL_SO_PRATELEIRA)
    const naHome = (await listagem()).eventos.find((e: any) => e.slug === SLUG_TRAVA)
    // ← a home dava o evento por esgotado enquanto a página mostrava o lote
    //   travado como disponível: duas rotas, duas respostas
    expect(naHome.esgotado).toBe(false)
    expect(naHome.aPartirDeCents).toBe(TOTAL_DEPOIS)
  }, 30_000)

  it('a vitrine não devolve contagem de estoque nem configuração do produtor', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    const v = await vitrine(SLUG_PUB).then((r) => r.json())
    const bruto = JSON.stringify(v)

    for (const proibido of [
      'quantity', '"sold"', 'reserved',       // contagem interna do estoque
      'fee_bps', 'feeBps', 'fee_mode',        // política de taxa
      'max_per_customer', 'maxPorCliente',    // teto por CPF
      'group_by_sector', 'agruparPorSetor',   // configuração de tela
      'stream_url', 'is_private', 'auto_rotate', 'channels',
    ]) {
      expect(bruto, `a vitrine devolveu ${proibido}`).not.toContain(proibido)
    }
    // status interno ('oculto', 'adiado', 'cancelado') não é vocabulário de
    // comprador — o que ele precisa é vendasAbertas + aviso em português
    expect(v.evento.status).toBeUndefined()

    // o teto de compra nunca passa do máximo por pedido do lote (6 na fixture)
    for (const setor of v.setores) {
      for (const lote of setor.lotes) expect(lote.maxPorCompra).toBeLessThanOrEqual(6)
    }
  }, 20_000)
})
