/**
 * POST /api/comandas/config — liga/desliga as comandas e muda as regras. Só gerente.
 * Ligar (`ativo: true`) só o master: é a chave que abre a comanda pra equipe inteira.
 */
import { configDaComanda, exigirNivel, reaisTexto, recusa, registrar } from '../../utils/comandas'
import { q } from '../../utils/db'

export default defineEventHandler(async (event) => {
  const c = exigirNivel(event, 'gerente')
  const b = (await readBody<Record<string, any>>(event)) ?? {}
  const antes = await configDaComanda(c.orgId)
  const novo = { ...antes }
  if (typeof b.ativo === 'boolean') {
    if (!c.master) recusa('Só o dono liga ou desliga as comandas.', 'so_master')
    novo.ativo = b.ativo
  }
  const centavos = (v: unknown, nome: string) => {
    const n = Math.trunc(Number(v))
    if (!Number.isInteger(n) || n < 0 || n > 100_000_00) recusa(`${nome} inválido.`, nome)
    return n
  }
  if (b.limitePadraoCents !== undefined) novo.limitePadraoCents = centavos(b.limitePadraoCents, 'Limite')
  if (b.avisoContaAltaCents !== undefined) novo.avisoContaAltaCents = centavos(b.avisoContaAltaCents, 'Aviso de conta alta')
  if (typeof b.atendenteFechaConta === 'boolean') novo.atendenteFechaConta = b.atendenteFechaConta
  if (typeof b.exigeCodigoWhatsapp === 'boolean') novo.exigeCodigoWhatsapp = b.exigeCodigoWhatsapp
  if (b.minutosParaDesfazer !== undefined) {
    const m = Math.trunc(Number(b.minutosParaDesfazer))
    if (!Number.isInteger(m) || m < 0 || m > 60) recusa('Minutos para desfazer: de 0 a 60.', 'minutos')
    novo.minutosParaDesfazer = m
  }
  if (b.horaFechamento !== undefined) {
    if (typeof b.horaFechamento !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(b.horaFechamento)) recusa('Horário de fechamento inválido (use HH:MM).', 'hora_fechamento')
    novo.horaFechamento = b.horaFechamento
  }
  await q(
    `INSERT INTO comanda_config (org_id, ativo, limite_padrao_cents, atendente_fecha_conta, minutos_para_desfazer,
                                 aviso_conta_alta_cents, exige_codigo_whatsapp, hora_fechamento, atualizado_em, atualizado_por)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$9, now(), $8)
     ON CONFLICT (org_id) DO UPDATE SET ativo = EXCLUDED.ativo, limite_padrao_cents = EXCLUDED.limite_padrao_cents,
       atendente_fecha_conta = EXCLUDED.atendente_fecha_conta, minutos_para_desfazer = EXCLUDED.minutos_para_desfazer,
       aviso_conta_alta_cents = EXCLUDED.aviso_conta_alta_cents, exige_codigo_whatsapp = EXCLUDED.exige_codigo_whatsapp,
       hora_fechamento = EXCLUDED.hora_fechamento, atualizado_em = now(), atualizado_por = EXCLUDED.atualizado_por`,
    [c.orgId, novo.ativo, novo.limitePadraoCents, novo.atendenteFechaConta, novo.minutosParaDesfazer,
      novo.avisoContaAltaCents, novo.exigeCodigoWhatsapp, c.usuarioId, novo.horaFechamento])
  const mudou: string[] = []
  if (antes.ativo !== novo.ativo) mudou.push(novo.ativo ? 'LIGOU as comandas' : 'DESLIGOU as comandas')
  if (antes.limitePadraoCents !== novo.limitePadraoCents) mudou.push(`limite padrão ${reaisTexto(antes.limitePadraoCents)} → ${reaisTexto(novo.limitePadraoCents)}`)
  if (antes.atendenteFechaConta !== novo.atendenteFechaConta) mudou.push(novo.atendenteFechaConta ? 'atendente pode fechar conta' : 'só o caixa fecha conta')
  if (antes.minutosParaDesfazer !== novo.minutosParaDesfazer) mudou.push(`prazo para desfazer ${novo.minutosParaDesfazer} min`)
  if (antes.avisoContaAltaCents !== novo.avisoContaAltaCents) mudou.push(`aviso de conta alta ${reaisTexto(novo.avisoContaAltaCents)}`)
  if (antes.exigeCodigoWhatsapp !== novo.exigeCodigoWhatsapp) mudou.push(novo.exigeCodigoWhatsapp ? 'exige código no WhatsApp' : 'NÃO exige código no WhatsApp')
  if (antes.horaFechamento !== novo.horaFechamento) mudou.push(`parque fecha às ${novo.horaFechamento}`)
  if (mudou.length) await registrar(null, c, { acao: 'config', descricao: `Configuração: ${mudou.join('; ')}` })
  return { config: novo }
})
