/**
 * ddd.ts — de onde vem o telefone.
 *
 * O cadastro do comprador não tem endereço, mas tem telefone, e o DDD é o
 * único sinal de origem que existe sem perguntar nada a ninguém. Serve pra
 * decidir onde anunciar e quanto estacionamento abrir — não serve como
 * endereço da pessoa, e a tela precisa dizer isso com todas as letras: quem
 * mudou de cidade levou o número junto.
 *
 * `REGIAO_DDD` só nomeia os DDDs da Bahia e os vizinhos que importam pra um
 * parque do interior; o resto fica no estado, que já responde a pergunta.
 */

export const DDD_UF: Record<string, string> = {
  11: 'SP', 12: 'SP', 13: 'SP', 14: 'SP', 15: 'SP', 16: 'SP', 17: 'SP', 18: 'SP', 19: 'SP',
  21: 'RJ', 22: 'RJ', 24: 'RJ',
  27: 'ES', 28: 'ES',
  31: 'MG', 32: 'MG', 33: 'MG', 34: 'MG', 35: 'MG', 37: 'MG', 38: 'MG',
  41: 'PR', 42: 'PR', 43: 'PR', 44: 'PR', 45: 'PR', 46: 'PR',
  47: 'SC', 48: 'SC', 49: 'SC',
  51: 'RS', 53: 'RS', 54: 'RS', 55: 'RS',
  61: 'DF', 62: 'GO', 63: 'TO', 64: 'GO', 65: 'MT', 66: 'MT', 67: 'MS',
  68: 'AC', 69: 'RO',
  71: 'BA', 73: 'BA', 74: 'BA', 75: 'BA', 77: 'BA',
  79: 'SE',
  81: 'PE', 82: 'AL', 83: 'PB', 84: 'RN', 85: 'CE', 86: 'PI',
  87: 'PE', 88: 'CE', 89: 'PI',
  91: 'PA', 92: 'AM', 93: 'PA', 94: 'PA', 95: 'RR', 96: 'AP', 97: 'AM', 98: 'MA', 99: 'MA',
}

export const REGIAO_DDD: Record<string, string> = {
  71: 'Salvador e região metropolitana',
  73: 'Sul da Bahia — Itabuna, Ilhéus, Ubatã, Gandu',
  74: 'Norte da Bahia — Juazeiro, Irecê',
  75: 'Feira de Santana e recôncavo',
  77: 'Oeste e sudoeste — Barreiras, Vitória da Conquista',
  79: 'Sergipe — Aracaju',
  81: 'Recife e região',
  61: 'Distrito Federal',
}
