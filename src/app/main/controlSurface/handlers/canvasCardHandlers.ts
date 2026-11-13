import { registerOperation } from '../registerOperation'
import {
  questionAnswerOperation,
  questionCreateOperation,
  questionHistoryOperation,
  todosSyncOperation,
} from '../../../../shared/contracts/controlSurface/operations/domains/cards'
import type { ControlSurface } from '../controlSurface'
import type { ControlSurfaceContext } from '../types'
import type { PersistenceStore } from '../../../../platform/persistence/sqlite/PersistenceStore'
import { createAppError } from '../../../../shared/errors/appError'
import {
  answerQuestionCard,
  createQuestionCard,
  syncTodoCard,
} from '../../../../contexts/workspace/application/canvasCards/canvasCardUseCases'
import { toNodeControlStateStore } from './nodeControlHandlers'

function queued<T>(queueRef: { current: Promise<void> }, task: () => Promise<T>): Promise<T> {
  const next = queueRef.current.then(task, task)
  queueRef.current = next.then(
    () => undefined,
    () => undefined,
  )
  return next
}

function callerNodeId(ctx: ControlSurfaceContext): string | null {
  return ctx.requestAuth?.kind === 'session-grant' ? ctx.requestAuth.grant.nodeId : null
}

/** Question and to-do cards. One queue: an answer is delivered and recorded at most once. */
export function registerCanvasCardHandlers(
  controlSurface: ControlSurface,
  deps: { getPersistenceStore: () => Promise<PersistenceStore> },
): void {
  const queue = { current: Promise.resolve() }
  const base = async (ctx: ControlSurfaceContext) => {
    const persistence = await deps.getPersistenceStore()
    return {
      persistence,
      store: toNodeControlStateStore(persistence),
      now: () => ctx.now(),
      assertActive: ctx.assertActive,
    }
  }

  registerOperation(controlSurface, questionCreateOperation, {
    defaultErrorCode: 'common.unexpected',
    handle: (ctx, input) =>
      queued(queue, async () =>
        createQuestionCard({ ...(await base(ctx)), callerNodeId: callerNodeId(ctx) }, input),
      ),
  })

  registerOperation(controlSurface, questionAnswerOperation, {
    defaultErrorCode: 'common.unexpected',
    handle: (ctx, input) =>
      queued(queue, async () => {
        const resolved = await base(ctx)
        return answerQuestionCard(
          {
            ...resolved,
            decisions: resolved.persistence.taskDecisions,
            deliver: async (agentNodeId, text) => {
              const result = await controlSurface.invoke(ctx, {
                kind: 'command',
                id: 'agent.prompt',
                payload: { nodeId: agentNodeId, text, timeoutMs: 30_000 },
              })
              if (!result.ok) {
                throw createAppError(result.error)
              }
            },
          },
          input,
        )
      }),
  })

  registerOperation(controlSurface, questionHistoryOperation, {
    defaultErrorCode: 'persistence.unavailable',
    handle: async (_ctx, input) => {
      const log = (await deps.getPersistenceStore()).taskDecisions
      if (!log) {
        throw createAppError('persistence.unavailable')
      }
      return {
        decisions: await log.list({
          projectId: input.projectId,
          spaceId: input.spaceId,
          limit: input.limit ?? 100,
        }),
      }
    },
  })

  registerOperation(controlSurface, todosSyncOperation, {
    defaultErrorCode: 'common.unexpected',
    handle: (ctx, input) =>
      queued(queue, async () =>
        syncTodoCard({ ...(await base(ctx)), callerNodeId: callerNodeId(ctx) }, input),
      ),
  })
}
