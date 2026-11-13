import type { QuestionCardItem } from '@shared/contracts/canvasCards'

/**
 * What the user picked before sending. Lives only in the renderer (and in localStorage, so a
 * reload keeps it); the Worker sees nothing until every question has an answer and the user sends.
 */
export interface QuestionDraftEntry {
  optionIndexes: number[]
  text: string
  skipped: boolean
}

export type QuestionDraft = Record<string, QuestionDraftEntry>

const EMPTY_ENTRY: QuestionDraftEntry = { optionIndexes: [], text: '', skipped: false }

export function draftEntry(draft: QuestionDraft, questionId: string): QuestionDraftEntry {
  return draft[questionId] ?? EMPTY_ENTRY
}

export function isDraftEntryAnswered(entry: QuestionDraftEntry): boolean {
  return entry.skipped || entry.optionIndexes.length > 0 || entry.text.trim().length > 0
}

export function countAnswered(questions: readonly QuestionCardItem[], draft: QuestionDraft) {
  return questions.filter(item => isDraftEntryAnswered(draftEntry(draft, item.id))).length
}

/** Multi-select toggles; single-select replaces the choice and clears the user's own text. */
export function toggleDraftOption(
  draft: QuestionDraft,
  item: QuestionCardItem,
  index: number,
): QuestionDraft {
  const entry = draftEntry(draft, item.id)
  const next: QuestionDraftEntry = item.multiSelect
    ? {
        ...entry,
        skipped: false,
        optionIndexes: entry.optionIndexes.includes(index)
          ? entry.optionIndexes.filter(value => value !== index)
          : [...entry.optionIndexes, index].sort((a, b) => a - b),
      }
    : { optionIndexes: [index], text: '', skipped: false }
  return { ...draft, [item.id]: next }
}

/** Single-select: typing an own answer replaces the chosen option. */
export function setDraftText(
  draft: QuestionDraft,
  item: QuestionCardItem,
  text: string,
): QuestionDraft {
  const entry = draftEntry(draft, item.id)
  const optionIndexes = item.multiSelect || text.trim().length === 0 ? entry.optionIndexes : []
  return { ...draft, [item.id]: { optionIndexes, text, skipped: false } }
}

export function toggleDraftSkip(draft: QuestionDraft, item: QuestionCardItem): QuestionDraft {
  const entry = draftEntry(draft, item.id)
  return {
    ...draft,
    [item.id]: entry.skipped ? EMPTY_ENTRY : { optionIndexes: [], text: '', skipped: true },
  }
}

/** The question.answer payload; text the agent did not allow is left out. */
export function draftToAnswers(questions: readonly QuestionCardItem[], draft: QuestionDraft) {
  return questions.map(item => {
    const entry = draftEntry(draft, item.id)
    if (entry.skipped) {
      return { questionId: item.id, skipped: true }
    }
    const text = item.allowOther ? entry.text.trim() : ''
    return {
      questionId: item.id,
      optionIndexes: entry.optionIndexes,
      ...(text ? { text } : {}),
    }
  })
}

/** The next question without an answer after `from`, wrapping; null when all are answered. */
export function nextUnansweredIndex(
  questions: readonly QuestionCardItem[],
  draft: QuestionDraft,
  from: number,
): number | null {
  for (let step = 1; step <= questions.length; step += 1) {
    const index = (from + step) % questions.length
    if (!isDraftEntryAnswered(draftEntry(draft, questions[index].id))) {
      return index
    }
  }
  return null
}

const STORAGE_PREFIX = 'eclipse-code:question-draft:'

export function loadQuestionDraft(nodeId: string): QuestionDraft {
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + nodeId)
    const parsed: unknown = raw ? JSON.parse(raw) : null
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {}
    }
    const draft: QuestionDraft = {}
    for (const [questionId, value] of Object.entries(parsed as Record<string, unknown>)) {
      const entry = (value ?? {}) as Partial<Record<keyof QuestionDraftEntry, unknown>>
      draft[questionId] = {
        optionIndexes: Array.isArray(entry.optionIndexes)
          ? entry.optionIndexes.filter((index): index is number => Number.isInteger(index))
          : [],
        text: typeof entry.text === 'string' ? entry.text : '',
        skipped: entry.skipped === true,
      }
    }
    return draft
  } catch {
    return {}
  }
}

export function saveQuestionDraft(nodeId: string, draft: QuestionDraft | null): void {
  try {
    if (!draft || Object.keys(draft).length === 0) {
      window.localStorage.removeItem(STORAGE_PREFIX + nodeId)
    } else {
      window.localStorage.setItem(STORAGE_PREFIX + nodeId, JSON.stringify(draft))
    }
  } catch {
    // Storage can be unavailable; the draft then lives only while the card is mounted.
  }
}
