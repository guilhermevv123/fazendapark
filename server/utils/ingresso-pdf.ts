/**
 * O PDF dos ingressos (dono, 05/10: "o cara pode baixar foto ou PDF, ele escolhe").
 *
 * Uma página por ingresso, no formato de tela de celular: logo, evento, data, o QR grande, o código
 * legível (é o que a portaria digita quando a câmera falha) e quem é o titular. Sai do link do
 * e-mail e do WhatsApp — a página `/ingressos/<pedido>` oferece "PDF" e "Imagem".
 *
 * As fontes são as padrão do PDF (Helvetica): não dependem de fonte instalada no servidor, que é o
 * que derrubaria uma imagem gerada lá (por isso a IMAGEM é desenhada no celular, não aqui).
 * Helvetica padrão só escreve Latin-1 — `latin1` troca o resto (aspas tortas, travessão, emoji)
 * por equivalente ou some com ele, em vez de estourar o PDF inteiro por um emoji no nome do evento.
 */
import QRCode from 'qrcode'
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib'
import { LOGO_EMAIL } from './email-logo'

export interface IngressoNoPdf {
  codigo: string
  /** o conteúdo assinado do QR (`montarQr`) */
  qr: string
  tipo?: string | null
  setor?: string | null
  lote?: string | null
  titular?: string | null
  sessao?: string | null
  /** "domingo 11/10" — os dias em que este ingresso passa (047) */
  diasDeUso?: string | null
}

export interface PdfDosIngressos {
  evento: string
  /**
   * NÃO é escrito (dono, 08/10): a data de INÍCIO do evento em cima do ingresso de domingo fez o
   * comprador achar que era pra ir na sexta. O dia que vale sai no cartão ("Vale só"), por ingresso.
   */
  quando?: string
  local?: string | null
  pedido: string
  ingressos: IngressoNoPdf[]
}

const hex = (h: string) => rgb(parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255)
const UVA = hex('#583c8d')
const TINTA = hex('#1e1a2e')
const SUAVE = hex('#5a5570')
const LINHA = hex('#d7caec')
const FAIXA = ['#22aac3', '#583c8d', '#fdb92a', '#b9d53a'].map(hex)

/** Só o que a Helvetica padrão escreve (Latin-1). */
export function latin1(texto: unknown): string {
  return String(texto ?? '')
    .replace(/[‘’‚]/g, "'").replace(/[“”„]/g, '"')
    .replace(/[–—]/g, '-').replace(/…/g, '...').replace(/ /g, ' ')
    .replace(/[^\x20-\x7E¡-ÿ]/g, '')
    .replace(/\s+/g, ' ').trim()
}

/** Quebra em linhas que cabem na largura (palavra que sozinha não cabe é cortada). */
function linhas(texto: string, fonte: PDFFont, tamanho: number, largura: number, max = 3): string[] {
  const saida: string[] = []
  let atual = ''
  for (const palavra of texto.split(' ')) {
    const tentativa = atual ? `${atual} ${palavra}` : palavra
    if (fonte.widthOfTextAtSize(tentativa, tamanho) <= largura) { atual = tentativa; continue }
    if (atual) saida.push(atual)
    atual = palavra
    while (fonte.widthOfTextAtSize(atual, tamanho) > largura && atual.length > 1) atual = atual.slice(0, -1)
  }
  if (atual) saida.push(atual)
  if (saida.length > max) {
    const resto = saida.slice(0, max)
    resto[max - 1] = `${resto[max - 1].replace(/\s*\S*$/, '')}...`
    return resto
  }
  return saida
}

const L = 360
const A = 640
const M = 28

function centro(p: PDFPage, texto: string, y: number, fonte: PDFFont, tamanho: number, cor = TINTA) {
  p.drawText(texto, { x: (L - fonte.widthOfTextAtSize(texto, tamanho)) / 2, y, size: tamanho, font: fonte, color: cor })
}

