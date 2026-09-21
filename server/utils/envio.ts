/**
 * envio.ts — a fila de e-mail: quem sai, quando, e o que fazer quando falha.
 *
 * O que `email.ts` monta, este arquivo entrega. A divisão não é estética: o
 * corpo do e-mail é puro (dá pra provar sem banco) e a fila é toda estado
 * compartilhado (só dá pra provar contra o banco, com duas conexões).
 *
 * ## Por que fila, e não `await enviarEmail()` dentro do webhook
 *
 * O handler do Asaas tem prazo. Servidor de e-mail engasga, demora 30 s,
 * devolve 421 e pede pra tentar mais tarde — e se isso acontecer dentro do
 * webhook, o Asaas não recebe 200, reentrega o evento, e a confirmação do
 * PAGAMENTO passa a depender do humor do servidor de e-mail. Dinheiro
 * confirmado não pode depender de correio. Aqui o pagamento grava a linha
 * (gatilho da migração 018, dentro da mesma transação) e vai embora.
 *
 * ## O claim é atômico ou a pessoa recebe duas vezes
 *
 * Dois processos varrendo a mesma fila é o caso normal (duas instâncias no
 * ar, ou o trabalhador de fundo e o reenvio do balcão ao mesmo tempo). Ler
 * com SELECT e marcar depois com UPDATE deixa os dois lerem a MESMA linha
 * antes de qualquer um marcar — e aí o comprador recebe o ingresso em
 * duplicata e liga perguntando se foi cobrado duas vezes. A reserva aqui é
 * UM comando: `UPDATE ... WHERE id = (SELECT ... FOR UPDATE SKIP LOCKED)
 * RETURNING`. Quem chega segundo pula a linha travada em vez de esperar por
 * ela, que é o que mantém dois trabalhadores dividindo trabalho em vez de
 * brigando.
 *
 * ## O laço nasce no plugin, não no `import`
 *
 * O trabalhador de fundo é ligado por `server/plugins/00.filas.ts`, que o
 * Nitro roda no boot do processo. Este arquivo NÃO liga nada por conta
 * própria ao ser importado — ver a nota em `garantirWorker()` pro defeito que
 * isso causou no build de produção.
 *
 * ## Fila invisível é fila que só se descobre quando o cliente liga
 *
 * A última parte do arquivo (`baterPonto`, `vereditoDaFila`) existe porque
 * contar a fila não responde "ela está andando?". Fila vazia com trabalhador
 * morto é idêntica a fila vazia com trabalhador vivo, até a primeira venda.
 * Quem distingue é o carimbo de cada varredura.
 */
import { hostname } from 'node:os'
import QRCode from 'qrcode'
import type { PoolClient, Pool } from 'pg'
import { db, q, q1 } from './db'
import { montarQr } from './ingresso'
import { PEDIDO_VIVO } from './liquido'
import {
  entregar, montarConfirmacao, type Entrega, type IngressoNoEmail, type Mensagem,
  type Transporte, transporteEscolhido,
} from './email'

/** Conexão OU pool: a reserva é um comando só e roda bem nos dois. */
type Executor = Pool | PoolClient

export interface LinhaEnvio {
  id: string
  org_id: string
  event_id: string | null
  order_id: string | null
  kind: string
  origin: string
  to_email: string
  to_name: string | null
  status: string
  attempts: number
  max_attempts: number
}

/* ------------------------------------------------------------ transporte */

let transporteInjetado: Transporte | null = null

/**
 * Troca o transporte em tempo de execução. Existe por dois motivos: o teste
 * precisa de um transporte que FALHA de propósito, e trocar o correio por um
 * provedor de API (Resend, SES) depois não pode exigir mexer na fila.
 */
export function usarTransporte(t: Transporte | null) {
  transporteInjetado = t
}

const entregarAgora = (m: Mensagem) => (transporteInjetado ?? entregar)(m)

/* ------------------------------------------------------------- a reserva */

/**
 * A reserva atômica. Exportada porque o teste de concorrência tem que rodar
 * EXATAMENTE este comando — um teste que reimplementa a reserva prova a cópia
 * dele, não a que roda em produção.
 *
 * $1 = quem está reservando (nome do trabalhador, pra rastro)
 * $2 = um id específico, ou NULL pra pegar o próximo da fila
 *
 * Quatro coisas dentro dele:
 *  • `status = 'na_fila' AND available_at <= now()` — respeita o adiamento de
 *    quem falhou e ainda está de castigo.
 *  • **pedido por id fura a espera**: quem apertou "mandar de novo" está com o
 *    cliente na frente e não vai esperar o castigo de uma tentativa anterior
 *    terminar. A varredura de fundo (id nulo) continua respeitando.
 *  • `status = 'enviando' AND claimed_at < now() - 5 min` — resgata a linha
 *    que ficou presa porque o processo morreu no meio. Sem isso, um kill -9
 *    durante o envio some com o ingresso pra sempre.
 *  • `SKIP LOCKED` — o segundo trabalhador pula a linha travada e pega outra.
 */
