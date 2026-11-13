import { describe, expect, it } from 'vitest'
import { createControlSurface } from '../../../src/app/main/controlSurface/controlSurface'
import type { ControlSurfaceContext } from '../../../src/app/main/controlSurface/types'
import { registerCanvasCardHandlers } from '../../../src/app/main/controlSurface/handlers/canvasCardHandlers'
import {
  SESSION_GRANT_POLICY,
  type GrantCheckDeps,
} from '../../../src/app/main/controlSurface/http/sessionGrantPolicy'
import { sessionGrantAccess } from '../../../src/app/main/controlSurface/http/sessionGrantAuthorization'
import type { PersistenceStore } from '../../../src/platform/persistence/sqlite/PersistenceStore'
import type { TaskDecisionRecord } from '../../../src/shared/contracts/canvasCards'

const now = new Date('2026-11-11T14:32:00.000Z')
const userCtx: ControlSurfaceContext = { now: () => now }
const agentCtx = (nodeId: string) =>
  ({
    now: () => now,
    requestAuth: { kind: 'session-grant', grant: { nodeId } },
  }) as unknown as ControlSurfaceContext

function agentNode(id: string, title: string, x: number) {
  return {
    id,
    sessionId: `session-${id}`,
    title,
    position: { x, y: 100 },
    width: 400,
    height: 520,
    kind: 'agent',
    labelColorOverride: null,
    status: 'running',
    startedAt: null,
    endedAt: null,
    exitCode: null,
    lastError: null,
    agent: null,
    task: null,
    scrollback: null,
  }
}

function setup(options: { members?: string[]; deliveryFails?: boolean } = {}) {
  let state = {
    formatVersion: 1,
    activeWorkspaceId: 'ws',
    workspaces: [
      {
        id: 'ws',
        name: 'ws',
        path: '/repo',
        worktreesRoot: '',
        viewport: { x: 0, y: 0, zoom: 1 },
        isMinimapVisible: true,
        spaces: [
          {
            id: 'task',
            name: 'feat-login',
            directoryPath: '/repo',
            labelColor: null,
            nodeIds: ['lead', 'dev'],
            rect: { x: 0, y: 0, width: 1400, height: 800 },
          },
        ],
        activeSpaceId: null,
        nodes: [agentNode('lead', 'Líder', 100), agentNode('dev', 'Dev 1', 600)] as unknown[],
        spaceArchiveRecords: [],
      },
    ],
    settings: {},
  }
  let revision = 0
  let writes = 0
  const prompts: Array<{ nodeId: string; text: string }> = []
  const decisions: TaskDecisionRecord[] = []
  const store = {
    readAppState: async () => state,
    readAppStateRevision: async () => revision,
    writeAppState: async (next: typeof state) => {
      state = next
      revision += 1
      writes += 1
      return { ok: true, level: 'full', bytes: 1, revision }
    },
    nodeLineage: {
      readAll: async () => new Map(),
      readMany: async (ids: readonly string[]) =>
        new Map(
          ids
            .filter(id => options.members?.includes(id))
            .map(id => [
              id,
              { nodeId: id, spawnedBy: 'lead', rootNodeId: 'lead', lineageDepth: 2 },
            ]),
        ),
    },
    taskDecisions: {
      append: async (record: TaskDecisionRecord) => {
        decisions.push(record)
      },
      list: async () => [...decisions].reverse(),
    },
  } as unknown as PersistenceStore
  const controlSurface = createControlSurface()
  controlSurface.register('agent.prompt', {
    kind: 'command',
    validate: payload => payload as { nodeId: string; text: string },
    defaultErrorCode: 'common.unexpected',
    handle: async (_ctx, payload: { nodeId: string; text: string }) => {
      if (options.deliveryFails) {
        throw new Error('agent is gone')
      }
      prompts.push({ nodeId: payload.nodeId, text: payload.text })
      return { delivered: true }
    },
  })
  registerCanvasCardHandlers(controlSurface, { getPersistenceStore: async () => store })
  const call = (ctx: ControlSurfaceContext, id: string, payload: unknown) =>
    controlSurface.invoke(ctx, {
      kind: id === 'question.history' ? 'query' : 'command',
      id,
      payload,
    })
  type CardNode = {
    id: string
    kind: string
    title: string
    position: { x: number; y: number }
    task: Record<string, unknown>
  }
  const nodes = () => state.workspaces[0]!.nodes as CardNode[]
  return {
    call,
    nodes,
    prompts,
    decisions,
    writes: () => writes,
    space: () => state.workspaces[0]!.spaces[0]!,
  }
}

const QUESTION = {
  question: 'Onde fica o botão do Google?',
  context: 'A tela tem e-mail e senha.',
  options: [
    { label: 'Acima do e-mail', detail: '1 arquivo', recommended: true },
    { label: 'Abaixo do Entrar', detail: 'mesmo custo' },
  ],
}

