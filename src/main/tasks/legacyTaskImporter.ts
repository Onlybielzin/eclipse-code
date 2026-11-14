/**
 * Importa as TAREFAS do app antigo (com canvas) para o app novo.
 *
 * O banco antigo e aberto SOMENTE LEITURA. Tarefa antiga = Space top-level com worktree
 * (workspace_spaces.directory_path). Para cada uma, enquanto a worktree existir no disco:
 *   - a tarefa entra no projeto com a mesma pasta (projeto casa pela raiz do workspace);
 *   - usa a MESMA worktree e a branch atual dela (nada e criado nem copiado);
 *   - o Lider antigo (no 'agent' com resumeSessionId) vira uma sessao de Lider aberta com
 *     esse providerSessionId; a recuperacao da partida a reabre com --resume, e a conversa
 *     continua;
 *   - pergunta pendente (no 'question', status 'pending') vira pergunta aberta;
 *   - status: "Pergunta para você" se trouxe pergunta, senao "Em andamento".
 *
 * Idempotente: tarefa cuja worktree ja e de uma tarefa do app novo e pulada.
 */
import Database from 'better-sqlite3'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { QuestionItem, Task } from '@shared/domain'
import type { SqliteTaskService } from './taskService'

export interface LegacyTaskQuestion {
  items: QuestionItem[]
}

export interface LegacyTask {
  legacySpaceId: string
  title: string
  projectRoot: string
  worktreePath: string
  leader: { providerSessionId: string; model: string | null } | null
  questions: LegacyTaskQuestion[]
}

export interface LegacyTaskImportReport {
  imported: { task: Task; resumes: boolean; questions: number }[]
  skipped: { title: string; reason: string }[]
}

