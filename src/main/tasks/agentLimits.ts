/**
 * Limite de agentes vivos. Conta so sessoes que estao vivas de verdade: status
 * diferente de 'exited' no banco E processo vivo no runtime (PtyHost para o
 * Lider, MemberRuntime para membros). Sessao encerrada, ou aberta no banco mas
 * com processo morto, nao ocupa vaga.
 */
import { DomainError, type Session, type SessionId, type TaskId } from '@shared/domain'
import type { AgentLimits } from '@shared/ports'

// Sem limite por padrão (pedido do vings) até existir configuração; os testes passam limites próprios.
export const DEFAULT_AGENT_LIMITS: AgentLimits = {
  maxLiveMembersPerTask: Number.POSITIVE_INFINITY,
  maxLiveAgents: Number.POSITIVE_INFINITY,
}

export interface AgentLiveness {
  /** true se o processo da sessao esta vivo no runtime. */
  isAlive(session: Session): boolean
}

export function liveSessions(openSessions: readonly Session[], liveness: AgentLiveness): Session[] {
  return openSessions.filter((s) => s.status !== 'exited' && liveness.isAlive(s))
}

export interface AgentCapacity {
  liveAgents: number
  liveMembersInTask: number
}

export function measureCapacity(live: readonly Session[], taskId: TaskId): AgentCapacity {
  return {
    liveAgents: live.length,
    liveMembersInTask: live.filter((s) => s.taskId === taskId && s.kind === 'member-acp').length,
  }
}

/**
 * Recusa abrir mais um agente quando o limite estoura ('unavailable').
 * `reuseSessionId`: sessao que vai ser substituida (retomada), nao conta duas vezes.
 */
export function assertAgentCapacity(input: {
  limits: AgentLimits
  kind: 'leader' | 'member'
  taskId: TaskId
  openSessions: readonly Session[]
  liveness: AgentLiveness
  reuseSessionId?: SessionId | undefined
}): AgentCapacity {
  const live = liveSessions(input.openSessions, input.liveness).filter(
    (s) => s.id !== input.reuseSessionId,
  )
  const capacity = measureCapacity(live, input.taskId)
  if (capacity.liveAgents >= input.limits.maxLiveAgents) {
    throw new DomainError(
      'unavailable',
      `limite de agentes vivos no app atingido (${input.limits.maxLiveAgents}); encerre um antes`,
      { limit: input.limits.maxLiveAgents, live: capacity.liveAgents },
    )
  }
  if (input.kind === 'member' && capacity.liveMembersInTask >= input.limits.maxLiveMembersPerTask) {
    throw new DomainError(
      'unavailable',
      `limite de membros vivos nesta tarefa atingido (${input.limits.maxLiveMembersPerTask}); encerre um antes`,
      { limit: input.limits.maxLiveMembersPerTask, live: capacity.liveMembersInTask },
    )
  }
  return capacity
}
