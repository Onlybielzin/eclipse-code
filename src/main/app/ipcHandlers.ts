/**
 * Handlers dos comandos IPC da tela. A entrada ja chega validada pelo createIpcRouter
 * (schemas de @shared/ipc). Leitura vai ao TaskService; o que abre ou fecha agente vai
 * ao TeamCoordinator.
 */
import { homedir } from 'node:os'
import type { IpcCommandHandlers } from '@shared/ipc'
import type { AppServices } from './services'

export interface IpcHandlerOptions {
  /** Home do usuario devolvida em projects.summary. Padrao: os.homedir(). */
  homeDir?: string
}

export function createIpcHandlers(
  services: Pick<AppServices, 'tasks' | 'coordinator'>,
  options: IpcHandlerOptions = {},
): Omit<IpcCommandHandlers, 'app.info' | 'projects.pickFolder'> {
  const { tasks, coordinator } = services
  const homeDir = options.homeDir ?? homedir()
  return {
    'projects.list': async () => tasks.listProjects(),
    'projects.add': async (input) => tasks.addProject(input),
    'projects.remove': async (input) => tasks.removeProject(input.projectId),
    'projects.summary': async () => ({ homeDir, projects: tasks.summarizeProjects() }),

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
    'terminal.write': async (input) => coordinator.writeTerminal(input.sessionId, input.data),
    'terminal.resize': async (input) =>
      coordinator.resizeTerminal(input.sessionId, input.cols, input.rows),

    'questions.list': async (input) => tasks.listOpenQuestions(input.projectId),
    'questions.answer': (input) => coordinator.answerUserQuestion(input.questionId, input.answers),
    'questions.dismiss': (input) => coordinator.dismissUserQuestion(input.questionId),
  }
}
