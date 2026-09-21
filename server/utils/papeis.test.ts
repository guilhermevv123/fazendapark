/**
 * A grade de papéis — provada onde ela vale: na ROTA, com o cookie do papel
 * errado.
 *
 * ## Por que não basta testar a tabela
 *
 * A armadilha deste projeto é achar que esconder o item do menu resolveu.
 * Esconder não protege rota: o `fetch` continua lá, o endereço é público, e
 * quem abre o DevTools chega igual. Por isso quase todo caso aqui embaixo
 * **faz login de verdade** com um usuário daquele papel e bate na rota
 * exigindo 403 — os casos de unidade em cima só guardam a tabela de não
 * mudar por engano.
 *
 * ## O que foi MEDIDO antes desta grade existir (servidor no ar, cookie real)
 *
 * | rota                                  | operacional | portaria |
 * |---------------------------------------|-------------|----------|
 * | GET  /evento/:id/financeiro (saldo)   | **200**     | 403      |
 * | POST /evento/:id/financeiro (saque)   | **200**     | 403      |
 * | GET  /evento/:id/bordero              | **200**     | 403      |
 * | GET  /admin/organizacao (chave Asaas) | **200**     | **200**  |
 * | GET  /admin/pedido/:id (CPF, e-mail)  | **200**     | **200**  |
 *
 * Cada linha dessa virou um caso abaixo. Um teste que só confirmasse os 403
 * que o porteiro antigo já dava ficaria verde com esta grade INTEIRA
 * arrancada — e teste assim é pior que não ter teste.
 *
 * ## Fixture
 *
 * Cinco logins próprios — um por papel, mais a portaria com `role` largo que
 * mede esta grade sem a ajuda do porteiro antigo — ids fixos, apagados no
 * `afterAll`.
 * O evento semeado é só LIDO. As únicas linhas que estes casos escrevem nele
 * são as leituras de portaria — que a catraca registra mesmo quando recusa —
 * e elas são apagadas uma a uma no fim, pelo código lido.
 *
 * Servidor fora do ar: PULA em vez de falhar.
 */
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import bcrypt from 'bcryptjs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { comSessao } from '../../scripts/teste-sessao'
import { menuDoEvento } from '../../app/composables/menuDoEvento'
import { db, q, q1 } from './db'
import { podeFazer } from './sessao'
import {
  areaDaPagina, areaDaRota, decidirAcesso, papelPode, podeAbrirPagina, roleLegado, rotaGateada,
  CATALOGO, PAPEIS, ROTULO, SO_DO_MASTER,
} from './papeis'

const BASE = process.env.BASE_TESTE ?? 'http://localhost:3100'
const EVENTO = '3cd875a0-e230-448a-892b-d4cc840b1948'
const SENHA = 'diamond123'

/**
 * Prazo dos casos que batem na rota. Os cinco segundos padrão do vitest são
 * curtos aqui e o vermelho que eles dão é MENTIROSO: o servidor de
 * desenvolvimento compila cada handler na primeira chamada, e um caso que
 * visita oito rotas ainda frias gasta o prazo inteiro compilando. Medido
 * depois de aquecidas, as mesmas oito respondem em ~10 ms cada. Prazo curto
 * aqui ensina a suíte a ficar vermelha por motivo que não é permissão — e
 * vermelho que não é o defeito vira vermelho que ninguém olha.
 */
const PRAZO = 20_000

/**
 * ids fixos: o teste apaga exatamente o que criou.
 *
 * **Um login por papel, com e-mail só deste arquivo — inclusive o master.**
 * Usar `dono@fazendapark.com.br` como o master destes casos amarra esta prova
 * a um e-mail que OUTRO arquivo da suíte erra a senha de propósito: o freio de
 * força bruta conta oito erros por e-mail em quinze minutos e, passando disso,
 * o login do dono responde 429 pra suíte inteira. Foi exatamente o que
 * aconteceu — esta grade ficou VERMELHA sem nenhuma permissão ter mudado.
 * Trava de outro teste não pode ser o veredito deste.
 */
const USUARIOS = {
  master:     { id: '00000000-0000-4000-8000-0000000012a0', email: 'master.papeis@teste.local' },
  financeiro: { id: '00000000-0000-4000-8000-0000000012a1', email: 'financeiro.papeis@teste.local' },
  operacao:   { id: '00000000-0000-4000-8000-0000000012a2', email: 'operacao.papeis@teste.local' },
  portaria:   { id: '00000000-0000-4000-8000-0000000012a3', email: 'portaria.papeis@teste.local' },
} as const

/**
 * O quinto login não é um papel novo: é o MESMO papel de portaria com o `role`
 * largo de quem é de operação — a combinação que o porteiro antigo deixa
 * passar inteira pelo prefixo `/api/admin/evento/`.
 *
 * Sem ele, todo 403 de portaria dentro do evento pode estar vindo do porteiro
 * velho, e esta grade ficaria verde mesmo desligada (foi o que a mutação A
 * mostrou: `a portaria não chega no dinheiro` continuou passando com o
 * middleware fora). Com ele, o único que pode negar é o `03` — e o teste
 * confere a MENSAGEM pra não aceitar um 403 de outro dono.
 *
 * As rotas de equipe gravam `papel` e `role` juntos, então esta combinação não
 * nasce pela tela. Ela é o ensaio do dia em que o `01` for aposentado.
 */
const PORTARIA_SOLTA = {
  id: '00000000-0000-4000-8000-0000000012a4',
  email: 'portaria.solta@teste.local',
  papel: 'portaria',
  role: 'operacional', // largo de propósito: o porteiro antigo libera
} as const

/**
 * Organização à parte, com DOIS masters, só pra exercitar a tela de equipe.
 *
 * Não dá pra fazer isso na organização semeada: o caso do último master
 * precisa REBAIXAR master de verdade, e o único master de lá é o
 * `dono@fazendapark.com.br` — dado semeado, que teste nenhum mexe. Aqui a
 * organização inteira é fabricada e apagada no fim (o `DELETE` da
 * organização leva os usuários e as sessões junto, por cascata).
 */
const ORG_EQUIPE = '0000e012-0000-4000-8000-000000000001'
const MASTERS = {
  m1: { id: '0000e012-0000-4000-8000-000000000002', email: 'm1.equipe@teste.local' },
  m2: { id: '0000e012-0000-4000-8000-000000000003', email: 'm2.equipe@teste.local' },
} as const

/**
 * A loja do lado, pro caso do e-mail repetido: o cadastro confere por
 * organização e o LOGIN não pergunta a organização. Duas organizações de
 * mentira, apagadas no fim junto com a de cima.
 */
const ORG_VIZINHA = '0000e012-0000-4000-8000-0000000000a1'
/** e-mail que existe SÓ na vizinha: é o que o cadastro daqui tem que recusar */
const EMAIL_DA_VIZINHA = 'ja.usado.la@teste.local'
/**
 * e-mail que já está REPETIDO nas duas, inserido direto no banco — que é o
 * único caminho que sobrou depois do conserto. Serve pra medir o estrago que
 * a recusa evita: senhas diferentes, e só uma das duas pessoas entra.
 */
const EMAIL_REPETIDO = 'repetido.nas.duas@teste.local'
const SENHA_DAQUI = 'senha-de-ca-9F2x'
const SENHA_DE_LA = 'senha-de-la-7K4p'

/* ------------------------------------------------------------- a tabela */

