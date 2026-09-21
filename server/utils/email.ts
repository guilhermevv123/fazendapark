/**
 * email.ts — monta o e-mail e entrega. Só isso.
 *
 * A fila (quem manda, quando, e o que fazer quando falha) é a vizinha
 * `envio.ts`. A separação importa: aqui dentro nada sabe de banco, então dá
 * pra provar o corpo do e-mail e a conversa de SMTP sem subir uma fila.
 *
 * ## O QR vai ANEXADO, não linkado
 *
 * A saída preguiçosa seria `<img src="https://.../qr.png">`. Gmail, Outlook e
 * Apple Mail bloqueiam imagem remota por padrão: o comprador abre o e-mail na
 * fila do estacionamento, vê um retângulo vazio onde devia estar o ingresso e
 * liga pra bilheteria. Anexo `cid:` aparece sem pedir permissão e continua
 * aparecendo depois, com o celular sem sinal — que é exatamente a hora em que
 * ele precisa do QR.
 *
 * ## Sem credencial de SMTP, o envio é SIMULADO — e diz isso
 *
 * Enquanto não existe servidor de e-mail configurado, o transporte padrão
 * grava o .eml em disco e marca a linha como `simulado`. Isso é diferente de
 * "enviado" de propósito: quem atende o cliente precisa saber que aquele
 * e-mail nunca saiu da máquina. Pra ligar o envio de verdade não se mexe em
 * código nenhum — basta `SMTP_URL` no ambiente:
 *
 *     SMTP_URL=smtp://usuario:senha@smtp.provedor.com:587
 *     EMAIL_REMETENTE="Fazenda Park <ingressos@fazendapark.com.br>"
 */
import { createHmac, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import net from 'node:net'
import tls from 'node:tls'

export interface ImagemEmbutida {
  cid: string
  nome: string
  conteudo: Buffer
  tipo: string
}

export interface Mensagem {
  de: string
  para: string
  paraNome?: string | null
  assunto: string
  texto: string
  html: string
  imagens?: ImagemEmbutida[]
  messageId?: string
}

export interface Entrega {
  via: 'simulado' | 'smtp'
  messageId: string
  arquivo?: string
}

/* ------------------------------------------------------------ remetente */

export function remetente(): string {
  return process.env.EMAIL_REMETENTE || 'Diamond Tickets <nao-responda@diamond-tickets.local>'
}

/** Só o endereço, sem o nome de exibição — é o que o SMTP quer no MAIL FROM. */
export function soEndereco(caixa: string): string {
  const m = String(caixa).match(/<([^>]+)>/)
  return (m ? m[1] : String(caixa)).trim()
}

/**
 * Aceita o que um servidor de e-mail aceitaria, e recusa o resto.
 *
 * Deliberadamente frouxa no meio e dura nas bordas: espaço, vírgula, quebra
 * de linha e endereço sem ponto no domínio são os erros de digitação que o
 * guichê comete, e cada um vira uma falha garantida na fila.
 */
export function enderecoValido(v: any): boolean {
  const s = String(v ?? '').trim()
  if (!s || s.length > 254) return false
  return /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[a-zA-Z]{2,}$/.test(s)
}

/* --------------------------------------------------------- montagem MIME */

const CRLF = '\r\n'

/** Assunto com acento precisa ir codificado, senão chega como "Ã§Ã£o". */
export function assuntoCodificado(assunto: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7E]*$/.test(assunto)) return assunto
  return `=?UTF-8?B?${Buffer.from(assunto, 'utf8').toString('base64')}?=`
}

function base64Quebrado(b: Buffer): string {
  return (b.toString('base64').match(/.{1,76}/g) ?? []).join(CRLF)
}

function fronteira(prefixo: string): string {
  return `=_${prefixo}_${randomUUID().replace(/-/g, '')}`
}

/**
 * Corpo completo em RFC 5322. É o que vai pro `DATA` do SMTP e o que é
 * gravado como .eml — os dois EXATAMENTE iguais, pra que abrir o arquivo
 * simulado mostre o que o servidor receberia.
 */