export const SQL_RESERVA = `
  UPDATE email_sends SET
    status = 'enviando',
    attempts = attempts + 1,
    claimed_at = now(),
    claimed_by = $1
  WHERE id = (
    SELECT id FROM email_sends
     WHERE ($2::uuid IS NULL OR id = $2::uuid)
       AND ( (status = 'na_fila' AND (available_at <= now() OR $2::uuid IS NOT NULL))
          OR (status = 'enviando' AND claimed_at < now() - interval '5 minutes') )
     ORDER BY available_at
     FOR UPDATE SKIP LOCKED
     LIMIT 1
  )
  RETURNING *`

export async function reservarProximo(
  exec: Executor, trabalhador: string, id?: string | null,
): Promise<LinhaEnvio | null> {
  const r = await exec.query(SQL_RESERVA, [trabalhador, id ?? null])
  return (r.rows[0] as LinhaEnvio) ?? null
}

/* ----------------------------------------------------------- enfileirar */

export interface PedidoParaEnfileirar {
  orgId: string
  eventId: string | null
  orderId: string
  paraEmail: string
  paraNome?: string | null
  origem?: 'automatico' | 'reenvio'
  pedidoPor?: string | null
}

/**
 * Põe na fila. O caminho automático NÃO passa por aqui — lá quem enfileira é
 * o gatilho do banco, na mesma transação do pagamento, justamente pra não
 * existir caminho de código que esqueça de chamar. Esta função é o reenvio
 * pedido no balcão.
 *
 * `exec` aceita a conexão de uma transação já aberta. Não é comodidade: a
 * rota de reenvio decide se enfileira depois de olhar o que já está pendente,
 * e olhar num lugar pra gravar em outro é a corrida clássica — dois cliques
 * simultâneos leem "não tem nada pendente" antes de qualquer um gravar, e o
 * comprador recebe o ingresso duas vezes. Com a conexão da transação, o olhar
 * e a gravação ficam do mesmo lado da trava do pedido.
 */
export async function enfileirar(
  p: PedidoParaEnfileirar, exec?: Executor,
): Promise<string> {
  const sql = `INSERT INTO email_sends (org_id, event_id, order_id, kind, origin,
                                        to_email, to_name, requested_by)
               VALUES ($1,$2,$3,'confirmacao_pedido',$4,$5,$6,$7)
               RETURNING id`
  const valores = [p.orgId, p.eventId, p.orderId, p.origem ?? 'reenvio',
    p.paraEmail.trim(), p.paraNome ?? null, p.pedidoPor ?? null]
  if (exec) return (await exec.query(sql, valores)).rows[0].id
  const linha = await q1<any>(sql, valores)
  return linha!.id
}

/* -------------------------------------------------------- montar o corpo */

/** Erro que NÃO adianta repetir: o adiamento não resolveria. */
class ErroDefinitivo extends Error {}

/**
 * Lê o pedido e devolve o e-mail pronto — com um QR gerado na hora por
 * ingresso.
 *
 * O QR é desenhado aqui, e não guardado: assim ingresso cancelado para de
 * produzir imagem no mesmo instante, sem depender de apagar arquivo nenhum.
 */
