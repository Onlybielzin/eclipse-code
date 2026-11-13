import {
  QUESTION_CARD_MAX_HEADER_CHARS,
  QUESTION_CARD_MAX_OPTIONS,
  QUESTION_CARD_MAX_QUESTIONS,
  QUESTION_CARD_MAX_TEXT_CHARS,
  TODO_CARD_MAX_ITEMS,
  TODO_CARD_MAX_TEXT_CHARS,
  type QuestionCardData,
  type QuestionCardItem,
  type QuestionCardItemAnswer,
  type QuestionCardOption,
  type TodoCardItem,
  type TodoCardItemStatus,
  type TodosCardData,
} from '../../../shared/contracts/canvasCards'

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function cleanText(value: unknown, maxChars: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxChars).trim() : ''
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

function normalizeOptions(value: unknown): QuestionCardOption[] {
  if (!Array.isArray(value)) {
    return []
  }
  let recommendedSeen = false
  return value
    .filter(isRecord)
    .map(option => {
      const recommended = option.recommended === true && !recommendedSeen
      recommendedSeen ||= recommended
      return {
        label: cleanText(option.label, QUESTION_CARD_MAX_TEXT_CHARS),
        detail: cleanText(option.detail, QUESTION_CARD_MAX_TEXT_CHARS),
        recommended,
      }
    })
    .filter(option => option.label.length > 0)
}

function questionId(index: number): string {
  return `q${index + 1}`
}

function normalizeItem(record: Record<string, unknown>, index: number): QuestionCardItem {
  return {
    id: cleanText(record.id, 32) || questionId(index),
    header: cleanText(record.header, QUESTION_CARD_MAX_HEADER_CHARS),
    question: cleanText(record.question, QUESTION_CARD_MAX_TEXT_CHARS),
    context: cleanText(record.context, QUESTION_CARD_MAX_TEXT_CHARS),
    options: normalizeOptions(record.options),
    multiSelect: record.multiSelect === true,
    allowOther: record.allowOther !== false,
  }
}

/** The questions of a raw payload: the `questions` list, or the older single-question fields. */
function rawQuestionItems(record: Record<string, unknown>): Record<string, unknown>[] {
  if (Array.isArray(record.questions)) {
    return record.questions.filter(isRecord)
  }
  return typeof record.question === 'string' ? [record] : []
}

export type QuestionCardInput = Pick<QuestionCardData, 'questions'>

/** Strict read of what an agent sends: every question needs text and 1..6 options. */
export function normalizeQuestionCardInput(
  raw: unknown,
): { ok: true; value: QuestionCardInput } | { ok: false; reason: string } {
  const record = isRecord(raw) ? raw : {}
  const rawItems = rawQuestionItems(record)
  if (rawItems.length === 0) {
    return { ok: false, reason: 'O card precisa de pelo menos uma pergunta.' }
  }
  if (rawItems.length > QUESTION_CARD_MAX_QUESTIONS) {
    return { ok: false, reason: `No máximo ${QUESTION_CARD_MAX_QUESTIONS} perguntas por card.` }
  }
  const questions: QuestionCardItem[] = []
  for (const [index, rawItem] of rawItems.entries()) {
    // Ids are the card's own, never the agent's: answers must match them exactly.
    const item = normalizeItem({ ...rawItem, id: undefined }, index)
    if (!item.question) {
      return { ok: false, reason: `A pergunta ${index + 1} precisa de texto (question).` }
    }
    if (item.options.length === 0) {
      return {
        ok: false,
        reason: `A pergunta ${index + 1} precisa de pelo menos uma opção com label.`,
      }
    }
    if (Array.isArray(rawItem.options) && rawItem.options.length > QUESTION_CARD_MAX_OPTIONS) {
      return { ok: false, reason: `No máximo ${QUESTION_CARD_MAX_OPTIONS} opções por pergunta.` }
    }
    questions.push(item)
  }
  return { ok: true, value: { questions } }
}

/**
 * One agent keeps one waiting card: new questions join it with the next ids (q4, q5, ...).
 * Null when the card is answered or the questions would not fit; then a new card opens.
 */