export function montarMime(m: Mensagem): { bruto: string; messageId: string } {
  const messageId = m.messageId ?? `<${randomUUID()}@diamond-tickets>`
  const imagens = m.imagens ?? []
  const alt = fronteira('alt')
  const rel = fronteira('rel')

  const cabecalho = [
    `From: ${m.de}`,
    `To: ${m.paraNome ? `${nomeCodificado(m.paraNome)} <${m.para}>` : m.para}`,
    `Subject: ${assuntoCodificado(m.assunto)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: ${messageId}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/related; boundary="${rel}"`,
  ].join(CRLF)

  const partes: string[] = []
  partes.push(`--${rel}`)
  partes.push(`Content-Type: multipart/alternative; boundary="${alt}"`, '')

  partes.push(`--${alt}`)
  partes.push('Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '')
  partes.push(base64Quebrado(Buffer.from(m.texto, 'utf8')), '')

  partes.push(`--${alt}`)
  partes.push('Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '')
  partes.push(base64Quebrado(Buffer.from(m.html, 'utf8')), '')
  partes.push(`--${alt}--`, '')

  for (const img of imagens) {
    partes.push(`--${rel}`)
    partes.push(
      `Content-Type: ${img.tipo}; name="${img.nome}"`,
      'Content-Transfer-Encoding: base64',
      `Content-ID: <${img.cid}>`,
      `Content-Disposition: inline; filename="${img.nome}"`, '')
    partes.push(base64Quebrado(img.conteudo), '')
  }
  partes.push(`--${rel}--`, '')

  return { bruto: cabecalho + CRLF + CRLF + partes.join(CRLF), messageId }
}

function nomeCodificado(nome: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7E]*$/.test(nome)) return `"${nome.replace(/"/g, '')}"`
  return `=?UTF-8?B?${Buffer.from(nome, 'utf8').toString('base64')}?=`
}

/* ------------------------------------------------------------ transporte */

export type Transporte = (m: Mensagem) => Promise<Entrega>

/**
 * Qual transporte está valendo AGORA. Lê o ambiente a cada chamada de
 * propósito: o teste troca a variável entre casos, e um valor congelado na
 * carga do módulo faria o segundo caso mentir.
 */
export function transporteEscolhido(): 'simulado' | 'smtp' {
  const forcado = process.env.EMAIL_TRANSPORTE
  if (forcado === 'simulado' || forcado === 'smtp') return forcado
  return process.env.SMTP_URL ? 'smtp' : 'simulado'
}

/** Onde o modo simulado grava o .eml. Fora do repositório, de propósito. */
export function pastaSimulada(): string {
  return process.env.EMAIL_PASTA_SIMULADO || join(tmpdir(), 'diamond-tickets-envios')
}

/**
 * Transporte simulado: grava e devolve o caminho. Não finge sucesso de rede,
 * não tenta adivinhar servidor — escreve o mesmo byte que o SMTP mandaria.
 */
export async function entregarSimulado(m: Mensagem): Promise<Entrega> {
  const { bruto, messageId } = montarMime(m)
  const pasta = pastaSimulada()
  await mkdir(pasta, { recursive: true })
  const nome = `${new Date().toISOString().replace(/[:.]/g, '-')}-${
    m.para.replace(/[^a-zA-Z0-9]/g, '_')}-${messageId.slice(1, 9)}.eml`
  const caminho = join(pasta, nome)
  await writeFile(caminho, bruto, 'utf8')
  return { via: 'simulado', messageId, arquivo: caminho }
}

/* ----------------------------------------------------------------- SMTP */

interface Conversa {
  escrever(linha: string): void
  ler(): Promise<{ codigo: number; texto: string }>
  trocarPorTls(host: string): Promise<void>
  fim(): void
}

/**
 * Cliente de SMTP mínimo — sem dependência nova, porque acrescentar pacote
 * num projeto que move dinheiro é decisão de quem manda, não de quem
 * implementa o e-mail.
 *
 * Fala o suficiente pra um provedor de verdade: EHLO, STARTTLS quando a porta
 * é 587, AUTH PLAIN/LOGIN quando a URL traz usuário, e DATA.
 *
 * O "dot stuffing" abaixo (linha que começa com ponto vai duplicada, senão
 * encerra a mensagem no meio e o ingresso chega cortado) hoje não chega a ser
 * exercitado — o corpo inteiro sai em base64, e base64 não tem ponto. Fica
 * porque o dia em que alguém trocar a codificação por quoted-printable ele
 * passa a ser a diferença entre o e-mail inteiro e um pedaço dele.
 */