describe('question.create', () => {
  it('puts a pending card in the asking agent Space, right of its window', async () => {
    const t = setup()
    const result = await t.call(agentCtx('lead'), 'question.create', QUESTION)
    expect(result.ok).toBe(true)
    const card = t.nodes().find(node => node.kind === 'question')!
    expect(card.title).toBe('Líder')
    expect(card.task).toMatchObject({
      questions: [{ id: 'q1', question: QUESTION.question }],
      askedByNodeId: 'lead',
      status: 'pending',
      answers: null,
    })
    expect(card.position.x).toBeGreaterThanOrEqual(100 + 400)
    expect(t.space().nodeIds).toContain(card.id)
  })

  it('refuses a team member: members ask the lead, never the user', async () => {
    const t = setup({ members: ['dev'] })
    const result = await t.call(agentCtx('dev'), 'question.create', QUESTION)
    expect(result).toMatchObject({ ok: false, error: { code: 'common.forbidden' } })
    expect(t.writes()).toBe(0)
  })

  it('refuses a question without options', async () => {
    const t = setup()
    const result = await t.call(userCtx, 'question.create', {
      question: 'Sem opções?',
      options: [],
      askedByNodeId: 'lead',
    })
    expect(result.ok).toBe(false)
    expect(t.writes()).toBe(0)
  })
})

describe('question.answer', () => {
  async function ask(t: ReturnType<typeof setup>) {
    const created = await t.call(agentCtx('lead'), 'question.create', QUESTION)
    return (created as { ok: true; value: { nodeId: string } }).value.nodeId
  }

  it('sends the answer to the agent, marks the card answered and keeps the decision', async () => {
    const t = setup()
    const nodeId = await ask(t)
    const result = await t.call(userCtx, 'question.answer', { nodeId, optionIndex: 0 })
    expect(result.ok).toBe(true)
    expect(t.prompts).toHaveLength(1)
    expect(t.prompts[0]).toMatchObject({ nodeId: 'lead' })
    expect(t.prompts[0]!.text).toContain('Acima do e-mail')
    const card = t.nodes().find(node => node.id === nodeId)!
    expect(card.task).toMatchObject({
      status: 'answered',
      answers: [{ questionId: 'q1', optionIndexes: [0], text: '', skipped: false }],
      answeredAt: now.toISOString(),
    })
    expect(t.decisions).toEqual([
      expect.objectContaining({
        projectId: 'ws',
        spaceId: 'task',
        askedByTitle: 'Líder',
        question: QUESTION.question,
        answer: 'Acima do e-mail',
      }),
    ])
    const history = await t.call(userCtx, 'question.history', { spaceId: 'task' })
    expect(history).toMatchObject({
      ok: true,
      value: { decisions: [{ answer: 'Acima do e-mail' }] },
    })
  })

  it('answers at most once: a second answer sends nothing', async () => {
    const t = setup()
    const nodeId = await ask(t)
    await t.call(userCtx, 'question.answer', { nodeId, text: 'Só no cadastro' })
    const again = await t.call(userCtx, 'question.answer', { nodeId, optionIndex: 1 })
    expect(again.ok).toBe(false)
    expect(t.prompts).toHaveLength(1)
    expect(t.decisions).toHaveLength(1)
  })

  it('keeps the card pending when the agent did not receive the answer', async () => {
    const t = setup({ deliveryFails: true })
    const nodeId = await ask(t)
    const writesBefore = t.writes()
    const result = await t.call(userCtx, 'question.answer', { nodeId, optionIndex: 0 })
    expect(result.ok).toBe(false)
    expect(t.writes()).toBe(writesBefore)
    expect(t.nodes().find(node => node.id === nodeId)!.task.status).toBe('pending')
    expect(t.decisions).toHaveLength(0)
  })
})