describe('a grade de papéis (tabela)', () => {
  it('classifica dinheiro e configuração de evento como coisas DIFERENTES', () => {
    // é exatamente o que o porteiro antigo não consegue: os dois moram no
    // mesmo prefixo /api/admin/evento/
    expect(areaDaRota(`/api/admin/evento/${EVENTO}/financeiro`)).toBe('dinheiro')
    expect(areaDaRota(`/api/admin/evento/${EVENTO}/bordero`)).toBe('dinheiro')
    expect(areaDaRota(`/api/admin/evento/${EVENTO}/extrato`)).toBe('dinheiro')
    expect(areaDaRota(`/api/admin/evento/${EVENTO}/dashboard`)).toBe('dinheiro')
    expect(areaDaRota(`/api/admin/evento/${EVENTO}/ingressos`)).toBe('evento')
    expect(areaDaRota(`/api/admin/evento/${EVENTO}/cupons`)).toBe('evento')
    expect(areaDaRota(`/api/admin/evento/${EVENTO}/pdv/venda`)).toBe('pdv')
    // o LEITOR e o HISTÓRICO são áreas diferentes: a portaria tem o primeiro
    expect(areaDaRota(`/api/admin/evento/${EVENTO}/checkins`)).toBe('portaria_historico')
    expect(areaDaRota('/api/admin/organizacao')).toBe('organizacao')
    expect(areaDaRota('/api/admin/equipe')).toBe('equipe')
    expect(areaDaRota('/api/checkin')).toBe('portaria')
  })

  it('rota que ninguém classificou é rota só do master', () => {
    const nova = '/api/admin/tela-que-alguem-vai-criar-amanha'
    expect(areaDaRota(nova)).toBe(null)
    expect(decidirAcesso('master', nova).liberado).toBe(true)
    for (const papel of ['financeiro', 'operacao', 'portaria'] as const) {
      expect(decidirAcesso(papel, nova).liberado, papel).toBe(false)
    }
  })

  it('operação não tem dinheiro e portaria não tem nada além da porta', () => {
    expect(papelPode('operacao', 'dinheiro')).toBe(false)
    expect(papelPode('operacao', 'equipe')).toBe(false)
    expect(papelPode('operacao', 'organizacao')).toBe(false)
    expect(papelPode('operacao', 'pdv')).toBe(true)

    for (const area of ['dinheiro', 'evento', 'venda', 'pdv', 'equipe', 'organizacao'] as const) {
      expect(papelPode('portaria', area), area).toBe(false)
    }
    expect(papelPode('portaria', 'portaria')).toBe(true)
  })

  /**
   * Esta grade existe pra SUBSTITUIR o porteiro antigo, não pra depender dele.
   * Enquanto `checkins` era área `portaria`, esta grade liberava a portaria no
   * histórico do evento e quem negava, de fato, era só o `01` — medido:
   * `403 Seu acesso (portaria) não inclui evento`. Aposentar o `01` teria
   * aberto aquela porta sem nenhum teste ficar vermelho.
   */
  it('a portaria não herda o histórico do evento junto com o leitor', () => {
    expect(papelPode('portaria', 'portaria')).toBe(true)
    expect(papelPode('portaria', 'portaria_historico')).toBe(false)
    // quem trabalha no evento continua lendo quem já entrou
    expect(papelPode('operacao', 'portaria_historico')).toBe(true)
    expect(papelPode('master', 'portaria_historico')).toBe(true)
    // e o financeiro não passa a ver o fluxo de gente por tabela nova
    expect(papelPode('financeiro', 'portaria_historico')).toBe(false)

    // a grade fina nega SOZINHA, sem depender do porteiro antigo
    const d = decidirAcesso('portaria', `/api/admin/evento/${EVENTO}/checkins`)
    expect(d.liberado).toBe(false)
    expect(d.motivo).toContain('quem já entrou')
  })

  it('a recusa diz o que a pessoa é e o que fazer, sem código', () => {
    const d = decidirAcesso('portaria', `/api/admin/evento/${EVENTO}/financeiro`)
    expect(d.liberado).toBe(false)
    expect(d.motivo).toContain('Portaria')
    expect(d.motivo).toContain('master')
    expect(d.motivo).not.toMatch(/40[13]|forbidden|invalid/i)
  })

  it('tranca /api/admin e a catraca, e não opina sobre o resto', () => {
    expect(rotaGateada('/api/admin/equipe')).toBe(true)
    expect(rotaGateada('/api/checkin')).toBe(true)
    expect(rotaGateada('/api/e/conquista-park-4-edicao')).toBe(false)
    expect(rotaGateada('/api/auth/eu')).toBe(false)
  })

  it('o catálogo que a tela mostra é a MESMA grade que tranca', () => {
    expect(CATALOGO.map((c) => c.valor)).toEqual(PAPEIS)
    for (const c of CATALOGO) {
      for (const area of c.areas) expect(papelPode(c.valor, area as any)).toBe(true)
    }
  })

  /**
   * A grade fina só decide DEPOIS da grossa. Se o `role` derivado de um papel
   * não passar pelo porteiro antigo, aquele papel fica trancado do lado de
   * fora de algo que esta grade jura que ele pode — e a tela responde 403 sem
   * ninguém entender por quê.
   */
  it('o role derivado deixa cada papel chegar onde a grade fina libera', () => {
    // financeiro precisa de DUAS áreas antigas: o evento (onde mora o saldo
    // e o saque, no mesmo prefixo) e o financeiro global
    expect(podeFazer(roleLegado('financeiro') as any, 'evento')).toBe(true)
    expect(podeFazer(roleLegado('financeiro') as any, 'financeiro')).toBe(true)

    expect(podeFazer(roleLegado('operacao') as any, 'evento')).toBe(true)
    expect(podeFazer(roleLegado('operacao') as any, 'portaria')).toBe(true)

    expect(podeFazer(roleLegado('portaria') as any, 'portaria')).toBe(true)
    // e continua estreita lá também: negação em dois lugares
    expect(podeFazer(roleLegado('portaria') as any, 'evento')).toBe(false)
  })
})

/* ------------------------------------------------- nenhuma rota esquecida */

/**
 * O balde do `null` é rede de segurança pra rota que nasce amanhã — não
 * destino de rota que já existe.
 *
 * Medido com a portaria logada, antes deste caso existir: `/api/admin/auditoria`,
 * `/api/admin/reconciliacao`, `/api/admin/evento/<id>/sessoes`,
 * `/api/admin/evento/<id>/reenviar`, `/api/admin/evento/<id>/remarcar` e
 * `/api/admin/evento/<id>/cancelar` respondiam todas
 * `403 Esta tela ainda não foi liberada para nenhum acesso além do master` —
 * pra TODO mundo, inclusive pro financeiro e pro balcão, que são as pessoas
 * pra quem aquelas telas foram feitas. Seis telas prontas, alcançáveis só pelo
 * dono, e nenhum teste vermelho.
 *
 * Este caso varre a pasta de rotas do disco em vez de listar caminhos na mão:
 * lista escrita à mão envelhece exatamente no dia em que alguém cria a rota
 * nova, que é o dia em que ela precisaria acusar.
 */
const PASTA_DAS_ROTAS = fileURLToPath(new URL('../api', import.meta.url))

/** Todo caminho de rota administrativa que existe no disco, com o id do seed. */
function rotasNoDisco(): string[] {
  const achadas: string[] = []
  const andar = (pasta: string, url: string) => {
    for (const nome of readdirSync(pasta)) {
      const caminho = join(pasta, nome)
      if (statSync(caminho).isDirectory()) { andar(caminho, `${url}/${nome}`); continue }
      if (!nome.endsWith('.ts') || nome.endsWith('.test.ts')) continue
      const base = nome.replace(/\.(get|post|patch|put|delete)?\.ts$/, '')
      achadas.push(base === 'index' ? url : `${url}/${base}`)
    }
  }
  andar(PASTA_DAS_ROTAS, '/api')
  return [...new Set(achadas)]
    .map((r) => r.replace('[id]', EVENTO))
    .filter((r) => rotaGateada(r))
    .sort()
}

const trancadaDeProposito = (rota: string) =>
  SO_DO_MASTER.some((p) => rota === p || rota.startsWith(p + '/'))

describe('nenhuma rota administrativa fica sem área por esquecimento', () => {
  it('toda rota de /api/admin tem área — ou está na lista de exceções, com motivo', () => {
    const rotas = rotasNoDisco()
    expect(rotas.length, 'a varredura não achou rota nenhuma: o caminho da pasta mudou')
      .toBeGreaterThan(30)

    const esquecidas = rotas.filter((r) => areaDaRota(r) === null && !trancadaDeProposito(r))
    expect(esquecidas,
      'rota(s) administrativa(s) sem área em AREA_DA_TELA/AREA_DA_RAIZ: hoje elas respondem 403 '
      + 'pra todo mundo menos o master. Classifique de propósito, ou ponha em SO_DO_MASTER '
      + 'escrevendo por quê').toEqual([])
  })

  /** A lista de exceções não pode envelhecer: o que está nela tem que continuar sendo verdade. */
  it('o que está em SO_DO_MASTER existe de verdade e continua sem área', () => {
    const rotas = rotasNoDisco()
    for (const prefixo of SO_DO_MASTER) {
      const minhas = rotas.filter((r) => r === prefixo || r.startsWith(prefixo + '/'))
      expect(minhas.length, `${prefixo} não é rota de ninguém — tire da lista`).toBeGreaterThan(0)
      for (const r of minhas) {
        expect(areaDaRota(r), `${r} ganhou área: tire de SO_DO_MASTER no mesmo diff`).toBe(null)
        for (const papel of ['financeiro', 'operacao', 'portaria'] as const) {
          expect(decidirAcesso(papel, r).liberado, `${papel} passou em ${r}`).toBe(false)
        }
      }
    }
  })

  /** As seis que estavam fora, nomeadas — pra a regressão ter nome e não só contagem. */
  it('as telas que estavam inalcançáveis chegaram em quem as usa', () => {
    expect(areaDaRota('/api/admin/auditoria')).toBe('dinheiro')
    expect(areaDaRota('/api/admin/reconciliacao')).toBe('dinheiro')
    expect(areaDaRota(`/api/admin/evento/${EVENTO}/sessoes`)).toBe('evento')
    expect(areaDaRota(`/api/admin/evento/${EVENTO}/remarcar`)).toBe('evento')
    expect(areaDaRota(`/api/admin/evento/${EVENTO}/reenviar`)).toBe('venda')
    // estorno em massa é saída de dinheiro, não configuração de evento
    expect(areaDaRota(`/api/admin/evento/${EVENTO}/cancelar`)).toBe('dinheiro')

    expect(papelPode('financeiro', 'dinheiro')).toBe(true)
    expect(papelPode('operacao', 'evento')).toBe(true)
    // o balcão é quem ouve "não chegou": ele precisa reenviar
    expect(papelPode('operacao', 'venda')).toBe(true)
    // e quem não tem caixa continua sem cancelar o evento inteiro
    expect(papelPode('operacao', 'dinheiro')).toBe(false)
  })
})

/* ------------------------------------------------------- o menu da lateral */

/**
 * O menu do painel, filtrado pela MESMA grade que tranca a rota.
 *
 * Medido no HTML servido a uma sessão de portaria, antes disto: a lateral
 * listava "Eventos, Organizações, Equipe, Financeiro, Configurações, Suporte"
 * — os seis, sem filtro nenhum. Clicar não vazava (o 403 do
 * `middleware/03.papel.ts` continua lá e é ele a proteção), mas seis portas
 * fechadas desenhadas na parede de quem só abre a catraca.
 *
 * O que estes casos guardam é a régua que o `layouts/admin.vue` lê. Se alguém
 * escrever uma segunda lista de quem-vê-o-quê dentro da tela, ela pode até
 * ficar certa hoje; o que não dá é ela envelhecer sozinha, e é por isso que a
 * varredura abaixo parte do menu DE VERDADE (`menuDoEvento`).
 */
