import {
  SUBTASK_STATE_LABELS,
  type Artifact,
  type Session,
  type SessionId,
  type Subtask,
  type SubtaskId,
  type TaskId,
  type Turn,
  type TurnId,
} from '@shared/domain'
import { fitInbox } from '../leader/inbox'
import type {
  LeaderNotice,
  LeaderNoticeStore,
  LeaderRelay,
  TaskService,
  Unsubscribe,
} from '@shared/ports'
import { isPausedByRestart } from '@shared/subtaskRules'

const MAX_SUMMARY_CHARS = 280
const MAX_SEEN_TURNS = 2_000
// Prazo para o gancho confirmar a colagem do wake (igual ao promptAckTimeoutMs do registro);
// passado ele, aviso ainda pendente acorda o Lider de novo.
export const WAKE_RETRY_MS = 15_000

const TURN_ERROR_LABELS: Record<string, string> = {
  process_exited: 'processo morreu',
  silent_timeout: 'sem resposta',
  turn_timeout: 'tempo máximo do turno',
  session_closed: 'sessão fechada',
  spawn_failed: 'não abriu',
  protocol_error: 'erro de protocolo',
  app_restarted: 'o app reiniciou',
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
  /** Relogio do TaskService (endedAt do turno vem dele). Padrao: Date.now. */
  now?: () => number
  /** Rede de seguranca: tenta de novo toda tarefa com aviso pendente (0 desliga). */
  retryIntervalMs?: number
  onError?: (error: unknown) => void
}

/** O minimo do LeaderSessionEvent que o relay usa. */
export interface LeaderActivityEvent {
  type: string
  sessionId: SessionId
  activity?: string
  /** notices-delivered: ids da fila duravel que o gancho entregou. */
  ids?: number[]
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
  notify(taskId: TaskId, text: string, subtaskId?: SubtaskId): void
  /**
   * O Lider acabou de ver estas subtarefas (subtarefas_esperar / subtarefas_ver): descarta os
   * avisos pendentes delas e nao enfileira o de um turno que terminou antes desta hora.
   */
  markSubtasksSeen(taskId: TaskId, subtaskIds: readonly SubtaskId[]): void
}

export const DEFAULT_NOTICE_RETRY_INTERVAL_MS = 30_000

