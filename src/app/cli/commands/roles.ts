import { defineCommand } from '../core/command'
import { CliError, usage } from '../core/errors'

/**
 * Project roles (the agent team) from outside the app. The Worker stores them and an open
 * Eclipse Code shows the change live, without a restart. Agents cannot change roles.
 */

const ROLE_FIELDS = [
  'id',
  'name',
  'description',
  'provider',
  'model',
  'isLead',
  'promptTemplate',
  'inputHint',
  'outputFormat',
  'createdAt',
  'updatedAt',
]

const projectOption = {
  type: 'string' as const,
  valueName: 'project',
  description: 'Project whose team to change',
}

const roleSetOptions = {
  project: projectOption,
  name: { type: 'string' as const, valueName: 'name', description: 'Role name', required: true },
  prompt: {
    type: 'string' as const,
    valueName: 'text',
    description: 'Prompt template (required for a new role); use this or --prompt-file',
    fileVariant: true as const,
  },
  description: { type: 'string' as const, valueName: 'text', description: 'Short description' },
  provider: {
    type: 'string' as const,
    valueName: 'provider',
    description: 'Provider the role always runs on (claude-code, codex, ...); "none" clears it',
  },
  model: { type: 'string' as const, valueName: 'model', description: 'Model for this role' },
  lead: { type: 'boolean' as const, description: 'Make this role the team lead' },
}

function rolePayload(projectId: string, raw: Record<string, unknown>) {
  const provider = raw.provider
  return {
    projectId,
    name: raw.name,
    ...(raw.prompt !== undefined ? { prompt: raw.prompt } : {}),
    ...(raw.description !== undefined ? { description: raw.description } : {}),
    ...(provider !== undefined ? { provider: provider === 'none' ? null : provider } : {}),
    ...(raw.model !== undefined ? { model: raw.model } : {}),
    ...(raw.isLead !== undefined ? { isLead: raw.isLead } : {}),
    ...(raw.inputHint !== undefined ? { inputHint: raw.inputHint } : {}),
    ...(raw.outputFormat !== undefined ? { outputFormat: raw.outputFormat } : {}),
  }
}

export const roleListCommand = defineCommand({
  path: ['role', 'list'],
  summary: "List a project's roles (its agent team)",
  connect: true,
  operation: 'role.list',
  options: { project: { ...projectOption, description: 'Project whose team to list' } },
  examples: ['eclipse-code role list --project kaliloop-backend'],
  render: {
    listKey: 'roles',
    fields: ROLE_FIELDS,
    defaultFields: ['name', 'provider', 'model', 'isLead'],
    examples: [
      'eclipse-code role list --project p --fields name,isLead',
      '{"projectId":"p","roles":[{"name":"Lead","isLead":true}]}',
    ],
  },
  buildInput: ({ options: o }) => ({ projectId: o.project }),
})

export const roleSetCommand = defineCommand({
  path: ['role', 'set'],
  summary: 'Create or update a project role; an open Eclipse Code shows it without a restart',
  description:
    'Matches the role by name (case-insensitive): an existing role keeps every field you do not pass. A new role needs a prompt. Only the user can change roles; agents are refused.',
  connect: true,
  mutation: true,
  operation: 'role.set',
  options: roleSetOptions,
  examples: [
    'eclipse-code role set --project kaliloop-backend --name "Líder" --prompt-file lider.md --provider claude-code --model claude-opus-5-5 --lead',
    'eclipse-code role set --project kaliloop-backend --name "Dev 1" --model claude-sonnet-5-5',
  ],
  render: {
    fields: ['projectId', 'created', 'role', ...ROLE_FIELDS.map(f => `role.${f}`)],
    examples: [
      'eclipse-code role set --project p --name "Dev 1" --model claude-sonnet-5-5 --fields created',
      '{"created":false}',
    ],
  },
  buildInput: ({ options: o }) => {
    if (typeof o.name !== 'string' || !o.name.trim()) {
      usage('--name must not be blank')
    }
    return rolePayload(String(o.project), { ...o, isLead: o.lead === true ? true : undefined })
  },
})

