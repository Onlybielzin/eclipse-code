import { randomUUID } from 'node:crypto'
import { registerOperation } from '../registerOperation'
import {
  roleDeleteOperation,
  roleListOperation,
  roleSetOperation,
} from '../../../../shared/contracts/controlSurface/operations/domains/roles'
import type { ControlSurface } from '../controlSurface'
import type { PersistenceStore } from '../../../../platform/persistence/sqlite/PersistenceStore'
import { createAppError } from '../../../../shared/errors/appError'
import { normalizePersistedAppState } from '../../../../platform/persistence/sqlite/normalize'
import { commitWithRetry } from '../../../../contexts/workspace/application/canvasCards/canvasCardState'
import type { NodeControlAppState } from '../../../../contexts/workspace/application/nodeControl/nodeControlState'
import {
  listProjectRoles,
  planDeleteProjectRole,
  planSetProjectRole,
} from '../../../../contexts/settings/application/projectRoleCommands'
import {
  AGENT_PROVIDERS,
  type AgentProvider,
} from '../../../../contexts/settings/domain/agentSettings.providers'
import { toNodeControlStateStore } from './nodeControlHandlers'

function requireProject(state: { workspaces: Array<{ id: string }> }, projectId: string): void {
  if (!state.workspaces.some(workspace => workspace.id === projectId)) {
    throw createAppError('common.invalid_input', {
      debugMessage: `Unknown project: ${projectId}. Run "eclipse-code project list".`,
    })
  }
}

function toProvider(value: string | null | undefined): AgentProvider | null | undefined {
  if (value === undefined || value === null) {
    return value
  }
  if (!(AGENT_PROVIDERS as readonly string[]).includes(value)) {
    throw createAppError('common.invalid_input', {
      debugMessage: `Unknown provider "${value}". Use one of: ${AGENT_PROVIDERS.join(', ')}.`,
    })
  }
  return value as AgentProvider
}

/**
 * Project roles (the agent team) edited from the CLI. The write is a compare-and-swap on the
 * shared app state; open shells converge on it through the sync refresh, without a restart.
 */
export function registerProjectRoleHandlers(
  controlSurface: ControlSurface,
  deps: { getPersistenceStore: () => Promise<PersistenceStore> },
): void {
  registerOperation(controlSurface, roleListOperation, {
    defaultErrorCode: 'common.unexpected',
    handle: async (_ctx, input) => {
      const store = await deps.getPersistenceStore()
      const state = normalizePersistedAppState(await store.readAppState())
      if (!state) {
        throw createAppError('persistence.unavailable')
      }
      requireProject(state, input.projectId)
      return {
        projectId: input.projectId,
        roles: listProjectRoles(state.settings, input.projectId),
      }
    },
  })

  registerOperation(controlSurface, roleSetOperation, {
    defaultErrorCode: 'common.unexpected',
    handle: async (ctx, input) => {
      const provider = toProvider(input.provider)
      const store = toNodeControlStateStore(await deps.getPersistenceStore())
      const now = ctx.now().toISOString()
      const result = await commitWithRetry(
        store,
        (state: NodeControlAppState) => {
          requireProject(state, input.projectId)
          const planned = planSetProjectRole(
            state.settings,
            input.projectId,
            {
              name: input.name,
              promptTemplate: input.prompt,
              description: input.description,
              provider,
              model: input.model,
              isLead: input.isLead,
              inputHint: input.inputHint,
              outputFormat: input.outputFormat,
            },
            now,
            randomUUID,
          )
          if (!planned.ok) {
            throw createAppError('common.invalid_input', { debugMessage: planned.reason })
          }
          return {
            next: { ...state, settings: planned.settings },
            result: { projectId: input.projectId, role: planned.role, created: planned.created },
          }
        },
        ctx.assertActive,
      )
      return result
    },
  })

  registerOperation(controlSurface, roleDeleteOperation, {
    defaultErrorCode: 'common.unexpected',
    handle: async (ctx, input) => {
      const store = toNodeControlStateStore(await deps.getPersistenceStore())
      return await commitWithRetry(
        store,
        (state: NodeControlAppState) => {
          requireProject(state, input.projectId)
          const planned = planDeleteProjectRole(state.settings, input.projectId, input.name)
          if (!planned) {
            throw createAppError('common.invalid_input', {
              debugMessage: `Role "${input.name}" not found in project ${input.projectId}.`,
            })
          }
          return {
            next: { ...state, settings: planned.settings },
            result: { projectId: input.projectId, deleted: planned.deleted },
          }
        },
        ctx.assertActive,
      )
    },
  })
}