describe('o menu não oferece porta fechada', () => {
  it('toda tela do menu do evento tem área classificada', () => {
    const semArea: string[] = []
    for (const grupo of menuDoEvento(EVENTO)) {
      for (const caminho of [grupo.para, ...(grupo.filhos ?? []).map((f) => f.para)]) {
        if (areaDaPagina(caminho) === null) semArea.push(caminho)
      }
    }
    expect(semArea,
      'tela(s) no menu que ninguém classificou em areaDaPagina: hoje só o master as vê')
      .toEqual([])
  })

  it('a portaria só enxerga o leitor de entrada — e o histórico continua fora', () => {
    expect(podeAbrirPagina('portaria', `/admin/evento/${EVENTO}/validacao`)).toBe(true)
    expect(podeAbrirPagina('portaria', `/admin/evento/${EVENTO}/validacao/historico`)).toBe(false)

    // as seis do menu de raiz que ela recebia inteiras
    for (const pagina of ['/admin', '/admin/organizacoes', '/admin/equipe', '/admin/financeiro',
      '/admin/configuracoes', '/admin/suporte']) {
      expect(podeAbrirPagina('portaria', pagina), pagina).toBe(false)
    }

    // e nenhuma tela do evento além do leitor
    const visiveis = menuDoEvento(EVENTO)
      .flatMap((g) => (g.filhos ?? [{ nome: g.nome, para: g.para }]))
      .filter((t) => podeAbrirPagina('portaria', t.para))
      .map((t) => t.nome)
    expect(visiveis).toEqual(['Leitor de entrada'])
  })

  it('quem cuida do dinheiro não recebe o menu de configurar evento, e vice-versa', () => {
    expect(podeAbrirPagina('financeiro', `/admin/evento/${EVENTO}/dashboard`)).toBe(true)
    expect(podeAbrirPagina('financeiro', `/admin/evento/${EVENTO}/financeiro/bordero`)).toBe(true)
    expect(podeAbrirPagina('financeiro', `/admin/evento/${EVENTO}/ingressos/cupons`)).toBe(false)
    expect(podeAbrirPagina('financeiro', `/admin/evento/${EVENTO}/pdv/caixa`)).toBe(false)
    expect(podeAbrirPagina('financeiro', '/admin/equipe')).toBe(false)

    expect(podeAbrirPagina('operacao', `/admin/evento/${EVENTO}/ingressos/cupons`)).toBe(true)
    expect(podeAbrirPagina('operacao', `/admin/evento/${EVENTO}/pdv/caixa`)).toBe(true)
    expect(podeAbrirPagina('operacao', `/admin/evento/${EVENTO}/dashboard`)).toBe(false)
    expect(podeAbrirPagina('operacao', `/admin/evento/${EVENTO}/relatorios/extrato`)).toBe(false)

    // o master continua vendo tudo que existe no menu
    for (const grupo of menuDoEvento(EVENTO)) {
      for (const caminho of [grupo.para, ...(grupo.filhos ?? []).map((f) => f.para)]) {
        expect(podeAbrirPagina('master', caminho), caminho).toBe(true)
      }
    }
  })

  /**
   * As duas telas de conferência de dinheiro existiam sem nenhum caminho até
   * elas — nenhum link, nenhum item de menu. Agora estão no menu de raiz, e
   * pra quem abre elas é a MESMA régua da rota.
   */
  it('auditoria e reconciliação chegam em quem cuida do dinheiro', () => {
    for (const pagina of ['/admin/auditoria', '/admin/reconciliacao']) {
      expect(podeAbrirPagina('master', pagina), pagina).toBe(true)
      expect(podeAbrirPagina('financeiro', pagina), pagina).toBe(true)
      expect(podeAbrirPagina('operacao', pagina), pagina).toBe(false)
      expect(podeAbrirPagina('portaria', pagina), pagina).toBe(false)
      // e a página combina com a rota que ela consulta
      expect(areaDaPagina(pagina)).toBe(areaDaRota(pagina.replace('/admin/', '/api/admin/')))
    }
  })
})

/* ------------------------------------ a grade da PÁGINA não nasce aberta */

/**
 * A régua da página tem que ser a MESMA da rota também no caso que ninguém
 * classificou — e esse é o caso que decide se o defeito volta sozinho.
 *
 * `areaDaRota` não tem catch-all: caminho desconhecido devolve `null`, e
 * `null` é só-do-master (a decisão 1, no topo de `papeis.ts`). A tabela das
 * páginas tinha: `['/admin', 'evento_ver']` estava na lista de PREFIXOS, e
 * `/admin` é prefixo de todo o painel. Resultado medido antes deste conserto:
 *
 *     areaDaPagina('/admin/filas')                    -> 'evento_ver'
 *     areaDaRota('/api/admin/filas')                  -> null
 *     podeAbrirPagina('operacao', '/admin/filas')     -> true
 *     decidirAcesso('operacao', '/api/admin/filas')   -> 403
 *
 * Ou seja: a tela nova nascia DESENHADA no menu de quem é de operação e de
 * quem é do financeiro, e respondendo 403 no clique — que é exatamente o item
 * morto que o filtro do menu existe pra apagar. Não é hipótese: a rota
 * `/api/admin/filas` já existe, já é só-do-master (está em `SO_DO_MASTER`), e
 * faltava só alguém pendurar a tela dela no menu de raiz.
 *
 * O lado de dentro do evento sempre esteve certo (tela desconhecida devolve
 * `null`); o furo era só na raiz, por causa do prefixo.
 */
describe('a página que ninguém classificou é do master, igual à rota', () => {
  it('página de raiz sem área não chega no menu de quem não é master', () => {
    const naoClassificadas = [
      '/admin/filas',          // a rota existe hoje e é só-do-master
      '/admin/payout',         // idem: é por onde o dinheiro SAI
      '/admin/tela-de-amanha', // a que ainda não foi escrita
    ]
    for (const pagina of naoClassificadas) {
      expect(areaDaPagina(pagina),
        `${pagina} ganhou área de graça: o menu vai oferecer o que a rota nega`).toBe(null)
      expect(podeAbrirPagina('master', pagina), pagina).toBe(true)
      for (const papel of ['financeiro', 'operacao', 'portaria'] as const) {
        expect(podeAbrirPagina(papel, pagina),
          `${papel} recebeu ${pagina} no menu — e a rota dela responde 403`).toBe(false)
      }
    }
  })

  it('menu e rota negam a mesma página pros mesmos papéis', () => {
    for (const pagina of ['/admin/filas', '/admin/payout', '/admin/tela-de-amanha']) {
      const rota = pagina.replace('/admin/', '/api/admin/')
      for (const papel of PAPEIS) {
        expect(podeAbrirPagina(papel, pagina),
          `${papel}: o menu diz ${podeAbrirPagina(papel, pagina)} e a rota diz `
          + `${decidirAcesso(papel, rota).liberado} sobre ${pagina}`)
          .toBe(decidirAcesso(papel, rota).liberado)
      }
    }
  })

  /**
   * O contrário do caso de cima: fechar a raiz não pode ter fechado as telas
   * que EXISTEM. Cada uma destas tem entrada própria na tabela; se alguém
   * apagar uma achando que o catch-all cobre, ela some do menu de quem
   * trabalha nela — e "a tela sumiu" é tão silencioso quanto o item morto.
   */
  it('e as páginas de raiz que existem continuam chegando em quem trabalha nelas', () => {
    expect(areaDaPagina('/admin'), 'a lista de eventos').toBe('evento_ver')
    expect(areaDaPagina('/admin/suporte')).toBe('evento_ver')
    expect(areaDaPagina('/admin/equipe')).toBe('equipe')
    expect(areaDaPagina('/admin/financeiro')).toBe('dinheiro')
    expect(areaDaPagina('/admin/auditoria')).toBe('dinheiro')
    expect(areaDaPagina('/admin/reconciliacao')).toBe('dinheiro')
    expect(areaDaPagina('/admin/configuracoes')).toBe('organizacao')
    expect(areaDaPagina('/admin/organizacoes')).toBe('organizacao')
    expect(areaDaPagina('/admin/evento/novo')).toBe('evento')

    // e o menu de raiz que cada papel recebe não mudou de tamanho
    const menuRaiz = ['/admin', '/admin/organizacoes', '/admin/equipe', '/admin/financeiro',
      '/admin/auditoria', '/admin/reconciliacao', '/admin/configuracoes', '/admin/suporte']
    const quantos = (papel: (typeof PAPEIS)[number]) =>
      menuRaiz.filter((p) => podeAbrirPagina(papel, p)).length
    expect(quantos('master')).toBe(8)
    expect(quantos('financeiro')).toBe(5)
    expect(quantos('operacao')).toBe(2)
    expect(quantos('portaria')).toBe(0)
  })
})

/* -------------------------------------------------------------- na rota */

let noAr = false
let pedidoId = ''
let codigoReal = ''
let inicio = new Date()
/** Por que o login SEMEADO da portaria não entrou, quando não entrou. */
let semPortariaSemeada = ''
const codigosLidos: string[] = []
const http: Record<string, ReturnType<typeof comSessao>> = {}

