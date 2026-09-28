/**
 * GET /api/admin/organizacao — o cadastro da própria organização.
 *
 * **A chave do Asaas nunca sai daqui.** A tela precisa de duas informações
 * sobre ela — se existe e qual é o fim dela, pra conferir que é a certa — e
 * nada mais. Devolver a chave inteira num JSON a coloca no cache do
 * navegador, no log do proxy e no print que alguém manda no grupo.
 *
 * Por isso `chaveFinal` traz só os 6 últimos caracteres, que é o suficiente
 * pra alguém comparar com o que está no painel do Asaas e concluir "é essa".
 *
 * **O ambiente que a tela mostra é o EFETIVO** (`ambienteEfetivo`), o mesmo que
 * escolhe a URL do gateway: o prefixo da chave manda e a configuração só
 * desempata chave sem prefixo. Mostrar a configuração crua foi o ORG-01 (P0):
 * selo "TESTES — ninguém é cobrado" em cima de chave de produção cobrando de
 * verdade. `ambienteDivergente` avisa quando o banco já está nesse estado.
 */
import { q1 } from '../../utils/db'
import { ambienteDivergente, ambienteEfetivo } from '../../utils/asaas-ambiente'
import { CofreFechado, finalDoSegredo } from '../../utils/cofre'
import { pixPeloMercadoPago, urlDoAviso } from '../../utils/mercadopago-conta'
import { baseDoSite } from '../../utils/envio'

function finalSemCofreFechado(guardado: string | null) {
  try { return finalDoSegredo(guardado) } catch (e) { if (e instanceof CofreFechado) return null; throw e }
}

export default defineEventHandler(async (event) => {
  const orgId = (event.context as any).sessao?.orgId
  if (!orgId) throw createError({ statusCode: 401, statusMessage: 'Sessão sem organização' })

  const o = await q1<any>(
    `SELECT o.id, o.name, o.slug, o.document, o.asaas_env, o.asaas_wallet, o.created_at,
            o.asaas_api_key, o.asaas_api_key IS NOT NULL AS tem_chave,
            o.mp_access_token, o.mp_access_token IS NOT NULL AS tem_token_mp,
            o.mp_webhook_secret IS NOT NULL AS tem_segredo_mp, o.mp_user_id, o.mp_test,
            o.legal_name, o.address_line, o.address_district, o.address_city, o.address_state,
            o.address_zip, o.support_email, o.support_phone, o.privacy_contact,
            (SELECT count(*)::int FROM events WHERE org_id = o.id) AS eventos,
            (SELECT count(*)::int FROM users  WHERE org_id = o.id AND active) AS pessoas,
            (SELECT count(*)::int FROM customers WHERE org_id = o.id) AS clientes
       FROM organizations o WHERE o.id = $1`, [orgId])
  if (!o) throw createError({ statusCode: 404, statusMessage: 'Organização não encontrada' })

  return {
    id: o.id, nome: o.name, slug: o.slug, documento: o.document,
    ambienteAsaas: o.asaas_env, carteiraAsaas: o.asaas_wallet,
    // para onde a cobrança vai de fato — é este que o selo mostra
    ambienteEfetivo: ambienteEfetivo(o.asaas_api_key, o.asaas_env),
    ambienteDivergente: ambienteDivergente(o.asaas_api_key, o.asaas_env),
    // os 6 últimos da chave ABERTA (no banco ela pode estar no cofre, e o fim do cifrado não diz
    // qual chave é); cofre que não abre neste servidor: sem final, e a saúde acusa
    temChave: o.tem_chave, chaveFinal: o.tem_chave ? finalSemCofreFechado(o.asaas_api_key) : null,
    // Pix pelo Mercado Pago (28/09). Do token, só o fim — a mesma regra da chave do Asaas.
    mercadoPago: (() => {
      const p = pixPeloMercadoPago(o)
      return {
        temToken: o.tem_token_mp,
        tokenFinal: o.tem_token_mp ? finalSemCofreFechado(o.mp_access_token) : null,
        contaDeTeste: !!o.mp_test,
        contaId: o.mp_user_id ?? null,
        temSegredo: o.tem_segredo_mp,
        // é isto que decide: com o token certo, TODO Pix do site sai pelo MP
        pixPeloMercadoPago: p.ok,
        motivo: p.ok ? null : p.motivo,
        // o endereço pra colar no painel do MP (opcional: é de lá que sai a assinatura secreta)
        urlDoAviso: urlDoAviso(baseDoSite(), o.id),
      }
    })(),
    eventos: o.eventos, pessoas: o.pessoas, clientes: o.clientes,
    criadoEm: o.created_at,
    // o que o site público mostra (rodapé, termos, privacidade, cancelamento) — PROD-08.
    // Vazio aqui vira "a preencher" na tela do master; o site omite a linha.
    razaoSocial: o.legal_name,
    endereco: {
      linha: o.address_line, bairro: o.address_district, cidade: o.address_city,
      uf: o.address_state, cep: o.address_zip,
    },
    emailAtendimento: o.support_email,
    telefoneAtendimento: o.support_phone,
    encarregadoDados: o.privacy_contact,
  }
})
