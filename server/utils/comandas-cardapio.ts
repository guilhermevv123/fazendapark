/**
 * O cardápio PADRÃO da comanda (055): o que todo parque aquático vende, já separado por
 * categoria. Um clique em "Usar cardápio padrão" cria tudo; o gerente ajusta preço, apaga o
 * que não vende e cria o que faltar. Preços são sugestão (pedido do dono, 11/11/2026).
 * `+18` marca bebida alcoólica: a pulseira de menor não lança esses itens.
 */
export interface ItemPadrao { nome: string; preco: number; maior18?: boolean }

export const CARDAPIO_PADRAO: { categoria: string; itens: ItemPadrao[] }[] = [
  { categoria: 'Bebidas', itens: [
    { nome: 'Água mineral', preco: 5 }, { nome: 'Água com gás', preco: 6 }, { nome: 'Refrigerante lata', preco: 7 },
    { nome: 'Refrigerante 2 L', preco: 15 }, { nome: 'Suco natural', preco: 10 }, { nome: 'Água de coco', preco: 8 },
    { nome: 'Energético', preco: 15 }, { nome: 'Isotônico', preco: 9 },
  ] },
  { categoria: 'Cervejas', itens: [
    { nome: 'Cerveja lata', preco: 8, maior18: true }, { nome: 'Cerveja long neck', preco: 12, maior18: true },
    { nome: 'Cerveja litrão', preco: 18, maior18: true }, { nome: 'Balde 6 long necks', preco: 65, maior18: true },
  ] },
  { categoria: 'Drinks', itens: [
    { nome: 'Caipirinha', preco: 18, maior18: true }, { nome: 'Caipiroska', preco: 20, maior18: true },
    { nome: 'Batida', preco: 18, maior18: true }, { nome: 'Dose de cachaça', preco: 8, maior18: true },
    { nome: 'Dose de whisky', preco: 18, maior18: true },
  ] },
  { categoria: 'Lanches', itens: [
    { nome: 'Misto quente', preco: 12 }, { nome: 'Hambúrguer', preco: 22 }, { nome: 'Cachorro-quente', preco: 14 },
    { nome: 'Pastel', preco: 10 }, { nome: 'Coxinha', preco: 8 }, { nome: 'Pão de queijo', preco: 6 },
  ] },
  { categoria: 'Porções', itens: [
    { nome: 'Batata frita', preco: 30 }, { nome: 'Calabresa acebolada', preco: 38 }, { nome: 'Frango a passarinho', preco: 42 },
    { nome: 'Isca de peixe', preco: 45 }, { nome: 'Aipim frito', preco: 28 }, { nome: 'Carne do sol com aipim', preco: 55 },
  ] },
  { categoria: 'Pratos', itens: [
    { nome: 'Prato feito', preco: 30 }, { nome: 'Prato kids', preco: 22 }, { nome: 'Espetinho', preco: 10 },
  ] },
  { categoria: 'Sobremesas', itens: [
    { nome: 'Picolé', preco: 6 }, { nome: 'Sorvete casquinha', preco: 8 }, { nome: 'Açaí 300 ml', preco: 18 }, { nome: 'Açaí 500 ml', preco: 25 },
  ] },
  { categoria: 'Outros', itens: [
    { nome: 'Protetor solar', preco: 35 }, { nome: 'Boia', preco: 25 }, { nome: 'Óculos de natação', preco: 30 },
    { nome: 'Toalha', preco: 40 }, { nome: 'Armário', preco: 15 },
  ] },
]

/**
 * Os 5 locais que vendem no Conquista Park (o dono, 11/11/2026) e o que cada um vende — o
 * tablet de cada local só mostra essas categorias. O gerente muda em Gestão → Locais de venda.
 */
export const PONTOS_PADRAO: { nome: string; categorias: string[] }[] = [
  { nome: 'Restaurante', categorias: ['Pratos', 'Porções', 'Bebidas', 'Cervejas', 'Sobremesas'] },
  { nome: 'Petiscaria', categorias: ['Porções', 'Lanches', 'Bebidas', 'Cervejas', 'Drinks'] },
  { nome: 'Conveniência e Sorveteria', categorias: ['Sobremesas', 'Bebidas', 'Lanches', 'Outros'] },
  { nome: "Bar D'água", categorias: ['Bebidas', 'Cervejas', 'Drinks', 'Porções'] },
  { nome: 'Bar Principal', categorias: ['Bebidas', 'Cervejas', 'Drinks', 'Porções', 'Lanches'] },
]
