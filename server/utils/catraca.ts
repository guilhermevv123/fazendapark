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
import { MOTIVOS, rotuloDoMotivo } from './meia-entrada'

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
 *
 * ## `aptos` mora AQUI, e não na rota que mostra o percentual
 *
 * A tela de validação tinha três números da mesma coisa saindo de dois lugares
 * e discordando na cara do operador: "Pessoas dentro = 2" ao lado de "Já
 * entraram = 0 (de 392 aptos)" e "Comparecimento = 0%". Medido no evento
 * semeado em 21/09: `entries` com 2 linhas, `tickets` com zero `usado`.
 *
 * Os dois lados estavam "certos" contando coisas diferentes: `entries` é o
 * LIVRO (uma linha por passagem, inclusive a retroativa da migração 013, a
 * offline e a do ingresso que já tinha sido cancelado) e `tickets.status` é a
 * TRAVA (um estado por ingresso, que volta atrás em cancelamento e
 * transferência). A trava não é ledger: ela responde "esse QR ainda passa?",
 * não "quanta gente entrou".
 *
 * Então a fonte da verdade do público é o LIVRO, e o denominador vem junto,
 * na mesma consulta, pra ninguém dividir o numerador de um lugar pelo
 * denominador de outro.
 *
 * `aptos` inclui o ingresso cancelado QUE JÁ ENTROU: a pessoa está fisicamente
 * dentro do parque e tirá-la do denominador — mantendo-a no numerador — fazia
 * o comparecimento passar de 100%.
 */
export const SQL_PUBLICO = `
  SELECT count(*)::int                                    AS entradas,
         COALESCE(sum(e.people), 0)::int                   AS pessoas,
         count(DISTINCT e.ticket_id)::int                  AS ingressos,
         count(*) FILTER (WHERE e.offline)::int            AS offline,
         max(e.entered_at)                                 AS ultima,
         (SELECT count(*)::int
            FROM tickets t
           WHERE t.event_id = $1
             AND (t.status <> 'cancelado'
                  OR EXISTS (SELECT 1 FROM entries e2 WHERE e2.ticket_id = t.id)))
                                                           AS aptos
    FROM entries e
   WHERE e.event_id = $1`

export type RetratoDoPublico = {
  /** pessoas dentro — `sum(people)`, uma mesa de 4 conta 4 */
  pessoas: number
  /** passagens de catraca; uma mesa de 4 conta 1 */
  entradas: number
  /** ingressos DISTINTOS que passaram — é este que o comparecimento divide */
  ingressos: number
  /** quantas passagens foram decididas sem rede */
  offline: number
  ultima: string | null
  /** ingressos que podiam entrar (o denominador) */
  aptos: number
  comparecimentoPct: number
}

/**
 * O retrato do público a partir da linha do `SQL_PUBLICO`.
 *
 * Existe como função, e não como três contas espalhadas por tela, porque era
 * assim que os números divergiam: cada superfície dividia o numerador que
 * tinha pelo denominador que achava. Quem mostra público chama isto.
 *
 * O percentual é de INGRESSO, não de pessoa: `aptos` conta ingresso, e dividir
 * `sum(people)` por contagem de ingresso daria mais de 100% em qualquer evento
 * com mesa.
 */
export function retratoDoPublico(linha: any): RetratoDoPublico {
  const pessoas = Number(linha?.pessoas ?? 0)
  const entradas = Number(linha?.entradas ?? 0)
  const ingressos = Number(linha?.ingressos ?? 0)
  const aptos = Number(linha?.aptos ?? 0)
  const bruto = aptos > 0 ? (ingressos / aptos) * 100 : 0
  return {
    pessoas,
    entradas,
    ingressos,
    offline: Number(linha?.offline ?? 0),
    ultima: linha?.ultima ?? null,
    aptos,
    // Uma casa decimal abaixo de 10%. Com 2 ingressos de 442 dentro, o
    // arredondamento pro inteiro escreve "0%" ao lado de "2 entraram" — e
    // dois números da mesma coisa discordando na mesma tela é exatamente o
    // chamado que este arquivo existe pra não gerar. 0,45 vira 0,5.
    comparecimentoPct: bruto > 0 && bruto < 10
      ? Math.round(bruto * 10) / 10
      : Math.round(bruto),
  }
}

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

/* ------------------------------------------------------- meia na portaria */

