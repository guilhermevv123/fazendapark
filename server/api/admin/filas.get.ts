/**
 * GET /api/admin/filas — as duas filas de fundo, visíveis.
 *
 * ## A pergunta que esta rota responde
 *
 * "O ingresso que o cliente comprou saiu?" e "o dinheiro que a gente mandou
 * devolver voltou?" — antes desta rota, as duas só tinham resposta depois que
 * o telefone da bilheteria tocou. As filas rodam dentro do processo do
 * servidor, sem tela, sem log quando não fazem nada e sem teste que fique
 * vermelho quando param. Foi assim que o trabalhador do e-mail passou a não
 * subir em produção (ver `server/plugins/00.filas.ts`) sem ninguém notar.
 *
 * ## Contar a fila NÃO responde
 *
 * Fila vazia com o trabalhador vivo e fila vazia com o trabalhador morto são
 * a mesma linha no banco — até a primeira venda, quando já é tarde. Por isso
 * a resposta tem DUAS medidas de natureza diferente:
 *
 *  - **o carimbo** (`worker_heartbeats`, migração 024): o trabalhador diz
 *    "estou aqui" a cada varredura, inclusive quando não achou nada. É o que
 *    acusa o processo morto com a fila vazia.
 *  - **a idade do mais velho maduro**: item que já podia ter saído e continua
 *    parado. É o que acusa o trabalhador que está vivo e engasgado — carimbo
 *    em dia e nada saindo.
 *
 * Quem junta as duas numa frase é `vereditoDaFila()`, em `utils/envio.ts`, e
 * não esta rota: a tela que repete a decisão por conta própria é a tela que
 * um dia diverge do que o servidor pensa.
 *
 * ## Os números são da SUA organização; o carimbo é do processo
 *
 * Contagem de fila é dado de cliente e sai cercada por `org_id`, como todo o
 * resto do painel — "12 na fila" incluindo o evento de outro produtor já é
 * vazamento, ainda que pequeno. O carimbo não é de ninguém: é o processo que
 * atende todas as organizações, e esconder dele quem opera o parque só
 * atrasaria a descoberta do que está parado pra todo mundo.
 */
import { q1 } from '../../utils/db'
import {
  FILA_DE_ENVIO, FILA_DE_ESTORNO, emPortugues, vereditoDaFila,
} from '../../utils/envio'

/**
 * Cada fila do jeito que o operador conhece. O nome técnico é a chave do
 * carimbo; o rótulo é o que ele vai ler.
 */
/**
 * ## Contar LINHA e chamar de GENTE foi o defeito desta rota
 *
 * Medido no build isolado, com duas linhas da fila apontando para o MESMO
 * pedido (a automática falhou, o reenvio do balcão falhou também): a resposta
 * dizia `2 ingresso(s) comprado(s) sem o e-mail na mão do cliente` — e do
 * outro lado do balcão havia UMA pessoa. A fila conta tentativas; quem opera
 * conta gente. Por isso todo número que vira frase para humano sai de
 * `pessoas_sem`, que agrupa por pedido, e nunca de `COUNT(*)`.
 *
 * As contagens de item (`parados`, `falharam`, `andando`) continuam sendo de
 * LINHA, de propósito: ali a pergunta é do tamanho do trabalho da fila, e
 * agrupar por pedido esconderia a segunda tentativa.
 *
 * ## "Falhou" não é passado, é gente esperando agora
 *
 * `status = 'falhou'` é o fim da linha: `SQL_RESERVA` não pega mais a linha
 * nem por id, e nenhum laço tenta de novo. Ou seja, é a pessoa que pagou e
 * NUNCA vai receber nada até um humano mandar de novo. Antes disto, essas
 * linhas não entravam no veredito: medido no build, com dois e-mails perdidos
 * de vez, a rota respondia `ok: true` e "Andando, e sem nada esperando" — a
 * própria resposta se contradizia, porque o `custo` ao lado já dizia que tinha
 * gente sem ingresso. Alarme externo lê `ok` e ia dormir.
 *
 * `perdidos` é o que conserta isso, e ele se apaga sozinho: um pedido com
 * falha mas com alguma linha AINDA PENDENTE não entra (o laço pode entregar),
 * e um pedido cuja segunda tentativa deu certo também não (já recebeu). É o
 * que evita o vermelho eterno de um endereço digitado torto em maio.
 */
