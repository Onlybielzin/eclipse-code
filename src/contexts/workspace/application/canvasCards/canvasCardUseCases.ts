import { randomUUID } from 'node:crypto'
import { createAppError } from '../../../../shared/errors/appError'
import type {
  QuestionCardData,
  TaskDecisionRecord,
  TodosCardData,
} from '../../../../shared/contracts/canvasCards'
import {
  appendQuestionsToCard,
  composeAnswerPrompt,
  describeAnswer,
  ensureQuestionCardData,
  ensureTodosCardData,
  normalizeQuestionCardInput,
  normalizeTodoItems,
  resolveQuestionAnswer,
  type QuestionAnswerInput,
} from '../../domain/canvasCards'
import {
  requireNodeControlState,
  type NodeControlAppStateStore,
} from '../nodeControl/nodeControlState'
import {
  commitWithRetry,
  insertNode,
  locateNode,
  makeCardNode,
  placeCardNextTo,
  replaceNode,
} from './canvasCardState'

/** Append-only log of answered questions, owned by the Worker; not part of the synced canvas. */
export interface TaskDecisionLog {
  append: (record: TaskDecisionRecord) => Promise<void>
  list: (filter: {
    projectId?: string
    spaceId?: string
    limit: number
  }) => Promise<TaskDecisionRecord[]>
}

export interface CanvasCardDeps {
  store: NodeControlAppStateStore
  now: () => Date
  assertActive?: () => void
}

function requireNode(deps: CanvasCardDeps, nodeId: string) {
  return async () => {
    const state = requireNodeControlState(await deps.store.readAppState())
    const located = locateNode(state, nodeId)
    if (!located) {
      throw createAppError('node.not_found', { debugMessage: `Unknown node: ${nodeId}` })
    }
    return located
  }
}

/**
 * An agent asks the user. The asker is the calling agent (from its session grant) or, for the
 * user's own tools, an explicit node. Agents created by another agent ask their lead instead.
 */
export async function createQuestionCard(
  deps: CanvasCardDeps & { callerNodeId: string | null },
  input: { askedByNodeId?: string } & Record<string, unknown>,
): Promise<{
  nodeId: string
  projectId: string
  spaceId: string | null
  merged: boolean
  revision: number
}> {
  const askedByNodeId = deps.callerNodeId ?? input.askedByNodeId ?? null
  if (!askedByNodeId) {
    throw createAppError('common.invalid_input', {
      debugMessage: 'question.create needs the asking agent (askedByNodeId).',
    })
  }
  if (deps.callerNodeId) {
    const lineage = await deps.store.nodeLineage?.readMany([deps.callerNodeId])
    if (lineage?.has(deps.callerNodeId)) {
      throw createAppError('common.forbidden', {
        details: {
          reason: 'team_member',
          operationId: 'question.create',
          message:
            'Only the lead asks the user. End your turn with STATUS: DUVIDA and the lead will answer or ask.',
        },
      })
    }
  }
  const normalized = normalizeQuestionCardInput(input)
  if (!normalized.ok) {
    throw createAppError('common.invalid_input', { debugMessage: normalized.reason })
  }
  await requireNode(deps, askedByNodeId)()
  const createdAt = deps.now().toISOString()
  return commitWithRetry(
    deps.store,
    state => {
      const asker = locateNode(state, askedByNodeId)
      if (!asker) {
        throw createAppError('node.not_found')
      }
      // The user answers one card per agent: questions asked while it waits join that card.
      const waiting = asker.workspace.nodes.find(node => {
        if (node.kind !== 'question') {
          return false
        }
        const data = ensureQuestionCardData(node.task)
        return data.askedByNodeId === askedByNodeId && data.status === 'pending'
      })
      const merged = waiting
        ? appendQuestionsToCard(ensureQuestionCardData(waiting.task), normalized.value.questions)
        : null
      if (waiting && merged) {
        return {
          next: replaceNode(state, asker.workspace, { ...waiting, task: merged }),
          result: {
            nodeId: waiting.id,
            projectId: asker.workspace.id,
            spaceId: asker.spaceId,
            merged: true as boolean,
          },
        }
      }
      const payload: QuestionCardData = {
        ...normalized.value,
        askedByNodeId,
        status: 'pending',
        answers: null,
        answeredAt: null,
        createdAt,
      }
      const node = makeCardNode({
        kind: 'question',
        title: asker.node.title,
        frame: placeCardNextTo(state, asker, 'question'),
        payload,
      })
      return {
        next: insertNode(state, asker.workspace, node, asker.spaceId),
        result: {
          nodeId: node.id,
          projectId: asker.workspace.id,
          spaceId: asker.spaceId,
          merged: false as boolean,
        },
      }
    },
    deps.assertActive,
  )
}