export const roleDeleteCommand = defineCommand({
  path: ['role', 'delete'],
  summary: 'Delete a project role by name',
  connect: true,
  mutation: true,
  operation: 'role.delete',
  options: {
    project: projectOption,
    name: { type: 'string', valueName: 'name', description: 'Role name', required: true },
  },
  examples: ['eclipse-code role delete --project kaliloop-backend --name "Dev 3"'],
  render: {
    fields: ['projectId', 'deleted', 'deleted.id', 'deleted.name'],
    examples: [
      'eclipse-code role delete --project p --name "Dev 3" --fields deleted.name',
      '{"deleted":{"name":"Dev 3"}}',
    ],
  },
  buildInput: ({ options: o }) => ({ projectId: o.project, name: o.name }),
})

export const roleImportCommand = defineCommand({
  path: ['role', 'import'],
  summary: 'Create or update a whole team from a JSON file; an open app shows it live',
  description:
    'The file is a JSON array of roles: {"name","prompt" or "promptFile","description","provider","model","isLead","inputHint","outputFormat"}. "promptFile" is relative to the JSON file. Roles not in the file are kept; existing roles are updated by name.',
  connect: true,
  mutation: true,
  operation: 'role.set',
  // The input is the file, not one role.set payload; each role is validated by the Worker.
  serverValidation: true,
  options: {
    project: projectOption,
    file: {
      type: 'string',
      valueName: 'path',
      description: 'JSON file with the team',
      required: true,
    },
  },
  examples: ['eclipse-code role import --project kaliloop-backend --file ./time.json'],
  render: {
    fields: ['projectId', 'roles', 'roles.name', 'roles.created'],
    examples: [
      'eclipse-code role import --project p --file ./time.json --fields roles',
      '{"roles":[{"name":"Dev 1","created":true}]}',
    ],
  },
  buildInput: ({ options: o }) => ({ projectId: o.project, file: o.file }),
  async execute(ctx) {
    const file = String(ctx.options.file)
    let parsed: unknown
    try {
      parsed = JSON.parse(await ctx.io.readTextFile(file))
    } catch (error) {
      throw new CliError(
        'common.invalid_input',
        2,
        `Could not read the team file ${file}: ${error instanceof Error ? error.message : String(error)}`,
        'Pass a JSON array of roles.',
      )
    }
    if (!Array.isArray(parsed) || parsed.length === 0) {
      usage('--file must contain a non-empty JSON array of roles')
    }
    const baseDir = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '.'
    const roles: Array<Record<string, unknown>> = []
    for (const raw of parsed as Array<Record<string, unknown>>) {
      if (typeof raw?.name !== 'string' || !raw.name.trim()) {
        usage('every role in --file needs a "name"')
      }
      if (typeof raw.promptFile === 'string') {
        const path = raw.promptFile.startsWith('/')
          ? raw.promptFile
          : `${baseDir}/${raw.promptFile}`
        // eslint-disable-next-line no-await-in-loop -- Few small files, read in order.
        roles.push({ ...raw, prompt: await ctx.io.readTextFile(path) })
      } else {
        roles.push(raw)
      }
    }
    const projectId = String(ctx.options.project)
    const results: Array<{ name: string; created: boolean }> = []
    for (const raw of roles) {
      // eslint-disable-next-line no-await-in-loop -- Sequential writes keep one lead and stable order.
      const result = (await ctx.invoke('role.set', rolePayload(projectId, raw))) as {
        role: { name: string }
        created: boolean
      }
      results.push({ name: result.role.name, created: result.created })
    }
    return { projectId, roles: results }
  },
})

export const roleCommands = [roleListCommand, roleSetCommand, roleDeleteCommand, roleImportCommand]
