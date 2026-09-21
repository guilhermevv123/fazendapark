/**
 * GET /api/admin/reconciliacao — o extrato do Asaas contra o nosso caixa.
 *
 * A pergunta que esta rota responde é a que ninguém conseguia fazer: **o que
 * a plataforma diz que recebeu bate com o que o gateway diz que pagou?**
 *
 * Um webhook perdido (e o webhook é a única porta por onde a plataforma
 * descobre que o dinheiro entrou) deixa dinheiro que existe no banco do Asaas
 * e não existe no nosso. Sem esta conferência, quem descobre é o comprador
 * que pagou e não recebeu ingresso — no portão, no dia do evento.
 *
 * Três decisões desta rota:
 *
 * 1. **O recorte vem da URL** (`?de=&ate=&eventoId=`), em dia de calendário
 *    LOCAL. Quem achou a divergência precisa mandar o link pro sócio.
 *
 * 2. **Sem credencial do Asaas ela NÃO quebra**: cai no gateway simulado e
 *    diz isso na tela, com o tamanho do que não foi conferido. Uma tela de
 *    dinheiro que devolve erro 500 quando falta configuração é uma tela que
 *    ninguém abre de novo.
 *
 * 3. **Ela nunca acusa o que não olhou.** Pedido que a fonte não conseguiu
 *    conferir sai em "não conferido", com o motivo — e não em "divergência
 *    grave". Acusar por falta de página é o jeito mais rápido de a tela
 *    perder credibilidade e passar a ser ignorada justo no dia em que a
 *    divergência for de verdade.
 *
 * 4. **Olhar não é conferir.** Abrir a tela LÊ; só um ato explícito
 *    (`?registrar=1`, o botão "Registrar conferência") grava uma linha em
 *    `reconciliation_runs`. Ver o porquê em `querRegistrar` lá embaixo.
 *
 * A comparação mora em `utils/reconciliacao.ts` (pura, testável sem rede); a
 * régua do que é "pedido com dinheiro" é `PEDIDO_VIVO()` de `utils/liquido.ts`,
 * a mesma do borderô e do teto do saque.
 */
import { q, q1 } from '../../utils/db'
import { ligado as simuladoLigado } from '../../utils/gateway-simulado'
import {
  CATALOGO, SQL_AVISOS_GUARDADOS, SQL_EXTRATO_SIMULADO, SQL_PEDIDOS_DO_PERIODO,
  SQL_PEDIDOS_POR_CHAVE, ambienteDaConfig, buscadorDoAsaas, comparar, conferirPorId,
  diaLocal, lerCobranca, lerJanela, listarCobrancas, pedidoDaLinha, vereditoDaConferencia,
  type CobrancaDoExtrato, type PedidoNosso,
} from '../../utils/reconciliacao'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** quantas linhas a resposta carrega de cada lista — o contador nunca é cortado */
const TETO_DA_LISTA = 300

/**
 * O cabeçalho que só o clique na tela manda.
 *
 * `reconciliation_runs` é um livro de atos de dinheiro, e este handler é um
 * GET. O cookie é `SameSite=Lax`, que ainda viaja numa NAVEGAÇÃO de topo
 * vinda de outro site — um link "clique aqui" bastaria pra carimbar
 * conferências no nome de quem clicou. Navegação de topo não consegue mandar
 * cabeçalho nenhum; `fetch` do nosso próprio JavaScript consegue. Por isso o
 * registro exige os dois: o parâmetro E o cabeçalho.
 */
const CABECALHO_DA_TELA = 'x-diamond-conferencia'

