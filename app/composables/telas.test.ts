// @vitest-environment happy-dom
/**
 * telas.test.ts — os três primeiros testes de componente deste repositório.
 *
 * ## Por que este arquivo existe
 *
 * Até aqui a suíte tinha 695 casos e **nenhum** olhava um `.vue`. Só
 * `app/composables/*.test.ts` era testado; 46 arquivos de tela, 35 páginas,
 * zero perguntas. Num projeto cuja própria documentação abre a seção "O que
 * só aparece olhando" — classe de CSS que não existe, `toISOString` virando
 * amanhã às 21h, `<p>` com bloco dentro — a tela era o único lugar sem rede.
 *
 * Medido antes: mudar o denominador da rosca do painel (o defeito que o
 * comentário de `dashboard.vue` conta em detalhe) deixava a suíte INTEIRA
 * verde, e `import` de um `.vue` num teste nem compilava
 * (`Install @vitejs/plugin-vue to handle .vue files`).
 *
 * ## O que ele NÃO é
 *
 * Não é cobertura de 35 telas — é a rede montada e três exemplos que mordem,
 * escolhidos entre as classes de defeito que já passaram por aqui:
 *
 *   1. um NÚMERO que a tela calcula sozinha (a rosca);
 *   2. um `v-if` de PAPEL escondendo o que tem que esconder;
 *   3. uma CLASSE que não existe em lugar nenhum (o bug invisível da casa).
 *
 * Cada um vem com a própria prova de mutação: arranque a trava e o caso fica
 * vermelho. Onde a mutação não cabe no runner (a rosca), o caso calcula os
 * DOIS denominadores e mostra que eles divergem — se um dia pararem de
 * divergir, a fixtura deixou de exercer o defeito e o caso avisa.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { limparTela, montarTela } from './.vitest-setup-dom'

const RAIZ = join(import.meta.dirname, '../..')

afterEach(() => limparTela())

// ===========================================================================
// 1. O NÚMERO QUE A TELA CALCULA
// ===========================================================================
/**
 * A fixtura é a MESMA da história contada em `dashboard.vue`: seis pedidos
 * criados, um deles devolvido por inteiro.
 *
 *   denominador certo  = `criados`                              = 6  → 83%
 *   denominador errado = finalizados + abandonados + abertos    = 5  → 100%
 *
 * O pedido devolvido não cabia em nenhuma das três fatias antigas: sumia do
 * desenho E do denominador, e a rosca dizia "100% finalizados" num evento com
 * um estorno total dentro. `/relatorios` dizia 6 criados ao lado.
 */
const FUNIL = {
  criados: 6, finalizados: 5, devolvidos: 1,
  abandonados: 0, abertos: 0, contestados: 0, comEstorno: 0, outros: 0,
}

const PAINEL = {
  periodo: { de: '2026-09-01', ate: '2026-09-21' },
  regua: 'todo o período',
  totais: {
    cobradoCents: 850_00, faceCents: 800_00, taxaCents: 50_00, descontoCents: 0,
    estornadoCents: 120_00, estornadoNoLiquidoCents: 120_00, liquidoCents: 730_00,
    hojeCents: 0, hojeLiquidoCents: 0,
    pedidos: 5, pedidosFechados: 5, pedidosComEstorno: 1,
    ingressos: 7, pagos: 7, cortesiasEmitidas: 0,
    ticketMedioPorIngressoCents: 121_43, ticketMedioPorPedidoCents: 170_00,
    ingressosPorPedido: 1.4,
  },
  publico: { pessoas: 0, passagens: 0, ingressosComEntrada: 0, passagensOffline: 0, ultimaEm: null },
  ritmo: [{ dia: '2026-09-20', cobradoCents: 850_00, liquidoCents: 730_00, ingressos: 7 }],
  funil: FUNIL,
  porForma: [{ forma: 'pix', cobradoCents: 850_00, liquidoCents: 730_00, n: 5 }],
  porCanal: [{ canal: 'online', cobradoCents: 850_00, liquidoCents: 730_00, n: 5 }],
  porSetor: [{
    setor: 'Pista', lote: '1º lote', quantidade: 100,
    vendidos: 7, reservados: 0, vendidosPeriodo: 7, cobradoCents: 850_00,
  }],
}