function normalize(path: string): string {
  const resolved = resolve(path.trim())
  return resolved.length > 1 ? resolved.replace(/\/+$/, '') : resolved
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function parseJson(text: unknown): Record<string, unknown> | null {
  if (typeof text !== 'string' || !text) return null
  try {
    const value: unknown = JSON.parse(text)
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/** Card de pergunta antigo -> itens do app novo (prompt com cabecalho e contexto). */
export function mapLegacyQuestionItems(raw: unknown): QuestionItem[] {
  if (!Array.isArray(raw)) return []
  const items: QuestionItem[] = []
  raw.slice(0, 4).forEach((entry, index) => {
    if (!entry || typeof entry !== 'object') return
    const q = entry as Record<string, unknown>
    const question = asString(q.question)
    if (!question) return
    const header = asString(q.header)
    const context = asString(q.context)
    const prompt = [header ? `${header}: ${question}` : question, context]
      .filter(Boolean)
      .join('\n\n')
    const options = (Array.isArray(q.options) ? q.options : []).slice(0, 6).map((o, i) => {
      const opt = (o ?? {}) as Record<string, unknown>
      const label = asString(opt.label) ?? `Opção ${i + 1}`
      const detail = asString(opt.detail)
      const description = [detail, opt.recommended === true ? '(recomendada)' : null]
        .filter(Boolean)
        .join(' ')
      return {
        id: `o${i + 1}`,
        label: opt.recommended === true ? `${label} (recomendada)` : label,
        ...(description ? { description } : {}),
      }
    })
    items.push({
      id: asString(q.id) ?? `q${index + 1}`,
      prompt,
      options,
      multiSelect: q.multiSelect === true,
      allowFreeText: q.allowOther !== false || options.length === 0,
    })
  })
  return items
}

/** Le as tarefas do banco antigo sem escrever nele. Banco ausente devolve []. */
export function readLegacyTasks(dbPath: string): LegacyTask[] {
  if (!existsSync(dbPath)) return []
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    db.pragma('query_only = ON')
    const spaces = db
      .prepare(
        `SELECT s.id, s.name, s.directory_path AS dir, w.path AS root
           FROM workspace_spaces s JOIN workspaces w ON w.id = s.workspace_id
          WHERE s.parent_space_id IS NULL AND s.directory_path IS NOT NULL`,
      )
      .all() as { id: string; name: string; dir: string; root: string }[]
    const nodesOf = db.prepare(
      `SELECT n.kind, n.agent_json AS agent, n.task_json AS task, n.started_at AS startedAt
         FROM workspace_space_nodes sn JOIN nodes n ON n.id = sn.node_id
        WHERE sn.space_id = ?`,
    )
    const tasks: LegacyTask[] = []
    for (const space of spaces) {
      const nodes = nodesOf.all(space.id) as {
        kind: string
        agent: string | null
        task: string | null
        startedAt: string | null
      }[]
      // Lider: o agente Claude da tarefa com conversa para retomar (o mais recente).
      let leader: LegacyTask['leader'] = null
      for (const node of nodes) {
        if (node.kind !== 'agent') continue
        const agent = parseJson(node.agent)
        if (!agent || agent.provider !== 'claude-code') continue
        const id = asString(agent.resumeSessionId)
        if (!id) continue
        const prompt = asString(agent.prompt) ?? ''
        const isLead = /L[ÍI]DER/i.test(prompt.slice(0, 200))
        if (!leader || isLead) leader = { providerSessionId: id, model: asString(agent.model) }
      }
      const questions: LegacyTaskQuestion[] = []
      for (const node of nodes) {
        if (node.kind !== 'question') continue
        const task = parseJson(node.task)
        if (!task || task.status !== 'pending') continue
        const items = mapLegacyQuestionItems(task.questions)
        if (items.length) questions.push({ items })
      }
      tasks.push({
        legacySpaceId: space.id,
        title: space.name,
        projectRoot: normalize(space.root),
        worktreePath: normalize(space.dir),
        leader,
        questions,
      })
    }
    return tasks
  } finally {
    db.close()
  }
}

function currentBranch(worktree: string): string | null {
  try {
    const out = execFileSync('git', ['-C', worktree, 'branch', '--show-current'], {
      encoding: 'utf8',
      timeout: 5000,
    }).trim()
    return out || null
  } catch {
    return null
  }
}

/** Grava no app novo. Cada tarefa e importada inteira ou pulada com motivo. */
export function importLegacyTasks(
  service: SqliteTaskService,
  legacy: readonly LegacyTask[],
  deps: { branchOf?: (worktree: string) => string | null; exists?: (p: string) => boolean } = {},
): LegacyTaskImportReport {
  const branchOf = deps.branchOf ?? currentBranch
  const exists = deps.exists ?? existsSync
  const report: LegacyTaskImportReport = { imported: [], skipped: [] }
  for (const lt of legacy) {
    if (!exists(lt.worktreePath)) {
      report.skipped.push({ title: lt.title, reason: 'worktree não existe mais' })
      continue
    }
    const project = service.getProjectByRoot(lt.projectRoot)
    if (!project) {
      report.skipped.push({ title: lt.title, reason: `sem projeto para ${lt.projectRoot}` })
      continue
    }
    const already = service
      .listTasks(project.id, { includeArchived: true })
      .some((t) => t.worktreePath !== null && normalize(t.worktreePath) === lt.worktreePath)
    if (already) {
      report.skipped.push({ title: lt.title, reason: 'já importada' })
      continue
    }
    const lead = service.getLeadRole(project.id)
    if (!lead) {
      report.skipped.push({ title: lt.title, reason: 'projeto sem papel de Líder' })
      continue
    }
    try {
      const task = service.createTask({
        projectId: project.id,
        title: lt.title,
        kind: 'team',
        worktreePath: lt.worktreePath,
        branch: branchOf(lt.worktreePath),
        baseBranch: null,
        leadRoleId: lead.id,
        soloProvider: null,
      })
      if (lt.leader) {
        // Sessao aberta: a recuperacao da partida a trata como Lider a retomar (--resume).
        service.openSession({
          taskId: task.id,
          subtaskId: null,
          roleId: lead.id,
          kind: 'leader-pty',
          provider: 'claude',
          model: lt.leader.model ?? lead.model,
          cwd: lt.worktreePath,
          providerSessionId: lt.leader.providerSessionId,
        })
      }
      // So a ultima pergunta fica aberta (pergunta nova substitui a anterior).
      for (const q of lt.questions) {
        service.createQuestion({ taskId: task.id, subtaskId: null, items: q.items })
      }
      const final =
        lt.questions.length > 0
          ? service.getTask(task.id)
          : service.setTaskWorkflowStatus(task.id, 'em_andamento', 'user')
      report.imported.push({
        task: final,
        resumes: lt.leader !== null,
        questions: lt.questions.length,
      })
    } catch (error) {
      report.skipped.push({
        title: lt.title,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return report
}