export function appendQuestionsToCard(
  data: QuestionCardData,
  questions: readonly QuestionCardItem[],
): QuestionCardData | null {
  if (data.status !== 'pending') {
    return null
  }
  if (data.questions.length + questions.length > QUESTION_CARD_MAX_QUESTIONS) {
    return null
  }
  const used = new Set(data.questions.map(item => item.id))
  let next = data.questions.length
  const appended = questions.map(item => {
    let id = questionId(next)
    while (used.has(id)) {
      next += 1
      id = questionId(next)
    }
    used.add(id)
    next += 1
    return { ...item, id }
  })
  return { ...data, questions: [...data.questions, ...appended] }
}

function ensureAnswer(value: unknown): QuestionCardItemAnswer | null {
  if (!isRecord(value) || typeof value.questionId !== 'string') {
    return null
  }
  return {
    questionId: value.questionId,
    optionIndexes: Array.isArray(value.optionIndexes)
      ? value.optionIndexes.filter((entry): entry is number => Number.isInteger(entry))
      : [],
    text: typeof value.text === 'string' ? value.text : '',
    skipped: value.skipped === true,
  }
}

/** Answers of a raw payload: the `answers` list, or the older single `answer`. */
function ensureAnswers(
  record: Record<string, unknown>,
  questions: QuestionCardItem[],
): QuestionCardItemAnswer[] | null {
  if (Array.isArray(record.answers)) {
    const answers = record.answers.map(ensureAnswer).filter(answer => answer !== null)
    return answers.length > 0 ? answers : null
  }
  if (isRecord(record.answer) && questions.length === 1) {
    const optionIndex = record.answer.optionIndex
    return [
      {
        questionId: questions[0].id,
        optionIndexes:
          typeof optionIndex === 'number' && Number.isInteger(optionIndex) ? [optionIndex] : [],
        text: typeof record.answer.text === 'string' ? record.answer.text : '',
        skipped: false,
      },
    ]
  }
  return null
}

/** Lenient read of a persisted payload: repair fields rather than lose the card. */
export function ensureQuestionCardData(value: unknown): QuestionCardData {
  const record = isRecord(value) ? value : {}
  const questions = rawQuestionItems(record)
    .slice(0, QUESTION_CARD_MAX_QUESTIONS)
    .map((item, index) => normalizeItem(item, index))
  const answers = ensureAnswers(record, questions)
  const status = record.status === 'answered' && answers ? 'answered' : 'pending'
  return {
    questions,
    askedByNodeId: nullableString(record.askedByNodeId),
    status,
    answers: status === 'answered' ? answers : null,
    answeredAt: status === 'answered' ? nullableString(record.answeredAt) : null,
    createdAt: nullableString(record.createdAt),
  }
}

export type QuestionAnswerRefusal =
  | 'already_answered'
  | 'invalid_option'
  | 'empty_answer'
  | 'other_not_allowed'
  | 'missing_answer'
  | 'unknown_question'

export interface QuestionAnswerInput {
  answers?: Array<{
    questionId: string
    optionIndexes?: number[] | null
    text?: string | null
    skipped?: boolean | null
  }> | null
  /** Older single-question shape: one option or the user's text. */
  optionIndex?: number | null
  text?: string | null
}

type ResolvedItem =
  | { ok: true; answer: QuestionCardItemAnswer; answerText: string | null }
  | { ok: false; reason: QuestionAnswerRefusal }

function resolveItem(
  item: QuestionCardItem,
  input: { optionIndexes?: number[] | null; text?: string | null; skipped?: boolean | null },
): ResolvedItem {
  if (input.skipped === true) {
    return {
      ok: true,
      answer: { questionId: item.id, optionIndexes: [], text: '', skipped: true },
      answerText: null,
    }
  }
  const optionIndexes = [...new Set(input.optionIndexes ?? [])].sort((a, b) => a - b)
  if (optionIndexes.some(index => !Number.isInteger(index) || !item.options[index])) {
    return { ok: false, reason: 'invalid_option' }
  }
  const text = cleanText(input.text, QUESTION_CARD_MAX_TEXT_CHARS)
  if (optionIndexes.length === 0 && !text) {
    return { ok: false, reason: 'empty_answer' }
  }
  // A single-choice question takes exactly one thing: one option or the user's own text.
  if (!item.multiSelect && optionIndexes.length + (text ? 1 : 0) > 1) {
    return { ok: false, reason: 'invalid_option' }
  }
  if (text && !item.allowOther) {
    return { ok: false, reason: 'other_not_allowed' }
  }
  const labels = optionIndexes.map(index => item.options[index].label).join(', ')
  return {
    ok: true,
    answer: { questionId: item.id, optionIndexes, text, skipped: false },
    answerText: [labels, text].filter(Boolean).join('; '),
  }
}

