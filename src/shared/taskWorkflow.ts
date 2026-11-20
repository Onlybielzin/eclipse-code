/**
 * Regras automaticas do status de trabalho da tarefa (TaskWorkflowStatus). Funcao pura:
 * o TaskService (unico escritor) chama dentro da transacao da escrita que gerou o sinal.
 *
 * Sinais e efeito (null = nao muda):
 *   work_started       Lider ou membro comecou a trabalhar: a_fazer | em_revisao | em_espera -> em_andamento.
 *   question_opened    Pergunta ao usuario aberta: qualquer -> pergunta.
 *   questions_cleared  Nao ha mais pergunta aberta: pergunta -> em_andamento.
 *   leader_concluded   Lider chamou tarefa_concluir: qualquer -> em_revisao.
 *
 * Em todos: lancado e cancelado nao mudam (W2). A automacao nunca produz pronto_lancar,
 * em_espera, lancado nem cancelado (W1). So work_started, question_opened e leader_concluded
 * tiram de em_espera.
 */
import { isArchivedWorkflowStatus, type TaskWorkflowStatus } from './domain'

export type TaskWorkflowSignal =
  'work_started' | 'question_opened' | 'questions_cleared' | 'leader_concluded'

export function nextTaskWorkflowStatus(
  current: TaskWorkflowStatus,
  signal: TaskWorkflowSignal,
): TaskWorkflowStatus | null {
  if (isArchivedWorkflowStatus(current)) return null
  let next: TaskWorkflowStatus | null
  switch (signal) {
    case 'work_started':
      next = current === 'a_fazer' || current === 'em_revisao' || current === 'em_espera' ? 'em_andamento' : null
      break
    case 'question_opened':
      next = 'pergunta'
      break
    case 'questions_cleared':
      next = current === 'pergunta' ? 'em_andamento' : null
      break
    case 'leader_concluded':
      next = 'em_revisao'
      break
  }
  return next === current ? null : next
}