describe('rosca do painel — o número que a tela calcula sozinha', () => {
  it('divide por `criados`, e o pedido devolvido aparece no desenho', async () => {
    const tela = await montarTela(
      await import('../pages/admin/evento/[id]/dashboard.vue'),
      {
        rota: { params: { id: 'evento-de-teste' }, path: '/admin/evento/evento-de-teste/dashboard' },
        respostas: { '/api/admin/evento/': PAINEL },
      })

    const texto = tela.text()

    /*
     * A trava: 83%, não 100%.
     *
     * 5/6 = 83%. Quem voltar o denominador pra `finalizados + abandonados +
     * abertos` (= 5) tira 5/5 = 100% e ESTE `expect` fica vermelho na hora.
     * Confirmado na mão: com o denominador antigo o caso reprova com
     * `esperava 83% … recebeu 100%`.
     */
    const pctNaRosca = texto.match(/(\d+)%\s*finalizados/)?.[1]
    expect(pctNaRosca, 'a rosca não desenhou a porcentagem').toBeTruthy()
    expect(Number(pctNaRosca), 'a rosca dividiu por uma população menor que a do evento')
      .toBe(83)

    // ...e a outra metade do mesmo defeito: o pedido devolvido tem que
    // EXISTIR na legenda. Antes ele não cabia em nenhuma fatia e evaporava.
    expect(texto, 'o estorno total sumiu da rosca').toContain('Devolvidos')

    /*
     * A fixtura ainda exerce o defeito?
     *
     * Se um dia alguém "arrumar" estes números e os dois denominadores
     * passarem a dar o mesmo, o caso acima continuaria verde sem estar
     * provando nada. Aqui a divergência é afirmada explicitamente.
     */
    const errado = FUNIL.finalizados + FUNIL.abandonados + FUNIL.abertos
    expect(errado, 'a fixtura parou de separar os dois denominadores').not.toBe(FUNIL.criados)
  })

  it('sem pedido nenhum a rosca some em vez de desenhar 0%', async () => {
    const tela = await montarTela(
      await import('../pages/admin/evento/[id]/dashboard.vue'),
      {
        rota: { params: { id: 'evento-de-teste' }, path: '/admin/evento/evento-de-teste/dashboard' },
        respostas: {
          '/api/admin/evento/': {
            ...PAINEL,
            funil: { criados: 0, finalizados: 0, devolvidos: 0, abandonados: 0, abertos: 0, contestados: 0, comEstorno: 0, outros: 0 },
          },
        },
      })
    expect(tela.text()).toContain('Sem pedidos no período')
  })
})

// ===========================================================================
// 2. O v-if DE PAPEL
// ===========================================================================
/**
 * O menu do painel é filtrado por `podeAbrirPagina` — a MESMA régua de
 * `server/utils/papeis.ts` que o middleware usa pra responder 403.
 *
 * Esconder item não é a proteção (quem tranca é o middleware), mas desenhar
 * porta fechada na parede é defeito: medido no comentário do próprio layout,
 * a sessão de portaria recebia "Eventos, Organizações, Equipe, Financeiro,
 * Configurações, Suporte" no HTML e cada clique terminava em recusa.
 *
 * `portaria` só tem a área `portaria`, e nenhuma das telas de raiz do painel
 * é dessa área: o menu dela é VAZIO, e no lugar entra a frase que explica.
 */
const RAIZ_DO_PAINEL = {
  rota: { params: {}, path: '/admin' },
}
const ITENS_DE_RAIZ = [
  '/admin', '/admin/organizacoes', '/admin/equipe', '/admin/financeiro',
  '/admin/auditoria', '/admin/reconciliacao', '/admin/configuracoes', '/admin/suporte',
]

/**
 * O MENU é a `<ul>` da lateral, não "todo `<a>` da tela".
 *
 * A marca no alto (`diamond.tickets`) aponta pra `/admin` em qualquer papel,
 * fora do `v-if` — medido aqui: a portaria monta o layout e o único endereço
 * de painel no HTML dela é o da logo. Contar esse `<a>` junto faria o caso
 * reprovar por uma coisa que não é o `v-if` do menu, e vermelho que não é o
 * defeito é vermelho que ninguém olha. Fica anotado como achado à parte — é a
 * mesma doença ("porta fechada desenhada na parede"), e `app/layouts/admin.vue`
 * não é arquivo desta trilha.
 */
async function menuDe(papel: string) {
  const tela = await montarTela(await import('../layouts/admin.vue'), {
    ...RAIZ_DO_PAINEL,
    respostas: { '/api/auth/eu': { usuario: { nome: 'Fulano de Teste', email: 'f@t.invalido', papel } } },
  })
  const href = (sel: string) =>
    tela.findAll(sel).map((a) => a.attributes('href')).filter(Boolean) as string[]
  return { tela, enderecos: href('nav ul a'), todosOsLinks: href('a') }
}