async function entrarCom(email: string) {
  const r = await fetch(`${BASE}/api/auth/entrar`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, senha: SENHA }),
  })
  if (!r.ok) throw new Error(`login de ${email} falhou (${r.status})`)
  const cookie = (r.headers.getSetCookie?.() ?? [])
    .map((c) => c.split(';')[0]).find((c) => c.startsWith('dt_sessao='))
  if (!cookie) throw new Error(`login de ${email} não devolveu cookie`)
  return cookie
}

beforeAll(async () => {
  try {
    noAr = (await fetch(`${BASE}/api/auth/eu`, { signal: AbortSignal.timeout(2500) })).ok
  } catch { noAr = false }
  if (!noAr) return

  inicio = new Date()

  /**
   * Limpa o freio de força bruta DOS E-MAILS DESTE ARQUIVO antes de entrar.
   *
   * O freio conta oito falhas por e-mail em quinze minutos. Os logins daqui
   * nunca erram a senha de propósito — mas uma rodada anterior interrompida (ou
   * outra rodada da suíte acontecendo ao mesmo tempo, que apaga a organização
   * deste arquivo no `afterAll` dela) deixa estes e-mails sem linha por alguns
   * segundos, e cada tentativa nesse intervalo conta como falha. Passando de
   * oito, TODO caso deste arquivo fica vermelho por 429 — vermelho que não é o
   * defeito, e que já enganou uma leitura inteira.
   *
   * Só os e-mails fabricados aqui. Os semeados (`dono@`, `portaria@`) são
   * compartilhados com outros arquivos e ficam de fora: apagar o freio deles
   * seria apagar a prova de outro teste.
   */
  await q(`DELETE FROM login_attempts WHERE ok = false AND email = ANY($1::text[])`,
    [[...Object.values(USUARIOS).map((u) => u.email), PORTARIA_SOLTA.email,
      ...Object.values(MASTERS).map((u) => u.email), EMAIL_DA_VIZINHA, EMAIL_REPETIDO]])

  // A senha é a mesma do dono porque o hash é copiado dele — nenhuma senha
  // nova entra no banco por causa de teste.
  for (const [papel, u] of Object.entries(USUARIOS)) {
    await q(
      `INSERT INTO users (id, org_id, name, email, password_hash, papel, role)
       SELECT $1, org_id, $2, $3, password_hash, $4, $5
         FROM users WHERE email = 'dono@fazendapark.com.br'
       ON CONFLICT (id) DO UPDATE SET papel = EXCLUDED.papel, role = EXCLUDED.role, active = true`,
      [u.id, `Teste ${papel}`, u.email, papel, roleLegado(papel as any)])
    http[papel] = comSessao(await entrarCom(u.email))
  }

  // papel de portaria com `role` de operação — ver PORTARIA_SOLTA lá em cima
  await q(
    `INSERT INTO users (id, org_id, name, email, password_hash, papel, role)
     SELECT $1, org_id, 'Teste portaria solta', $2, password_hash, $3, $4
       FROM users WHERE email = 'dono@fazendapark.com.br'
     ON CONFLICT (id) DO UPDATE SET papel = EXCLUDED.papel, role = EXCLUDED.role, active = true`,
    [PORTARIA_SOLTA.id, PORTARIA_SOLTA.email, PORTARIA_SOLTA.papel, PORTARIA_SOLTA.role])
  http.portariaSolta = comSessao(await entrarCom(PORTARIA_SOLTA.email))

  // O único login que este arquivo NÃO fabrica: o da portaria que já existe no
  // parque. Ele tem que continuar entrando — é metade do item. Se o freio de
  // força bruta o travar por causa de outra rodada, os dois casos dele param
  // dizendo POR QUÊ, em vez de acusar uma permissão que não mudou.
  try {
    http.portariaSemeada = comSessao(await entrarCom('portaria@fazendapark.com.br'))
  } catch (e: any) {
    semPortariaSemeada = e?.message ?? String(e)
  }

  // a organização de dois masters, à parte da semeada — ver MASTERS lá em cima
  await q(`INSERT INTO organizations (id, name, slug)
           VALUES ($1,'ZZ EQUIPE PAPEIS','zz-equipe-papeis')
           ON CONFLICT (id) DO NOTHING`, [ORG_EQUIPE])
  for (const [nome, u] of Object.entries(MASTERS)) {
    await q(
      `INSERT INTO users (id, org_id, name, email, password_hash, papel, role)
       SELECT $1, $2, $3, $4, password_hash, 'master', 'master'
         FROM users WHERE email = 'dono@fazendapark.com.br'
       ON CONFLICT (id) DO UPDATE SET papel = 'master', role = 'master', active = true`,
      [u.id, ORG_EQUIPE, `Master equipe ${nome}`, u.email])
    http[nome] = comSessao(await entrarCom(u.email))
  }

  pedidoId = (await q1<any>(`SELECT id FROM orders WHERE event_id = $1 LIMIT 1`, [EVENTO]))?.id ?? ''
  codigoReal = (await q1<any>(
    `SELECT code FROM tickets WHERE event_id = $1 AND status = 'valido' LIMIT 1`, [EVENTO]))?.code ?? ''
})

afterAll(async () => {
  await q(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [[ORG_EQUIPE, ORG_VIZINHA]])
  await q(`DELETE FROM users WHERE email = ANY($1::text[])`,
    [[EMAIL_DA_VIZINHA, EMAIL_REPETIDO]])
  // as leituras que a catraca registrou por causa deste teste, uma a uma
  if (codigosLidos.length) {
    await q(
      `DELETE FROM checkins
        WHERE event_id = $1 AND created_at >= $2 AND code_lido = ANY($3::text[])`,
      [EVENTO, inicio, codigosLidos])
  }
  await q(`DELETE FROM users WHERE id = ANY($1::uuid[])`,
    [[...Object.values(USUARIOS).map((u) => u.id), PORTARIA_SOLTA.id]])
})

/** status da rota, com o cookie daquele papel */
const bater = async (papel: string, rota: string, metodo = 'GET', corpo?: unknown) => {
  const r = await http[papel](rota, {
    method: metodo,
    body: metodo === 'GET' ? undefined : JSON.stringify(corpo ?? {}),
  })
  return { status: r.status, corpo: await r.json().catch(() => ({})) }
}

