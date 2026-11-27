/**
 * Ícones dos produtos das comandas (055): um por produto e por categoria.
 *
 * O banco guarda o EMOJI (🍟, 💧…) — é a "chave" do ícone. Na tela, quem desenha é
 * `components/comanda/Icone.vue`: se existe a ilustração 3D daquele emoji em
 * `public/comandas/icones/<código>.webp`, mostra ela (igual em qualquer tablet, sem depender
 * do emoji do Android/Windows); senão mostra o próprio emoji.
 *
 * As ilustrações são o Fluent Emoji 3D da Microsoft (licença MIT), já em webp 160px.
 *
 * O gerente pode escolher o ícone no cadastro (Gestão → Produtos). Sem escolha, o tablet
 * acha um pelo nome ("Batata frita" → 🍟, "Água" → 💧); sem nada parecido, usa o da
 * categoria e, por último, 🍽️.
 */

/** palavra (sem acento, minúscula) → emoji. A primeira da lista que aparecer no nome vence. */
const POR_PALAVRA: [string, string][] = [
  ['batata', '🍟'], ['fritas', '🍟'], ['misto', '🥪'], ['sanduiche', '🥪'], ['hamburguer', '🍔'], ['burger', '🍔'], ['x-', '🍔'],
  ['cachorro', '🌭'], ['hot dog', '🌭'], ['pastel', '🥟'], ['coxinha', '🍗'], ['frango', '🍗'], ['galeto', '🍗'], ['peixe', '🐟'],
  ['isca', '🐟'], ['tilapia', '🐟'], ['camarao', '🍤'], ['costela', '🍖'], ['carne', '🥩'], ['picanha', '🥩'], ['bacon', '🥓'],
  ['calabresa', '🌭'], ['linguica', '🌭'], ['aipim', '🍠'], ['mandioca', '🍠'], ['macaxeira', '🍠'], ['pizza', '🍕'],
  ['macarrao', '🍝'], ['espaguete', '🍝'], ['marmita', '🍱'], ['prato', '🍛'], ['feijoada', '🍛'], ['moqueca', '🍲'],
  ['caldo', '🍜'], ['sopa', '🍜'], ['salada', '🥗'], ['arroz', '🍚'], ['ovo', '🍳'], ['tapioca', '🫓'], ['queijo', '🧀'],
  ['salgado', '🥐'], ['pao', '🍞'], ['bolo', '🍰'], ['torta', '🥧'], ['pudim', '🍮'], ['brigadeiro', '🍫'], ['chocolate', '🍫'],
  ['pirulito', '🍭'], ['bala', '🍬'], ['doce', '🍬'], ['biscoito', '🍪'], ['cookie', '🍪'], ['rosquinha', '🍩'], ['donut', '🍩'],
  ['waffle', '🧇'], ['panqueca', '🥞'], ['picole', '🍦'], ['acai', '🍨'], ['sorvete', '🍦'], ['casquinha', '🍦'],
  ['raspadinha', '🍧'], ['milho', '🌽'], ['pipoca', '🍿'], ['amendoim', '🥜'], ['agua de coco', '🥥'], ['coco', '🥥'],
  ['agua', '💧'], ['refrigerante', '🥤'], ['refri', '🥤'], ['coca', '🥤'], ['guarana', '🥤'], ['suco', '🧃'],
  ['milk', '🧋'], ['vitamina', '🥛'], ['leite', '🥛'], ['cafe', '☕'], ['cha', '🍵'], ['mate', '🧉'], ['energetico', '⚡'],
  ['cerveja', '🍺'], ['chopp', '🍺'], ['litrao', '🍺'], ['long neck', '🍺'], ['balde', '🪣'], ['caipirinha', '🍹'],
  ['caipiroska', '🍹'], ['batida', '🍹'], ['espumante', '🥂'], ['champanhe', '🍾'], ['drink', '🍸'], ['gin', '🍸'],
  ['vinho', '🍷'], ['whisky', '🥃'], ['dose', '🥃'], ['cachaca', '🥃'], ['vodka', '🥃'], ['espetinho', '🍢'], ['espeto', '🍢'],
  ['isotonico', '🥤'], ['armario', '🔐'], ['oculos de sol', '🕶️'], ['oculos', '🥽'], ['gelo', '🧊'], ['cigarro', '🚬'],
  ['protetor', '🧴'], ['boia', '🛟'], ['toalha', '🧺'], ['bone', '🧢'], ['camiseta', '👕'], ['camisa', '👕'],
  ['chinelo', '🩴'], ['maio', '🩱'], ['biquini', '🩱'], ['guarda-sol', '⛱️'], ['ingresso', '🎟️'], ['balao', '🎈'],
  ['pelucia', '🧸'], ['papel', '🧻'], ['sabonete', '🧼'], ['carregador', '🔋'], ['melancia', '🍉'], ['abacaxi', '🍍'],
  ['manga', '🥭'], ['banana', '🍌'], ['morango', '🍓'], ['limao', '🍋'], ['uva', '🍇'], ['abacate', '🥑'], ['laranja', '🍊'],
  ['porcao', '🍽️'],
]
const POR_CATEGORIA: [string, string][] = [
  ['cerveja', '🍺'], ['drink', '🍹'], ['bebida', '🥤'], ['porc', '🍟'], ['lanche', '🥪'], ['prato', '🍲'], ['refei', '🍲'],
  ['sobremesa', '🍦'], ['sorve', '🍦'], ['doce', '🍫'], ['petisc', '🍟'], ['cafe', '☕'], ['fruta', '🍉'], ['praia', '⛱️'],
  ['aluguel', '⛱️'], ['loja', '🛍️'], ['outro', '🛍️'], ['conveni', '🛍️'],
]