describe('menu do painel — o v-if de papel', () => {
  it('a portaria não vê nenhuma tela do painel, e ouve o porquê', async () => {
    const { tela, enderecos, todosOsLinks } = await menuDe('portaria')

    const vazou = enderecos.filter((h) => ITENS_DE_RAIZ.includes(h))
    // ← com o `v-if` arrancado do menu, `vazou` volta com os oito endereços
    //   e o caso fica vermelho listando cada um deles.
    expect(vazou, 'a portaria recebeu no HTML telas que o servidor nega').toEqual([])

    // e a tela DIZ o que está acontecendo, em vez de ficar uma barra vazia
    expect(tela.text()).toContain('Seu acesso é só o leitor de entrada')

    /*
     * A logo, documentada onde dá pra ver.
     *
     * Ela é o ÚNICO endereço de painel que a portaria recebe, e leva a uma
     * tela que o servidor nega. Não é um `expect` de falha porque o conserto
     * mora num arquivo de outra trilha; é um `expect` de ESTADO, pra quem
     * mexer no layout descobrir aqui que mudou o combinado.
     */
    expect(todosOsLinks.filter((h) => ITENS_DE_RAIZ.includes(h)),
      'mudou o que a portaria recebe fora do menu — confira se virou conserto ou regressão')
      .toEqual(['/admin'])
  })

  it('o master vê as telas de raiz do painel', async () => {
    const { tela, enderecos } = await menuDe('master')

    const faltando = ITENS_DE_RAIZ.filter((p) => !enderecos.includes(p))
    // ← a outra ponta: um filtro que esconde DEMAIS some com a tela do
    //   financeiro e ninguém percebe, porque "sumiu" não lança nada.
    expect(faltando, 'o master perdeu tela do painel no menu').toEqual([])
    expect(tela.text()).not.toContain('Seu acesso é só o leitor de entrada')
  })

  it('papel desconhecido não vira menu cheio', async () => {
    // `ehPapel` recusa o que não está na lista; a régua é allow-list, e o
    // fallback de allow-list errada é justamente "mostra tudo".
    const { enderecos } = await menuDe('gerente-regional')
    expect(enderecos.filter((h) => ITENS_DE_RAIZ.includes(h))).toEqual([])
  })
})

// ===========================================================================
// 3. A CLASSE QUE NÃO EXISTE
// ===========================================================================
/**
 * "Classe de CSS que não existe não gera nada. O Tailwind não avisa; o
 * elemento renderiza sem cor." — CLAUDE.md, e já aconteceu.
 *
 * Varrer TODA classe seria impossível (Tailwind gera utilitário sob demanda).
 * A varredura é cirúrgica, e cobre os dois jeitos de inventar nome aqui:
 *
 *  • **família da casa** — `btn-*`, `chip-*`, `selo-*`, `faixa-*`, `card*`,
 *    `rotulo*`, `numero-*`, `campo*`, `titulo*`, `apoio-*`. O Tailwind não
 *    tem nenhum utilitário com esses prefixos, então qualquer token assim ou
 *    está em `app/assets/base.css`, ou no `<style>` do próprio arquivo, ou
 *    não existe;
 *
 *  • **tom de cor do projeto** — `text-tinta-fraquinha`, `bg-acao-medio`.
 *    As famílias (`tinta`, `acao`, `linha`, `fundo`, `menu`, `ok`, `alerta`,
 *    `erro`) estão no `tailwind.config.js` com os tons medidos no painel de
 *    origem; um tom que não está lá vira classe morta silenciosa.
 */
const FAMILIA_DA_CASA = /^(btn|chip|selo|faixa|card|rotulo|numero|campo|titulo|apoio)(-|$)/
const UTILITARIO_DE_COR =
  /^(?:text|bg|border|ring|fill|stroke|divide|from|to|via|outline|shadow|accent|caret|decoration|placeholder)-(.+)$/
const VARIANTE =
  /^(?:sm|md|lg|xl|2xl|hover|focus|active|disabled|group-hover|group-focus|first|last|odd|even|peer-checked|focus-visible|aria-\w+|data-\w+|print|dark|motion-safe|has-\w+|\[[^\]]*\])+:/

