/**
 * dev-e2e.mjs — sobe o `nuxt dev` da AUDITORIA/E2E: `.env` e, por cima, `.env.e2e`.
 *
 * Terceira instância, separada das outras duas de propósito:
 *   3100  `npm run dev`        banco `diamond_tickets`       (o painel real, local)
 *   3101  `npm run dev:teste`  banco `diamond_tickets_test`  (a suíte vitest)
 *   3120  `npm run dev:e2e`    banco `diamond_tickets_e2e`   (Playwright + teste na mão)
 * O E2E cria evento, compra, cancela e estorna — rodar isso no banco da suíte faz as asserções de
 * contagem dela darem vermelho que não é defeito, e no real suja o que o dono vê.
 *
 *   npm run e2e:banco   → recria o banco do zero (só aceita nome *_e2e*)
 *   npm run dev:e2e     → este servidor (porta E2E_PORTA, padrão 3120)
 *   npm run e2e         → a bateria do Playwright contra ele
 */
import { readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'

// `--env <arquivo>` e `--porta <n>`: mais de uma instância de E2E ao mesmo tempo (cada frota com o
// seu banco `*_e2e_<nome>` e a sua porta), sem uma recompilar ou apagar o banco da outra.
const args = process.argv.slice(2)
const opcao = (nome) => { const i = args.indexOf(`--${nome}`); return i >= 0 ? args[i + 1] : undefined }
if (opcao('env')) process.env.E2E_ENV_ARQUIVO = opcao('env')
if (opcao('porta')) process.env.E2E_PORTA = opcao('porta')

function carregar(arquivo, sobrescrever) {
  try {
    for (const linha of readFileSync(new URL(`../${arquivo}`, import.meta.url), 'utf8').split('\n')) {
      const m = linha.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
      if (m && (sobrescrever || !process.env[m[1]])) process.env[m[1]] = m[2]
    }
  } catch { /* arquivo ausente: a trava abaixo acusa */ }
}
carregar('.env', false)
carregar(process.env.E2E_ENV_ARQUIVO ?? '.env.e2e', true)

const banco = String(process.env.DATABASE_URL ?? '').split('/').pop()?.split('?')[0] ?? ''
if (!/_e2e(_[a-z0-9]+)?$/.test(banco)) {
  console.error(`dev-e2e: DATABASE_URL aponta pra "${banco}" — o servidor de E2E só sobe num banco *_e2e (confira o .env.e2e)`)
  process.exit(9)
}
const porta = process.env.E2E_PORTA ?? '3120'
// pasta de compilação própria: dividir `.nuxt/` com o 3100 e o 3101 faz os três recompilarem juntos
process.env.NUXT_PASTA_BUILD ??= `.nuxt-e2e-${porta}`
// endereço fixo em IPv4: com `localhost`, o Node desta máquina passou a abrir só no [::1] (28/09) e
// quem esperava em 127.0.0.1 — a bateria do Playwright, que só aceita máquina local — ficava parado
const filho = spawn('npx', ['nuxt', 'dev', '--host', '127.0.0.1', '--port', porta], { stdio: 'inherit', env: process.env })
filho.on('exit', (codigo) => process.exit(codigo ?? 0))
