/**
 * cadastro.test.ts — a porta por onde o cadastro do cliente entra.
 *
 * Duas metades, e a segunda vai ao BANCO de propósito: as faixas de idade dos
 * relatórios são um `CASE` gerado em SQL a partir de `FAIXAS_ETARIAS`, e o que
 * precisa ficar travado é o corte que o Postgres faz (17→18, 24→25…), não uma
 * conta parecida em TypeScript.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { db, q1 } from './db'
import {
  CadastroInvalido, cpfMascarado, FAIXAS_ETARIAS, nomeProprio, normalizarEndereco,
  normalizarInstagram, prepararCadastro, SQL_FAIXA, validarNascimento, validarSenha,
} from './cadastro'

afterAll(async () => { await db().end() })

/** Meio-dia local: longe o bastante da virada do dia pra o teste não depender da hora. */
const HOJE = new Date(2026, 8, 21, 12, 0, 0)

function campoDoErro(fn: () => unknown): string | null {
  try { fn() } catch (e) { return e instanceof CadastroInvalido ? e.campo : `outro:${(e as Error).message}` }
  return null
}

describe('nascimento', () => {
  it('aceita uma data que existe', () => {
    expect(validarNascimento('1990-12-25', HOJE)).toBe('1990-12-25')
  })

  it('recusa data que não existe (31 de fevereiro não vira 3 de março)', () => {
    expect(campoDoErro(() => validarNascimento('2001-02-31', HOJE))).toBe('nascimento')
    expect(campoDoErro(() => validarNascimento('2001-13-01', HOJE))).toBe('nascimento')
  })

  it('aceita 29 de fevereiro só em ano bissexto', () => {
    expect(validarNascimento('2000-02-29', HOJE)).toBe('2000-02-29')
    expect(campoDoErro(() => validarNascimento('2001-02-29', HOJE))).toBe('nascimento')
  })

  it('recusa o futuro, mas aceita hoje', () => {
    expect(validarNascimento('2026-09-21', HOJE)).toBe('2026-09-21')
    expect(campoDoErro(() => validarNascimento('2026-09-22', HOJE))).toBe('nascimento')
  })

  it('recusa ano de dois dígitos que virou 0026 e quem teria mais de 120 anos', () => {
    expect(campoDoErro(() => validarNascimento('0026-05-01', HOJE))).toBe('nascimento')
    expect(campoDoErro(() => validarNascimento('1899-01-01', HOJE))).toBe('nascimento')
    expect(campoDoErro(() => validarNascimento('1900-01-01', HOJE))).toBe('nascimento')
    expect(validarNascimento('1910-01-01', HOJE)).toBe('1910-01-01')
  })

  it('recusa texto que não é AAAA-MM-DD (a página converte antes de mandar)', () => {
    expect(campoDoErro(() => validarNascimento('25/12/1990', HOJE))).toBe('nascimento')
    expect(campoDoErro(() => validarNascimento('', HOJE))).toBe('nascimento')
  })
})

describe('instagram', () => {
  it('tira o @ e põe em minúsculo', () => {
    expect(normalizarInstagram('@Conquista.Park')).toBe('conquista.park')
    expect(normalizarInstagram('  conquista_park ')).toBe('conquista_park')
  })

  it('entende o link colado', () => {
    expect(normalizarInstagram('https://www.instagram.com/conquistapark/?igsh=abc123')).toBe('conquistapark')
    expect(normalizarInstagram('instagram.com/conquistapark')).toBe('conquistapark')
  })

  it('vazio não é erro — o campo é opcional', () => {
    expect(normalizarInstagram('')).toBeNull()
    expect(normalizarInstagram(undefined)).toBeNull()
    expect(normalizarInstagram('   ')).toBeNull()
  })

  it('recusa o que o Instagram não aceita', () => {
    expect(campoDoErro(() => normalizarInstagram('meu nome'))).toBe('instagram')
    expect(campoDoErro(() => normalizarInstagram('a'.repeat(31)))).toBe('instagram')
    expect(campoDoErro(() => normalizarInstagram('joão'))).toBe('instagram')
  })
})

describe('endereço', () => {
  it('sem nada preenchido é "sem endereço", não erro', () => {
    expect(normalizarEndereco(undefined)).toBeNull()
    expect(normalizarEndereco({})).toBeNull()
    expect(normalizarEndereco({ rua: '  ', cidade: '' })).toBeNull()
  })

  it('padroniza: UF em maiúsculas, CEP só com dígitos, cidade com inicial maiúscula', () => {
    expect(normalizarEndereco({
      cep: '45.000-000', rua: ' Rua  das Flores ', numero: '12', bairro: 'Centro',
      cidade: 'VITÓRIA DA CONQUISTA', estado: 'ba',
    })).toEqual({
      cep: '45000000', rua: 'Rua das Flores', numero: '12', bairro: 'Centro',
      cidade: 'Vitória da Conquista', estado: 'BA', complemento: null,
    })
  })

  it('não mexe em cidade digitada com caixa mista', () => {
    expect(normalizarEndereco({ cidade: 'Conquista', estado: 'BA' })!.cidade).toBe('Conquista')
  })

  it('qualquer campo preenchido exige cidade e UF (senão não serve a relatório nenhum)', () => {
    expect(campoDoErro(() => normalizarEndereco({ rua: 'Rua A' }))).toBe('cidade')
    expect(campoDoErro(() => normalizarEndereco({ cidade: 'Salvador' }))).toBe('estado')
    expect(campoDoErro(() => normalizarEndereco({ cidade: 'Salvador', estado: 'XX' }))).toBe('estado')
  })

  it('CEP com o número de dígitos errado é recusado', () => {
    expect(campoDoErro(() => normalizarEndereco({ cep: '1234', cidade: 'Salvador', estado: 'BA' }))).toBe('cep')
  })
})

