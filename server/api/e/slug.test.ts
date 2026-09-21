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
const EV_COTA = '00000000-0000-4000-8000-0000000e5e08'
const EV_TERMINOU = '00000000-0000-4000-8000-0000000e5e09'
const EV_EMPATE = '00000000-0000-4000-8000-0000000e5e0a'
/** teto do PEDIDO (`events.max_per_order = 4`), sem teto por CPF no evento */
const EV_TETOS = '00000000-0000-4000-8000-0000000e5e0b'
/** teto por CPF no EVENTO (`events.max_per_customer = 3`), sem teto de pedido */
const EV_TETO_CPF = '00000000-0000-4000-8000-0000000e5e0c'
/** rascunho: não existe pro comprador, nem por link direto */
const EV_RASCUNHO = '00000000-0000-4000-8000-0000000e5e0d'

const SETOR_GIRO = '00000000-0000-4000-8000-0000000e5e10'
const SETOR_ESGOTADO = '00000000-0000-4000-8000-0000000e5e11'
const SETOR_CANAL = '00000000-0000-4000-8000-0000000e5e12'
const SETOR_SEM_GIRO = '00000000-0000-4000-8000-0000000e5e13'
const SETOR_FECHADO = '00000000-0000-4000-8000-0000000e5e14'
const SETOR_TRAVA = '00000000-0000-4000-8000-0000000e5e15'
const SETOR_COTA = '00000000-0000-4000-8000-0000000e5e16'
const SETOR_TERMINOU = '00000000-0000-4000-8000-0000000e5e17'
const SETOR_EMPATE = '00000000-0000-4000-8000-0000000e5e18'
/** setor SEM teto por CPF: nele quem aperta é o pedido, o lote ou o tipo */
const SETOR_TETO_LIVRE = '00000000-0000-4000-8000-0000000e5e19'
/** setor com `max_per_customer = 3` */
const SETOR_TETO_SETOR = '00000000-0000-4000-8000-0000000e5e1a'
/** setor do evento que limita por CPF */
const SETOR_TETO_EVENTO = '00000000-0000-4000-8000-0000000e5e1b'

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
const L_COTA = '00000000-0000-4000-8000-0000000e5e2d'
const L_TERMINOU = '00000000-0000-4000-8000-0000000e5e2e'
const L_IRMAO_A = '00000000-0000-4000-8000-0000000e5e41'
const L_IRMAO_B = '00000000-0000-4000-8000-0000000e5e42'
const L_IRMAO_C = '00000000-0000-4000-8000-0000000e5e43'
/** um lote por teto duro — cada um com um dono diferente do número */
const L_TETO_PEDIDO = '00000000-0000-4000-8000-0000000e5e61'
const L_TETO_LOTE = '00000000-0000-4000-8000-0000000e5e62'
const L_TETO_TIPO = '00000000-0000-4000-8000-0000000e5e63'
const L_TETO_SETOR = '00000000-0000-4000-8000-0000000e5e64'
const L_TETO_EVENTO = '00000000-0000-4000-8000-0000000e5e65'

const T_INTEIRA = '00000000-0000-4000-8000-0000000e5e31'
const T_MEIA = '00000000-0000-4000-8000-0000000e5e32'
const T_UNICO = '00000000-0000-4000-8000-0000000e5e33'
const T_COTA_INTEIRA = '00000000-0000-4000-8000-0000000e5e51'
const T_COTA_MEIA = '00000000-0000-4000-8000-0000000e5e52'
const T_TETO_TIPO = '00000000-0000-4000-8000-0000000e5e53'

const SLUG_PUB = 'zz-vitrine-teste'
const SLUG_PRIV = 'zz-privado-teste'
const SLUG_OCULTO = 'zz-oculto-teste'
const SLUG_FECHADO = 'zz-fechado-teste'
const SLUG_SEM_GIRO = 'zz-sem-giro-teste'
const SLUG_TRAVA = 'zz-trava-teste'
const SLUG_COTA = 'zz-cota-teste'
const SLUG_TERMINOU = 'zz-terminou-teste'
const SLUG_EMPATE = 'zz-empate-teste'
const SLUG_TETOS = 'zz-tetos-teste'
const SLUG_TETO_CPF = 'zz-teto-cpf-teste'
const SLUG_RASCUNHO = 'zz-rascunho-teste'

/**
 * Espelho de `TETO_PADRAO_POR_PEDIDO` (server/api/e/[slug].get.ts): o teto que
 * vale quando o produtor não declarou nenhum. Escrito aqui, não importado: o
 * arquivo roda em `environment: node`, sem os auto-imports do Nitro, e importar
 * a rota quebra logo no `defineEventHandler` do topo. Espelhar também é o
 * ponto — mexer no padrão do produto acende luz vermelha aqui em vez de passar
 * sozinho.
 */
