/**
 * TaskStore sobre better-sqlite3 (sincrono). So le e grava; regra de negocio fica
 * no TaskService. Colunas aninhadas (partes, entrega, itens) ficam em JSON.
 */
import Database from 'better-sqlite3'
import type {
  ActivityEvent,
  ActivityEventDraft,
  ActivityPayload,
  Artifact,
  ArtifactFormat,
  Delivery,
  DomainEvent,
  DomainEventEnvelope,
  EpochMs,
  Message,
  MessageAuthor,
  Part,
  Project,
  ProjectId,
  Provider,
  QuestionAnswer,
  QuestionId,
  QuestionItem,
  Role,
  RoleId,
  Session,
  SessionEndReason,
  SessionId,
  SessionKind,
  SessionStatus,
  StopReason,
  Subtask,
  SubtaskFailureCode,
  SubtaskId,
  SubtaskState,
  Task,
  TaskId,
  TaskKind,
  TaskStatus,
  TaskWorkflowStatus,
  Turn,
  TurnError,
  TurnId,
  UserQuestion,
  UserQuestionStatus,
} from '@shared/domain'
import type { ActivityPage } from '@shared/ipc'
import type { LeaderNotice, TaskStore } from '@shared/ports'
import { MIGRATIONS } from './migrations'

type Db = Database.Database
type Row = Record<string, unknown>

/** Quantas revisoes de evento manter. A tela so precisa das recentes para descartar atrasadas. */
export const EVENT_RETENTION = 5_000
const EVENT_PRUNE_EVERY = 500

export interface OpenTaskStoreOptions {
  /** Caminho do arquivo ou ':memory:'. */
  filename: string
}

/** Chave de comparacao de nome: sem acento, minuscula, espacos colapsados. */
export function roleNameKey(name: string): string {
  return name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim()
}

export function migrate(db: Db): number {
  const current = db.pragma('user_version', { simple: true }) as number
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue
    db.transaction(() => {
      db.exec(migration.sql)
      db.pragma(`user_version = ${migration.version}`)
    })()
  }
  return db.pragma('user_version', { simple: true }) as number
}

export function openSqliteTaskStore(options: OpenTaskStoreOptions): SqliteTaskStore {
  const db = new Database(options.filename)
  if (options.filename !== ':memory:') db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')
  db.pragma('synchronous = NORMAL')
  migrate(db)
  return new SqliteTaskStore(db)
}

// ---------------------------------------------------------------------------
// Conversao linha <-> entidade
// ---------------------------------------------------------------------------

const str = (v: unknown): string => v as string
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v))
const num = (v: unknown): number => Number(v)
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v))
const json = <T>(v: unknown): T => JSON.parse(v as string) as T
const jsonOrNull = <T>(v: unknown): T | null => (v === null || v === undefined ? null : json<T>(v))

function toProject(r: Row): Project {
  return {
    id: str(r['id']),
    name: str(r['name']),
    rootPath: str(r['root_path']),
    createdAt: num(r['created_at']),
    updatedAt: num(r['updated_at']),
  }
}

function toRole(r: Row): Role {
  return {
    id: str(r['id']),
    projectId: str(r['project_id']),
    name: str(r['name']),
    description: str(r['description']),
    provider: str(r['provider']) as Provider,
    model: strOrNull(r['model']),
    promptTemplate: str(r['prompt_template']),
    isLead: num(r['is_lead']) === 1,
    createdAt: num(r['created_at']),
    updatedAt: num(r['updated_at']),
  }
}

function toTask(r: Row): Task {
  return {
    id: str(r['id']),
    projectId: str(r['project_id']),
    contextId: str(r['context_id']),
    title: str(r['title']),
    kind: str(r['kind']) as TaskKind,
    worktreePath: strOrNull(r['worktree_path']),
    branch: strOrNull(r['branch']),
    baseBranch: strOrNull(r['base_branch']),
    leadRoleId: strOrNull(r['lead_role_id']),
    soloProvider: strOrNull(r['solo_provider']) as Provider | null,
    status: str(r['status']) as TaskStatus,
    workflowStatus: str(r['workflow_status']) as TaskWorkflowStatus,
    createdAt: num(r['created_at']),
    updatedAt: num(r['updated_at']),
    archivedAt: numOrNull(r['archived_at']),
  }
}

