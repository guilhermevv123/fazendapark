/**
 * Para onde a cobrança VAI de fato — e por que a tela não pode ler isso do `<select>`.
 *
 * `utils/asaas.ts` decide a URL do gateway pelo PREFIXO da chave (`ambienteDaChave`): `_prod_` bate
 * na produção, `_hmlg_` no sandbox, e só a chave sem prefixo conhecido deixa a configuração
 * (`organizations.asaas_env`) desempatar. A tela, até 27/09, mostrava a configuração. O resultado
 * (auditoria ORG-01, P0): com a chave de sandbox gravada, trocar só o `<select>` pra "Produção" e
 * salvar deixava o selo dizendo PRODUÇÃO/RECEBENDO enquanto o checkout gerava PIX de sandbox que
 * ninguém consegue pagar — e, no caminho inverso, o selo "Testes (sandbox) — ninguém é cobrado"
 * em cima de uma chave de produção que cobra de verdade.
 *
 * Duas regras moram aqui, e as duas leem o prefixo pela MESMA função que escolhe a URL:
 *
 * 1. **O selo mostra o ambiente efetivo** (`ambienteEfetivo`): a mesma conta de `baseUrl()`.
 * 2. **A troca que não muda nada é recusada** (`recusaDeAmbiente`): chave e ambiente têm que
 *    concordar DEPOIS do salvamento — a chave que vai ficar (a colada agora ou a já gravada) e o
 *    ambiente que vai ficar. Produção exige chave de produção; testes não aceita chave de produção.
 *
 * Mora fora de `asaas.ts` de propósito (aquele arquivo é de outra trilha nesta rodada); o prefixo
 * NÃO é copiado — é importado de lá, pra as duas pontas nunca discordarem sobre o que é produção.
 */
import { ambienteDaChave } from './asaas'

export type AmbienteAsaas = 'sandbox' | 'production'

/** Onde a cobrança bate: o prefixo da chave manda; a configuração só vale pra chave sem prefixo. */
export function ambienteEfetivo(
  chave: string | null | undefined,
  configurado: AmbienteAsaas | string | null | undefined,
): AmbienteAsaas {
  const daChave = ambienteDaChave(chave)
  if (daChave) return daChave
  return configurado === 'production' ? 'production' : 'sandbox'
}

/** A chave gravada diz um ambiente e a configuração diz outro (estado que a tela precisa gritar). */
export function ambienteDivergente(
  chave: string | null | undefined,
  configurado: AmbienteAsaas | string | null | undefined,
): boolean {
  const daChave = ambienteDaChave(chave)
  return !!daChave && !!configurado && daChave !== configurado
}

const NOME: Record<AmbienteAsaas, string> = { production: 'PRODUÇÃO', sandbox: 'TESTES (sandbox)' }

/**
 * A frase da recusa, ou `null` quando chave e ambiente concordam depois do salvamento.
 *
 * `chaveFinal` é a chave que vai ficar gravada: a colada agora, a que já estava (quando o corpo
 * não mexe na chave) ou `null` (removida / nunca houve). `chaveNova` diz se ela veio do corpo —
 * só muda a frase ("a chave colada" × "a chave gravada").
 */
export function recusaDeAmbiente(p: {
  chaveFinal: string | null | undefined
  ambienteFinal: AmbienteAsaas
  chaveNova: boolean
}): string | null {
  const daChave = ambienteDaChave(p.chaveFinal)
  const qual = p.chaveNova ? 'A chave colada' : 'A chave gravada'

  if (p.ambienteFinal === 'production') {
    if (!p.chaveFinal) {
      return 'Produção sem chave do Asaas geraria cobrança de verdade que nunca confirma. '
        + 'Informe a chave de produção junto com a troca de ambiente.'
    }
    if (daChave !== 'production') {
      return `${qual} não é de produção (as de produção começam com $aact_prod_). `
        + 'Trocar só o ambiente não muda para onde a cobrança vai — o comprador receberia um PIX '
        + 'de testes que ninguém consegue pagar. Cole a chave de produção junto com a troca.'
    }
    return null
  }

  if (daChave === 'production') {
    return `${qual} é de PRODUÇÃO e o ambiente escolhido é ${NOME.sandbox}. `
      + 'A cobrança continuaria saindo de verdade enquanto a tela diria "ninguém é cobrado". '
      + 'Cole uma chave de testes ($aact_hmlg_…) junto com a troca, ou remova a chave.'
  }
  return null
}