const FILAS = [
  {
    nome: FILA_DE_ENVIO,
    rotulo: 'Entrega do ingresso por e-mail',
    // `parados` = ainda vai sair; `maduros` = já podia ter saído. A diferença
    // é a espera de quem falhou e está de castigo, que NÃO é fila entalada.
    sql: `
      WITH linhas AS (SELECT * FROM email_sends WHERE org_id = $1),
           por_pedido AS (
             SELECT bool_or(status = 'enviado')                AS teve_saida,
                    bool_or(status IN ('na_fila','enviando'))  AS tem_pendente,
                    bool_or(status = 'falhou')                 AS teve_falha
               FROM linhas WHERE order_id IS NOT NULL GROUP BY order_id
             UNION ALL
             -- Linha sem pedido não tem irmã: cada uma é um caso por si.
             -- Agrupar todas no mesmo \`order_id\` nulo juntaria gente
             -- diferente numa linha só, e o número mentiria pra MENOS — que é
             -- o jeito de errar que ninguém descobre olhando a tela.
             SELECT status = 'enviado', status IN ('na_fila','enviando'),
                    status = 'falhou'
               FROM linhas WHERE order_id IS NULL)
      SELECT COALESCE(COUNT(*) FILTER (WHERE status = 'na_fila'), 0)::int      AS parados,
             COALESCE(COUNT(*) FILTER (WHERE status = 'na_fila'
                                         AND available_at <= now()), 0)::int   AS maduros,
             COALESCE(COUNT(*) FILTER (WHERE status = 'enviando'), 0)::int     AS andando,
             COALESCE(COUNT(*) FILTER (WHERE status = 'falhou'), 0)::int       AS falharam,
             COALESCE(COUNT(*) FILTER (WHERE status = 'enviado'
                                         AND sent_at > now() - interval '24 hours'),
                      0)::int                                                  AS feitos_24h,
             COALESCE(EXTRACT(epoch FROM now() - MIN(available_at)
                              FILTER (WHERE status = 'na_fila'
                                        AND available_at <= now())), 0)::int   AS mais_velho,
             (SELECT count(*) FROM por_pedido
               WHERE teve_falha AND NOT teve_saida AND NOT tem_pendente)::int  AS perdidos,
             (SELECT count(*) FROM por_pedido
               WHERE NOT teve_saida AND (tem_pendente OR teve_falha))::int     AS pessoas_sem,
             (SELECT last_error FROM linhas
               WHERE last_error IS NOT NULL
               ORDER BY created_at DESC LIMIT 1)                               AS ultimo_erro,
             0::bigint                                                         AS preso_cents,
             0::bigint                                                         AS perdido_cents
        FROM linhas`,
    naoSaiu: (n: number) => `${n} ingresso(s) comprado(s) sem o e-mail na mão do cliente`,
  },
  {
    nome: FILA_DE_ESTORNO,
    rotulo: 'Devolução do dinheiro (estorno)',
    // `na_mao` fica FORA de "falharam" de propósito: é devolução que alguém
    // vai fazer por fora (dinheiro de balcão, PIX na chave do produtor), não
    // fila quebrada. Misturar as duas põe alarme vermelho em cima do que já
    // está resolvido, e alarme que mente é alarme que ninguém olha. Pela
    // mesma razão ela conta como SAÍDA no agrupamento por pedido: o destino
    // daquele dinheiro já foi decidido, só não foi por aqui.
    sql: `
      WITH linhas AS (SELECT * FROM refund_jobs WHERE org_id = $1),
           por_pedido AS (
             SELECT bool_or(status IN ('estornado','na_mao'))    AS teve_saida,
                    bool_or(status IN ('na_fila','estornando'))  AS tem_pendente,
                    bool_or(status = 'falhou')                   AS teve_falha
               FROM linhas GROUP BY order_id)
      SELECT COALESCE(COUNT(*) FILTER (WHERE status = 'na_fila'), 0)::int      AS parados,
             COALESCE(COUNT(*) FILTER (WHERE status = 'na_fila'
                                         AND available_at <= now()), 0)::int   AS maduros,
             COALESCE(COUNT(*) FILTER (WHERE status = 'estornando'), 0)::int   AS andando,
             COALESCE(COUNT(*) FILTER (WHERE status = 'falhou'), 0)::int       AS falharam,
             COALESCE(COUNT(*) FILTER (WHERE status = 'estornado'
                                         AND done_at > now() - interval '24 hours'),
                      0)::int                                                  AS feitos_24h,
             COALESCE(EXTRACT(epoch FROM now() - MIN(available_at)
                              FILTER (WHERE status = 'na_fila'
                                        AND available_at <= now())), 0)::int   AS mais_velho,
             (SELECT count(*) FROM por_pedido
               WHERE teve_falha AND NOT teve_saida AND NOT tem_pendente)::int  AS perdidos,
             (SELECT count(*) FROM por_pedido
               WHERE NOT teve_saida AND (tem_pendente OR teve_falha))::int     AS pessoas_sem,
             (SELECT last_error FROM linhas
               WHERE last_error IS NOT NULL
               ORDER BY created_at DESC LIMIT 1)                               AS ultimo_erro,
             COALESCE(SUM(amount_cents) FILTER (WHERE status IN ('na_fila','estornando')),
                      0)::bigint                                               AS preso_cents,
             -- Dinheiro que desistiu de voltar. Fica FORA de \`preso_cents\`
             -- porque preso ainda anda sozinho e este não anda mais: some da
             -- fila e some da conta do cliente ao mesmo tempo. A régua é a
             -- mesma de \`perdidos\` — pedido sem nenhuma saída e sem nada
             -- pendente —, senão o mesmo estorno seria contado duas vezes.
             (SELECT COALESCE(SUM(l.amount_cents), 0) FROM linhas l
               WHERE l.status = 'falhou'
                 AND NOT EXISTS (SELECT 1 FROM linhas b
                                  WHERE b.order_id = l.order_id
                                    AND b.status IN ('estornado','na_mao',
                                                     'na_fila','estornando')))::bigint
                                                                               AS perdido_cents
        FROM linhas`,
    naoSaiu: (n: number) => `${n} devolução(ões) que o cliente ainda não recebeu`,
  },
] as const

