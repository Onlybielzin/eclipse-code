import { describe, expect, it } from 'vitest'
import type { Project, Role, Subtask, Task, UserQuestion } from '@shared/domain'
import { buildWallSnapshot, coalesced, type WallSource } from './wallService'

const NOW = new Date(2026, 10, 14, 15, 0, 0).getTime()
const MIDNIGHT = new Date(2026, 10, 14, 0, 0, 0).getTime()

const project = (id: string, name: string) => ({ id, name, rootPath: `/r/${id}` }) as Project
const role = { id: 'dev', name: 'Dev' } as Role
const task = (id: string, p: string, extra: Partial<Task> = {}) =>
  ({
    id, projectId: p, title: `t-${id}`, kind: 'team', worktreePath: `/wt/${id}`, branch: id,
    baseBranch: 'main', status: 'open', workflowStatus: 'em_andamento', updatedAt: 5, ...extra,
  }) as Task
const sub = (id: string, taskId: string, extra: Partial<Subtask> = {}) =>
  ({ id, taskId, roleId: 'dev', title: id, state: 'working', finishedAt: null, ...extra }) as Subtask

function source(tasks: Task[], subs: Subtask[], questions: UserQuestion[] = []): WallSource {
  return {
    listProjects: () => [project('p1', 'alfa'), project('p2', 'beta')],
    listRoles: () => [role],
    listTasks: (pid) => tasks.filter((t) => t.projectId === pid),
    listSubtasks: (tid) => subs.filter((s) => s.taskId === tid),
    listOpenQuestions: (pid) =>
      questions.filter((q) => tasks.find((t) => t.id === q.taskId)?.projectId === pid),
    getAgentLimitSettings: () => ({ maxLiveAgents: 12, maxLiveMembersPerTask: null }),
  }
}

describe('buildWallSnapshot', () => {
  it('junta os projetos, soma os números e ignora tarefa arquivada', async () => {
    const tasks = [
      task('a', 'p1'),
      task('b', 'p2', { workflowStatus: 'em_revisao' }),
      task('solo', 'p1', { kind: 'solo', worktreePath: null }),
      task('old', 'p1', { status: 'archived', workflowStatus: 'lancado' }),
    ]
    const subs = [
      sub('s1', 'a'),
      sub('s2', 'a', { state: 'completed', finishedAt: MIDNIGHT + 1 }),
      sub('s3', 'b', { state: 'completed', finishedAt: MIDNIGHT - 1 }),
      sub('s4', 'old', { state: 'completed', finishedAt: MIDNIGHT + 5 }),
    ]
    const q = [{ id: 'q1', taskId: 'a', status: 'open' }] as UserQuestion[]
    const snap = await buildWallSnapshot(source(tasks, subs, q), {
      now: () => NOW,
      readDiff: async (cwd) => ({
        linesAdded: cwd === '/wt/a' ? 7 : 1, linesRemoved: 2, lastFile: 'x.ts', lastLines: ['+x'],
      }),
    })
    expect(snap.tasks.map((t) => t.id).sort()).toEqual(['a', 'b', 'solo'])
    const a = snap.tasks.find((t) => t.id === 'a')!
    expect(a).toMatchObject({ projectName: 'alfa', linesAdded: 7, linesRemoved: 2, openQuestions: 1 })
    expect(a.members.map((m) => [m.role, m.state])).toEqual([['Dev', 'working'], ['Dev', 'completed']])
    expect(snap).toMatchObject({
      workingAgents: 1, maxLiveAgents: 12, doneToday: 2, inReview: 1, openQuestions: 1, at: NOW,
    })
  })

  it('time sem worktree conta os agentes e aparece sem ler o diff', async () => {
    const reads: string[] = []
    const snap = await buildWallSnapshot(
      source([task('t', 'p1', { worktreePath: null })], [sub('s1', 't')]),
      { now: () => NOW, readDiff: async (cwd) => (reads.push(cwd), { linesAdded: 9, linesRemoved: 9, lastFile: null, lastLines: [] }) },
    )
    expect(snap.workingAgents).toBe(1)
    expect(snap.tasks).toHaveLength(1)
    expect(snap.tasks[0]).toMatchObject({ linesAdded: 0, linesRemoved: 0 })
    expect(reads).toEqual([])
  })

  it('erro no git de uma tarefa não derruba o retrato e o limite é 4 em paralelo', async () => {
    const tasks = Array.from({ length: 9 }, (_, i) => task(`t${i}`, 'p1'))
    let running = 0
    let peak = 0
    const snap = await buildWallSnapshot(source(tasks, []), {
      now: () => NOW,
      readDiff: async (cwd) => {
        running++
        peak = Math.max(peak, running)
        await new Promise((r) => setTimeout(r, 5))
        running--
        if (cwd === '/wt/t3') throw new Error('sumiu')
        return { linesAdded: 1, linesRemoved: 0, lastFile: null, lastLines: [] }
      },
    })
    expect(snap.tasks).toHaveLength(9)
    expect(snap.tasks.find((t) => t.id === 't3')!.linesAdded).toBe(0)
    expect(peak).toBeLessThanOrEqual(4)
  })
})

describe('coalesced', () => {
  it('chamadas simultâneas reaproveitam a mesma execução; depois de acabar, abre outra', async () => {
    let runs = 0
    const read = coalesced(async () => {
      await new Promise((r) => setTimeout(r, 5))
      return ++runs
    })
    const [a, b, c] = await Promise.all([read(), read(), read()])
    expect([a, b, c]).toEqual([1, 1, 1])
    expect(await read()).toBe(2)
  })
})
