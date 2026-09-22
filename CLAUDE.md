# Conquista Park — bilheteria

Plataforma de bilheteria própria, feita pra substituir a Zig — que cobra mensalidade
**mais 5% de cada venda**. Cliente real: Fazenda Park / Conquista Park (parque aquático na
Bahia). O gateway é o **Asaas**.

O produto se chama **Conquista Park**; é de **um parque só**, sem multi-loja e sem revenda.
`diamond-tickets` (pasta), `diamond_tickets` (banco) e o `name` do `package.json` são nome
antigo do repositório: ficam como estão. Nada que o cliente lê (tela, e-mail, ingresso) diz Diamond;
sobra só identificador técnico (`User-Agent`, cabeçalho `x-diamond-conferencia`, domínio do
`Message-ID`).

Isto aqui **movimenta dinheiro de verdade e controla a entrada de pessoas num parque**.
Um número errado aqui não é um bug de tela: é dinheiro saindo da conta ou fila parada
no portão.

---

## Como rodar

| coisa | comando |
|---|---|
| servidor de dev | porta **3100** — use a tool `preview_start` com o nome `tickets`, nunca `npm run dev` no Bash |
| testes | `npx vitest run` (raiz do projeto) |
| build de verdade | `npm run build` — **o único que pega template .vue quebrado e template literal aberta** |
| banco | `/opt/homebrew/opt/postgresql@16/bin/psql -d diamond_tickets` |
| migração | arquivo novo em `db/`, numerado; aplicar com `psql -d diamond_tickets -f db/0NN_nome.sql` (o `npm run db:push` aponta pra um script que não existe) |
| curl logado | `/tmp/dt.sh <url-completa> [args do curl]` — entra como `dono@fazendapark.com.br` |

Login: `http://localhost:3100/entrar` — `dono@fazendapark.com.br` (master) e
`portaria@fazendapark.com.br` (portaria), senha `diamond123` nos dois.
Evento semeado: `3cd875a0-e230-448a-892b-d4cc840b1948`.

---

## Idioma

**Código em português.** Nomes de variável, função, arquivo de página, mensagem de erro,
comentário, nome de teste — tudo em PT-BR. As colunas do banco são em inglês (`total_cents`,
`asaas_payment_id`) porque o schema nasceu assim; a fronteira é a borda da consulta: o SQL
fala inglês, o TypeScript que recebe fala português (`liquidoCents`, `recebidoDiretoCents`).

Mensagem de erro é texto que um operador de guichê vai ler às 21h com fila na frente.
Escreva pra ele: o que aconteceu e o que fazer. Nada de `Invalid request` nem de código.

---

## Dinheiro

**Centavos inteiros, sempre.** `bigint` no banco, `number` inteiro no TS, sufixo `Cents` no
nome. Porcentagem em *basis points* (`fee_bps`, 1000 = 10%). **Nunca float.** Nunca
`parseFloat` num valor em reais.

**A conta do líquido mora em `server/utils/liquido.ts` e em lugar nenhum mais.**

```
líquido = total_cents − platform_cents − refunded_cents
```

Não invente uma segunda. Ela já esteve copiada em cinco arquivos como `face − estornado`,
que só acerta quando a taxa foi repassada ao comprador e ninguém usou cupom — exatamente o
caso do seed, por isso nenhum teste ficava vermelho. Três coisas que essa história ensinou:

1. **Não dá pra decidir por `fee_mode_online` / `fee_mode_pos`.** O modo muda com o tempo e
   vale dali pra frente. O mesmo canal de bilheteria tem pedidos dos dois jeitos. O que
   aconteceu está no pedido; a configuração só diz o que vai acontecer no próximo.
2. **`estornado_parcial` CONTA.** O webhook grava esse status num reembolso parcial e o
   valor devolvido já está em `refunded_cents`. Recortar com `status = 'pago'` fazia um
   estorno de R$ 20 apagar um pedido de R$ 850 inteiro. Use `PEDIDO_VIVO()` no `WHERE`, ou
   `FILTER` por soma — **nunca um `WHERE status = 'pago'` sobre consulta que soma dinheiro.**
   Contagem de "quantos pedidos fecharam" pode continuar em `'pago'`: ali a pergunta é outra.
