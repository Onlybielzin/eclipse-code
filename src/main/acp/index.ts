/**
 * acp/: membros do time pelo ACP. Implementa MemberRuntime (src/shared/ports.ts).
 *
 * Referencia: /data/Projects/paperclip packages/adapter-utils/src/acpx-engine/execute.ts,
 * adapters/claude-local/src/server/acp.ts, adapters/codex-local/src/server/acp.ts.
 * Escrito do zero sobre @agentclientprotocol/sdk (ClientSideConnection).
 *
 * Uso no composition root:
 *   const members = new AcpMemberRuntime({ clock, timeouts, deliveries }, { logger })
 */
export { AcpMemberRuntime } from './AcpMemberRuntime'
export type { AcpMemberRuntimeOptions, AcpRuntimeLogger } from './AcpMemberRuntime'
export {
  CLAUDE_SETTING_SOURCES,
  buildAgentCommand,
  buildSessionMeta,
  resolveAcpAgentScript,
  toAcpMcpServer,
} from './agentCommand'
export type { AgentCommand } from './agentCommand'
export { decidePermission } from './permissionPolicy'

/** Padroes sugeridos; o app pode sobrepor pelas configuracoes. */
export const DEFAULT_MEMBER_TURN_TIMEOUTS = {
  /** 45 min por turno. */
  turnTimeoutMs: 45 * 60_000,
  /** 10 min sem nenhum session/update (um teste longo nao manda eventos). */
  silenceTimeoutMs: 10 * 60_000,
} as const
