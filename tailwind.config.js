/**
 * Tokens medidos no CSS computado do painel da Zig (20/09/2026), não estimados
 * de print. Cada valor abaixo saiu de um getComputedStyle na tela real.
 *
 *   menu      #002D8C  nav lateral, 220px de largura
 *   acao      #1C70E9  botão sólido ("Aplicar"), peso 700, raio 8
 *   acao.forte#0050C3  borda do item ativo e do chip selecionado
 *   fundo     #F9FBFD  fundo da área de conteúdo
 *   tinta     #171719  títulos e números
 *   tinta.corpo #12263F texto corrido
 *   linha     #EAE9ED  borda de card
 *
 * Tipografia: Lato nos títulos/menu/KPI, Roboto no corpo a 15px.
 */
export default {
  content: ['./app/**/*.{vue,ts}', './server/**/*.ts'],
  theme: {
    extend: {
      colors: {
        menu:  { DEFAULT: '#002D8C', hover: '#0B3C9E', ativo: '#0050C3' },
        acao:  { DEFAULT: '#1C70E9', forte: '#0050C3', escuro: '#0B57C7', claro: '#C8E6FA', fraco: '#EAF3FE',
                 // #2C7BE5 é o azul do passo ativo e dos links do módulo de criação —
                 // medido lá, é um tom à parte do #1C70E9 dos botões sólidos.
                 passo: '#2C7BE5' },
        fundo: { DEFAULT: '#F9FBFD', card: '#FFFFFF', cinza: '#F3F5F8' },
        tinta: { DEFAULT: '#171719', corpo: '#12263F', suave: '#5A6B84', fraca: '#8A97A8',
                 rotulo: '#4F6C7C', passo: '#89929F' },
        linha: { DEFAULT: '#EAE9ED', forte: '#D8DDE5', campo: '#CED4DA' },
        // semânticas, separadas do azul de ação de propósito
        ok:    { DEFAULT: '#12805C', claro: '#E3F5EE' },
        alerta:{ DEFAULT: '#B26A00', claro: '#FDF3E2' },
        erro:  { DEFAULT: '#C1292E', claro: '#FCEAEA' },
      },
      fontFamily: {
        titulo: ['Lato', 'system-ui', 'sans-serif'],
        corpo:  ['Roboto', 'system-ui', 'sans-serif'],
      },
      fontSize: { base: ['15px', '1.5'] },
      spacing: { menu: '220px' },
      borderRadius: { card: '8px' },
    },
  },
}
