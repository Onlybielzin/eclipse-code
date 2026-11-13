/**
 * Validadores zod de formas de entrada compartilhadas por IPC (tela -> main)
 * e pelo McpBridge (servidor MCP -> main). Tudo que cruza uma fronteira de
 * processo passa por aqui antes de chegar ao TaskService.
 */
import { z } from 'zod'
import {
  DELIVERY_STATES,
  MAX_QUESTION_ITEMS,
  MAX_QUESTION_OPTIONS,
  PROVIDERS,
  TASK_KINDS,
  type ChangedFile,
  type Delivery,
  type JsonObject,
  type Part,
  type QuestionAnswer,
  type QuestionItem,
  type TestRun,
} from './domain'

export const MAX_TITLE_CHARS = 200
export const MAX_TEXT_CHARS = 100_000
export const MAX_ID_CHARS = 128
export const MAX_PATH_CHARS = 4_096

export const idSchema = z.string().min(1).max(MAX_ID_CHARS)
export const titleSchema = z.string().trim().min(1).max(MAX_TITLE_CHARS)
export const textSchema = z.string().max(MAX_TEXT_CHARS)
export const absolutePathSchema = z
  .string()
  .min(1)
  .max(MAX_PATH_CHARS)
  .refine((p) => p.startsWith('/'), { message: 'caminho precisa ser absoluto' })

export const providerSchema = z.enum(PROVIDERS)
export const taskKindSchema = z.enum(TASK_KINDS)
export const deliveryStateSchema = z.enum(DELIVERY_STATES)

export const jsonObjectSchema: z.ZodType<JsonObject> = z.record(
  z.string(),
  z.json(),
) as z.ZodType<JsonObject>

export const partSchema: z.ZodType<Part> = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: textSchema, metadata: jsonObjectSchema.optional() }),
  z.object({
    kind: z.literal('file'),
    uri: z.string().min(1).max(MAX_PATH_CHARS),
    name: z.string().max(MAX_TITLE_CHARS).optional(),
    mediaType: z.string().max(MAX_TITLE_CHARS).optional(),
    metadata: jsonObjectSchema.optional(),
  }),
  z.object({
    kind: z.literal('data'),
    data: jsonObjectSchema,
    metadata: jsonObjectSchema.optional(),
  }),
])

export const changedFileSchema: z.ZodType<ChangedFile> = z.object({
  path: z.string().min(1).max(MAX_PATH_CHARS),
  change: z.enum(['added', 'modified', 'deleted', 'renamed']),
  note: z.string().max(1_000).optional(),
})

export const testRunSchema: z.ZodType<TestRun> = z.object({
  command: z.string().min(1).max(2_000),
  result: z.string().max(4_000),
  passed: z.boolean().nullable(),
})

export const questionItemSchema: z.ZodType<QuestionItem> = z.object({
  id: idSchema,
  prompt: z.string().trim().min(1).max(2_000),
  options: z
    .array(
      z.object({
        id: idSchema,
        label: z.string().trim().min(1).max(MAX_TITLE_CHARS),
        description: z.string().max(1_000).optional(),
      }),
    )
    .max(MAX_QUESTION_OPTIONS),
  multiSelect: z.boolean(),
  allowFreeText: z.boolean(),
})

export const questionItemsSchema = z.array(questionItemSchema).min(1).max(MAX_QUESTION_ITEMS)

export const questionAnswerSchema: z.ZodType<QuestionAnswer> = z.object({
  itemId: idSchema,
  optionIds: z.array(idSchema).max(MAX_QUESTION_OPTIONS),
  text: z.string().max(MAX_TEXT_CHARS).nullable(),
})

/** Duvida sem itens e permitida: a pergunta pode estar so no resumo. */
export const deliverySchema: z.ZodType<Delivery> = z.object({
  state: deliveryStateSchema,
  summary: z.string().trim().min(1).max(MAX_TEXT_CHARS),
  files: z.array(changedFileSchema).max(500),
  tests: z.array(testRunSchema).max(100),
  questions: z.array(questionItemSchema).max(MAX_QUESTION_ITEMS),
})
