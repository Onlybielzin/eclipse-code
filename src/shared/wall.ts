/** Retrato da Parede: todos os projetos num so objeto. Leitura pura, montado no main. */
import type { SubtaskState, TaskWorkflowStatus } from './domain'

export interface WallMember {
  subtaskId: string
  /** Nome do papel ("Dev", "Revisor"). */
  role: string
  title: string
  state: SubtaskState
}

export interface WallTask {
  id: string
  projectId: string
  projectName: string
  title: string
  workflowStatus: TaskWorkflowStatus
  branch: string | null
  updatedAt: number
  members: WallMember[]
  /** Linhas adicionadas e removidas contra a base (git diff da worktree). */
  linesAdded: number
  linesRemoved: number
  /** Arquivo rastreado mudado mais recentemente, relativo a worktree. */
  lastFile: string | null
  /** Ate 6 ultimas linhas do diff desse arquivo, com marcador + ou -. */
  lastLines: string[]
  openQuestions: number
}

export interface WallSnapshot {
  /** Horario do retrato (ms). */
  at: number
  tasks: WallTask[]
  /** Subtarefas em 'working' agora. */
  workingAgents: number
  /** Limite de agentes vivos; null = sem limite. */
  maxLiveAgents: number | null
  /** Subtarefas prontas desde a meia-noite local. */
  doneToday: number
  /** Tarefas abertas com workflowStatus em_revisao. */
  inReview: number
  openQuestions: number
}