function toSubtask(r: Row): Subtask {
  return {
    id: str(r['id']),
    taskId: str(r['task_id']),
    roleId: str(r['role_id']),
    title: str(r['title']),
    instructions: str(r['instructions']),
    state: str(r['state']) as SubtaskState,
    statusMessage: strOrNull(r['status_message']),
    failureCode: strOrNull(r['failure_code']) as SubtaskFailureCode | null,
    referenceTaskIds: json<SubtaskId[]>(r['reference_task_ids']),
    sessionId: strOrNull(r['session_id']),
    createdAt: num(r['created_at']),
    updatedAt: num(r['updated_at']),
    finishedAt: numOrNull(r['finished_at']),
  }
}

function toMessage(r: Row): Message {
  return {
    id: str(r['id']),
    taskId: str(r['task_id']),
    subtaskId: str(r['subtask_id']),
    author: str(r['author']) as MessageAuthor,
    parts: json<Part[]>(r['parts_json']),
    turnId: strOrNull(r['turn_id']),
    createdAt: num(r['created_at']),
  }
}

function toArtifact(r: Row): Artifact {
  return {
    id: str(r['id']),
    taskId: str(r['task_id']),
    subtaskId: str(r['subtask_id']),
    sessionId: str(r['session_id']),
    turnId: str(r['turn_id']),
    format: str(r['format']) as ArtifactFormat,
    delivery: json<Delivery>(r['delivery_json']),
    parts: json<Part[]>(r['parts_json']),
    createdAt: num(r['created_at']),
  }
}

function toSession(r: Row): Session {
  return {
    id: str(r['id']),
    taskId: str(r['task_id']),
    subtaskId: strOrNull(r['subtask_id']),
    roleId: strOrNull(r['role_id']),
    kind: str(r['kind']) as SessionKind,
    provider: str(r['provider']) as Provider,
    model: strOrNull(r['model']),
    cwd: str(r['cwd']),
    providerSessionId: strOrNull(r['provider_session_id']),
    pid: numOrNull(r['pid']),
    status: str(r['status']) as SessionStatus,
    activeTurnId: strOrNull(r['active_turn_id']),
    startedAt: num(r['started_at']),
    endedAt: numOrNull(r['ended_at']),
    endReason: strOrNull(r['end_reason']) as SessionEndReason | null,
    exitCode: numOrNull(r['exit_code']),
  }
}

function toTurn(r: Row): Turn {
  return {
    id: str(r['id']),
    sessionId: str(r['session_id']),
    subtaskId: str(r['subtask_id']),
    startedAt: num(r['started_at']),
    endedAt: numOrNull(r['ended_at']),
    stopReason: strOrNull(r['stop_reason']) as StopReason | null,
    error: jsonOrNull<TurnError>(r['error_json']),
    finalText: strOrNull(r['final_text']),
  }
}

function toActivity(r: Row): ActivityEvent {
  return {
    seq: num(r['seq']),
    sessionId: str(r['session_id']),
    subtaskId: str(r['subtask_id']),
    turnId: str(r['turn_id']),
    at: num(r['at']),
    payload: json<ActivityPayload>(r['payload_json']),
  }
}