describe('question cards with several questions', () => {
  const MULTI = {
    questions: [
      { header: 'Login', question: 'Onde fica o botão?', options: [{ label: 'Acima' }] },
      {
        header: 'Telas',
        question: 'Quais telas mudam?',
        multiSelect: true,
        options: [{ label: 'Login' }, { label: 'Cadastro' }],
      },
      { header: 'Prazo', question: 'Sobe hoje?', options: [{ label: 'Sim' }] },
    ],
  }

  async function askMany(t: ReturnType<typeof setup>) {
    const created = await t.call(agentCtx('lead'), 'question.create', MULTI)
    return (created as { ok: true; value: { nodeId: string } }).value.nodeId
  }

  it('delivers all answers in one message and keeps one decision per question', async () => {
    const t = setup()
    const nodeId = await askMany(t)
    const result = await t.call(userCtx, 'question.answer', {
      nodeId,
      answers: [
        { questionId: 'q1', optionIndexes: [0] },
        { questionId: 'q2', optionIndexes: [0, 1] },
        { questionId: 'q3', skipped: true },
      ],
    })
    expect(result.ok).toBe(true)
    expect(t.prompts).toHaveLength(1)
    expect(t.prompts[0]!.text).toContain('1. Login: Onde fica o botão? -> Acima')
    expect(t.prompts[0]!.text).toContain('2. Telas: Quais telas mudam? -> Login, Cadastro')
    expect(t.prompts[0]!.text).toContain('3. Prazo: Sobe hoje? -> pulada (você decide)')
    expect(t.nodes().find(node => node.id === nodeId)!.task.status).toBe('answered')
    expect(t.decisions.map(decision => decision.answer)).toEqual([
      'Acima',
      'Login, Cadastro',
      'pulada (você decide)',
    ])
  })

  it('refuses a partial answer and sends nothing', async () => {
    const t = setup()
    const nodeId = await askMany(t)
    const result = await t.call(userCtx, 'question.answer', {
      nodeId,
      answers: [{ questionId: 'q1', optionIndexes: [0] }],
    })
    expect(result.ok).toBe(false)
    expect(t.prompts).toHaveLength(0)
    expect(t.nodes().find(node => node.id === nodeId)!.task.status).toBe('pending')
  })

  it('puts new questions in the card still waiting for the user, not in a second card', async () => {
    const t = setup()
    const first = await askMany(t)
    const second = await t.call(agentCtx('lead'), 'question.create', {
      questions: [{ header: 'Docs', question: 'Atualizo o README?', options: [{ label: 'Sim' }] }],
    })
    expect(second).toMatchObject({ ok: true, value: { nodeId: first, merged: true } })
    const cards = t.nodes().filter(node => node.kind === 'question')
    expect(cards).toHaveLength(1)
    expect(cards[0]!.task.questions.map((item: { id: string }) => item.id)).toEqual([
      'q1',
      'q2',
      'q3',
      'q4',
    ])
  })

  it('opens a new card once the previous one was answered', async () => {
    const t = setup()
    const first = await askMany(t)
    await t.call(userCtx, 'question.answer', {
      nodeId: first,
      answers: [
        { questionId: 'q1', skipped: true },
        { questionId: 'q2', skipped: true },
        { questionId: 'q3', skipped: true },
      ],
    })
    const second = await t.call(agentCtx('lead'), 'question.create', QUESTION)
    expect(second).toMatchObject({ ok: true, value: { merged: false } })
    expect(t.nodes().filter(node => node.kind === 'question')).toHaveLength(2)
  })

  it('refuses more than 8 questions in one card', async () => {
    const t = setup()
    const one = { question: 'Q', options: [{ label: 'A' }] }
    const result = await t.call(agentCtx('lead'), 'question.create', {
      questions: Array.from({ length: 9 }, () => one),
    })
    expect(result.ok).toBe(false)
    expect(t.writes()).toBe(0)
  })
})

describe('todos.sync', () => {
  it('creates one card per agent and replaces its items afterwards', async () => {
    const t = setup()
    await t.call(agentCtx('dev'), 'todos.sync', {
      items: [{ text: 'Ler a rota', status: 'in_progress' }],
    })
    await t.call(agentCtx('dev'), 'todos.sync', {
      items: [
        { text: 'Ler a rota', status: 'completed' },
        { text: 'Criar a rota', status: 'pending' },
      ],
    })
    const cards = t.nodes().filter(node => node.kind === 'todos')
    expect(cards).toHaveLength(1)
    expect(cards[0]!.task).toMatchObject({
      ownerNodeId: 'dev',
      items: [
        { text: 'Ler a rota', status: 'completed' },
        { text: 'Criar a rota', status: 'pending' },
      ],
    })
  })

  it('does not create a card for an empty list', async () => {
    const t = setup()
    const result = await t.call(agentCtx('dev'), 'todos.sync', { items: [] })
    expect(result).toMatchObject({ ok: true, value: { nodeId: null } })
    expect(t.writes()).toBe(0)
  })
})

describe('agent authority over cards', () => {
  it('only the user answers questions', () => {
    expect(sessionGrantAccess('question.answer').access).toBe('denied')
    expect(sessionGrantAccess('question.history').access).toBe('allowed')
  })

  it('an agent cannot ask or keep a list in the name of another node', () => {
    for (const [id, field] of [
      ['question.create', 'askedByNodeId'],
      ['todos.sync', 'ownerNodeId'],
    ] as const) {
      const rule = SESSION_GRANT_POLICY[id]
      expect(rule.access).toBe('constrained')
      if (rule.access !== 'constrained') {
        continue
      }
      const deps = (wirePayload: unknown) =>
        ({ grant: {}, wirePayload, operationId: id }) as unknown as GrantCheckDeps
      expect(() => rule.check({}, deps({ [field]: 'other' }))).toThrow()
      expect(() => rule.check({}, deps({ items: [] }))).not.toThrow()
    }
  })
})