/**
 * The user answers every question of the card at once. Order is the invariant: deliver all answers
 * to the agent in one message first, then mark answered, so a failed delivery leaves the card
 * pending for another try. Callers serialize answers per Worker.
 */
export async function answerQuestionCard(
  deps: CanvasCardDeps & {
    deliver: (agentNodeId: string, text: string) => Promise<void>
    decisions?: TaskDecisionLog
  },
  input: { nodeId: string } & QuestionAnswerInput,
): Promise<{ nodeId: string; answeredAt: string; answerText: string; revision: number }> {
  const located = await requireNode(deps, input.nodeId)()
  if (located.node.kind !== 'question') {
    throw createAppError('common.invalid_input', { debugMessage: 'The node is not a question.' })
  }
  const data = ensureQuestionCardData(located.node.task)
  const resolved = resolveQuestionAnswer(data, input)
  if (!resolved.ok) {
    throw createAppError('common.invalid_input', {
      debugMessage: `question.answer refused: ${resolved.reason}`,
      details: { reason: resolved.reason },
    })
  }
  if (!data.askedByNodeId) {
    throw createAppError('common.invalid_input', {
      debugMessage: 'This question has no agent to receive the answer.',
    })
  }
  const answerPrompt = composeAnswerPrompt(data, resolved.answerTexts)
  await deps.deliver(data.askedByNodeId, answerPrompt)

  const answeredAt = deps.now().toISOString()
  const committed = await commitWithRetry(
    deps.store,
    state => {
      const current = locateNode(state, input.nodeId)
      if (!current) {
        throw createAppError('node.not_found')
      }
      const next: QuestionCardData = {
        ...ensureQuestionCardData(current.node.task),
        status: 'answered',
        answers: resolved.answers,
        answeredAt,
      }
      return {
        next: replaceNode(state, current.workspace, { ...current.node, task: next }),
        result: {
          projectId: current.workspace.id,
          spaceId: current.spaceId,
          askerTitle:
            current.workspace.nodes.find(node => node.id === data.askedByNodeId)?.title ??
            current.node.title,
        },
      }
    },
    deps.assertActive,
  )
  // History is a record, not part of the answer: the agent already has it and the card is marked.
  // One row per question, so each decision can be looked up on its own.
  await Promise.all(
    data.questions.map((item, index) =>
      deps.decisions
        ?.append({
          id: randomUUID(),
          projectId: committed.projectId,
          spaceId: committed.spaceId,
          questionNodeId: input.nodeId,
          askedByNodeId: data.askedByNodeId,
          askedByTitle: committed.askerTitle,
          question: item.question,
          answer: describeAnswer(resolved.answerTexts[index] ?? null),
          answeredAt,
        })
        .catch(() => undefined),
    ),
  )
  return {
    nodeId: input.nodeId,
    answeredAt,
    answerText: answerPrompt,
    revision: committed.revision,
  }
}

/** Mirrors an agent's task list into its single to-do card, creating the card on first items. */
export async function syncTodoCard(
  deps: CanvasCardDeps & { callerNodeId: string | null },
  input: { ownerNodeId?: string; items: unknown },
): Promise<{ nodeId: string | null; created: boolean; revision: number | null }> {
  const ownerNodeId = deps.callerNodeId ?? input.ownerNodeId ?? null
  if (!ownerNodeId) {
    throw createAppError('common.invalid_input', {
      debugMessage: 'todos.sync needs the agent that owns the list (ownerNodeId).',
    })
  }
  const items = normalizeTodoItems(input.items)
  const ownerAtStart = await requireNode(deps, ownerNodeId)()
  const hasCard = ownerAtStart.workspace.nodes.some(
    node => node.kind === 'todos' && ensureTodosCardData(node.task).ownerNodeId === ownerNodeId,
  )
  if (!hasCard && items.length === 0) {
    return { nodeId: null, created: false, revision: null }
  }
  const updatedAt = deps.now().toISOString()
  const outcome = await commitWithRetry(
    deps.store,
    state => {
      const owner = locateNode(state, ownerNodeId)
      if (!owner) {
        throw createAppError('node.not_found')
      }
      const existing = owner.workspace.nodes.find(
        node => node.kind === 'todos' && ensureTodosCardData(node.task).ownerNodeId === ownerNodeId,
      )
      const payload: TodosCardData = { ownerNodeId, items, updatedAt }
      if (existing) {
        return {
          next: replaceNode(state, owner.workspace, { ...existing, task: payload }),
          result: { nodeId: existing.id as string | null, created: false },
        }
      }
      const node = makeCardNode({
        kind: 'todos',
        title: owner.node.title,
        frame: placeCardNextTo(state, owner, 'todos'),
        payload,
      })
      return {
        next: insertNode(state, owner.workspace, node, owner.spaceId),
        result: { nodeId: node.id as string | null, created: true },
      }
    },
    deps.assertActive,
  )
  return outcome
}
