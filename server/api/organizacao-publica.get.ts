/**
 * GET /api/organizacao-publica — quem vende: os dados da empresa que o SITE mostra.
 *
 * O site vendia sem razão social, CNPJ, endereço e canal de atendimento (auditoria PROD-08) — o
 * que o Decreto 7.962/2013 pede de qualquer loja na internet, e o que a pessoa precisa pra exercer
 * o direito de arrependimento (CDC art. 49) e os direitos da LGPD. O rodapé público e as páginas
 * /termos, /privacidade e /cancelamento leem daqui.
 *
 * Três regras:
 *
 * 1. **Só o que é público por natureza.** Nome, razão social, CNPJ/CPF, endereço, e-mail e
 *    telefone de atendimento e o encarregado de dados. Nunca chave do Asaas, carteira, contagem de
 *    cliente, dinheiro ou equipe — a consulta nem seleciona essas colunas.
 * 2. **Campo vazio não vem.** O master preenche em Configurações; enquanto não preenche, a tela
 *    dele mostra "a preencher" e o site OMITE a linha. Nada aqui é inventado nem tem valor padrão.
 * 3. **O CNPJ de exemplo da instalação não é de ninguém daqui.** `scripts/seed.mjs` grava
 *    00.000.000/0001-91 (Banco do Brasil) como documento da organização. Ele vale como ausente:
 *    o rodapé não pode dizer que quem vende é um banco (`ehDocumentoDeExemplo`).
 * 4. **Qual organização.** O produto é de um parque só: sem parâmetro, é a primeira organização
 *    cadastrada. Com `?evento=<slug>`, é a dona daquele evento (a página do evento já sabe qual é).
 *
 * Sem login, fora de `/api/admin/` de propósito — é o que o comprador anônimo lê.
 */
import { q, q1 } from '../utils/db'
import { ehDocumentoDeExemplo } from '../../app/composables/dadosDaEmpresa'

const SLUG = /^[a-z0-9-]{1,80}$/

export default defineEventHandler(async (event) => {
  const { evento } = getQuery(event) as { evento?: string }
  if (evento !== undefined && !SLUG.test(String(evento))) {
    throw createError({ statusCode: 400, statusMessage: 'Evento inválido.' })
  }

  const o = await q1<any>(
    `SELECT o.id, o.name, o.legal_name, o.document, o.address_line, o.address_district, o.address_city,
            o.address_state, o.address_zip, o.support_email, o.support_phone, o.privacy_contact
       FROM organizations o
      WHERE ${evento ? 'o.id = (SELECT e.org_id FROM events e WHERE e.slug = $1)' : 'true'}
      ORDER BY o.created_at, o.id
      LIMIT 1`, evento ? [evento] : [])
  if (!o) throw createError({ statusCode: 404, statusMessage: 'Organização não encontrada.' })

  // os dados mudam raramente, e quem edita espera ver no ar em seguida: um minuto de cache
  setHeader(event, 'Cache-Control', 'public, max-age=60')

  const texto = (v: unknown) => {
    const t = String(v ?? '').trim()
    return t ? t : undefined
  }
  const endereco = {
    linha: texto(o.address_line), bairro: texto(o.address_district),
    cidade: texto(o.address_city), uf: texto(o.address_state), cep: texto(o.address_zip),
  }
  const temEndereco = Object.values(endereco).some(Boolean)

  // O canal de atendimento da EMPRESA é o que o master preenche em Configurações. Enquanto ele
  // não preenche, a página de cancelamento não pode ficar sem caminho nenhum: o contato de suporte
  // que a equipe digitou em cada evento publicado (obrigatório no assistente) serve de reserva —
  // é dado que uma pessoa pôs no painel, não valor inventado.
  const reserva = !texto(o.support_email) && !texto(o.support_phone)
    ? await q<any>(
      `SELECT DISTINCT e.support_kind AS tipo, e.support_value AS valor
         FROM events e
        WHERE e.org_id = $1
          AND e.status = 'ativo' AND NOT e.is_private
          AND e.support_value IS NOT NULL AND e.support_kind IS NOT NULL
        LIMIT 3`, [o.id])
    : []

  // `undefined` some do JSON: o que não foi preenchido não viaja nem como null
  return {
    nome: texto(o.name),
    razaoSocial: texto(o.legal_name),
    documento: ehDocumentoDeExemplo(o.document) ? undefined : texto(o.document),
    endereco: temEndereco ? endereco : undefined,
    email: texto(o.support_email),
    telefone: texto(o.support_phone),
    encarregado: texto(o.privacy_contact),
    contatosDosEventos: reserva.length
      ? reserva.map((r) => ({ tipo: r.tipo as 'whatsapp' | 'telefone' | 'email', valor: String(r.valor) }))
      : undefined,
  }
})
