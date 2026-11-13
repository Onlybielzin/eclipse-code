import { normalizeTextValue } from './settingsNormalization'
import { AGENT_PROVIDERS, type AgentProvider } from './agentSettings.providers'

export interface ProjectRoleDefinition {
  id: string
  name: string
  description: string
  promptTemplate: string
  inputHint: string
  outputFormat: string
  /** Provider this role always runs on; null follows the window's choice or the default. */
  provider: AgentProvider | null
  /** Model for this role; empty follows the provider's configured model. */
  model: string
  /** The team lead: it receives every task and creates the other roles' agents (eclipse-code mcp). */
  isLead: boolean
  createdAt: string
  updatedAt: string
}

export type ProjectRolesByWorkspaceId = Record<string, ProjectRoleDefinition[]>

const MAX_PROJECT_ROLES_PER_WORKSPACE = 100
const MAX_PROJECT_ROLE_NAME_LENGTH = 80
const MAX_PROJECT_ROLE_DESCRIPTION_LENGTH = 1_000
const MAX_PROJECT_ROLE_PROMPT_TEMPLATE_LENGTH = 40_000
const MAX_PROJECT_ROLE_INPUT_HINT_LENGTH = 4_000
const MAX_PROJECT_ROLE_OUTPUT_FORMAT_LENGTH = 8_000
const MAX_PROJECT_ROLE_MODEL_LENGTH = 120

function normalizeRoleProvider(value: unknown): AgentProvider | null {
  return typeof value === 'string' && (AGENT_PROVIDERS as readonly string[]).includes(value)
    ? (value as AgentProvider)
    : null
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function normalizeProjectRoleDefinition(value: unknown): ProjectRoleDefinition | null {
  if (!isPlainRecord(value)) {
    return null
  }

  const id = normalizeTextValue(value.id)
  const name = normalizeTextValue(value.name).slice(0, MAX_PROJECT_ROLE_NAME_LENGTH)
  const promptTemplate = normalizeTextValue(value.promptTemplate).slice(
    0,
    MAX_PROJECT_ROLE_PROMPT_TEMPLATE_LENGTH,
  )

  if (id.length === 0 || name.length === 0 || promptTemplate.length === 0) {
    return null
  }

  return {
    id,
    name,
    description: normalizeTextValue(value.description).slice(
      0,
      MAX_PROJECT_ROLE_DESCRIPTION_LENGTH,
    ),
    promptTemplate,
    inputHint: normalizeTextValue(value.inputHint).slice(0, MAX_PROJECT_ROLE_INPUT_HINT_LENGTH),
    outputFormat: normalizeTextValue(value.outputFormat).slice(
      0,
      MAX_PROJECT_ROLE_OUTPUT_FORMAT_LENGTH,
    ),
    provider: normalizeRoleProvider(value.provider),
    model: normalizeTextValue(value.model).slice(0, MAX_PROJECT_ROLE_MODEL_LENGTH),
    isLead: value.isLead === true,
    createdAt: normalizeTextValue(value.createdAt),
    updatedAt: normalizeTextValue(value.updatedAt),
  }
}

function toRoleNameKey(name: string): string {
  return name.trim().toLowerCase()
}

export function normalizeProjectRoles(value: unknown): ProjectRoleDefinition[] {
  if (!Array.isArray(value)) {
    return []
  }

  const normalized: ProjectRoleDefinition[] = []
  const seenIds = new Set<string>()
  const seenNames = new Set<string>()
  let hasLead = false

  for (const item of value) {
    const role = normalizeProjectRoleDefinition(item)
    if (!role) {
      continue
    }

    const nameKey = toRoleNameKey(role.name)
    if (seenIds.has(role.id) || seenNames.has(nameKey)) {
      continue
    }

    seenIds.add(role.id)
    seenNames.add(nameKey)
    // One lead per project: the first one saved keeps the mark.
    if (role.isLead && hasLead) {
      role.isLead = false
    }
    hasLead ||= role.isLead
    normalized.push(role)

    if (normalized.length >= MAX_PROJECT_ROLES_PER_WORKSPACE) {
      break
    }
  }

  return normalized
}

export function normalizeProjectRolesByWorkspaceId(value: unknown): ProjectRolesByWorkspaceId {
  if (!isPlainRecord(value)) {
    return {}
  }

  const normalized: ProjectRolesByWorkspaceId = {}
  for (const [workspaceId, rawRoles] of Object.entries(value)) {
    const normalizedWorkspaceId = workspaceId.trim()
    if (normalizedWorkspaceId.length === 0) {
      continue
    }

    const roles = normalizeProjectRoles(rawRoles)
    if (roles.length === 0) {
      continue
    }

    normalized[normalizedWorkspaceId] = roles
  }

  return normalized
}