function toQuestion(r: Row): UserQuestion {
  return {
    id: str(r['id']),
    taskId: str(r['task_id']),
    subtaskId: strOrNull(r['subtask_id']),
    items: json<QuestionItem[]>(r['items_json']),
    status: str(r['status']) as UserQuestionStatus,
    answers: jsonOrNull<QuestionAnswer[]>(r['answers_json']),
    createdAt: num(r['created_at']),
    answeredAt: numOrNull(r['answered_at']),
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class SqliteTaskStore implements TaskStore {
  readonly db: Db

  constructor(db: Db) {
    this.db = db
  }

  private all<T>(sql: string, map: (r: Row) => T, ...params: unknown[]): T[] {
    return (this.db.prepare(sql).all(...params) as Row[]).map(map)
  }

  private one<T>(sql: string, map: (r: Row) => T, ...params: unknown[]): T | null {
    const row = this.db.prepare(sql).get(...params) as Row | undefined
    return row ? map(row) : null
  }

  private run(sql: string, params: Record<string, unknown>): void {
    this.db.prepare(sql).run(params)
  }

  transaction<T>(fn: () => T): T {
    if (this.db.inTransaction) return fn()
    return this.db.transaction(fn)()
  }

  appendEvent(event: DomainEvent, at: EpochMs): DomainEventEnvelope {
    const info = this.db
      .prepare('INSERT INTO events (at, type, event_json) VALUES (?, ?, ?)')
      .run(at, event.type, JSON.stringify(event))
    const revision = Number(info.lastInsertRowid)
    if (revision % EVENT_PRUNE_EVERY === 0) {
      this.db.prepare('DELETE FROM events WHERE revision <= ?').run(revision - EVENT_RETENTION)
    }
    return { revision, at, event }
  }

  /** Revisao mais alta ja gravada (0 se nenhuma). */
  latestRevision(): number {
    // sqlite_sequence guarda o maior id ja usado, mesmo depois da poda.
    const row = this.db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'events'").get() as
      Row | undefined
    return row ? num(row['seq']) : 0
  }

  // --- projects -----------------------------------------------------------

  listProjects(): Project[] {
    return this.all('SELECT * FROM projects ORDER BY created_at, id', toProject)
  }
  getProject(id: ProjectId): Project | null {
    return this.one('SELECT * FROM projects WHERE id = ?', toProject, id)
  }
  getProjectByRoot(rootPath: string): Project | null {
    return this.one('SELECT * FROM projects WHERE root_path = ?', toProject, rootPath)
  }
  insertProject(p: Project): void {
    this.run(
      `INSERT INTO projects (id, name, root_path, created_at, updated_at)
       VALUES (@id, @name, @rootPath, @createdAt, @updatedAt)`,
      { ...p },
    )
  }
  updateProject(p: Project): void {
    this.run(
      `UPDATE projects SET name = @name, root_path = @rootPath, updated_at = @updatedAt
       WHERE id = @id`,
      { ...p },
    )
  }
  deleteProject(id: ProjectId): void {
    // Ordem explicita: filhos antes dos pais, para nao depender da ordem do cascade.
    this.transaction(() => {
      const taskIds = `(SELECT id FROM tasks WHERE project_id = @id)`
      for (const table of ['activity', 'artifacts', 'messages', 'turns']) {
        this.run(
          `DELETE FROM ${table} WHERE subtask_id IN (SELECT id FROM subtasks WHERE task_id IN ${taskIds})`,
          { id },
        )
      }
      this.run(`DELETE FROM questions WHERE task_id IN ${taskIds}`, { id })
      this.run(`DELETE FROM sessions WHERE task_id IN ${taskIds}`, { id })
      this.run(`DELETE FROM subtasks WHERE task_id IN ${taskIds}`, { id })
      this.run(`DELETE FROM tasks WHERE project_id = @id`, { id })
      this.run(`DELETE FROM roles WHERE project_id = @id`, { id })
      this.run(`DELETE FROM projects WHERE id = @id`, { id })
    })
  }

  // --- roles --------------------------------------------------------------

  listRoles(projectId: ProjectId): Role[] {
    return this.all(
      'SELECT * FROM roles WHERE project_id = ? AND deleted_at IS NULL ORDER BY is_lead DESC, created_at, id',
      toRole,
      projectId,
    )
  }
  /** Inclui papeis apagados: o historico de subtarefas ainda aponta para eles. */
  getRole(id: RoleId): Role | null {
    return this.one('SELECT * FROM roles WHERE id = ?', toRole, id)
  }
  isRoleDeleted(id: RoleId): boolean {
    const row = this.db.prepare('SELECT deleted_at FROM roles WHERE id = ?').get(id) as
      Row | undefined
    return row !== undefined && row['deleted_at'] !== null
  }
  insertRole(r: Role): void {
    this.run(
      `INSERT INTO roles (id, project_id, name, name_key, description, provider, model,
         prompt_template, is_lead, created_at, updated_at, deleted_at)
       VALUES (@id, @projectId, @name, @nameKey, @description, @provider, @model,
         @promptTemplate, @isLead, @createdAt, @updatedAt, NULL)`,
      { ...r, nameKey: roleNameKey(r.name), isLead: r.isLead ? 1 : 0 },
    )
  }
  updateRole(r: Role): void {
    this.run(
      `UPDATE roles SET name = @name, name_key = @nameKey, description = @description,
         provider = @provider, model = @model, prompt_template = @promptTemplate,
         is_lead = @isLead, updated_at = @updatedAt
       WHERE id = @id`,
      { ...r, nameKey: roleNameKey(r.name), isLead: r.isLead ? 1 : 0 },
    )
  }
  /** Apagar e logico: subtarefas antigas continuam apontando para o papel. */
  deleteRole(id: RoleId): void {
    this.run(`UPDATE roles SET deleted_at = @now, is_lead = 0 WHERE id = @id`, {
      id,
      now: Date.now(),
    })
  }

  // --- tasks --------------------------------------------------------------

  listTasks(projectId: ProjectId, options: { includeArchived: boolean }): Task[] {
    return this.all(
      `SELECT * FROM tasks WHERE project_id = ? ${options.includeArchived ? '' : "AND status = 'open'"}
       ORDER BY created_at, id`,
      toTask,
      projectId,
    )
  }
  getTask(id: TaskId): Task | null {
    return this.one('SELECT * FROM tasks WHERE id = ?', toTask, id)
  }
  insertTask(t: Task): void {
    this.run(
      `INSERT INTO tasks (id, project_id, context_id, title, kind, worktree_path, branch,
         base_branch, lead_role_id, solo_provider, status, workflow_status, created_at, updated_at,
         archived_at)
       VALUES (@id, @projectId, @contextId, @title, @kind, @worktreePath, @branch,
         @baseBranch, @leadRoleId, @soloProvider, @status, @workflowStatus, @createdAt, @updatedAt,
         @archivedAt)`,
      { ...t },
    )
  }
  updateTask(t: Task): void {
    this.run(
      `UPDATE tasks SET title = @title, worktree_path = @worktreePath, branch = @branch,
         base_branch = @baseBranch, lead_role_id = @leadRoleId, solo_provider = @soloProvider,
         status = @status, workflow_status = @workflowStatus, updated_at = @updatedAt,
         archived_at = @archivedAt
       WHERE id = @id`,
      { ...t },
    )
  }

  // --- subtasks -----------------------------------------------------------

  listSubtasks(taskId: TaskId): Subtask[] {
    return this.all(
      'SELECT * FROM subtasks WHERE task_id = ? ORDER BY created_at, rowid',
      toSubtask,
      taskId,
    )
  }
  /** Subtarefas nao finais de todas as tarefas abertas (recuperacao no boot). */
  listUnfinishedSubtasks(): Subtask[] {
    return this.all(
      `SELECT s.* FROM subtasks s JOIN tasks t ON t.id = s.task_id
       WHERE s.state NOT IN ('completed', 'failed', 'canceled')
       ORDER BY s.created_at, s.rowid`,
      toSubtask,
    )
  }
  getSubtask(id: SubtaskId): Subtask | null {
    return this.one('SELECT * FROM subtasks WHERE id = ?', toSubtask, id)
  }
  insertSubtask(s: Subtask): void {
    this.run(
      `INSERT INTO subtasks (id, task_id, role_id, title, instructions, state, status_message,
         failure_code, reference_task_ids, session_id, created_at, updated_at, finished_at)
       VALUES (@id, @taskId, @roleId, @title, @instructions, @state, @statusMessage,
         @failureCode, @referenceTaskIds, @sessionId, @createdAt, @updatedAt, @finishedAt)`,
      { ...s, referenceTaskIds: JSON.stringify(s.referenceTaskIds) },
    )
  }
  updateSubtask(s: Subtask): void {
    this.run(
      `UPDATE subtasks SET state = @state, status_message = @statusMessage,
         failure_code = @failureCode, session_id = @sessionId, updated_at = @updatedAt,
         finished_at = @finishedAt
       WHERE id = @id`,
      { ...s },
    )
  }

  // --- messages -----------------------------------------------------------

  listMessages(subtaskId: SubtaskId): Message[] {
    return this.all(
      'SELECT * FROM messages WHERE subtask_id = ? ORDER BY seq',
      toMessage,
      subtaskId,
    )
  }
  insertMessage(m: Message): void {
    this.run(
      `INSERT INTO messages (id, task_id, subtask_id, author, parts_json, turn_id, created_at, seq)
       VALUES (@id, @taskId, @subtaskId, @author, @parts, @turnId, @createdAt,
         (SELECT COALESCE(MAX(seq), 0) + 1 FROM messages WHERE subtask_id = @subtaskId))`,
      { ...m, parts: JSON.stringify(m.parts) },
    )
  }

  // --- artifacts ----------------------------------------------------------

  listArtifacts(subtaskId: SubtaskId): Artifact[] {
    return this.all(
      'SELECT * FROM artifacts WHERE subtask_id = ? ORDER BY seq',
      toArtifact,
      subtaskId,
    )
  }
  listArtifactsForTurn(turnId: TurnId): Artifact[] {
    return this.all('SELECT * FROM artifacts WHERE turn_id = ? ORDER BY seq', toArtifact, turnId)
  }
  insertArtifact(a: Artifact): void {
    this.run(
      `INSERT INTO artifacts (id, task_id, subtask_id, session_id, turn_id, format,
         delivery_json, parts_json, created_at, seq)
       VALUES (@id, @taskId, @subtaskId, @sessionId, @turnId, @format, @delivery, @parts,
         @createdAt, (SELECT COALESCE(MAX(seq), 0) + 1 FROM artifacts WHERE subtask_id = @subtaskId))`,
      { ...a, delivery: JSON.stringify(a.delivery), parts: JSON.stringify(a.parts) },
    )
  }

  // --- sessions -----------------------------------------------------------

  getSession(id: SessionId): Session | null {
    return this.one('SELECT * FROM sessions WHERE id = ?', toSession, id)
  }
  listSessions(taskId: TaskId): Session[] {
    return this.all(
      'SELECT * FROM sessions WHERE task_id = ? ORDER BY started_at, rowid',
      toSession,
      taskId,
    )
  }
  listOpenSessions(): Session[] {
    return this.all(
      "SELECT * FROM sessions WHERE status <> 'exited' ORDER BY started_at, rowid",
      toSession,
    )
  }
  insertSession(s: Session): void {
    this.run(
      `INSERT INTO sessions (id, task_id, subtask_id, role_id, kind, provider, model, cwd,
         provider_session_id, pid, status, active_turn_id, started_at, ended_at, end_reason, exit_code)
       VALUES (@id, @taskId, @subtaskId, @roleId, @kind, @provider, @model, @cwd,
         @providerSessionId, @pid, @status, @activeTurnId, @startedAt, @endedAt, @endReason, @exitCode)`,
      { ...s },
    )
  }
  updateSession(s: Session): void {
    this.run(
      `UPDATE sessions SET provider_session_id = @providerSessionId, pid = @pid, status = @status,
         active_turn_id = @activeTurnId, ended_at = @endedAt, end_reason = @endReason,
         exit_code = @exitCode
       WHERE id = @id`,
      { ...s },
    )
  }

  // --- turns --------------------------------------------------------------

  getTurn(id: TurnId): Turn | null {
    return this.one('SELECT * FROM turns WHERE id = ?', toTurn, id)
  }
  listTurns(subtaskId: SubtaskId): Turn[] {
    return this.all(
      'SELECT * FROM turns WHERE subtask_id = ? ORDER BY started_at, rowid',
      toTurn,
      subtaskId,
    )
  }
  insertTurn(t: Turn): void {
    this.run(
      `INSERT INTO turns (id, session_id, subtask_id, started_at, ended_at, stop_reason,
         error_json, final_text)
       VALUES (@id, @sessionId, @subtaskId, @startedAt, @endedAt, @stopReason, @error, @finalText)`,
      { ...t, error: t.error ? JSON.stringify(t.error) : null },
    )
  }
  updateTurn(t: Turn): void {
    this.run(
      `UPDATE turns SET ended_at = @endedAt, stop_reason = @stopReason, error_json = @error,
         final_text = @finalText
       WHERE id = @id`,
      { ...t, error: t.error ? JSON.stringify(t.error) : null },
    )
  }

  // --- activity -----------------------------------------------------------

  appendActivity(drafts: ActivityEventDraft[]): ActivityEvent[] {
    return this.transaction(() => {
      const nextSeq = this.db.prepare(
        'SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM activity WHERE session_id = ?',
      )
      const insert = this.db.prepare(
        `INSERT INTO activity (session_id, seq, subtask_id, turn_id, at, payload_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      return drafts.map((d) => {
        const seq = num((nextSeq.get(d.sessionId) as Row)['next'])
        insert.run(d.sessionId, seq, d.subtaskId, d.turnId, d.at, JSON.stringify(d.payload))
        return { ...d, seq }
      })
    })
  }
  listActivity(subtaskId: SubtaskId, afterSeq: number | null, limit: number): ActivityPage {
    const rows = this.all(
      `SELECT * FROM activity WHERE subtask_id = ? AND seq > ? ORDER BY seq, rowid LIMIT ?`,
      toActivity,
      subtaskId,
      afterSeq ?? 0,
      limit + 1,
    )
    const hasMore = rows.length > limit
    const events = hasMore ? rows.slice(0, limit) : rows
    return { events, lastSeq: events.at(-1)?.seq ?? null, hasMore }
  }
  listTurnActivity(turnId: TurnId): ActivityEvent[] {
    return this.all('SELECT * FROM activity WHERE turn_id = ? ORDER BY seq', toActivity, turnId)
  }

  // --- questions ----------------------------------------------------------

  listOpenQuestions(projectId: ProjectId): UserQuestion[] {
    return this.all(
      `SELECT q.* FROM questions q JOIN tasks t ON t.id = q.task_id
       WHERE t.project_id = ? AND q.status = 'open' ORDER BY q.created_at, q.rowid`,
      toQuestion,
      projectId,
    )
  }
  listOpenTaskQuestions(taskId: TaskId): UserQuestion[] {
    return this.all(
      "SELECT * FROM questions WHERE task_id = ? AND status = 'open' ORDER BY created_at, rowid",
      toQuestion,
      taskId,
    )
  }
  countOpenQuestions(taskId: TaskId): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM questions WHERE task_id = ? AND status = 'open'")
      .get(taskId) as { n: number }
    return row.n
  }
  getQuestion(id: QuestionId): UserQuestion | null {
    return this.one('SELECT * FROM questions WHERE id = ?', toQuestion, id)
  }
  insertQuestion(q: UserQuestion): void {
    this.run(
      `INSERT INTO questions (id, task_id, subtask_id, items_json, status, answers_json,
         created_at, answered_at)
       VALUES (@id, @taskId, @subtaskId, @items, @status, @answers, @createdAt, @answeredAt)`,
      {
        ...q,
        items: JSON.stringify(q.items),
        answers: q.answers ? JSON.stringify(q.answers) : null,
      },
    )
  }
  updateQuestion(q: UserQuestion): void {
    this.run(
      `UPDATE questions SET status = @status, answers_json = @answers, answered_at = @answeredAt
       WHERE id = @id`,
      { ...q, answers: q.answers ? JSON.stringify(q.answers) : null },
    )
  }

  // --- avisos ao Lider -----------------------------------------------------

  insertLeaderNotice(taskId: TaskId, text: string, createdAt: EpochMs): LeaderNotice {
    const info = this.db
      .prepare('INSERT INTO leader_notices (task_id, text, created_at) VALUES (?, ?, ?)')
      .run(taskId, text, createdAt)
    return { id: Number(info.lastInsertRowid), taskId, text, createdAt }
  }
  listPendingLeaderNotices(taskId: TaskId, limit = -1): LeaderNotice[] {
    return this.all(
      `SELECT * FROM leader_notices WHERE task_id = ? AND delivered_at IS NULL
       ORDER BY id LIMIT ?`,
      toLeaderNotice,
      taskId,
      limit,
    )
  }
  countPendingLeaderNotices(taskId: TaskId): number {
    const row = this.db
      .prepare(
        'SELECT COUNT(*) AS n FROM leader_notices WHERE task_id = ? AND delivered_at IS NULL',
      )
      .get(taskId) as { n: number }
    return row.n
  }
  markLeaderNoticeDelivered(id: number, at: EpochMs): void {
    this.db
      .prepare('UPDATE leader_notices SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL')
      .run(at, id)
  }
  listTasksWithPendingLeaderNotices(): TaskId[] {
    return (
      this.db
        .prepare(
          `SELECT DISTINCT n.task_id AS id FROM leader_notices n JOIN tasks t ON t.id = n.task_id
           WHERE n.delivered_at IS NULL AND t.status = 'open' ORDER BY n.task_id`,
        )
        .all() as { id: string }[]
    ).map((row) => row.id)
  }

  close(): void {
    if (this.db.open) this.db.close()
  }
}

function toLeaderNotice(row: Row): LeaderNotice {
  return {
    id: Number(row['id']),
    taskId: String(row['task_id']),
    text: String(row['text']),
    createdAt: Number(row['created_at']),
  }
}
