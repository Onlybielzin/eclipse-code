import { startTeamTurnRelay } from '../../../contexts/agent/application/TeamTurnRelay'
import type { AgentRunStateRegistry } from '../../../contexts/agent/application/AgentRunStateRegistry'
import type { PersistenceStore } from '../../../platform/persistence/sqlite/PersistenceStore'
import { normalizePersistedAppState } from '../../../platform/persistence/sqlite/normalize'
import type { ControlSurface } from './controlSurface'
import type { ControlSurfaceContext } from './types'

/** Runs the team relay for the Worker's lifetime: member turn ends go to the member's lead. */
export function startWorkerTeamTurnRelay(
  controlSurface: ControlSurface,
  deps: {
    context: ControlSurfaceContext
    registry: AgentRunStateRegistry
    getPersistenceStore: () => Promise<PersistenceStore>
  },
): () => void {
  const invoke = async (kind: 'query' | 'command', id: string, payload: unknown) => {
    const result = await controlSurface.invoke(deps.context, { kind, id, payload })
    if (!result.ok) {
      throw Object.assign(new Error(result.error.code), { code: result.error.code })
    }
    return result.value
  }

  const log = (message: string) => {
    if (process.env['ECLIPSE_CODE_TEAM_RELAY_DEBUG'] === '1') {
      process.stderr.write(`[team-relay] ${message}\n`)
    }
  }

  return startTeamTurnRelay({
    subscribe: listener => {
      let unsubscribe = () => {}
      const follow = () => {
        const baseline = deps.registry.list()
        unsubscribe = deps.registry.subscribe(
          { epoch: baseline.epoch, afterSeq: baseline.seq },
          { types: ['agent.turn_completed'] },
          event => {
            if (event.type === 'resync_required') {
              unsubscribe()
              follow()
              return
            }
            const ended = event.snapshot.lastEndedTurn
            const turnId = ended?.id ?? event.endedTurn?.id
            log(`turn_completed node=${event.snapshot.nodeId} turn=${turnId}`)
            if (turnId) {
              listener({
                nodeId: event.snapshot.nodeId,
                turnId,
                outcome: ended?.outcome ?? 'unknown',
              })
            }
          },
        )
      }
      follow()
      return () => unsubscribe()
    },
    readMember: async nodeId => {
      const store = await deps.getPersistenceStore()
      const lineage = await store.nodeLineage?.readMany([nodeId])
      const parentNodeId = lineage?.get(nodeId)?.spawnedBy
      log(`member node=${nodeId} parent=${parentNodeId ?? 'none'}`)
      if (!parentNodeId) {
        return null
      }
      const state = normalizePersistedAppState(await store.readAppState())
      const title =
        state?.workspaces.flatMap(workspace => workspace.nodes).find(node => node.id === nodeId)
          ?.title ?? 'Agente'
      return { parentNodeId, title }
    },
    readFinalMessage: async (nodeId, turnId) => {
      const value = (await invoke('query', 'agent.finalMessage', { nodeId, turnId })) as {
        message?: unknown
      }
      return typeof value?.message === 'string' && value.message.trim() ? value.message : null
    },
    deliver: async (parentNodeId, text) => {
      try {
        await invoke('command', 'agent.prompt', { nodeId: parentNodeId, text, timeoutMs: 60_000 })
        log(`delivered to ${parentNodeId}`)
      } catch (error) {
        log(`delivery to ${parentNodeId} failed: ${(error as Error).message}`)
        throw error
      }
    },
    sleep: ms =>
      new Promise(resolve => {
        setTimeout(resolve, ms).unref?.()
      }),
  })
}
