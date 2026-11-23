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
 * subiu (Lancada) e tratada como pronto_lancar: work_started nao mexe; question_opened e
 * leader_concluded seguem a regra acima. esperando_outra nao tem Lider: work_started nao mexe.
 * Em todos: lancado e cancelado nao mudam (W2). A automacao nunca produz pronto_lancar,
 * subiu, esperando_outra, em_espera, lancado nem cancelado (W1); a espera automatica por inatividade nao e sinal daqui:
 * e o TeamCoordinator, com a configuracao ligada, no mesmo caminho do usuario.
 * So work_started, question_opened e leader_concluded tiram de em_espera.
 */
import {
  isArchivedWorkflowStatus,
  TASK_WORKFLOW_STATUS_LABELS,
  type Task,
  type TaskWorkflowStatus,
} from './domain'

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

/** A tarefa B espera a A: A ja subiu (ou foi lancada) e libera a B. */
export function releasesWaitingTasks(status: TaskWorkflowStatus): boolean {
  return status === 'subiu' || status === 'lancado'
}

/** Linha da tela para a tarefa que espera `other` (null = a outra nao existe mais). */
export function describeTaskWait(other: Pick<Task, 'name' | 'workflowStatus'> | null): string {
  if (other === null) return 'A tarefa que esta aguardava foi apagada. Inicie esta tarefa ou cancele.'
  if (other.workflowStatus === 'cancelado') {
    return `A tarefa "${other.name}" foi cancelada. Inicie esta tarefa ou cancele.`
  }
  return `Esperando: ${other.name} (${TASK_WORKFLOW_STATUS_LABELS[other.workflowStatus]})`
}