export async function entregarPorSmtp(m: Mensagem, urlBruta?: string): Promise<Entrega> {
  const url = new URL(urlBruta ?? process.env.SMTP_URL ?? '')
  const seguroDireto = url.protocol === 'smtps:'
  const porta = Number(url.port || (seguroDireto ? 465 : 587))
  const host = url.hostname
  const usuario = decodeURIComponent(url.username || '')
  const senha = decodeURIComponent(url.password || '')
  const prazo = Number(process.env.SMTP_TIMEOUT_MS || 20_000)

  const { bruto, messageId } = montarMime(m)
  const conversa = await abrirConversa(host, porta, seguroDireto, prazo)

  try {
    await esperar(conversa, 220)
    let capacidades = await ehlo(conversa)

    if (!seguroDireto && /STARTTLS/i.test(capacidades)) {
      conversa.escrever('STARTTLS')
      await esperar(conversa, 220)
      await conversa.trocarPorTls(host)
      capacidades = await ehlo(conversa)
    }

    if (usuario) {
      if (/AUTH[^\r\n]*LOGIN/i.test(capacidades) && !/AUTH[^\r\n]*PLAIN/i.test(capacidades)) {
        conversa.escrever('AUTH LOGIN')
        await esperar(conversa, 334)
        conversa.escrever(Buffer.from(usuario, 'utf8').toString('base64'))
        await esperar(conversa, 334)
        conversa.escrever(Buffer.from(senha, 'utf8').toString('base64'))
        await esperar(conversa, 235)
      } else {
        const credencial = Buffer.from(`\0${usuario}\0${senha}`, 'utf8').toString('base64')
        conversa.escrever(`AUTH PLAIN ${credencial}`)
        await esperar(conversa, 235)
      }
    }

    conversa.escrever(`MAIL FROM:<${soEndereco(m.de)}>`)
    await esperar(conversa, 250)
    conversa.escrever(`RCPT TO:<${soEndereco(m.para)}>`)
    await esperar(conversa, 250, 251)
    conversa.escrever('DATA')
    await esperar(conversa, 354)

    for (const linha of bruto.split(/\r?\n/)) {
      conversa.escrever(linha.startsWith('.') ? `.${linha}` : linha)
    }
    conversa.escrever('.')
    await esperar(conversa, 250)

    conversa.escrever('QUIT')
    await conversa.ler().catch(() => ({ codigo: 221, texto: '' }))
    return { via: 'smtp', messageId }
  } finally {
    conversa.fim()
  }
}

async function ehlo(c: Conversa): Promise<string> {
  c.escrever(`EHLO ${process.env.SMTP_EHLO || 'diamond-tickets'}`)
  const r = await esperar(c, 250)
  return r.texto
}

async function esperar(c: Conversa, ...aceitos: number[]) {
  const r = await c.ler()
  if (!aceitos.includes(r.codigo)) {
    // Mensagem pra humano: o código sozinho ("550") não diz nada a quem
    // atende o cliente; o texto do servidor quase sempre diz.
    throw new Error(`o servidor de e-mail respondeu ${r.codigo}: ${r.texto.trim()}`)
  }
  return r
}

function abrirConversa(
  host: string, porta: number, seguro: boolean, prazo: number,
): Promise<Conversa> {
  return new Promise((resolve, reject) => {
    let socket: net.Socket = seguro
      ? tls.connect({ host, port: porta, servername: host })
      : net.connect({ host, port: porta })

    let buffer = ''
    let pendente: ((r: { codigo: number; texto: string }) => void) | null = null
    let erroPendente: ((e: Error) => void) | null = null
    let fatal: Error | null = null

    const consumir = () => {
      if (!pendente) return
      // Resposta multilinha: "250-CAPACIDADE" repete até "250 " com espaço.
      const m = buffer.match(/^(?:\d{3}-[^\n]*\n)*(\d{3}) [^\n]*\n/)
      if (!m) return
      const texto = buffer.slice(0, m[0].length)
      buffer = buffer.slice(m[0].length)
      const resolver = pendente
      pendente = null
      erroPendente = null
      resolver({ codigo: Number(m[1]), texto })
    }

    const ligar = (s: net.Socket) => {
      s.setEncoding('utf8')
      s.setTimeout(prazo)
      s.on('data', (d: any) => { buffer += String(d); consumir() })
      s.on('timeout', () => derrubar(new Error(`o servidor de e-mail não respondeu em ${prazo} ms`)))
      s.on('error', (e) => derrubar(e as Error))
      s.on('close', () => derrubar(new Error('o servidor de e-mail encerrou a conexão')))
    }

    const derrubar = (e: Error) => {
      fatal = fatal ?? e
      const falhar = erroPendente
      pendente = null
      erroPendente = null
      if (falhar) falhar(fatal)
      else reject(fatal)
      try { socket.destroy() } catch { /* já morreu */ }
    }

    const conversa: Conversa = {
      escrever: (linha) => { socket.write(linha + CRLF) },
      ler: () => new Promise((res, rej) => {
        if (fatal) return rej(fatal)
        pendente = res
        erroPendente = rej
        consumir()
      }),
      trocarPorTls: (nome) => new Promise((res, rej) => {
        const cru = socket
        cru.removeAllListeners('data')
        cru.removeAllListeners('close')
        cru.removeAllListeners('error')
        cru.removeAllListeners('timeout')
        const seguroSocket = tls.connect(
          { socket: cru, servername: nome, rejectUnauthorized: process.env.SMTP_TLS_FROUXO !== '1' },
          () => { socket = seguroSocket; buffer = ''; ligar(seguroSocket); res() })
        seguroSocket.once('error', rej)
      }),
      fim: () => { try { socket.destroy() } catch { /* já morreu */ } },
    }

    socket.once(seguro ? 'secureConnect' : 'connect', () => { ligar(socket); resolve(conversa) })
    socket.once('error', reject)
  })
}

