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
  '- tarefa_concluir (resumo): declara a tarefa terminada.',
  'O app avisa quando o turno de um membro acaba: linha [eclipse] no terminal ou contexto do gancho.',
].join('\n')

/**
 * Regra de fim do Lider. Vai sempre no prompt do Lider (prompt de sistema no Claude, inicial no Codex), mesmo com prompt de papel proprio,
 * porque e o unico jeito de a tarefa ir para "Em revisão".
 */
export const LEADER_FINISH_RULE = [
  'Quando todo o trabalho da tarefa estiver pronto e verificado, chame a ferramenta MCP',
  '`tarefa_concluir` uma vez, com um resumo do que foi entregue. A tarefa vai para "Em revisão"',
  'do usuário. Não chame com pergunta ao usuário sem resposta. Só o usuário marca',
  '"Pronto pra lançar" e "Concluída".',
].join(' ')

const LEADER_NO_WORKTREE_LINE =
  'Esta tarefa não tem worktree: você e os membros rodam na pasta do projeto, na branch atual. Não crie worktree nem branch sem o vings pedir. Os membros dividem a mesma pasta.'

/**
 * Contexto do app que vai SEMPRE no fim do prompt do Lider. Os prompts importados do app
 * antigo (com canvas) falam de card, Space, janela e ferramentas que nao existem mais;
 * este bloco diz o que vale aqui, para o Lider nao procurar o que nao existe.
 */
export function leaderAppContext(withWorktree: boolean): string {
  return [
    '## Como é o app (vale mais que qualquer instrução acima)',
    'Você está no Eclipse Code novo, que NÃO tem canvas. Não existem card no canvas, Space,',
    'janela de agente, aba + nem as ferramentas pergunta_criar, perguntas_historico,',
    'agente_criar, agente_mensagem, agentes_esperar, agente_ler, agente_encerrar e',
    'feature_criar_space. Se o texto acima citar algo disso, use o equivalente:',
    '- Perguntar ao usuário: pergunta_repassar. O cartão aparece em cima do seu terminal',
    '  e no botão "precisa de você" do topo. Depois de repassar, termine o turno.',
    '- Abrir um membro do time: subtarefa_criar (papel, titulo, instrucoes).',
    '- Esperar membros e ler as entregas: subtarefas_esperar; ver a lista: subtarefas_ver.',
    '- Responder a dúvida de um membro: subtarefa_responder. Parar um membro: subtarefa_cancelar.',
    withWorktree
      ? '- A worktree e a branch desta tarefa já existem e são a sua pasta atual. Não crie outra.'
      : `- ${LEADER_NO_WORKTREE_LINE}`,
    '- Subtarefa pronta, bloqueada ou cancelada é final. Não precisa cancelar nem esconder:',
    '  o app guarda as bloqueadas e canceladas num grupo recolhido. Para refazer, crie outra.',
    '- Quando um membro termina o turno, o aviso [eclipse] chega como contexto do gancho (Claude) ou como linha no terminal (Codex).',
    '- Se o app reiniciar, subtarefas em andamento param e você recebe aviso: responda com',
    '  subtarefa_responder para retomar ou cancele com subtarefa_cancelar.',
    '- Ao terminar tudo: tarefa_concluir (resumo). A tarefa vai para "Em revisão".',
  ].join('\n')
}

export const LEADER_APP_CONTEXT = leaderAppContext(true)

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
  if (!rendered.includes('tarefa_concluir')) parts.push(LEADER_FINISH_RULE)
  if (rendered) parts.push(leaderAppContext(input.task.worktreePath !== null))
  else if (input.task.worktreePath === null) parts.push(LEADER_NO_WORKTREE_LINE)
  return parts.join('\n\n')
}

/** Primeira mensagem visivel do Lider Claude; o papel inteiro vai no prompt de sistema. */
export function composeLeaderKickoff(task: Task): string {
  return `Tarefa: ${task.title.replace(/\s*[\r\n]+\s*/g, ' ').trim()}. Comece.`
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

/**
 * Primeiro prompt do membro reaberto na MESMA conversa (session/load) depois do reinicio:
 * ele ja tem o contexto, so falta a mensagem do Lider.
 */
export function composeMemberResumePrompt(text: string, withWorktree = true): string {
  return `O app reiniciou e você parou no meio desta subtarefa. A conversa foi retomada; o que você já alterou continua ${withWorktree ? 'na worktree' : 'na pasta do projeto'}. Mensagem do Líder:\n\n${text.trim()}\n\n${DELIVERY_RULE}`
}

const MAX_PROGRESS_CHARS = 4_000

/**
 * Primeiro prompt do membro reaberto em conversa NOVA (sem providerSessionId ou o
 * session/load falhou): leva titulo, instrucoes originais, o resumo do que ja foi feito e a
 * mensagem do Lider.
 */
export function composeMemberReopenPrompt(input: {
  subtask: Subtask
  progress: string
  answer: string
}): string {
  const { subtask } = input
  const progress = input.progress.trim()
  const clipped =
    progress.length > MAX_PROGRESS_CHARS ? `…${progress.slice(-MAX_PROGRESS_CHARS)}` : progress
  return [
    `Subtarefa ${subtask.id}: ${subtask.title}`,
    '',
    'O app reiniciou no meio desta subtarefa e a conversa anterior não pôde ser retomada.',
    'O que já foi alterado continua na worktree: confira os arquivos antes de seguir.',
    '',
    'Instruções originais:',
    subtask.instructions.trim(),
    '',
    'O que já foi feito (último relato do membro anterior):',
    clipped || '(nada registrado)',
    '',
    'Mensagem do Líder:',
    input.answer.trim(),
    '',
    DELIVERY_RULE,
  ].join('\n')
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

/**
 * Aviso ao Lider de que a subtarefa parou porque o app reiniciou (com ou sem turno aberto).
 * Um por subtarefa: o fim de turno fechado pela recuperacao nao gera outro.
 */
export function composeSessionLostNotice(subtask: Subtask, roleName: string): string {
  return `[eclipse] O app reiniciou e a subtarefa ${subtask.id} (${roleName}: ${oneLine(subtask.title, 80)}) parou no meio. O que o membro já alterou continua na worktree. Para continuar: subtarefa_responder com o que ele deve fazer (o app reabre o membro na mesma conversa). Para encerrar: subtarefa_cancelar.`
}

/** Aviso ao Lider retomado cuja tarefa nao teve subtarefa parada. */
export function composeLeaderResumedNotice(): string {
  return '[eclipse] O app reiniciou e esta sessão foi retomada. Nenhuma subtarefa parou. Continue de onde parou só se houver trabalho pendente; não comece nada novo sem pedido.'
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
