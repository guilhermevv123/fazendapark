/**
 * catraca.ts — a trava da porta e o livro de entradas, num lugar só.
 *
 * Este arquivo existe por causa de um teste que mentia. A suíte tinha um
 * "dois leitores no mesmo instante" que ficava VERDE mesmo com a condição da
 * trava arrancada: os dois pedidos eram atendidos em fila pelo servidor, o
 * segundo via o ingresso já `usado` na checagem prévia e devolvia "já entrou"
 * sem nunca chegar no UPDATE. O teste passava pelo caminho fácil e dava a
 * impressão de estar provando a parte difícil.
 *
 * Com a instrução aqui, o teste roda **a mesma linha** que a porta roda, em
 * duas conexões, forçando a ordem à mão. Copiar o SQL pro teste teria o mesmo
 * defeito de sempre: alguém muda a rota e o teste continua provando a versão
 * antiga.
 *
 * Duas camadas, que fazem coisas diferentes e não se substituem:
 *
 *   • a TRAVA (`SQL_MARCA_ENTRADA*`) impede a segunda entrada **quando os dois
 *     leitores falam com o mesmo banco**;
 *   • o LIVRO (`SQL_GRAVA_ENTRADA`) registra a passagem que aconteceu —
 *     inclusive a que a trava não teve como impedir, porque o tablet estava
 *     sem rede. É dele que sai a contagem de gente e o conflito.
 */

/**
 * O `AND status = 'valido'` é a trava inteira. Sem ele, dois leitores que
 * leram o ingresso antes de qualquer um gravar marcam entrada os dois e o
 * mesmo QR passa duas vezes — medido: 20 leitores simultâneos, 10 entraram.
 *
 * DOIS parâmetros, e continua assim: o teste de corrida da suíte chama esta
 * constante com `[ticketId, operador]`. Um `$3` aqui derrubaria aquele teste
 * com "bind message supplies 2 parameters" — por isso a variante com hora
 * explícita é uma constante separada, logo abaixo.
 */
export const SQL_MARCA_ENTRADA = `
  UPDATE tickets
     SET status = 'usado', checked_in_at = now(), checked_in_by = $2
   WHERE id = $1 AND status = 'valido'
   RETURNING id`

/**
 * A mesma trava, com a hora vinda de fora — o caminho da entrada que foi
 * validada offline e só chegou aqui depois.
 *
 * `now()` seria mentira nesse caminho: a pessoa passou às 14h02 e a fila só
 * sincronizou às 18h. Com `now()`, o "que horas ele entrou?" responderia a
 * hora em que a rede voltou, e o gráfico de fila mostraria um pico que nunca
 * existiu. `COALESCE` porque o mesmo SQL serve o caminho online, que não tem
 * hora pra informar.
 */
export const SQL_MARCA_ENTRADA_EM = `
  UPDATE tickets
     SET status = 'usado',
         checked_in_at = COALESCE($3::timestamptz, now()),
         checked_in_by = $2
   WHERE id = $1 AND status = 'valido'
   RETURNING id`

/**
 * Grava a passagem no livro. **Idempotente pelo id que nasceu no dispositivo.**
 *
 * Três coisas que este SQL decide, e que não podem ser decididas em outro
 * lugar:
 *
 * 1. `ON CONFLICT (id) DO NOTHING` — reenviar a fila inteira (rede oscilando,
 *    operador cutucando o botão, aba reaberta) não conta a pessoa duas vezes.
 *    Quem chama sabe o que aconteceu pelo `RETURNING`: linha de volta = entrada
 *    nova; nada = já estava lá.
 *
 * 2. `people` vem de `sectors.admits`, lido aqui — **nunca do número que o
 *    tablet mandou**. Quem conta o público não pode aceitar a contagem de um
 *    dispositivo que passa a noite fora de rede na mão de um terceirizado.
 *
 * 3. O `WHERE t.org_id = $3` é a cerca da organização DENTRO do insert. Um
 *    ingresso de outra produtora simplesmente não produz linha — e quem chama
 *    descobre pelo `RETURNING` vazio, sem precisar de uma consulta antes que
 *    alguém possa esquecer de escrever.
 *
 * $1 id (do dispositivo) · $2 ticketId · $3 orgId · $4 gate · $5 deviceId
 * $6 operatorId · $7 offline · $8 hora da passagem (null = agora)
 */
export const SQL_GRAVA_ENTRADA = `
  INSERT INTO entries (id, org_id, event_id, ticket_id, session_id, people,
                       gate, device_id, operator_id, offline, entered_at)
  SELECT $1, t.org_id, t.event_id, t.id, t.session_id, s.admits,
         $4, $5, $6, $7, COALESCE($8::timestamptz, now())
    FROM tickets t
    JOIN sectors s ON s.id = t.sector_id
   WHERE t.id = $2 AND t.org_id = $3
  ON CONFLICT (id) DO NOTHING
  RETURNING id, people`

/**
 * Quando e ONDE este ingresso passou — a primeira vez.
 *
 * É o que falta na recusa de hoje. "Este ingresso já entrou" com a fila
 * andando e o cliente jurando que não entrou não resolve nada; "entrou às
 * 14h02 pelo portão Norte, liberado pelo João" encerra a discussão em dois
 * segundos. Ordenado por `entered_at` e não por `synced_at`: numa entrada que
 * ficou horas na fila offline, a ordem de chegada no servidor não é a ordem em
 * que as pessoas passaram.
 */
export const SQL_PRIMEIRA_ENTRADA = `
  SELECT e.entered_at, e.gate, e.device_id, e.offline, u.name AS operador
    FROM entries e
    LEFT JOIN users u ON u.id = e.operator_id
   WHERE e.ticket_id = $1
   ORDER BY e.entered_at ASC
   LIMIT 1`

