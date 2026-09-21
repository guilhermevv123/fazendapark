# Diamond Tickets

Plataforma de bilheteria própria, feita pra substituir a Zig — que cobra mensalidade
**mais 5% de cada venda**. Cliente real: Fazenda Park / Conquista Park (parque aquático na
Bahia). O gateway é o **Asaas**.

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

## Interface

Identidade visual da Zig, por pedido do dono. Use **só as classes que existem** em
`app/assets/base.css` — `card`, `rotulo`, `rotulo-kpi`, `numero-kpi`, `campo`, `chip`,
`chip-ativo`, `btn`, `btn-secundario`, `faixa-erro`. Inventar nome de classe é o bug
invisível de cima.

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
