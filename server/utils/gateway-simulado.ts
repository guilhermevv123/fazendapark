/**
 * Gateway simulado — só pra rodar o fluxo inteiro na máquina sem chave do Asaas.
 *
 * Existe porque o caminho que mais quebra em sistema de ingresso é o que vai do
 * "paguei" até o "ingresso na mão", e ele não pode ficar sem exercício até
 * alguém lembrar de configurar credencial.
 *
 * Três travas pra isto nunca virar buraco em produção:
 *   1. só liga com PAGAMENTO_SIMULADO=1 no .env;
 *   2. se NODE_ENV=production, `ligado()` devolve false mesmo com a variável;
 *   3. o id da cobrança nasce com prefixo `sim_`, então dá pra varrer o banco
 *      e provar que nenhum pedido de verdade passou por aqui.
 */
import { randomUUID } from 'node:crypto'
import QRCode from 'qrcode'

export function ligado(): boolean {
  if (process.env.NODE_ENV === 'production') return false
  return process.env.PAGAMENTO_SIMULADO === '1'
}

export interface CobrancaSimulada {
  id: string
  invoiceUrl: string | null
  simulado: true
}

export async function criarCobrancaSimulada(dados: {
  value: number
  description: string
  externalReference: string
}): Promise<CobrancaSimulada> {
  return {
    id: `sim_${randomUUID()}`,
    invoiceUrl: null,
    simulado: true,
  }
}

/**
 * PIX falso com a cara do verdadeiro: payload no formato EMV (BR Code), com
 * os mesmos campos e o mesmo CRC16 do real. O app de banco vai recusar — a
 * chave não existe —, mas a tela, o copia-e-cola e o QR se comportam igual.
 */
export async function pixSimulado(valorReais: number, referencia: string) {
  const payload = montarBrCode({
    chave: 'simulado@conquistapark.dev',
    nome: 'CONQUISTA PARK SIM',
    cidade: 'UBATA',
    valor: valorReais,
    txid: referencia.replace(/\W/g, '').slice(0, 25).toUpperCase(),
  })
  const dataUrl = await QRCode.toDataURL(payload, { margin: 1, width: 400 })
  return { payload, encodedImage: dataUrl.split(',')[1] }
}

/** Campo EMV: id + tamanho em 2 dígitos + valor. */
function campo(id: string, valor: string) {
  return id + String(valor.length).padStart(2, '0') + valor
}

function montarBrCode(d: {
  chave: string; nome: string; cidade: string; valor: number; txid: string
}) {
  const conta = campo('00', 'br.gov.bcb.pix') + campo('01', d.chave)
  const semCrc =
    campo('00', '01') +
    campo('26', conta) +
    campo('52', '0000') +
    campo('53', '986') +
    campo('54', d.valor.toFixed(2)) +
    campo('58', 'BR') +
    campo('59', d.nome.slice(0, 25)) +
    campo('60', d.cidade.slice(0, 15)) +
    campo('62', campo('05', d.txid || '***')) +
    '6304'
  return semCrc + crc16(semCrc)
}

/** CRC16/CCITT-FALSE, que é o que o BR Code manda. */
function crc16(s: string): string {
  let crc = 0xffff
  for (let i = 0; i < s.length; i++) {
    crc ^= s.charCodeAt(i) << 8
    for (let b = 0; b < 8; b++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0')
}