const limpo = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

export function iconeDaCategoria(c: { nome: string; icone?: string | null } | undefined | null): string {
  if (!c) return '🍽️'
  if (c.icone) return c.icone
  const n = limpo(c.nome)
  return POR_CATEGORIA.find(([p]) => n.includes(p))?.[1] ?? '🍽️'
}

export function iconeDoItem(i: { nome: string; icone?: string | null }, categoria?: { nome: string; icone?: string | null } | null): string {
  if (i.icone) return i.icone
  // só no começo de palavra: "cha" é chá, não o meio de "cachaça"
  const n = ` ${limpo(i.nome)}`
  return POR_PALAVRA.find(([p]) => n.includes(` ${p}`))?.[1] ?? iconeDaCategoria(categoria)
}

/** a paleta do cadastro, em grupos, com o nome que a busca procura */
export const GRUPOS_DE_ICONES: { grupo: string; icones: { e: string; nome: string }[] }[] = [
  { grupo: 'Lanches e porções', icones: [
    { e: '🍟', nome: 'Batata frita' }, { e: '🍔', nome: 'Hambúrguer' }, { e: '🥪', nome: 'Sanduíche' }, { e: '🌭', nome: 'Cachorro-quente' },
    { e: '🥟', nome: 'Pastel' }, { e: '🥐', nome: 'Salgado' }, { e: '🍗', nome: 'Frango' }, { e: '🍤', nome: 'Camarão frito' },
    { e: '🦐', nome: 'Camarão' }, { e: '🐟', nome: 'Peixe' }, { e: '🥩', nome: 'Carne' }, { e: '🍖', nome: 'Costela' },
    { e: '🥓', nome: 'Bacon' }, { e: '🍢', nome: 'Espetinho' }, { e: '🍠', nome: 'Aipim' }, { e: '🧀', nome: 'Queijo' },
    { e: '🍕', nome: 'Pizza' }, { e: '🌮', nome: 'Taco' }, { e: '🌯', nome: 'Wrap' }, { e: '🫓', nome: 'Tapioca' },
    { e: '🍞', nome: 'Pão' }, { e: '🥚', nome: 'Ovo' }, { e: '🍳', nome: 'Ovo frito' }, { e: '🍿', nome: 'Pipoca' },
    { e: '🥜', nome: 'Amendoim' }, { e: '🌽', nome: 'Milho' },
  ] },
  { grupo: 'Pratos', icones: [
    { e: '🍽️', nome: 'Refeição' }, { e: '🍛', nome: 'Prato feito' }, { e: '🍲', nome: 'Moqueca' }, { e: '🥘', nome: 'Panelada' },
    { e: '🍜', nome: 'Caldo' }, { e: '🍝', nome: 'Macarrão' }, { e: '🥗', nome: 'Salada' }, { e: '🍚', nome: 'Arroz' },
    { e: '🍱', nome: 'Marmita' },
  ] },
  { grupo: 'Doces e sorvetes', icones: [
    { e: '🍦', nome: 'Sorvete' }, { e: '🍨', nome: 'Açaí' }, { e: '🍧', nome: 'Raspadinha' }, { e: '🍰', nome: 'Fatia de bolo' },
    { e: '🎂', nome: 'Bolo' }, { e: '🥧', nome: 'Torta' }, { e: '🍮', nome: 'Pudim' }, { e: '🍫', nome: 'Chocolate' },
    { e: '🍬', nome: 'Bala' }, { e: '🍭', nome: 'Pirulito' }, { e: '🍩', nome: 'Rosquinha' }, { e: '🍪', nome: 'Biscoito' },
    { e: '🧇', nome: 'Waffle' }, { e: '🥞', nome: 'Panqueca' }, { e: '🍡', nome: 'Doce no palito' },
  ] },
  { grupo: 'Bebidas', icones: [
    { e: '💧', nome: 'Água' }, { e: '🥤', nome: 'Refrigerante' }, { e: '🧃', nome: 'Suco' }, { e: '🥥', nome: 'Água de coco' },
    { e: '⚡', nome: 'Energético' }, { e: '☕', nome: 'Café' }, { e: '🍵', nome: 'Chá' }, { e: '🧋', nome: 'Milk-shake' },
    { e: '🥛', nome: 'Leite e vitamina' }, { e: '🧉', nome: 'Mate' }, { e: '🧊', nome: 'Gelo' },
  ] },
  { grupo: 'Bebidas alcoólicas', icones: [
    { e: '🍺', nome: 'Cerveja e chopp' }, { e: '🍻', nome: 'Rodada' }, { e: '🪣', nome: 'Balde' }, { e: '🍹', nome: 'Caipirinha' },
    { e: '🍸', nome: 'Drink' }, { e: '🍷', nome: 'Vinho' }, { e: '🥂', nome: 'Espumante' }, { e: '🍾', nome: 'Garrafa' },
    { e: '🥃', nome: 'Dose' }, { e: '🍶', nome: 'Cachaça' },
  ] },
  { grupo: 'Frutas', icones: [
    { e: '🍉', nome: 'Melancia' }, { e: '🍍', nome: 'Abacaxi' }, { e: '🥭', nome: 'Manga' }, { e: '🍌', nome: 'Banana' },
    { e: '🍓', nome: 'Morango' }, { e: '🍋', nome: 'Limão' }, { e: '🍇', nome: 'Uva' }, { e: '🥑', nome: 'Abacate' },
    { e: '🍊', nome: 'Laranja' },
  ] },
  { grupo: 'Loja e serviços', icones: [
    { e: '🛍️', nome: 'Conveniência' }, { e: '🧴', nome: 'Protetor solar' }, { e: '🛟', nome: 'Boia' }, { e: '🥽', nome: 'Óculos de natação' },
    { e: '🕶️', nome: 'Óculos de sol' }, { e: '🧢', nome: 'Boné' }, { e: '👕', nome: 'Camiseta' }, { e: '🩴', nome: 'Chinelo' },
    { e: '🩱', nome: 'Maiô' }, { e: '⛱️', nome: 'Guarda-sol' }, { e: '🧺', nome: 'Toalha' }, { e: '🔐', nome: 'Armário' },
    { e: '🎟️', nome: 'Ingresso' }, { e: '🎈', nome: 'Balão' }, { e: '🧸', nome: 'Pelúcia' }, { e: '🔋', nome: 'Carregador' },
    { e: '🧼', nome: 'Sabonete' }, { e: '🧻', nome: 'Papel' }, { e: '🚬', nome: 'Cigarro' },
  ] },
]

