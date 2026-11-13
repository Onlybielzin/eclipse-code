import * as z from 'zod'
import { defineOperation } from '../defineOperation'

/**
 * Eclipse Code project roles (the team), edited from outside the shell. Writes go through the
 * Worker, so an open app picks them up live. Only the user edits roles: session grants (agents)
 * may list them but not change them.
 */

const projectId = z.string().trim().min(1).describe('Project (workspace) ID')
const name = z.string().trim().min(1).max(80).describe('Role name, matched case-insensitively')

export const roleListOperation = defineOperation({
  id: 'role.list',
  kind: 'query',
  scope: 'read',
  availability: 'always',
  summary: "List a project's roles (its agent team)",
  input: z.strictObject({ projectId }),
  errors: ['common.invalid_input', 'persistence.unavailable'],
})

export const roleSetOperation = defineOperation({
  id: 'role.set',
  kind: 'command',
  scope: 'admin',
  availability: 'always',
  summary: 'Create or update a project role by name; an open app shows it without a restart',
  input: z.strictObject({
    projectId,
    name,
    prompt: z.string().max(40_000).optional().describe('Prompt template; required for a new role'),
    description: z.string().max(1_000).optional(),
    provider: z
      .string()
      .trim()
      .min(1)
      .nullable()
      .optional()
      .describe(
        'Provider the role always runs on (claude-code, codex, ...); null follows the window choice',
      ),
    model: z.string().max(120).optional().describe('Model; empty follows the provider default'),
    isLead: z.boolean().optional().describe('Make this the team lead (one per project)'),
    inputHint: z.string().max(4_000).optional(),
    outputFormat: z.string().max(8_000).optional(),
  }),
  errors: [
    'common.invalid_input',
    'persistence.invalid_state',
    'persistence.io_failed',
    'persistence.unavailable',
  ],
})

export const roleDeleteOperation = defineOperation({
  id: 'role.delete',
  kind: 'command',
  scope: 'admin',
  availability: 'always',
  summary: 'Delete a project role by name',
  input: z.strictObject({ projectId, name }),
  errors: [
    'common.invalid_input',
    'persistence.invalid_state',
    'persistence.io_failed',
    'persistence.unavailable',
  ],
})

export const roleOperations = [roleListOperation, roleSetOperation, roleDeleteOperation] as const
