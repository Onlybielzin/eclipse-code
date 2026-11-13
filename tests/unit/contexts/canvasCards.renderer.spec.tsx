import React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  readPersistedState,
  toPersistedState,
  writeRawPersistedState,
} from '../../../src/contexts/workspace/presentation/renderer/utils/persistence'
import { toRuntimeNodes } from '../../../src/contexts/workspace/presentation/renderer/utils/nodeTransform'
import { selectCardsToClose } from '../../../src/contexts/workspace/presentation/renderer/components/workspaceCanvas/hooks/useCanvasCardLifecycle'
import { listPendingQuestions } from '../../../src/app/renderer/shell/utils/pendingQuestions'
import { SidebarAttentionInbox } from '../../../src/app/renderer/shell/components/SidebarAttentionInbox'
import type { WorkspaceState } from '../../../src/contexts/workspace/presentation/renderer/types'
import { installMockStorage } from '../../support/persistenceTestStorage'

installMockStorage()

beforeEach(() => {
  window.localStorage.clear()
})

const question = {
  question: 'Onde fica o botão?',
  context: '',
  options: [{ label: 'Acima', detail: '1 arquivo', recommended: true }],
  allowOther: true,
  askedByNodeId: 'lead',
  status: 'pending',
  answer: null,
  answeredAt: null,
  createdAt: '2026-11-11T14:00:00.000Z',
}

function cardNode(id: string, kind: 'question' | 'todos', task: unknown) {
  return {
    id,
    title: 'Líder',
    position: { x: 10, y: 20 },
    width: 360,
    height: 400,
    kind,
    status: null,
    startedAt: null,
    endedAt: null,
    exitCode: null,
    lastError: null,
    scrollback: null,
    agent: null,
    task,
  }
}

async function restoredWorkspace(nodes: unknown[]): Promise<WorkspaceState> {
  await writeRawPersistedState(
    JSON.stringify({
      activeWorkspaceId: 'ws',
      workspaces: [{ id: 'ws', name: 'loja', path: '/tmp/loja', nodes }],
    }),
  )
  const persisted = (await readPersistedState())!.workspaces[0]!
  return {
    ...persisted,
    nodes: toRuntimeNodes(persisted),
  } as unknown as WorkspaceState
}

describe('canvas cards survive a restart', () => {
  it('reads question and to-do cards back with their payloads, and writes them unchanged', async () => {
    const todos = {
      ownerNodeId: 'dev',
      items: [{ text: 'Ler', status: 'completed' }],
      updatedAt: null,
    }
    const workspace = await restoredWorkspace([
      cardNode('q1', 'question', question),
      cardNode('t1', 'todos', todos),
    ])
    const [q, t] = workspace.nodes
    expect(q!.type).toBe('questionNode')
    // Saved before multi-question cards: opens as a card with one question.
    expect(q!.data.question).toMatchObject({
      questions: [{ id: 'q1', question: question.question }],
      status: 'pending',
    })
    expect(t!.type).toBe('todosNode')
    expect(t!.data.todos).toEqual(todos)

    const written = toPersistedState([workspace], 'ws').workspaces[0]!.nodes
    expect(written.find(node => node.id === 'q1')!.task).toMatchObject({ askedByNodeId: 'lead' })
    expect(written.find(node => node.id === 't1')!.task).toEqual(todos)
  })
})

describe('cards that leave the canvas', () => {
  it('closes answered questions right away and to-do lists whose agent is gone', async () => {
    const answeredAt = '2026-11-11T14:32:00.000Z'
    const workspace = await restoredWorkspace([
      cardNode('pending', 'question', question),
      cardNode('answered', 'question', {
        ...question,
        status: 'answered',
        answer: { optionIndex: 0, text: '' },
        answeredAt,
      }),
      cardNode('orphan', 'todos', { ownerNodeId: 'gone', items: [], updatedAt: null }),
      cardNode('mine', 'todos', { ownerNodeId: 'pending', items: [], updatedAt: null }),
    ])
    expect(selectCardsToClose(workspace.nodes)).toEqual(['answered', 'orphan'])
  })
})

describe('needs you: questions', () => {
  it('lists pending questions and opens the card on click', async () => {
    const workspace = await restoredWorkspace([cardNode('q1', 'question', question)])
    const pending = listPendingQuestions([workspace])
    expect(pending).toEqual([
      expect.objectContaining({
        nodeId: 'q1',
        question: question.question,
        questionCount: 1,
        askedByNodeId: 'lead',
      }),
    ])
    const onSelect = vi.fn()
    render(<SidebarAttentionInbox items={[]} questions={pending} onSelectAgentNode={onSelect} />)
    expect(screen.getByTestId('workspace-attention-inbox')).toHaveTextContent('1')
    fireEvent.click(screen.getByTestId('workspace-attention-question-ws-q1'))
    expect(onSelect).toHaveBeenCalledWith('ws', 'q1')
  })
})
