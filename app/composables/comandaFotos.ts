/**
 * Fotos reais dos produtos das comandas (057).
 *
 * Ordem do que aparece no tablet e na gestão:
 *  1. a foto que o dono enviou no painel (`item.foto` = `/api/cardapio-foto/<id>.webp`);
 *  2. `item.foto = 'nenhuma'`: só o ícone;
 *  3. automática: a foto pronta pelo NOME do produto (`public/comandas/fotos/<arquivo>.webp`,
 *     fotos livres do Wikimedia Commons, créditos em `public/comandas/fotos/CREDITOS.md`);
 *  4. sem foto pronta para o nome: o ícone (`comandaIcones.ts`).
 */

/** [começo de palavra no nome, arquivo]: o primeiro que casar vale, então o específico vem antes */
const POR_NOME: [string, string][] = [
  ['agua de coco', 'agua-de-coco'], ['agua com gas', 'agua-com-gas'], ['agua tonica', 'agua-com-gas'], ['agua', 'agua-mineral'],
  ['refrigerante 2', 'refrigerante-garrafa'], ['refrigerante 1', 'refrigerante-garrafa'], ['refrigerante 600', 'refrigerante-garrafa'],
  ['refri', 'refrigerante-lata'], ['coca', 'refrigerante-lata'], ['guarana', 'refrigerante-lata'], ['fanta', 'refrigerante-lata'],
  ['suco', 'suco'], ['energetico', 'energetico'], ['isotonico', 'isotonico'], ['gatorade', 'isotonico'],
  ['balde', 'cerveja-balde'], ['cerveja long', 'cerveja-long-neck'], ['long neck', 'cerveja-long-neck'],
  ['cerveja lata', 'cerveja-lata'], ['latao', 'cerveja-lata'], ['latinha', 'cerveja-lata'],
  ['cerveja', 'cerveja-copo'], ['chope', 'cerveja-copo'], ['chopp', 'cerveja-copo'],
  ['caipiroska', 'caipiroska'], ['caipirinha', 'caipirinha'], ['batida', 'batida'],
  ['dose de cachaca', 'cachaca'], ['cachaca', 'cachaca'], ['dose de whisky', 'whisky'], ['whisky', 'whisky'], ['uisque', 'whisky'],
  ['cachorro', 'cachorro-quente'], ['hot dog', 'cachorro-quente'], ['coxinha', 'coxinha'],
  ['hamburguer', 'hamburguer'], ['x-', 'hamburguer'], ['x ', 'hamburguer'], ['misto', 'misto-quente'],
  ['pastel', 'pastel'], ['pao de queijo', 'pao-de-queijo'],
  ['carne do sol', 'carne-do-sol'], ['carne de sol', 'carne-do-sol'],
  ['aipim', 'aipim-frito'], ['mandioca', 'aipim-frito'], ['macaxeira', 'aipim-frito'], ['batata', 'batata-frita'], ['fritas', 'batata-frita'],
  ['calabresa', 'calabresa'], ['frango', 'frango-passarinho'], ['isca', 'isca-de-peixe'], ['peixe', 'isca-de-peixe'],
  ['espet', 'espetinho'], ['churrasco', 'espetinho'],
  ['prato kids', 'prato-kids'], ['prato infantil', 'prato-kids'], ['kids', 'prato-kids'], ['prato', 'prato-feito'], ['pf', 'prato-feito'],
  ['refeicao', 'prato-feito'], ['acai', 'acai'], ['picole', 'picole'], ['sorvete', 'sorvete'], ['casquinha', 'sorvete'],
  ['toalha', 'toalha'], ['boia', 'boia'], ['protetor', 'protetor-solar'], ['oculos', 'oculos-natacao'], ['armario', 'armario'],
]
/** os arquivos que existem em `public/comandas/fotos` (sem foto boa, o nome fica de fora e vale o ícone) */
const COM_FOTO = new Set<string>(/* FOTOS-PRONTAS */['acai', 'agua-com-gas', 'agua-de-coco', 'agua-mineral', 'aipim-frito', 'armario', 'batata-frita', 'boia', 'cachaca', 'cachorro-quente', 'caipirinha', 'caipiroska', 'calabresa', 'carne-do-sol', 'cerveja-balde', 'cerveja-copo', 'cerveja-lata', 'cerveja-long-neck', 'coxinha', 'energetico', 'espetinho', 'frango-passarinho', 'hamburguer', 'isca-de-peixe', 'misto-quente', 'oculos-natacao', 'pao-de-queijo', 'pastel', 'picole', 'prato-kids', 'protetor-solar', 'refrigerante-lata', 'sorvete', 'suco', 'toalha', 'whisky'])

const limpo = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

/** a foto pronta para este nome de produto, ou null */
export function fotoPronta(nome: string | null | undefined): string | null {
  if (!nome) return null
  const n = ` ${limpo(nome)}`
  const achou = POR_NOME.find(([p, arquivo]) => n.includes(` ${p}`) && COM_FOTO.has(arquivo))
  return achou ? `/comandas/fotos/${achou[1]}.webp` : null
}

/** o endereço da imagem do produto, ou null (aí a tela mostra o ícone) */
export function fotoDoItem(i: { nome: string; foto?: string | null }): string | null {
  if (i.foto === 'nenhuma') return null
  // no app do tablet, a foto enviada vem do servidor do sistema (as prontas vão dentro do app)
  if (i.foto) return `${(globalThis as any).__ENDERECO_DO_SISTEMA__ ?? ''}${i.foto}`
  return fotoPronta(i.nome)
}
