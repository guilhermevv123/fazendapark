/**
 * 00.filas.ts — as filas de fundo sobem AQUI, no boot do processo.
 *
 * ## O defeito que este arquivo fecha
 *
 * Os dois trabalhadores de fundo do sistema — o que entrega o ingresso
 * (`utils/envio.ts`) e o que devolve o dinheiro (`utils/cancelamento.ts`) —
 * subiam por efeito colateral de `import`: uma chamada solta no fim de cada
 * módulo, que rodava quando alguém importasse o arquivo.
 *
 * Em `npm run dev` isso funciona, e é por isso que ninguém viu. No
 * `npm run build` o Nitro fatia o servidor por rota e só carrega o pedaço
 * quando a rota é chamada. Medido no build anterior:
 *
 *   .output/server/chunks/nitro/nitro.mjs
 *     { route: '/api/admin/evento/:id/reenviar', lazy: true }
 *   .output/server/chunks/routes/api/admin/evento/_id/reenviar.post.mjs:597
 *     garantirWorker();
 *
 * O `garantirWorker()` existia SÓ dentro do pedaço daquela rota. Ou seja: em
 * produção o trabalhador da fila de e-mail só nascia se alguém abrisse a tela
 * de reenvio — e ninguém abre, porque a tela de reenvio é pra quando o
 * e-mail não chegou. O comprador pagava e não recebia nada, que era
 * exatamente o defeito que a fila existia pra fechar; ele só tinha mudado de
 * lugar. O mesmo valia pro estorno, cujo pedaço só é carregado por
 * `/evento/:id/cancelar` e `/evento/:id/remarcar`.
 *
 * Provado no build, não em dev: servidor de produção no ar por 67 s com uma
 * linha madura na fila (quatro varreduras deviam ter acontecido),
 * `attempts = 0`, nenhum .eml em disco, stdout mudo.
 *
 * ## Por que plugin
 *
 * Plugin de servidor do Nitro roda na criação da aplicação, no boot do
 * processo, sem depender de requisição nenhuma — é o único lugar que dá a
 * garantia de que a fila anda num servidor que ninguém abriu ainda. O `00.`
 * no nome é a ordem: a fila é a primeira coisa que precisa estar de pé.
 *
 * ## Duas decisões
 *
 * 1. **Subir não é o bastante; tem que ficar VISÍVEL.** As duas filas
 *    carimbam o boot em `worker_heartbeat_instances` (migração 026, uma linha
 *    POR PROCESSO) e a de e-mail carimba cada varredura. Sem isso, "a fila não
 *    anda" continua sendo uma descoberta do cliente pelo telefone:
 *    `GET /api/admin/filas` responde agora, com o quanto está parado e há
 *    quanto tempo cada instância não varre, e a tela `/admin/filas` mostra.
 *
 *    A chave era só `worker` até a 025, e aí ESTE arquivo era quem produzia o
 *    defeito: com duas instâncias no ar, os dois processos anunciavam na mesma
 *    linha e o último apagava o rastro do primeiro. Medido no banco: maquinaA
 *    morta há 10 min, maquinaB batendo, uma linha só, `bateu_ha = 0` — a tela
 *    dizendo "Andando" com metade da frota parada.
 *
 * 2. **Erro aqui não derruba o servidor.** O boot da fila é importante, mas
 *    não é mais importante que a bilheteria continuar vendendo. Falhou o
 *    carimbo, fica o log — e a tela de saúde mostra a fila sem sinal, que é
 *    a verdade.
 */
import {
  FILA_DE_ENVIO, FILA_DE_ESTORNO, INTERVALO_MS, anunciarWorker, encerrarPonto,
  garantirWorker, pararWorker,
} from '../utils/envio'
import {
  INTERVALO_MS as INTERVALO_ESTORNO_MS, garantirWorkerDeEstorno,
} from '../utils/cancelamento'

export default defineNitroPlugin((nitro) => {
  garantirWorker()
  garantirWorkerDeEstorno()

  // O que o carimbo grava NÃO é o retorno das duas chamadas acima.
  //
  // Elas são idempotentes e devolvem `false` em DOIS casos opostos: a fila
  // está desligada por ambiente, ou já havia um laço rodando — e este segundo
  // caso é o normal do estorno, cujo módulo ainda liga o laço dele sozinho ao
  // ser importado. Gravar o retorno marcaria a fila de estorno como
  // "desligada" justamente quando ela está de pé, e a tela de saúde passaria
  // a mentir na direção mais cara: alarme falso todo dia até ninguém mais
  // olhar. Depois de chamar, existe laço se, e só se, o ambiente não desligou.
  const envioLigado = process.env.DT_ENVIO_WORKER !== 'off'
  const estornoLigado = process.env.DT_ESTORNO_WORKER !== 'off'

  console.log(`[filas] envio=${envioLigado ? 'ligado' : 'desligado'}`
    + ` estorno=${estornoLigado ? 'ligado' : 'desligado'}`)

  // Sem `await`: o boot do servidor não espera o banco. Se o Postgres estiver
  // subindo junto, o carimbo chega alguns segundos depois e ninguém fica sem
  // bilheteria por causa disso.
  //
  // O último parâmetro é o que separa as duas: a fila de e-mail carimba cada
  // varredura, a de estorno NÃO — o laço dela mora em `utils/cancelamento.ts`,
  // que não é arquivo desta trilha. Sem essa distinção a tela acusaria a fila
  // de estorno de silêncio 45 s depois de todo boot, com ela trabalhando, e
  // alarme falso diário treina o operador a ignorar a tela inteira.
  void anunciarWorker(FILA_DE_ENVIO, envioLigado, INTERVALO_MS, true)
  void anunciarWorker(FILA_DE_ESTORNO, estornoLigado, INTERVALO_ESTORNO_MS, false)

  // Saída limpa tira ESTE processo da frota; morte, não.
  //
  // Com uma linha por processo (026), a linha de quem sai fica calada pra
  // sempre — e "desligaram esta máquina" passaria a ser idêntico a "esta
  // máquina caiu". São as duas coisas que a tela de saúde existe pra separar:
  // a primeira ninguém precisa resolver, a segunda alguém precisa resolver
  // agora. O gancho `close` do Nitro roda no SIGTERM do deploy e do
  // `docker stop`; `kill -9`, OOM e queda de energia NÃO passam por aqui, que
  // é justamente o que faz a linha ficar acusando quando tem que acusar.
  nitro.hooks.hook('close', async () => {
    // Primeiro PARA de varrer, depois bate a saída. Na outra ordem o laço
    // dispara mais uma varredura depois da linha apagada e o carimbo dela
    // recria o registro de um processo que está morrendo — o fantasma que
    // `SAIRAM` (em `utils/envio.ts`) segura por dentro. Aqui é o cinto: sem
    // varredura nova não há batida nova, e o que já estava em voo o `SAIRAM`
    // cala.
    pararWorker()
    await encerrarPonto(FILA_DE_ENVIO)
    await encerrarPonto(FILA_DE_ESTORNO)
  })
})