/**
 * O que a portaria precisa ler quando o ingresso é meia-entrada.
 *
 * Meia sem esta informação é o portão virando discussão: o operador lê "Meia-
 * entrada" no nome do tipo e não sabe QUAL papel pedir — carteira estudantil?
 * laudo? ID Jovem? Ele não tem que saber a lei, tem que ler na tela. Os três
 * campos já estão gravados no ingresso desde a migração 015 (`half_reason`,
 * `half_document`, `half_document_required`) e nenhuma das duas portas — nem o
 * leitor online, nem a lista que desce pro tablet — os pedia no SELECT.
 *
 * `half_document_required` é o texto CONGELADO no momento da compra e tem
 * precedência: a lei muda, e o que vale é o que foi prometido ao comprador.
 * `MOTIVOS` só entra quando o ingresso é velho e nasceu sem o carimbo.
 *
 * ## Por que o `half_reason` NÃO pode ser a chave do bloco
 *
 * Exigir motivo pra mostrar o pedido de documento devolve o operador ao furo
 * original justamente nos ingressos que a migração 015 escreveu pra socorrer.
 * Medido nesta instalação em 21/09, com a consulta já corrigida:
 * `tt.kind = 'meia'` em 25 ingressos, `half_document_required` preenchido em
 * 25, `half_reason` preenchido em **1** — os outros 24 voltavam `meia: null`
 * e a tela mostrava só "Meia-entrada", que é a frase exata do defeito.
 *
 * São dois caminhos inteiros, não uma ponta solta:
 *
 *  • **a meia velha** — vendida antes da 015. Ninguém perguntou o motivo e
 *    nunca vai ter um; o passo 5 daquela migração carimbou nela o texto
 *    "documento que comprove o direito (carteira de estudante, 60+, PCD…)"
 *    exatamente pra portaria não ficar cega. Jogar esse texto fora na borda
 *    da consulta desfaz a migração.
 *  • **a meia do balcão** — `pdv/venda.post.ts` não pergunta o motivo (o
 *    gatilho da 015 só derruba a venda ONLINE sem motivo), então ingresso de
 *    meia sem `half_reason` continua nascendo hoje.
 *
 * Então a pergunta que abre o bloco é "este ingresso é meia?", e ela tem três
 * respostas boas: o motivo declarado, o texto congelado, ou a espécie do tipo
 * (`ticket_types.kind`, coluna gerada em db/015). Sem motivo o bloco diz que
 * não sabe — o operador lê "motivo não declarado" e pede o documento genérico,
 * que é MUITO melhor que não ver nada e adivinhar.
 */
export type MeiaDoIngresso = {
  /** o motivo declarado na compra; `null` na meia velha e na do balcão */
  motivo: string | null
  /** "Estudante", "Idoso (60 anos ou mais)"… — o que o operador lê primeiro */
  rotulo: string
  /** QUAL papel pedir, em uma frase */
  documento: string
  /** número da credencial declarado na compra (CIE, ID Jovem); null quando não há */
  numero: string | null
}

/** O que a portaria lê quando o ingresso é meia e ninguém declarou o motivo. */
export const MEIA_SEM_MOTIVO = 'motivo não declarado na compra'
/** …e qual papel pedir nesse caso. */
export const DOCUMENTO_GENERICO =
  'Documento que comprove o direito à meia-entrada — confira com o supervisor.'

export function meiaDoIngresso(t: any): MeiaDoIngresso | null {
  const motivo = t?.half_reason ?? null
  const congelado = t?.half_document_required ?? null
  // `especie` é `ticket_types.kind` (db/015): quem trouxer a coluna ganha o
  // bloco mesmo no ingresso de balcão, que nasce sem motivo E sem texto.
  const ehMeia = motivo != null || congelado != null || t?.especie === 'meia'
  if (!ehMeia) return null
  return {
    motivo,
    rotulo: motivo ? rotuloDoMotivo(motivo) : MEIA_SEM_MOTIVO,
    documento: congelado
      ?? (motivo ? MOTIVOS[motivo]?.documento : null)
      // Motivo fora da lista é dado velho ou vindo de fora: dizer "documento
      // que comprove" é pior que mandar o operador conferir com o supervisor.
      ?? DOCUMENTO_GENERICO,
    numero: t?.half_document ?? null,
  }
}

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

/* ------------------------------------------------- o relógio do dispositivo */

/**
 * O relógio do tablet não é fonte confiável, e o livro guarda DUAS horas
 * diferentes justamente por isso:
 *
 *   `entries.entered_at` — quando a PESSOA passou, medido no aparelho;
 *   `entries.synced_at`  — quando a linha chegou aqui, medido no servidor.
 *
 * A distância entre as duas é o tamanho do apagão de rede. Só que até aqui o
 * `entered_at` era o que o aparelho dissesse, sem cerca nenhuma: o campo era
 * só `z.string().datetime({ offset: true })` e ia direto pro livro E pro
 * `tickets.checked_in_at`. Medido nesta instalação, com a rota de hoje: um
 * tablet mandando `1970-01-01T03:00:00Z` e outro mandando `2035-06-01T12:00Z`
 * gravaram os dois, `ultima` do evento virou **2035**, e o gráfico de fila por
 * hora — que é o que dimensiona quantos portões abrir no ano que vem — ficou
 * com dois pontos a 65 anos de distância do evento, pra sempre.
 *
 * Um tablet barato que perdeu o NTP durante o apagão é o caso comum, não o
 * exótico. A cerca abaixo é a resposta, e ela **não descarta a passagem**:
 * descartar apagaria uma pessoa que está fisicamente dentro do parque, que é o
 * erro mais caro que esta parte do sistema sabe cometer. O que é recusado é o
 * INSTANTE — a passagem entra com a hora do SERVIDOR, e a divergência volta
 * marcada na resposta pra portaria saber qual aparelho conferir.
 */

