/**
 * Handlers dos comandos IPC da tela. A entrada ja chega validada pelo createIpcRouter
 * (schemas de @shared/ipc). Leitura vai ao TaskService; o que abre ou fecha agente vai
 * ao TeamCoordinator.
 */
import { homedir } from 'node:os'
import type { IpcCommandHandlers } from '@shared/ipc'
import { buildWallSnapshot, coalesced } from '../wall'
import type { AppServices } from './services'

export interface IpcHandlerOptions {
  /** Home do usuario devolvida em projects.summary. Padrao: os.homedir(). */
  homeDir?: string
}

export function createIpcHandlers(
  services: Pick<AppServices, 'tasks' | 'coordinator' | 'brain' | 'taskProcesses'>,
  options: IpcHandlerOptions = {},
): Omit<
  IpcCommandHandlers,
  | 'app.info'
  | 'app.whatsNew'
  | 'app.whatsNewSeen'
  | 'projects.pickFolder'
  | 'update.state'
  | 'update.install'
  | 'update.check'
> {
  const { tasks, coordinator, brain, taskProcesses } = services
  const homeDir = options.homeDir ?? homedir()
  const wallSnapshot = coalesced(() => buildWallSnapshot(tasks))
  return {
    'projects.list': async () => tasks.listProjects(),
    'projects.add': async (input) => tasks.addProject(input),
    'projects.remove': async (input) => tasks.removeProject(input.projectId),
    'projects.summary': async () => ({ homeDir, projects: tasks.summarizeProjects() }),

    'settings.get': async () => tasks.getAgentLimitSettings(),
    'settings.save': async (input) => tasks.saveAgentLimitSettings(input),

    'brain.setKey': async (input) => brain.setKey(input.key),
    'brain.status': async () => brain.status(),
    'brain.graph': () => brain.graph(),
    'brain.memory': (input) => brain.memory(input.id),
    'brain.subscribe': async (_input, context) => {
      if (context) brain.subscribe(context.senderId)
    },
    'brain.unsubscribe': async (_input, context) => {
      if (context) brain.unsubscribe(context.senderId)
    },

    'wall.snapshot': wallSnapshot,

    'roles.list': async (input) => tasks.listRoles(input.projectId),
    'roles.save': async (input) => tasks.saveRole(input),
    'roles.delete': async (input) => tasks.deleteRole(input.roleId),

    'tasks.list': async (input) =>
      tasks.listTasks(input.projectId, { includeArchived: input.includeArchived }),
    'tasks.create': (input) => coordinator.createTask(input),
    'tasks.archive': (input) =>
      coordinator.archiveTask(input.taskId, { removeWorktree: input.removeWorktree }),
    'tasks.setStatus': (input) => coordinator.setTaskStatus(input.taskId, input.status),

    'subtasks.list': async (input) => tasks.listSubtasks(input.taskId),
    'subtasks.detail': async (input) => tasks.getSubtaskDetail(input.subtaskId),
    'activity.list': async (input) =>
      tasks.listActivity(input.subtaskId, input.afterSeq ?? null, input.limit),
    'sessions.list': async (input) => tasks.listSessions(input.taskId),

    'leader.ensure': (input) => coordinator.ensureLeader(input.taskId),
    'terminal.attach': async (input) => coordinator.attachTerminal(input.sessionId),
    // Processos das abas Iniciar e Terminal usam o ptyId como sessionId.
    'terminal.write': async (input) =>
      taskProcesses.owns(input.sessionId)
        ? taskProcesses.write(input.sessionId, input.data)
        : coordinator.writeTerminal(input.sessionId, input.data),
    'terminal.resize': async (input) =>
      taskProcesses.owns(input.sessionId)
        ? taskProcesses.resize(input.sessionId, input.cols, input.rows)
        : coordinator.resizeTerminal(input.sessionId, input.cols, input.rows),

    'tasks.setStartCommand': async (input) =>
      tasks.setTaskStartCommand(input.taskId, input.command, input.dir),
    'taskProcess.attach': async (input) => taskProcesses.attach(input.taskId, input.kind),
    'taskProcess.start': (input) => taskProcesses.start(input.taskId, input.kind, input.restart),
    'taskProcess.stop': async (input) => taskProcesses.stop(input.taskId, input.kind),

    'questions.list': async (input) => tasks.listOpenQuestions(input.projectId),
    'questions.answer': (input) => coordinator.answerUserQuestion(input.questionId, input.answers),
    'questions.dismiss': (input) => coordinator.dismissUserQuestion(input.questionId),
  }
}