export default defineEventHandler(async (event) => {
  const sessao = (event.context as any).sessao
  if (!sessao?.orgId) {
    throw createError({ statusCode: 401, statusMessage: 'Faça login para continuar' })
  }
  const orgId = sessao.orgId as string

  const busca = getQuery(event)

  let janela
  try {
    janela = lerJanela(busca.de, busca.ate)
  } catch (e: any) {
    throw createError({ statusCode: 400, statusMessage: e?.message ?? 'Período inválido.' })
  }

  // O middleware de organização cerca `/api/admin/evento/:id` pela URL. Aqui o
  // evento vem como filtro, então a cerca é minha: id de outro produtor não
  // existe pra quem está olhando.
  const eventoId = typeof busca.eventoId === 'string' && UUID.test(busca.eventoId)
    ? busca.eventoId
    : null
  let evento: { id: string; name: string } | null = null
  if (eventoId) {
    evento = await q1<any>(`SELECT id, name FROM events WHERE id = $1 AND org_id = $2`,
      [eventoId, orgId])
    if (!evento) throw createError({ statusCode: 404, statusMessage: 'Evento não encontrado' })
  }

  const org = await q1<any>(
    `SELECT name, asaas_api_key, asaas_env, asaas_wallet FROM organizations WHERE id = $1`,
    [orgId])

  /* ------------------------------------------------------------- nosso lado */
  const nossos: PedidoNosso[] = (await q<any>(SQL_PEDIDOS_DO_PERIODO,
    [orgId, janela.inicio, janela.fim, eventoId])).map(pedidoDaLinha)

  /* --------------------------------------------------------- lado do gateway */
  const cfg = org?.asaas_api_key
    ? { apiKey: String(org.asaas_api_key), environment: org.asaas_env ?? null,
        walletId: org.asaas_wallet ?? null }
    : null

  let fonte: 'asaas' | 'simulado' | 'indisponivel' =
    cfg ? 'asaas' : simuladoLigado() ? 'simulado' : 'indisponivel'
  let extrato: CobrancaDoExtrato[] = []
  let extratoCompleto = false
  let truncado = false
  let erroDaFonte: string | null = null
  let ambiente: string | null = null

  if (cfg) {
    ambiente = ambienteDaConfig(cfg)
    const buscador = buscadorDoAsaas(cfg)
    try {
      const r = await listarCobrancas(buscador, janela)
      extrato = r.cobrancas
      truncado = r.truncado
      // Só o extrato de verdade e inteiro autoriza a rota a dizer "este
      // pedido não tem cobrança lá". Página faltando derruba essa autoridade.
      extratoCompleto = !truncado
    } catch (e: any) {
      // Credencial errada ou gateway fora NÃO vira "cai pro simulado": isso
      // esconderia a chave quebrada atrás de uma tela que parece funcionar.
      erroDaFonte = e?.message ?? String(e)
    }
  } else if (fonte === 'simulado') {
    // o mesmo recorte do nosso lado — o extrato desta fonte não pode ser o
    // histórico inteiro debaixo de um cabeçalho que promete um período
    const linhas = await q<any>(SQL_EXTRATO_SIMULADO,
      [orgId, eventoId, janela.inicio, janela.fim])
    extrato = linhas
      .map((l) => lerCobranca({ ...(l.pagamento ?? {}), id: l.pagamento?.id ?? l.id }))
      .filter((c) => c.id)
  }

  /* ---- pedidos que o extrato aponta e a janela não pegou (borda do período) */
  const conhecidos = new Set(nossos.map((p) => p.id))
  const idsDeCobranca = extrato.map((c) => c.id).filter(Boolean)
  const referencias = extrato
    .map((c) => c.referenciaExterna)
    .filter((r): r is string => !!r && UUID.test(r))
  if (idsDeCobranca.length || referencias.length) {
    const extras = await q<any>(SQL_PEDIDOS_POR_CHAVE, [orgId, idsDeCobranca, referencias])
    for (const l of extras) {
      const p = pedidoDaLinha(l)
      if (!conhecidos.has(p.id)) { conhecidos.add(p.id); nossos.push(p) }
    }
  }

  /* --- o que a listagem não trouxe, a gente PERGUNTA antes de acusar */
  const noExtrato = new Set(extrato.map((c) => c.id))
  let ausentesConfirmadas = new Set<string>()
  let naoPerguntadas = new Set<string>()
  if (cfg && !erroDaFonte) {
    const faltando = nossos
      .filter((p) => p.vivo && p.cobrancaId && !noExtrato.has(p.cobrancaId))
      .map((p) => p.cobrancaId!)
    if (faltando.length) {
      const r = await conferirPorId(buscadorDoAsaas(cfg), faltando)
      extrato = [...extrato, ...r.achadas]
      ausentesConfirmadas = r.ausentes
      naoPerguntadas = r.naoPerguntadas
      if (r.erro && !erroDaFonte) erroDaFonte = r.erro
    }
  }

  const resultado = comparar({
    pedidos: nossos,
    extrato,
    extratoCompleto: extratoCompleto && !erroDaFonte,
    ausentesConfirmadas,
    naoPerguntadas,
  })

  /* --------------- o aviso guardado, que transforma a ação em instrução */
  const idsParaOlhar = resultado.divergencias
    .map((d) => d.cobrancaId)
    .filter((id): id is string => !!id)
  const avisos = idsParaOlhar.length
    // a cerca de organização vai DENTRO da consulta: `payment_events` não tem
    // `org_id`, e a lista de ids não pode ser a única defesa (ver o comentário
    // de `SQL_AVISOS_GUARDADOS`)
    ? await q<any>(SQL_AVISOS_GUARDADOS, [idsParaOlhar, orgId])
    : []
  const avisoPorCobranca = new Map(avisos.map((a) => [a.external_id, a]))

  const divergencias = resultado.divergencias.map((d) => {
    const a = d.cobrancaId ? avisoPorCobranca.get(d.cobrancaId) : null
    return {
      ...d,
      aviso: a
        ? {
            id: a.id as string,
            evento: a.event_name as string,
            processado: !!a.processed_at,
            tentativas: Number(a.attempts ?? 0),
            erro: (a.error as string | null) ?? null,
          }
        : null,
    }
  })

  const t = resultado.totais

  /* --------------------------------------------- grava o ATO, e só o ato
   *
   * Isto aqui gravava uma linha em TODA leitura. Com `useFetch`, uma única
   * abertura da tela grava duas (servidor + hidratação): 14 linhas viravam 16
   * em duas chamadas, medido. O efeito é o cartão "última conferência em ..."
   * mostrando VOCÊ de cinco segundos atrás — o contrário exato da pergunta
   * que a tabela existe pra responder, que é "quando foi a última vez que
   * isso foi conferido DE VERDADE". Um livro que se preenche sozinho a cada
   * relance não é memória, é ruído: some com o dia em que alguém olhou mesmo.
   *
   * Agora olhar lê, e conferir é um ato: o botão da tela manda `registrar=1`
   * com o cabeçalho de lá, e só esse par grava.
   */
  const pediuRegistro = String(busca.registrar ?? '') === '1'
  const daTela = getRequestHeader(event, CABECALHO_DA_TELA) === '1'
  const querRegistrar = pediuRegistro && daTela

  let registro: { gravado: boolean; quando: string | null; porque: string | null } =
    { gravado: false, quando: null, porque: null }

  if (querRegistrar) {
    const gravada = await q<any>(
      `INSERT INTO reconciliation_runs
         (org_id, event_id, period_start, period_end, source, environment,
          ran_by, ran_by_email, orders_count, orders_cents, gateway_count, gateway_cents,
          webhook_missing, charge_missing, amount_mismatch, duplicate_charge, unchecked, error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       RETURNING created_at`,
      [orgId, eventoId, janela.de, janela.ate, fonte, ambiente,
       sessao.usuarioId ?? null, sessao.email ?? null,
       t.pedidos, t.nossoCents, t.cobrancas, t.gatewayCents,
       t.webhookPerdido, t.semCobranca, t.valorDiferente, t.cobrancaRepetida, t.naoConferidos,
       erroDaFonte])
      // Conferência que falha porque o registro dela falhou é o pior dos dois
      // mundos: o operador fica sem a resposta E sem o log.
      .catch((e) => {
        console.error('[reconciliacao] não gravei a conferência:', e?.message)
        registro.porque = 'A conferência rodou, mas não consegui gravar o registro dela. '
          + 'O resultado abaixo vale; o histórico desta vez não ficou.'
        return []
      })
    if (gravada?.[0]) {
      registro = { gravado: true, quando: gravada[0].created_at, porque: null }
    }
  } else if (pediuRegistro) {
    registro.porque = 'O pedido de registro não veio da tela — nada foi gravado.'
  }

  /* --------------------------------- a última conferência REGISTRADA (não esta) */
  const ultima = await q1<any>(
    `SELECT created_at, ran_by_email, source, period_start, period_end,
            webhook_missing, charge_missing, amount_mismatch, duplicate_charge, unchecked
       FROM reconciliation_runs
      WHERE org_id = $1
      ORDER BY created_at DESC LIMIT 1`, [orgId])

  return {
    periodo: { de: janela.de, ate: janela.ate, dias: janela.dias },
    evento: evento ? { id: evento.id, nome: evento.name } : null,
    organizacao: org?.name ?? null,
    fonte: {
      tipo: fonte,
      ambiente,
      rotulo: ROTULO_DA_FONTE[fonte],
      /** o que a tela precisa dizer em voz alta sobre o que NÃO foi conferido */
      aviso: avisoDaFonte(fonte, truncado, erroDaFonte, t.naoConferidos),
      completa: extratoCompleto && !erroDaFonte,
      truncado,
      erro: erroDaFonte,
    },
    // O veredito em uma palavra e num tom — é o que impede a tela de pintar
    // "0 divergências" de verde quando a verdade é "não conferi nada".
    veredito: vereditoDaConferencia({
      fonte,
      completa: extratoCompleto && !erroDaFonte,
      erro: erroDaFonte,
      naoConferidos: t.naoConferidos,
      divergencias: t.webhookPerdido + t.semCobranca + t.valorDiferente + t.cobrancaRepetida,
    }),
    registro,
    totais: {
      pedidos: t.pedidos,
      nossoCents: t.nossoCents,
      cobrancas: t.cobrancas,
      gatewayCents: t.gatewayCents,
      diferencaCents: t.diferencaCents,
      conferidos: t.conferidos,
      webhookPerdido: t.webhookPerdido,
      semCobranca: t.semCobranca,
      valorDiferente: t.valorDiferente,
      cobrancaRepetida: t.cobrancaRepetida,
      naoConferidos: t.naoConferidos,
      // o tamanho do que NÃO foi conferido, em dinheiro: é ele que impede a
      // tela de pôr a "Diferença" em vermelho quando ninguém conferiu nada
      naoConferidosCents: t.naoConferidosCents,
    },
    divergencias: divergencias.slice(0, TETO_DA_LISTA),
    // A lista é cortada, o CONTADOR não (`totais` acima vem da comparação
    // inteira). Cortar os dois faria a tela dizer "200 divergências" num
    // período com 4.000 — e o operador fecharia o mês com o número errado.
    naoConferidos: resultado.naoConferidos.slice(0, TETO_DA_LISTA),
    tetoDaLista: TETO_DA_LISTA,
    catalogo: CATALOGO,
    // "conferência anterior" virou "última conferência REGISTRADA": o nome
    // antigo prometia que alguém tinha conferido antes, e quem gravava a linha
    // era a própria abertura da tela.
    ultimaConferencia: ultima
      ? {
          quando: ultima.created_at,
          por: ultima.ran_by_email,
          fonte: ultima.source,
          // `period_start` é `date` no banco e volta como `Date` à meia-noite
          // LOCAL; serializado cru vira "2026-09-01T03:00:00.000Z" e a tela
          // mostraria 31/08. Dia de calendário sai como dia de calendário.
          de: ultima.period_start ? diaLocal(new Date(ultima.period_start)) : null,
          ate: ultima.period_end ? diaLocal(new Date(ultima.period_end)) : null,
          divergencias: Number(ultima.webhook_missing) + Number(ultima.charge_missing)
            + Number(ultima.amount_mismatch) + Number(ultima.duplicate_charge ?? 0),
          naoConferidos: Number(ultima.unchecked),
        }
      : null,
  }
})

