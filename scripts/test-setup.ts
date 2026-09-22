/**
 * test-setup.ts — o que toda corrida da suíte precisa antes do primeiro caso.
 *
 * Quatro coisas, e as três últimas são trava, não conveniência:
 *
 *  1. **o `.env`, depois o `.env.test` por cima** — pra quem fala com o banco
 *     falar com o banco de TESTE, nunca com o que o painel real usa. O real
 *     (`diamond_tickets`) já teve 939 pedido falso empilhado por rodada de
 *     suíte antes desta separação existir — `.env.test` aponta pro banco
 *     `diamond_tickets_test`, que só a suíte toca (ver `dev:teste` no
 *     `package.json`, que sobe o servidor DESTE banco na porta que
 *     `BASE_DE_TESTE` usa por padrão);
 *
 *  2. **a sonda do servidor de dev e o pulo honesto.** A convenção antiga era
 *     `if (!noAr) return void console.warn('(pulado)')` dentro do `it()`. O
 *     vitest conta isso como **PASSOU** — tique verde, somado ao total. Medido:
 *     com `BASE_TESTE` apontando pra porta morta, quatro arquivos desta suíte
 *     imprimiram `Tests 61 passed (61)` sem ter feito uma única requisição.
 *     Numa corrida de MUTAÇÃO isso é o pior resultado possível: a invariante
 *     acabou de ser arrancada e a suíte responde verde. `ctx.skip()` sai
 *     contado como pulado, que é o que se lê de longe. A convenção velha
 *     sobrevive em quinze arquivos de outras trilhas, e por isso o pulo
 *     honesto também é imposto de fora, pelo aviso (ver `AVISO_DE_PULO`);
 *
 *  3. **a marca da corrida**, pra fixtura de id fixo não brigar com a fixtura
 *     da corrida vizinha (ver `uuidDaCorrida`).
 */
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach } from 'vitest'

// ---------------------------------------------------------------- 1. .env
function carregar(arquivo: string, sobrescrever: boolean) {
  try {
    for (const linha of readFileSync(new URL(`../${arquivo}`, import.meta.url), 'utf8').split('\n')) {
      const m = linha.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
      if (m && (sobrescrever || !process.env[m[1]])) process.env[m[1]] = m[2]
    }
  } catch { /* arquivo ausente: o teste que precisar vai falhar dizendo o porquê */ }
}
carregar('.env', false)
// por cima, sobrescrevendo — é o que manda a suíte pro banco de teste em vez
// do banco que o painel real usa (ver o item 1 lá em cima).
carregar('.env.test', true)

// ------------------------------------------------- 2. sonda do servidor
export const BASE_DE_TESTE = process.env.BASE_TESTE ?? 'http://localhost:3101'

/**
 * A PACIÊNCIA — e por que 2500 ms era um defeito, não um número.
 *
 * A checagem antiga era uma tentativa só, com `AbortSignal.timeout(2500)`.
 * Servidor de dev OCUPADO responde 200 em 3 s sem nenhum problema: é o dia a
 * dia com três trilhas batendo no mesmo `nuxt dev`, ou logo depois de um
 * reinício, quando o Nitro ainda está compilando a primeira rota.
 *
 * Reproduzido com um proxy que segurava a PRIMEIRA resposta por 3 s e
 * devolvia 200 (o resto passava direto): `fluxo`, `api/catraca` e
 * `utils/catraca` imprimiram `5 passed`, `12 passed` e `36 passed` — 53 casos
 * dizendo que estavam verdes com o servidor no ar, respondendo, e nenhum deles
 * tendo chegado nele.
 *
 * Três tentativas com prazo crescente: a primeira cobre o caminho normal
 * (medido em menos de 50 ms), e as outras duas separam "ocupado" de "morto".
 * Porta fechada nem chega a esperar — `ECONNREFUSED` volta na hora.
 */
const PACIENCIA = [4000, 10_000, 20_000]

export interface Sonda {
  /** `true` = servidor no ar. (Sim, o nome é "no ar": `noAr` não é negação.) */
  noAr: boolean
  /** A linha que explica o pulo. Vazia quando o servidor respondeu. */
  porque: string
}

/**
 * Bate no servidor de dev com prazo crescente e devolve o veredito COM motivo.
 *
 * O motivo não é enfeite: sem ele o relato só mostra "pulado", e "pulado
 * porque a porta está fechada" e "pulado porque a máquina está afogada" pedem
 * ações opostas de quem está lendo.
 */
