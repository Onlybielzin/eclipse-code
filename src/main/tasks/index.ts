/**
 * tasks/: unico dono do estado duravel. Implementa TaskStore, TaskService e
 * TeamCoordinator (src/shared/ports.ts).
 *
 * TODO(tasks):
 *  - SQLite (better-sqlite3) com migracoes: projects, roles, tasks, subtasks, messages,
 *    artifacts, sessions, turns, activity, questions, events (revisao global).
 *  - TaskService: invariantes de domain.ts (estado final imutavel, um Lider vivo por
 *    tarefa, escrita antes do evento). finishTurn usa resolveTurn (subtaskRules.ts).
 *  - TeamCoordinator: fluxo criar -> membro -> turno -> aviso ao Lider -> encerrar;
 *    recoverOnStartup; implementa McpToolHandler.
 */
export {}
