import { describe, expect, it } from 'vitest'
import type { Subtask, Task, UserQuestion } from '@shared/domain'
import {
  composeLeaderPrompt,
  composeMemberFirstPrompt,
  composeMemberResumePrompt,
  LEADER_FINISH_RULE,
  LEADER_APP_CONTEXT,
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
  workflowStatus: 'a_fazer',
  startCommand: null,
  startDir: null,
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
      `Lidere Login novo.\n\n${LEADER_FINISH_RULE}\n\n${LEADER_APP_CONTEXT}`,
    )
    const semPapel = composeLeaderPrompt({ task, cwd: '/wt/login', template: null })
    expect(semPapel).toContain('subtarefa_criar')
    expect(semPapel).toContain('Tarefa: Login novo')
  })

  it('Líder: sempre recebe a regra de chamar tarefa_concluir ao terminar', () => {
    const comPapel = composeLeaderPrompt({ task, cwd: '/wt/login', template: 'Lidere.' })
    expect(comPapel).toContain('tarefa_concluir')
    expect(comPapel).toContain('Em revisão')
    // Papel que ja fala da ferramenta nao recebe a regra repetida.
    const proprio = composeLeaderPrompt({
      task,
      cwd: '/wt/login',
      template: 'Lidere {{tarefa}} e chame tarefa_concluir no fim.',
    })
    expect(proprio).not.toContain(LEADER_FINISH_RULE)
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

describe('contexto do app no prompt do Líder', () => {
  const t = { title: 'Login novo' } as Parameters<typeof composeLeaderPrompt>[0]['task']
  it('prompt importado com canvas recebe o bloco que diz o que vale no app novo', () => {
    const prompt = composeLeaderPrompt({
      task: t,
      cwd: '/wt',
      template: 'Pergunte com pergunta_criar (card no canvas).',
    })
    expect(prompt.endsWith(LEADER_APP_CONTEXT)).toBe(true)
    expect(prompt).toContain('NÃO tem canvas')
    expect(prompt).toContain('pergunta_repassar')
    expect(prompt).toContain('A worktree e a branch desta tarefa já existem')
  })

  it('tarefa sem worktree troca a linha da worktree pelo aviso da pasta do projeto', () => {
    const prompt = composeLeaderPrompt({
      task: { ...t, worktreePath: null, branch: null } as typeof t,
      cwd: '/repo',
      template: 'Lidere {{tarefa}} na branch {{branch}}.',
    })
    expect(prompt).toContain('Esta tarefa não tem worktree')
    expect(prompt).toContain('pasta do projeto, na branch atual')
    expect(prompt).not.toContain('já existem')
  })
})

describe('aviso de tarefa sem worktree', () => {
  it('Líder sem prompt de papel também recebe o aviso', () => {
    const prompt = composeLeaderPrompt({
      task: { ...task, worktreePath: null, branch: null },
      cwd: '/repo',
      template: '',
    })
    expect(prompt).toContain('Esta tarefa não tem worktree')
  })

  it('prompt de retomada do membro diz onde ficou o trabalho', () => {
    expect(composeMemberResumePrompt('siga', true)).toContain('continua na worktree')
    expect(composeMemberResumePrompt('siga', false)).toContain('continua na pasta do projeto')
  })
})