3. **"Quanto é do produtor" ≠ "quanto dá pra transferir".** Venda no balcão em espécie nunca
   passou pela plataforma — está na gaveta dele. A régua do teto de saque é
   `asaas_payment_id IS NOT NULL`, **não o canal e não a forma de pagamento**: o banco tem
   `bilheteria + pix` COM cobrança (QR da plataforma) e SEM (chave do próprio produtor).

Quando uma tela mostra um total que o usuário não consegue sacar, ela **nomeia a diferença**
("na plataforma" / "recebido direto por você"). Saldo escondido vira chamado de "o sistema
comeu minha venda".

---

## Testes

**Teste que fica verde com a trava arrancada é pior que não ter teste** — dá uma garantia
que ele não tem. Depois de escrever um teste de invariante, **arranque a invariante e
confirme que ele fica vermelho.** Se não ficar, o teste não testa nada.

A armadilha que já pegou quatro vezes neste projeto: **uma pré-checagem esconde a trava.**
A rota checa o saldo antes do `FOR UPDATE`, o teste sequencial passa, e a serialização nunca
foi exercida. Duas variantes:

- **Não use `Promise.all` com dois `fetch` pra testar concorrência.** Eles não chegam juntos
  no servidor de dev: o primeiro já gravou quando o segundo lê. Abra **duas conexões do pool**
  e force a ordem na mão (ver `server/api/saque.test.ts`).
- **`client.release()` não desfaz transação aberta.** Falha de asserção no meio deixa o
  `FOR UPDATE` preso na conexão devolvida e o caso SEGUINTE trava até o timeout. `ROLLBACK`
  no `finally`, sempre.

Teste de dinheiro vai **ao banco**, não confere aritmética em memória: o que precisa ficar
travado é a expressão SQL compartilhada, não uma cópia dela em TypeScript.

Fixture: ids fixos próprios, `DELETE` no `afterAll`, **nunca mexer nos dados do evento
semeado**. **Fixture é dona da identidade que cria**: e-mail de teste leva o nome do arquivo
(`dono.venda.pdv@teste.invalido`), nunca um compartilhado — dois arquivos com o mesmo e-mail em
organizações diferentes produzem vermelho **intermitente**, que aparece só quando a outra suíte
morreu antes do `afterAll`.

Se o servidor estiver fora do ar, o teste **pula de verdade** — `ctx.skip()`, nunca
`if (!noAr) return`. O `return` conta como **✓**: já houve rodada com **296 passed em 4s** sem
bater uma vez na rota, com o servidor respondendo 500. Numa corrida de mutação isso dá a
invariante por provada exatamente quando ela foi arrancada.

---

## O que só aparece olhando

A classe de bug que mais passou por aqui não lança exceção, não suja o console e não deixa
teste vermelho. Só aparece na tela.

- **Classe de CSS que não existe não gera nada.** O Tailwind não avisa; o elemento renderiza
  sem cor. Antes de dizer que uma tela ficou pronta, **meça a cor computada** no navegador
  (`getComputedStyle`), não confie em ter escrito a classe.
- **`npm run build` pega o que o vitest não pega**: template `.vue` quebrado, e crase dentro
  de comentário SQL fechando a template literal. **Rode o build antes de dizer que terminou.**
- **`toISOString()` converte pra UTC antes de cortar.** Às 21h de Brasília, "hoje" vira
  amanhã. Formate a data em horário local.
- **`toLocaleString` separa o `R$` com espaço fino (U+00A0)**, não com espaço normal.
  Comparar sem normalizar falha com as duas strings idênticas na tela.
- **`JOIN` come linha sem par em silêncio.** Venda de balcão sem terminal sumiu de um painel
  e ficou no outro; os dois estavam "certos". Use `LEFT JOIN` e marque a linha órfã.
