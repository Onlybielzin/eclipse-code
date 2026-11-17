import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultAccessFor } from './defaultRoles'
import { LEGACY_DATABASE_PATH, importLegacyProjects, readLegacyProjects } from './legacyImporter'
import { createHarness } from './testing'

let dir: string
let legacyPath: string

const hash = (p: string): string => createHash('sha256').update(readFileSync(p)).digest('hex')

function buildLegacyDb(path: string): void {
  const db = new Database(path)
  db.exec(`
    CREATE TABLE app_settings (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL);
    CREATE TABLE workspaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0);
  `)
  db.prepare('INSERT INTO workspaces (id, name, path, sort_order) VALUES (?, ?, ?, ?)').run(
    'ws1',
    'ereemby',
    '/home/u/ereemby/',
    0,
  )
  db.prepare('INSERT INTO workspaces (id, name, path, sort_order) VALUES (?, ?, ?, ?)').run(
    'ws2',
    'sem-papeis',
    '/home/u/vazio',
    1,
  )
  const role = (name: string, provider: string, isLead: boolean, model: string | null = 'm') => ({
    id: `id-${name}`,
    name,
    description: `desc ${name}`,
    promptTemplate: `prompt ${name}`,
    inputHint: '',
    outputFormat: '',
    provider,
    model,
    isLead,
    createdAt: '2026-11-12T00:57:50.000Z',
    updatedAt: '2026-11-12T00:57:50.000Z',
  })
  db.prepare('INSERT INTO app_settings (id, value) VALUES (1, ?)').run(
    JSON.stringify({
      language: 'en',
      projectRolesByWorkspaceId: {
        ws1: [
          role('Dev 1', 'claude-code', false, 'claude-sonnet-5-5'),
          role('Líder', 'claude-code', true, 'claude-opus-5-5'),
          role('Revisor', 'codex', false, 'gpt-6.1-sol'),
          role('Gemini', 'gemini-cli', false),
          role('Sem modelo', 'codex', false, ''),
        ],
      },
    }),
  )
  db.close()
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'eclipse-next-legacy-'))
  legacyPath = join(dir, 'eclipse-code.db')
  buildLegacyDb(legacyPath)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('importador do app antigo', () => {
  it('lê projetos e papéis sem tocar no arquivo', () => {
    const before = hash(legacyPath)
    const projects = readLegacyProjects(legacyPath)
    expect(hash(legacyPath)).toBe(before)
    expect(existsSync(`${legacyPath}-wal`)).toBe(false)
    expect(projects).toHaveLength(2)
    const [ereemby, vazio] = projects
    expect(ereemby).toMatchObject({ name: 'ereemby', rootPath: '/home/u/ereemby' })
    expect(ereemby?.roles.map((r) => [r.name, r.provider, r.model, r.isLead])).toEqual([
      ['Dev 1', 'claude', 'claude-sonnet-5-5', false],
      ['Líder', 'claude', 'claude-opus-5-5', true],
      ['Revisor', 'codex', 'gpt-6.1-sol', false],
      ['Sem modelo', 'codex', null, false],
    ])
    expect(ereemby?.skippedRoles).toEqual([
      { name: 'Gemini', reason: 'provedor não suportado: gemini-cli' },
    ])
    expect(vazio?.roles).toEqual([])
  })

  it('a conexão de leitura não consegue escrever', () => {
    const db = new Database(legacyPath, { readonly: true, fileMustExist: true })
    expect(() => db.prepare("UPDATE workspaces SET name = 'x'").run()).toThrow(/readonly/i)
    db.close()
  })

  it('banco ausente devolve lista vazia', () => {
    expect(readLegacyProjects(join(dir, 'nao-existe.db'))).toEqual([])
    expect(existsSync(join(dir, 'nao-existe.db'))).toBe(false)
  })

  it('importa uma vez; rodar de novo não duplica nem troca o Líder', () => {
    const { service } = createHarness()
    const legacy = readLegacyProjects(legacyPath)
    const first = importLegacyProjects(service, legacy)
    expect(first.projectsCreated.map((p) => p.rootPath)).toEqual([
      '/home/u/ereemby',
      '/home/u/vazio',
    ])
    expect(first.rolesCreated).toHaveLength(4)
    const project = first.projectsCreated[0]!
    expect(service.getLeadRole(project.id)?.name).toBe('Líder')
    expect(first.rolesSkipped).toEqual([
      { project: 'ereemby', name: 'Gemini', reason: 'provedor não suportado: gemini-cli' },
    ])

    const second = importLegacyProjects(service, legacy)
    expect(second.projectsCreated).toEqual([])
    expect(second.projectsMatched).toHaveLength(2)
    expect(second.rolesCreated).toEqual([])
    expect(service.listRoles(project.id)).toHaveLength(4)
  })

  it('papel importado recebe o acesso padrão pelo nome, como a migração 8', () => {
    const { service } = createHarness()
    const report = importLegacyProjects(service, readLegacyProjects(legacyPath))
    const access = Object.fromEntries(report.rolesCreated.map((r) => [r.name, r.access]))
    expect(access).toMatchObject({ Líder: 'full', Revisor: 'read_only', 'Sem modelo': 'full' })
    expect(defaultAccessFor('Dev', false)).toBe('no_commit')
    expect(defaultAccessFor(' DEV ', false)).toBe('no_commit')
    expect(defaultAccessFor('Dev', true)).toBe('full')
    expect(defaultAccessFor('Dev 1', false)).toBe('full')
  })

  it('projeto que já tem Líder recebe o Líder antigo como papel comum', () => {
    const { service } = createHarness()
    const p = service.addProject({ rootPath: '/home/u/ereemby' })
    service.saveRole({
      projectId: p.id,
      name: 'Chefe',
      description: '',
      provider: 'codex',
      model: null,
      promptTemplate: '',
      isLead: true,
      access: 'full',
    })
    const report = importLegacyProjects(service, readLegacyProjects(legacyPath))
    expect(report.projectsMatched.map((x) => x.id)).toEqual([p.id])
    expect(service.getLeadRole(p.id)?.name).toBe('Chefe')
    expect(service.findRoleByName(p.id, 'lider')?.isLead).toBe(false)
  })

  // Só roda com ECLIPSE_LEGACY_SMOKE=1: lê o banco real do app antigo, sem escrever.
  it.runIf(process.env['ECLIPSE_LEGACY_SMOKE'] === '1' && existsSync(LEGACY_DATABASE_PATH))(
    'lê o banco real do app antigo em modo somente leitura',
    () => {
      const projects = readLegacyProjects()
      expect(projects.length).toBeGreaterThan(0)
      const { service } = createHarness()
      const report = importLegacyProjects(service, projects)
      console.log(
        'projetos:',
        report.projectsCreated.map((p) => `${p.name} (${service.listRoles(p.id).length} papéis)`),
        'pulados:',
        report.rolesSkipped,
      )
    },
  )
})