export async function sondarServidor(
  rota = '/api/auth/eu',
  base = BASE_DE_TESTE,
): Promise<Sonda> {
  const tentativas: string[] = []
  for (const paciencia of PACIENCIA) {
    try {
      const r = await fetch(base + rota, { signal: AbortSignal.timeout(paciencia) })
      // < 500 porque a pergunta é "tem servidor atendendo?", não "estou logado?".
      if (r.status < 500) return { noAr: true, porque: '' }
      tentativas.push(`${paciencia} ms → HTTP ${r.status}`)
    } catch (e: any) {
      const causa = e?.name === 'TimeoutError'
        ? 'estourou o prazo (servidor ocupado?)'
        : (e?.cause?.code ?? e?.message ?? e?.name ?? 'erro sem nome')
      tentativas.push(`${paciencia} ms → ${causa}`)
      // Porta fechada não melhora esperando mais: não gasta os outros prazos.
      if (e?.cause?.code === 'ECONNREFUSED') {
        return { noAr: false, porque: `${base} recusou conexão — o \`nuxt dev\` da 3100 não está rodando` }
      }
    }
  }
  return {
    noAr: false,
    porque: `${base}${rota} não respondeu em ${PACIENCIA.length} tentativas (${tentativas.join('; ')})`,
  }
}

/**
 * Anuncia o pulo UMA vez por arquivo, no `beforeAll`.
 *
 * Uma linha por arquivo, não uma por caso: trinta e seis `console.warn`
 * iguais viram ruído que ninguém lê, e era justamente nesse ruído que a
 * decisão de não testar nada sumia.
 */
export function anunciarPulo(arquivo: string, sonda: Sonda) {
  if (!sonda.noAr) console.warn(`\n  ⤳ ${arquivo}: PULANDO o arquivo inteiro — ${sonda.porque}\n`)
}

/**
 * Pula o caso de verdade — contado como pulado, nunca como aprovado.
 *
 * Use no primeiro comando do `it(ctx => …)`. É a única forma de saída
 * permitida num caso que depende do servidor: `return` puro devolve ✓.
 */
export function seForaDoArPula(ctx: { skip: (motivo?: string) => void }, sonda: Sonda) {
  if (!sonda.noAr) ctx.skip(sonda.porque)
}

// ------------------------------------ 2b. a trava do pulo velho, sem editar
/**
 * O MESMO PULO HONESTO, imposto de fora, pra quem ainda usa a convenção velha.
 *
 * `seForaDoArPula` conserta o arquivo que foi reescrito. Sobram os outros:
 * **195 casos em 15 arquivos** ainda fazem `return void console.warn('
 * (pulado: servidor fora do ar)')` dentro do `it()`, e isso sai contado como
 * APROVADO. Medido agora, com `BASE_TESTE` numa porta morta:
 *
 *     papeis 55 · relatorios 25 · pdv 14 · isolamento 6
 *     → `Tests 100 passed (100)`, zero requisições feitas.
 *
 * Reescrever os quinze arquivos não é opção enquanto as outras trilhas estão
 * com eles abertos. Mas a convenção deixa uma assinatura boa demais pra
 * ignorar: o aviso SEMPRE começa com `(pulado`. Então o `console.warn` vira o
 * gatilho — quem anuncia que pulou, pula de verdade.
 *
 * `ctx.skip()` é a API oficial: ela levanta o `PendingError` do runner, que
 * aborta o corpo do caso e marca `skip` (não `fail`). É exatamente o que a
 * regra da casa manda — *"se o servidor estiver fora do ar, o teste pula em
 * vez de falhar"* — só que agora o relatório conta o pulo em vez de somar um
 * tique verde.
 *
 * Três cuidados, e os três já custaram tentativa:
 *
 *  - **só dentro de caso.** `beforeAll`/`afterAll` também avisam; levantar o
 *    `PendingError` lá derruba o arquivo inteiro com um erro que não é o
 *    defeito. O par `beforeEach`/`afterEach` marca a janela em que existe um
 *    caso pra pular;
 *  - **só o aviso de pulo.** `(pulado…)` e `(pulada…)` entram; `[Vue warn]`,
 *    `(só o login fabricado: …)` e qualquer outro aviso passam direto — esse
 *    último anuncia caso que vai RODAR meio caminho, e abortá-lo seria trocar
 *    uma mentira por outra;
 *  - **uma vez por processo, e o caso da vez mora no `globalThis`.** O setup é
 *    avaliado uma vez por arquivo de teste. Embrulhar o `console.warn` de novo
 *    a cada arquivo empilharia patch em cima de patch — daí a trava. Mas se o
 *    embrulho fica de fora e a variável do caso fosse de MÓDULO, o embrulho do
 *    primeiro arquivo continuaria lendo a variável do primeiro módulo, que
 *    nunca mais é escrita: a trava morreria calada a partir do segundo
 *    arquivo, que é a pior falha possível pra uma trava contra tique verde
 *    falso. As duas coisas moram no `globalThis`, então qualquer embrulho lê
 *    sempre o caso de agora.
 *
 * Com o servidor no ar nada disso dispara: nenhum caso avisa pulo, e a suíte
 * segue idêntica. Medido nas duas pontas, suíte inteira, com os 773 casos que
 * existiam na hora da medição:
 *
 *     servidor no ar      → 773 passed (773)        — antes e depois
 *     porta morta, antes  → 684 passed |  89 skipped
 *     porta morta, depois → 413 passed | 360 skipped
 *
 * São **271 tiques verdes** que não tinham feito requisição nenhuma.
 */
