/**
 * Tokens do Conquista Park.
 *
 * Portados do sistema do parque (repositório `sistemapark`, arquivo
 * `src/app/globals.css`) por ordem do dono em 21/09/2026: "pegar todo esse
 * estilo de design do novo repositório e aplicar em tudo, a logo também".
 * Antes disto a identidade era a da Zig (Lato/Roboto, azul #1C70E9, menu
 * lateral #002D8C); nada daquilo vale mais.
 *
 * Duas camadas de nome, de propósito:
 *
 *   1. AS ESCALAS DA MARCA — `pool`, `grape`, `sun`, `citrus`, `ink`, mais os
 *      semânticos `success`, `warning`, `danger`. São idênticas às do
 *      sistemapark: quem abrir os dois lado a lado encontra o mesmo hex sob o
 *      mesmo nome.
 *   2. OS NOMES DA CASA — `acao`, `tinta`, `linha`, `fundo`, `ok`, `alerta`,
 *      `erro`, `menu`. Existem em ~2.500 lugares nas telas; trocar o nome de
 *      cada um seria reescrever tudo pra ganhar nada. Ficam, e apontam pro tom
 *      certo da escala da marca (o comentário de cada um diz qual).
 *
 * Quem for escrever tela nova usa o nome da casa pro que ele já cobre, e a
 * escala da marca pro resto (`ring-ink-200`, `bg-pool-50`, `text-grape-700`).
 *
 * Contraste: os pares de texto e fundo abaixo passam WCAG AA (4,5:1) — por isso
 * `tinta.fraca` é `ink-500` e não `ink-400`, que na cor de fundo branca dá 2,6:1
 * e só serve pra placeholder e ícone.
 *
 * O teste `app/composables/telas.test.ts` lê ESTE arquivo pra saber quais tons
 * existem: cada família em uma linha `nome: { tom: '#hex', ... }`, sem chave
 * aninhada e sem comentário com chave dentro.
 */