const TETO_PADRAO_POR_PEDIDO = 20

/**
 * A cota legal de meia-entrada do lote da fixture: 40% de 10 lugares
 * (Decreto 8.537/2015). O número é escrito aqui em vez de importado de
 * propósito — se a cota mudar de valor, este teste fica vermelho e a mudança
 * vira uma decisão em vez de um efeito colateral.
 */
const COTA_DO_L_COTA = 4

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

/** CPF sintético que passa no dígito verificador — um por compra. */
function cpf(): string {
  const d = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10))
  const dig = (arr: number[], peso: number) => {
    const r = (arr.reduce((a, n, i) => a + n * (peso - i), 0) * 10) % 11
    return r === 10 ? 0 : r
  }
  d.push(dig(d, 10)); d.push(dig(d, 11))
  return d.join('')
}

/**
 * Tenta COMPRAR de verdade, pela mesma rota do comprador. É o que transforma
 * este arquivo de "teste de vitrine" em teste de coerência: a tela só está
 * certa se a porta concordar com ela.
 */
async function comprar(slug: string, item: Record<string, any>) {
  const r = await fetch(`${BASE}/api/checkout`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      eventSlug: slug,
      itens: [item],
      comprador: {
        nome: 'Comprador da Vitrine', documento: cpf(),
        email: `zz.vitrine.${Date.now()}.${Math.random()}@exemplo.com`,
      },
      forma: 'pix',
    }),
  })
  const corpo = await r.json().catch(() => ({}))
  return { status: r.status, recado: corpo.statusMessage ?? corpo.message ?? '', corpo }
}

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
  await sql(`UPDATE lots SET sold = 0, reserved = 0, expires_at = NULL WHERE id = ANY($1::uuid[])`,
    [[L_COTA, L_TERMINOU, L_IRMAO_A, L_IRMAO_B, L_IRMAO_C]])
  await sql(`UPDATE ticket_types SET sold = 0 WHERE id = ANY($1::uuid[])`,
    [[T_COTA_INTEIRA, T_COTA_MEIA]])
  // Os lotes dos tetos têm 500 lugares e a varredura compra deles: sem este
  // reset o `sold` só sobe e o teste acaba medindo estoque em vez de teto.
  await sql(`UPDATE lots SET sold = 0, reserved = 0 WHERE id = ANY($1::uuid[])`,
    [[L_TETO_PEDIDO, L_TETO_LOTE, L_TETO_TIPO, L_TETO_SETOR, L_TETO_EVENTO]])
  await sql(`UPDATE ticket_types SET sold = 0 WHERE id = $1`, [T_TETO_TIPO])
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
  await evento(EV_COTA, 'ZZ COTA TESTE', SLUG_COTA, {})
  await evento(EV_EMPATE, 'ZZ EMPATE TESTE', SLUG_EMPATE, {})

  // Já TERMINOU: começou anteontem, acabou ontem, e ninguém fechou a venda na
  // mão. `sales_end_at` e `sales_end_minutes_after` seguem nulos de propósito
  // — é o evento que acabou sozinho, o caso que a vitrine não enxergava.
  await sql(
    `INSERT INTO events (id, org_id, name, slug, status, starts_at, ends_at,
                         fee_bps, fee_mode_online, city, state)
     VALUES ($1,$2,'ZZ TERMINOU TESTE',$3,'ativo',
             now() - interval '2 days', now() - interval '1 day',
             1000,'repassar','Ubatã','BA')
     ON CONFLICT (id) DO NOTHING`, [EV_TERMINOU, ORG, SLUG_TERMINOU])

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
  await setor(SETOR_COTA, EV_COTA, 'ZZ PISTA COTA', 1)
  await setor(SETOR_TERMINOU, EV_TERMINOU, 'ZZ PISTA TERMINOU', 1)
  await setor(SETOR_EMPATE, EV_EMPATE, 'ZZ IRMÃOS', 1)

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
  // 10 lugares → a cota legal deixa passar 4 meias (COTA_DO_L_COTA), e a
  // prateleira da meia tem 6. Os dois números são diferentes DE PROPÓSITO:
  // com 6 na prateleira e 4 na cota, só quem enxerga a cota acerta o teto.
  await lote(L_COTA, SETOR_COTA, 'LOTE COM COTA', 5000, 1, 10, 0)
  await lote(L_TERMINOU, SETOR_TERMINOU, 'LOTE DO QUE TERMINOU', 1000, 1, 50, 0)

  // Três lotes IRMÃOS no mesmo setor, todos em `sort_order = 0`: o produtor
  // nunca disse quem é o 1º. Ver `situacoesDoSetor`.
  for (const id of [L_IRMAO_A, L_IRMAO_B, L_IRMAO_C]) {
    await sql(
      `INSERT INTO lots (id, sector_id, name, price_cents, sort_order, quantity, sold,
                         max_per_order, channels)
       VALUES ($1,$2,$3,3000,0,50,0,6,'{online}')
       ON CONFLICT (id) DO NOTHING`,
      [id, SETOR_EMPATE, 'IRMÃO ' + (id === L_IRMAO_A ? 'A' : id === L_IRMAO_B ? 'B' : 'C')])
  }
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

  // As duas variações do lote com cota. A INTEIRA pede documento e NÃO é meia
  // (preço cheio, `discount_bps = 0`): é o ingresso nominal, e a coluna gerada
  // `ticket_types.kind` é quem sabe disso. A meia tem 6 na prateleira contra
  // uma cota de 4.
  await sql(
    `INSERT INTO ticket_types (id, lot_id, name, quantity, sold, discount_bps,
                               requires_document, sort_order)
     VALUES ($1,$2,'Inteira nominal',4,0,0,true,1),
            ($3,$2,'Meia',6,0,5000,true,2)
     ON CONFLICT (id) DO NOTHING`, [T_COTA_INTEIRA, L_COTA, T_COTA_MEIA])

  // ---------------------------------------------- os cinco tetos duros -----
  // Um lote por teto, com estoque de sobra (500) em todos: assim o número que
  // a vitrine anuncia SÓ pode ter vindo do teto, nunca da prateleira. Os
  // valores são todos diferentes (4, 2, 1, 3, 3) pra que arrancar UM clamp
  // mexa em UM lote — teste que muda tudo junto não diz qual trava caiu.
  await sql(
    `INSERT INTO events (id, org_id, name, slug, status, starts_at, ends_at,
                         fee_bps, fee_mode_online, auto_rotate_lots,
                         max_per_order, max_per_customer, city, state)
     VALUES ($1,$2,'ZZ TETOS TESTE',$3,'ativo',
             now() + interval '30 days', now() + interval '31 days',
             1000,'repassar',false,4,NULL,'Ubatã','BA')
     ON CONFLICT (id) DO NOTHING`, [EV_TETOS, ORG, SLUG_TETOS])
  await sql(
    `INSERT INTO events (id, org_id, name, slug, status, starts_at, ends_at,
                         fee_bps, fee_mode_online, auto_rotate_lots,
                         max_per_order, max_per_customer, city, state)
     VALUES ($1,$2,'ZZ TETO CPF TESTE',$3,'ativo',
             now() + interval '30 days', now() + interval '31 days',
             1000,'repassar',false,NULL,3,'Ubatã','BA')
     ON CONFLICT (id) DO NOTHING`, [EV_TETO_CPF, ORG, SLUG_TETO_CPF])
  // Rascunho: existe no banco e NÃO existe pro comprador.
  await sql(
    `INSERT INTO events (id, org_id, name, slug, status, starts_at, ends_at,
                         fee_bps, fee_mode_online, city, state)
     VALUES ($1,$2,'ZZ LANÇAMENTO SECRETO',$3,'rascunho',
             now() + interval '30 days', now() + interval '31 days',
             1000,'repassar','Ubatã','BA')
     ON CONFLICT (id) DO NOTHING`, [EV_RASCUNHO, ORG, SLUG_RASCUNHO])

  const setorComTeto = (id: string, eventoId: string, nome: string, teto: number | null) => sql(
    `INSERT INTO sectors (id, event_id, name, sort_order, max_per_customer)
     VALUES ($1,$2,$3,1,$4) ON CONFLICT (id) DO NOTHING`, [id, eventoId, nome, teto])
  await setorComTeto(SETOR_TETO_LIVRE, EV_TETOS, 'ZZ SEM TETO DE SETOR', null)
  await setorComTeto(SETOR_TETO_SETOR, EV_TETOS, 'ZZ SETOR COM TETO', 3)
  await setorComTeto(SETOR_TETO_EVENTO, EV_TETO_CPF, 'ZZ PISTA DO TETO POR CPF', null)

  // `auto_rotate_lots = false` nos dois eventos: aqui cada lote responde por
  // si. Com giro ligado, só o primeiro do setor ficaria comprável e os outros
  // quatro sairiam 'em_breve' — o teste mediria giro, não teto.
  const loteComTeto = (
    id: string, setorId: string, nome: string, ordem: number,
    porDocumento: number | null = null,
  ) => sql(
    `INSERT INTO lots (id, sector_id, name, price_cents, sort_order, quantity, sold,
                       max_per_order, limit_by_document, max_per_document)
     VALUES ($1,$2,$3,1000,$4,500,0,6,$5,$6)
     ON CONFLICT (id) DO NOTHING`,
    [id, setorId, nome, ordem, porDocumento != null, porDocumento])

  await loteComTeto(L_TETO_PEDIDO, SETOR_TETO_LIVRE, 'LOTE DO TETO DE PEDIDO', 1)
  await loteComTeto(L_TETO_LOTE, SETOR_TETO_LIVRE, 'LOTE 2 POR CPF', 2, 2)
  await loteComTeto(L_TETO_TIPO, SETOR_TETO_LIVRE, 'LOTE COM TIPO LIMITADO', 3)
  await loteComTeto(L_TETO_SETOR, SETOR_TETO_SETOR, 'LOTE DO SETOR LIMITADO', 1)
  await loteComTeto(L_TETO_EVENTO, SETOR_TETO_EVENTO, 'LOTE DO EVENTO LIMITADO', 1)

  await sql(
    `INSERT INTO ticket_types (id, lot_id, name, quantity, sold, discount_bps,
                               max_per_customer, sort_order)
     VALUES ($1,$2,'Nominativo',500,0,0,1,1)
     ON CONFLICT (id) DO NOTHING`, [T_TETO_TIPO, L_TETO_TIPO])

  await semear()
}, 30_000)

