# O que a Zig tem, o que já temos, o que falta

Levantamento feito a partir dos **arquivos de idioma da própria Zig**
(`pesquisa/zig-locales/`, 264 KB, 14 arquivos), puxados do painel em
20/09/2026. É o inventário mais honesto que existe do produto deles: cada
tela, cada campo e cada mensagem de erro aparece ali, inclusive as que não dá
pra alcançar sem ter o módulo contratado.

Vale mais que navegar clicando — navegar mostra o que está ligado *naquela
conta*; o idioma mostra o produto inteiro.

---

## Já temos, funcionando e testado

| Zig chama | Nosso caminho |
|---|---|
| Dashboard | `/admin/evento/:id/dashboard` — abas Visão geral e **Público** |
| Configurar ingressos | `/ingressos` |
| Ordenar setores | `/ingressos/ordenar` |
| Passaportes / Grupos | `/ingressos/passaportes` |
| Códigos promocionais | `/ingressos/cupons` |
| Promoters / Divulgadores | `/ingressos/promoters` |
| Cortesias | `/ingressos/cortesias` |
| Pedidos | `/vendas` |
| Participantes | `/vendas/participantes` |
| **Ingressos transferidos** | `/vendas/transferencias` + link público `/transferencia/:token` |
| Relatórios | `/relatorios`, `/relatorios/lotes` |
| Validação e acessos | `/validacao` (leitor) e `/validacao/historico` |
| Transferências (dinheiro) | `/financeiro` |
| Borderô | `/financeiro/bordero` |
| Mapa de Assentos | `/assentos` |
| Configurações do evento | `/configuracoes` |
| Organizações | `/admin/organizacoes` |
| Equipe / Gestão de acessos | `/admin/equipe` |
| Suporte | `/admin/suporte` |

## Falta, em ordem de quanto dói

### 1. PDV / bilheteria física
`posSales`, `posManagement`, `posTerms`. Venda na portaria, no dia, com
dinheiro e maquininha. Um parque que abre o portão às 18h vende uma parte
relevante ali, e hoje esse dinheiro não tem por onde entrar no sistema.

### 2. Extrato detalhado (`detailedExtract`)
O borderô fecha o total; o extrato mostra linha a linha o que compõe. É o
relatório que o contador pede e o que resolve discussão sobre número.

### 3. Relatórios que a Zig separa e nós juntamos
`generalSales`, `dailySales`, `promoterSales`, `posSales`. Temos os números;
falta a forma de cada um — "vendas por dia" é outra pergunta de "vendas por
promoter", e hoje as duas moram na mesma tela.

### 4. Auditoria com tela (`audit`, `auditActivities`, `antfraud`)
A tabela `audit_log` já grava tudo — quem criou, quem cancelou, quem mudou
preço. Não existe tela pra ler. Gravar sem conseguir consultar é quase o
mesmo que não gravar.

### 5. Personalização da página pública (`personalizations`)
Cor, banner, textos da página de venda. Hoje o comprador vê o padrão.

### 6. Integrações e marketing (`integrations`, `marketing`, `mails`)
Pixel, analytics, e-mail transacional. **O e-mail é o mais urgente dos três**:
a transferência de ingresso já gera o link, mas ainda é o operador que manda
— o sistema não envia nada sozinho.

### 7. Cashless / produtos (`products`, `equipments`, `inventory`)
O coração do negócio da Zig: consumação, ficha, maquininha, estoque de bar.
É outro produto inteiro dentro do produto. Para o Fazenda Park pode importar
muito ou nada — depende de como o bar do parque opera hoje.

### 8. Itens menores
`locators` (localizadores), `faqs`, `terms`, `eventCategories`,
`ticketCategories`, `establishments`, `paymentPlans`, `visitsAudience`,
`bankingSends`.

---

## Onde somos diferentes de propósito

- **Quatro colunas de dinheiro** (face → taxa → comprador paga → produção
  recebe) em vez da taxa embutida. Na Zig o produtor descobre a conta no
  borderô; aqui ela aparece na hora de montar o lote.
- **Asaas no lugar do adquirente deles.** É o que tira os 5%.
- **Transferência com histórico**, não edição de titular: dá pra desfazer e
  dá pra provar quem era o dono antes.
- **Público só com o que foi perguntado.** A Zig mostra faixa etária e
  gênero; nosso checkout não pergunta, então a tela diz que não pergunta em
  vez de estimar.

## O que os arquivos de idioma ensinaram que não dava pra ver clicando

- `batchManagerDrawer` — o criador de lote deles escreve em **várias sessões
  de uma vez** ("Criar lote e ingressos em quais sessões?"). É um detalhe de
  modelagem que muda a tabela, não a tela.
- `linkedSessionsDrawer` — um lote pode estar preso a N sessões, e eles
  avisam antes de editar.
- `nominalTransfers.modal` — a regra do cancelamento em uma frase: *"o
  ingresso retorna para o último titular"*. Foi daí que saiu a decisão de
  guardar os três campos do titular anterior, e não só o nome.
- Limites por CPF no lote (`hasDocLimit`), mínimo e máximo por compra, e
  canais de venda por lote — tudo campo de lote, não de evento.
