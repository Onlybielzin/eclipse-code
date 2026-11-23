// Descricao da tarefa: migracao 12 em banco antigo e createTask gravando/lendo.
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { MIGRATIONS } from './migrations'
import { migrate, SqliteTaskStore } from './sqliteTaskStore'
import { createHarness, seedTeam } from './testing'

describe('descrição da tarefa', () => {
  it('banco antigo ganha a coluna description com ""', () => {
    const db = new Database(':memory:')
    for (const m of MIGRATIONS.filter((x) => x.version <= 11)) db.exec(m.sql)
    db.pragma('user_version = 11')
    db.exec(`
      INSERT INTO projects VALUES ('p', 'p', '/p', 1, 1);
      INSERT INTO tasks (id, project_id, context_id, title, name, kind, status, created_at, updated_at)
        VALUES ('t', 'p', 'c1', 'A', 'A', 'solo', 'open', 1, 1);
    `)
    expect(migrate(db)).toBeGreaterThanOrEqual(12)
    expect(new SqliteTaskStore(db).getTask('t')?.description).toBe('')
  })

  it('createTask grava a descrição e a leitura devolve; sem descrição fica ""', () => {
    const h = createHarness()
    const fx = seedTeam(h.service)
    const base = {
      projectId: fx.project.id,
      kind: 'team' as const,
      worktreePath: null,
      branch: null,
      baseBranch: null,
      leadRoleId: null,
      soloProvider: null,
    }
    const com = h.service.createTask({ ...base, title: 'A', description: 'linha 1\nlinha 2' })
    const sem = h.service.createTask({ ...base, title: 'B' })
    expect(h.service.getTask(com.id)?.description).toBe('linha 1\nlinha 2')
    expect(h.service.getTask(sem.id)?.description).toBe('')
  })
})