describe('o papel decide na ROTA, não no menu', () => {
  it('operação não vê o saldo nem pede transferência', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')

    const saldo = await bater('operacao', `/api/admin/evento/${EVENTO}/financeiro`)
    expect(saldo.status, JSON.stringify(saldo.corpo)).toBe(403)

    // o pedido de saque, com corpo VÁLIDO: tem que morrer no porteiro, antes
    // de qualquer linha em payouts
    const antes = await q1<any>(`SELECT count(*)::int AS n FROM payouts WHERE event_id = $1`, [EVENTO])
    const saque = await bater('operacao', `/api/admin/evento/${EVENTO}/financeiro`, 'POST', {
      beneficiario: 'Teste Papéis', destinoTipo: 'pix',
      destino: 'teste@papeis.local', valorCents: 1000,
    })
    expect(saque.status, JSON.stringify(saque.corpo)).toBe(403)
    const depois = await q1<any>(`SELECT count(*)::int AS n FROM payouts WHERE event_id = $1`, [EVENTO])
    expect(depois.n, 'o saque recusado deixou linha em payouts').toBe(antes.n)
  }, PRAZO)

  it('operação não vê borderô, extrato nem painel de faturamento', async () => {
    if (!noAr) return void console.warn('  (pulado)')
    for (const tela of ['bordero', 'extrato', 'dashboard', 'relatorios']) {
      const r = await bater('operacao', `/api/admin/evento/${EVENTO}/${tela}`)
      expect(r.status, `${tela}: ${JSON.stringify(r.corpo)}`).toBe(403)
    }
  }, PRAZO)

  it('operação continua fazendo o trabalho dela', async () => {
    if (!noAr) return void console.warn('  (pulado)')
    for (const tela of ['ingressos', 'cupons', 'vendas', 'pdv', 'checkins']) {
      const r = await bater('operacao', `/api/admin/evento/${EVENTO}/${tela}`)
      expect(r.status, `${tela}: ${JSON.stringify(r.corpo)}`).toBe(200)
    }
  }, PRAZO)

  it('portaria não lê o cadastro da organização nem a ficha do comprador', async () => {
    if (!noAr) return void console.warn('  (pulado)')

    // as duas rotas que respondiam 200 pra QUALQUER login, porque nenhum
    // prefixo do porteiro antigo cobria elas
    const org = await bater('portaria', '/api/admin/organizacao')
    expect(org.status, JSON.stringify(org.corpo)).toBe(403)

    const pedido = await bater('portaria', `/api/admin/pedido/${pedidoId}`)
    expect(pedido.status, JSON.stringify(pedido.corpo)).toBe(403)
  }, PRAZO)

  /**
   * O caso que mede ESTA grade sozinha. Todos os outros 403 de portaria dentro
   * do evento poderiam ser do porteiro antigo — `role = 'portaria'` já não tem
   * a área "evento" lá. Aqui o `role` é o largo de operação, o `01` libera, e
   * quem sobra pra negar é o `03`. Por isso o caso confere a MENSAGEM: um 403
   * com o texto do porteiro velho seria a prova errada.
   */
  it('com o porteiro antigo liberando, a grade fina segura a portaria sozinha', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')

    const hist = await bater('portariaSolta', `/api/admin/evento/${EVENTO}/checkins`)
    expect(hist.status, JSON.stringify(hist.corpo)).toBe(403)
    const motivo = hist.corpo.statusMessage ?? hist.corpo.message ?? ''
    expect(motivo, 'quem negou foi o porteiro antigo, não esta grade')
      .toContain('quem já entrou')

    // e o resto do evento continua fechado pra ela pelo mesmo caminho
    for (const tela of ['financeiro', 'bordero', 'ingressos', 'pdv']) {
      const r = await bater('portariaSolta', `/api/admin/evento/${EVENTO}/${tela}`)
      expect(r.status, `${tela}: ${JSON.stringify(r.corpo)}`).toBe(403)
    }

    // o leitor de entrada, que é o trabalho dela, continua de pé
    const codigo = `PAPEIS-SOLTA-${Date.now()}`
    codigosLidos.push(codigo)
    const leitura = await bater('portariaSolta', '/api/checkin', 'POST',
      { qr: codigo, eventId: EVENTO, gate: 'teste-papeis' })
    expect(leitura.status, JSON.stringify(leitura.corpo)).toBe(200)
  }, PRAZO)

  it('operação também não lê o cadastro e as credenciais de cobrança', async () => {
    if (!noAr) return void console.warn('  (pulado)')
    const org = await bater('operacao', '/api/admin/organizacao')
    expect(org.status, JSON.stringify(org.corpo)).toBe(403)
    // e não troca a chave do Asaas
    const troca = await bater('operacao', '/api/admin/organizacao', 'PATCH', { nome: 'Nome Roubado' })
    expect(troca.status).toBe(403)
  }, PRAZO)

  it('só master mexe em equipe — nem o financeiro', async () => {
    if (!noAr) return void console.warn('  (pulado)')
    for (const papel of ['financeiro', 'operacao', 'portaria']) {
      const ler = await bater(papel, '/api/admin/equipe')
      expect(ler.status, `${papel} leu a equipe`).toBe(403)
      const criar = await bater(papel, '/api/admin/equipe', 'POST',
        { nome: 'Intruso', email: `intruso.${papel}@teste.local`, papel: 'master' })
      expect(criar.status, `${papel} criou acesso`).toBe(403)
    }
    const meu = await q1<any>(
      `SELECT count(*)::int AS n FROM users WHERE email LIKE 'intruso.%@teste.local'`)
    expect(meu.n, 'a criação recusada gravou usuário').toBe(0)
  }, PRAZO)

  it('o financeiro CHEGA no dinheiro — e só nele', async () => {
    if (!noAr) return void console.warn('  (pulado)')

    // antes desta grade, quem era `financeiro` levava 403 aqui: o prefixo do
    // evento não estava na grade grossa dele
    for (const tela of ['financeiro', 'bordero', 'extrato', 'relatorios']) {
      const r = await bater('financeiro', `/api/admin/evento/${EVENTO}/${tela}`)
      expect(r.status, `${tela}: ${JSON.stringify(r.corpo)}`).toBe(200)
    }
    expect((await bater('financeiro', '/api/admin/financeiro')).status).toBe(200)

    // e não configura evento nem vende no balcão
    expect((await bater('financeiro', `/api/admin/evento/${EVENTO}/ingressos`)).status).toBe(403)
    expect((await bater('financeiro', `/api/admin/evento/${EVENTO}/pdv`)).status).toBe(403)
    expect((await bater('financeiro', `/api/admin/evento/${EVENTO}/checkins`)).status).toBe(403)
  }, PRAZO)

  it('rota nova nasce trancada pra quem não é master', async () => {
    if (!noAr) return void console.warn('  (pulado)')
    const nova = '/api/admin/tela-que-alguem-vai-criar-amanha'
    for (const papel of ['financeiro', 'operacao', 'portaria']) {
      expect((await bater(papel, nova)).status, papel).toBe(403)
    }
    // pro master ela simplesmente não existe ainda — 404, que é a resposta do
    // roteador, não do porteiro
    expect((await bater('master', nova)).status).toBe(404)
    // o prazo é folgado de propósito: o 404 de rota inexistente faz o servidor
    // de desenvolvimento montar a página de erro, e isso leva mais de um
    // segundo sozinho
  }, 20_000)
})

describe('a portaria continua entrando e validando', () => {
  /** Pula dizendo o motivo — nunca em silêncio, nunca passando por verde. */
  function semSessaoSemeada(): boolean {
    if (!noAr) { console.warn('  (pulado: servidor fora do ar)'); return true }
    if (semPortariaSemeada) { console.warn(`  (pulado: ${semPortariaSemeada})`); return true }
    return false
  }

  it('o login semeado da portaria entra e a catraca responde', async () => {
    if (semSessaoSemeada()) return

    const eu = await http.portariaSemeada('/api/auth/eu').then((r) => r.json())
    expect(eu.usuario?.email).toBe('portaria@fazendapark.com.br')

    const codigo = `PAPEIS-TESTE-${Date.now()}`
    codigosLidos.push(codigo)
    const r = await bater('portariaSemeada', '/api/checkin', 'POST',
      { qr: codigo, eventId: EVENTO, gate: 'teste-papeis' })
    // chegou no handler: quem responde 'invalido' é a catraca, não o porteiro
    expect(r.status, JSON.stringify(r.corpo)).toBe(200)
    expect(r.corpo.resultado).toBe('invalido')
  }, PRAZO)

  it('a portaria confere um ingresso de verdade sem queimá-lo', async () => {
    if (semSessaoSemeada()) return
    expect(codigoReal, 'o seed não tem ingresso válido').not.toBe('')
    codigosLidos.push(codigoReal)

    const r = await bater('portariaSemeada', '/api/checkin', 'POST',
      { qr: codigoReal, eventId: EVENTO, apenasConsultar: true })
    expect(r.status, JSON.stringify(r.corpo)).toBe(200)
    // O veredito depende da hora: fora da janela da sessão o seed responde
    // `fora_da_sessao`, e isso é a catraca funcionando. O que este caso
    // precisa provar é que ela ACHOU o ingresso — `invalido` é a resposta de
    // código que não existe, e seria também a resposta se a leitura tivesse
    // morrido antes de consultar o banco.
    expect(r.corpo.resultado, JSON.stringify(r.corpo)).not.toBe('invalido')

    // "só conferir" não pode ter gasto o ingresso do evento semeado
    const t = await q1<any>(`SELECT status FROM tickets WHERE code = $1`, [codigoReal])
    expect(t.status).toBe('valido')
  }, PRAZO)

  it('a portaria não chega no dinheiro por nenhum caminho', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    for (const rota of [
      `/api/admin/evento/${EVENTO}/financeiro`,
      `/api/admin/evento/${EVENTO}/bordero`,
      '/api/admin/financeiro',
    ]) {
      expect((await bater('portaria', rota)).status, rota).toBe(403)
      // o login que já existe no parque, além do fabricado aqui: é ele que
      // está no celular do portão hoje
      if (!semPortariaSemeada) {
        expect((await bater('portariaSemeada', rota)).status, rota).toBe(403)
      }
    }
    if (semPortariaSemeada) console.warn(`  (só o login fabricado: ${semPortariaSemeada})`)
  }, PRAZO)
})

/* --------------------------------------------- a organização não fica órfã */

/**
 * O outro lado da grade: quem ENTREGA o papel.
 *
 * A grade acima prova que só o master mexe em equipe. Falta provar que a tela
 * de equipe não consegue apagar o último master — porque, desde que esta
 * grade existe, organização sem master não é só "sem administrador": é
 * organização onde NINGUÉM mais abre equipe (área `equipe`) nem a credencial
 * de cobrança (área `organizacao`), e não existe caminho pela tela pra
 * desfazer. Não é um 422 de conforto; é a única coisa entre a operação e um
 * painel que ninguém mais administra.
 *
 * As três travas do `PATCH /api/admin/equipe` não tinham NENHUM teste. Medido
 * por mutação: arrancando as três de uma vez (a de não se rebaixar sozinho, a
 * do último master e a revogação de sessão) a suíte inteira continuava verde.
 *
 * O caso de concorrência não usa `Promise.all` com dois `fetch` — dois pedidos
 * não chegam juntos no servidor de desenvolvimento e o primeiro já gravou
 * quando o segundo lê. A ordem é forçada na mão: uma terceira conexão segura
 * as linhas dos masters, as duas rotas passam pela decisão e param na hora de
 * gravar, e só então a trava é solta.
 */
