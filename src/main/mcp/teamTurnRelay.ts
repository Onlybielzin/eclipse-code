import {
  SUBTASK_STATE_LABELS,
  type Artifact,
  type Subtask,
  type TaskId,
  type Turn,
  type TurnId,
} from '@shared/domain'
import type { LeaderRelay, TaskService, Unsubscribe } from '@shared/ports'

const MAX_SUMMARY_CHARS = 280
const MAX_PENDING_PER_TASK = 50
const MAX_SEEN_TURNS = 2_000

const TURN_ERROR_LABELS: Record<string, string> = {
  process_exited: 'processo morreu',
  silent_timeout: 'sem resposta',
  turn_timeout: 'tempo máximo do turno',
  session_closed: 'sessão fechada',
  spawn_failed: 'não abriu',
  protocol_error: 'erro de protocolo',
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/**
 * Aviso de uma linha ao Lider. Leva id, estado e resumo; o resto (arquivos, testes,
 * historico) fica no app e o Lider le com subtarefas_ver, sem passar pelo modelo.
 */
export function composeTurnNotice(input: {
  subtask: Subtask
  roleName: string
  turn: Turn
  delivery: Artifact | null
}): string {
  const { subtask, turn, delivery } = input
  const state = SUBTASK_STATE_LABELS[subtask.state]
  const reason =
    turn.error !== null ? ` (${TURN_ERROR_LABELS[turn.error.code] ?? turn.error.code})` : ''
  const summarySource =
    delivery?.delivery.summary ??
    subtask.statusMessage ??
    turn.error?.message ??
    turn.finalText ??
    ''
  const summary = oneLine(summarySource, MAX_SUMMARY_CHARS) || '(sem resumo)'
  const format = delivery?.format === 'unformatted' ? ' [entrega sem formato]' : ''
  return `[eclipse] Subtarefa ${subtask.id} (${input.roleName}: ${oneLine(subtask.title, 80)}) terminou o turno: ${state}${reason}${format}. ${summary} -> detalhes: subtarefas_ver`
}

export interface TeamTurnRelayDeps {
  tasks: TaskService
  relay: LeaderRelay
  onError?: (error: unknown) => void
}

export interface TeamTurnRelay {
  stop(): void
  /** Resolve quando nao ha aviso em envio (para testes e para fechar o app). */
  idle(): Promise<void>
  /** Avisos guardados porque o Lider nao estava vivo ou nao ficou ocioso a tempo. */
  pending(taskId: TaskId): readonly string[]
}

/**
 * TeamTurnRelay novo: quando o turno de um membro fecha (turn.upserted com endedAt),
 * manda ao terminal do Lider uma linha com id, estado e resumo. Como o antigo,
 * ignora fim de turno repetido e entrega um aviso por vez. Diferente do antigo, nao
 * descarta: sem Lider vivo ou ocioso, o aviso fica na fila da tarefa e sai em ordem
 * quando o Lider volta (session.upserted) ou no proximo aviso.
 */
export function startTeamTurnRelay(deps: TeamTurnRelayDeps): TeamTurnRelay {
  const { tasks, relay } = deps
  const onError = deps.onError ?? (() => undefined)
  const seen = new Set<TurnId>()
  const queues = new Map<TaskId, string[]>()
  const draining = new Map<TaskId, Promise<void>>()
  let stopped = false

  const remember = (turnId: TurnId): boolean => {
    if (seen.has(turnId)) return false
    seen.add(turnId)
    if (seen.size > MAX_SEEN_TURNS) seen.delete(seen.values().next().value as TurnId)
    return true
  }

  const drain = (taskId: TaskId): Promise<void> => {
    const running = draining.get(taskId)
    if (running) return running
    const job = (async () => {
      const queue = queues.get(taskId)
      while (!stopped && queue && queue.length > 0) {
        const leader = tasks.getLiveLeaderSession(taskId)
        if (!leader) return
        const text = queue[0] as string

        const result = await relay.deliver(leader.id, text)
        if (!result.delivered) return
        queue.shift()
      }
    })()
      .catch(onError)
      .finally(() => {
        draining.delete(taskId)
        const left = queues.get(taskId)
        if (left && left.length === 0) queues.delete(taskId)
      })
    draining.set(taskId, job)
    return job
  }

  const handleTurnEnd = (turn: Turn) => {
    const subtask = tasks.getSubtask(turn.subtaskId)
    let roleName = subtask.roleId
    try {
      roleName = tasks.getRole(subtask.roleId).name
    } catch {
      // papel apagado: fica o id
    }
    const deliveries = tasks.listTurnDeliveries(turn.id)
    const text = composeTurnNotice({
      subtask,
      roleName,
      turn,
      delivery: deliveries[deliveries.length - 1] ?? null,
    })
    const queue = queues.get(subtask.taskId) ?? []
    queue.push(text)
    if (queue.length > MAX_PENDING_PER_TASK) queue.shift()
    queues.set(subtask.taskId, queue)
    void drain(subtask.taskId)
  }

  const unsubscribe: Unsubscribe = tasks.subscribe((envelope) => {
    if (stopped) return
    const { event } = envelope
    if (event.type === 'turn.upserted' && event.turn.endedAt !== null) {
      if (!remember(event.turn.id)) return
      const turn = event.turn
      // Depois do commit todo: a transicao da subtarefa e a entrega sem formato
      // saem na mesma transacao, mas os eventos chegam um a um.
      queueMicrotask(() => {
        try {
          handleTurnEnd(turn)
        } catch (error) {
          onError(error)
        }
      })
      return
    }
    if (
      event.type === 'session.upserted' &&
      event.session.kind === 'leader-pty' &&
      event.session.status === 'running' &&
      queues.has(event.session.taskId)
    ) {
      void drain(event.session.taskId)
    }
  })

  return {
    stop() {
      stopped = true
      unsubscribe()
    },
    async idle() {
      // Espera microtarefas pendentes e qualquer envio em curso.
      await Promise.resolve()
      while (draining.size > 0) {
        await Promise.all([...draining.values()])
      }
    },
    pending(taskId) {
      return [...(queues.get(taskId) ?? [])]
    },
  }
}