export default defineEventHandler(async (event) => {
  const sessao = (event.context as any).sessao
  if (!sessao?.orgId) {
    throw createError({ statusCode: 401, statusMessage: 'Faça login para continuar' })
  }
  const orgId = sessao.orgId as string

  const filas = []
  for (const f of FILAS) {
    const n = await q1<any>(f.sql, [orgId])

    // LEFT-JOIN na mão: fila que nunca carimbou tem contagem e não tem
    // carimbo. Um JOIN comeria a linha em silêncio e a fila que nunca subiu —
    // que é justamente a que importa — sumiria da tela.
    const ponto = await q1<any>(
      `SELECT status, instance, beat_ms, beats, booted_at, beat_at, worked_at,
              done, failed, last_error,
              EXTRACT(epoch FROM now() - beat_at)::int   AS bateu_ha,
              EXTRACT(epoch FROM now() - worked_at)::int AS trabalhou_ha
         FROM worker_heartbeats WHERE worker = $1`, [f.nome])

    const maduros = Number(n?.maduros ?? 0)
    const maisVelho = Number(n?.mais_velho ?? 0)
    const perdidos = Number(n?.perdidos ?? 0)
    const pessoasSem = Number(n?.pessoas_sem ?? 0)
    const v = vereditoDaFila({
      status: ponto?.status ?? null,
      bateuHaSegundos: ponto ? Number(ponto.bateu_ha) : null,
      intervaloMs: ponto?.beat_ms != null ? Number(ponto.beat_ms) : null,
      // Fila que só registra o boot não pode ser acusada de silêncio: o
      // "bateu há" dela é a idade do processo.
      carimba: ponto?.beats !== false,
      maduros,
      maisVelhoSegundos: maisVelho,
      // Sem isto, `ok` respondia "true" com gente que pagou e nunca vai
      // receber — a fila estava vazia porque desistiu, não porque entregou.
      perdidos,
    })

    filas.push({
      nome: f.nome,
      rotulo: f.rotulo,
      parado: v.parado,
      diagnostico: v.frase,

      // "quantos itens estão na fila"
      naFila: Number(n?.parados ?? 0),
      maduros,
      emAndamento: Number(n?.andando ?? 0),
      // "quantos falharam" — LINHAS, que é o tamanho do estrago na fila.
      falharam: Number(n?.falharam ?? 0),
      // Destes, quantos PEDIDOS ficaram sem nenhuma saída e sem nada pendente:
      // é o que ninguém vai tentar de novo sozinho.
      perdidos,
      feitas24h: Number(n?.feitos_24h ?? 0),

      esperaDoMaisVelhoSegundos: maisVelho,
      esperaDoMaisVelhoTexto: maduros ? emPortugues(maisVelho) : null,
      presoCents: Number(n?.preso_cents ?? 0),
      perdidoCents: Number(n?.perdido_cents ?? 0),

      // O custo em GENTE, não em linha de tabela — e gente se conta por
      // pedido. Duas tentativas falhas do mesmo comprador são duas linhas e
      // uma pessoa só; medido antes disto, a resposta dizia "2 ingresso(s)
      // comprado(s) sem o e-mail" para UM cliente no balcão.
      custo: pessoasSem > 0 ? f.naoSaiu(pessoasSem) : null,

      ultimoErro: n?.ultimo_erro ?? null,

      // "há quanto tempo o worker não roda"
      trabalhador: ponto
        ? {
            estado: ponto.status,
            instancia: ponto.instance,
            subiuEm: ponto.booted_at,
            // Sem carimbo de varredura, o "bateu há" é a idade do boot e não
            // diz nada sobre estar vivo. Vai como null pra tela não desenhar
            // um número que parece batimento e não é.
            carimbaVarredura: ponto.beats !== false,
            bateuHaSegundos: ponto.beats === false ? null : Number(ponto.bateu_ha),
            bateuHaTexto: ponto.beats === false
              ? null : emPortugues(Number(ponto.bateu_ha)),
            varreDeSegundos: ponto.beat_ms != null
              ? Math.round(Number(ponto.beat_ms) / 1000) : null,
            trabalhouHaSegundos: ponto.trabalhou_ha != null
              ? Number(ponto.trabalhou_ha) : null,
            feitosDesdeOBoot: Number(ponto.done ?? 0),
            falhosDesdeOBoot: Number(ponto.failed ?? 0),
            ultimoErro: ponto.last_error ?? null,
          }
        : null,
    })
  }

  return {
    // `ok` é a única coisa que um alarme externo precisa ler. Falso quer
    // dizer "tem gente sem receber o que pagou", não "tem aviso na tela".
    ok: filas.every((f) => !f.parado),
    agora: new Date().toISOString(),
    filas,
  }
})