const AVISO_DE_PULO = /^\s*\(pulad[oa]\b/
const JA_EMBRULHADO = Symbol.for('diamond-tickets.pulo-honesto')
const CASO_DA_VEZ = Symbol.for('diamond-tickets.caso-da-vez')

type CasoPulavel = { skip: (motivo?: string) => void } | null

beforeEach((ctx) => { (globalThis as any)[CASO_DA_VEZ] = ctx })
afterEach(() => { (globalThis as any)[CASO_DA_VEZ] = null })

if (!(globalThis as any)[JA_EMBRULHADO]) {
  ;(globalThis as any)[JA_EMBRULHADO] = true
  const avisoOriginal = console.warn.bind(console)
  console.warn = (...args: unknown[]) => {
    avisoOriginal(...args)
    const texto = typeof args[0] === 'string' ? args[0] : ''
    const caso = (globalThis as any)[CASO_DA_VEZ] as CasoPulavel
    if (caso && AVISO_DE_PULO.test(texto)) {
      // o caso já vai abortar aqui; zerar impede que um segundo aviso do
      // mesmo caso (ou do gancho seguinte) levante o pulo de novo
      ;(globalThis as any)[CASO_DA_VEZ] = null
      caso.skip(texto.trim())
    }
  }
}

// --------------------------------------------- 3. a marca desta corrida
/**
 * Doze hexadecimais que identificam ESTA corrida: relógio + pid.
 *
 * Fixtura de id fixo não sobrevive a duas corridas no mesmo banco — que é o
 * dia a dia aqui, com várias trilhas rodando `npx vitest run` ao mesmo tempo.
 * Medido com dois `npx vitest run server/api/catraca.test.ts` simultâneos:
 *
 *   corrida A: insert or update on table "tickets" violates foreign key
 *              constraint "tickets_org_id_fkey"        ← o `afterAll` da
 *              vizinha apagou a organização no meio do `beforeAll` desta
 *   corrida B: duplicate key value violates unique constraint
 *              "organizations_slug_key"                ← o slug também é fixo
 *
 * As duas terminaram `Test Files 1 failed` / `Tests 12 skipped (12)` — e
 * repare que **falha de `beforeAll` aparece como "skipped"**, não como
 * "failed": é daí que vêm os relatos de "N skipped" com o servidor no ar.
 */
export const MARCA_DA_CORRIDA =
  (Date.now().toString(16).slice(-8) + process.pid.toString(16).padStart(4, '0')).slice(-12)

/** oito hexadecimais estáveis a partir de um texto (não é segurança, é rótulo) */
function digerir(texto: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < texto.length; i++) {
    h ^= texto.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/**
 * uuid de fixtura desta corrida, deste arquivo, desta linha.
 *
 *   `${escopo}`-`${n}`-4000-8000-`${marca da corrida}`
 *
 * O `escopo` separa arquivo de arquivo (duas suítes carregadas no mesmo
 * processo têm a MESMA marca), o `n` separa as fixturas dentro do arquivo, e
 * a marca separa corrida de corrida. Some qualquer uma das três e volta a
 * briga de cima.
 */
export function uuidDaCorrida(escopo: string, n: number): string {
  return `${digerir(escopo)}-${n.toString(16).padStart(4, '0')}-4000-8000-${MARCA_DA_CORRIDA}`
}

/**
 * A marca em maiúsculas, pra código de ingresso e slug.
 *
 * O QR é conferido contra `/^DT1:[0-9a-f-]{36}:[A-Z0-9-]+:[A-Z0-9]{10}$/`: o
 * `code` só aceita maiúscula, número e traço.
 */
export const MARCA_MAIUSCULA = MARCA_DA_CORRIDA.toUpperCase()
