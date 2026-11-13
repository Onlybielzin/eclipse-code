/**
 * Eclipse Code canvas cards: a question an agent asks the user, and the to-do list an agent keeps.
 * Both are canvas windows whose data lives in the node's persisted payload (task_json).
 */

export const QUESTION_CARD_MAX_QUESTIONS = 8
export const QUESTION_CARD_MAX_OPTIONS = 6
export const QUESTION_CARD_MAX_TEXT_CHARS = 4000
export const QUESTION_CARD_MAX_HEADER_CHARS = 24
export const TODO_CARD_MAX_ITEMS = 50
export const TODO_CARD_MAX_TEXT_CHARS = 300

export interface QuestionCardOption {
  label: string
  /** Cost or consequence of this choice, shown under the label. */
  detail: string
  recommended: boolean
}

export type QuestionCardStatus = 'pending' | 'answered'

/** One question inside a card. A card holds 1 to QUESTION_CARD_MAX_QUESTIONS of them. */
export interface QuestionCardItem {
  /** Stable inside the card (q1, q2, ...); answers refer to it. */
  id: string
  /** Short tab label, e.g. "Banco". Empty falls back to "Question N". */
  header: string
  question: string
  context: string
  options: QuestionCardOption[]
  /** The user may pick more than one option. */
  multiSelect: boolean
  allowOther: boolean
}

/** The user's answer to one question: chosen options, own text, or explicitly skipped. */
export interface QuestionCardItemAnswer {
  questionId: string
  /** Indexes into the question's options, ascending. */
  optionIndexes: number[]
  /** The user's own answer; empty when only options were chosen. */
  text: string
  /** "Let the agent decide": the agent gets "skipped", never an empty answer. */
  skipped: boolean
}

export interface QuestionCardData {
  questions: QuestionCardItem[]
  /** The agent that asked and receives the answers. */
  askedByNodeId: string | null
  status: QuestionCardStatus
  /** One entry per question, in question order; null while pending. */
  answers: QuestionCardItemAnswer[] | null
  answeredAt: string | null
  createdAt: string | null
}

export type TodoCardItemStatus = 'pending' | 'in_progress' | 'completed'

export interface TodoCardItem {
  text: string
  status: TodoCardItemStatus
  /** Optional detail (the task description). */
  note?: string
}

export interface TodosCardData {
  /** The agent whose list this card mirrors. One card per agent. */
  ownerNodeId: string | null
  items: TodoCardItem[]
  updatedAt: string | null
}

/** One answered question, kept after the card closes. */
export interface TaskDecisionRecord {
  id: string
  projectId: string
  spaceId: string | null
  questionNodeId: string
  askedByNodeId: string | null
  askedByTitle: string
  question: string
  answer: string
  answeredAt: string
}