- Nunca `<p>` com bloco dentro: o navegador fecha o `<p>` sozinho e o layout quebra.
- **`startsWith` em status casa o vizinho.** `status.startsWith('estornado')` pega
  `estornado` *e* `estornado_parcial`, e o guichê passou a responder "esta venda já foi
  cancelada" pra um pedido com R$ 915,00 ainda na gaveta. Compare o status **inteiro**.
- **Mostrar mais linha acorda botão que dormia.** Consertar um `WHERE status = 'pago'` de
  lista não é só mostrar a linha: é liberar todas as ações daquela linha, que nunca foram
  exercidas naquele estado. Depois de alargar uma lista, clique o que ela agora oferece.

**Recusa não é senha errada.** O freio de força bruta conta tentativa **falha**; uma recusa em
que a senha estava CERTA (e-mail em duas organizações, por exemplo) não entra nele. Contando,
a pessoa leva 429 por cima de um problema que nenhuma tentativa dela resolve, e o sinal de quem
está de fato chutando senha fica embaçado.

---

## Cadastro do cliente e a base de clientes

O formulário do site (`pagamento.vue`) cria o cadastro que alimenta follow-up e remarketing. Cinco
regras que não se quebram sem pensar:

- **`server/utils/cadastro.ts` é a única porta de validação** (nascimento, Instagram, endereço,
  senha). O checkout aceita tudo como opcional — a PÁGINA é quem exige. As faixas de idade moram
  numa lista só (`FAIXAS_ETARIAS`), e o SQL dos relatórios é gerado dela.
- **A senha nunca sai do `cadastro` reactive da página.** O `form` inteiro vai pro `sessionStorage`;
  a senha jamais. Ela é gravada como bcrypt e **não existe login de cliente ainda**: no dia em que
  existir, o e-mail tem que ser confirmado por link ANTES de a senha valer (o formulário não prova
  que o e-mail é de quem digitou — por isso o upsert nunca troca uma senha já gravada).
- **`marketing_opt_in` é consentimento (LGPD).** Só muda quando a pessoa se manifesta; a página manda
  `true` ou omite, nunca `false` por silêncio. O carimbo só anda quando o valor muda.
- **`clientes` é área só do master** (a base inteira, com CPF): a lista mostra CPF mascarado, a ficha
  mostra inteiro, a exportação NÃO leva CPF nem rua e **grava na Auditoria** quem exportou e com
  que filtro. Os filtros da lista e da exportação vêm de `server/utils/clientes-filtro.ts`.
- **O relatório da organização (`/admin/relatorios`) é a MESMA conta do relatório do evento**
  (`PEDIDO_VIVO`, `SQL_LIQUIDO`), somada — filtrado por um evento ele é idêntico ao dele. Venda de
  balcão sem cliente conta no dinheiro; nunca entra um `JOIN customers` no caminho do dinheiro.

`audit_log` é append-only por gatilho: teste que precisa apagar linha dele faz
`SET LOCAL auditoria.expurgo = 'liberado'` na mesma transação (ver `expurgar()` em
`server/api/admin/clientes.test.ts`). E fixture com e-mail de login FIXO precisa limpar os restos de
uma rodada que caiu no `beforeAll`: o mesmo e-mail em duas organizações faz o login recusar, e a
suíte inteira devolve 401 longe da causa.

---

## Interface

A identidade é a do sistema do parque (repositório `sistemapark`), com a logo do Conquista Park —
aplicada em tudo em 21/09/2026, por ordem do dono. A da Zig (Lato/Roboto, azul `#1C70E9`) saiu.

- **Tokens.** `tailwind.config.js` tem dois níveis de nome. As escalas da marca — `pool` (azul
  piscina, a ação), `grape` (roxo da logo), `sun` (amarelo), `citrus`, `ink` (neutros), `success`,
  `warning`, `danger`, `canvas` — são as do sistemapark, hex por hex. Os nomes da casa (`acao`,
  `tinta`, `linha`, `fundo`, `ok`, `alerta`, `erro`, `menu`) seguem nas telas e apontam pra um tom
  da escala; o comentário de cada um no config diz qual. Tela nova: nome da casa pro que ele cobre,
  escala da marca pro resto. Cor em SVG (`fill`, `stroke`) não gera classe: use o hex da escala e
  escreva de qual tom é.
