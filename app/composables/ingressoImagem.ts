/**
 * O ingresso como IMAGEM (dono, 05/10: "baixar foto ou PDF, o cara escolhe").
 *
 * Desenhado aqui no celular, num canvas do tamanho de um story (1080×1920), e não no servidor:
 * a imagem precisa de fonte, e o servidor (Docker enxuto) não tem fonte nenhuma — o texto sairia
 * em quadradinhos. O aparelho tem as dele. O QR vem da MESMA rota que a página mostra
 * (`/api/ingresso/<id>/qr.png?pedido=`), então a imagem nunca carrega um QR que a portaria recusa.
 *
 * Salvar: com a folha de compartilhar do celular (Web Share com arquivo) a pessoa toca em
 * "Salvar imagem" e vai pra galeria; sem ela (computador), baixa um PNG por ingresso.
 */
export interface IngressoParaImagem {
  codigo: string
  qrUrl: string
  tipo?: string | null
  setor?: string | null
  lote?: string | null
  titular?: string | null
}
export interface DadosDaImagem {
  evento: string
  quando: string
  local?: string | null
  pedido: string
  /** Volte Mais (042): o ingresso do retorno sai com a faixa "Cliente <nome>" no topo */
  volteMais?: string | null
}

const W = 1080
const H = 1920
const M = 80
const COR = { uva: '#583c8d', uvaClara: '#f6f3fb', linha: '#d7caec', tinta: '#1e1a2e', suave: '#5a5570' }
const FAIXA = ['#22aac3', '#583c8d', '#fdb92a', '#b9d53a']
const SANS = 'system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif'
const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace'

export function carregarImagem(src: string): Promise<HTMLImageElement> {
  return new Promise((ok, falha) => {
    const img = new Image()
    img.decoding = 'async'
    img.onload = () => ok(img)
    img.onerror = () => falha(new Error(`não carregou ${src}`))
    img.src = src
  })
}

function quebrar(ctx: CanvasRenderingContext2D, texto: string, largura: number, max: number): string[] {
  const saida: string[] = []
  let atual = ''
  for (const p of texto.split(/\s+/).filter(Boolean)) {
    const t = atual ? `${atual} ${p}` : p
    if (ctx.measureText(t).width <= largura) { atual = t; continue }
    if (atual) saida.push(atual)
    atual = p
  }
  if (atual) saida.push(atual)
  if (saida.length > max) {
    const resto = saida.slice(0, max)
    resto[max - 1] += '…'
    return resto
  }
  return saida
}