describe('a tela de equipe não deixa a organização sem master', () => {
  /** volta os dois pra master e renova os dois cookies (rebaixar revoga sessão) */
  async function doisMastersDePe() {
    await q(
      `UPDATE users SET papel = 'master', role = 'master', active = true
        WHERE id = ANY($1::uuid[])`, [[MASTERS.m1.id, MASTERS.m2.id]])
    for (const [nome, u] of Object.entries(MASTERS)) http[nome] = comSessao(await entrarCom(u.email))
  }

  const mastersAtivos = async () =>
    (await q1<any>(
      `SELECT count(*)::int AS n FROM users
        WHERE org_id = $1 AND papel = 'master' AND active`, [ORG_EQUIPE]))!.n

  it('ninguém se rebaixa nem se desativa sozinho', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    await doisMastersDePe()

    const rebaixar = await bater('m1', '/api/admin/equipe', 'PATCH',
      { id: MASTERS.m1.id, papel: 'operacao' })
    expect(rebaixar.status, JSON.stringify(rebaixar.corpo)).toBe(422)

    const desativar = await bater('m1', '/api/admin/equipe', 'PATCH',
      { id: MASTERS.m1.id, ativo: false })
    expect(desativar.status, JSON.stringify(desativar.corpo)).toBe(422)

    const eu = await q1<any>(`SELECT papel, active FROM users WHERE id = $1`, [MASTERS.m1.id])
    expect(eu.papel, 'ele se rebaixou e não tem como voltar pela tela').toBe('master')
    expect(eu.active, 'ele se trancou pra fora da própria conta').toBe(true)
  }, PRAZO)

  /**
   * A trava do último master, lida com atenção, **nunca dispara num pedido
   * sozinho**: quem manda o PATCH já precisa ser master (área `equipe`), a
   * trava de cima impede que ele seja o próprio alvo, e a contagem é de
   * masters ativos com `id <> alvo` — ou seja, ele mesmo sempre entra na
   * conta. Sequencialmente a resposta certa é 200 e o guarda é decoração.
   *
   * Ele só existe pra UM caso: dois pedidos ao mesmo tempo, cada um tirando
   * um dos dois últimos masters. É o caso do teste abaixo, e é onde a
   * contagem fora da transação não segura nada.
   */
  it('rebaixar um master com outro de pé é permitido — e sobra um', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    await doisMastersDePe()

    const r = await bater('m1', '/api/admin/equipe', 'PATCH',
      { id: MASTERS.m2.id, papel: 'operacao' })
    expect(r.status, JSON.stringify(r.corpo)).toBe(200)
    expect(await mastersAtivos(), 'a trava do último master barrou um caso legítimo').toBe(1)

    // e o rebaixado não se repromove: equipe é área de master
    expect((await bater('m2', '/api/admin/equipe', 'PATCH',
      { id: MASTERS.m2.id, papel: 'master' })).status,
      'um ex-master se repromoveu').not.toBe(200)
  }, PRAZO)

  it('rebaixar alguém derruba a sessão que ele já tinha aberta', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    await doisMastersDePe()

    // a sessão de m2 está de pé agora
    expect((await bater('m2', '/api/admin/equipe')).status).toBe(200)

    expect((await bater('m1', '/api/admin/equipe', 'PATCH',
      { id: MASTERS.m2.id, papel: 'operacao' })).status).toBe(200)

    // 401 (sessão revogada), não 403: 403 seria o papel novo barrando com o
    // cookie antigo ainda válido — que é exatamente o que não pode sobrar.
    const depois = await bater('m2', '/api/admin/equipe')
    expect(depois.status, 'o cookie de antes do rebaixamento continua valendo').toBe(401)
  }, PRAZO)

  /**
   * A trava tem que vir ANTES da decisão. Com a contagem de masters feita
   * fora da transação e sem `FOR UPDATE`, os dois pedidos leem "sobra outro"
   * e os dois gravam: a organização acorda sem master nenhum.
   *
   * ## Por que a espera é medida no BANCO, e não em milissegundos
   *
   * Este caso já esperou 400 ms entre disparar um pedido e o outro, torcendo
   * pra que nesse tempo ele tivesse chegado no `FOR UPDATE`. Num servidor de
   * desenvolvimento recém-editado, o handler ainda está COMPILANDO nesses
   * 400 ms: o `ROLLBACK` solta a trava antes de qualquer um dos dois chegar
   * nela, os dois rodam sem nunca disputar linha, e o caso fica vermelho
   * dizendo "os dois pedidos foram aceitos" — vermelho que não é o defeito.
   * Medido: uma reprovação em oito rodadas, sempre a primeira depois de um
   * arquivo mudar, que é exatamente quando se roda a suíte.
   *
   * Agora a espera é por FATO: `pg_stat_activity` mostra quem está parado
   * esperando lock. O caso só solta a trava depois de VER os dois pedidos
   * presos nela — e, se eles nunca ficarem presos (que é o que acontece com o
   * `FOR UPDATE` arrancado), o caso continua vermelho, só que na asserção
   * certa: a organização sem master nenhum.
   */
  it('CONCORRÊNCIA — dois masters se rebaixando ao mesmo tempo não zeram a organização',
    async () => {
      if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
      await doisMastersDePe()

      /**
       * Quantos pedidos estão parados esperando ESTA trava.
       *
       * O texto casado é o da consulta que a rota de equipe faz antes de
       * decidir, e só ela: `users` + `papel = 'master'` + `FOR UPDATE`. Contar
       * qualquer espera de lock do banco pegaria carona em outra rodada da
       * suíte acontecendo ao mesmo tempo — e um contador que sobe por causa do
       * vizinho é tão ruim quanto o relógio que este caso acabou de aposentar.
       */
      const presosNaTrava = async () => Number((await q1<any>(
        `SELECT count(*)::int AS n
           FROM pg_stat_activity
          WHERE datname = current_database()
            AND pid <> pg_backend_pid()
            AND wait_event_type = 'Lock'
            AND query ILIKE '%FROM users%'
            AND query ILIKE '%papel = ''master''%'
            AND query ILIKE '%FOR UPDATE%'`))!.n)

      /** espera até `quantos` pedidos estarem presos; desiste depois de 15 s */
      const esperarPresos = async (quantos: number) => {
        const limite = Date.now() + 15_000
        while (Date.now() < limite) {
          if (await presosNaTrava() >= quantos) return quantos
          await new Promise((r) => setTimeout(r, 50))
        }
        return await presosNaTrava()
      }

      const trava = await db().connect()
      let respostas: number[] = []
      let corpos: any[] = []
      let presos = 0
      try {
        await trava.query('BEGIN')
        // segura as linhas dos masters desta organização: as duas rotas
        // passam pela decisão e ficam paradas na hora de gravar
        await trava.query(
          `SELECT id FROM users
            WHERE org_id = $1 AND papel = 'master' AND active
            ORDER BY id FOR UPDATE`, [ORG_EQUIPE])

        const p1 = http.m1('/api/admin/equipe', {
          method: 'PATCH', body: JSON.stringify({ id: MASTERS.m2.id, papel: 'operacao' }),
        })
        // o primeiro tem que estar preso ANTES do segundo sair: é assim que a
        // ordem fica na mão do teste, e não no relógio
        await esperarPresos(1)
        const p2 = http.m2('/api/admin/equipe', {
          method: 'PATCH', body: JSON.stringify({ id: MASTERS.m1.id, papel: 'operacao' }),
        })
        presos = await esperarPresos(2)

        // solta: agora os dois gravam (ou o segundo descobre que virou o último)
        await trava.query('ROLLBACK')
        const fim = await Promise.all([p1, p2])
        respostas = fim.map((r) => r.status)
        corpos = await Promise.all(fim.map((r) => r.json().catch(() => ({}))))
      } finally {
        // ROLLBACK antes de devolver ao pool, SEMPRE — `release()` não desfaz
        // transação aberta e a trava ficaria pendurada no caso seguinte.
        await trava.query('ROLLBACK').catch(() => {})
        trava.release()
      }

      expect(await mastersAtivos(),
        'os dois rebaixamentos passaram: a organização ficou sem nenhum master — '
        + 'ninguém mais abre equipe nem a credencial de cobrança, e não há tela pra desfazer')
        .toBeGreaterThanOrEqual(1)
      // a prova de que a serialização foi EXERCITADA, e não presumida: os dois
      // pedidos foram vistos parados na mesma trava. Sem isto, um caso em que
      // os dois rodaram em fila indiana sozinhos passaria dando a mesma
      // garantia que este — e é dessa ilusão que o arquivo inteiro fala.
      expect(presos,
        'nenhum dos dois pedidos chegou a ficar preso na trava: ou o handler não '
        + 'pega mais `FOR UPDATE` antes de decidir, ou ele nem chegou lá')
        .toBe(2)
      // exatamente um pedido pode ter vencido; o outro tem que ouvir a recusa
      expect(respostas.filter((s) => s === 200).length,
        `os dois pedidos foram aceitos (${respostas.join(', ')})`).toBe(1)

      // e a recusa é a MENSAGEM do último master, não um 500 de conflito de
      // banco: quem está na tela precisa saber o que fazer (promover alguém),
      // não ver "erro interno" depois de clicar.
      const i = respostas.findIndex((s) => s !== 200)
      expect(respostas[i], JSON.stringify(corpos[i])).toBe(422)
      expect(corpos[i].statusMessage ?? corpos[i].message ?? '').toContain('último master')
    }, 40_000)
})

/* ------------------------------------- um papel só, dito do mesmo jeito */

/**
 * Duas rotas mostravam o papel da MESMA pessoa e discordavam.
 *
 * `/api/auth/eu` devolvia `users.role` — a grade GROSSA e legada — enquanto o
 * `middleware/03.papel.ts` decide por `users.papel`, a grade fina. Como
 * `roleLegado('financeiro') = 'admin'` e `roleLegado('operacao') =
 * 'operacional'`, medido com o servidor no ar:
 *
 * | pessoa     | users.papel | /api/auth/eu dizia |
 * |------------|-------------|--------------------|
 * | financeiro | financeiro  | **admin**          |
 * | operação   | operacao    | **operacional**    |
 *
 * Não é rótulo torto: é a tela decidindo o que mostrar por uma régua que o
 * servidor não usa — e foi assim que o menu passou a oferecer o que o 403
 * nega. Os dois papéis onde as colunas coincidem (master, portaria) escondiam
 * o defeito; por isso os quatro são conferidos, um a um.
 */