export const ICONES_PARA_ESCOLHER = GRUPOS_DE_ICONES.flatMap((g) => g.icones.map((i) => i.e))

/** nome do ícone (o da paleta), para leitura de tela e busca */
const NOME_DO_ICONE = new Map(GRUPOS_DE_ICONES.flatMap((g) => g.icones.map((i) => [i.e, i.nome] as const)))
export const nomeDoIcone = (e: string) => NOME_DO_ICONE.get(e) ?? ''

/** busca na paleta pelo nome do ícone ("cerv" acha 🍺) */
export function buscarIcones(texto: string) {
  const t = limpo(texto.trim())
  if (!t) return GRUPOS_DE_ICONES
  return GRUPOS_DE_ICONES
    .map((g) => ({ ...g, icones: g.icones.filter((i) => limpo(i.nome).includes(t) || limpo(g.grupo).includes(t)) }))
    .filter((g) => g.icones.length)
}

/** código do arquivo da ilustração: 🍽️ → "1f37d" (sem o seletor de variação FE0F) */
const codigo = (e: string) => [...e].map((c) => c.codePointAt(0)!).filter((c) => c !== 0xfe0f).map((c) => c.toString(16)).join('-')
const COM_ILUSTRACAO = new Set(ICONES_PARA_ESCOLHER.map(codigo))

/** caminho da ilustração 3D do emoji, ou null quando não temos (aí a tela mostra o emoji) */
export function imagemDoIcone(e: string | null | undefined): string | null {
  if (!e) return null
  const c = codigo(e)
  return COM_ILUSTRACAO.has(c) ? `/comandas/icones/${c}.webp` : null
}
