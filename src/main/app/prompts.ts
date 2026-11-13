/**
 * Textos que o app manda aos agentes: prompt do papel (com as variaveis de
 * PROMPT_TEMPLATE_VARIABLES), prompt do turno do membro e avisos ao Lider.
 * Funcoes puras, sem I/O.
 */
import {
  PROMPT_TEMPLATE_VARIABLES,
  type PromptTemplateVariable,
  type QuestionAnswer,
  type Subtask,
  type Task,
  type UserQuestion,
} from '@shared/domain'

export type PromptVariables = Partial<Record<PromptTemplateVariable, string>>

/** Troca {{variavel}} pelo valor. Variavel desconhecida ou sem valor vira ''. */
export function renderPromptTemplate(template: string, vars: PromptVariables): string {
  return template.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (match, name: string) => {
    const key = name.toLowerCase() as PromptTemplateVariable
    if (!(PROMPT_TEMPLATE_VARIABLES as readonly string[]).includes(key)) return match
    return vars[key] ?? ''
  })
}

export function taskPromptVariables(task: Task, cwd: string): PromptVariables {
  return { tarefa: task.title, worktree: cwd, branch: task.branch ?? '' }
}

const LEADER_TOOLS_HINT = [
  'Você é o Líder desta tarefa no Eclipse Code. Ferramentas do servidor MCP "eclipse":',
  '- subtarefa_criar (papel, titulo, instrucoes): abre um membro do time.',
  '- subtarefas_esperar: espera os membros pararem e devolve as entregas.',
  '- subtarefas_ver, subtarefa_responder, subtarefa_cancelar, pergunta_repassar.',
  'O app avisa neste terminal, com uma linha [eclipse], quando o turno de um membro acaba.',
].join('\n')

/** Prompt inicial do Lider: o prompt do papel com as variaveis da tarefa. */
export function composeLeaderPrompt(input: {
  task: Task
  cwd: string
  template: string | null
}): string {
  const vars = taskPromptVariables(input.task, input.cwd)
  const rendered = input.template ? renderPromptTemplate(input.template, vars).trim() : ''
  const parts = [rendered || LEADER_TOOLS_HINT]
  if (!rendered.includes(input.task.title)) parts.push(`Tarefa: ${input.task.title}`)
  return parts.join('\n\n')
}

/** Prompt de sistema do membro: o prompt do papel com as variaveis da subtarefa. */
export function composeMemberSystemPrompt(input: {
  task: Task
  subtask: Subtask
  cwd: string
  template: string
}): string {
  return renderPromptTemplate(input.template, {
    ...taskPromptVariables(input.task, input.cwd),
    subtarefa: input.subtask.title,
    instrucoes: input.subtask.instructions,
  }).trim()
}

const DELIVERY_RULE = [
  'Ao terminar, chame a ferramenta MCP `entregar` uma vez, com estado (pronto, duvida ou bloqueado),',
  'resumo, arquivos alterados e testes rodados. Se não conseguir chamar a ferramenta,',
  'termine a resposta com uma linha `STATUS: PRONTO`, `STATUS: DUVIDA` ou `STATUS: BLOQUEADO`.',
].join(' ')

/** Primeiro prompt do turno do membro (o subtarefa_criar do Lider). */
export function composeMemberFirstPrompt(subtask: Subtask, references: Subtask[]): string {
  const lines = [`Subtarefa ${subtask.id}: ${subtask.title}`, '', subtask.instructions.trim()]
  if (references.length > 0) {
    lines.push('', 'Esta subtarefa continua ou corrige:')
    for (const ref of references) {
      lines.push(`- ${ref.id} (${ref.title}): ${ref.statusMessage ?? 'sem resumo'}`)
    }
  }
  lines.push('', DELIVERY_RULE)
  return lines.join('\n')
}

/** Prompt do turno seguinte, quando o Lider (ou o usuario) responde uma duvida. */
export function composeMemberAnswerPrompt(text: string): string {
  return `Resposta à sua dúvida:\n\n${text.trim()}\n\n${DELIVERY_RULE}`
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** Aviso ao Lider de que o membro nao abriu (nao ha turno, entao o TeamTurnRelay nao avisa). */
export function composeSpawnFailureNotice(
  subtask: Subtask,
  roleName: string,
  reason: string,
): string {
  return `[eclipse] Subtarefa ${subtask.id} (${roleName}: ${oneLine(subtask.title, 80)}) não abriu: bloqueado. ${oneLine(reason, 280)} -> detalhes: subtarefas_ver`
}

/** Aviso ao Lider de que o processo do membro parou fora de turno (ex: em duvida). */
export function composeMemberStoppedNotice(subtask: Subtask, roleName: string): string {
  return `[eclipse] Subtarefa ${subtask.id} (${roleName}: ${oneLine(subtask.title, 80)}) parou: bloqueado (processo morreu fora de turno). -> detalhes: subtarefas_ver`
}

/** Aviso ao Lider de que a subtarefa sem turno aberto se perdeu quando o app reiniciou. */
export function composeSessionLostNotice(subtask: Subtask, roleName: string): string {
  return `[eclipse] Subtarefa ${subtask.id} (${roleName}: ${oneLine(subtask.title, 80)}) parou: bloqueado (sessão perdida ao reiniciar o app). -> detalhes: subtarefas_ver`
}

function answerText(question: UserQuestion, answers: readonly QuestionAnswer[]): string {
  return answers
    .map((answer) => {
      const item = question.items.find((i) => i.id === answer.itemId)
      const labels = answer.optionIds
        .map((id) => item?.options.find((o) => o.id === id)?.label ?? id)
        .filter(Boolean)
      const chosen = [...labels, ...(answer.text ? [answer.text] : [])].join(', ')
      return `${oneLine(item?.prompt ?? answer.itemId, 120)} -> ${oneLine(chosen || '(vazio)', 200)}`
    })
    .join(' | ')
}

/** Aviso ao Lider quando o usuario responde ou descarta uma pergunta de "Precisa de você". */
export function composeQuestionNotice(question: UserQuestion): string {
  const target = question.subtaskId ? ` (subtarefa ${question.subtaskId})` : ''
  if (question.status === 'dismissed' || !question.answers) {
    return `[eclipse] O usuário deixou a decisão com você na pergunta ${question.id}${target}.`
  }
  return `[eclipse] O usuário respondeu a pergunta ${question.id}${target}: ${answerText(question, question.answers)}`
}