const ROTULO_DA_FONTE: Record<string, string> = {
  asaas: 'Extrato do Asaas',
  simulado: 'Gateway simulado',
  indisponivel: 'Sem fonte para conferir',
}

/**
 * O que a tela diz sobre a fonte. É a frase que impede a maior mentira
 * possível desta tela: "nenhuma divergência" quando a verdade é "não olhei".
 */
function avisoDaFonte(
  fonte: string, truncado: boolean, erro: string | null, naoConferidos: number,
): string | null {
  if (erro) {
    return `Não consegui falar com o Asaas: ${erro}. `
      + 'Nada abaixo foi conferido contra o extrato — corrija a credencial em '
      + 'Organizações e confira de novo.'
  }
  if (fonte === 'indisponivel') {
    return 'Esta organização não tem credencial do Asaas e o gateway simulado está '
      + 'desligado: não existe extrato para comparar. Abaixo está só o nosso lado.'
  }
  if (fonte === 'simulado') {
    return 'Sem credencial do Asaas: conferido contra o gateway simulado, que só conhece '
      + 'as cobranças cujo aviso ficou guardado aqui. Serve pra achar aviso preso, não '
      + 'para fechar o caixa — e cobrança que nunca virou pedido nenhum não aparece.'
      + (naoConferidos ? ` ${naoConferidos} pedido(s) ficaram sem conferência.` : '')
  }
  if (truncado) {
    return 'O período tem mais cobranças do que esta conferência consegue ler de uma vez. '
      + 'Estreite as datas — do jeito que está, o que sobrou não foi conferido.'
  }
  if (naoConferidos) {
    return `${naoConferidos} pedido(s) não foram conferidos: o Asaas não respondeu por eles.`
  }
  return null
}
