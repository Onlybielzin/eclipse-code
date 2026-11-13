import type Database from 'better-sqlite3'
import type { TaskDecisionRecord } from '../../../../shared/contracts/canvasCards'
import type { TaskDecisionLog } from '../../application/canvasCards/canvasCardUseCases'

/** Answered questions outlive their cards; deliberately no foreign keys (nodes are deleted). */
export function ensureTaskDecisionSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_decisions (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL,
      space_id TEXT,
      question_node_id TEXT NOT NULL,
      asked_by_node_id TEXT,
      asked_by_title TEXT NOT NULL,
      question TEXT NOT NULL,
      answer TEXT NOT NULL,
      answered_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS task_decisions_space_idx ON task_decisions(space_id, answered_at);
    CREATE INDEX IF NOT EXISTS task_decisions_project_idx ON task_decisions(project_id, answered_at);
  `)
}

const COLUMNS = `id, project_id AS projectId, space_id AS spaceId, question_node_id AS questionNodeId,
  asked_by_node_id AS askedByNodeId, asked_by_title AS askedByTitle, question, answer,
  answered_at AS answeredAt`

export function createSqliteTaskDecisionLog(db: Database.Database): TaskDecisionLog {
  return {
    append: async record => {
      db.prepare(
        `INSERT OR IGNORE INTO task_decisions (id, project_id, space_id, question_node_id,
          asked_by_node_id, asked_by_title, question, answer, answered_at)
         VALUES (@id, @projectId, @spaceId, @questionNodeId, @askedByNodeId, @askedByTitle,
          @question, @answer, @answeredAt)`,
      ).run(record)
    },
    list: async ({ projectId, spaceId, limit }) => {
      const where: string[] = []
      const params: Record<string, unknown> = { limit }
      if (spaceId) {
        where.push('space_id = @spaceId')
        params.spaceId = spaceId
      }
      if (projectId) {
        where.push('project_id = @projectId')
        params.projectId = projectId
      }
      return db
        .prepare(
          `SELECT ${COLUMNS} FROM task_decisions ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
           ORDER BY answered_at DESC LIMIT @limit`,
        )
        .all(params) as TaskDecisionRecord[]
    },
  }
}
