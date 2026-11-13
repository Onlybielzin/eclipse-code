import {
  DELIVERY_STATE_LABELS,
  DomainError,
  isFinalSubtaskState,
  TASK_WORKFLOW_STATUS_LABELS,
  SUBTASK_STATE_LABELS,
  type Artifact,
  type JsonObject,
  type Subtask,
  type SubtaskId,
  type SubtaskState,
} from '@shared/domain'
import {
  deliveryFromEntregar,
  MCP_TOOL_ROLES,
  MCP_WAIT_DEFAULT_SECONDS,
  mcpToolInputSchemas,
  type McpCaller,
  type McpToolInput,
  type McpToolName,
  type McpToolResult,
} from '@shared/mcp'
import type { McpToolHandler, TaskService } from '@shared/ports'

/**
 * Operacoes com efeito fora do banco (abrir, retomar ou parar o membro). Quem
 * implementa e o TeamCoordinator (tasks/); o handler so valida, autoriza e chama.
 */
export interface McpTeamActions {
  createSubtask(
    caller: McpCaller,
    input: { roleId: string; title: string; instructions: string; referenceTaskIds: SubtaskId[] },
  ): Promise<Subtask>
  answerSubtask(caller: McpCaller, subtaskId: SubtaskId, text: string): Promise<Subtask>
  cancelSubtask(caller: McpCaller, subtaskId: SubtaskId, reason: string | null): Promise<Subtask>
}

export interface McpToolHandlerDeps {
  tasks: TaskService
  actions: McpTeamActions
}

export interface DisposableMcpToolHandler extends McpToolHandler {
  /** Solta quem esta em subtarefas_esperar (fecha com o resultado atual). */
  dispose(): void
}

