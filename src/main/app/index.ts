/**
 * app/: composition root do main.
 *
 * TODO(app):
 *  - Abrir o TaskStore (tasks/) em AppPaths.database e criar o TaskService.
 *  - Criar PtyHost (terminal/), LeaderLauncher + LeaderRelay (leader/),
 *    MemberRuntime (acp/), WorktreeService (worktree/), McpBridgeServer (mcp/).
 *  - Criar o TeamCoordinator (tasks/) com essas portas e ligar o McpBridgeServer a ele.
 *  - Registrar os IpcCommandHandlers no createIpcRouter e repassar
 *    TaskService.subscribe -> 'domain.event' e PtyHost.onData -> 'terminal.data'.
 *  - Chamar TeamCoordinator.recoverOnStartup() antes de mostrar a janela.
 *  - Em before-quit: TeamCoordinator.shutdown(), McpBridgeServer.stop(), PtyHost.dispose().
 */
export { createIpcRouter } from './ipcRouter'
export { resolveAppPaths } from './paths'
