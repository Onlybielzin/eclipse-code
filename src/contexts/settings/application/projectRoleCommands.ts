import type { AgentProvider } from '../domain/agentSettings.providers'
import {
  normalizeProjectRoles,
  normalizeProjectRolesByWorkspaceId,
  type ProjectRoleDefinition,
} from '../domain/projectRoles'

/**
 * Project roles edited from outside the shell (CLI, scripts). Pure plans over the persisted
 * settings object: the Worker commits the result with compare-and-swap, and every open shell
 * converges on it through the normal sync refresh, so no restart is needed.
 */

export interface ProjectRolePatch {
  /** Role name; the key (case-insensitive) that decides create vs update. */
  name: string
  promptTemplate?: string
  description?: string
  provider?: AgentProvider | null
  model?: string
  isLead?: boolean
  inputHint?: string
  outputFormat?: string
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

const nameKey = (name: string) => name.trim().toLowerCase()

export function listProjectRoles(settings: unknown, projectId: string): ProjectRoleDefinition[] {
  const byProject = normalizeProjectRolesByWorkspaceId(
    isPlainRecord(settings) ? settings.projectRolesByWorkspaceId : undefined,
  )
  return byProject[projectId] ?? []
}

function withProjectRoles(
  settings: unknown,
  projectId: string,
  roles: ProjectRoleDefinition[],
): Record<string, unknown> {
  const base = isPlainRecord(settings) ? settings : {}
  const byProject = normalizeProjectRolesByWorkspaceId(base.projectRolesByWorkspaceId)
  const next = { ...byProject }
  if (roles.length > 0) {
    next[projectId] = roles
  } else {
    delete next[projectId]
  }
  return { ...base, projectRolesByWorkspaceId: next }
}

export type SetProjectRoleResult =
  | { ok: true; settings: Record<string, unknown>; role: ProjectRoleDefinition; created: boolean }
  | { ok: false; reason: string }

export function planSetProjectRole(
  settings: unknown,
  projectId: string,
  patch: ProjectRolePatch,
  now: string,
  createId: () => string,
): SetProjectRoleResult {
  const name = patch.name.trim()
  if (!name) {
    return { ok: false, reason: 'Role name must not be blank.' }
  }
  const roles = listProjectRoles(settings, projectId)
  const existing = roles.find(role => nameKey(role.name) === nameKey(name))
  if (!existing && !patch.promptTemplate?.trim()) {
    return { ok: false, reason: `Role "${name}" does not exist yet; a new role needs a prompt.` }
  }

  const role: ProjectRoleDefinition = {
    id: existing?.id ?? createId(),
    // The name only finds the role; an update keeps its saved spelling.
    name: existing?.name ?? name,
    description: patch.description ?? existing?.description ?? '',
    promptTemplate: patch.promptTemplate ?? existing?.promptTemplate ?? '',
    inputHint: patch.inputHint ?? existing?.inputHint ?? '',
    outputFormat: patch.outputFormat ?? existing?.outputFormat ?? '',
    provider: patch.provider !== undefined ? patch.provider : (existing?.provider ?? null),
    model: patch.model ?? existing?.model ?? '',
    isLead: patch.isLead ?? existing?.isLead ?? false,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  }

  // One lead per project: a new lead takes the mark from the previous one.
  const others = roles
    .filter(candidate => candidate.id !== role.id)
    .map(candidate =>
      role.isLead && candidate.isLead ? { ...candidate, isLead: false } : candidate,
    )
  const nextRoles = existing
    ? roles.map(candidate =>
        candidate.id === role.id ? role : others.find(other => other.id === candidate.id)!,
      )
    : [...others, role]

  const normalized = normalizeProjectRoles(nextRoles)
  const saved = normalized.find(candidate => candidate.id === role.id)
  if (!saved) {
    return { ok: false, reason: `Role "${name}" could not be saved (role limit reached?).` }
  }
  return {
    ok: true,
    settings: withProjectRoles(settings, projectId, normalized),
    role: saved,
    created: !existing,
  }
}

export function planDeleteProjectRole(
  settings: unknown,
  projectId: string,
  name: string,
): { settings: Record<string, unknown>; deleted: ProjectRoleDefinition } | null {
  const roles = listProjectRoles(settings, projectId)
  const deleted = roles.find(role => nameKey(role.name) === nameKey(name))
  if (!deleted) {
    return null
  }
  return {
    settings: withProjectRoles(
      settings,
      projectId,
      roles.filter(role => role.id !== deleted.id),
    ),
    deleted,
  }
}
