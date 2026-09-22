/**
 * dev-teste.mjs — sobe o `nuxt dev` na porta 3101, com o `.env.test` por cima
 * do `.env` (mesma regra de scripts/test-setup.ts). Existe só porque o Nuxt
 * sozinho carrega `.env`, não `.env.test` — sem isto, "npm run dev:teste"
 * teria que hardcodar a connection string do banco de teste no
 * package.json, presa ao usuário deste Mac.
 *
 *   npm run dev:teste
 */
import { readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'

function carregar(arquivo, sobrescrever) {
  try {
    for (const linha of readFileSync(new URL(`../${arquivo}`, import.meta.url), 'utf8').split('\n')) {
      const m = linha.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
      if (m && (sobrescrever || !process.env[m[1]])) process.env[m[1]] = m[2]
    }
  } catch { /* arquivo ausente: nuxt dev acusa se faltar DATABASE_URL */ }
}
carregar('.env', false)
carregar('.env.test', true)

const filho = spawn('npx', ['nuxt', 'dev', '--port', '3101'], { stdio: 'inherit', env: process.env })
filho.on('exit', (codigo) => process.exit(codigo ?? 0))