/**
 * Quanta gente está dentro. `sum(people)`, não `count(*)`.
 *
 * Uma mesa de 4 é uma leitura e quatro pessoas (`sectors.admits = 4`). Contar
 * linha lotava o parque com o painel marcando um quarto do que tinha dentro —
 * está escrito assim desde a migração 006 e continuava sem ninguém somando.
 */
export const SQL_PUBLICO = `
  SELECT count(*)::int                                    AS entradas,
         COALESCE(sum(e.people), 0)::int                   AS pessoas,
         count(DISTINCT e.ticket_id)::int                  AS ingressos,
         count(*) FILTER (WHERE e.offline)::int            AS offline,
         max(e.entered_at)                                 AS ultima
    FROM entries e
   WHERE e.event_id = $1`

/**
 * O conflito: o mesmo ingresso com mais de uma passagem.
 *
 * Duas catracas sem rede não se enxergam — as duas têm o ingresso como válido
 * na lista baixada e as duas deixam entrar. Quando a rede volta, as duas linhas
 * chegam (ids diferentes, nascidos em dispositivos diferentes) e o sistema tem
 * que **mostrar** isso. A tentação é a outra: um `UNIQUE (ticket_id)` fazendo a
 * segunda linha sumir na sincronização — aí o parque conta uma pessoa a menos
 * do que tem dentro e ninguém descobre a fraude.
 *
 * `LEFT JOIN users`: operador nulo (entrada retroativa, login apagado) some com
 * JOIN comum, e some justamente a linha mais suspeita.
 *
 * Quando o passaporte de N sessões existir, este HAVING ganha uma cláusula:
 * duas passagens em SESSÕES diferentes de um ingresso com
 * `sectors.sessions_covered > 1` são reentrada legítima, não conflito. Hoje
 * nenhum ingresso volta a `valido` depois de entrar, então toda segunda
 * passagem é conflito de verdade.
 */
export const SQL_CONFLITOS = `
  SELECT t.id                                             AS ticket_id,
         t.code,
         t.holder_name,
         count(*)::int                                    AS passagens,
         COALESCE(sum(e.people), 0)::int                   AS pessoas,
         count(*) FILTER (WHERE e.offline)::int            AS offline,
         count(DISTINCT e.device_id)::int                  AS dispositivos,
         min(e.entered_at)                                 AS primeira,
         max(e.entered_at)                                 AS ultima,
         json_agg(json_build_object(
           'id', e.id, 'em', e.entered_at, 'gate', e.gate,
           'dispositivo', e.device_id, 'offline', e.offline, 'operador', u.name
         ) ORDER BY e.entered_at) AS detalhe
    FROM entries e
    JOIN tickets t ON t.id = e.ticket_id
    LEFT JOIN users u ON u.id = e.operator_id
   WHERE e.event_id = $1
   GROUP BY t.id, t.code, t.holder_name
  HAVING count(*) > 1
   ORDER BY max(e.entered_at) DESC
   LIMIT 200`

/* ------------------------------------------------------------------- fila */

/** Teto de uma remessa. Uma noite inteira sem rede num portão não passa disso,
 *  e o teto impede que um dispositivo com defeito peça um insert de 200 mil. */
export const LIMITE_FILA = 500

export type EntradaDaFila = {
  /** uuid gerado no DISPOSITIVO — é a chave da idempotência */
  id: string
  /** o QR lido (DT1:…) ou o código digitado */
  qr: string
  gate?: string | null
  /** hora da passagem, medida no dispositivo (ISO) */
  em?: string | null
  offline?: boolean
}

/**
 * Tira da remessa o que está repetido DENTRO dela mesma.
 *
 * O banco aguenta: `ON CONFLICT (id) DO NOTHING` já resolve id repetido no
 * mesmo comando. O problema é o RELATO — sem deduplicar aqui, a remessa com o
 * mesmo id duas vezes volta dizendo "1 aplicada, 1 recusada", e "recusada" no
 * relatório da portaria significa "essa pessoa não entrou". Deduplicar antes
 * faz o relato dizer o que de fato aconteceu: uma aplicada, uma repetida.
 *
 * Fica a PRIMEIRA ocorrência: numa fila gravada em ordem de passagem, é a que
 * carrega a hora certa.
 */
export function normalizarFila(fila: EntradaDaFila[]): {
  fila: EntradaDaFila[]
  repetidasNoEnvio: number
} {
  const vistos = new Set<string>()
  const saida: EntradaDaFila[] = []
  let repetidasNoEnvio = 0
  for (const item of fila) {
    if (vistos.has(item.id)) { repetidasNoEnvio++; continue }
    vistos.add(item.id)
    saida.push(item)
  }
  return { fila: saida, repetidasNoEnvio }
}

/** Resultado de cada item da remessa, no vocabulário da portaria. */
export type ResultadoDaFila =
  | 'aplicada'   // entrou agora no livro
  | 'repetida'   // já estava no livro com este id — reenvio, não é pessoa nova
  | 'conflito'   // entrou no livro, mas o ingresso já tinha passado antes
  | 'invalido'   // código que não existe nesta organização
  | 'cancelado'  // ingresso cancelado depois que o tablet baixou a lista

export const MENSAGEM_DA_FILA: Record<ResultadoDaFila, string> = {
  aplicada: 'Entrada registrada',
  repetida: 'Já estava registrada (reenvio da fila)',
  conflito: 'Este ingresso já tinha entrado por outro leitor',
  invalido: 'Código não encontrado neste evento',
  cancelado: 'Ingresso cancelado — entrou mesmo assim, confira na portaria',
}