/* ------------------------------------------------------------- fachada */

/**
 * Entrega pelo transporte do ambiente. É o único ponto que decide entre
 * simular e mandar de verdade — quem chama não precisa saber, e não existe
 * um segundo caminho que possa divergir deste.
 */
export async function entregar(m: Mensagem): Promise<Entrega> {
  return transporteEscolhido() === 'smtp' ? entregarPorSmtp(m) : entregarSimulado(m)
}

/* ------------------------------------------- e-mail de confirmação */

export interface IngressoNoEmail {
  id: string
  codigo: string
  setor?: string | null
  lote?: string | null
  tipo?: string | null
  sessao?: string | null
  titular?: string | null
  qrPng?: Buffer | null
}

export interface DadosConfirmacao {
  pedido: string
  compradorNome?: string | null
  compradorEmail: string
  eventoNome: string
  eventoInicio?: Date | string | null
  local?: string | null
  totalCents: number
  ingressos: IngressoNoEmail[]
  linkIngressos: string
  substantivo?: string | null
}

const reais = (c: number) =>
  (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })

/**
 * Data no fuso do parque. `toISOString()` cortaria em UTC e, às 21h de
 * Brasília, o ingresso de hoje chegaria marcado com a data de amanhã.
 */
export function quando(d: Date | string | null | undefined): string {
  if (!d) return ''
  return new Date(d).toLocaleString('pt-BR', {
    timeZone: process.env.TZ_EVENTO || 'America/Bahia',
    day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

const escapar = (v: any) => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * O e-mail que o comprador recebe. HTML de e-mail é feito de tabela e estilo
 * embutido porque cliente de e-mail ignora folha de estilo e quebra flexbox —
 * o que é feio aqui é o que abre igual no Gmail e no Outlook velho.
 */
export function montarConfirmacao(d: DadosConfirmacao): Mensagem {
  const imagens: ImagemEmbutida[] = []
  const substantivo = d.substantivo || 'Ingressos'
  const assunto = `${substantivo} confirmados — ${d.eventoNome} (pedido ${d.pedido})`

  const linhasTexto = d.ingressos.map((t, i) => {
    const onde = [t.setor, t.lote, t.tipo].filter(Boolean).join(' · ')
    return `  ${i + 1}. ${t.codigo}${onde ? `  (${onde})` : ''}`
  })

  const texto = [
    `${d.compradorNome ? `${d.compradorNome}, s` : 'S'}eu pagamento foi confirmado.`,
    '',
    d.eventoNome,
    d.eventoInicio ? quando(d.eventoInicio) : '',
    d.local ?? '',
    '',
    `Pedido ${d.pedido} · ${reais(d.totalCents)}`,
    `${d.ingressos.length} ${d.ingressos.length === 1 ? 'ingresso' : 'ingressos'}:`,
    ...linhasTexto,
    '',
    'Abra o link abaixo para ver o QR de cada ingresso:',
    d.linkIngressos,
    '',
    'Na portaria, apresente o QR. Se a leitura falhar, informe o código do ingresso.',
  ].filter((l) => l !== null).join('\n')

  const blocos = d.ingressos.map((t, i) => {
    let qr = ''
    if (t.qrPng) {
      const cid = `qr-${t.codigo.replace(/[^a-zA-Z0-9]/g, '')}@diamond-tickets`
      imagens.push({ cid, nome: `${t.codigo}.png`, conteudo: t.qrPng, tipo: 'image/png' })
      qr = `<img src="cid:${cid}" alt="QR do ingresso ${escapar(t.codigo)}" width="180" height="180"
              style="display:block;border:1px solid #DEE2E6;border-radius:8px;background:#fff">`
    }
    const onde = [t.setor, t.lote, t.tipo].filter(Boolean).map(escapar).join(' · ')
    return `
    <tr>
      <td style="padding:12px 0;border-top:1px solid #DEE2E6">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
          <tr>
            <td width="192" valign="top" style="padding-right:12px">${qr}</td>
            <td valign="top" style="font-family:Arial,Helvetica,sans-serif;color:#212529">
              <div style="font-size:13px;color:#6C757D">
                ${escapar(t.tipo || 'Ingresso')} ${i + 1} de ${d.ingressos.length}
              </div>
              <div style="font-size:22px;font-weight:bold;letter-spacing:2px;margin:4px 0">
                ${escapar(t.codigo)}
              </div>
              ${onde ? `<div style="font-size:13px;color:#495057">${onde}</div>` : ''}
              ${t.sessao ? `<div style="font-size:13px;color:#495057">${escapar(t.sessao)}</div>` : ''}
              ${t.titular ? `<div style="font-size:13px;color:#495057">Titular: ${escapar(t.titular)}</div>` : ''}
            </td>
          </tr>
        </table>
      </td>
    </tr>`
  }).join('')

  const html = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapar(assunto)}</title></head>
<body style="margin:0;padding:0;background:#F1F3F5">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#F1F3F5">
  <tr><td align="center" style="padding:24px 12px">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600"
           style="max-width:600px;width:100%;background:#FFFFFF;border:1px solid #DEE2E6;border-radius:8px">
      <tr><td style="padding:20px 24px;background:#0B2E4F;border-radius:8px 8px 0 0;
                     font-family:Arial,Helvetica,sans-serif;color:#FFFFFF;font-size:18px;font-weight:bold">
        diamond<span style="font-weight:normal;opacity:.7">.tickets</span>
      </td></tr>
      <tr><td style="padding:24px;font-family:Arial,Helvetica,sans-serif;color:#212529">
        <div style="font-size:20px;font-weight:bold">${escapar(d.eventoNome)}</div>
        ${d.eventoInicio ? `<div style="font-size:14px;color:#495057;margin-top:4px">${escapar(quando(d.eventoInicio))}</div>` : ''}
        ${d.local ? `<div style="font-size:14px;color:#495057">${escapar(d.local)}</div>` : ''}

        <div style="font-size:15px;margin-top:16px">
          ${d.compradorNome ? `${escapar(d.compradorNome)}, seu` : 'Seu'} pagamento foi confirmado
          e ${d.ingressos.length === 1 ? 'seu ingresso está' : 'seus ingressos estão'} abaixo.
        </div>

        <div style="font-size:14px;color:#495057;margin-top:12px">
          Pedido <strong style="color:#212529">${escapar(d.pedido)}</strong>
          · ${escapar(reais(d.totalCents))}
        </div>

        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"
               style="margin-top:12px">${blocos}</table>

        <div style="margin:24px 0 8px">
          <a href="${escapar(d.linkIngressos)}"
             style="display:inline-block;background:#1F7AE0;color:#FFFFFF;text-decoration:none;
                    font-weight:bold;font-size:16px;padding:12px 20px;border-radius:8px">
            Ver ${escapar(substantivo.toLowerCase())} no celular
          </a>
        </div>
        <div style="font-size:13px;color:#6C757D">
          Na portaria, apresente o QR. Se a leitura falhar, informe o código do ingresso —
          ele funciona digitado. Guarde este e-mail: ele é a sua entrada.
        </div>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`

  return {
    de: remetente(),
    para: d.compradorEmail,
    paraNome: d.compradorNome ?? null,
    assunto,
    texto,
    html,
    imagens,
  }
}

/**
 * Assinatura curta do conteúdo — serve pra ver, no suporte, se o reenvio
 * mandou a mesma coisa que o primeiro envio. Não é segurança, é rastro.
 */
export function impressao(m: Mensagem): string {
  return createHmac('sha256', 'impressao-de-envio')
    .update(`${m.para}|${m.assunto}|${m.texto}`).digest('hex').slice(0, 16)
}