/** Fila em memoria com a mesma forma da duravel. Para testes e para rodar sem SQLite. */
export function createMemoryLeaderNoticeStore(): LeaderNoticeStore {
  let nextId = 1
  const pending: LeaderNotice[] = []
  return {
    enqueueLeaderNotice(taskId, text, subtaskId) {
      const notice = {
        id: nextId++,
        taskId,
        text,
        createdAt: Date.now(),
        subtaskId: subtaskId ?? null,
      }
      pending.push(notice)
      return notice
    },
    listPendingLeaderNotices(taskId) {
      return pending.filter((n) => n.taskId === taskId)
    },
    discardPendingLeaderNoticesForSubtasks(taskId, subtaskIds) {
      for (let i = pending.length - 1; i >= 0; i--) {
        const n = pending[i]
        if (n && n.taskId === taskId && n.subtaskId !== null && subtaskIds.includes(n.subtaskId)) {
          pending.splice(i, 1)
        }
      }
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
  const now = deps.now ?? Date.now
  const seen = new Set<TurnId>()
  // Quando o Lider viu cada subtarefa parada. Cobre a corrida: o aviso de fim de turno entra
  // na fila num microtask depois do commit e o subtarefas_esperar pode devolver antes.
  const seenBySubtask = new Map<SubtaskId, number>()
  const draining = new Map<TaskId, Promise<void>>()
  const rerun = new Set<TaskId>()
  // Avisos que ja acordaram o Lider desta sessao (id -> hora da colagem): sem repetir a cada ocioso.
  const woken = new Map<SessionId, Map<number, number>>()
  // Lideres ja acordados por subtarefa parada pelo reinicio (uma vez por sessao).
  const wokenByRestart = new Set<SessionId>()
  // Lideres com subtarefa parada pelo reinicio e sem wake bem-sucedido (sessao -> tarefa): o sweep tenta de novo.
  const restartCandidates = new Map<SessionId, TaskId>()
  const restartWaking = new Map<SessionId, Promise<void>>()
  let stopped = false

  const remember = (turnId: TurnId): boolean => {
    if (seen.has(turnId)) return false
    seen.add(turnId)
    if (seen.size > MAX_SEEN_TURNS) seen.delete(seen.values().next().value as TurnId)
    return true
  }

  // Aviso criado depois da abertura da sessao acorda o Lider ocioso; o que ja estava na fila
  // (abertura do app, retomada) so anda pelo gancho. Reconfere a fila: o gancho pode ter entregado.
  const wakeIdleLeader = async (taskId: TaskId, leader: Session): Promise<void> => {
    if (!relay.wake) return
    const sent = woken.get(leader.id) ?? new Map<number, number>()
    const pending = notices.listPendingLeaderNotices(taskId)
    const stillPending = new Set(pending.map((n) => n.id))
    for (const id of sent.keys()) if (!stillPending.has(id)) sent.delete(id)
    const at = now()
    // Colagem so quer dizer Enter escrito: se o aviso segue pendente apos o prazo, tenta de novo.
    const fresh = pending.filter((n) => {
      const sentAt = sent.get(n.id)
      return (
        n.createdAt > leader.startedAt && (sentAt === undefined || at - sentAt >= WAKE_RETRY_MS)
      )
    })
    if (fresh.length === 0) return
    if (!(await relay.wake(leader.id))) return
    // A caixa leva so o que cabe; o resto acorda de novo no proximo ocioso.
    for (const n of fitInbox(fresh)) sent.set(n.id, at)
    woken.set(leader.id, sent)
  }

  const drain = (taskId: TaskId): Promise<void> => {
    const running = draining.get(taskId)
    if (running) {
      // Pedido chegou com a rodada quase no fim: roda mais uma ao terminar.
      rerun.add(taskId)
      return running
    }
    const job = (async () => {
      while (!stopped) {
        const pending = notices.listPendingLeaderNotices(taskId)
        if (pending.length === 0) return
        const leader = tasks.getLiveLeaderSession(taskId)
        if (!leader) return
        // Lider Claude: o aviso vai pela caixa do gancho e sai da fila com notices-delivered.
        // So Codex (sem gancho) ou sessao encerrada devolve aviso para colar.
        const toPaste = relay.offer
          ? await relay.offer(
              leader.id,
              pending.map(({ id, text }) => ({ id, text })),
            )
          : pending
        const next = toPaste[0]
        if (!next) {
          await wakeIdleLeader(taskId, leader)
          return
        }
        const result = await relay.deliver(leader.id, next.text)
        if (!result.delivered) return
        notices.markLeaderNoticeDelivered(next.id)
      }
    })()
      .catch(onError)
      .finally(() => {
        draining.delete(taskId)
        if (rerun.delete(taskId)) void drain(taskId)
      })
    draining.set(taskId, job)
    return job
  }

  // O aviso do reinicio entra pelo SessionStart (nao comeca turno): so o wake vira turno.
  // O wake falha enquanto o Lider nao esta pronto; a sessao fica candidata e o sweep repete.
  const wakeByRestart = (sessionId: SessionId, taskId: TaskId): void => {
    if (!relay.wake || stopped || restartWaking.has(sessionId)) return
    const job = (async () => {
      if (
        wokenByRestart.has(sessionId) ||
        tasks.getSession(sessionId).status !== 'running' ||
        !tasks.listSubtasks(taskId).some(isPausedByRestart)
      ) {
        restartCandidates.delete(sessionId)
        return
      }
      restartCandidates.set(sessionId, taskId)
      if (await relay.wake?.(sessionId)) {
        wokenByRestart.add(sessionId)
        restartCandidates.delete(sessionId)
      }
    })()
      .catch(onError)
      .finally(() => restartWaking.delete(sessionId))
    restartWaking.set(sessionId, job)
  }

  const enqueue = (taskId: TaskId, text: string, subtaskId?: SubtaskId): void => {
    notices.enqueueLeaderNotice(taskId, text, subtaskId)
    void drain(taskId)
  }

  const handleTurnEnd = (turn: Turn) => {
    const subtask = tasks.getSubtask(turn.subtaskId)
    // Turno fechado pela recuperacao com a subtarefa parada: o aviso de reinicio ja entrou na
    // fila na mesma transacao (recoverAfterRestart). Um aviso so por subtarefa.
    if (turn.error?.code === 'app_restarted' && isPausedByRestart(subtask)) return
    // O Lider ja viu essa subtarefa depois do fim do turno: o aviso chegaria velho.
    const seenAt = seenBySubtask.get(subtask.id)
    if (seenAt !== undefined && turn.endedAt !== null && seenAt >= turn.endedAt) return
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
    enqueue(subtask.taskId, text, subtask.id)
  }

  const sweep = () => {
    if (stopped) return
    try {
      for (const taskId of notices.listTasksWithPendingLeaderNotices()) void drain(taskId)
      for (const [sessionId, taskId] of restartCandidates) wakeByRestart(sessionId, taskId)
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
    if (event.type === 'session.upserted' && event.session.status !== 'running') {
      woken.delete(event.session.id)
      wokenByRestart.delete(event.session.id)
      restartCandidates.delete(event.session.id)
    }
  })

  const offLeader = deps.leaderEvents?.onEvent((event) => {
    if (stopped) return
    if (event.type === 'notices-delivered') {
      try {
        for (const id of event.ids ?? []) notices.markLeaderNoticeDelivered(id)
      } catch (error) {
        onError(error)
      }
    } else if (event.type !== 'activity' || event.activity !== 'idle') return
    let taskId: TaskId
    try {
      taskId = tasks.getSession(event.sessionId).taskId
    } catch {
      return
    }
    const sessionId = event.sessionId
    void drain(taskId).then(() => wakeByRestart(sessionId, taskId))
  })

  const timer = retryIntervalMs > 0 ? setInterval(sweep, retryIntervalMs) : null
  timer?.unref?.()

  return {
    stop() {
      stopped = true
      restartCandidates.clear()
      unsubscribe()
      offLeader?.()
      if (timer) clearInterval(timer)
    },
    async idle() {
      // Espera microtarefas pendentes e qualquer envio em curso.
      await Promise.resolve()
      while (draining.size > 0 || restartWaking.size > 0) {
        await Promise.all([...draining.values(), ...restartWaking.values()])
      }
    },
    pending(taskId) {
      return notices.listPendingLeaderNotices(taskId).map((n) => n.text)
    },
    notify(taskId, text, subtaskId) {
      if (stopped) return
      // O Lider ja viu a subtarefa depois da ultima transicao: o aviso chegaria velho.
      if (subtaskId !== undefined) {
        const seenAt = seenBySubtask.get(subtaskId)
        try {
          if (seenAt !== undefined && seenAt >= tasks.getSubtask(subtaskId).updatedAt) return
        } catch {
          // subtarefa desconhecida: avisa mesmo assim
        }
      }
      enqueue(taskId, text, subtaskId)
    },
    markSubtasksSeen(taskId, subtaskIds) {
      if (stopped || subtaskIds.length === 0) return
      const at = now()
      for (const id of subtaskIds) {
        seenBySubtask.set(id, at)
        if (seenBySubtask.size > MAX_SEEN_TURNS) {
          seenBySubtask.delete(seenBySubtask.keys().next().value as SubtaskId)
        }
      }
      try {
        notices.discardPendingLeaderNoticesForSubtasks(taskId, subtaskIds)
        // Reoferece o que sobrou: a oferta regrava a caixa do gancho sem o que foi descartado.
        if (notices.listPendingLeaderNotices(taskId).length > 0) void drain(taskId)
      } catch (error) {
        onError(error)
      }
    },
  }
}
