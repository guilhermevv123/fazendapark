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
import { botaoDoEmail, COR, escaparNoEmail, FONTE, moldeDoEmail } from './email-visual'

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

/**
 * Quem assina o e-mail. Sem `EMAIL_REMETENTE` fica um endereço que NÃO existe
 * de propósito (`.invalid` é reservado pra isso, RFC 2606) — o de antes,
 * `nao-responda@diamond-tickets.local`, era domínio inválido E carregava o nome
 * antigo do repositório na frente do comprador (PROD-05). Em produção a falta
 * da variável nem chega aqui: `pendenciaDoEmail` segura o envio antes.
 */
export function remetente(): string {
  return process.env.EMAIL_REMETENTE || 'Conquista Park <nao-responda@conquistapark.invalid>'
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
/**
 * O domínio de quem assina (`"Conquista Park <ingressos@conquistapark.com.br>"` → `conquistapark.com.br`).
 * Message-ID e EHLO com nome solto ("diamond-tickets", sem ponto) são sinal de máquina mal
 * configurada pros filtros de spam; com o domínio do remetente, batem com o SPF/DKIM dele.
 */
export function dominioDoRemetente(de: string | null | undefined): string | null {
  const m = String(de ?? '').match(/@([a-z0-9.-]+\.[a-z]{2,})>?\s*$/i)
  return m ? m[1]!.toLowerCase() : null
}

export function montarMime(m: Mensagem): { bruto: string; messageId: string } {
  const messageId = m.messageId ?? `<${randomUUID()}@${dominioDoRemetente(m.de) ?? 'diamond-tickets.invalid'}>`
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
  c.escrever(`EHLO ${process.env.SMTP_EHLO || dominioDoRemetente(remetente()) || 'diamond-tickets'}`)
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
 * O que falta pro e-mail sair DE VERDADE em produção — frase pra operador, ou
 * `null` quando está tudo no lugar (ou fora de produção, onde simular é o certo).
 *
 * PROD-05: sem `SMTP_URL` o transporte caía no simulado em silêncio — o .eml
 * ia pra `/tmp` do contêiner (que some no deploy), a linha era marcada como
 * enviada, e a home e a FAQ seguiam prometendo e-mail. Agora, em produção, o
 * envio FALHA com esta frase: a fila tenta de novo com espera, desiste com o
 * erro escrito, e `/admin/filas` e `/api/saude` acusam. Quem quer mesmo simular
 * em produção (ensaio) diz isso com `EMAIL_TRANSPORTE=simulado`.
 */
export function pendenciaDoEmail(env: Record<string, string | undefined> = process.env): string | null {
  if (env.NODE_ENV !== 'production' || env.EMAIL_TRANSPORTE === 'simulado') return null
  if (!env.SMTP_URL) {
    return 'SMTP_URL não configurado: o e-mail do ingresso não sai em produção '
      + '(configure o servidor de e-mail no ambiente do deploy)'
  }
  try { new URL(env.SMTP_URL) } catch {
    return 'SMTP_URL não é um endereço smtp:// ou smtps:// válido'
  }
  if (!env.EMAIL_REMETENTE || !enderecoValido(soEndereco(env.EMAIL_REMETENTE))) {
    return 'EMAIL_REMETENTE não configurado (ex.: "Conquista Park <ingressos@seudominio.com.br>"): '
      + 'sem ele o remetente seria um endereço que não existe'
  }
  return null
}

/**
 * Entrega pelo transporte do ambiente. É o único ponto que decide entre
 * simular e mandar de verdade — quem chama não precisa saber, e não existe
 * um segundo caminho que possa divergir deste.
 */
export async function entregar(m: Mensagem): Promise<Entrega> {
  const falta = pendenciaDoEmail()
  if (falta) throw new Error(falta)
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
  /** `null` quando a URL pública não está configurada: o e-mail sai sem o link */
  linkIngressos: string | null
  substantivo?: string | null
  /** fuso do EVENTO (events.timezone); sem ele, o do parque */
  fuso?: string | null
  /** Volte Mais (042): o cupom de consumação do retorno — o caixa do bar escaneia o QR */
  cupomConsumacao?: { codigo: string; consumacaoPct: number; dia: string; link: string | null; qrPng: Buffer | null } | null
  /** Volte Mais (042): a 1ª visita paga ganha o convite pro retorno com desconto */
  conviteVolteMais?: { nome: string; descontoPct: number; consumacaoPct: number; permanente: boolean } | null
}

const reais = (c: number) =>
  (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })

/**
 * Data no fuso do parque. `toISOString()` cortaria em UTC e, às 21h de
 * Brasília, o ingresso de hoje chegaria marcado com a data de amanhã.
 */
export function quando(d: Date | string | null | undefined, fuso?: string | null): string {
  if (!d) return ''
  return new Date(d).toLocaleString('pt-BR', {
    timeZone: fuso || process.env.TZ_EVENTO || 'America/Bahia',
    day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

/**
 * O dia de uma sessão sem título, do jeito que se fala: "sábado, 04/10 às
 * 09:00" — no fuso do evento. Antes saía `String(Date)` (B28).
 */
export function diaDaSessao(d: Date | string, fuso?: string | null): string {
  const data = new Date(d)
  const tz = fuso || process.env.TZ_EVENTO || 'America/Bahia'
  const dia = data.toLocaleDateString('pt-BR', { timeZone: tz, weekday: 'long', day: '2-digit', month: '2-digit' })
  const hora = data.toLocaleTimeString('pt-BR', { timeZone: tz, hour: '2-digit', minute: '2-digit' })
  return `${dia} às ${hora}`
}


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
    d.totalCents === 0
      ? `${d.compradorNome ? `${d.compradorNome}, s` : 'S'}eu ingresso está garantido.`
      : `${d.compradorNome ? `${d.compradorNome}, s` : 'S'}eu pagamento foi confirmado.`,
    '',
    d.eventoNome,
    d.eventoInicio ? quando(d.eventoInicio, d.fuso) : '',
    d.local ?? '',
    '',
    `Pedido ${d.pedido} · ${d.totalCents === 0 ? 'Grátis' : reais(d.totalCents)}`,
    `${d.ingressos.length} ${d.ingressos.length === 1 ? 'ingresso' : 'ingressos'}:`,
    ...linhasTexto,
    '',
    ...(d.linkIngressos
      ? ['Abra o link abaixo para ver o QR de cada ingresso:', d.linkIngressos, '']
      : ['O QR de cada ingresso está anexado a este e-mail.', '']),
    'Na portaria, apresente o QR. Se a leitura falhar, informe o código do ingresso.',
    ...(d.cupomConsumacao
      ? ['', `CLIENTE VOLTE MAIS — ${d.cupomConsumacao.consumacaoPct}% de desconto na consumação em ${d.cupomConsumacao.dia}.`,
         `Cupom ${d.cupomConsumacao.codigo}: mostre no caixa do bar com um documento com foto.`,
         ...(d.cupomConsumacao.link ? [d.cupomConsumacao.link] : [])]
      : []),
    ...(d.conviteVolteMais
      ? ['', `${d.conviteVolteMais.nome}: depois desta visita, ${d.conviteVolteMais.descontoPct}% de desconto no ingresso ${d.conviteVolteMais.permanente ? 'em todas as próximas visitas' : 'nas próximas visitas'}${d.conviteVolteMais.consumacaoPct ? ` e ${d.conviteVolteMais.consumacaoPct}% na consumação` : ''}. Compre pelo site com a sua conta.`]
      : []),
  ].filter((l) => l !== null).join('\n')

  const gratis = d.totalCents === 0
  const varios = d.ingressos.length !== 1
  const e = escaparNoEmail
  const dataDoEvento = d.eventoInicio ? quando(d.eventoInicio, d.fuso) : ''

  const blocos = d.ingressos.map((t, i) => {
    let qr = ''
    if (t.qrPng) {
      const cid = `qr-${t.codigo.replace(/[^a-zA-Z0-9]/g, '')}@diamond-tickets`
      imagens.push({ cid, nome: `${t.codigo}.png`, conteudo: t.qrPng, tipo: 'image/png' })
      qr = `<img src="cid:${cid}" alt="QR do ingresso ${e(t.codigo)}" width="200" height="200"
              style="display:block;margin:0 auto;width:200px;height:200px;border:0;background:#fff">`
    }
    const onde = [t.setor, t.lote].filter(Boolean).map(e).join(' · ')
    return `
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"
               style="margin-top:16px;border:2px solid ${COR.uvaLinha};border-radius:8px;border-collapse:separate">
          <tr><td bgcolor="${COR.uva}" style="background:${COR.uva};padding:12px 16px;border-radius:6px 6px 0 0;
                     font-family:${FONTE};font-size:12px;font-weight:bold;letter-spacing:.08em;text-transform:uppercase;color:#ffffff">
            ${e(t.tipo || 'Ingresso')} &nbsp;·&nbsp; ${i + 1} de ${d.ingressos.length}
          </td></tr>
          <tr><td align="center" style="padding:22px 16px 8px">${qr}</td></tr>
          <tr><td align="center" style="padding:6px 16px 18px;font-family:${FONTE}">
            <div style="font-family:'Courier New',Courier,monospace;font-size:24px;font-weight:bold;letter-spacing:3px;color:${COR.tinta}">${e(t.codigo)}</div>
            ${onde ? `<div style="font-size:13px;color:${COR.suave};margin-top:6px">${onde}</div>` : ''}
            ${t.sessao ? `<div style="font-size:13px;color:${COR.suave};margin-top:2px">${e(t.sessao)}</div>` : ''}
          </td></tr>
          ${t.titular ? `<tr><td style="border-top:2px dashed ${COR.uvaLinha};padding:12px 16px;font-family:${FONTE};font-size:13px;color:${COR.suave}">
            Titular: <strong style="color:${COR.tinta}">${e(t.titular)}</strong>
          </td></tr>` : ''}
        </table>`
  }).join('')

  // Volte Mais (042): o cupom de consumação, com cara de cupom (borda tracejada, sol) — o caixa do bar
  // escaneia o QR com a câmera do celular e dá a baixa; sem câmera, digita o código.
  let cupomHtml = ''
  if (d.cupomConsumacao) {
    const cc = d.cupomConsumacao
    let qrCupom = ''
    if (cc.qrPng) {
      const cid = `cupom-${cc.codigo}@diamond-tickets`
      imagens.push({ cid, nome: `cupom-${cc.codigo}.png`, conteudo: cc.qrPng, tipo: 'image/png' })
      qrCupom = `<img src="cid:${cid}" alt="QR do cupom de consumação ${e(cc.codigo)}" width="150" height="150"
              style="display:block;margin:0 auto;width:150px;height:150px;border:0;background:#fff">`
    }
    cupomHtml = `
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"
               style="margin-top:20px;border:3px dashed ${COR.sol};border-radius:10px;border-collapse:separate" data-parte="cupom-consumacao-email">
          <tr><td bgcolor="${COR.solClaro}" style="background:${COR.solClaro};padding:16px 18px 6px;border-radius:8px 8px 0 0;font-family:${FONTE};text-align:center">
            <div style="font-size:12px;font-weight:bold;letter-spacing:.1em;text-transform:uppercase;color:${COR.uva}">Cliente Volte Mais</div>
            <div style="font-size:34px;font-weight:bold;line-height:1.1;color:${COR.tinta};margin-top:4px">${cc.consumacaoPct}% no bar</div>
            <div style="font-size:14px;color:${COR.corpo};margin-top:4px">Desconto na consumação em ${e(cc.dia)}</div>
          </td></tr>
          <tr><td bgcolor="${COR.solClaro}" align="center" style="background:${COR.solClaro};padding:10px 16px 6px">${qrCupom}</td></tr>
          <tr><td bgcolor="${COR.solClaro}" align="center" style="background:${COR.solClaro};padding:4px 16px 16px;border-radius:0 0 8px 8px;font-family:${FONTE}">
            <div style="font-family:'Courier New',Courier,monospace;font-size:22px;font-weight:bold;letter-spacing:4px;color:${COR.tinta}">${e(cc.codigo)}</div>
            <div style="font-size:13px;color:${COR.suave};margin-top:6px">Mostre este cupom e um documento com foto no caixa do bar. Vale no dia da visita, depois da entrada.</div>
            ${cc.link ? `<div style="margin-top:12px">${botaoDoEmail('Abrir meu cupom', cc.link)}</div>` : ''}
          </td></tr>
        </table>`
  }
  const conviteHtml = d.conviteVolteMais ? `
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:20px" data-parte="convite-volte-mais-email">
          <tr><td bgcolor="${COR.solClaro}" style="background:${COR.solClaro};border-left:4px solid ${COR.sol};border-radius:6px;padding:14px 16px;font-family:${FONTE};font-size:14px;color:${COR.corpo}">
            <strong style="color:${COR.tinta}">${e(d.conviteVolteMais.nome)}:</strong> depois desta visita, você ganha
            <strong style="color:${COR.tinta}">${d.conviteVolteMais.descontoPct}% de desconto no ingresso</strong>
            ${d.conviteVolteMais.permanente ? 'em todas as próximas visitas' : 'nas próximas visitas'}${d.conviteVolteMais.consumacaoPct ? ` e ${d.conviteVolteMais.consumacaoPct}% na consumação` : ''}.
            É só comprar pelo site com a sua conta.
          </td></tr>
        </table>` : ''

  const resumo = `
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"
               style="margin-top:22px;border-radius:8px;border-collapse:separate">
          <tr><td bgcolor="${COR.uvaClara}" style="background:${COR.uvaClara};padding:18px 18px 16px;border-radius:8px 8px 0 0;font-family:${FONTE}">
            <div style="font-size:19px;font-weight:bold;line-height:1.3;color:${COR.tinta}">${e(d.eventoNome)}</div>
            ${dataDoEvento ? `<div style="font-size:14px;color:${COR.corpo};margin-top:6px">${e(dataDoEvento)}</div>` : ''}
            ${d.local ? `<div style="font-size:14px;color:${COR.suave};margin-top:2px">${e(d.local)}</div>` : ''}
          </td></tr>
          <tr><td bgcolor="${COR.uvaClara}" style="background:${COR.uvaClara};border-top:1px solid ${COR.uvaLinha};padding:12px 18px;border-radius:0 0 8px 8px;font-family:${FONTE}">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
              <td style="font-size:13px;color:${COR.suave}">Pedido <strong style="color:${COR.tinta}">${e(d.pedido)}</strong></td>
              <td align="right" style="font-size:15px;font-weight:bold;color:${COR.tinta}">${gratis ? 'Grátis' : e(reais(d.totalCents))}</td>
            </tr></table>
          </td></tr>
        </table>`

  const corpo = `
        <div style="display:inline-block;background:${COR.okClaro};color:${COR.ok};font-size:12px;font-weight:bold;
                    letter-spacing:.06em;text-transform:uppercase;padding:6px 10px;border-radius:6px">
          ${gratis ? 'Ingresso garantido' : 'Pagamento confirmado'}
        </div>
        <h1 style="margin:14px 0 0;font-family:${FONTE};font-size:26px;line-height:1.25;color:${COR.tinta}">
          ${varios ? `Seus ${e(substantivo.toLowerCase())} estão aqui!` : 'Seu ingresso está aqui!'}
        </h1>
        <p style="margin:16px 0 0;font-size:16px;color:${COR.corpo}">
          ${d.compradorNome ? `Olá, <strong style="color:${COR.tinta}">${e(d.compradorNome)}</strong>! ` : ''}${gratis
            ? `${varios ? 'Seus ingressos estão garantidos' : 'Seu ingresso está garantido'}.`
            : 'Seu pagamento foi confirmado.'} Mostre o QR abaixo na portaria e é só curtir.
        </p>
${resumo}
        ${d.linkIngressos ? `<div style="margin:24px 0 4px">${botaoDoEmail(`Ver ${substantivo.toLowerCase()} no celular`, d.linkIngressos)}</div>` : ''}
${blocos}
${cupomHtml}
${conviteHtml}
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:24px">
          <tr><td bgcolor="${COR.piscinaClara}" style="background:${COR.piscinaClara};border-left:4px solid ${COR.piscina};
                     border-radius:6px;padding:14px 16px;font-family:${FONTE};font-size:14px;color:${COR.corpo}">
            <strong style="color:${COR.tinta}">Na portaria:</strong> apresente o QR, no celular ou impresso.
            Se a leitura falhar, informe o código do ingresso — ele funciona digitado.
            Guarde este e-mail: ele é a sua entrada.
          </td></tr>
        </table>`

  const molde = moldeDoEmail({
    assunto,
    previa: `Pedido ${d.pedido} · ${d.eventoNome}${dataDoEvento ? ` · ${dataDoEvento}` : ''}`,
    corpo,
  })
  imagens.unshift(...molde.imagens)
  const html = molde.html

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