- **Tipografia.** Geist e Geist Mono, servidas por nós (`@fontsource-variable`, ligadas em
  `nuxt.config.ts`), não pelo Google: saem de `/_nuxt/`, que o service worker da portaria guarda, e o
  leitor de entrada mantém a fonte sem rede. Peso máximo de texto: `font-semibold`. `text-base` = 15px.
- **Logo.** `<LogoMarca />` (arquivos em `public/brand/`, cópia byte a byte do sistemapark);
  `clara` é a versão branca pra fundo escuro. Não tem altura padrão: quem usa escreve `h-*`.
  `<CabecalhoPublico />` é a faixa das telas de quem COMPRA; `<OndasMarca />` é o desenho de fundo.
- **Classes que existem** em `app/assets/base.css` — use **só** elas, inventar nome é o bug
  invisível de cima: `card`, `titulo`, `titulo-bloco`, `apoio-bloco`, `rotulo`, `rotulo-kpi`,
  `numero-kpi`, `campo`, `chip`, `chip-ativo`, `btn`, `btn-primario`, `btn-secundario`, `btn-erro`,
  `btn-cta`, `faixa-erro`, `faixa-aviso`, `selo`, `selo-ok`, `selo-alerta`, `selo-erro`,
  `selo-neutro`. `btn-cta` é o amarelo de COMPRAR: só nas telas de quem compra, nunca no painel.
- **Cantos.** Botão e campo `rounded-xl`, cartão `rounded-2xl`, círculo só em avatar e passo.
- **Trava de teste.** `app/composables/telas.test.ts` lê o `tailwind.config.js` e o `base.css` pra
  pegar classe sem definição (cor que não existe, prefixo de casa que ninguém escreveu). O parser
  espera cada família de cor numa linha `nome: { tom: '#hex', ... }`, sem chave aninhada.
- **Config velha no dev.** Mexeu no `tailwind.config.js`? Reinicie o servidor de dev por inteiro:
  o processo antigo segue com a config em memória e responde 500 ("a classe não existe") até você parar.

Filtro de tela mora na **URL**, não em `ref` solto: o operador precisa mandar o link do que
está vendo.

CSV sai com `;`, BOM `﻿` e quebra `\r\n` — as três coisas que fazem o Excel brasileiro
abrir o arquivo certo. Já existe pronto em `app/composables/baixarCsv.ts`.

---

## Git

**Commit local sempre, `git push` NUNCA** sem o dono liberar. Mensagem em português,
explicando *por que* — o defeito que o commit fecha e a prova de que fechou.

---

**Uma suíte por vez.** Dois `npx vitest run` ao mesmo tempo disputam o mesmo Postgres e o mesmo
servidor de dev: 21 arquivos ainda usam uuid fixo de fixture, então o segundo processo colhe
"já existe um ponto de venda com esse nome" e asserções de contagem que o vizinho mexeu. Isso
produz vermelho que **não é defeito** — e, pior, ensina a ignorar vermelho. Antes de dar veredito
sobre a suíte, pare a frota e rode sozinho.

Para saber se a suíte está mentindo, rode contra uma porta morta:
`BASE_TESTE=http://localhost:9999 npx vitest run`. O que depende do servidor tem que aparecer como
**skipped**; o que aparecer como *passed* ali ou é teste de unidade/SQL direto, ou é tique oco.

---

## Antes de dizer que terminou

1. `npx vitest run` — suíte **inteira**, não só o arquivo novo
2. mutação: arranque a invariante e confirme o vermelho
3. `npm run build`
4. abra a tela e **meça** — cor computada, número batendo com a outra rota que mostra o mesmo
5. diga o que ficou de fora
