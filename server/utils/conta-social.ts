/**
 * conta-social.ts — a volta do Google/Apple até a sessão (ou até o cadastro que falta).
 *
 * `entrar-social.ts` diz QUEM é (id_token conferido); este arquivo decide o que fazer com isso:
 * conta que já existe entra; quem ainda não tem conta cai em `/conta/completar`, com o que o
 * provedor provou num pacote assinado de 15 minutos — falta o CPF e o celular, que o provedor não
 * tem.
 */
import { setCookie, type H3Event } from 'h3'
import { abrirSessaoDoCliente, contaDaIdentidadeSocial } from './conta-do-cliente'
import {
  assinarPacoteSocial, COOKIE_DO_CADASTRO_SOCIAL, concluirEntradaSocial, RecusaSocial,
  type ProvedorSocial,
} from './entrar-social'

/** Devolve o endereço (deste site) pra onde mandar a pessoa. */
export async function voltaDoProvedorSocial(event: H3Event, p: ProvedorSocial, params: {
  code?: unknown; state?: unknown; erro?: unknown; nomeDaApple?: string | null
}): Promise<string> {
  try {
    const { identidade, orgId, destino } = await concluirEntradaSocial(event, p, params)
    const conta = await contaDaIdentidadeSocial(orgId, identidade)
    if (conta) {
      await abrirSessaoDoCliente(event, conta.id)
      return destino
    }
    setCookie(event, COOKIE_DO_CADASTRO_SOCIAL, assinarPacoteSocial({
      provedor: identidade.provedor, sub: identidade.sub, email: identidade.email,
      emailVerificado: identidade.emailVerificado, nome: identidade.nome, org: orgId, volta: destino,
    }, 15), {
      httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/', maxAge: 900,
    })
    return `/conta/completar?volta=${encodeURIComponent(destino)}`
  } catch (e) {
    // só o CÓDIGO vai na URL (ver `MotivoDaRecusaSocial`); a frase é da tela
    if (e instanceof RecusaSocial) return `/conta/entrar?erro=${e.motivo}`
    throw e
  }
}
