/**
 * A cara dos e-mails do Conquista Park (dono, 05/10): TODO e-mail que o site manda — ingresso,
 * confirmar o e-mail, senha nova — sai neste molde, com a logo embutida, a faixa nas 4 cores dos
 * respingos da logo e o botão amarelo do site.
 *
 * HTML de e-mail é tabela e estilo embutido: cliente de e-mail ignora folha de estilo, flexbox e
 * fonte de fora. O que parece antiquado aqui é o que abre igual no Gmail, no Outlook e no iPhone.
 * As cores são as do `tailwind.config.js` (uva, sol, piscina, cítrico, tinta).
 */
import type { ImagemEmbutida } from './email'
import { LOGO_EMAIL } from './email-logo'

export const COR = {
  uva: '#583c8d', uvaEscura: '#2e2149', uvaClara: '#f6f3fb', uvaLinha: '#d7caec',
  sol: '#fdb92a', solClaro: '#fffaeb',
  piscina: '#22aac3', piscinaClara: '#effafd',
  citrico: '#b9d53a',
  tinta: '#1e1a2e', corpo: '#2d293f', suave: '#5a5570', fraca: '#716c87',
  linha: '#e2e0ea', fundo: '#f4f6f9', branco: '#ffffff',
  ok: '#15803d', okClaro: '#edfcf2',
} as const

/** Fonte de e-mail: só as que todo aparelho tem. */
export const FONTE = `Arial, Helvetica, sans-serif`

export const escaparNoEmail = (v: unknown) => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** O site oficial — o rodapé aponta sempre pra ele (no teste também: localhost não abre no celular). */
export const SITE_OFICIAL = 'https://www.conquistapark.com.br'

export const CID_LOGO = 'logo-conquista-park@diamond-tickets'

/** A logo como anexo embutido — vai em toda mensagem que usa o molde. */
export function imagemDaLogo(): ImagemEmbutida {
  return { cid: CID_LOGO, nome: 'conquista-park.png', conteudo: Buffer.from(LOGO_EMAIL.png, 'base64'), tipo: 'image/png' }
}

/** O botão do site (amarelo, letra escura, canto de 6 px). Tabela pra o Outlook respeitar o fundo. */
export function botaoDoEmail(texto: string, link: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0">
  <tr><td bgcolor="${COR.sol}" style="background:${COR.sol};border-radius:6px">
    <a href="${escaparNoEmail(link)}" target="_blank"
       style="display:inline-block;padding:15px 30px;font-family:${FONTE};font-size:16px;font-weight:bold;
              color:${COR.tinta};text-decoration:none;border-radius:6px">${escaparNoEmail(texto)}</a>
  </td></tr>
</table>`
}

/** A faixa de 4 cores que fecha o topo — os respingos da logo, em linha. */
function faixaDaMarca(): string {
  const cores = [COR.piscina, COR.uva, COR.sol, COR.citrico]
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
  <tr>${cores.map((c) => `<td height="6" bgcolor="${c}" style="background:${c};height:6px;line-height:6px;font-size:0">&nbsp;</td>`).join('')}</tr>
</table>`
}

export interface MoldeDoEmail {
  /** vai no `<title>` */
  assunto: string
  /** a linha que o Gmail mostra ao lado do assunto, antes de abrir */
  previa: string
  /** o miolo, já em HTML (cada parte escapa o que é dado de gente) */
  corpo: string
}

/**
 * O e-mail inteiro em volta do miolo: topo com a logo, faixa colorida, cartão branco e rodapé
 * do parque. Devolve o HTML e a logo pra ir junto em `imagens`.
 */
export function moldeDoEmail(m: MoldeDoEmail): { html: string; imagens: ImagemEmbutida[] } {
  const site = SITE_OFICIAL
  const siteVisivel = site.replace(/^https?:\/\//, '').replace(/\/$/, '')
  const larguraLogo = Math.round(LOGO_EMAIL.largura / 2)
  const alturaLogo = Math.round(LOGO_EMAIL.altura / 2)
  const html = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">
<title>${escaparNoEmail(m.assunto)}</title></head>
<body style="margin:0;padding:0;background:${COR.fundo};-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${escaparNoEmail(m.previa)}</div>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" bgcolor="${COR.fundo}" style="background:${COR.fundo}">
  <tr><td align="center" style="padding:24px 12px 32px">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600"
           style="max-width:600px;width:100%;background:${COR.branco};border:1px solid ${COR.linha};border-radius:8px;overflow:hidden">
      <tr><td align="center" bgcolor="${COR.branco}" style="padding:28px 24px 22px;background:${COR.branco}">
        <img src="cid:${CID_LOGO}" alt="Conquista Park" width="${larguraLogo}" height="${alturaLogo}"
             style="display:block;width:${larguraLogo}px;height:auto;border:0;outline:none;text-decoration:none">
      </td></tr>
      <tr><td style="padding:0;font-size:0;line-height:0">${faixaDaMarca()}</td></tr>
      <tr><td style="padding:32px 28px 28px;font-family:${FONTE};color:${COR.corpo};font-size:15px;line-height:1.55">
${m.corpo}
      </td></tr>
      <tr><td bgcolor="${COR.uvaEscura}" style="background:${COR.uvaEscura};padding:22px 28px;font-family:${FONTE}">
        <div style="font-size:15px;font-weight:bold;color:${COR.branco}">Conquista Park</div>
        <div style="font-size:13px;color:${COR.uvaLinha};margin-top:4px">Parque aquático · Entre Gandu e Itamari, Bahia</div>
        <div style="font-size:13px;margin-top:10px">
          <a href="${escaparNoEmail(site)}" target="_blank" style="color:${COR.sol};text-decoration:none;font-weight:bold">${escaparNoEmail(siteVisivel)}</a>
        </div>
        <div style="font-size:12px;color:${COR.uvaLinha};margin-top:12px;line-height:1.5">
          Este e-mail foi enviado automaticamente pelo site do Conquista Park. Não precisa responder.
        </div>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`
  return { html, imagens: [imagemDaLogo()] }
}
