import {
  SUBTASK_STATE_LABELS,
  type Artifact,
  type SessionId,
  type Subtask,
  type TaskId,
  type Turn,
  type TurnId,
} from '@shared/domain'
import type {
  LeaderNotice,
  LeaderNoticeStore,
  LeaderRelay,
  TaskService,
  Unsubscribe,
} from '@shared/ports'

const MAX_SUMMARY_CHARS = 280
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
  /** Fila duravel (SqliteTaskService). Sem ela, fila em memoria (testes). */
  notices?: LeaderNoticeStore
  /**
   * Eventos do registro de Lideres (LeaderSessionRegistry.onEvent). Lider ocioso volta a
   * tentar a entrega: sem isso, um aviso que esgotou as tentativas do relay so andaria
   * com outro fim de turno.
   */
  leaderEvents?: {
    onEvent(listener: (event: LeaderActivityEvent) => void): Unsubscribe
  }
  /** Rede de seguranca: tenta de novo toda tarefa com aviso pendente (0 desliga). */
  retryIntervalMs?: number
  onError?: (error: unknown) => void
}

/** O minimo do LeaderSessionEvent que o relay usa. */
export interface LeaderActivityEvent {
  type: string
  sessionId: SessionId
  activity?: string
}

export interface TeamTurnRelay {
  stop(): void
  /** Resolve quando nao ha aviso em envio (para testes e para fechar o app). */
  idle(): Promise<void>
  /** Avisos guardados porque o Lider nao estava vivo ou nao ficou ocioso a tempo. */
  pending(taskId: TaskId): readonly string[]
  /**
   * Aviso fora de fim de turno (resposta do usuario, membro que nao abriu ou parou).
   * Grava na fila duravel e tenta entregar; nunca descarta.
   */
  notify(taskId: TaskId, text: string): void
}

export const DEFAULT_NOTICE_RETRY_INTERVAL_MS = 30_000

/** Fila em memoria com a mesma forma da duravel. Para testes e para rodar sem SQLite. */
export function createMemoryLeaderNoticeStore(): LeaderNoticeStore {
  let nextId = 1
  const pending: LeaderNotice[] = []
  return {
    enqueueLeaderNotice(taskId, text) {
      const notice = { id: nextId++, taskId, text, createdAt: Date.now() }
      pending.push(notice)
      return notice
    },
    listPendingLeaderNotices(taskId) {
      return pending.filter((n) => n.taskId === taskId)
    },
    markLeaderNoticeDelivered(id) {
      const index = pending.findIndex((n) => n.id === id)
      if (index >= 0) pending.splice(index, 1)
    },
    listTasksWithPendingLeaderNotices() {
      return [...new Set(pending.map((n) => n.taskId))]
    },
  }
}

/**
 * TeamTurnRelay novo: quando o turno de um membro fecha (turn.upserted com endedAt),
 * manda ao terminal do Lider uma linha com id, estado e resumo. Como o antigo,
 * ignora fim de turno repetido e entrega um aviso por vez. Diferente do antigo, nao
 * descarta: todo aviso (fim de turno ou notify) entra numa fila duravel e so sai dela
 * quando o relay confirma a entrega. A fila volta a andar quando o Lider volta
 * (session.upserted running), quando fica ocioso (leaderEvents), no proximo aviso e,
 * como rede de seguranca, a cada retryIntervalMs.
 *
 * Invariante: aviso gravado na fila so sai com entrega confirmada (ou pelo teto por tarefa).
 */
export function startTeamTurnRelay(deps: TeamTurnRelayDeps): TeamTurnRelay {
  const { tasks, relay } = deps
  const notices = deps.notices ?? createMemoryLeaderNoticeStore()
  const onError = deps.onError ?? (() => undefined)
  const retryIntervalMs = deps.retryIntervalMs ?? DEFAULT_NOTICE_RETRY_INTERVAL_MS
  const seen = new Set<TurnId>()
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
      while (!stopped) {
        const next = notices.listPendingLeaderNotices(taskId)[0]
        if (!next) return
        const leader = tasks.getLiveLeaderSession(taskId)
        if (!leader) return
        const result = await relay.deliver(leader.id, next.text)
        if (!result.delivered) return
        notices.markLeaderNoticeDelivered(next.id)
      }
    })()
      .catch(onError)
      .finally(() => draining.delete(taskId))
    draining.set(taskId, job)
    return job
  }

  const enqueue = (taskId: TaskId, text: string): void => {
    notices.enqueueLeaderNotice(taskId, text)
    void drain(taskId)
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
    enqueue(subtask.taskId, text)
  }

  const sweep = () => {
    if (stopped) return
    try {
      for (const taskId of notices.listTasksWithPendingLeaderNotices()) void drain(taskId)
    } catch (error) {
      onError(error)
    }
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
      event.session.status === 'running'
    ) {
      void drain(event.session.taskId)
    }
  })

  const offLeader = deps.leaderEvents?.onEvent((event) => {
    if (stopped || event.type !== 'activity' || event.activity !== 'idle') return
    let taskId: TaskId
    try {
      taskId = tasks.getSession(event.sessionId).taskId
    } catch {
      return
    }
    void drain(taskId)
  })

  const timer = retryIntervalMs > 0 ? setInterval(sweep, retryIntervalMs) : null
  timer?.unref?.()

  return {
    stop() {
      stopped = true
      unsubscribe()
      offLeader?.()
      if (timer) clearInterval(timer)
    },
    async idle() {
      // Espera microtarefas pendentes e qualquer envio em curso.
      await Promise.resolve()
      while (draining.size > 0) {
        await Promise.all([...draining.values()])
      }
    },
    pending(taskId) {
      return notices.listPendingLeaderNotices(taskId).map((n) => n.text)
    },
    notify(taskId, text) {
      if (stopped) return
      enqueue(taskId, text)
    },
  }
}