export async function montarPdfDosIngressos(d: PdfDosIngressos): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  pdf.setTitle(latin1(`Ingressos - ${d.evento}`))
  pdf.setAuthor('Conquista Park')
  pdf.setCreator('Conquista Park')
  const normal = await pdf.embedFont(StandardFonts.Helvetica)
  const negrito = await pdf.embedFont(StandardFonts.HelveticaBold)
  const mono = await pdf.embedFont(StandardFonts.CourierBold)
  const logo = await pdf.embedPng(Buffer.from(LOGO_EMAIL.png, 'base64'))

  const total = d.ingressos.length
  for (let i = 0; i < total; i++) {
    const t = d.ingressos[i]
    const p = pdf.addPage([L, A])
    let y = A

    // faixa das 4 cores da marca no topo
    FAIXA.forEach((c, k) => p.drawRectangle({ x: (L / 4) * k, y: A - 6, width: L / 4, height: 6, color: c }))
    y -= 6

    // logo
    const lw = 150
    const lh = lw * (LOGO_EMAIL.altura / LOGO_EMAIL.largura)
    y -= 14 + lh
    p.drawImage(logo, { x: (L - lw) / 2, y, width: lw, height: lh })

    // evento e data
    y -= 26
    for (const l of linhas(latin1(d.evento), negrito, 17, L - 2 * M, 2)) {
      centro(p, l, y, negrito, 17)
      y -= 21
    }
    y += 6
    if (d.local) { centro(p, latin1(d.local), y, normal, 10, SUAVE); y -= 14 }

    // cartão do ingresso
    const topoCartao = y - 6
    const cabecalho = 26
    const qrTam = 220
    const altCartao = cabecalho + 16 + qrTam + 12 + 22 + 14 + 84
    const baseCartao = topoCartao - altCartao
    p.drawRectangle({ x: M, y: baseCartao, width: L - 2 * M, height: altCartao, color: rgb(1, 1, 1),
      borderColor: LINHA, borderWidth: 1 })
    p.drawRectangle({ x: M, y: topoCartao - cabecalho, width: L - 2 * M, height: cabecalho, color: UVA })
    const rotulo = latin1(`${(t.tipo || 'Ingresso').toUpperCase()}  ·  ${i + 1} de ${total}`)
    centro(p, rotulo, topoCartao - cabecalho + 9, negrito, 10.5, rgb(1, 1, 1))

    // QR
    const png = await QRCode.toBuffer(t.qr, { margin: 1, width: 600, errorCorrectionLevel: 'M' })
    const qr = await pdf.embedPng(png)
    let yy = topoCartao - cabecalho - 16 - qrTam
    p.drawImage(qr, { x: (L - qrTam) / 2, y: yy, width: qrTam, height: qrTam })

    // código legível
    yy -= 24
    centro(p, latin1(t.codigo), yy, mono, 17)
    yy -= 14
    centro(p, 'código do ingresso', yy, normal, 8.5, SUAVE)

    // picote + dados
    yy -= 12
    for (let x = M + 8; x < L - M - 8; x += 8) p.drawLine({ start: { x, y: yy }, end: { x: x + 4, y: yy }, thickness: 1, color: LINHA })
    const dados: [string, string][] = []
    if (t.titular) dados.push(['Titular', latin1(t.titular)])
    if (t.diasDeUso) dados.push(['Vale só', latin1(t.diasDeUso.replace(/^./, (c) => c.toUpperCase()))])
    const setor = [t.setor, t.lote].filter(Boolean).join(' · ')
    if (setor) dados.push(['Setor', latin1(setor)])
    if (t.sessao) dados.push(['Sessão', latin1(t.sessao)])
    dados.push(['Pedido', latin1(d.pedido)])
    yy -= 16
    for (const [k, v] of dados.slice(0, 5)) {
      p.drawText(k, { x: M + 14, y: yy, size: 9.5, font: normal, color: SUAVE })
      const valor = linhas(v, negrito, 9.5, L - 2 * M - 90, 1)[0] ?? ''
      p.drawText(valor, { x: L - M - 14 - negrito.widthOfTextAtSize(valor, 9.5), y: yy, size: 9.5, font: negrito, color: TINTA })
      yy -= 14
    }

    // rodapé: só o site (a caixa "Na portaria, mostre este QR Code" saiu a pedido do dono, 08/10)
    centro(p, 'www.conquistapark.com.br', 16, negrito, 8.5, UVA)
  }
  return pdf.save()
}
