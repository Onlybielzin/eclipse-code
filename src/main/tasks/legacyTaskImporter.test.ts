import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { importLegacyTasks, mapLegacyQuestionItems, readLegacyTasks } from './legacyTaskImporter'
import { createHarness } from './testing'

let dir: string
let legacyPath: string
const hash = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex')

const question = {
  id: 'q1',
  header: 'Main',
  question: 'Posso subir para a main?',
  context: 'Guia v2 pronto.',
  options: [
    { label: 'Subir agora', detail: 'Sobe 6 arquivos.', recommended: false },
    { label: 'Esperar', detail: 'Nada sobe.', recommended: true },
  ],
  multiSelect: false,
  allowOther: true,
}

function buildLegacyDb(path: string): void {
  const db = new Database(path)
  db.exec(`
    CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT, path TEXT);
    CREATE TABLE workspace_spaces (id TEXT PRIMARY KEY, workspace_id TEXT, name TEXT,
      directory_path TEXT, parent_space_id TEXT);
    CREATE TABLE nodes (id TEXT PRIMARY KEY, kind TEXT, agent_json TEXT, task_json TEXT,
      started_at TEXT);
    CREATE TABLE workspace_space_nodes (space_id TEXT, node_id TEXT);
  `)
  db.prepare('INSERT INTO workspaces VALUES (?, ?, ?)').run('ws1', 'ereemby', '/repo/ereemby/')
  const space = db.prepare('INSERT INTO workspace_spaces VALUES (?, ?, ?, ?, ?)')
  space.run('s1', 'ws1', 'feat-orfer-e-up', '/repo/ereemby/.wt/feat-orfer', null)
  space.run('s2', 'ws1', 'feat-sumiu', '/repo/ereemby/.wt/feat-sumiu', null)
  space.run('s3', 'ws1', 'feat-sem-lider', '/repo/ereemby/.wt/feat-sem-lider', null)
  const node = db.prepare('INSERT INTO nodes VALUES (?, ?, ?, ?, ?)')
  const link = db.prepare('INSERT INTO workspace_space_nodes VALUES (?, ?)')
  node.run(
    'lead',
    'agent',
    JSON.stringify({
      provider: 'claude-code',
      prompt: 'Você é o LÍDER do time',
      model: 'claude-opus-5-5',
      resumeSessionId: 'conv-123',
    }),
    null,
    null,
  )
  node.run(
    'rev',
    'agent',
    JSON.stringify({ provider: 'codex', prompt: 'Revisor', resumeSessionId: 'x' }),
    null,
    null,
  )
  node.run(
    'q',
    'question',
    null,
    JSON.stringify({ status: 'pending', questions: [question] }),
    null,
  )
  node.run(
    'q-old',
    'question',
    null,
    JSON.stringify({ status: 'answered', questions: [question] }),
    null,
  )
  for (const id of ['lead', 'rev', 'q', 'q-old']) link.run('s1', id)
  db.close()
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'legacy-tasks-'))
  legacyPath = join(dir, 'eclipse-code.db')
  buildLegacyDb(legacyPath)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('importação das tarefas do app antigo', () => {
  it('lê sem escrever: Líder Claude com conversa, só perguntas pendentes', () => {
    const before = hash(legacyPath)
    const tasks = readLegacyTasks(legacyPath)
    expect(hash(legacyPath)).toBe(before)
    const orfer = tasks.find((t) => t.title === 'feat-orfer-e-up')!
    expect(orfer.projectRoot).toBe('/repo/ereemby')
    expect(orfer.leader).toEqual({ providerSessionId: 'conv-123', model: 'claude-opus-5-5' })
    expect(orfer.questions).toHaveLength(1)
  })

  it('cria a tarefa na mesma worktree, Líder para retomar e pergunta aberta; é idempotente', () => {
    const { service } = createHarness()
    const project = service.addProject({ rootPath: '/repo/ereemby' })
    service.saveRole({
      projectId: project.id,
      roleId: service.findRoleByName(project.id, 'Líder')?.id,
      name: 'Líder',
      description: '',
      provider: 'claude',
      model: 'claude-opus-5-5',
      promptTemplate: 'lidere',
      isLead: true,
    })
    const exists = (p: string) => !p.endsWith('feat-sumiu')
    const deps = { exists, branchOf: () => 'feat/orfer' }
    const report = importLegacyTasks(service, readLegacyTasks(legacyPath), deps)

    expect(report.imported.map((i) => i.task.title).sort()).toEqual([
      'feat-orfer-e-up',
      'feat-sem-lider',
    ])
    expect(report.skipped).toEqual([{ title: 'feat-sumiu', reason: 'worktree não existe mais' }])

    const orfer = report.imported.find((i) => i.task.title === 'feat-orfer-e-up')!.task
    expect(orfer.worktreePath).toBe('/repo/ereemby/.wt/feat-orfer')
    expect(orfer.branch).toBe('feat/orfer')
    expect(orfer.workflowStatus).toBe('pergunta')
    const leader = service.getLatestLeaderSession(orfer.id)!
    expect(leader.providerSessionId).toBe('conv-123')
    expect(leader.status).not.toBe('exited')
    const open = service.listOpenQuestions(project.id)
    expect(open).toHaveLength(1)
    expect(open[0]!.items[0]!.prompt).toContain('Main: Posso subir para a main?')
    expect(open[0]!.items[0]!.options[1]!.label).toBe('Esperar (recomendada)')

    const semLider = report.imported.find((i) => i.task.title === 'feat-sem-lider')!
    expect(semLider.resumes).toBe(false)
    expect(semLider.task.workflowStatus).toBe('em_andamento')

    const again = importLegacyTasks(service, readLegacyTasks(legacyPath), deps)
    expect(again.imported).toHaveLength(0)
    expect(service.listTasks(project.id, { includeArchived: true })).toHaveLength(2)
  })

  it('projeto inexistente no app novo é pulado com motivo', () => {
    const { service } = createHarness()
    const report = importLegacyTasks(service, readLegacyTasks(legacyPath), {
      exists: () => true,
      branchOf: () => null,
    })
    expect(report.imported).toHaveLength(0)
    expect(report.skipped[0]!.reason).toContain('sem projeto')
  })

  it('mapeia o card antigo para itens do app novo', () => {
    const items = mapLegacyQuestionItems([question, { nada: 1 }])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ id: 'q1', multiSelect: false, allowFreeText: true })
    expect(items[0]!.options.map((o) => o.id)).toEqual(['o1', 'o2'])
  })
})
