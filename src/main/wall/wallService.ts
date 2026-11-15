/**
 * Retrato da Parede: tarefas abertas de todos os projetos com o diff de cada worktree.
 * So le. O git das worktrees roda em paralelo, no maximo 4 por vez.
 */
import type { Project, ProjectId, Role, Subtask, Task, TaskId, UserQuestion } from '@shared/domain'
import type { AgentLimitSettings } from '@shared/ports'
import type { WallSnapshot, WallTask } from '@shared/wall'
import { readWorktreeDiff, type WorktreeDiff } from './worktreeDiff'

export interface WallSource {
  listProjects(): Project[]
  listRoles(projectId: ProjectId): Role[]
  listTasks(projectId: ProjectId, options: { includeArchived: boolean }): Task[]
  listSubtasks(taskId: TaskId): Subtask[]
  listOpenQuestions(projectId: ProjectId): UserQuestion[]
  getAgentLimitSettings(): AgentLimitSettings
}

export interface WallOptions {
  now?: () => number
  readDiff?: (cwd: string, baseBranch: string) => Promise<WorktreeDiff>
}

const GIT_PARALLEL = 4
const NO_DIFF: WorktreeDiff = { linesAdded: 0, linesRemoved: 0, lastFile: null, lastLines: [] }

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async () => {
    for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i] as T)
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

export async function buildWallSnapshot(
  source: WallSource,
  options: WallOptions = {},
): Promise<WallSnapshot> {
  const now = (options.now ?? Date.now)()
  const readDiff = options.readDiff ?? readWorktreeDiff
  const d = new Date(now)
  const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()

  let doneToday = 0
  let workingAgents = 0
  let openQuestions = 0
  const pending: { base: Omit<WallTask, 'linesAdded' | 'linesRemoved' | 'lastFile' | 'lastLines'>; cwd: string | null; branch: string }[] = []

  for (const project of source.listProjects()) {
    const roles = new Map(source.listRoles(project.id).map((r) => [r.id, r.name]))
    const questions = source.listOpenQuestions(project.id)
    openQuestions += questions.length
    // Arquivadas entram so na conta de "prontas hoje".
    for (const task of source.listTasks(project.id, { includeArchived: true })) {
      const subtasks = source.listSubtasks(task.id)
      doneToday += subtasks.filter(
        (s) => s.state === 'completed' && s.finishedAt !== null && s.finishedAt >= midnight,
      ).length
      if (task.status !== 'open') continue
      workingAgents += subtasks.filter((s) => s.state === 'working').length
      pending.push({
        cwd: task.worktreePath, // sem worktree: sem leitura de diff (a raiz do projeto mistura o trabalho de outras tarefas)
        branch: task.baseBranch ?? 'HEAD',
        base: {
          id: task.id,
          projectId: project.id,
          projectName: project.name,
          title: task.title,
          workflowStatus: task.workflowStatus,
          branch: task.branch,
          updatedAt: task.updatedAt,
          members: subtasks.map((s) => ({
            subtaskId: s.id,
            role: roles.get(s.roleId) ?? 'Membro',
            title: s.title,
            state: s.state,
          })),
          openQuestions: questions.filter((q) => q.taskId === task.id).length,
        },
      })
    }
  }

  const tasks = await mapLimit(pending, GIT_PARALLEL, async (p) => ({
    ...p.base,
    ...(p.cwd === null ? NO_DIFF : await readDiff(p.cwd, p.branch).catch(() => NO_DIFF)),
  }))
  return {
    at: now,
    tasks,
    workingAgents,
    maxLiveAgents: source.getAgentLimitSettings().maxLiveAgents,
    doneToday,
    inReview: tasks.filter((t) => t.workflowStatus === 'em_revisao').length,
    openQuestions,
  }
}

/** Um unico retrato em voo: chamadas simultaneas esperam a mesma execucao. */
export function coalesced<T>(run: () => Promise<T>): () => Promise<T> {
  let inflight: Promise<T> | null = null
  return () => {
    inflight ??= run().finally(() => {
      inflight = null
    })
    return inflight
  }
}