/** classes declaradas em `base.css` */
function classesDaCasa(): Set<string> {
  const css = readFileSync(join(RAIZ, 'app/assets/base.css'), 'utf8')
  return new Set([...css.matchAll(/\.([a-z][a-z0-9-]*)/g)].map((m) => m[1]))
}

/** famílias de cor e seus tons, lidas do `tailwind.config.js` */
function tonsDoProjeto(): Record<string, Set<string>> {
  const cfg = readFileSync(join(RAIZ, 'tailwind.config.js'), 'utf8')
  // +9 pula o próprio `colors: {`, senão a primeira família capturada é
  // "colors" e a `menu` fica de fora da conferência.
  const bloco = cfg.slice(cfg.indexOf('colors: {') + 9, cfg.indexOf('fontFamily'))
  const fam: Record<string, Set<string>> = {}
  for (const m of bloco.matchAll(/(\w+)\s*:\s*\{([^}]*)\}/g)) {
    fam[m[1]] = new Set([...m[2].matchAll(/([A-Za-z]+)\s*:\s*'#/g)].map((x) => x[1]))
  }
  return fam
}

function arquivosVue(dir: string): string[] {
  const achados: string[] = []
  for (const n of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, n.name)
    if (n.isDirectory()) achados.push(...arquivosVue(p))
    else if (n.name.endsWith('.vue')) achados.push(p)
  }
  return achados
}

/**
 * A MESMA contagem por outro mecanismo — quem desce a árvore aqui é o Node.
 *
 * `arquivosVue()` é recursão escrita à mão, e recursão escrita à mão quebra
 * devolvendo lista CURTA em silêncio. O piso numérico que estava aqui
 * (`> 40`, com 47 telas de verdade) não pega isso: MEDIDO, com um `continue`
 * na pasta `app/components` — quatro telas — a varredura devolvia 43, passava
 * no piso, e duas classes mortas plantadas de propósito saíram
 * `Tests 7 passed (7)`, verde.
 *
 * É o mesmo defeito do piso de varredura das rotas administrativas, que esta
 * frota consertou em `server/api/autenticacao.test.ts` e reintroduziu aqui no
 * arquivo novo. A receita é a de lá: duas varreduras independentes e
 * IGUALDADE entre elas, mais um piso absoluto pro dia em que as duas
 * quebrarem juntas.
 */
function arquivosVuePeloNode(dir: string): string[] {
  return (readdirSync(dir, { recursive: true, encoding: 'utf8' }) as string[])
    .filter((c) => c.endsWith('.vue'))
}

/** Toda classe escrita num pedaço de fonte `.vue`, já sem prefixo de variante. */
function classesEscritas(fonte: string): string[] {
  const pedacos = [
    // `class="a b c"` — o `(?<!:)` tira o `:class`, senão o ternário inteiro
    // entra e vira token com aspas grudadas (`text-tinta-fraca'`).
    ...[...fonte.matchAll(/(?<!:)\bclass="([^"]*)"/g)].map((m) => m[1]),
    // `:class="x ? 'a' : 'b'"` e `:class="['a', cond && 'b']"`
    ...[...fonte.matchAll(/:class="([^"]*)"/g)]
      .flatMap((m) => [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1])),
    ...[...fonte.matchAll(/:class="([^"]*)"/g)]
      .flatMap((m) => [...m[1].matchAll(/`([^`$]*)`/g)].map((x) => x[1])),
    /*
     * `classe: 'selo-ok'` — a classe que mora num objeto do `<script>`.
     *
     * É o jeito mais comum deste repositório de escolher selo por situação:
     * `const SITUACOES = { pago: { texto: 'PAGO', classe: 'selo-ok' } }`, e
     * depois `:class="SITUACOES[x].classe"`. O nome nunca aparece num
     * atributo `class`, então as duas varreduras de cima passam por cima dele.
     * São **35 literais em 8 telas** hoje (todos vivos — conferido), e o dia
     * em que um deles virar `selo-aviso` o Tailwind não avisa, o build não
     * avisa, e o selo renderiza sem cor nenhuma.
     */
    ...[...fonte.matchAll(/\bclass(?:e|es)?\s*:\s*'([^']*)'/g)].map((m) => m[1]),
  ]
  return pedacos.flatMap((p) => p.split(/\s+/))
    .map((t) => t.replace(VARIANTE, '').replace(/^!/, ''))
    .filter((t) => t && !t.includes('{') && !t.includes('$'))
}

/** As classes mortas de um fonte `.vue`. É o detector, sozinho e testável. */
function classesMortas(fonte: string, declaradas: Set<string>, tons: Record<string, Set<string>>) {
  const locais = new Set([...fonte.matchAll(/<style[\s\S]*?<\/style>/g)]
    .flatMap((b) => [...b[0].matchAll(/\.([a-z][a-z0-9-]*)/g)].map((x) => x[1])))

  const mortas: string[] = []
  for (const t of classesEscritas(fonte)) {
    if (FAMILIA_DA_CASA.test(t) && !declaradas.has(t) && !locais.has(t)) {
      mortas.push(t)
      continue
    }
    const cor = t.match(UTILITARIO_DE_COR)
    if (!cor) continue
    // `text-tinta-suave/60` → o `/60` é opacidade, não faz parte do tom
    const [familia, tom] = cor[1].split('/')[0].split('-')
    const conhecidos = tons[familia]
    if (!conhecidos) continue // família que não é do projeto: é Tailwind puro
    if (!conhecidos.has(tom ?? 'DEFAULT')) mortas.push(t)
  }
  return mortas
}

describe('classe morta — o bug que só aparece olhando', () => {
  /**
   * A PROVA DE MUTAÇÃO, embutida.
   *
   * Sem ela, o caso de baixo pode passar a varrer zero arquivo (a pasta muda,
   * a regex quebra) e continuar verde afirmando "nenhuma classe morta". Aqui
   * o detector é obrigado a achar o que foi plantado.
   */
  it('o detector acha classe morta plantada (senão o caso abaixo não vale nada)', () => {
    const declaradas = classesDaCasa()
    const tons = tonsDoProjeto()

    const amostra = `
      <template>
        <div class="card p-4">
          <button class="btn-perigo">apagar</button>
          <span class="selo-aviso">novo</span>
          <p class="text-tinta-fraquinha">apoio</p>
          <p class="text-tinta-fraca">apoio de verdade</p>
          <p :class="ok ? 'chip-ativo' : 'chip-apagado'">estado</p>
          <span :class="SITUACOES[x].classe">situação</span>
        </div>
      </template>
      <script setup lang="ts">
      const SITUACOES: Record<string, { texto: string; classe: string }> = {
        pago: { texto: 'PAGO', classe: 'selo-ok' },
        sumido: { texto: 'SUMIDO', classe: 'selo-fantasma' },
      }
      </script>`

    expect(classesMortas(amostra, declaradas, tons).sort()).toEqual(
      ['btn-perigo', 'chip-apagado', 'selo-aviso', 'selo-fantasma', 'text-tinta-fraquinha'])

    // e as vivas continuam vivas: detector que grita em tudo também é inútil
    expect(classesMortas(
      '<template><p class="card chip-ativo text-tinta-fraca btn-secundario">ok</p></template>'
      + "<script setup>const S = { a: { classe: 'selo-alerta' } }</script>",
      declaradas, tons)).toEqual([])
  })

  it('nenhuma tela usa classe da casa ou tom de cor que não existe', () => {
    const declaradas = classesDaCasa()
    const tons = tonsDoProjeto()
    const telas = arquivosVue(join(RAIZ, 'app'))
    const peloNode = arquivosVuePeloNode(join(RAIZ, 'app'))

    // 1. o número absoluto não desabou (47 telas hoje; 40 dá folga pra apagar
    //    tela sem vermelho de mentira, e trava as duas varreduras quebrando
    //    juntas)
    expect(peloNode.length, 'a pasta de telas encolheu demais — um caso verde aqui '
      + 'não quer dizer que as classes estão vivas')
      .toBeGreaterThanOrEqual(40)

    // 2. ...e as duas varreduras enxergam A MESMA árvore. Qualquer pasta que a
    //    recursão à mão deixe de descer aparece aqui como diferença, seja 1 ou
    //    20 — que é o que o piso sozinho não pega.
    expect(telas.length,
      `a varredura à mão achou ${telas.length} telas e o Node achou ${peloNode.length}: `
      + 'ela parou de enxergar parte da árvore, e o que ela não enxerga não é conferido')
      .toBe(peloNode.length)

    const mortas: string[] = []
    for (const arq of telas) {
      for (const c of classesMortas(readFileSync(arq, 'utf8'), declaradas, tons)) {
        mortas.push(`${c}  ←  ${arq.slice(RAIZ.length + 1)}`)
      }
    }
    expect(mortas, 'classe escrita que não vira CSS nenhum — renderiza sem estilo e ninguém avisa')
      .toEqual([])
  })
})