/** Quanto o relógio do aparelho pode adiantar em relação ao do servidor. */
export const TOLERANCIA_RELOGIO_MS = 10 * 60_000
/** Portão abre cedo: passagem antes do início do evento é normal até aqui. */
export const FOLGA_ANTES_MS = 12 * 3_600_000
/** E gente ainda entra depois do horário de término. */
export const FOLGA_DEPOIS_MS = 12 * 3_600_000

export type MotivoDeRelogioTorto =
  /** a hora enviada não é uma data que dê pra ler */
  | 'formato'
  /** o aparelho marcou uma passagem no futuro além da tolerância */
  | 'futuro'
  /** a hora está fora da janela do evento e longe de agora */
  | 'fora_do_evento'

export type Relogio = {
  /**
   * O instante que VAI para o livro. `null` = use o do servidor (`now()`),
   * que é exatamente o que o `COALESCE($8::timestamptz, now())` do
   * `SQL_GRAVA_ENTRADA` faz.
   */
  em: string | null
  /** o que o aparelho mandou, quando foi recusado (pra mostrar na tela) */
  enviado: string | null
  torto: boolean
  motivo: MotivoDeRelogioTorto | null
  /** de quanto o relógio do aparelho está errado, em minutos (sinal = adiantado) */
  desvioMin: number
}

const RELOGIO_OK: Relogio = { em: null, enviado: null, torto: false, motivo: null, desvioMin: 0 }

export const MENSAGEM_DE_RELOGIO: Record<MotivoDeRelogioTorto, string> = {
  formato: 'a hora enviada por este aparelho não pôde ser lida',
  futuro: 'este aparelho marcou a passagem no futuro',
  fora_do_evento: 'este aparelho marcou a passagem fora do período do evento',
}

/**
 * Confere a hora que o aparelho mandou contra a janela do evento.
 *
 * Aceita quando o instante está **dentro do evento** (com folga dos dois
 * lados) **ou perto de agora** — as duas portas são necessárias:
 *
 *  • só a janela do evento recusaria a passagem legítima de um teste de portão
 *    feito semanas antes da abertura, e marcaria como "relógio torto" um
 *    aparelho certíssimo;
 *  • só o "perto de agora" recusaria a fila que ficou a noite inteira offline
 *    e só subiu de manhã — que é o caso pra que esta rota existe.
 *
 * O futuro é barrado nas duas: nenhuma passagem acontece depois de agora, e a
 * tolerância existe só pra absorver a diferença de relógio de minutos.
 */
export function conferirRelogio(
  em: string | null | undefined,
  evento: { starts_at?: Date | string | null; ends_at?: Date | string | null } | null,
  agora: Date = new Date(),
): Relogio {
  // Sem hora é o caminho normal do leitor online: o servidor carimba.
  if (em == null || em === '') return RELOGIO_OK

  const t = new Date(em).getTime()
  const n = agora.getTime()
  const desvioMin = Math.round((t - n) / 60_000)
  const recusa = (motivo: MotivoDeRelogioTorto): Relogio =>
    ({ em: null, enviado: em, torto: true, motivo, desvioMin: Number.isFinite(t) ? desvioMin : 0 })

  if (!Number.isFinite(t)) return recusa('formato')
  if (t > n + TOLERANCIA_RELOGIO_MS) return recusa('futuro')

  if (Math.abs(t - n) <= TOLERANCIA_RELOGIO_MS) return { ...RELOGIO_OK, em }

  const inicio = evento?.starts_at ? new Date(evento.starts_at).getTime() : NaN
  // Evento sem horário de início não tem janela pra conferir: sobra o "perto
  // de agora" acima, e passar daqui sem janela seria inventar uma.
  if (!Number.isFinite(inicio)) return recusa('fora_do_evento')

  const fimBruto = evento?.ends_at ? new Date(evento.ends_at).getTime() : NaN
  const fim = Number.isFinite(fimBruto) ? fimBruto : inicio

  if (t < inicio - FOLGA_ANTES_MS) return recusa('fora_do_evento')
  if (t > fim + FOLGA_DEPOIS_MS) return recusa('fora_do_evento')
  return { ...RELOGIO_OK, em }
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
