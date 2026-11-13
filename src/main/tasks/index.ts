/**
 * tasks/: unico dono do estado duravel. Implementa TaskStore e TaskService
 * (src/shared/ports.ts), o limite de agentes vivos, a recuperacao no boot
 * (TaskService.recoverAfterRestart) e o importador do app antigo (so leitura).
 *
 * TODO(tasks): TeamCoordinator (fluxo criar -> membro -> turno -> aviso ao Lider ->
 * encerrar; recoverOnStartup chama recoverAfterRestart; implementa McpToolHandler).
 * Depende das portas de acp/, leader/ e mcp/; entra na integracao.
 */
export { MIGRATIONS, LATEST_SCHEMA_VERSION } from './migrations'
export { openSqliteTaskStore, SqliteTaskStore, roleNameKey, migrate } from './sqliteTaskStore'
export {
  createTaskService,
  SqliteTaskService,
  systemClock,
  uuidIds,
  type RecoveryReport,
  type TaskServiceDeps,
} from './taskService'
export {
  DEFAULT_AGENT_LIMITS,
  assertAgentCapacity,
  liveSessions,
  measureCapacity,
  type AgentCapacity,
  type AgentLiveness,
} from './agentLimits'
export {
  LEGACY_DATABASE_PATH,
  importLegacyProjects,
  readLegacyProjects,
  type LegacyImportReport,
  type LegacyProject,
  type LegacyRole,
} from './legacyImporter'
