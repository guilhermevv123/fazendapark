/**
 * O que todo evento do Conquista Park tem de igual (dono, 05/10: "categorias já predefinidas, sem
 * ficar em aberto"; "endereço é fixo, o do Fazenda Park").
 *
 * Um lugar só, usado pela criação (`/admin/evento/novo`) e pelas Configurações do evento: as duas
 * telas oferecem as MESMAS categorias e gravam o MESMO endereço — duas listas divergiriam no
 * primeiro dia em que alguém mexesse numa.
 */

/** Categoria → subcategorias que ela oferece. A ordem é a da tela. */
export const CATEGORIAS_DO_PARQUE: Record<string, string[]> = {
  'Parque aquático': ['Dia de parque', 'Fim de semana', 'Feriado', 'Férias', 'Passaporte', 'Promoção'],
  'Festa': ['Pool party', 'São João', 'Carnaval', 'Réveillon', 'Aniversário do parque', 'Festa à fantasia'],
  'Show': ['Forró', 'Pagode', 'Sertanejo', 'Arrocha', 'Axé', 'Piseiro', 'Gospel', 'Banda local'],
  'Festival': ['Música', 'Gastronomia', 'Cultural'],
  'Infantil': ['Dia das Crianças', 'Recreação', 'Personagens', 'Colônia de férias'],
  'Grupos e excursões': ['Escola', 'Empresa', 'Igreja', 'Excursão'],
  'Esporte': ['Corrida', 'Natação', 'Torneio', 'Campeonato'],
}
export const NOMES_DAS_CATEGORIAS = Object.keys(CATEGORIAS_DO_PARQUE)

/** As subcategorias da categoria (vazio pra categoria antiga que saiu da lista). */
export const subcategoriasDe = (categoria: string | null | undefined) =>
  (categoria && CATEGORIAS_DO_PARQUE[categoria]) || []

/**
 * Fazenda Park Nova Conquista — o ponto do Google Maps que o dono mandou
 * (https://maps.app.goo.gl/AWbncf9LsfSvzaT7A → -13.937816, -39.4888029). Zona rural entre Itamaraty e
 * Gandu, a 2 km da BR-101, CEP 45550-000. Pro cliente a cidade é "Entre Gandu e Itamaraty" (dono, 09/10:
 * nada de Ubatã no site).
 */
export const LOCAL_DO_PARQUE = {
  nome: 'Fazenda Park Nova Conquista',
  cep: '45550-000',
  endereco: 'Zona rural, a 2 km da BR-101 (entre Itamaraty e Gandu)',
  numero: 's/n',
  bairro: 'Zona rural',
  cidade: 'Entre Gandu e Itamaraty',
  estado: 'BA',
  complemento: '',
} as const

export const MAPA_DO_PARQUE = 'https://maps.app.goo.gl/AWbncf9LsfSvzaT7A'

/**
 * O contato de suporte do evento é um TELEFONE (dono, 05/10: "aqui é o número de telefone"), e
 * nasce com o WhatsApp oficial do parque — o mesmo número da atendente (instância `guilherme`).
 * Antes o campo aceitava qualquer texto: um evento foi ao ar com "73999056Q3123".
 */
export const CONTATO_DO_PARQUE = { tipo: 'whatsapp' as const, valor: '(73) 99842-1010' }

/** DDD + número: 10 dígitos (fixo) ou 11 (celular). */
export const telefoneValido = (v: string | null | undefined) => /^\d{10,11}$/.test(String(v ?? '').replace(/\D/g, ''))
