// Carrega .env antes de qualquer teste tocar no banco.
import { readFileSync } from 'node:fs'
try {
  for (const linha of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
    const m = linha.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
  }
} catch { /* sem .env: o teste que precisar vai falhar dizendo o porquê */ }