/** A subtarefa parou: o Lider tem algo a fazer com ela. */
export function isStoppedState(state: SubtaskState): boolean {
  return state !== 'submitted' && state !== 'working'
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/**
 * Implementa as ferramentas MCP no main. Valida com mcpToolInputSchemas, confere
 * MCP_TOOL_ROLES contra o papel do token e garante que toda subtarefa citada e
 * da tarefa do chamador. Nao grava direto: le e escreve pelo TaskService ou pelas
 * McpTeamActions.
 */
export function createMcpToolHandler(deps: McpToolHandlerDeps): DisposableMcpToolHandler {
  const { tasks, actions } = deps
  const waiters = new Set<() => void>()

  const ownSubtask = (caller: McpCaller, id: SubtaskId): Subtask => {
    const subtask = tasks.getSubtask(id)
    if (subtask.taskId !== caller.taskId) {
      throw new DomainError('not_found', `subtarefa ${id} nao existe nesta tarefa`)
    }
    return subtask
  }

  const roleName = (roleId: string): string => {
    try {
      return tasks.getRole(roleId).name
    } catch {
      return roleId
    }
  }

  const lastArtifact = (id: SubtaskId): Artifact | null => {
    const artifacts = tasks.getSubtaskDetail(id).artifacts
    return artifacts.length > 0 ? (artifacts[artifacts.length - 1] ?? null) : null
  }

  const subtaskSummary = (subtask: Subtask): JsonObject => ({
    id: subtask.id,
    titulo: subtask.title,
    papel: roleName(subtask.roleId),
    estado: SUBTASK_STATE_LABELS[subtask.state],
    resumo: subtask.statusMessage,
    origem: subtask.referenceTaskIds,
  })

  const deliveryData = (subtask: Subtask): JsonObject => {
    const artifact = lastArtifact(subtask.id)
    const base = subtaskSummary(subtask)
    if (!artifact) return { ...base, entrega: null }
    const d = artifact.delivery
    return {
      ...base,
      entrega: {
        estado: DELIVERY_STATE_LABELS[d.state],
        formato: artifact.format === 'structured' ? 'estruturada' : 'sem formato',
        resumo: d.summary,
        arquivos: d.files.map((f) => ({
          caminho: f.path,
          mudanca: f.change,
          nota: f.note ?? null,
        })),
        testes: d.tests.map((t) => ({ comando: t.command, resultado: t.result, passou: t.passed })),
        perguntas: d.questions.map((q) => ({
          id: q.id,
          pergunta: q.prompt,
          opcoes: q.options.map((o) => o.label),
        })),
      },
    }
  }

  const deliveryLine = (subtask: Subtask): string => {
    const artifact = lastArtifact(subtask.id)
    const summary = artifact?.delivery.summary ?? subtask.statusMessage ?? '(sem resumo)'
    const files = artifact ? artifact.delivery.files.length : 0
    const tests = artifact ? artifact.delivery.tests.length : 0
    return `- ${subtask.id} [${SUBTASK_STATE_LABELS[subtask.state]}] ${subtask.title} (${roleName(subtask.roleId)}): ${oneLine(summary, 400)}${artifact ? ` | arquivos: ${files}, testes: ${tests}` : ''}`
  }

  const run = {
    async subtarefa_criar(caller: McpCaller, input: McpToolInput<'subtarefa_criar'>) {
      const task = tasks.getTask(caller.taskId)
      const role = tasks.findRoleByName(task.projectId, input.papel)
      if (!role) {
        const names = tasks
          .listRoles(task.projectId)
          .filter((r) => !r.isLead)
          .map((r) => r.name)
        throw new DomainError(
          'not_found',
          `papel "${input.papel}" nao existe. Papeis do projeto: ${names.join(', ') || '(nenhum)'}`,
        )
      }
      if (role.isLead) throw new DomainError('invalid_input', 'o papel de Lider nao vira membro')
      const origem = input.origem ?? []
      for (const id of origem) ownSubtask(caller, id)
      const subtask = await actions.createSubtask(caller, {
        roleId: role.id,
        title: input.titulo,
        instructions: input.instrucoes,
        referenceTaskIds: origem,
      })
      return {
        text: `Subtarefa ${subtask.id} criada para ${role.name} (${SUBTASK_STATE_LABELS[subtask.state]}). O app avisa neste terminal quando o turno do membro acabar; para esperar, use subtarefas_esperar.`,
        data: subtaskSummary(subtask),
      }
    },

    async entregar(caller: McpCaller, input: McpToolInput<'entregar'>) {
      if (caller.subtaskId === null) {
        throw new DomainError('forbidden', 'so um membro com subtarefa entrega')
      }
      const artifact = tasks.recordDelivery(caller.sessionId, deliveryFromEntregar(input))
      return {
        text: `Entrega gravada (${DELIVERY_STATE_LABELS[artifact.delivery.state]}). Encerre o turno agora; o Lider recebe o aviso.`,
        data: { entrega_id: artifact.id, subtarefa_id: artifact.subtaskId },
      }
    },

    async subtarefa_responder(caller: McpCaller, input: McpToolInput<'subtarefa_responder'>) {
      const current = ownSubtask(caller, input.subtarefa_id)
      if (current.state !== 'input_required') {
        throw new DomainError(
          'invalid_transition',
          `subtarefa ${current.id} esta ${SUBTASK_STATE_LABELS[current.state]}; so se responde uma em dúvida`,
        )
      }
      const subtask = await actions.answerSubtask(caller, current.id, input.texto)
      return {
        text: `Resposta enviada a ${subtask.id}. O membro continua na mesma sessão.`,
        data: subtaskSummary(subtask),
      }
    },

    async subtarefa_cancelar(caller: McpCaller, input: McpToolInput<'subtarefa_cancelar'>) {
      const current = ownSubtask(caller, input.subtarefa_id)
      if (isFinalSubtaskState(current.state)) {
        throw new DomainError(
          'final_state',
          `subtarefa ${current.id} ja esta ${SUBTASK_STATE_LABELS[current.state]} e nao muda`,
        )
      }
      const subtask = await actions.cancelSubtask(caller, current.id, input.motivo ?? null)
      return { text: `Subtarefa ${subtask.id} cancelada.`, data: subtaskSummary(subtask) }
    },

    async subtarefas_ver(caller: McpCaller, input: McpToolInput<'subtarefas_ver'>) {
      if (input.subtarefa_id) {
        const subtask = ownSubtask(caller, input.subtarefa_id)
        const detail = tasks.getSubtaskDetail(subtask.id)
        const data: JsonObject = {
          ...deliveryData(subtask),
          instrucoes: subtask.instructions,
          entregas: detail.artifacts.length,
          turnos: detail.turns.length,
        }
        return { text: `${deliveryLine(subtask)}\n\n${JSON.stringify(data, null, 2)}`, data }
      }
      const list = tasks.listSubtasks(caller.taskId)
      if (list.length === 0)
        return { text: 'Nenhuma subtarefa nesta tarefa.', data: { subtarefas: [] } }
      return {
        text: list.map(deliveryLine).join('\n'),
        data: { subtarefas: list.map(subtaskSummary) },
      }
    },

    subtarefas_esperar(caller: McpCaller, input: McpToolInput<'subtarefas_esperar'>) {
      const ids =
        input.subtarefa_ids ??
        tasks
          .listSubtasks(caller.taskId)
          .filter((s) => !isStoppedState(s.state))
          .map((s) => s.id)
      const unique = [...new Set(ids)]
      for (const id of unique) ownSubtask(caller, id)
      const mode = input.modo ?? 'todas'
      const timeoutMs = (input.timeout_segundos ?? MCP_WAIT_DEFAULT_SECONDS) * 1000

      const build = (timedOut: boolean): McpToolResult => {
        const current = unique.map((id) => tasks.getSubtask(id))
        const waiting = current.filter((s) => !isStoppedState(s.state))
        const head = timedOut
          ? `Prazo acabou; ${waiting.length} de ${current.length} ainda em andamento.`
          : `${current.length - waiting.length} de ${current.length} pararam.`
        return {
          text: [head, ...current.map(deliveryLine)].join('\n'),
          data: { prazo_acabou: timedOut, subtarefas: current.map(deliveryData) },
        }
      }
      if (unique.length === 0) {
        return Promise.resolve({
          text: 'Nenhuma subtarefa em andamento para esperar.',
          data: { prazo_acabou: false, subtarefas: [] },
        })
      }

      return new Promise<McpToolResult>((resolve) => {
        const watched = new Set(unique)
        let done = false
        let timer: ReturnType<typeof setTimeout> | null = null
        // Assina antes de ler o estado para nao perder evento entre a leitura e a assinatura.
        const unsubscribe = tasks.subscribe((envelope) => {
          if (
            envelope.event.type === 'subtask.upserted' &&
            watched.has(envelope.event.subtask.id)
          ) {
            check()
          }
        })
        const finish = (timedOut: boolean) => {
          if (done) return
          done = true
          unsubscribe()
          if (timer) clearTimeout(timer)
          waiters.delete(release)
          let result: McpToolResult
          try {
            result = build(timedOut)
          } catch (error) {
            result = {
              text: `Erro ao montar o resultado: ${error instanceof Error ? error.message : String(error)}`,
              isError: true,
            }
          }
          resolve(result)
        }
        const release = () => finish(true)
        function check() {
          const states = unique.map((id) => tasks.getSubtask(id).state)
          const stopped = states.filter(isStoppedState).length
          if (mode === 'qualquer' ? stopped > 0 : stopped === states.length) finish(false)
        }
        waiters.add(release)
        timer = setTimeout(() => finish(true), timeoutMs)
        check()
      })
    },

    async pergunta_repassar(caller: McpCaller, input: McpToolInput<'pergunta_repassar'>) {
      if (input.subtarefa_id) ownSubtask(caller, input.subtarefa_id)
      const question = tasks.createQuestion({
        taskId: caller.taskId,
        subtaskId: input.subtarefa_id ?? null,
        items: input.itens,
      })
      return {
        text: `Pergunta ${question.id} repassada ao usuário em "Precisa de você". O app avisa quando ele responder.`,
        data: { pergunta_id: question.id },
      }
    },

    async tarefa_concluir(caller: McpCaller, input: McpToolInput<'tarefa_concluir'>) {
      if (caller.role !== 'leader' || caller.subtaskId !== null) {
        throw new DomainError('forbidden', 'so o Lider conclui a tarefa')
      }
      const task = tasks.concludeTask(caller.taskId)
      return {
        text: `Tarefa marcada como "${TASK_WORKFLOW_STATUS_LABELS[task.workflowStatus]}". O usuário revisa e decide quando lançar.`,
        data: { tarefa_id: task.id, status: task.workflowStatus, resumo: input.resumo },
      }
    },
  } satisfies {
    [N in McpToolName]: (caller: McpCaller, input: McpToolInput<N>) => Promise<McpToolResult>
  }

  return {
    async callTool(caller, name, args) {
      if (!MCP_TOOL_ROLES[name].includes(caller.role)) {
        throw new DomainError(
          'forbidden',
          `${name} nao e permitida para ${caller.role === 'leader' ? 'o Lider' : 'um membro'}`,
        )
      }
      const parsed = mcpToolInputSchemas[name].safeParse(args ?? {})
      if (!parsed.success) {
        throw new DomainError(
          'invalid_input',
          parsed.error.issues
            .map((i) => `${i.path.join('.') || '(raiz)'}: ${i.message}`)
            .join('; '),
        )
      }
      const fn = run[name] as (caller: McpCaller, input: unknown) => Promise<McpToolResult>
      return fn(caller, parsed.data)
    },
    dispose() {
      for (const release of [...waiters]) release()
    },
  }
}
