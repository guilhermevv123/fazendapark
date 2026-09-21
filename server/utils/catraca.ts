/**
 * catraca.ts — a trava da porta, num lugar só.
 *
 * Este arquivo existe por causa de um teste que mentia. A suíte tinha um
 * "dois leitores no mesmo instante" que ficava VERDE mesmo com a condição da
 * trava arrancada: os dois pedidos eram atendidos em fila pelo servidor, o
 * segundo via o ingresso já `usado` na checagem prévia e devolvia "já entrou"
 * sem nunca chegar no UPDATE. O teste passava pelo caminho fácil e dava a
 * impressão de estar provando a parte difícil.
 *
 * Com a instrução aqui, o teste roda **a mesma linha** que a porta roda, em
 * duas conexões, forçando a ordem à mão. Copiar o SQL pro teste teria o mesmo
 * defeito de sempre: alguém muda a rota e o teste continua provando a versão
 * antiga.
 *
 * O `AND status = 'valido'` é a trava inteira. Sem ele, dois leitores que
 * leram o ingresso antes de qualquer um gravar marcam entrada os dois e o
 * mesmo QR passa duas vezes — medido: 20 leitores simultâneos, 10 entraram.
 */
export const SQL_MARCA_ENTRADA = `
  UPDATE tickets
     SET status = 'usado', checked_in_at = now(), checked_in_by = $2
   WHERE id = $1 AND status = 'valido'
   RETURNING id`
