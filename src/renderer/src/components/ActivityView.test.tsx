// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { makeActivity, makeSubtask } from '../test/fakeApi'
import { ActivityView, buildBlocks } from './ActivityView'

const sub = makeSubtask('m1', 't1', { state: 'working' })

describe('Atividade com cara de terminal', () => {
  const events = [
    makeActivity(sub, 1, { kind: 'text', text: 'Vou rodar os testes.' }),
    makeActivity(sub, 2, {
      kind: 'tool_call',
      toolCallId: 'c1',
      title: 'Terminal',
      toolKind: 'execute',
      status: 'pending',
      input: {},
    }),
    makeActivity(sub, 3, {
      kind: 'tool_call',
      toolCallId: 'c1',
      title: 'pnpm test',
      toolKind: 'execute',
      status: 'in_progress',
      input: { command: 'pnpm test' },
    }),
    makeActivity(sub, 4, {
      kind: 'tool_result',
      toolCallId: 'c1',
      status: 'completed',
      output: '```\n' + Array.from({ length: 20 }, (_, i) => `linha ${i + 1}`).join('\n') + '\n```',
    }),
  ]

  it('junta chamada, atualização e resultado da mesma ferramenta num bloco', () => {
    const blocks = buildBlocks(events)
    expect(blocks).toHaveLength(2)
    const tool = blocks[1]
    expect(tool?.type).toBe('tool')
    if (tool?.type !== 'tool') return
    expect(tool.title).toBe('pnpm test')
    expect(tool.status).toBe('completed')
    expect(tool.output?.startsWith('linha 1')).toBe(true)
  })

  it('mostra o comando, corta a saída longa e indica que está trabalhando', () => {
    render(<ActivityView events={events} working />)
    expect(screen.getByText('pnpm test')).toBeTruthy()
    expect(screen.getByText('+ 8 linhas')).toBeTruthy()
    expect(screen.getByRole('status').textContent).toContain('trabalhando')
  })
})
