/**
 * GET /api/admin/financeiro — o caixa da organização inteira.
 *
 * O financeiro do evento responde "quanto sobra DESTE evento". Este responde
 * "quanto a produtora tem a receber, somando tudo" — que é a pergunta de quem
 * paga fornecedor no fim do mês, não a de quem está produzindo um show.
 *
 * A regra de liberação é a MESMA do financeiro por evento, importada de
 * `utils/retencao`. Duas definições de "quando o dinheiro libera" é a receita
 * pra esta tela dizer que tem saldo e a outra dizer que não tem.
 *
 * ## A régua do dinheiro aqui é `PEDIDO_VIVO()`, em TODO campo
 *
 * O líquido desta rota já saía de `utils/liquido.ts` e batia com as outras
 * telas; face, taxa, contagem de pedido, a curva por mês e a quebra por forma
 * de pagamento continuavam cada uma com `status = 'pago'`. É o mesmo defeito,
 * só que escrito dentro do `FILTER` em vez do `WHERE`: o pedido com estorno
 * PARCIAL cai fora antes de a soma chegar nele.
 *
 * Medido lado a lado no mesmo evento, antes: face R$ 1.500,00 aqui contra
 * R$ 2.450,00 no borderô/painel/relatórios; a quebra por forma somando
 * R$ 1.900,00 contra R$ 2.835,00 de cobrado. Um evento em que a face aparece
 * MENOR que o próprio líquido — e a tela inteira verde.
 *
 * ## O saldo é o do `saldoParaSaque`, não o do líquido
 *
 * Retido e disponível daqui saíam de `liquido − transferido − em curso`, e o
 * líquido inclui o dinheiro do balcão, que nunca passou pela plataforma.
 * Medido (evento com R$ 840 pela plataforma e R$ 135 em espécie): antes de
 * sacar, o evento dizia R$ 840 e esta tela R$ 975; depois de R$ 500
 * transferidos e R$ 340 pedidos, o evento dizia R$ 0 e esta tela R$ 135 — um
 * dinheiro que já estava na gaveta do produtor, oferecido de novo como saldo.
 * Agora o saldo de cada evento é o MESMO `saldoParaSaque` que trava o saque
 * (`utils/saque.ts`), e o recebido direto vem numa coluna própria, com nome.
 *
 * ## O período (27/09 — auditoria FIN-05) e o que NÃO depende dele
 *
 * `?periodo=` / `?de=` / `?ate=` são lidos por `lerRecorte`, a MESMA leitura da Visão geral. O
 * período vale pra o que é FLUXO: a entrada por mês e por dia, "como entrou", o total que entrou
 * no período (`noPeriodo`) e o histórico de transferências. Saldo não tem período — retido,
 * disponível, transferido e o "Por evento" são o estado de AGORA, e seguem somando a vida toda.
 * Sem parâmetro nenhum a rota responde como sempre respondeu: tudo desde o começo.
 *
 * O mês e o dia saem como TEXTO (`AAAA-MM-DD`, o calendário do parque — a sessão do banco está em
 * America/Bahia). O instante que saía antes era lido pelo navegador no fuso DELE, e a barra de
 * setembro aparecia como agosto (FIN-01, a metade do navegador).
 *
 * ## Saldo devedor (FIN-03)
 *
 * `saldoParaSaque` pode dar NEGATIVO: estorno depois do saque tira da plataforma um dinheiro que já
 * tinha sido transferido. Retido e disponível continuam presos em zero (é o que o financeiro do
 * evento e o borderô mostram), mas a parte negativa agora sai com nome — `saldoDevedorCents` —, em
 * vez de sumir num `Math.max(…, 0)` sem ninguém saber que a conta ficou devendo.
 */
import { db, FUSO_DO_BANCO, q, q1 } from '../../utils/db'
import { DIAS_DE_RETENCAO, SQL_LIBERA_EM } from '../../utils/retencao'
import { PEDIDO_VIVO, SQL_LIQUIDO } from '../../utils/liquido'
import { saldoParaSaque } from '../../utils/saque'
import { hojeNoFuso, lerRecorte } from '../../../app/composables/painelPeriodo'

