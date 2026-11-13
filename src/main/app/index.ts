/**
 * app/: composition root do main.
 *
 *   services.ts        startAppServices: SQLite, PtyHost, Lider, ACP, worktrees, ponte MCP,
 *                      TeamCoordinator, TeamTurnRelay e recuperacao da partida. Sem Electron.
 *   teamCoordinator.ts fluxo criar tarefa -> Lider; subtarefa_criar -> membro -> turno ->
 *                      entrega -> aviso -> encerrar; implementa McpToolHandler.
 *   ipcHandlers.ts     comandos da tela (entrada ja validada pelo ipcRouter).
 *   prompts.ts         textos mandados aos agentes.
 *   smoke.ts           modo --smoke: SQLite, node-pty e servidor MCP do pacote, sem janela.
 *
 * O src/main/index.ts so acrescenta janela, IPC e o desligamento ordenado.
 */
export { createIpcRouter } from './ipcRouter'
export { createIpcHandlers } from './ipcHandlers'
export { resolveAppPaths } from './paths'
export { runSmokeChecks, type SmokeReport } from './smoke'
export { startAppServices, type AppServices, type AppServicesOptions } from './services'
export { AppTeamCoordinator, silentLogger, type AppLogger } from './teamCoordinator'