/**
 * Every question gets exactly one answer, sent together. Returns the stored answers and, per
 * question, the text the agent reads (null = skipped, the agent decides).
 */
export function resolveQuestionAnswer(
  data: QuestionCardData,
  input: QuestionAnswerInput,
):
  | { ok: true; answers: QuestionCardItemAnswer[]; answerTexts: Array<string | null> }
  | { ok: false; reason: QuestionAnswerRefusal } {
  if (data.status === 'answered') {
    return { ok: false, reason: 'already_answered' }
  }
  const given =
    input.answers ??
    (data.questions.length === 1
      ? [
          {
            questionId: data.questions[0].id,
            optionIndexes: typeof input.optionIndex === 'number' ? [input.optionIndex] : [],
            text: typeof input.optionIndex === 'number' ? '' : input.text,
          },
        ]
      : [])
  const known = new Set(data.questions.map(item => item.id))
  if (given.some(entry => !known.has(entry.questionId))) {
    return { ok: false, reason: 'unknown_question' }
  }
  const answers: QuestionCardItemAnswer[] = []
  const answerTexts: Array<string | null> = []
  for (const item of data.questions) {
    const entries = given.filter(entry => entry.questionId === item.id)
    if (entries.length !== 1) {
      return { ok: false, reason: 'missing_answer' }
    }
    const resolved = resolveItem(item, entries[0])
    if (!resolved.ok) {
      return resolved
    }
    answers.push(resolved.answer)
    answerTexts.push(resolved.answerText)
  }
  return { ok: true, answers, answerTexts }
}

const SKIPPED_ANSWER_TEXT = 'pulada (você decide)'

/** What one answer reads like in the decision history and in the agent's message. */
export function describeAnswer(answerText: string | null): string {
  return answerText ?? SKIPPED_ANSWER_TEXT
}

/** The message the asking agent receives, written for the agent (Portuguese, like its prompt). */
export function composeAnswerPrompt(
  data: QuestionCardData,
  answerTexts: ReadonlyArray<string | null>,
): string {
  if (data.questions.length === 1) {
    return [
      `[pergunta respondida] ${data.questions[0].question}`,
      `Resposta do vings: ${describeAnswer(answerTexts[0] ?? null)}`,
      'Siga com essa decisão.',
    ].join('\n')
  }
  return [
    `[perguntas respondidas] ${data.questions.length} perguntas`,
    ...data.questions.map((item, index) => {
      const label = item.header ? `${item.header}: ` : ''
      return `${index + 1}. ${label}${item.question} -> ${describeAnswer(answerTexts[index] ?? null)}`
    }),
    'Siga com essas decisões.',
  ].join('\n')
}

/**
 * An answered question leaves the canvas right away: the agent already has the answers and the
 * decisions are kept in the task history.
 */
export function isQuestionCardClosable(data: QuestionCardData): boolean {
  return data.status === 'answered'
}

function normalizeTodoStatus(value: unknown): TodoCardItemStatus | null {
  if (value === 'completed' || value === 'in_progress') {
    return value
  }
  if (value === 'deleted') {
    return null
  }
  return 'pending'
}

/**
 * Reads the shapes Claude Code uses: TodoWrite ({content, status, activeForm}) and the task list
 * ({subject, status}). Unknown statuses count as pending; deleted items and empty text are dropped.
 */
export function normalizeTodoItems(value: unknown): TodoCardItem[] {
  if (!Array.isArray(value)) {
    return []
  }
  const items: TodoCardItem[] = []
  for (const raw of value) {
    if (!isRecord(raw)) {
      continue
    }
    const status = normalizeTodoStatus(raw.status)
    const text = cleanText(raw.text ?? raw.content ?? raw.subject, TODO_CARD_MAX_TEXT_CHARS)
    if (status && text) {
      items.push({ text, status })
    }
    if (items.length >= TODO_CARD_MAX_ITEMS) {
      break
    }
  }
  return items
}

export function ensureTodosCardData(value: unknown): TodosCardData {
  const record = isRecord(value) ? value : {}
  return {
    ownerNodeId: nullableString(record.ownerNodeId),
    items: normalizeTodoItems(record.items),
    updatedAt: nullableString(record.updatedAt),
  }
}

export function summarizeTodoProgress(items: readonly TodoCardItem[]): {
  done: number
  total: number
} {
  return { done: items.filter(item => item.status === 'completed').length, total: items.length }
}
