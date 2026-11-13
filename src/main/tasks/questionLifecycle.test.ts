// Ciclo de vida da pergunta ao usuario: pergunta nova substitui a aberta da mesma tarefa,
// Enter no terminal do Lider fecha as abertas, e a migracao 4. SQLite em memoria.
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import type { DomainEventEnvelope, QuestionItem } from '@shared/domain'
import { MIGRATIONS } from './migrations'
import { migrate, SqliteTaskStore } from './sqliteTaskStore'
import { createHarness, seedTeam } from './testing'

const ITEMS: QuestionItem[] = [
  { id: 'i1', prompt: 'Qual banco?', options: [], multiSelect: false, allowFreeText: true },
]

function setup() {
  const { service } = createHarness()
  const fx = seedTeam(service)
  const other = service.createTask({
    projectId: fx.project.id,
    title: 'Outra tarefa',
    kind: 'team',
    worktreePath: '/wt/outra',
    branch: 'feat/outra',
    baseBranch: 'main',
    leadRoleId: null,
    soloProvider: null,
  })
  return { service, fx, other }
}

describe('pergunta nova substitui a aberta', () => {
  it('fecha as abertas da mesma tarefa como superseded, na mesma escrita', () => {
    const { service, fx } = setup()
    const q1 = service.createQuestion({ taskId: fx.task.id, subtaskId: null, items: ITEMS })
    const events: DomainEventEnvelope[] = []
    service.subscribe((e) => events.push(e))
    const q2 = service.createQuestion({ taskId: fx.task.id, subtaskId: null, items: ITEMS })

    expect(service.getQuestion(q1.id)).toMatchObject({ status: 'superseded', answers: null })
    expect(service.getQuestion(q1.id).answeredAt).not.toBeNull()
    expect(service.listOpenQuestions(fx.project.id).map((q) => q.id)).toEqual([q2.id])
    // Uma escrita so: a substituida e a nova saem juntas, a tarefa nao pisca para em_andamento.
    expect(events.map((e) => e.event.type)).toEqual(['question.upserted', 'question.upserted'])
    expect(service.getTask(fx.task.id).workflowStatus).toBe('pergunta')
  })

  it('não mexe na pergunta aberta de outra tarefa', () => {
    const { service, fx, other } = setup()
    const elsewhere = service.createQuestion({ taskId: other.id, subtaskId: null, items: ITEMS })
    service.createQuestion({ taskId: fx.task.id, subtaskId: null, items: ITEMS })
    service.createQuestion({ taskId: fx.task.id, subtaskId: null, items: ITEMS })
    expect(service.getQuestion(elsewhere.id).status).toBe('open')
    expect(service.listOpenQuestions(fx.project.id)).toHaveLength(2)
  })

  it('substituída não aceita resposta depois', () => {
    const { service, fx } = setup()
    const q1 = service.createQuestion({ taskId: fx.task.id, subtaskId: null, items: ITEMS })
    service.createQuestion({ taskId: fx.task.id, subtaskId: null, items: ITEMS })
    expect(() =>
      service.answerQuestion(q1.id, [{ itemId: 'i1', optionIds: [], text: 'x' }]),
    ).toThrow(/já foi respondida/)
  })
})

describe('resposta pelo terminal', () => {
  it('fecha todas as abertas da tarefa como answered_in_terminal e volta a em_andamento', () => {
    const { service, fx, other } = setup()
    const elsewhere = service.createQuestion({ taskId: other.id, subtaskId: null, items: ITEMS })
    const q = service.createQuestion({ taskId: fx.task.id, subtaskId: null, items: ITEMS })
    expect(service.getTask(fx.task.id).workflowStatus).toBe('pergunta')

    const closed = service.closeQuestionsAnsweredInTerminal(fx.task.id)
    expect(closed.map((c) => [c.id, c.status])).toEqual([[q.id, 'answered_in_terminal']])
    expect(service.getQuestion(q.id).status).toBe('answered_in_terminal')
    expect(service.getTask(fx.task.id).workflowStatus).toBe('em_andamento')
    expect(service.getQuestion(elsewhere.id).status).toBe('open')
    expect(service.getTask(other.id).workflowStatus).toBe('pergunta')
  })

  it('sem pergunta aberta não escreve nada', () => {
    const { service, fx } = setup()
    const events: DomainEventEnvelope[] = []
    service.subscribe((e) => events.push(e))
    expect(service.closeQuestionsAnsweredInTerminal(fx.task.id)).toEqual([])
    expect(events).toEqual([])
    expect(service.getTask(fx.task.id).workflowStatus).toBe('a_fazer')
  })
})

describe('migração 4', () => {
  it('mantém as perguntas antigas e passa a aceitar os dois status novos', () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    for (const m of MIGRATIONS.filter((x) => x.version <= 3)) db.exec(m.sql)
    db.pragma('user_version = 3')
    db.exec(`
      INSERT INTO projects VALUES ('p', 'p', '/p', 1, 1);
      INSERT INTO tasks (id, project_id, context_id, title, kind, status, created_at, updated_at)
        VALUES ('t', 'p', 'c1', 'A', 'solo', 'open', 1, 1);
      INSERT INTO questions (id, task_id, subtask_id, items_json, status, answers_json, created_at, answered_at)
        VALUES ('q1', 't', NULL, '[]', 'open', NULL, 1, NULL),
               ('q2', 't', NULL, '[]', 'answered', '[]', 2, 3);
    `)
    expect(migrate(db)).toBeGreaterThanOrEqual(4)
    const store = new SqliteTaskStore(db)
    expect(store.getQuestion('q1')?.status).toBe('open')
    expect(store.getQuestion('q2')).toMatchObject({
      status: 'answered',
      answers: [],
      answeredAt: 3,
    })
    expect(store.listOpenTaskQuestions('t').map((q) => q.id)).toEqual(['q1'])
    db.prepare("UPDATE questions SET status = 'superseded' WHERE id = 'q1'").run()
    db.prepare("UPDATE questions SET status = 'answered_in_terminal' WHERE id = 'q2'").run()
    expect(() => db.prepare("UPDATE questions SET status = 'x' WHERE id = 'q1'").run()).toThrow(
      /CHECK/,
    )
    // Apagar a tarefa ainda leva as perguntas junto (chave estrangeira recriada).
    db.prepare("DELETE FROM tasks WHERE id = 't'").run()
    expect(db.prepare('SELECT COUNT(*) AS n FROM questions').get()).toEqual({ n: 0 })
  })
})
