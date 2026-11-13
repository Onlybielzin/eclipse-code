import { checkSessionGrantPrompt } from './sessionGrantPromptPolicy'
import type { CONTROL_SURFACE_OPERATIONS } from '../../../../shared/contracts/controlSurface/operations'
import {
  checkSessionGrantLaunch,
  SESSION_GRANT_FULL_ACCESS_PATH,
  SESSION_GRANT_LAUNCH_REJECTED_FIELDS,
} from './sessionGrantLaunchPolicy'
import type { SessionGrant } from './sessionGrantRegistry'
import { createAppError } from '../../../../shared/errors/appError'
export type OperationId = (typeof CONTROL_SURFACE_OPERATIONS)[number]['id']
export type GrantCheckDeps = {
  readonly grant: SessionGrant
  readonly wirePayload: unknown
  readonly operationId: string
}
export type GrantRule =
  | { access: 'allow' }
  | { access: 'deny'; reason: string }
  | {
      access: 'constrained'
      reason: string
      rejectedFields: Readonly<Record<string, string>>
      check: (payload: unknown, deps: GrantCheckDeps) => void
    }
export const SESSION_GRANT_POLICY_VERSION = 's1a-v5'
const allow = { access: 'allow' } as const
const deny = (reason: string): GrantRule => ({ access: 'deny', reason })
const launch = {
  access: 'constrained',
  reason:
    'runtime creation requires admitted local node.create; agent terminals use saved launch settings for new conversations; prompts must describe a task and cannot run provider commands',
  rejectedFields: SESSION_GRANT_LAUNCH_REJECTED_FIELDS,
  check: checkSessionGrantLaunch,
} as const
const runtime = {
  access: 'constrained',
  reason:
    'runtime creation requires admitted local node.create; use eclipse-code node create agent or eclipse-code node create terminal',
  rejectedFields: {},
  check: () => {},
} as const
const nodeCreate = {
  access: 'constrained',
  reason:
    'agent and terminal creation requires a current local canvas session, depth at most 3 and at most 6 live descendants per tree',
  rejectedFields: {},
  check: () => {},
} as const
/** The calling agent is the asker or the list owner; an agent cannot act for another node. */
function callerOwnedCard(field: string, reason: string): GrantRule {
  return {
    access: 'constrained',
    reason,
    rejectedFields: { [field]: 'agent terminals act as themselves; omit it' },
    check: (_payload, deps) => {
      const wire = deps.wirePayload
      if (wire && typeof wire === 'object' && Object.hasOwn(wire, field)) {
        throw createAppError('common.forbidden', {
          details: {
            reason: 'field_denied',
            operationId: deps.operationId,
            message: `${field} is the calling agent; omit it.`,
          },
        })
      }
    },
  }
}
const settingsReason = `only the user can change settings; agent permissions are in ${SESSION_GRANT_FULL_ACCESS_PATH}`