afterAll(async () => {
  if (!noAr) return
  // Os pedidos saem PRIMEIRO: `order_items.lot_id` é ON DELETE RESTRICT, então
  // a organização não cai enquanto existir uma compra do teste de coerência
  // pendurada nos lotes dela.
  await sql(`DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE org_id = $1)`,
    [ORG])
  await sql(`DELETE FROM tickets WHERE order_id IN (SELECT id FROM orders WHERE org_id = $1)`, [ORG])
  await sql(`DELETE FROM orders WHERE org_id = $1`, [ORG])
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

/**
 * A vitrine e a porta contam a MESMA história.
 *
 * Esta é a trava que impede a porta de reabrir. Todo furo desta trilha é a
 * mesma doença em lugares diferentes: a tela decide uma coisa, o checkout
 * decide outra, e ninguém vê — porque cada lado, sozinho, parece certo. O
 * comprador é que descobre, depois de digitar nome, e-mail e CPF.
 *
 * Por isso o teste principal daqui não confere uma regra: ele PERCORRE a
 * vitrine e tenta comprar cada lote que ela mostra. O que a tela disse que
 * está à venda tem que dar 200. O que ela disse que está fechado tem que dar
 * 409 — e com um recado que o comprador consiga ler.
 */
describe('coerência — o que a vitrine mostra é o que o checkout aceita', () => {
  const pular = () => {
    if (!noAr) console.warn('  (pulado: servidor fora do ar em ' + BASE + ')')
    return !noAr
  }

  /** As situações que a vitrine anuncia como "dá pra comprar". */
  const COMPRAVEL = ['disponivel', 'ultimas']

  /** O item de compra que a PRÓPRIA vitrine oferece para este lote. */
  const itemOferecido = (lote: any) => {
    const v = lote.variacoes.find((x: any) => !x.esgotado) ?? lote.variacoes[0]
    if (!v?.tipoId) return { lotId: lote.id, quantidade: 1 }
    return {
      lotId: lote.id, ticketTypeId: v.tipoId, quantidade: 1,
      ...(v.ehMeia ? { meia: { motivo: 'idoso' } } : {}),
    }
  }

  it('percorre a vitrine inteira e tenta comprar cada lote', async () => {
    if (pular()) return
    await semear()

    const slugs = [SLUG_PUB, SLUG_SEM_GIRO, SLUG_TRAVA, SLUG_FECHADO,
      SLUG_COTA, SLUG_TERMINOU, SLUG_EMPATE, SLUG_TETOS, SLUG_TETO_CPF]
    let visitados = 0

    for (const slug of slugs) {
      const v = await vitrine(slug).then((r) => r.json())
      const lotes = v.setores.flatMap((s: any) => s.lotes)
      // Vitrine vazia varre lista vazia e fica verde com a trava arrancada.
      expect(lotes.length, `${slug} ficou sem lote na fixture`).toBeGreaterThan(0)

      for (const lote of lotes) {
        visitados++
        const onde = `${slug} / ${lote.nome} (${lote.situacao})`
        const r = await comprar(slug, itemOferecido(lote))

        if (COMPRAVEL.includes(lote.situacao)) {
          // ← a metade que some sem ninguém ver: a tela vende, a porta recusa
          expect(r.status, `${onde} devia vender e respondeu ${r.status}: ${r.recado}`).toBe(200)
          continue
        }

        // Fechado na tela tem que ser fechado na porta — e 409, nunca 500:
        // "Server Error" na cara do comprador é defeito nosso vestido de
        // recusa (era o que o dia lotado respondia).
        expect(r.status, `${onde} devia recusar e respondeu ${r.status}`).toBe(409)
        expect(r.recado, `${onde} recusou sem recado`).toBeTruthy()
        expect(r.recado, `${onde} recusou com erro cru`).not.toMatch(/Server Error|undefined|\[object/)

        if (v.evento.vendasAbertas === false) {
          // Evento fechado: a MESMA frase, caractere por caractere. Duas
          // frases diferentes pro mesmo motivo é a assinatura de duas regras.
          expect(r.recado, `${onde} deu recado diferente do da vitrine`)
            .toBe(v.evento.avisoDeVenda)
        } else {
          // Lote fechado: o recado diz DE QUAL lote está falando.
          expect(r.recado, `${onde} não disse de qual lote falava`).toContain(lote.nome)
        }
      }
    }

    expect(visitados, 'a varredura não visitou lote nenhum').toBeGreaterThan(8)
    await semear()
  }, 90_000)

  /**
   * A varredura de cima compra UM ingresso de cada lote. Este aqui compra o
   * TANTO QUE A TELA AUTORIZA — que é uma pergunta diferente, e era a que
   * ninguém fazia.
   *
   * O que estava quebrado: `maxPorCompra` saía de `min(lots.max_per_order,
   * estoque)` e ignorava os cinco tetos duros que o checkout confere. Medido,
   * com CPF que nunca tinha comprado nada na vida:
   *
   *   • lote com `limit_by_document` e `max_per_document = 2` → vitrine
   *     `maxPorCompra: 6`, checkout com 6 → 409 "Cada CPF leva no máximo 2";
   *   • `events.max_per_order = 4` → vitrine 6, checkout com 6 → 409;
   *   • `events.max_per_customer = 3` → checkout com 4 → 409;
   *   • `sectors.max_per_customer = 2` → checkout com 3 → 409;
   *   • `ticket_types.max_per_customer = 1` → checkout com 2 → 409.
   *
   * Ou seja: o "+" subia até 6 e a porta recusava no 3, sempre depois do CPF.
   * É o mesmo defeito do lote esgotado com teto cheio, por outra coluna.
   *
   * O teste tem DUAS metades e as duas importam. Comprar o teto (200) prova
   * que a tela não pede menos do que podia; comprar teto+1 (409) prova que o
   * número anunciado não é decorativo — sem essa metade, devolver 1 em tudo
   * passaria.
   */
  it('o teto que a vitrine anuncia é exatamente o que a porta aceita', async () => {
    if (pular()) return
    await semear()

    // teto esperado + quem aperta. Os cinco valores são diferentes de
    // propósito: cada clamp arrancado derruba UM caso, com nome e tudo.
    const casos: Array<[string, string, number, string]> = [
      [SLUG_TETOS, 'LOTE DO TETO DE PEDIDO', 4, 'pedido'],
      [SLUG_TETOS, 'LOTE 2 POR CPF', 2, 'cpf'],
      [SLUG_TETOS, 'LOTE COM TIPO LIMITADO', 1, 'cpf'],
      [SLUG_TETOS, 'LOTE DO SETOR LIMITADO', 3, 'cpf'],
      [SLUG_TETO_CPF, 'LOTE DO EVENTO LIMITADO', 3, 'cpf'],
    ]

    for (const [slug, nome, esperado, por] of casos) {
      const v = await vitrine(slug).then((r) => r.json())
      const lote = v.setores.flatMap((s: any) => s.lotes).find((l: any) => l.nome === nome)
      expect(lote, `${nome} sumiu da fixture`).toBeTruthy()
      // Estoque de 500 em todos: se este número for 500 ou 6, quem respondeu
      // foi a prateleira ou o `max_per_order` do lote, não o teto duro.
      const linha = lote.variacoes[0]
      expect(linha.maxPorCompra, `${nome}: a vitrine anunciou teto errado`).toBe(esperado)
      expect(linha.tetoPor, `${nome}: a tela não sabe dizer quem apertou`).toBe(por)

      const item = (q: number) => linha.tipoId
        ? { lotId: lote.id, ticketTypeId: linha.tipoId, quantidade: q }
        : { lotId: lote.id, quantidade: q }

      const certo = await comprar(slug, item(esperado))
      expect(certo.status,
        `${nome}: a tela autorizou ${esperado} e a porta respondeu ${certo.status}: ${certo.recado}`)
        .toBe(200)

      const demais = await comprar(slug, item(esperado + 1))
      expect(demais.status, `${nome}: a porta aceitou ${esperado + 1}, acima do teto anunciado`)
        .toBe(409)
      expect(demais.recado, `${nome}: recusou sem recado`).toBeTruthy()
      expect(demais.recado, `${nome}: recusou com erro cru`)
        .not.toMatch(/Server Error|undefined|\[object/)
    }

    await semear()
  }, 60_000)

  /**
   * O teto do PEDIDO INTEIRO — o único que nenhuma linha sozinha enxerga.
   *
   * Os tetos do teste acima são POR LINHA: cada lote anuncia o seu e a porta
   * confere o mesmo número. Some duas linhas e aparece o buraco: 3 de um lote
   * e 3 de outro passam nos dois tetos de linha e estouram
   * `events.max_per_order = 4`. Medido no navegador antes de `maxPorPedido`
   * existir, em `zz-auditor-normal` (`max_per_order = 6`): dava pra montar
   * 6 + 6 = 12 com o botão "Pagar" HABILITADO, e o 409 só chegava depois de
   * nome, e-mail e CPF digitados.
   *
   * Por isso a vitrine publica `evento.maxPorPedido`: é dele que a tela tira
   * o aviso e o bloqueio do botão. Este teste guarda os dois lados —
   * o número publicado e a recusa da porta no mesmo número. Apagar
   * `maxPorPedido` do payload deixa a tela com `?? 0`, o portão desligado em
   * silêncio e ESTE teste vermelho.
   */
  it('a vitrine publica o teto do pedido inteiro, e a porta recusa nele', async () => {
    if (pular()) return
    await semear()

    // 1) o número publicado é o do banco, não um palpite da tela
    const v = await vitrine(SLUG_TETOS).then((r) => r.json())
    const [noBanco] = await sql(`SELECT max_per_order FROM events WHERE id = $1`, [EV_TETOS])
    expect(v.evento.maxPorPedido, 'a vitrine não publicou o teto do pedido')
      .toBe(Number(noBanco.max_per_order))

    // 2) evento SEM teto declarado cai no padrão — e num padrão utilizável,
    //    não em 0 (que travaria toda compra) nem em null (que desliga a tela).
    const semTeto = await vitrine(SLUG_TETO_CPF).then((r) => r.json())
    const [nulo] = await sql(`SELECT max_per_order FROM events WHERE id = $1`, [EV_TETO_CPF])
    expect(nulo.max_per_order, 'a fixture perdeu o evento sem teto declarado').toBeNull()
    expect(semTeto.evento.maxPorPedido, 'evento sem teto declarado ficou sem padrão')
      .toBe(TETO_PADRAO_POR_PEDIDO)

    // 3) duas linhas, cada uma dentro do SEU teto, somando acima do do pedido
    const teto = v.evento.maxPorPedido
    const lotes = v.setores.flatMap((s: any) => s.lotes)
    const a = lotes.find((l: any) => l.nome === 'LOTE DO TETO DE PEDIDO')
    const b = lotes.find((l: any) => l.nome === 'LOTE DO SETOR LIMITADO')
    expect(a && b, 'a fixture dos tetos sumiu').toBeTruthy()

    const qa = Math.min(a.variacoes[0].maxPorCompra, teto)
    const qb = teto + 1 - qa
    expect(qa + qb, 'a conta do teste não estoura o teto').toBeGreaterThan(teto)
    expect(qb, `linha B precisa caber no teto dela (${b.variacoes[0].maxPorCompra})`)
      .toBeLessThanOrEqual(b.variacoes[0].maxPorCompra)

    const r = await fetch(`${BASE}/api/checkout`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        eventSlug: SLUG_TETOS,
        itens: [
          { lotId: a.id, ticketTypeId: a.variacoes[0].tipoId ?? undefined, quantidade: qa },
          { lotId: b.id, ticketTypeId: b.variacoes[0].tipoId ?? undefined, quantidade: qb },
        ],
        comprador: {
          nome: 'Comprador do Teto', documento: cpf(),
          email: `zz.teto.${Date.now()}.${Math.random()}@exemplo.com`,
        },
        forma: 'pix',
      }),
    })
    const corpo = await r.json().catch(() => ({}))
    const recado = corpo.statusMessage ?? corpo.message ?? ''
    expect(r.status, `a porta aceitou ${qa + qb} num evento de teto ${teto}`).toBe(409)
    // O recado tem que dizer O NÚMERO: "não foi possível" manda o comprador
    // adivinhar quantos tirar da lista.
    expect(recado, `recusou sem dizer o teto: ${recado}`).toContain(String(teto))

    await semear()
    // 60s como o vizinho: com outra suíte batendo no mesmo Postgres, uma
    // compra real já chegou a passar de 30s aqui. Teste que fica vermelho por
    // fila do banco ensina a ignorar vermelho.
  }, 60_000)

  /**
   * Evento em rascunho responde o MESMO 404 do slug que nunca existiu — nas
   * TRÊS portas públicas, não só na vitrine.
   *
   * A vitrine já escondia (`estaPublicado`), e o comentário dela diz por quê:
   * resposta diferente confirma que o evento existe e está sendo preparado. As
   * outras duas contavam. Medido antes:
   *
   *   GET  /api/e/zz-rascunho-teste        → 404  (igual a um slug inventado)
   *   POST /api/cupom/conferir             → 200  {"motivo":"venda_fechada"}
   *   POST /api/checkout                   → 409  "As vendas deste evento…"
   *
   * Com isso dá pra varrer palpites de slug e descobrir qual lançamento está
   * montado no painel antes do anúncio — o 404 e o não-404 são a resposta.
   */
  it('evento em rascunho responde o mesmo 404 do slug que não existe', async () => {
    if (pular()) return

    const cupom = (slug: string) => fetch(`${BASE}/api/cupom/conferir`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ eventSlug: slug, codigo: 'QUALQUER' }),
    })

    const inventado = 'zz-slug-que-nunca-existiu-teste'
    // A vitrine é a régua: as outras duas portas têm que dar a MESMA resposta
    // que ela dá, pro rascunho e pro slug inventado.
    expect((await vitrine(SLUG_RASCUNHO)).status).toBe(404)
    expect((await vitrine(inventado)).status).toBe(404)

    expect((await cupom(inventado)).status, 'a conferência de cupom mudou de régua').toBe(404)
    expect((await cupom(SLUG_RASCUNHO)).status,
      'a conferência de cupom confirmou que o rascunho existe').toBe(404)

    const compraInventada = await comprar(inventado, { lotId: L1, quantidade: 1 })
    const compraRascunho = await comprar(SLUG_RASCUNHO, { lotId: L1, quantidade: 1 })
    expect(compraInventada.status, 'o checkout mudou de régua').toBe(404)
    expect(compraRascunho.status, 'o checkout confirmou que o rascunho existe').toBe(404)
    expect(compraRascunho.recado, 'o checkout entregou o rascunho pela frase')
      .toBe(compraInventada.recado)
  }, 30_000)

  /**
   * Furo B: a cota legal de meia-entrada (40%, Decreto 8.537/2015) só existia
   * do lado do checkout. A vitrine contava a PRATELEIRA da variação e
   * anunciava 6 meias num lote onde só cabem 4 — o comprador montava as 6 e
   * levava "Restaram 4 meias-entradas" depois do CPF.
   */
  it('a vitrine já desconta a cota legal da meia — e a porta concorda no número',
    async () => {
      if (pular()) return
      await semear()

      const v = await vitrine(SLUG_COTA).then((r) => r.json())
      const lote = setorDe(v, 'ZZ PISTA COTA').lotes.find((l: any) => l.id === L_COTA)
      const meia = lote.variacoes.find((x: any) => x.tipoId === T_COTA_MEIA)

      // 6 na prateleira, 4 na cota: quem só olha a prateleira devolve 6.
      expect(meia.maxPorCompra).toBe(COTA_DO_L_COTA)

      // e o número anunciado é o número que a porta aceita
      const passa = await comprar(SLUG_COTA, {
        lotId: L_COTA, ticketTypeId: T_COTA_MEIA, quantidade: COTA_DO_L_COTA,
        meia: { motivo: 'idoso' },
      })
      expect(passa.status, passa.recado).toBe(200)

      await semear()
      const estoura = await comprar(SLUG_COTA, {
        lotId: L_COTA, ticketTypeId: T_COTA_MEIA, quantidade: COTA_DO_L_COTA + 1,
        meia: { motivo: 'idoso' },
      })
      expect(estoura.status).toBe(409)
      expect(estoura.recado).toMatch(/meia/i)

      await semear()
    }, 40_000)

  /**
   * Furo A: a tela deduzia "este ingresso é meia" de `exigeDocumento`. No
   * ingresso NOMINAL de preço cheio (documento sim, desconto não) ela pedia o
   * motivo de meia-entrada, o comprador escolhia, e o checkout devolvia 422
   * `meia_em_inteira` no último clique. Quem sabe a espécie é a coluna gerada
   * `ticket_types.kind`, a mesma régua dos dois lados.
   */
  it('a espécie do ingresso vem do servidor, não do palpite da tela', async () => {
    if (pular()) return
    const v = await vitrine(SLUG_COTA).then((r) => r.json())
    const lote = setorDe(v, 'ZZ PISTA COTA').lotes.find((l: any) => l.id === L_COTA)
    const inteira = lote.variacoes.find((x: any) => x.tipoId === T_COTA_INTEIRA)
    const meia = lote.variacoes.find((x: any) => x.tipoId === T_COTA_MEIA)

    // ← o par que derrubava a dedução: pede documento E não é meia
    expect(inteira.exigeDocumento).toBe(true)
    expect(inteira.ehMeia).toBe(false)
    expect(meia.ehMeia).toBe(true)

    // e a porta confirma a mesma leitura: declarar meia numa inteira é 422
    const r = await comprar(SLUG_COTA, {
      lotId: L_COTA, ticketTypeId: T_COTA_INTEIRA, quantidade: 1, meia: { motivo: 'idoso' },
    })
    expect(r.status).toBe(422)
    expect(r.corpo.data?.tipo).toBe('meia_em_inteira')
  }, 30_000)

  /**
   * Furo C1: "venda aberta" tinha duas definições. O checkout olhava
   * `ends_at` e recusava evento terminado; a vitrine não olhava, e seguia
   * anunciando lote à venda de um evento que acabou ontem. Agora existe uma
   * função só (`portaDeVenda`) e os dois lados leem a resposta dela — a
   * mesma frase, inclusive.
   */
  it('evento que já terminou fecha a vitrine com a frase do checkout', async () => {
    if (pular()) return
    const v = await vitrine(SLUG_TERMINOU).then((r) => r.json())

    expect(v.evento.vendasAbertas).toBe(false)
    expect(v.evento.avisoDeVenda).toMatch(/Este evento terminou em \d{2}\/\d{2}\/\d{4}/)

    const lotes = v.setores.flatMap((s: any) => s.lotes)
    expect(lotes.length, 'fixture do evento terminado ficou sem lote').toBeGreaterThan(0)
    for (const lote of lotes) {
      expect(lote.situacao).toBe('fechado')
      expect(lote.maxPorCompra).toBe(0)
    }

    const r = await comprar(SLUG_TERMINOU, { lotId: L_TERMINOU, quantidade: 1 })
    expect(r.status).toBe(409)
    // caractere por caractere: é o mesmo texto, da mesma função
    expect(r.recado).toBe(v.evento.avisoDeVenda)
    expect(r.corpo.data?.motivo).toBe('evento_terminou')
  }, 30_000)

  /**
   * O giro de lote é a ordem que o PRODUTOR deu. Quando os lotes do setor
   * estão todos empatados em `sort_order`, ninguém disse quem é o "1º" — e a
   * versão antiga comparava a POSIÇÃO DA LINHA, deixando o Postgres escolher.
   * Medido num setor de três lotes iguais: um saía `disponivel` e os outros
   * dois `em_breve`, sem que nada nos dados dissesse isso. Resposta tirada de
   * ordem física muda sozinha no primeiro UPDATE que reescrever uma linha.
   */
  it('sem ordem declarada, o giro não inventa um "1º lote"', async () => {
    if (pular()) return
    await semear()

    const v = await vitrine(SLUG_EMPATE).then((r) => r.json())
    const lotes = setorDe(v, 'ZZ IRMÃOS').lotes
    expect(lotes.length).toBe(3)
    expect(lotes.map((l: any) => l.situacao)).toEqual(['disponivel', 'disponivel', 'disponivel'])

    // e os três vendem de verdade — a vitrine não está mentindo pra ficar bonita
    for (const lote of lotes) {
      const r = await comprar(SLUG_EMPATE, { lotId: lote.id, quantidade: 1 })
      expect(r.status, `${lote.nome}: ${r.recado}`).toBe(200)
    }

    await semear()
  }, 40_000)

  /**
   * A contraprova do teste acima: com a ordem DECLARADA, o giro continua
   * valendo dos dois lados. Sem isto, "empate não gira" poderia ser
   * implementado como "nada gira" e os dois testes ficariam verdes.
   */
  it('com a ordem declarada, o lote seguinte continua fechado nos dois lados', async () => {
    if (pular()) return
    await semear()

    const v = await vitrine(SLUG_PUB).then((r) => r.json())
    const segundo = setorDe(v, 'ZZ PISTA').lotes.find((l: any) => l.id === L2)
    expect(segundo.situacao).toBe('em_breve')
    expect(segundo.maxPorCompra).toBe(0)

    const r = await comprar(SLUG_PUB, { lotId: L2, ticketTypeId: null, quantidade: 1 })
    expect(r.status).toBe(409)
    expect(r.corpo.data?.tipo).toBe('lote_fora_da_vitrine')
    expect(r.recado).toContain('2º LOTE')

    await semear()
  }, 30_000)
})
