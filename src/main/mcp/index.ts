/**
 * mcp/: servidor MCP stdio do app e ponte com o main.
 *
 *   bridgeServer.ts   McpBridgeServer (lado main): socket unix 0600, token por sessao.
 *   bridgeClient.ts   McpBridgeClient (lado do servidor MCP stdio).
 *   toolHandler.ts    McpToolHandler: valida, autoriza pelo papel do token e chama
 *                     TaskService ou McpTeamActions (implementadas pelo TeamCoordinator).
 *   stdioServer.ts    servidor MCP (@modelcontextprotocol/sdk); entrada do build em server.ts.
 *   teamTurnRelay.ts  aviso de uma linha ao Lider quando o turno de um membro fecha.
 *   ptyLeaderRelay.ts LeaderRelay sobre o PtyHost: espera ocioso, cola e envia.
 *
 * Origem: src/app/cli/mcp/server.ts, TeamTurnRelay.ts e PromptDeliveryService.ts do app antigo.
 */
export { createMcpBridgeServer, type McpBridgeServerOptions } from './bridgeServer'
export { createMcpBridgeClient } from './bridgeClient'
export {
  createMcpToolHandler,
  isStoppedState,
  type DisposableMcpToolHandler,
  type McpTeamActions,
  type McpToolHandlerDeps,
} from './toolHandler'
export { createEclipseMcpServer, runStdioMcpServer, toolInputJsonSchema } from './stdioServer'
export {
  DEFAULT_NOTICE_RETRY_INTERVAL_MS,
  composeTurnNotice,
  createMemoryLeaderNoticeStore,
  startTeamTurnRelay,
  type LeaderActivityEvent,
  type TeamTurnRelay,
  type TeamTurnRelayDeps,
} from './teamTurnRelay'
export {
  createPtyLeaderRelay,
  lastBracketedPasteMode,
  type PtyLeaderRelay,
  type PtyLeaderRelayOptions,
} from './ptyLeaderRelay'
