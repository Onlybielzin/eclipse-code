import * as z from 'zod'
import { defineOperation } from '../defineOperation'
import {
  QUESTION_CARD_MAX_HEADER_CHARS,
  QUESTION_CARD_MAX_QUESTIONS,
  QUESTION_CARD_MAX_OPTIONS,
  QUESTION_CARD_MAX_TEXT_CHARS,
  TODO_CARD_MAX_ITEMS,
} from '../../../canvasCards'

/**
 * Eclipse Code canvas cards. An agent asks the user a question as a card next to its window, and
 * keeps a to-do card that mirrors its task list. Only the user answers (session grants are denied
 * question.answer); the answer reaches the asking agent as a prompt.
 */

const nodeId = z.string().trim().min(1)

const questionOptions = z
  .array(
    z.strictObject({
      label: z.string().max(QUESTION_CARD_MAX_TEXT_CHARS),
      detail: z
        .string()
        .max(QUESTION_CARD_MAX_TEXT_CHARS)
        .optional()
        .describe('Cost or consequence of this choice'),
      recommended: z.boolean().optional(),
    }),
  )
  .min(1)
  .max(QUESTION_CARD_MAX_OPTIONS)

export const questionCreateOperation = defineOperation({
  id: 'question.create',
  kind: 'command',
  scope: 'interact',
  availability: 'always',
  summary: 'Ask the user up to 8 questions in one card next to the asking agent',
  input: z.strictObject({
    questions: z
      .array(
        z.strictObject({
          header: z
            .string()
            .max(QUESTION_CARD_MAX_HEADER_CHARS)
            .optional()
            .describe('Short tab label, e.g. "Banco"'),
          question: z.string().max(QUESTION_CARD_MAX_TEXT_CHARS).describe('One sentence'),
          context: z
            .string()
            .max(QUESTION_CARD_MAX_TEXT_CHARS)
            .optional()
            .describe('What the user needs to know to decide'),
          options: questionOptions,
          multiSelect: z.boolean().optional().describe('The user may pick several options'),
          allowOther: z
            .boolean()
            .optional()
            .describe('Let the user write another answer (default true)'),
        }),
      )
      .min(1)
      .max(QUESTION_CARD_MAX_QUESTIONS)
      .optional()
      .describe('The questions; or use the single-question fields below'),
    question: z
      .string()
      .max(QUESTION_CARD_MAX_TEXT_CHARS)
      .optional()
      .describe('Single-question shape: the question, one sentence'),
    context: z.string().max(QUESTION_CARD_MAX_TEXT_CHARS).optional(),
    options: questionOptions.optional(),
    allowOther: z.boolean().optional(),
    askedByNodeId: nodeId
      .optional()
      .describe('Agent that receives the answer; agents cannot set it (it is the caller)'),
  }),
  errors: [
    'common.forbidden',
    'common.invalid_input',
    'node.not_found',
    'persistence.invalid_state',
    'persistence.io_failed',
    'persistence.unavailable',
  ],
})

export const questionAnswerOperation = defineOperation({
  id: 'question.answer',
  kind: 'command',
  scope: 'interact',
  availability: 'always',
  summary: 'Answer every question of a card at once; the asking agent gets them',
  input: z.strictObject({
    nodeId,
    answers: z
      .array(
        z.strictObject({
          questionId: z.string().trim().min(1),
          optionIndexes: z.array(z.number().int().min(0)).max(QUESTION_CARD_MAX_OPTIONS).optional(),
          text: z.string().max(QUESTION_CARD_MAX_TEXT_CHARS).optional(),
          skipped: z.boolean().optional().describe('Let the agent decide'),
        }),
      )
      .min(1)
      .max(QUESTION_CARD_MAX_QUESTIONS)
      .optional(),
    optionIndex: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Single-question shape: the chosen option'),
    text: z
      .string()
      .max(QUESTION_CARD_MAX_TEXT_CHARS)
      .optional()
      .describe('Single-question shape: the user answer'),
  }),
  errors: [
    'common.invalid_input',
    'node.not_found',
    'agent.busy',
    'agent.not_running',
    'agent.state_unknown',
    'persistence.invalid_state',
    'persistence.io_failed',
    'persistence.unavailable',
  ],
})

export const questionHistoryOperation = defineOperation({
  id: 'question.history',
  kind: 'query',
  scope: 'read',
  availability: 'always',
  summary: 'List answered questions (decisions) of a task Space or project, newest first',
  input: z.strictObject({
    spaceId: z.string().trim().min(1).optional(),
    projectId: z.string().trim().min(1).optional(),
    limit: z.number().int().min(1).max(500).optional(),
  }),
  errors: ['persistence.unavailable'],
})

export const todosSyncOperation = defineOperation({
  id: 'todos.sync',
  kind: 'command',
  scope: 'interact',
  availability: 'always',
  summary: "Replace an agent's to-do card with its current task list (creates the card once)",
  input: z.strictObject({
    items: z
      .array(
        z.strictObject({
          text: z.string(),
          status: z.enum(['pending', 'in_progress', 'completed']),
        }),
      )
      .max(TODO_CARD_MAX_ITEMS),
    ownerNodeId: nodeId
      .optional()
      .describe('Agent that owns the list; agents cannot set it (it is the caller)'),
  }),
  errors: [
    'common.invalid_input',
    'node.not_found',
    'persistence.invalid_state',
    'persistence.io_failed',
    'persistence.unavailable',
  ],
})

export const cardOperations = [
  questionCreateOperation,
  questionAnswerOperation,
  questionHistoryOperation,
  todosSyncOperation,
] as const
