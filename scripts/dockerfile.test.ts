/**
 * PROD-10 · a imagem de produção: não roda como root, e tem HEALTHCHECK de
 * VIDA — não de prontidão.
 *
 * O segundo ponto é o perigoso. `/api/saude` responde 503 quando falta
 * configuração ou a fila de e-mail parou — é o que o monitor externo precisa
 * ver. Um HEALTHCHECK que tratasse o 503 como "morto" faria o orquestrador
 * matar e subir o contêiner em laço por causa de um SMTP faltando: o site
 * inteiro fora do ar por um aviso. Por isso o comando do HEALTHCHECK é
 * executado aqui de verdade, contra três servidores de mentira: 200, 503 e
 * nenhum.
 *
 * Sem Docker: lê o Dockerfile e roda o próprio comando dele com o Node.
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, describe, expect, it } from 'vitest'

const DOCKERFILE = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8')
const final = DOCKERFILE.slice(DOCKERFILE.lastIndexOf('\nFROM '))

/** O script do `CMD node -e "..."` do HEALTHCHECK, como o Docker vai rodar. */
function scriptDoHealthcheck(): string {
  const bloco = final.match(/HEALTHCHECK[^\n]*\\\n\s*CMD node -e "([^"]+)"/)
  if (!bloco) throw new Error('o Dockerfile final não tem HEALTHCHECK com `CMD node -e "..."`')
  return bloco[1]
}

const servidores: Server[] = []
async function servidorQueResponde(status: number): Promise<number> {
  const s = createServer((_req, res) => { res.statusCode = status; res.end('{}') })
  servidores.push(s)
  await new Promise<void>((ok) => s.listen(0, '127.0.0.1', ok))
  return (s.address() as AddressInfo).port
}
afterAll(() => { for (const s of servidores) s.close() })

async function rodar(porta: number): Promise<number | null> {
  // assíncrono de propósito: o servidor de mentira vive NESTE processo, e um
  // spawnSync travaria o laço de eventos que responde a ele
  return new Promise((ok) => {
    const p = spawn(process.execPath, ['-e', scriptDoHealthcheck()], { env: { ...process.env, PORT: String(porta) } })
    p.on('exit', (code) => ok(code))
  })
}

describe('PROD-10 · a imagem de produção', () => {
  it('o servidor roda como usuário comum (USER node antes do CMD)', () => {
    // trava: a linha `USER node` na etapa final
    const usuario = final.match(/^USER\s+(\S+)/m)?.[1]
    expect(usuario, 'o contêiner roda como root').toBeTruthy()
    expect(usuario).not.toBe('root')
    expect(final.indexOf('USER ')).toBeLessThan(final.indexOf('\nCMD '))
  })

  it('HEALTHCHECK de vida: 200 e 503 são "vivo"; sem resposta é "morto"', async () => {
    // trava: o `.then(()=>process.exit(0), ...)` — com `r.ok` o 503 viraria laço de reinício
    expect(await rodar(await servidorQueResponde(200))).toBe(0)
    expect(await rodar(await servidorQueResponde(503)),
      'um 503 de configuração faltando mataria o contêiner em laço').toBe(0)
    const fechada = await servidorQueResponde(200)
    servidores.pop()!.close()
    await new Promise((r) => setTimeout(r, 50))
    expect(await rodar(fechada), 'servidor fora do ar passou por vivo').toBe(1)
  })

  it('o HEALTHCHECK pergunta a /api/saude, na porta do PORT', () => {
    expect(scriptDoHealthcheck()).toContain('/api/saude')
    expect(scriptDoHealthcheck()).toContain('process.env.PORT')
  })
})