describe('a tela e o porteiro falam do MESMO papel', () => {
  it('/api/auth/eu devolve a coluna `papel`, não o `role` legado', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')

    for (const [papel, u] of Object.entries(USUARIOS)) {
      const eu = await http[papel]('/api/auth/eu').then((r) => r.json())
      const gravado = await q1<any>(`SELECT papel, role FROM users WHERE id = $1`, [u.id])

      expect(eu.usuario?.papel,
        `${u.email}: a tela mostra um papel e o porteiro decide por outro`)
        .toBe(gravado.papel)
      expect(eu.usuario.papel, u.email).toBe(papel)
      expect(eu.usuario.papelRotulo, `${u.email}: o rótulo vem pronto do servidor`)
        .toBe((ROTULO as any)[papel])
    }

    // os dois em que as colunas DIVERGEM — se um dia passarem a coincidir,
    // este arquivo deixa de medir o que jura medir
    expect(roleLegado('financeiro'),
      'as colunas coincidiram: o caso acima ficaria verde com o defeito de volta')
      .not.toBe('financeiro')
    expect(roleLegado('operacao')).not.toBe('operacao')
  }, PRAZO)

  /**
   * O teste que não aceita rótulo bonito: com o papel que a tela RECEBEU, a
   * grade tem que prever a resposta da rota. Se a rota manda um papel de outro
   * vocabulário, `decidirAcesso` não acha a lista dele e a previsão desanda —
   * que é exatamente o menu oferecendo porta fechada.
   */
  it('o papel que a tela recebe PREVÊ o que a rota responde', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')

    const provas = [
      '/api/admin/equipe',
      '/api/admin/auditoria',
      `/api/admin/evento/${EVENTO}/financeiro`,
      `/api/admin/evento/${EVENTO}/ingressos`,
    ]

    for (const papel of Object.keys(USUARIOS)) {
      const eu = await http[papel]('/api/auth/eu').then((r) => r.json())
      const dito = eu.usuario?.papel
      for (const rota of provas) {
        const r = await bater(papel, rota)
        const previsto = decidirAcesso(dito as any, rota).liberado
        expect(r.status === 403,
          `${papel} em ${rota}: a grade previu ${previsto ? 'liberado' : '403'} `
          + `com o papel "${dito}" que a tela recebeu, e a rota respondeu ${r.status}`)
          .toBe(!previsto)
      }
    }
  }, 40_000)
})

/* ------------------------------- as telas que estavam fora, agora na rota */

/**
 * O outro lado do caso de varredura: a rota de verdade, com o cookie de quem
 * precisa dela. Medido antes, com a portaria logada, as seis respondiam
 * `403 ... nenhum acesso além do master` — inclusive pro financeiro e pro
 * balcão.
 */
describe('as telas destrancadas chegaram em quem trabalha nelas', () => {
  it('o financeiro abre auditoria e reconciliação', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    for (const rota of ['/api/admin/auditoria', '/api/admin/reconciliacao']) {
      const r = await bater('financeiro', rota)
      expect(r.status, `${rota}: ${JSON.stringify(r.corpo).slice(0, 300)}`).toBe(200)
    }
  }, PRAZO)

  it('a operação configura as datas do evento e reenvia ingresso que não chegou', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')

    expect((await bater('operacao', `/api/admin/evento/${EVENTO}/sessoes`)).status).toBe(200)

    // corpo vazio de propósito: o que importa é ter CHEGADO no handler. 400
    // ("Informe o pedido...") é a validação dele; 403 seria o porteiro.
    const reenvio = await bater('operacao', `/api/admin/evento/${EVENTO}/reenviar`, 'POST', {})
    expect(reenvio.status, JSON.stringify(reenvio.corpo).slice(0, 300)).not.toBe(403)
    expect(reenvio.corpo.statusMessage ?? reenvio.corpo.message ?? '').toContain('pedido')
  }, PRAZO)

  it('quem não tem caixa não cancela o evento inteiro, e a portaria não abre nada disso', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')

    // cancelar enfileira estorno de TODO pedido vivo: é saída de dinheiro
    const antes = await q1<any>(
      `SELECT count(*)::int AS n FROM refund_jobs WHERE event_id = $1`, [EVENTO])
    const r = await bater('operacao', `/api/admin/evento/${EVENTO}/cancelar`, 'POST',
      { escopo: 'evento', motivo: 'teste de papéis — não deve passar' })
    expect(r.status, JSON.stringify(r.corpo).slice(0, 300)).toBe(403)
    const depois = await q1<any>(
      `SELECT count(*)::int AS n FROM refund_jobs WHERE event_id = $1`, [EVENTO])
    expect(depois.n, 'o cancelamento recusado enfileirou estorno no evento semeado').toBe(antes.n)

    const estado = await q1<any>(`SELECT status FROM events WHERE id = $1`, [EVENTO])
    expect(estado.status, 'o evento semeado foi cancelado por um papel que não tem caixa')
      .not.toBe('cancelado')

    for (const rota of ['/api/admin/auditoria', '/api/admin/reconciliacao',
      `/api/admin/evento/${EVENTO}/sessoes`]) {
      expect((await bater('portaria', rota)).status, rota).toBe(403)
    }
  }, PRAZO)
})

/* ---------------------------------------- um e-mail, um login, um sistema */

/**
 * O cadastro conferia o e-mail repetido POR ORGANIZAÇÃO
 * (`WHERE org_id = $1 AND lower(email) = $2`, de mãos dadas com o índice único
 * `(org_id, email)`), e o login não pergunta a organização: `auth/entrar.post.ts`
 * procura em `users` inteiro e fica com a primeira linha.
 *
 * O resultado era o pior tipo de defeito deste projeto — o que não lança
 * exceção, não suja log e não deixa teste vermelho: o acesso nascia "com
 * sucesso", a senha provisória era entregue, e a pessoa nunca mais entrava. A
 * senha dela era conferida contra o hash da OUTRA, e a resposta era
 * "E-mail ou senha não confere" — a mesma de senha errada.
 *
 * Duas saídas eram possíveis: ensinar a organização ao login, ou tratar o
 * e-mail como global. A segunda foi a escolhida (o login é a porta de um
 * sistema só; pedir "qual é a sua loja?" na tela de entrada é pedir uma
 * informação que a pessoa do guichê não tem). Estes casos provam os dois
 * lados: a recusa na tela, e o estrago que ela evita.
 */