/** Desenha UM ingresso e devolve o PNG. */
export async function desenharIngresso(d: DadosDaImagem, t: IngressoParaImagem, indice: number, total: number,
  logo: HTMLImageElement | null, qr: HTMLImageElement): Promise<Blob> {
  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  const ctx = c.getContext('2d')!
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, W, H)
  FAIXA.forEach((cor, k) => { ctx.fillStyle = cor; ctx.fillRect((W / 4) * k, 0, W / 4, 18) })
  ctx.textAlign = 'center'
  ctx.textBaseline = 'alphabetic'

  let y = 18 + 50
  if (d.volteMais) {
    ctx.fillStyle = '#fdb92a'
    ctx.fillRect(0, 18, W, 76)
    ctx.fillStyle = '#2e2149'
    ctx.font = `700 38px ${SANS}`
    ctx.fillText(`★ CLIENTE ${d.volteMais.toUpperCase()} ★`, W / 2, 70)
    y += 76
  }
  if (logo) {
    const lw = 420
    const lh = lw * (logo.naturalHeight / logo.naturalWidth)
    ctx.drawImage(logo, (W - lw) / 2, y, lw, lh)
    y += lh + 70
  } else {
    y += 60
  }

  ctx.fillStyle = COR.tinta
  ctx.font = `700 56px ${SANS}`
  for (const l of quebrar(ctx, d.evento, W - 2 * M, 2)) { ctx.fillText(l, W / 2, y); y += 66 }
  ctx.fillStyle = COR.suave
  ctx.font = `400 36px ${SANS}`
  ctx.fillText(d.quando, W / 2, y + 4)
  y += 50
  if (d.local) { ctx.font = `400 32px ${SANS}`; ctx.fillText(d.local, W / 2, y + 4); y += 46 }

  // cartão
  const topo = y + 20
  const cab = 84
  const qrTam = 640
  const linhas: [string, string][] = []
  if (t.titular) linhas.push(['Titular', t.titular])
  const setor = [t.setor, t.lote].filter(Boolean).join(' · ')
  if (setor) linhas.push(['Setor', setor])
  linhas.push(['Pedido', d.pedido])
  const alt = cab + 48 + qrTam + 40 + 70 + 40 + 40 + linhas.length * 52 + 30
  ctx.fillStyle = '#ffffff'
  ctx.strokeStyle = COR.linha
  ctx.lineWidth = 3
  ctx.beginPath(); ctx.roundRect(M, topo, W - 2 * M, alt, 28); ctx.fill(); ctx.stroke()
  ctx.save()
  ctx.beginPath(); ctx.roundRect(M, topo, W - 2 * M, cab, [28, 28, 0, 0]); ctx.clip()
  ctx.fillStyle = COR.uva
  ctx.fillRect(M, topo, W - 2 * M, cab)
  ctx.restore()
  ctx.fillStyle = '#ffffff'
  ctx.font = `700 34px ${SANS}`
  ctx.fillText(`${(t.tipo || 'Ingresso').toUpperCase()}  ·  ${indice} de ${total}`, W / 2, topo + 55)

  let yy = topo + cab + 48
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(qr, (W - qrTam) / 2, yy, qrTam, qrTam)
  ctx.imageSmoothingEnabled = true
  yy += qrTam + 70
  ctx.fillStyle = COR.tinta
  ctx.font = `700 58px ${MONO}`
  ctx.fillText(t.codigo, W / 2, yy)
  yy += 40
  ctx.fillStyle = COR.suave
  ctx.font = `400 28px ${SANS}`
  ctx.fillText('código do ingresso', W / 2, yy)
  yy += 40
  ctx.strokeStyle = COR.linha
  ctx.setLineDash([14, 12])
  ctx.beginPath(); ctx.moveTo(M + 30, yy); ctx.lineTo(W - M - 30, yy); ctx.stroke()
  ctx.setLineDash([])
  yy += 56
  for (const [k, v] of linhas) {
    ctx.textAlign = 'left'
    ctx.fillStyle = COR.suave
    ctx.font = `400 32px ${SANS}`
    ctx.fillText(k, M + 40, yy)
    ctx.textAlign = 'right'
    ctx.fillStyle = COR.tinta
    ctx.font = `600 32px ${SANS}`
    ctx.fillText(quebrar(ctx, v, W - 2 * M - 260, 1)[0] ?? '', W - M - 40, yy)
    yy += 52
  }
  ctx.textAlign = 'center'

  // rodapé
  const caixa = H - 230
  ctx.fillStyle = COR.uvaClara
  ctx.beginPath(); ctx.roundRect(M, caixa, W - 2 * M, 120, 20); ctx.fill()
  ctx.fillStyle = COR.tinta
  ctx.font = `400 30px ${SANS}`
  ctx.fillText('Na portaria, mostre este QR Code.', W / 2, caixa + 52)
  ctx.fillStyle = COR.suave
  ctx.fillText('Se a câmera falhar, informe o código do ingresso.', W / 2, caixa + 94)
  ctx.fillStyle = COR.uva
  ctx.font = `700 28px ${SANS}`
  ctx.fillText('www.conquistapark.com.br', W / 2, H - 50)

  return new Promise((ok, falha) => c.toBlob((b) => (b ? ok(b) : falha(new Error('canvas vazio'))), 'image/png'))
}

/**
 * Gera as imagens e entrega: folha de compartilhar do celular (com arquivo) ou download.
 * Devolve 'compartilhado' | 'baixado' | 'cancelado'.
 */
export async function salvarIngressosComoImagem(d: DadosDaImagem, lista: IngressoParaImagem[]) {
  const logo = await carregarImagem('/brand/conquista-park.png').catch(() => null)
  const arquivos: File[] = []
  for (let i = 0; i < lista.length; i++) {
    const qr = await carregarImagem(lista[i].qrUrl)
    const png = await desenharIngresso(d, lista[i], i + 1, lista.length, logo, qr)
    arquivos.push(new File([png], `ingresso-${lista[i].codigo}.png`, { type: 'image/png' }))
  }
  const nav = navigator as any
  if (nav.canShare?.({ files: arquivos })) {
    try {
      await nav.share({ files: arquivos, title: `Ingressos — ${d.evento}` })
      return 'compartilhado' as const
    } catch (e: any) {
      if (e?.name === 'AbortError') return 'cancelado' as const
      // o compartilhar falhou de outro jeito: cai pro download
    }
  }
  for (const f of arquivos) {
    const url = URL.createObjectURL(f)
    const a = document.createElement('a')
    a.href = url
    a.download = f.name
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
    await new Promise((r) => setTimeout(r, 300))
  }
  return 'baixado' as const
}