// Each entry is a deliberate authority decision. New operations require explicit review.
// Project isolation is a separate policy boundary, planned for S1b.
export const SESSION_GRANT_POLICY = {
  'agent.delivery.get': allow,
  'agent.finalMessage': allow,
  'agent.get': allow,
  'agent.history.clear': allow,
  'agent.list': allow,
  'agent.listSessions': allow,
  'agent.prompt': {
    access: 'constrained',
    reason: 'agent terminals can send messages but cannot run provider commands',
    rejectedFields: {},
    check: checkSessionGrantPrompt,
  },
  'auth.issueWebSessionTicket': deny('this action requires a human decision in Eclipse Code'),
  'canvas.focus': allow,
  'endpoint.homeDirectory': allow,
  'endpoint.list': allow,
  'endpoint.overview.list': allow,
  'endpoint.ping': allow,
  'endpoint.prepare': deny('this action requires a human decision in Eclipse Code'),
  'endpoint.readDirectory': deny('this action requires a human decision in Eclipse Code'),
  'endpoint.register': deny('this action requires a human decision in Eclipse Code'),
  'endpoint.registerManagedSsh': deny('this action requires a human decision in Eclipse Code'),
  'endpoint.remove': deny('this action requires a human decision in Eclipse Code'),
  'endpoint.repair': deny('this action requires a human decision in Eclipse Code'),
  'endpoint.sshConfigHosts': allow,
  'endpoint.updateManagedSsh': deny('this action requires a human decision in Eclipse Code'),
  'filesystem.copyEntry': allow,
  'filesystem.copyEntryInMount': allow,
  'filesystem.createDirectory': allow,
  'filesystem.createDirectoryInMount': allow,
  'filesystem.deleteEntry': allow,
  'filesystem.deleteEntryInMount': allow,
  'filesystem.moveEntry': allow,
  'filesystem.moveEntryInMount': allow,
  'filesystem.mutationCapabilities': allow,
  'filesystem.readDirectory': allow,
  'filesystem.readDirectoryInMount': allow,
  'filesystem.readFileBytes': allow,
  'filesystem.readFileBytesInMount': allow,
  'filesystem.readFileText': allow,
  'filesystem.readFileTextInMount': allow,
  'filesystem.renameEntry': allow,
  'filesystem.renameEntryInMount': allow,
  'filesystem.stat': allow,
  'filesystem.statInMount': allow,
  'filesystem.writeFileText': allow,
  'filesystem.writeFileTextInMount': allow,
  'gitWorktree.create': allow,
  'gitWorktree.createInMount': allow,
  'gitWorktree.getDefaultBranch': allow,
  'gitWorktree.getDefaultBranchInMount': allow,
  'gitWorktree.graph': allow,
  'gitWorktree.graphInMount': allow,
  'gitWorktree.listBranches': allow,
  'gitWorktree.listBranchesInMount': allow,
  'gitWorktree.listWorktrees': allow,
  'gitWorktree.listWorktreesInMount': allow,
  'gitWorktree.remove': allow,
  'gitWorktree.removeInMount': allow,
  'gitWorktree.renameBranch': allow,
  'gitWorktree.renameBranchInMount': allow,
  'gitWorktree.statusSummary': allow,
  'gitWorktree.statusSummaryInMount': allow,
  'gitWorktree.suggestNames': allow,
  'integration.github.resolvePullRequests': allow,
  'integration.github.resolvePullRequestsInMount': allow,
  'mount.create': deny('this action requires a human decision in Eclipse Code'),
  'mount.list': allow,
  'mount.promote': deny('this action requires a human decision in Eclipse Code'),
  'mount.remove': deny('this action requires a human decision in Eclipse Code'),
  'mountTarget.resolve': allow,
  'node.create': nodeCreate,
  'node.delete': allow,
  'node.get': allow,
  'node.managedClaudeBinding': allow,
  'node.list': allow,
  'node.resolveCallerSelector': allow,
  'node.update': allow,
  'note.create': allow,
  'plugin.command.run': deny(
    'plugin code runs with plugin authority and requires a human decision',
  ),
  'plugin.details': allow,
  'plugin.discover': deny('this action requires a human decision in Eclipse Code'),
  'plugin.git.apply': deny('this action requires a human decision in Eclipse Code'),
  'plugin.git.check': deny('this action requires a human decision in Eclipse Code'),
  'plugin.git.install': deny('this action requires a human decision in Eclipse Code'),
  'plugin.git.update': deny('this action requires a human decision in Eclipse Code'),
  'plugin.host.request': deny(
    'plugin code runs with plugin authority and requires a human decision',
  ),
  'plugin.install': deny('this action requires a human decision in Eclipse Code'),
  'plugin.invoke': deny('plugin code runs with plugin authority and requires a human decision'),
  'plugin.list': allow,
  'plugin.preferences.get': allow,
  'plugin.preferences.set': deny('installation-wide plugin settings belong to the user'),
  'plugin.reload': deny('this action requires a human decision in Eclipse Code'),
  'plugin.repository.details': deny('this action requires a human decision in Eclipse Code'),
  'plugin.rollback': deny('this action requires a human decision in Eclipse Code'),
  'plugin.setEnabled': deny('this action requires a human decision in Eclipse Code'),
  'plugin.sidebar.items': deny(
    'plugin code runs with plugin authority and requires a human decision',
  ),
  'plugin.skill.get': allow,
  'plugin.source': allow,
  'plugin.storage.get': allow,
  'plugin.storage.set': deny('installation-wide plugin settings belong to the user'),
  'plugin.uninstall': deny('this action requires a human decision in Eclipse Code'),
  'plugin.view.close': allow,
  'plugin.view.open': deny('opening a plugin view can execute plugin code with plugin authority'),
  'plugin.view.preferences.get': allow,
  'plugin.view.preferences.set': deny('installation-wide plugin settings belong to the user'),
  'plugin.view.setTitle': allow,
  'plugin.window.list': allow,
  'plugin.window.open': deny(
    'opening a plugin window can execute plugin code with plugin authority',
  ),
  'project.add': deny('this action requires a human decision in Eclipse Code'),
  'project.list': allow,
  'pty.debugCrashHost': deny('this action requires a human decision in Eclipse Code'),
  'pty.listProfiles': allow,
  'pty.spawn': runtime,
  'pty.spawnInMount': runtime,
  'session.attachAgentStateWatcher': deny('agent observation is managed by Eclipse Code'),
  'session.detachAgentStateWatcher': deny('agent observation is managed by Eclipse Code'),
  'session.finalMessage': allow,
  'session.finalMessageForNode': allow,
  'question.answer': deny('only the user answers questions, in Eclipse Code'),
  'question.create': callerOwnedCard(
    'askedByNodeId',
    'only an agent the user started asks the user; the answer comes back to the caller',
  ),
  'question.history': allow,
  'role.delete': deny('only the user edits the project team, in Eclipse Code'),
  'role.list': allow,
  'role.set': deny('only the user edits the project team, in Eclipse Code'),
  'session.cleanupUnreferenced': deny('this action requires a human decision in Eclipse Code'),
  'session.get': allow,
  'session.kill': allow,
  'session.launchAgent': launch,
  'session.launchAgentInMount': launch,
  'session.list': allow,
  'session.prepareOrRevive': deny('session recovery is managed by Eclipse Code'),
  'session.presentationSnapshot': allow,
  'session.snapshot': allow,
  'session.spawnTerminal': runtime,
  'session.stopNode': allow,
  'session.terminalAgentActivity.list': allow,
  'session.writeNode': deny(
    'send messages with eclipse-code agent prompt; only the user can answer permission prompts and dialogs in Eclipse Code',
  ),
  'space.create': allow,
  'space.delete': allow,
  'space.createChild': allow,
  'space.get': allow,
  'space.list': allow,
  'space.update': allow,
  'sync.readAgentNodePlaceholderScrollback': allow,
  'sync.readNodeScrollback': allow,
  'sync.readWorkspaceStateRaw': deny('it exposes private settings and credentials'),
  'sync.state': deny('it exposes private settings and credentials'),
  'sync.writeAgentNodePlaceholderScrollback': deny(
    'saved agent history is managed by Eclipse Code',
  ),
  'sync.writeNodeScrollback': deny('saved terminal history is managed by Eclipse Code'),
  'sync.writeState': deny(settingsReason),
  'sync.writeWorkspaceStateRaw': deny(settingsReason),
  'system.capabilities': allow,
  'system.homeDirectory': allow,
  'system.operation.describe': allow,
  'system.operations': allow,
  'system.ping': allow,
  'system.whoami': allow,
  'todos.sync': callerOwnedCard('ownerNodeId', 'an agent mirrors only its own task list'),
  'worker.config.get': deny('this action requires a human decision in Eclipse Code'),
  'worker.config.set': deny('this action requires a human decision in Eclipse Code'),
  'worker.maintenance.acquire': deny('this action requires a human decision in Eclipse Code'),
  'worker.maintenance.activate': deny('this action requires a human decision in Eclipse Code'),
  'worker.maintenance.release': deny('this action requires a human decision in Eclipse Code'),
  'worker.maintenance.status': deny('this action requires a human decision in Eclipse Code'),
  'worker.maintenance.stop': deny('this action requires a human decision in Eclipse Code'),
  'worker.webAccess.setSecurity': deny('this action requires a human decision in Eclipse Code'),
  'worker.webAccess.setSettings': deny('this action requires a human decision in Eclipse Code'),
  'workspace.allocateProjectPlaceholder': deny(
    'approving new project roots requires a human decision',
  ),
  'workspace.approveRoot': deny('this action requires a human decision in Eclipse Code'),
  'workspace.ensureDirectory': deny(
    'project directory setup is managed by Eclipse Code; use eclipse-code fs for approved files',
  ),
  'worktree.archive': allow,
  'worktree.create': allow,
  'worktree.list': allow,
} satisfies Record<OperationId, GrantRule>

export function sessionGrantRule(id: string): GrantRule {
  return Object.hasOwn(SESSION_GRANT_POLICY, id)
    ? SESSION_GRANT_POLICY[id as OperationId]
    : deny('use eclipse-code api ops to find an available operation')
}
