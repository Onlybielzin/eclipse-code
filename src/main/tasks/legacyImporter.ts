/**
 * Importa projetos e papeis do app antigo (~/.config/eclipse-code/eclipse-code.db).
 *
 * O banco antigo e aberto SOMENTE LEITURA (readonly + fileMustExist + query_only):
 * nada aqui escreve nele. Le:
 *   - workspaces (id, name, path)
 *   - app_settings.value -> projectRolesByWorkspaceId: { [workspaceId]: RoleDef[] }
 *
 * Regras da importacao (idempotente):
 *   - projeto casa pelo caminho da raiz (sem barra no fim); se nao existe, e criado.
 *   - papel com o mesmo nome (sem acento/maiuscula) e pulado; nada e sobrescrito.
 *   - o Lider antigo so vira Lider se o projeto ainda nao tem Lider.
 *   - provider 'claude-code'/'claude' -> 'claude'; 'codex' -> 'codex'; outro e pulado.
 */
import Database from 'better-sqlite3'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Project, Provider, Role } from '@shared/domain'
import type { SqliteTaskService } from './taskService'

export const LEGACY_DATABASE_PATH = join(homedir(), '.config', 'eclipse-code', 'eclipse-code.db')

export interface LegacyRole {
  legacyId: string
  name: string
  description: string
  promptTemplate: string
  provider: Provider
  model: string | null
  isLead: boolean
}

export interface LegacyProject {
  legacyId: string
  name: string
  rootPath: string
  roles: LegacyRole[]
  /** Papeis que nao deu para ler (provider desconhecido, campo faltando). */
  skippedRoles: { name: string; reason: string }[]
}

function normalizeRoot(path: string): string {
  const resolved = resolve(path.trim())
  return resolved.length > 1 ? resolved.replace(/\/+$/, '') : resolved
}

function mapProvider(value: unknown): Provider | null {
  if (value === 'claude-code' || value === 'claude') return 'claude'
  if (value === 'codex') return 'codex'
  return null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/** Le o banco antigo sem escrever nele. Banco ausente devolve []. */
export function readLegacyProjects(dbPath: string = LEGACY_DATABASE_PATH): LegacyProject[] {
  if (!existsSync(dbPath)) return []
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    db.pragma('query_only = ON')
    const hasTable = (name: string): boolean =>
      db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !==
      undefined
    if (!hasTable('workspaces') || !hasTable('app_settings')) return []

    const workspaces = db
      .prepare('SELECT id, name, path FROM workspaces ORDER BY sort_order, rowid')
      .all() as {
      id: string
      name: string
      path: string
    }[]
    const settingsRow = db.prepare('SELECT value FROM app_settings WHERE id = 1').get() as
      { value: string } | undefined
    let rolesByWorkspace: Record<string, unknown> = {}
    if (settingsRow) {
      try {
        const settings = JSON.parse(settingsRow.value) as Record<string, unknown>
        const raw = settings['projectRolesByWorkspaceId']
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
          rolesByWorkspace = raw as Record<string, unknown>
        }
      } catch {
        rolesByWorkspace = {}
      }
    }

    return workspaces.map((ws) => {
      const roles: LegacyRole[] = []
      const skippedRoles: LegacyProject['skippedRoles'] = []
      const list = rolesByWorkspace[ws.id]
      for (const entry of Array.isArray(list) ? list : []) {
        if (!entry || typeof entry !== 'object') continue
        const r = entry as Record<string, unknown>
        const name = asString(r['name'])?.trim()
        if (!name) {
          skippedRoles.push({ name: '(sem nome)', reason: 'papel sem nome' })
          continue
        }
        const provider = mapProvider(r['provider'])
        if (!provider) {
          skippedRoles.push({ name, reason: `provedor não suportado: ${String(r['provider'])}` })
          continue
        }
        const model = asString(r['model'])?.trim()
        roles.push({
          legacyId: asString(r['id']) ?? name,
          name,
          description: asString(r['description']) ?? '',
          promptTemplate: asString(r['promptTemplate']) ?? '',
          provider,
          model: model ? model : null,
          isLead: r['isLead'] === true,
        })
      }
      return {
        legacyId: ws.id,
        name: ws.name,
        rootPath: normalizeRoot(ws.path),
        roles,
        skippedRoles,
      }
    })
  } finally {
    db.close()
  }
}

export interface LegacyImportReport {
  projectsCreated: Project[]
  projectsMatched: Project[]
  rolesCreated: Role[]
  rolesSkipped: { project: string; name: string; reason: string }[]
}

/** Grava no app novo o que foi lido. Cada projeto e uma escrita do TaskService. */
export function importLegacyProjects(
  service: SqliteTaskService,
  legacy: readonly LegacyProject[],
): LegacyImportReport {
  const report: LegacyImportReport = {
    projectsCreated: [],
    projectsMatched: [],
    rolesCreated: [],
    rolesSkipped: [],
  }
  for (const lp of legacy) {
    let project = service.getProjectByRoot(lp.rootPath)
    if (project) report.projectsMatched.push(project)
    else {
      project = service.addProject({ rootPath: lp.rootPath, name: lp.name })
      report.projectsCreated.push(project)
    }
    for (const skipped of lp.skippedRoles) {
      report.rolesSkipped.push({ project: lp.name, ...skipped })
    }
    // Lider primeiro, para a regra "so vira Lider se nao ha Lider" valer na ordem certa.
    const ordered = [...lp.roles].sort((a, b) => Number(b.isLead) - Number(a.isLead))
    for (const role of ordered) {
      if (service.findRoleByName(project.id, role.name)) {
        report.rolesSkipped.push({ project: lp.name, name: role.name, reason: 'já existe' })
        continue
      }
      const isLead = role.isLead && service.getLeadRole(project.id) === null
      report.rolesCreated.push(
        service.saveRole({
          projectId: project.id,
          name: role.name,
          description: role.description,
          provider: role.provider,
          model: role.model,
          promptTemplate: role.promptTemplate,
          isLead,
        }),
      )
    }
  }
  return report
}