export async function montarMensagemDoPedido(
  orderId: string, paraEmail: string, paraNome?: string | null,
): Promise<Mensagem> {
  const o = await q1<any>(
    `SELECT o.id, o.code, o.status, o.total_cents, o.event_id,
            (${PEDIDO_VIVO('o.')}) AS vale_ingresso,
            c.name AS comprador, c.email AS comprador_email,
            e.name AS evento, e.starts_at, e.venue_name, e.city, e.state, e.ticket_noun
       FROM orders o
       JOIN events e ON e.id = o.event_id
       LEFT JOIN customers c ON c.id = o.customer_id
      WHERE o.id = $1`, [orderId])
  if (!o) throw new ErroDefinitivo('o pedido não existe mais')

  // Estorno TOTAL, cancelamento, chargeback: o ingresso não vale mais, e
  // mandar "seus ingressos estão confirmados" depois disso é pior do que não
  // mandar nada — a pessoa aparece no portão com um QR morto.
  if (!o.vale_ingresso) {
    throw new ErroDefinitivo(`o pedido saiu de pago (está ${o.status}) antes do e-mail sair`)
  }

  const ingressos = await q<any>(
    `SELECT t.id, t.code, t.status, t.holder_name,
            s.name AS setor, l.name AS lote, tt.name AS tipo,
            ses.title AS sessao, ses.starts_at AS sessao_inicio
       FROM tickets t
       JOIN lots l ON l.id = t.lot_id
       JOIN sectors s ON s.id = l.sector_id
       LEFT JOIN ticket_types tt ON tt.id = t.ticket_type_id
       LEFT JOIN event_sessions ses ON ses.id = s.session_id
      WHERE t.order_id = $1 AND t.status <> 'cancelado'
      ORDER BY s.sort_order, t.issued_at, t.code`, [orderId])

  // Sem ingresso não existe e-mail de ingresso. Isto é retentável de
  // propósito: se a emissão ainda estiver acontecendo, a próxima tentativa
  // encontra tudo no lugar.
  if (!ingressos.length) throw new Error('o pedido ainda não tem ingresso emitido')

  const comQr: IngressoNoEmail[] = []
  for (const t of ingressos) {
    comQr.push({
      id: t.id,
      codigo: t.code,
      setor: t.setor,
      lote: t.lote,
      tipo: t.tipo,
      sessao: t.sessao ?? (t.sessao_inicio ? String(t.sessao_inicio) : null),
      titular: t.holder_name,
      qrPng: await QRCode.toBuffer(montarQr(t.code, o.event_id), {
        margin: 1, width: 360, errorCorrectionLevel: 'M',
      }),
    })
  }

  const local = [o.venue_name, [o.city, o.state].filter(Boolean).join('/')]
    .filter(Boolean).join(' · ')

  return montarConfirmacao({
    pedido: o.code,
    compradorNome: paraNome ?? o.comprador,
    compradorEmail: paraEmail,
    eventoNome: o.evento,
    eventoInicio: o.starts_at,
    local: local || null,
    totalCents: Number(o.total_cents),
    substantivo: o.ticket_noun,
    ingressos: comQr,
    linkIngressos: `${baseDoSite()}/ingressos/${o.code}`,
  })
}

/** A URL pública do site. Sem ela o link do e-mail apontaria pro vazio. */
export function baseDoSite(): string {
  return (process.env.PUBLIC_BASE_URL || 'http://localhost:3100').replace(/\/+$/, '')
}

/* ------------------------------------------------------------ processar */

export interface ResultadoEnvio {
  id: string
  ok: boolean
  status: 'enviado' | 'na_fila' | 'falhou'
  para: string
  via?: Entrega['via']
  arquivo?: string
  erro?: string
  tentativa: number
}

/**
 * Pega UMA linha e leva até o fim. Devolve null quando não havia nada pra
 * fazer — é assim que o laço sabe parar.
 *
 * A reserva é comando próprio, fora de transação longa, de propósito: manter
 * a linha travada durante a conversa com o servidor de e-mail prenderia uma
 * conexão do pool por 30 s a cada envio lento.
 */
export async function processarUm(
  trabalhador = 'padrao', id?: string | null,
): Promise<ResultadoEnvio | null> {
  const linha = await reservarProximo(db(), trabalhador, id)
  if (!linha) return null

  const inicio = Date.now()
  const transporte = transporteInjetado ? 'injetado' : transporteEscolhido()
  try {
    const mensagem = await montarMensagemDoPedido(
      linha.order_id!, linha.to_email, linha.to_name)
    const entrega = await entregarAgora(mensagem)

    await q(
      `UPDATE email_sends SET status = 'enviado', sent_at = now(), sent_via = $2,
              message_id = $3, file_path = $4, subject = $5, body_text = $6,
              body_html = $7, last_error = NULL, claimed_at = NULL
        WHERE id = $1`,
      [linha.id, entrega.via, entrega.messageId, entrega.arquivo ?? null,
       mensagem.assunto, mensagem.texto, mensagem.html])
    await anotarTentativa(linha, entrega.via, true, null, Date.now() - inicio, trabalhador)

    return {
      id: linha.id, ok: true, status: 'enviado', para: linha.to_email,
      via: entrega.via, arquivo: entrega.arquivo, tentativa: linha.attempts,
    }
  } catch (e: any) {
    const erro = legivel(e, linha.to_email)
    // Erro definitivo não ganha nova chance: repetir um pedido estornado
    // cinco vezes só enche o log e atrasa a fila de quem tem ingresso válido.
    const desiste = e instanceof ErroDefinitivo || linha.attempts >= linha.max_attempts
    await q(
      `UPDATE email_sends SET status = $2, last_error = $3, claimed_at = NULL,
              available_at = CASE WHEN $2 = 'na_fila'
                                  THEN now() + make_interval(secs => $4) ELSE available_at END
        WHERE id = $1`,
      [linha.id, desiste ? 'falhou' : 'na_fila', erro, adiamentoSegundos(linha.attempts)])
    await anotarTentativa(linha, transporte, false, erro, Date.now() - inicio, trabalhador)

    return {
      id: linha.id, ok: false, status: desiste ? 'falhou' : 'na_fila',
      para: linha.to_email, erro, tentativa: linha.attempts,
    }
  }
}

/** 30 s, 1 min, 2 min, 4 min… com teto de 1 h. */
export function adiamentoSegundos(tentativa: number): number {
  return Math.min(3600, 30 * 2 ** Math.max(0, tentativa - 1))
}

