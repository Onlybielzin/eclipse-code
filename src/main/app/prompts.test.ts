import { describe, expect, it } from 'vitest'
import type { Subtask, Task, UserQuestion } from '@shared/domain'
import {
  composeLeaderPrompt,
  composeMemberFirstPrompt,
  composeQuestionNotice,
  renderPromptTemplate,
} from './prompts'

const task: Task = {
  id: 't1',
  projectId: 'p1',
  contextId: 'c1',
  title: 'Login novo',
  kind: 'team',
  worktreePath: '/wt/login',
  branch: 'feat/login-novo',
  baseBranch: 'main',
  leadRoleId: 'r1',
  soloProvider: null,
  status: 'open',
  createdAt: 0,
  updatedAt: 0,
  archivedAt: null,
}

const subtask: Subtask = {
  id: 's1',
  taskId: 't1',
  roleId: 'r2',
  title: 'Tela',
  instructions: 'Faça a tela.',
  state: 'submitted',
  statusMessage: null,
  failureCode: null,
  referenceTaskIds: [],
  sessionId: null,
  createdAt: 0,
  updatedAt: 0,
  finishedAt: null,
}

describe('prompts', () => {
  it('troca as variaveis conhecidas e mantém as desconhecidas', () => {
    expect(
      renderPromptTemplate('{{tarefa}} em {{ worktree }} ({{branch}}) {{outra}}', {
        tarefa: 'A',
        worktree: '/w',
        branch: 'b',
      }),
    ).toBe('A em /w (b) {{outra}}')
  })

  it('Líder: prompt do papel renderizado; sem papel usa a dica das ferramentas', () => {
    expect(composeLeaderPrompt({ task, cwd: '/wt/login', template: 'Lidere {{tarefa}}.' })).toBe(
      'Lidere Login novo.',
    )
    const semPapel = composeLeaderPrompt({ task, cwd: '/wt/login', template: null })
    expect(semPapel).toContain('subtarefa_criar')
    expect(semPapel).toContain('Tarefa: Login novo')
  })

  it('membro: instruções, origem e a regra de entrega com STATUS', () => {
    const text = composeMemberFirstPrompt(subtask, [
      { ...subtask, id: 's0', title: 'Antes', statusMessage: 'bloqueado' },
    ])
    expect(text).toContain('Subtarefa s1: Tela')
    expect(text).toContain('Faça a tela.')
    expect(text).toContain('- s0 (Antes): bloqueado')
    expect(text).toContain('entregar')
    expect(text).toContain('STATUS: PRONTO')
  })

  it('aviso de pergunta respondida leva os rótulos escolhidos', () => {
    const question: UserQuestion = {
      id: 'q1',
      taskId: 't1',
      subtaskId: 's1',
      items: [
        {
          id: 'i1',
          prompt: 'Qual banco?',
          options: [{ id: 'o1', label: 'Postgres' }],
          multiSelect: false,
          allowFreeText: true,
        },
      ],
      status: 'answered',
      answers: [{ itemId: 'i1', optionIds: ['o1'], text: 'versão 16' }],
      createdAt: 0,
      answeredAt: 1,
    }
    expect(composeQuestionNotice(question)).toBe(
      '[eclipse] O usuário respondeu a pergunta q1 (subtarefa s1): Qual banco? -> Postgres, versão 16',
    )
    expect(composeQuestionNotice({ ...question, status: 'dismissed', answers: null })).toContain(
      'deixou a decisão com você',
    )
  })
})