/** o histórico de transferências vem em páginas (FIN-07: cortava em 40 sem avisar) */
export const TRANSFERENCIAS_POR_PAGINA = 25

export default defineEventHandler(async (event) => {
  const orgId = (event.context as any).sessao?.orgId
  if (!orgId) throw createError({ statusCode: 401, statusMessage: 'Sessão sem organização' })

  const consulta = getQuery(event) as Record<string, string | undefined>
  const hoje = hojeNoFuso(FUSO_DO_BANCO)
  const recorte = lerRecorte(consulta, hoje)
  if ('erro' in recorte) throw createError({ statusCode: 400, statusMessage: recorte.erro })
  const pagina = Math.max(1, Math.min(10_000, Math.trunc(Number(consulta.pagina ?? 1)) || 1))

  // o recorte do FLUXO: pelo dia do pagamento (vendas) ou do pedido de saque (transferências)
  const fluxo = (coluna: string, params: any[]) => {
    const cond: string[] = []
    if (recorte.de) { params.push(recorte.de); cond.push(`${coluna} >= $${params.length}::date`) }
    if (recorte.ate) { params.push(recorte.ate); cond.push(`${coluna} < ($${params.length}::date + 1)`) }
    return cond.length ? ` AND ${cond.join(' AND ')}` : ''
  }
  const pMes: any[] = [orgId]; const noMes = fluxo('o.paid_at', pMes)
  const pDia: any[] = [orgId]; const noDia = fluxo('o.paid_at', pDia)
  const pForma: any[] = [orgId]; const naForma = fluxo('paid_at', pForma)
  const pNo: any[] = [orgId]; const noPeriodoSql = fluxo('o.paid_at', pNo)
  const pTr: any[] = [orgId]; const nasTransferencias = fluxo('p.requested_at', pTr)

  const [porEvento, transferencias, porMes, resumoPagamentos, porDia, entrou, saques] = await Promise.all([
    q<any>(
      `SELECT e.id, e.name, e.status, e.starts_at, e.ends_at,
              now() > ${SQL_LIBERA_EM('e.ends_at')} AS liberado,
              ${SQL_LIBERA_EM('e.ends_at')} AS libera_em,
              COALESCE(v.face, 0)::bigint      AS face,
              COALESCE(v.taxa, 0)::bigint      AS taxa,
              COALESCE(v.estornado, 0)::bigint AS estornado,
              COALESCE(v.liquido, 0)::bigint   AS liquido,
              COALESCE(v.pedidos, 0)::int      AS pedidos,
              COALESCE(v.fechados, 0)::int     AS fechados,
              COALESCE(t.transferido, 0)::bigint AS transferido,
              COALESCE(t.em_curso, 0)::bigint    AS em_curso
         FROM events e
         LEFT JOIN LATERAL (
           -- O recorte é por FILTER em cada soma, nunca por um WHERE que vale
           -- pra todas. Enquanto era WHERE status = 'pago', o pedido com
           -- estorno PARCIAL — que o webhook marca 'estornado_parcial' — caía
           -- fora antes de a conta do líquido filtrar: uma devolução de
           -- R$ 20 apagava um pedido de R$ 850 do caixa da organização, e o
           -- estorno em si também sumia da coluna que devia mostrá-lo.
           --
           -- Trocar o WHERE por FILTER consertou só o líquido; face, taxa e a
           -- contagem seguiram recortando por 'pago', que é o MESMO defeito
           -- escrito dentro de cada soma. Medido lado a lado no mesmo evento:
           -- face R$ 1.500,00 aqui contra R$ 2.450,00 no borderô, no painel e
           -- em relatórios, com o líquido igual nas quatro — a linha do
           -- financeiro da organização mostrando uma face MENOR que o próprio
           -- líquido, que é aritmeticamente impossível e ninguém percebeu.
           --
           -- Daqui pra frente todo FILTER de dinheiro desta rota é
           -- PEDIDO_VIVO(), e a contagem de "quantos fecharam sem devolver
           -- nada" continua existindo com nome próprio.
           -- (sem crase em comentário de SQL: dentro de template literal ela
           --  fecha a string e o erro sai em OUTRO arquivo — foi o que
           --  aconteceu na primeira versão desta linha.)
           SELECT SUM(face_cents) FILTER (WHERE ${PEDIDO_VIVO()}) AS face,
                  SUM(fee_cents)  FILTER (WHERE ${PEDIDO_VIVO()}) AS taxa,
                  SUM(refunded_cents)                             AS estornado,
                  COUNT(*)        FILTER (WHERE ${PEDIDO_VIVO()}) AS pedidos,
                  COUNT(*)        FILTER (WHERE status = 'pago')  AS fechados,
                  ${SQL_LIQUIDO()} AS liquido
             FROM orders WHERE event_id = e.id
         ) v ON true
         LEFT JOIN LATERAL (
           SELECT SUM(amount_cents) FILTER (WHERE status = 'concluida') AS transferido,
                  SUM(amount_cents) FILTER (WHERE status IN ('solicitada','processando')) AS em_curso
             FROM payouts WHERE event_id = e.id
         ) t ON true
        WHERE e.org_id = $1
        ORDER BY e.starts_at DESC NULLS LAST`, [orgId]),

    q<any>(
      `SELECT p.id, p.code, p.beneficiary_name, p.amount_cents, p.status,
              p.destination_kind, p.requested_at, p.processed_at,
              e.name AS evento, u.name AS pedido_por,
              count(*) OVER ()::int AS total_geral
         FROM payouts p
         LEFT JOIN events e ON e.id = p.event_id
         LEFT JOIN users u ON u.id = p.requested_by
        WHERE p.org_id = $1${nasTransferencias}
        ORDER BY p.requested_at DESC, p.id
        LIMIT ${TRANSFERENCIAS_POR_PAGINA} OFFSET ${(pagina - 1) * TRANSFERENCIAS_POR_PAGINA}`, pTr),

    // Competência pelo PAGAMENTO, não pela criação do pedido: o mês em que o
    // dinheiro entrou é o mês que o contador quer ver.
    //
    // `PEDIDO_VIVO` e não `'pago'`: o gráfico de barras é uma decomposição da
    // face total da tela, e com o recorte por 'pago' o mês em que alguém pediu
    // reembolso parcial perdia a venda inteira — a barra encolhia e o total
    // acima dela não, sem nada explicando a diferença.
    //
    // O mês é TEXTO do calendário do parque, e o gráfico da tela mostra o líquido ou o cobrado
    // (FIN-04: a barra era a FACE, uma terceira medida sem nome). `faceCents` continua aqui
    // porque é a decomposição que `evento/[id]/relatorios.test.ts` confere contra o banco.
    q<any>(
      `SELECT to_char(date_trunc('month', o.paid_at), 'YYYY-MM-DD') AS mes,
              COALESCE(SUM(o.face_cents),0)::bigint AS face,
              COALESCE(SUM(o.fee_cents),0)::bigint  AS taxa,
              COALESCE(SUM(o.total_cents),0)::bigint AS cobrado,
              ${SQL_LIQUIDO('o.')} AS liquido,
              COUNT(*)::int AS pedidos
         FROM orders o
        WHERE o.org_id = $1 AND ${PEDIDO_VIVO('o.')} AND o.paid_at IS NOT NULL${noMes}
        GROUP BY 1 ORDER BY 1`, pMes),

    // Mesma régua: a quebra por forma de pagamento tem que somar o cobrado que
    // as outras telas mostram. Com `status = 'pago'` ela somava R$ 1.900,00
    // contra R$ 2.835,00 de cobrado no painel e em relatórios pelo mesmo
    // período.
    q<any>(
      `SELECT payment_method AS forma, COUNT(*)::int AS pedidos,
              COALESCE(SUM(total_cents),0)::bigint AS cobrado,
              ${SQL_LIQUIDO()} AS liquido
         FROM orders WHERE org_id = $1 AND ${PEDIDO_VIVO()}${naForma}
        GROUP BY 1 ORDER BY 3 DESC`, pForma),

    // por dia, pro gráfico de período curto (até ~6 meses a tela desenha dia ou semana)
    q<any>(
      `SELECT to_char(date_trunc('day', o.paid_at), 'YYYY-MM-DD') AS dia,
              COALESCE(SUM(o.total_cents),0)::bigint AS cobrado,
              ${SQL_LIQUIDO('o.')} AS liquido,
              COUNT(*)::int AS pedidos
         FROM orders o
        WHERE o.org_id = $1 AND ${PEDIDO_VIVO('o.')} AND o.paid_at IS NOT NULL${noDia}
        GROUP BY 1 ORDER BY 1`, pDia),

    // o que ENTROU no período — a mesma régua (e o mesmo número) da Visão geral no mesmo recorte
    q1<any>(
      `SELECT COALESCE(SUM(o.total_cents),0)::bigint AS cobrado,
              ${SQL_LIQUIDO('o.')} AS liquido,
              COUNT(*)::int AS pedidos,
              to_char(MIN(o.paid_at), 'YYYY-MM-DD') AS primeiro_dia
         FROM orders o
        WHERE o.org_id = $1 AND ${PEDIDO_VIVO('o.')}${noPeriodoSql}`, pNo),

    /**
     * Os saques ESPERANDO alguém, separados pelo que o botão faz (FIN-02). "Enviar saques
     * pendentes" executa `SQL_FILA_DE_PAYOUTS` — só PIX 'solicitada'. O de conta bancária a
     * fila não alcança (é transferência à mão no painel do gateway) e o 'processando' já saiu:
     * contados juntos, o botão anunciava um número e um valor que não eram o que ia sair.
     * Sem período: pendência é pendência, seja de quando for.
     */
    q<any>(
      `SELECT CASE WHEN status = 'processando' THEN 'emVoo'
                   WHEN destination_kind = 'pix' THEN 'enviaveis'
                   ELSE 'manuais' END AS grupo,
              count(*)::int AS n, COALESCE(SUM(amount_cents),0)::bigint AS soma
         FROM payouts
        WHERE org_id = $1 AND status IN ('solicitada','processando')
        GROUP BY 1`, [orgId]),
  ])

  // O saldo de cada evento sai de `saldoParaSaque` — a MESMA função que trava
  // o saque. Uma conexão só pra todos os eventos: a organização é um parque,
  // são poucos eventos, e N consultas numa conexão custam menos que N
  // conexões disputando o pool.
  const saldos = new Map<string, Awaited<ReturnType<typeof saldoParaSaque>>>()
  const conexao = await db().connect()
  try {
    for (const e of porEvento) saldos.set(e.id, await saldoParaSaque(conexao, e.id))
  } finally {
    conexao.release()
  }

  let face = 0, taxa = 0, estornado = 0, transferido = 0, emCurso = 0, retido = 0, disponivel = 0
  let somaLiquido = 0, naPlataforma = 0, recebidoDireto = 0, devedor = 0
  const eventos = porEvento.map((e) => {
    // conta única em `utils/liquido.ts` — a face cheia mentia sempre que a
    // taxa foi absorvida ou um cupom entrou
    const liquido = Number(e.liquido)
    const t = Number(e.transferido)
    const c = Number(e.em_curso)
    const s = saldos.get(e.id)!
    // `saldoParaSaque().disponivelCents` = na plataforma − transferido − em
    // curso. É o número que o financeiro do evento e o borderô mostram; aqui
    // ele só é partido em "preso pela retenção" e "livre".
    const saldo = Math.max(s.disponivelCents, 0)
    const preso = e.liberado ? 0 : saldo
    const livre = saldo - preso
    // a parte que o `Math.max` esconde: o evento DEVE à plataforma (estorno depois do saque)
    const deve = Math.max(-s.disponivelCents, 0)
    devedor += deve

    face += Number(e.face); taxa += Number(e.taxa); estornado += Number(e.estornado)
    somaLiquido += liquido
    naPlataforma += s.gatewayCents; recebidoDireto += s.diretoCents
    transferido += t; emCurso += c; retido += preso; disponivel += livre

    return {
      id: e.id, nome: e.name, status: e.status,
      comeca: e.starts_at, termina: e.ends_at,
      liberado: e.liberado, liberaEm: e.libera_em,
      // `pedidos` é a população que as somas ao lado usam — pedido que virou
      // dinheiro, inclusive o que devolveu uma parte. É o mesmo número que
      // relatórios e o painel chamam de `pedidos`.
      pedidos: e.pedidos,
      // e a outra pergunta, a de sempre: quantos fecharam sem devolver nada
      pedidosFechados: e.fechados,
      faceCents: Number(e.face), taxaCents: Number(e.taxa),
      estornadoCents: Number(e.estornado), liquidoCents: liquido,
      // as duas metades do líquido, com nome: sem elas o líquido fica maior
      // que o saldo e o produtor acha que o sistema comeu a venda do balcão
      naPlataformaCents: s.gatewayCents, recebidoDiretoCents: s.diretoCents,
      transferidoCents: t, emCursoCents: c,
      retidoCents: preso, disponivelCents: livre,
      // retido + disponível: o "a receber" do borderô e do financeiro do evento
      saldoCents: saldo,
      saldoDevedorCents: deve,
    }
  })

  // página além da última: a janela não conta nada, então a contagem vem à parte
  const totalDeTransferencias = transferencias.length || pagina === 1
    ? Number(transferencias[0]?.total_geral ?? 0)
    : Number((await q1<any>(`SELECT count(*)::int AS n FROM payouts p WHERE p.org_id = $1${nasTransferencias}`, pTr))?.n ?? 0)

  const grupoDeSaque = (g: string) => {
    const l = saques.find((x: any) => x.grupo === g)
    return { pedidos: Number(l?.n ?? 0), valorCents: Number(l?.soma ?? 0) }
  }

  return {
    diasDeRetencao: DIAS_DE_RETENCAO,
    totais: {
      faceCents: face, taxaCents: taxa, estornadoCents: estornado,
      // soma dos líquidos por evento, não uma segunda conta sobre os totais:
      // total que não é a soma das linhas é o jeito clássico de a tela do
      // dinheiro discordar de si mesma
      liquidoCents: somaLiquido,
      naPlataformaCents: naPlataforma, recebidoDiretoCents: recebidoDireto,
      transferidoCents: transferido, emCursoCents: emCurso,
      retidoCents: retido, disponivelCents: disponivel,
      saldoCents: retido + disponivel,
      // transferido + em curso + retido + disponível + recebido direto − devedor = líquido
      saldoDevedorCents: devedor,
    },
    filtro: {
      periodo: recorte.periodo, de: recorte.de, ate: recorte.ate,
      hoje, primeiroDia: entrou?.primeiro_dia ?? null,
    },
    noPeriodo: {
      cobradoCents: Number(entrou?.cobrado ?? 0), liquidoCents: Number(entrou?.liquido ?? 0),
      pedidos: Number(entrou?.pedidos ?? 0),
    },
    eventos,
    porMes: porMes.map((m) => ({
      mes: m.mes, pedidos: m.pedidos,
      faceCents: Number(m.face), taxaCents: Number(m.taxa),
      cobradoCents: Number(m.cobrado), liquidoCents: Number(m.liquido),
    })),
    porDia: porDia.map((d) => ({
      dia: d.dia, pedidos: d.pedidos, cobradoCents: Number(d.cobrado), liquidoCents: Number(d.liquido),
    })),
    porForma: resumoPagamentos.map((f) => ({
      forma: f.forma, pedidos: f.pedidos, cobradoCents: Number(f.cobrado), liquidoCents: Number(f.liquido),
    })),
    saques: {
      enviaveis: grupoDeSaque('enviaveis'), manuais: grupoDeSaque('manuais'), emVoo: grupoDeSaque('emVoo'),
    },
    transferenciasTotal: totalDeTransferencias,
    pagina, porPagina: TRANSFERENCIAS_POR_PAGINA,
    transferencias: transferencias.map((t) => ({
      id: t.id, codigo: t.code, beneficiario: t.beneficiary_name,
      valorCents: Number(t.amount_cents), status: t.status,
      destinoTipo: t.destination_kind, evento: t.evento, pedidoPor: t.pedido_por,
      solicitadaEm: t.requested_at, processadaEm: t.processed_at,
    })),
  }
})
