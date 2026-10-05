/**
 * O cupom de consumação do Volte Mais como IMAGEM (042, dono 05/10: "o cara chega e baixa o
 * ticketzinho dele"). Mesmo jeito do ingresso (`ingressoImagem.ts`): desenhado no aparelho (o
 * servidor não tem fonte), salvo pela folha de compartilhar ou baixado.
 *
 * O QR da imagem é o MESMO da página (`/api/consumo/<token>/qr.png`): a atendente escaneia a foto
 * na galeria e cai na página do cupom, onde o servidor diz se ainda vale. A imagem é só o
 * caminho — quem decide "já usado" é o banco, então print reaproveitado não engana o caixa.
 */
import { carregarImagem } from './ingressoImagem'

export interface CupomParaImagem {
  token: string
  codigo: string
  consumacaoPct: number
  /** 'AAAA-MM-DD' */
  dia: string
  programa: string
  evento?: string | null
  titular?: string | null
}

/** O cupom como o caixa do bar vê (`/api/admin/consumacao`, `situacaoParaOCaixa` no servidor). */
export type CupomNoCaixa = {
  estado: 'valido' | 'ativo' | 'usado' | 'antes_do_dia' | 'passou_o_dia' | 'pedido_cancelado'
  recado: string; consumacaoPct: number; dia: string; hoje: string; codigo: string; token: string
  programa: string; evento: string; pedido: string; titular: string | null; cpf: string | null
  entradaHoje: string | null; diaTodo: boolean; usosMax: number
  usos: { em: string; por: string | null; semEntrada: boolean }[]; restam: number | null
}

const W = 1080
const H = 1580
const SANS = 'system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif'
const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace'
const COR = { sol: '#fdb92a', solClaro: '#fffaeb', uva: '#583c8d', tinta: '#1e1a2e', suave: '#5a5570', branco: '#ffffff' }

export const diaDoCupomBR = (iso: string) => iso.split('-').reverse().join('/')

export async function desenharCupom(c: CupomParaImagem, logo: HTMLImageElement | null, qr: HTMLImageElement): Promise<Blob> {
  const tela = document.createElement('canvas')
  tela.width = W; tela.height = H
  const ctx = tela.getContext('2d')!

  ctx.fillStyle = COR.solClaro
  ctx.fillRect(0, 0, W, H)
  // a moldura tracejada de cupom
  ctx.strokeStyle = COR.sol; ctx.lineWidth = 10; ctx.setLineDash([34, 20])
  ctx.strokeRect(40, 40, W - 80, H - 80)
  ctx.setLineDash([])

  // faixa de cima (só o texto: o logo é roxo e some no roxo) e o logo no fundo claro
  ctx.fillStyle = COR.uva
  ctx.fillRect(40, 40, W - 80, 110)
  ctx.fillStyle = COR.branco
  ctx.textAlign = 'center'
  ctx.font = `700 44px ${SANS}`
  ctx.fillText(`★ CLIENTE ${c.programa.toUpperCase()} ★`, W / 2, 112)
  if (logo) {
    const h = 120, w = (logo.width / logo.height) * h
    ctx.drawImage(logo, (W - w) / 2, 180, w, h)
  }
  ctx.translate(0, 80) // o resto desce o tanto que o logo ocupou

  ctx.fillStyle = COR.tinta
  ctx.font = `800 150px ${SANS}`
  ctx.fillText(`${c.consumacaoPct}%`, W / 2, 470)
  ctx.font = `700 60px ${SANS}`
  ctx.fillText('de desconto no bar', W / 2, 550)
  ctx.fillStyle = COR.suave
  ctx.font = `500 40px ${SANS}`
  ctx.fillText(`Vale em ${diaDoCupomBR(c.dia)}${c.evento ? ` · ${c.evento}` : ''}`.slice(0, 48), W / 2, 615)

  const lado = 460
  ctx.fillStyle = COR.branco
  ctx.fillRect((W - lado) / 2 - 20, 660, lado + 40, lado + 40)
  ctx.drawImage(qr, (W - lado) / 2, 680, lado, lado)

  ctx.fillStyle = COR.tinta
  ctx.font = `700 76px ${MONO}`
  ctx.fillText(c.codigo.split('').join(' '), W / 2, 1270)
  if (c.titular) {
    ctx.fillStyle = COR.suave
    ctx.font = `500 38px ${SANS}`
    ctx.fillText(`Titular: ${c.titular}`.slice(0, 44), W / 2, 1335)
  }
  ctx.fillStyle = COR.suave
  ctx.font = `500 32px ${SANS}`
  ctx.fillText('Mostre no caixa do bar com um documento com foto.', W / 2, 1400)
  ctx.fillText('O caixa escaneia o QR e dá a baixa.', W / 2, 1442)

  return new Promise((ok, falha) => tela.toBlob((b) => (b ? ok(b) : falha(new Error('canvas vazio'))), 'image/png'))
}

/** Gera e entrega: folha de compartilhar (celular) ou download. 'compartilhado' | 'baixado' | 'cancelado'. */
export async function salvarCupomComoImagem(c: CupomParaImagem) {
  const logo = await carregarImagem('/brand/conquista-park.png').catch(() => null)
  const qr = await carregarImagem(`/api/consumo/${encodeURIComponent(c.token)}/qr.png`)
  const png = await desenharCupom(c, logo, qr)
  const arquivo = new File([png], `cupom-bar-${c.codigo}.png`, { type: 'image/png' })
  const nav = navigator as any
  if (nav.canShare?.({ files: [arquivo] })) {
    try {
      await nav.share({ files: [arquivo], title: `Cupom ${c.consumacaoPct}% no bar` })
      return 'compartilhado' as const
    } catch (e: any) {
      if (e?.name === 'AbortError') return 'cancelado' as const
    }
  }
  const url = URL.createObjectURL(arquivo)
  const a = document.createElement('a')
  a.href = url; a.download = arquivo.name
  document.body.appendChild(a); a.click(); a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
  return 'baixado' as const
}
