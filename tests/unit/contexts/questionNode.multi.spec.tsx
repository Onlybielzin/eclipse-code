import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ReactFlowProvider } from '@xyflow/react'
import { QuestionNode } from '../../../src/contexts/workspace/presentation/renderer/components/QuestionNode'
import { ensureQuestionCardData } from '../../../src/contexts/workspace/domain/canvasCards'

const invoke = vi.fn(async () => ({ ok: true }))

beforeEach(() => {
  invoke.mockClear()
  window.localStorage.clear()
  ;(window as unknown as { eclipseCodeApi: unknown }).eclipseCodeApi = {
    controlSurface: { invoke },
  }
})

function renderCard(task: unknown, nodeId = 'card-1') {
  return render(
    <ReactFlowProvider>
      <QuestionNode
        nodeId={nodeId}
        askerTitle="Líder"
        place={null}
        data={ensureQuestionCardData(task)}
        position={{ x: 0, y: 0 }}
        width={360}
        height={420}
        onClose={() => undefined}
        onResize={() => undefined}
      />
    </ReactFlowProvider>,
  )
}

const MULTI = {
  questions: [
    {
      header: 'Login',
      question: 'Onde fica o botão?',
      options: [{ label: 'Acima' }, { label: 'Abaixo' }],
    },
    {
      header: 'Telas',
      question: 'Quais telas mudam?',
      multiSelect: true,
      options: [{ label: 'Login' }, { label: 'Cadastro' }],
    },
    { header: 'Prazo', question: 'Sobe hoje?', options: [{ label: 'Sim' }] },
  ],
  askedByNodeId: 'lead',
  status: 'pending',
}

describe('question card with several questions', () => {
  it('collects every answer and sends them once, only when all are answered or skipped', async () => {
    renderCard(MULTI)
    const send = screen.getByTestId('question-node-send-all')
    expect(send).toBeDisabled()

    // Single choice: a click picks and moves to the next question without sending.
    fireEvent.click(screen.getByTestId('question-node-option-1'))
    expect(invoke).not.toHaveBeenCalled()
    expect(screen.getByText('Quais telas mudam?')).toBeInTheDocument()

    // Multi choice: two clicks keep both; then go to the last question by its tab.
    fireEvent.click(screen.getByTestId('question-node-option-0'))
    fireEvent.click(screen.getByTestId('question-node-option-1'))
    fireEvent.click(screen.getByTestId('question-node-tab-2'))
    fireEvent.click(screen.getByTestId('question-node-skip'))

    expect(send).toBeEnabled()
    fireEvent.click(send)
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1))
    expect(invoke).toHaveBeenCalledWith({
      kind: 'command',
      id: 'question.answer',
      payload: {
        nodeId: 'card-1',
        answers: [
          { questionId: 'q1', optionIndexes: [1] },
          { questionId: 'q2', optionIndexes: [0, 1] },
          { questionId: 'q3', skipped: true },
        ],
      },
    })
  })

  it('keeps the choices made before a reload', () => {
    const first = renderCard(MULTI, 'card-2')
    fireEvent.click(screen.getByTestId('question-node-option-0'))
    first.unmount()
    renderCard(MULTI, 'card-2')
    expect(screen.getByTestId('question-node-tab-0').className).toContain(
      'question-node__tab--done',
    )
  })

  it('still answers a single question on the first click', async () => {
    renderCard({
      question: 'Onde?',
      options: [{ label: 'A' }, { label: 'B' }],
      askedByNodeId: 'lead',
      status: 'pending',
    })
    expect(screen.queryByTestId('question-node-send-all')).toBeNull()
    fireEvent.click(screen.getByTestId('question-node-option-1'))
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1))
    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: { nodeId: 'card-1', answers: [{ questionId: 'q1', optionIndexes: [1] }] },
      }),
    )
  })

  it('shows each question with what was chosen once answered', () => {
    renderCard({
      ...MULTI,
      status: 'answered',
      answeredAt: '2026-11-12T10:00:00.000Z',
      answers: [
        { questionId: 'q1', optionIndexes: [0], text: '', skipped: false },
        { questionId: 'q2', optionIndexes: [1], text: 'Perfil', skipped: false },
        { questionId: 'q3', optionIndexes: [], text: '', skipped: true },
      ],
    })
    expect(screen.getByTestId('question-node-answer-q1')).toHaveTextContent('Acima')
    expect(screen.getByTestId('question-node-answer-q2')).toHaveTextContent('Cadastro, Perfil')
    expect(screen.getByTestId('question-node-answer-q3')).toHaveTextContent(/agent decides/i)
  })
})
