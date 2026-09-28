// @vitest-environment happy-dom
/**
 * layout-painel.test.ts — o shell do painel (`layouts/admin.vue`) e o `<ModalLateral>`.
 *
 *   · NAV-01: foco de TECLADO na lateral abre o trilho (os filhos dos grupos aparecem);
 *   · NAV-02: fora de evento, a trilha começa no assunto da tela ("CONFIGURAÇÕES / DADOS E
 *     COBRANÇA"), não sempre em "EVENTOS";
 *   · NAV-03: o cabeçalho do grupo acende com qualquer filho aberto (Financeiro → Relatórios);
 *   · NAV-04: "Sair" sem rede avisa que não saiu; 401 (sessão que já acabou) segue pro login;
 *   · NAV-05: a gaveta do celular trava a rolagem, prende o Tab, fecha no Esc e devolve o foco;
 *     o ModalLateral trava a rolagem, prende o Tab e fecha no Esc;
 *   · ADM-56: selo pra todo status do evento (sem "pausado"), "BORDERÔ" com acento, e a portaria
 *     sem "Voltar aos eventos" nem o pedido do resumo que ela não abre;
 *   · ADM-57: o ModalLateral fica ACIMA da lateral (z-[60] > z-50);
 *   · proposta 17: o item do menu diz o mesmo nome do h1 ("Dados e cobrança").
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { limparTela, montarTela } from './.vitest-setup-dom'
import { travasDeRolagem } from './painelFoco'

vi.setConfig({ testTimeout: 30_000 })
afterEach(() => {
  limparTela()
  document.documentElement.style.overflow = ''
  document.body.innerHTML = ''
})

const EU = (papel: string) => ({ usuario: { nome: 'Fulano de Teste', email: 'f@t.invalido', papel, papelRotulo: papel } })

async function layout(path: string, papel = 'master', extra: Record<string, any> = {}, params: Record<string, any> = {}) {
  return montarTela(await import('../layouts/admin.vue'), {
    rota: { path, params },
    respostas: { '/api/auth/eu': EU(papel), ...extra },
  })
}
const trilhaDe = (tela: any) =>
  tela.find('nav[aria-label="Onde você está"]').findAll('a, span:not([aria-hidden])').map((x: any) => x.text().trim()).filter(Boolean)

describe('trilha do topo (NAV-02) e nomes (proposta 17)', () => {
  it('fora de evento: começa no assunto da tela', async () => {
    let tela = await layout('/admin/configuracoes')
    expect(trilhaDe(tela)).toEqual(['CONFIGURAÇÕES', 'DADOS E COBRANÇA'])
    limparTela()
    tela = await layout('/admin/financeiro')
    expect(trilhaDe(tela)).toEqual(['RELATÓRIOS', 'FINANCEIRO'])
    // o degrau do assunto leva pra tela dele (quem abre)
    expect(tela.find('nav[aria-label="Onde você está"] a').attributes('href')).toBe('/admin/relatorios')
    limparTela()
    tela = await layout('/admin/clientes')
    expect(trilhaDe(tela)).toEqual(['CLIENTES'])
    limparTela()
    tela = await layout('/admin/auditoria')
    expect(trilhaDe(tela)).toEqual(['AUDITORIA'])
    limparTela()
    tela = await layout('/admin')
    expect(trilhaDe(tela)).toEqual(['EVENTOS'])
    limparTela()
    // a recusa do assistente (quem não cria evento) mora neste layout: nada de "NOVO" cru
    tela = await layout('/admin/evento/novo', 'financeiro')
    expect(trilhaDe(tela)).toEqual(['EVENTOS', 'CRIAR EVENTO'])
    expect(tela.find('nav[aria-label="Onde você está"] a').attributes('href')).toBe('/admin')
  })

  it('o item do menu diz "Dados e cobrança", como o h1 e a aba', async () => {
    const tela = await layout('/admin/configuracoes')
    const nomes = tela.findAll('nav[aria-label="Menu do painel"] a').map((a: any) => a.text().trim())
    expect(nomes).toContain('Dados e cobrança')
    expect(nomes).not.toContain('Geral e cobrança')
  })

  it('dentro do evento: EVENTOS / NOME / TELA, com acento (ADM-56)', async () => {
    const tela = await layout('/admin/evento/e1/financeiro/bordero', 'master',
      { '/api/admin/evento/e1/resumo': { nome: 'Domingo no Parque', status: 'ativo' } }, { id: 'e1' })
    expect(trilhaDe(tela)).toEqual(['EVENTOS', 'DOMINGO NO PARQUE', 'BORDERÔ'])
  })
})

describe('grupo aceso (NAV-03)', () => {
  it('em /admin/financeiro o cabeçalho "Relatórios" acende junto com o filho', async () => {
    const tela = await layout('/admin/financeiro')
    const grupo = tela.findAll('nav[aria-label="Menu do painel"] button[aria-expanded]').find((b: any) => b.text().includes('Relatórios'))!
    expect(grupo.attributes('data-aceso')).toBe('sim')
    const filho = tela.findAll('nav[aria-label="Menu do painel"] a').find((a: any) => a.text().trim() === 'Financeiro')!
    expect(filho.attributes('aria-current')).toBe('page')
    // e o grupo que não tem a tela aberta continua apagado
    const outro = tela.findAll('nav[aria-label="Menu do painel"] button[aria-expanded]').find((b: any) => b.text().includes('Configurações'))!
    expect(outro.attributes('data-aceso')).toBeUndefined()
  })
})

describe('teclado no trilho (NAV-01)', () => {
  it('o foco entrando na lateral abre o trilho: os filhos do grupo deixam de estar escondidos', async () => {
    const tela = await layout('/admin/financeiro')
    const filhos = () => tela.find('nav[aria-label="Menu do painel"] li ul')
    expect(filhos().classes(), 'recolhido, os filhos ficam fora do desenho no desktop').toContain('lg:hidden')
    await tela.find('#menu-lateral').trigger('focusin')
    await nextTick()
    expect(filhos().classes()).not.toContain('lg:hidden')
  })
})

describe('selo da situação e a portaria (ADM-56)', () => {
  it('evento cancelado se anuncia no topo; adiado em alerta; sem "pausado"', async () => {
    let tela = await layout('/admin/evento/e1/vendas', 'master',
      { '/api/admin/evento/e1/resumo': { nome: 'Feriado', status: 'cancelado' } }, { id: 'e1' })
    const selo = () => tela.find('header [class*="selo-"]')
    expect(selo().text()).toBe('CANCELADO')
    expect(selo().classes()).toContain('selo-erro')
    limparTela()
    tela = await layout('/admin/evento/e1/vendas', 'master',
      { '/api/admin/evento/e1/resumo': { nome: 'Carnaval', status: 'adiado' } }, { id: 'e1' })
    expect(selo().text()).toBe('ADIADO')
    expect(selo().classes()).toContain('selo-alerta')
  })

  it('portaria no leitor: sem "Voltar aos eventos" e sem pedir o resumo que ela não abre', async () => {
    const tela = await layout('/admin/evento/e1/validacao', 'portaria',
      { '/api/admin/evento/e1/resumo': { nome: 'Domingo no Parque', status: 'ativo' } }, { id: 'e1' })
    expect(tela.text()).not.toContain('Voltar aos eventos')
    // no dublê, o resumo só chega se a tela PEDIR — e o nome do evento só aparece se ela pediu
    expect(tela.text()).not.toContain('DOMINGO NO PARQUE')
    expect(trilhaDe(tela)).toEqual(['EVENTOS', 'VALIDAÇÃO'])
    expect(tela.find('nav[aria-label="Onde você está"] a').exists(), 'EVENTOS não é link pra portaria').toBe(false)
  })
})

describe('Sair (NAV-04)', () => {
  async function abrirConta(tela: any) {
    await tela.find('button[aria-label="Menu da sua conta"]').trigger('click')
    await nextTick()
  }

  it('sem rede: avisa que não saiu, e a sessão continua', async () => {
    const tela = await layout('/admin', 'master', { '/api/auth/sair': new Error('fetch failed') })
    await abrirConta(tela)
    await tela.find('[data-acao="sair"]').trigger('click')
    await vi.waitFor(() => expect(tela.find('[data-parte="erro-ao-sair"]').exists()).toBe(true))
    expect(tela.find('[data-parte="erro-ao-sair"]').text()).toContain('Não consegui sair agora')
    expect(tela.find('[data-acao="sair"]').text()).toBe('Sair')
  })

  it('401 (a sessão já tinha acabado) é o mesmo que ter saído: vai pro login', async () => {
    const recusa = Object.assign(new Error('401'), { statusCode: 401 })
    const local = { href: '/admin' }
    const original = Object.getOwnPropertyDescriptor(window, 'location')
    Object.defineProperty(window, 'location', { value: local, configurable: true })
    try {
      const tela = await layout('/admin', 'master', { '/api/auth/sair': recusa })
      await abrirConta(tela)
      await tela.find('[data-acao="sair"]').trigger('click')
      await vi.waitFor(() => expect(local.href).toBe('/entrar'))
    } finally {
      if (original) Object.defineProperty(window, 'location', original)
    }
  })
})

describe('gaveta do celular (NAV-05)', () => {
  it('abrir trava o fundo; Tab fica dentro; Esc fecha, solta o fundo e devolve o foco ao botão', async () => {
    const tela = await layout('/admin/relatorios', 'master')
    document.body.appendChild(tela.element as HTMLElement)
    const botao = tela.find('button[aria-label="Abrir menu"]')
    await botao.trigger('click')
    await nextTick(); await nextTick()
    expect(document.documentElement.style.overflow).toBe('hidden')
    expect(tela.find('#menu-lateral').attributes('role')).toBe('dialog')

    // Tab no último focável da gaveta volta pro primeiro
    const lateral = tela.find('#menu-lateral').element as HTMLElement
    const focaveis = [...lateral.querySelectorAll<HTMLElement>('a[href], button:not([disabled])')]
    focaveis.at(-1)!.focus()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    expect(document.activeElement).toBe(focaveis[0])

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await nextTick(); await nextTick()
    expect(tela.find('#menu-lateral').attributes('role')).toBeUndefined()
    expect(document.documentElement.style.overflow).toBe('')
    expect(document.activeElement).toBe(botao.element)
    expect(travasDeRolagem()).toBe(0)
  })
})

describe('ModalLateral (NAV-05, ADM-57)', () => {
  const Casca = defineComponent({
    setup: () => {
      const aberto = ref(false)
      const fechou = ref(0)
      return () => h('div', [
        h('button', { id: 'abrir', type: 'button', onClick: () => { aberto.value = true } }, 'Dar acesso a alguém'),
        aberto.value
          ? h((globalThis as any).__ModalLateral, { titulo: 'Dar acesso', onFechar: () => { fechou.value++; aberto.value = false } }, {
              default: () => [h('input', { id: 'campo-1' }), h('input', { id: 'campo-2' })],
              acoes: () => [h('button', { id: 'ultimo', type: 'button' }, 'Criar')],
            })
          : h('p', { id: 'fechado' }, `fechou ${fechou.value}`),
      ])
    },
  })

  it('camada acima da lateral; trava o fundo; foco no primeiro campo; Tab preso; Esc fecha, solta e devolve o foco', async () => {
    ;(globalThis as any).__ModalLateral = (await import('../components/ModalLateral.vue')).default
    const tela = await montarTela(Casca, { rota: { path: '/admin/equipe' } })
    document.body.appendChild(tela.element as HTMLElement)
    const abrir = tela.find('#abrir').element as HTMLElement
    abrir.focus()
    await tela.find('#abrir').trigger('click')
    await nextTick(); await nextTick()
    expect(tela.find('[data-parte="modal-lateral"]').classes()).toContain('z-[60]')
    expect(document.documentElement.style.overflow).toBe('hidden')
    expect((document.activeElement as HTMLElement)?.id).toBe('campo-1')

    ;(tela.find('#ultimo').element as HTMLElement).focus()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    expect((document.activeElement as HTMLElement)?.getAttribute('aria-label'), 'o Tab escapou do painel').toBe('Fechar')

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await nextTick(); await nextTick()
    expect(tela.find('#fechado').text()).toBe('fechou 1')
    expect(document.documentElement.style.overflow).toBe('')
    expect(travasDeRolagem()).toBe(0)
    expect(document.activeElement, 'o foco não voltou pra quem abriu').toBe(abrir)
  })
})