describe('senha', () => {
  const quem = { email: 'maria.souza@exemplo.com', documento: '529.982.247-25' }

  it('aceita uma senha razoável', () => {
    expect(campoDoErro(() => validarSenha('cachoeira2026', quem))).toBeNull()
  })

  it('recusa curta, longa demais pro bcrypt, e as óbvias', () => {
    expect(campoDoErro(() => validarSenha('abc123', quem))).toBe('senha')
    expect(campoDoErro(() => validarSenha('a1'.repeat(37), quem))).toBe('senha') // 74 bytes
    expect(campoDoErro(() => validarSenha('aaaaaaaaaa', quem))).toBe('senha')
  })

  it('recusa o e-mail e o CPF como senha', () => {
    expect(campoDoErro(() => validarSenha('maria.souza@exemplo.com', quem))).toBe('senha')
    expect(campoDoErro(() => validarSenha('maria.souza', quem))).toBe('senha')
    expect(campoDoErro(() => validarSenha('52998224725', quem))).toBe('senha')
    expect(campoDoErro(() => validarSenha('529.982.247-25', quem))).toBe('senha')
  })

  it('conta bytes, não letras: acento pesa dois', () => {
    // 40 "ã" = 40 letras mas 80 bytes
    expect(campoDoErro(() => validarSenha('ã'.repeat(40), quem))).toBe('senha')
  })
})

describe('prepararCadastro', () => {
  const quem = { email: 'maria@exemplo.com', documento: '52998224725' }

  it('sem nada é um cadastro vazio, sem erro (o balcão e o cliente antigo não têm)', () => {
    expect(prepararCadastro({}, quem, HOJE)).toEqual({
      nascimento: null, instagram: null, endereco: null, senha: null, aceitaNovidades: null,
    })
  })

  it('junta tudo limpo', () => {
    const c = prepararCadastro({
      nascimento: '1990-12-25', instagram: '@Maria', senha: 'cachoeira2026', aceitaNovidades: true,
      endereco: { cidade: 'salvador', estado: 'ba' },
    }, quem, HOJE)
    expect(c).toEqual({
      nascimento: '1990-12-25', instagram: 'maria', senha: 'cachoeira2026', aceitaNovidades: true,
      endereco: { cep: null, rua: null, numero: null, bairro: null, cidade: 'Salvador', estado: 'BA', complemento: null },
    })
  })

  it('consentimento só vale se a pessoa se manifestou: ausente é null, não false', () => {
    expect(prepararCadastro({}, quem, HOJE).aceitaNovidades).toBeNull()
    expect(prepararCadastro({ aceitaNovidades: false }, quem, HOJE).aceitaNovidades).toBe(false)
  })

  it('devolve o campo do primeiro problema, pra a página marcar o lugar certo', () => {
    expect(campoDoErro(() => prepararCadastro({ nascimento: '2999-01-01' }, quem, HOJE))).toBe('nascimento')
    expect(campoDoErro(() => prepararCadastro({ senha: '123' }, quem, HOJE))).toBe('senha')
  })
})

describe('CPF mascarado', () => {
  it('esconde o começo e o fim, mostra o meio', () => {
    expect(cpfMascarado('52998224725')).toBe('***.982.247-**')
    expect(cpfMascarado('529.982.247-25')).toBe('***.982.247-**')
  })
  it('sem CPF, traço', () => {
    expect(cpfMascarado(null)).toBe('—')
    expect(cpfMascarado('123')).toBe('—')
  })
})

describe('nomeProprio', () => {
  it('só mexe quando está tudo numa caixa só', () => {
    expect(nomeProprio('JOSÉ DA SILVA')).toBe('José da Silva')
    expect(nomeProprio('maria de fátima')).toBe('Maria de Fátima')
    expect(nomeProprio('Jean McDonald')).toBe('Jean McDonald')
  })
})

describe('faixa de idade (o corte é do Postgres)', () => {
  /** A faixa de quem completou `anos` anos HOJE, e de quem completa amanhã (um dia mais novo). */
  async function faixaDe(anos: number, diasAMais = 0): Promise<string | null> {
    const r = await q1<{ f: string | null }>(
      `SELECT ${SQL_FAIXA('d')} AS f
         FROM (SELECT (current_date - make_interval(years => $1) + make_interval(days => $2))::date AS d) t`,
      [anos, diasAMais])
    return r!.f
  }

  it('sem data de nascimento não tem faixa (NULL, não "até 17")', async () => {
    const r = await q1<{ f: string | null }>(`SELECT ${SQL_FAIXA('NULL::date')} AS f`)
    expect(r!.f).toBeNull()
  })

  it.each([
    [0, 'ate17'], [17, 'ate17'], [18, '18a24'], [24, '18a24'], [25, '25a34'], [34, '25a34'],
    [35, '35a44'], [44, '35a44'], [45, '45a59'], [59, '45a59'], [60, '60mais'], [95, '60mais'],
  ])('quem fez %i anos hoje cai em %s', async (anos, chave) => {
    expect(await faixaDe(anos)).toBe(chave)
  })

  it('o aniversário conta: faltando um dia pra fazer 18, ainda é "até 17"', async () => {
    expect(await faixaDe(18, 1)).toBe('ate17')
  })

  it('a lista de faixas não deixa buraco nem sobreposição', () => {
    for (let i = 1; i < FAIXAS_ETARIAS.length; i++) {
      expect(FAIXAS_ETARIAS[i].de).toBe(FAIXAS_ETARIAS[i - 1].ate! + 1)
    }
    expect(FAIXAS_ETARIAS[0].de).toBe(0)
    expect(FAIXAS_ETARIAS.at(-1)!.ate).toBeNull()
  })
})