async function anotarTentativa(
  linha: LinhaEnvio, transporte: string, ok: boolean,
  erro: string | null, ms: number, trabalhador: string,
) {
  await q(
    `INSERT INTO email_send_attempts (send_id, attempt, worker, transport, ok, error, ms)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [linha.id, linha.attempts, trabalhador, transporte, ok, erro, ms])
}

/**
 * Mensagem de erro escrita pra quem atende o cliente, não pro log. "550" não
 * ajuda ninguém no guichê; "a caixa de entrada recusou" ajuda.
 */
export function legivel(e: any, destino: string): string {
  const cru = String(e?.message ?? e ?? 'erro desconhecido')
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|não respondeu|encerrou a conexão/i.test(cru)) {
    return `Não consegui falar com o servidor de e-mail para entregar em ${destino}: ${cru}`
  }
  return `Não consegui entregar em ${destino}: ${cru}`
}

/** Varre a fila até acabar (ou até o teto). Devolve o que fez. */
export async function processarFila(
  limite = 25, trabalhador = 'fila',
): Promise<ResultadoEnvio[]> {
  const feitos: ResultadoEnvio[] = []
  for (let i = 0; i < limite; i++) {
    const r = await processarUm(trabalhador)
    if (!r) break
    feitos.push(r)
  }
  return feitos
}

/* -------------------------------------------------------- trabalhador */

let relogio: ReturnType<typeof setInterval> | null = null
let rodando = false

export const INTERVALO_MS = Number(process.env.ENVIO_INTERVALO_MS || 15_000)

/**
 * Liga o trabalhador de fundo. Idempotente: chamar dez vezes não cria dez
 * laços.
 *
 * **Quem chama isto é `server/plugins/00.filas.ts`, e ninguém mais precisa.**
 * Até a versão anterior o laço subia por efeito colateral de `import` deste
 * módulo, no fim do arquivo. Em dev funcionava e por isso ninguém viu; no
 * `npm run build` o empacotador fatia o servidor por rota, e o único pedaço
 * que importava este módulo era o da rota de reenvio — que é `lazy: true`.
 * Resultado medido no build: o trabalhador só nascia se alguém abrisse a tela
 * de reenvio, e ninguém abre. O comprador pagava e não recebia nada, que era
 * exatamente o defeito que a fila existia pra fechar.
 *
 * `unref()` pra não segurar o processo vivo — sem isso, o mesmo laço que
 * mantém a fila andando em produção travaria o `vitest` no fim da suíte.
 */
export function garantirWorker(): boolean {
  if (relogio || process.env.DT_ENVIO_WORKER === 'off') return false
  relogio = setInterval(() => {
    if (rodando) return   // varredura anterior ainda não terminou
    rodando = true
    processarFila()
      .then(async (f) => {
        // Só fala quando fez alguma coisa: "0 enviados" a cada 15 s esconde
        // o dia em que 300 falharem de uma vez.
        const ruins = f.filter((r) => !r.ok)
        if (f.length) console.log(`[envio] ${f.length - ruins.length} enviado(s)` +
          (ruins.length ? `, ${ruins.length} com falha: ${ruins[0].erro}` : ''))
        // A batida sai TODA varredura, inclusive a que não achou nada. É o
        // que separa "fila vazia" de "trabalhador morto" — ver baterPonto().
        await baterPonto(FILA_DE_ENVIO, {
          feitos: f.length - ruins.length, falhos: ruins.length,
          erro: ruins[0]?.erro ?? null,
        })
      })
      .catch(async (e) => {
        const erro = String(e?.message ?? e)
        console.error('[envio] varredura falhou:', erro)
        await baterPonto(FILA_DE_ENVIO, { erro })
      })
      .finally(() => { rodando = false })
  }, INTERVALO_MS)
  relogio.unref?.()
  return true
}

export function pararWorker() {
  if (relogio) clearInterval(relogio)
  relogio = null
}

/* ------------------------------------------------------ batida do ponto */

/**
 * Os nomes das duas filas de fundo do sistema. Os dois trabalhadores nascem
 * no mesmo plugin e são lidos pela mesma tela, então os nomes moram num lugar
 * só — string solta em três arquivos é como a tela passa a olhar uma fila que
 * ninguém carimba mais.
 */
export const FILA_DE_ENVIO = 'envio'
export const FILA_DE_ESTORNO = 'estorno'

/** host:pid. Com duas instâncias no ar, "não bate" pode ser só UMA morta. */
export function instanciaDoProcesso(): string {
  return `${hostname()}:${process.pid}`
}

/**
 * A tabela do carimbo, UMA LINHA POR PROCESSO (migração 026).
 *
 * Até a 025 a chave era só `worker`: as duas instâncias de um deploy com mais
 * de um contêiner escreviam a MESMA linha, e quem batia por último apagava o
 * rastro da outra. Medido no banco com o INSERT literal daqui: maquinaA morta
 * há 10 min, maquinaB batendo — uma linha só, `bateu_ha = 0`, e a tela
 * respondendo "Andando" com metade da frota parada.
 *
 * `worker_heartbeats` continua existindo e é o que a tela de saúde lê: virou
 * uma VISÃO que resume a frota numa linha por fila, com o `beat_at` da
 * instância ligada mais CALADA — a viva não empresta o carimbo pra morta. Por
 * isso escrever aqui é sempre na tabela física, e ler sobre "a fila" é sempre
 * na visão.
 */
const TABELA_DO_PONTO = 'worker_heartbeat_instances'

/**
 * As filas de que ESTE processo já bateu a saída.
 *
 * O gancho `close` do Nitro apaga a linha, mas NÃO para o laço — e a varredura
 * que começou antes do SIGTERM continua rodando (entregar por SMTP leva
 * segundos) e termina chamando `baterPonto`, que é um `INSERT ... ON CONFLICT`
 * e RECRIA a linha recém-apagada. Medido: `anunciarWorker` → `encerrarPonto` →
 * `baterPonto` deixa a linha de volta no banco.
 *
 * A linha que volta nasce com os PADRÕES da coluna — `status = 'ligado'`,
 * `beats = true`, `booted_at = now()` — e o processo morre logo depois. Em
 * Docker o contêiner novo tem outro hostname, então a limpeza de mesma-máquina
 * do `anunciarWorker` nunca alcança esse fantasma: ele fica no painel pra
 * sempre, um por deploy que pegou uma varredura em voo. É o alarme falso
 * diário que a 026 foi escrita pra evitar, entrando pela porta dos fundos.
 *
 * Por fila, e não global: uma fila pode sair enquanto a outra continua. E
 * `anunciarWorker` tira dela de novo — quem anuncia está de volta ao trabalho,
 * e uma mordaça permanente esconderia a fila VIVA, que é estrago maior que o
 * fantasma.
 */
const SAIRAM = new Set<string>()

/**
 * Registra que o trabalhador SUBIU (ou que está desligado de propósito).
 *
 * Chamado pelo plugin no boot, uma vez por processo. Sem esta linha, a tela
 * de saúde não consegue distinguir "nunca subiu neste ambiente" de "subiu e
 * parou", que pedem respostas completamente diferentes: a primeira é
 * configuração, a segunda é o processo travado.
 */
export async function anunciarWorker(
  worker: string, ligado: boolean, intervaloMs?: number | null,
  /**
   * Este trabalhador carimba CADA varredura, ou só o boot?
   *
   * A fila de estorno não carimba: o laço dela mora em `utils/cancelamento.ts`
   * e aquele arquivo não é meu pra mexer. Dizer aqui que ela carimba faria a
   * tela acusar silêncio 45 s depois do boot, todo boot, numa fila que está
   * trabalhando — alarme falso diário até o operador parar de olhar a tela,
   * que é um estrago maior do que o da tela não existir.
   */
  carimba = true,
): Promise<void> {
  const instancia = instanciaDoProcesso()
  // Anunciar é o contrário de sair: este processo voltou a atender esta fila.
  SAIRAM.delete(worker)

  await engolir(q(
    `INSERT INTO ${TABELA_DO_PONTO} (worker, status, instance, beat_ms, beats,
                                     booted_at, beat_at)
     VALUES ($1::text, $2::text, $3::text, $4::int, $5::boolean, now(), now())
     ON CONFLICT (worker, instance) DO UPDATE SET
       status = EXCLUDED.status,
       beat_ms = EXCLUDED.beat_ms, beats = EXCLUDED.beats,
       booted_at = now(), beat_at = now(),
       last_error = NULL`,
    [worker, ligado ? 'ligado' : 'desligado', instancia, regua(intervaloMs), carimba]))

  // A vida ANTERIOR deste mesmo lugar sai da frota agora.
  //
  // Chave por processo cria um lixo que a chave por fila não tinha: cada
  // reinício é um pid novo e a linha do pid velho fica calada pra sempre. Sem
  // esta limpeza, a tela acusaria uma instância morta depois de TODO deploy e
  // de todo `npm run dev` — alarme falso diário, que é como se ensina o
  // operador a não olhar mais a tela.
  //
  // A régua é a mesma da visão (026): mesma fila, mesma MÁQUINA, e já calada
  // além da própria tolerância. O irmão que está vivo bate a cada 15 s e nunca
  // cai nessa janela, então derrubar o processo antigo não derruba o que está
  // trabalhando ao lado. Instância de OUTRA máquina não é tocada — essa,
  // calada, é morte de verdade e tem que continuar aparecendo.
  await engolir(q(
    `DELETE FROM ${TABELA_DO_PONTO}
      WHERE worker = $1::text
        AND instance <> $2::text
        AND maquina_da_instancia(instance) = maquina_da_instancia($2::text)
        AND beat_at < now() - make_interval(
              secs => GREATEST(45, (COALESCE(beat_ms, 15000) * 3) / 1000.0))`,
    [worker, instancia]))
}

/**
 * A régua do trabalhador, ou nada.
 *
 * Um `NaN` aqui derruba a linha INTEIRA — o Postgres recusa "NaN" num `int`,
 * e como falha de carimbo é engolida de propósito, o efeito visível é a fila
 * some da tela de saúde como se nunca tivesse subido. É fácil chegar num
 * `NaN`: o intervalo vem de `Number(process.env.…)` de OUTRO módulo, e a
 * ordem em que o empacotador inicializa as constantes entre módulos não é
 * coisa que este arquivo controle. Sem régua a tela usa a dela; sem linha
 * nenhuma a tela mente.
 */
function regua(ms?: number | null): number | null {
  return typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? Math.round(ms) : null
}

/**
 * A batida de cada varredura.
 *
 * Bate MESMO quando não havia nada na fila, de propósito: fila vazia com
 * trabalhador vivo e fila vazia com trabalhador morto são a mesma linha no
 * banco até a primeira venda — e aí já é tarde. O que distingue as duas é
 * alguém dizendo "estou aqui" de quinze em quinze segundos.
 *
 * `done`/`failed` são acumulados (`+`), não substituídos: a pergunta de quem
 * abre a tela às 21h é "quanto já saiu desde que este processo subiu", e
 * sobrescrever com o resultado da última varredura responderia sempre 0 ou 1.
 *
 * Falha de batida NUNCA derruba a fila: o ponto é um registro sobre o
 * trabalho, não o trabalho. Se o banco piscar na hora do carimbo, o ingresso
 * ainda tem que sair.
 *
 * **Quem bate o ponto tem que bater a SAÍDA também.** Desde a 026 cada
 * processo tem a sua linha, então um processo curto que carimba uma fila de
 * verdade e vai embora (um teste, um script de terminal) deixa uma instância
 * fantasma, calada pra sempre — e a tela passa a acusar de parada uma fila que
 * está trabalhando. O laço de fundo é longo e sai pelo `encerrarPonto()` do
 * gancho `close` (`server/plugins/00.filas.ts`); quem não for laço chama o
 * `encerrarPonto()` na mão.
 */
export async function baterPonto(
  worker: string,
  o: {
    feitos?: number; falhos?: number; erro?: string | null
    /** a régua daquele laço; sem isto vale a da fila de e-mail, que é quem bate aqui */
    intervaloMs?: number | null
  } = {},
): Promise<void> {
  // Já bateu a saída nesta fila: a varredura que estava em voo quando o
  // SIGTERM chegou não recria a linha que o `encerrarPonto` apagou. Ver
  // `SAIRAM`. Sai calado de propósito — é o fim normal de um desligamento, não
  // um erro pra sujar o log do deploy.
  if (SAIRAM.has(worker)) return

  const feitos = o.feitos ?? 0
  const falhos = o.falhos ?? 0
  // `instance` é METADE DA CHAVE, e isso custou uma tela mentindo.
  //
  // `instance` e `booted_at` são o mesmo fato: QUAL processo subiu e QUANDO.
  // Quem escreve os dois juntos é `anunciarWorker`, no boot. Quando a batida
  // reescrevia `instance` na linha do outro, ela passava a misturar dois
  // processos — medido na tela: `subiuEm 06:29:50` com `instancia :21600`, e o
  // 21600 não tinha subido àquela hora. Numa investigação de "o ingresso não
  // saiu às 21h", esse par manda olhar o log do processo errado.
  //
  // Com a chave por `(worker, instance)` (026) isso deixou de depender de
  // cuidado: a batida de um processo não alcança a linha de outro nem se
  // quiser. O que ela ainda não pode é apagar a hora de subida da PRÓPRIA
  // linha — por isso `booted_at` continua fora do UPDATE.
  //
  // A régua do UPDATE vai por COALESCE: batida sem régua na mão não apaga a
  // que o anúncio do boot gravou. Sem isso, a tela de saúde perderia a
  // referência de "quanto tempo é silêncio demais" na primeira varredura.
  //
  // Todo parâmetro vai CASTADO. Sem o `::int`, o Postgres recebe dois valores
  // sem tipo nos dois lados do `+` e recusa a consulta inteira com
  // "operator is not unique: unknown + unknown" — e, como falha de carimbo é
  // engolida de propósito, o erro só aparecia como uma linha no log com a
  // batida nunca chegando ao banco. Foi assim que este mesmo INSERT rodou
  // três varreduras seguidas sem gravar nada.
  await engolir(q(
    `INSERT INTO ${TABELA_DO_PONTO} (worker, instance, beat_ms, beat_at, worked_at,
                                     done, failed, last_error)
     VALUES ($1::text, $2::text, $3::int, now(),
             CASE WHEN $4::int + $5::int > 0 THEN now() END,
             $4::int, $5::int, $6::text)
     ON CONFLICT (worker, instance) DO UPDATE SET
       beat_ms = COALESCE(EXCLUDED.beat_ms, ${TABELA_DO_PONTO}.beat_ms),
       beat_at = now(),
       worked_at = COALESCE(EXCLUDED.worked_at, ${TABELA_DO_PONTO}.worked_at),
       done = ${TABELA_DO_PONTO}.done + EXCLUDED.done,
       failed = ${TABELA_DO_PONTO}.failed + EXCLUDED.failed,
       last_error = COALESCE(EXCLUDED.last_error, ${TABELA_DO_PONTO}.last_error)`,
    [worker, instanciaDoProcesso(), regua(o.intervaloMs ?? INTERVALO_MS),
     feitos, falhos, o.erro ?? null]))
}

/**
 * O ponto de SAÍDA: este processo está saindo de propósito.
 *
 * Sem ele, a diferença entre "desligaram esta máquina" e "esta máquina morreu"
 * não existe no banco — as duas deixam uma linha calada pra sempre, e a tela
 * de saúde passa a acusar uma instância que ninguém quer de volta. Alarme que
 * não tem como ser resolvido é alarme que o operador aprende a ignorar, e aí
 * ele ignora junto o dia em que a instância caiu de verdade.
 *
 * Quem chama é o gancho `close` do Nitro (`server/plugins/00.filas.ts`), que
 * roda no SIGTERM de um deploy ou de um `docker stop`. Queda seca — OOM,
 * energia, `kill -9` — não passa por aqui, e é exatamente isso que se quer:
 * essa linha FICA, calada, acusando. Saída limpa some da frota; morte, não.
 *
 * A marca em `SAIRAM` vem ANTES do `DELETE`: entre marcar e apagar não pode
 * caber uma batida da varredura em voo, senão ela grava a linha depois do
 * apagamento e o fantasma nasce exatamente no lugar que este conserto fecha.
 */
export async function encerrarPonto(worker: string): Promise<void> {
  SAIRAM.add(worker)
  await engolir(q(
    `DELETE FROM ${TABELA_DO_PONTO} WHERE worker = $1::text AND instance = $2::text`,
    [worker, instanciaDoProcesso()]))
}

/** Erro de carimbo vira uma linha no log, nunca uma exceção que sobe. */
async function engolir(p: Promise<unknown>): Promise<void> {
  try { await p } catch (e: any) {
    console.error('[fila] não consegui bater o ponto:', e?.message ?? e)
  }
}

/* ------------------------------------------------------------ o veredito */

/** O que a tela de saúde recebe sobre UMA fila, já medido pelo banco. */
export interface SinalDaFila {
  /** o que a fila carimbou, ou null quando nunca carimbou nada */
  status?: 'ligado' | 'desligado' | null
  bateuHaSegundos?: number | null
  /** o intervalo daquele processo, que é a régua do "atrasado" */
  intervaloMs?: number | null
  /**
   * A fila carimba cada varredura? Quando não carimba, o silêncio dela não
   * quer dizer nada e acusar por silêncio seria mentira — sobra julgar pelo
   * resultado, que é o que ficou parado. `undefined` = carimba (é o normal).
   */
  carimba?: boolean | null
  /** itens prontos pra sair e ainda parados */
  maduros: number
  /** idade do mais velho que já podia ter saído */
  maisVelhoSegundos?: number | null
  /**
   * Pedidos que desistiram DE VEZ: falharam, não têm nenhuma linha pendente e
   * nunca tiveram saída.
   *
   * Contar só o que está `na_fila` responde "a fila anda?" e deixa passar a
   * pergunta que o cliente faz: "cadê o meu ingresso?". `status = 'falhou'` é
   * fim de linha — `SQL_RESERVA` não pega a linha nem por id, nenhum laço
   * tenta de novo —, então fila vazia por desistência é indistinguível de
   * fila vazia por entrega. Medido no build antes disto: dois e-mails
   * perdidos de vez e a resposta era `ok: true`, "Andando, e sem nada
   * esperando", com o custo ao lado dizendo que tinha gente sem ingresso.
   */
  perdidos?: number | null
}

/**
 * Três batidas perdidas. Uma só é ruído — a varredura anterior pode estar no
 * meio de um SMTP lento e a seguinte sai atrasada. Três seguidas não é
 * lentidão, é ausência.
 */
const BATIDAS_DE_TOLERANCIA = 3

/**
 * "A fila está andando?", em uma frase que o operador lê às 21h.
 *
 * PURO de propósito: a decisão é aritmética e cabe num teste de mesa, sem
 * subir servidor nem encher banco. A rota só junta os números e pergunta
 * aqui — é o que impede a tela de responder por conta própria e divergir.
 *
 * A ordem das perguntas importa. "Não carimbou nunca" vem antes de "tem item
 * parado": a fila com 300 presos e nenhum carimbo é o trabalhador que não
 * subiu, e mandar o operador olhar os 300 itens é mandar ele pro lugar
 * errado.
 */
export function vereditoDaFila(s: SinalDaFila): { parado: boolean; frase: string } {
  const espera = Math.max(1000, s.intervaloMs ?? INTERVALO_MS)
  const atraso = Math.round((espera * BATIDAS_DE_TOLERANCIA) / 1000)

  if (s.status === 'desligado') {
    return {
      parado: true,
      frase: 'Esta fila está DESLIGADA neste servidor (DT_ENVIO_WORKER=off). '
        + 'Nada sai dela enquanto estiver assim.',
    }
  }

  if (s.status == null || s.bateuHaSegundos == null) {
    return {
      parado: true,
      frase: 'Esta fila nunca deu sinal de vida neste servidor — o trabalhador não subiu. '
        + 'Ninguém vai receber nada até ele subir; reinicie o servidor e confira esta tela.',
    }
  }

  // Só quem carimba pode ser acusado de silêncio. Numa fila que só registra o
  // boot, `bateuHaSegundos` é a idade do processo, e comparar a idade do
  // processo com o intervalo de varredura condena todo servidor que passou de
  // um minuto no ar.
  const carimba = s.carimba !== false

  if (carimba && s.bateuHaSegundos > atraso) {
    return {
      parado: true,
      frase: `O trabalhador desta fila não dá sinal há ${emPortugues(s.bateuHaSegundos)} `
        + `(o normal é a cada ${Math.round(espera / 1000)}s). `
        + 'O que estiver na fila não está saindo.',
    }
  }

  const perdidos = s.perdidos ?? 0

  if (s.maduros > 0 && (s.maisVelhoSegundos ?? 0) > atraso) {
    return {
      parado: true,
      frase: (carimba ? 'O trabalhador está vivo, mas ' : 'Esta fila está atrasada: ')
        + `${s.maduros} item(ns) já podiam ter saído e `
        + `o mais velho espera há ${emPortugues(s.maisVelhoSegundos ?? 0)}. `
        + 'Olhe o último erro da fila.'
        // Os dois cabem na mesma tela e pedem coisas diferentes: o atrasado
        // sai sozinho quando destravar, o que parou de vez só sai se alguém
        // mandar. Escolher um e calar o outro é o que fazia a resposta se
        // contradizer.
        + (perdidos > 0 ? ` E ${paradosDeVez(perdidos)}: ninguém tenta de novo.` : ''),
    }
  }

  // Fila VAZIA porque desistiu não é fila vazia porque entregou. Este ramo é
  // o que separa as duas — e ele vem depois do atraso de propósito: quando há
  // os dois, o item atrasado ainda anda sozinho e o operador precisa saber
  // primeiro se a fila está de pé.
  if (perdidos > 0) {
    return {
      parado: true,
      frase: `${paradosDeVez(perdidos)}: o teto de tentativas estourou e ninguém tenta `
        + 'de novo sozinho. Quem pagou continua sem. Olhe o último erro e mande de novo '
        + 'pelo painel.',
    }
  }

  // "Andando" é afirmação sobre o trabalhador, e quem não carimba não dá essa
  // garantia. Dizer "andando" de uma fila que só registrou o boot é o tipo de
  // frase confortável que faz o operador fechar a tela sem olhar.
  const nada = s.maduros > 0
    ? `${s.maduros} item(ns) na vez de sair.`
    : 'e sem nada esperando.'

  return {
    parado: false,
    frase: carimba
      ? (s.maduros > 0 ? `Andando: ${nada}` : `Andando, ${nada}`)
      : `Sem nada atrasado — mas esta fila não carimba varredura, então o que dá `
        + `pra afirmar dela é só o que está parado (${s.maduros} na vez de sair).`,
  }
}

/**
 * "1 pedido parou de vez" / "3 pedidos pararam de vez".
 *
 * PEDIDO, e não item de fila: duas tentativas falhas do mesmo comprador são
 * duas linhas e uma pessoa só, e o operador que lê "2" vai procurar dois
 * clientes que não existem.
 */
function paradosDeVez(n: number): string {
  return n === 1 ? '1 pedido parou de vez' : `${n} pedidos pararam de vez`
}

/** "3 min", "2 h 10 min" — tempo pra quem está no guichê, não em milissegundos. */
export function emPortugues(segundos: number): string {
  const s = Math.max(0, Math.round(segundos))
  if (s < 90) return `${s}s`
  const min = Math.round(s / 60)
  if (min < 90) return `${min} min`
  const h = Math.floor(min / 60)
  return `${h}h${min % 60 ? ` ${min % 60} min` : ''}`
}