export default {
  content: ['./app/**/*.{vue,ts}', './server/**/*.ts'],
  theme: {
    extend: {
      colors: {
        // ---- escalas da marca (iguais às do sistemapark) --------------------
        // pool: azul piscina, da logo. 700 é a cor de ação do painel.
        pool:    { 50: '#effafd', 100: '#d9f2f9', 200: '#b6e5f2', 300: '#8fd4ea', 400: '#4fc6db', 500: '#22aac3', 600: '#1789a1', 700: '#146f83', 800: '#155b6b', 900: '#164b59', 950: '#07303a' },
        // grape: o roxo da logo. Marca, destaque, avatar, reembolso.
        grape:   { 50: '#f6f3fb', 100: '#ebe4f6', 200: '#d7caec', 300: '#b9a2da', 400: '#9877c5', 500: '#7a56ab', 600: '#583c8d', 700: '#4a3277', 800: '#3c2961', 900: '#2e2149', 950: '#1b1330' },
        // sun: o amarelo da logo. É o botão de COMPRAR do site.
        sun:     { 50: '#fffaeb', 100: '#fff1cc', 200: '#ffe29a', 300: '#fed160', 400: '#fdb92a', 500: '#f29b0c', 600: '#cf7506', 700: '#a45408', 800: '#86420e' },
        // citrus: o verde-limão da logo. Cortesia e confirmação leve.
        citrus:  { 50: '#f8fbea', 100: '#eff6d0', 200: '#deeca3', 300: '#cde06f', 400: '#b9d53a', 500: '#9cb826', 600: '#7b921b', 700: '#5d6f19', 800: '#4b5919' },
        // ink: neutros levemente arroxeados. Texto, borda, fundo.
        ink:     { 50: '#f7f7fa', 100: '#efeef4', 200: '#e2e0ea', 300: '#c8c5d5', 400: '#a09cb2', 500: '#716c87', 600: '#5a5570', 700: '#433e57', 800: '#2d293f', 900: '#1e1a2e', 950: '#120f1d' },
        success: { 50: '#edfcf2', 100: '#d3f8e0', 600: '#16a34a', 700: '#15803d', 800: '#166534' },
        warning: { 50: '#fff8eb', 100: '#feedc7', 600: '#d97706', 700: '#b45309', 800: '#92400e' },
        danger:  { 50: '#fef2f2', 100: '#fee2e2', 600: '#dc2626', 700: '#b91c1c', 800: '#991b1b' },
        // fundo da página (o cinza-azulado atrás dos cartões)
        canvas: '#f4f6f9',

        // ---- nomes da casa, apontando pra escala da marca --------------------
        // menu: o que era o azul da lateral. A lateral agora é branca; sobra o
        // roxo da logo pro avatar e pra barra de progresso.
        menu:  { DEFAULT: '#583c8d', hover: '#4a3277', ativo: '#3c2961' },
        // acao: a cor do botão sólido, do link e do foco = pool-700 e vizinhos.
        acao:  { DEFAULT: '#146f83', forte: '#1789a1', escuro: '#155b6b', claro: '#d9f2f9', fraco: '#effafd', passo: '#146f83' },
        // fundo: fundo de página, de cartão e o cinza de apoio (hover, cabeçalho de tabela)
        fundo: { DEFAULT: '#f4f6f9', card: '#ffffff', cinza: '#f7f7fa' },
        // tinta: títulos e números (ink-900), texto corrido (ink-800), apoio (ink-600 e ink-500)
        tinta: { DEFAULT: '#1e1a2e', corpo: '#2d293f', suave: '#5a5570', fraca: '#716c87', rotulo: '#2d293f', passo: '#a09cb2' },
        linha: { DEFAULT: '#e2e0ea', forte: '#c8c5d5', campo: '#e2e0ea' },
        // semânticas, separadas do azul de ação de propósito
        ok:    { DEFAULT: '#15803d', claro: '#edfcf2' },
        alerta:{ DEFAULT: '#b45309', claro: '#fff8eb' },
        erro:  { DEFAULT: '#b91c1c', claro: '#fef2f2' },
      },
      // Geist, a mesma do site do parque, servida por nós (`@fontsource-variable`,
      // registrada em nuxt.config.ts). Servir do próprio domínio importa: o
      // service worker da portaria guarda o que vem de /_nuxt/, então a tela do
      // leitor mantém a tipografia inclusive sem rede.
      fontFamily: {
        titulo: ['"Geist Variable"', 'ui-sans-serif', 'system-ui', '-apple-system', '"Segoe UI"', 'sans-serif'],
        corpo:  ['"Geist Variable"', 'ui-sans-serif', 'system-ui', '-apple-system', '"Segoe UI"', 'sans-serif'],
        mono:   ['"Geist Mono Variable"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      fontSize: { base: ['15px', '1.5'] },
      // `card` é o raio de CONTROLE e de painel pequeno (campo, botão, menu
      // suspenso): 12px, o `rounded-xl` do sistemapark. O cartão grande usa
      // `rounded-2xl` direto, em `.card`.
      borderRadius: { card: '12px' },
      boxShadow: {
        card: '0 1px 2px 0 rgb(30 26 46 / 0.04), 0 2px 12px -4px rgb(30 26 46 / 0.08)',
        pop: '0 24px 60px -18px rgb(18 15 29 / 0.35), 0 2px 8px -2px rgb(18 15 29 / 0.12)',
        lateral: '0 12px 40px -16px rgb(15 23 42 / 0.22)',
      },
      keyframes: {
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        'rise-in': {
          from: { opacity: '0', transform: 'translateY(6px) scale(0.985)' },
          to: { opacity: '1', transform: 'none' },
        },
        'slide-in-left': { from: { transform: 'translateX(-100%)' }, to: { transform: 'none' } },
        drift: {
          from: { transform: 'translate3d(-3%, -2%, 0) scale(1)' },
          to: { transform: 'translate3d(3%, 2%, 0) scale(1.08)' },
        },
      },
      animation: {
        'fade-in': 'fade-in 160ms ease-out both',
        'rise-in': 'rise-in 220ms cubic-bezier(0.2, 0.8, 0.2, 1) both',
        'slide-in-left': 'slide-in-left 220ms cubic-bezier(0.2, 0.8, 0.2, 1) both',
        drift: 'drift 22s ease-in-out infinite alternate',
      },
    },
  },
}
