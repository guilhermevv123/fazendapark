/**
 * documento.ts — validação de CPF.
 *
 * Mora num util e não dentro do checkout porque agora tem dois caixas: o site
 * e o guichê. Regra de documento copiada é regra que aceita no balcão o CPF
 * que o site recusa, e o furo só aparece na meia-entrada barrada na portaria.
 */

/**
 * Rejeita os repetidos (111.111.111-11) de propósito: eles passam na conta do
 * dígito verificador e são o que aparece quando alguém quer "só preencher".
 */
export function cpfValido(cpf: string): boolean {
  const d = cpf.replace(/\D/g, '')
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false
  let soma = 0
  for (let i = 0; i < 9; i++) soma += Number(d[i]) * (10 - i)
  let r = (soma * 10) % 11
  if (r === 10) r = 0
  if (r !== Number(d[9])) return false
  soma = 0
  for (let i = 0; i < 10; i++) soma += Number(d[i]) * (11 - i)
  r = (soma * 10) % 11
  if (r === 10) r = 0
  return r === Number(d[10])
}