describe('o e-mail é um só no sistema, porque o login também é', () => {
  beforeAll(async () => {
    if (!noAr) return
    await q(`INSERT INTO organizations (id, name, slug)
             VALUES ($1,'ZZ VIZINHA PAPEIS','zz-vizinha-papeis')
             ON CONFLICT (id) DO NOTHING`, [ORG_VIZINHA])
    await q(`DELETE FROM users WHERE email = ANY($1::text[])`,
      [[EMAIL_DA_VIZINHA, EMAIL_REPETIDO]])
    await q(`INSERT INTO users (org_id, name, email, password_hash, papel, role)
             VALUES ($1,'Gente da Vizinha',$2,$3,'operacao','operacional')`,
      [ORG_VIZINHA, EMAIL_DA_VIZINHA, await bcrypt.hash(SENHA_DE_LA, 10)])

    // o bloco anterior rebaixa master de propósito; aqui m1 precisa voltar
    await q(`UPDATE users SET papel='master', role='master', active=true WHERE id = $1`,
      [MASTERS.m1.id])
    http.m1 = comSessao(await entrarCom(MASTERS.m1.email))
  })

  const quantos = async (email: string) =>
    (await q1<any>(`SELECT count(*)::int AS n FROM users WHERE lower(email) = $1`, [email]))!.n

  it('o cadastro recusa e-mail que já entra por outra organização', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    expect(await quantos(EMAIL_DA_VIZINHA), 'a fixtura da vizinha não entrou').toBe(1)

    const r = await bater('m1', '/api/admin/equipe', 'POST',
      { nome: 'Xará da Vizinha', email: EMAIL_DA_VIZINHA, papel: 'operacao' })
    expect(r.status, JSON.stringify(r.corpo).slice(0, 400)).toBe(409)

    const msg: string = r.corpo.statusMessage ?? r.corpo.message ?? ''
    expect(msg).toContain(EMAIL_DA_VIZINHA)
    expect(msg, 'a recusa não diz o motivo e quem está na tela não sabe o que fazer')
      .toMatch(/outra organização/i)
    expect(msg, 'a recusa entrega o nome do cliente vizinho').not.toMatch(/ZZ VIZINHA/i)
    expect(msg, 'recusa escrita pra máquina, não pro operador de guichê')
      .not.toMatch(/conflict|duplicate|constraint|unique/i)

    expect(await quantos(EMAIL_DA_VIZINHA),
      'a recusa gravou o acesso assim mesmo: nasceu um login que nunca abre').toBe(1)
  }, PRAZO)

  it('o mesmo e-mail na MESMA organização continua com a frase de sempre', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')
    const r = await bater('m1', '/api/admin/equipe', 'POST',
      { nome: 'Xará de Casa', email: MASTERS.m2.email, papel: 'operacao' })
    expect(r.status, JSON.stringify(r.corpo).slice(0, 400)).toBe(409)
    const msg: string = r.corpo.statusMessage ?? r.corpo.message ?? ''
    expect(msg, 'a frase da casa virou a do vizinho').toContain('Já existe acesso')
    expect(msg).not.toMatch(/outra organização/i)
  }, PRAZO)

  /**
   * O estrago que a recusa evita, MEDIDO na rota de login. As duas linhas
   * entram direto no banco porque pela tela o caso de cima não deixa mais — e
   * o índice único do banco é `(org_id, email)`, então ele aceita as duas.
   *
   * ## Por que seis tentativas, e nesta ordem
   *
   * A consulta do login é `WHERE lower(email) = $1` sem organização e **sem
   * `ORDER BY`**: qual das duas linhas volta é a ordem física da tabela. E ela
   * MUDA — `abrirSessao` grava `last_login_at`, o que reescreve a linha e a
   * joga pro fim. Medido: duas entradas alternadas (uma senha, depois a outra)
   * passaram as DUAS, porque a ordem virou no meio.
   *
   * Por isso o padrão é a mesma pessoa DUAS VEZES SEGUIDAS, que é o que
   * acontece no expediente. Qualquer que seja o comportamento da ordem, pelo
   * menos uma entrada com a senha CERTA é recusada:
   *
   * - ordem estável → a pessoa da outra linha nunca é encontrada, e as três
   *   tentativas dela caem;
   * - ordem virando a cada entrada → a segunda seguida da mesma pessoa cai.
   *
   * As seis passarem só seria possível se a linha certa estivesse na frente
   * nas seis, o que as duas senhas diferentes tornam impossível. É por isso
   * que este caso não é sorteio.
   */
  it('duas pessoas com o mesmo e-mail em lojas diferentes: a entrada vira sorteio', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')

    await q(`DELETE FROM users WHERE lower(email) = $1`, [EMAIL_REPETIDO])
    await q(`INSERT INTO users (org_id, name, email, password_hash, papel, role)
             VALUES ($1,'Pessoa Daqui',$2,$3,'operacao','operacional')`,
      [ORG_EQUIPE, EMAIL_REPETIDO, await bcrypt.hash(SENHA_DAQUI, 10)])
    await q(`INSERT INTO users (org_id, name, email, password_hash, papel, role)
             VALUES ($1,'Pessoa de Lá',$2,$3,'operacao','operacional')`,
      [ORG_VIZINHA, EMAIL_REPETIDO, await bcrypt.hash(SENHA_DE_LA, 10)])
    expect(await quantos(EMAIL_REPETIDO), 'o banco recusou as duas linhas').toBe(2)

    const tentar = async (senha: string) => {
      const r = await fetch(`${BASE}/api/auth/entrar`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: EMAIL_REPETIDO, senha }),
      })
      return { status: r.status, corpo: await r.json().catch(() => ({})) }
    }

    const roteiro = [SENHA_DAQUI, SENHA_DAQUI, SENHA_DE_LA, SENHA_DE_LA, SENHA_DAQUI, SENHA_DAQUI]
    const respostas: { senha: string; status: number; corpo: any }[] = []
    for (const senha of roteiro) respostas.push({ senha, ...(await tentar(senha)) })

    // As recusas daqui são de propósito, e o freio de força bruta não pode
    // herdar elas: oito num e-mail em quinze minutos trancariam a rodada
    // seguinte, e o vermelho apareceria num caso que não tem nada a ver com o
    // assunto. Este caso apaga exatamente o que escreveu.
    await q(`DELETE FROM login_attempts WHERE email = $1`, [EMAIL_REPETIDO])

    // se o freio pegar antes (rodada anterior, suíte rodando em paralelo),
    // este caso PULA dizendo o motivo em vez de acusar defeito que não é este
    if (respostas.some((r) => r.status === 429)) {
      return void console.warn('  (pulado: freio de força bruta respondeu 429)')
    }

    const recusadas = respostas.filter((r) => r.status !== 200)
    expect(recusadas.length,
      `as seis entradas com a senha CERTA foram aceitas (${respostas.map((r) => r.status).join(',')}): `
      + 'o login passou a saber de qual organização é o e-mail, e a recusa do cadastro virou '
      + 'exagero — reveja os dois no mesmo diff')
      .toBeGreaterThan(0)

    // e quem é recusado ouve a frase de senha errada, com a senha certa na
    // mão. É isso que o suporte não tem como adivinhar — e é por isso que o
    // cadastro recusa antes, em vez de entregar um login que às vezes abre.
    for (const r of recusadas) {
      expect(r.status).toBe(401)
      expect(r.corpo.statusMessage ?? r.corpo.message ?? '')
        .toContain('E-mail ou senha não confere')
    }
  }, PRAZO)
})

/* ------------------------------------------- a tela toda, não só o menu */

/**
 * O menu da lateral não é o único lugar em que esta tela desenha caminho.
 *
 * `layouts/admin.vue` desenha TRÊS: a lateral, a trilha do topo
 * ("EVENTOS / NOME DO EVENTO / TELA") e o ícone de suporte ao lado do avatar.
 * Filtrar só a lateral deixou as outras duas oferecendo exatamente as portas
 * que ela tinha acabado de tirar da parede. Medido no HTML servido, com a
 * lateral JÁ filtrada:
 *
 * | quem     | onde                        | o topo entregava                  |
 * |----------|-----------------------------|-----------------------------------|
 * | portaria | /admin/evento/<id>/validacao| `EVENTOS → /admin` + ícone suporte|
 * | operação | qualquer tela do evento     | nome do evento → `/dashboard`     |
 *
 * As duas da portaria respondem 403 pra ela (`/api/admin/eventos`), e a lista
 * de eventos não mostra a recusa: mostra **"Nenhum evento aqui ainda."**. Quem
 * está no portão lê "o parque não tem evento", não "não é o seu acesso". O
 * `/dashboard` da operação é pior de explicar: a lateral esconde o item de
 * propósito (faturamento do dia é área `dinheiro`) e a trilha devolve o mesmo
 * link uma linha acima.
 *
 * Este caso lê o `<header>` do HTML que o servidor entrega e exige que TODO
 * link de `/admin` que sobrar ali seja uma página que aquele papel abre — pela
 * mesma `podeAbrirPagina` de `papeis.ts`, não por uma lista escrita aqui.
 */
describe('o topo da tela não oferece porta fechada', () => {
  /**
   * Prazo próprio, muito maior que o `PRAZO` das rotas de API — e pela mesma
   * razão dele, só que em outra escala. Estes casos pedem a PÁGINA inteira,
   * renderizada no servidor: na primeira visita depois de um arquivo mudar, o
   * servidor de desenvolvimento compila o layout, a página e cada componente
   * dela. Medido nesse estado, uma única tela do evento levou mais de dois
   * minutos; aquecida, 300 ms. Com os 20 s das rotas, o vermelho que aparece
   * é "Test timed out", que não é defeito nenhum de permissão — e vermelho que
   * não é o defeito é vermelho que ninguém olha.
   */
  const PRAZO_TELA = 180_000

  /** os caminhos de /admin que o cabeçalho (trilha + ícones) oferece */
  const linksDoTopo = (html: string): string[] => {
    const cabecalho = html.match(/<header class="flex h-\[59px\][\s\S]*?<\/header>/)
    if (!cabecalho) return ['(esta tela não tem o cabeçalho do painel)']
    return [...cabecalho[0].matchAll(/href="([^"]+)"/g)]
      .map((m) => m[1]!)
      .filter((h) => h === '/admin' || h.startsWith('/admin/'))
  }

  const abrir = async (papel: string, pagina: string) => {
    const r = await http[papel](pagina)
    expect(r.status, `${pagina} não abriu pra ${papel}`).toBe(200)
    return linksDoTopo(await r.text())
  }

  it('todo link do cabeçalho é uma tela que aquele papel abre', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')

    for (const papel of PAPEIS) {
      for (const pagina of ['/admin', `/admin/evento/${EVENTO}/validacao`]) {
        const oferecidos = await abrir(papel, pagina)
        const fechados = oferecidos.filter((l) => !podeAbrirPagina(papel, l))
        expect(fechados,
          `${papel} em ${pagina}: o cabeçalho desenhou porta que a rota nega — `
          + 'clicar termina em 403, ou pior, numa tela vazia que diz que não existe nada')
          .toEqual([])
      }
    }
  }, PRAZO_TELA)

  it('a portaria não recebe nenhum atalho no topo do leitor', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')

    const oferecidos = await abrir('portaria', `/admin/evento/${EVENTO}/validacao`)
    expect(oferecidos,
      'a lateral da portaria já está vazia, com a frase explicando o motivo; '
      + 'o topo continuava oferecendo a lista de eventos e o suporte').toEqual([])

    // e é porta fechada mesmo: a tela que a trilha oferecia responde 403
    expect((await bater('portaria', '/api/admin/eventos')).status).toBe(403)
  }, PRAZO_TELA)

  it('a trilha da operação não devolve o dashboard que o menu esconde', async () => {
    if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')

    const dashboard = `/admin/evento/${EVENTO}/dashboard`
    // o menu esconde…
    expect(podeAbrirPagina('operacao', dashboard)).toBe(false)
    // …e o topo não pode devolver
    const oferecidos = await abrir('operacao', `/admin/evento/${EVENTO}/validacao`)
    expect(oferecidos, 'a trilha ligou o nome do evento no faturamento do dia')
      .not.toContain(dashboard)
    // a lista de eventos ela abre, e continua sendo link
    expect(oferecidos).toContain('/admin')

    expect((await bater('operacao', `/api/admin/evento/${EVENTO}/dashboard`)).status).toBe(403)
  }, PRAZO_TELA)

  it('e quem pode continua com os atalhos — o conserto não apagou caminho de ninguém',
    async () => {
      if (!noAr) return void console.warn('  (pulado: servidor fora do ar)')

      for (const papel of ['master', 'financeiro'] as const) {
        const oferecidos = await abrir(papel, `/admin/evento/${EVENTO}/validacao`)
        expect(oferecidos, `${papel} perdeu a volta pra lista de eventos`).toContain('/admin')
        expect(oferecidos, `${papel} perdeu o atalho de suporte`).toContain('/admin/suporte')
        expect(oferecidos, `${papel} perdeu o link do evento na trilha`)
          .toContain(`/admin/evento/${EVENTO}/dashboard`)
      }
    }, PRAZO_TELA)
})
