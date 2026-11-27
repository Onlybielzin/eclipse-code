/**
 * Acesso pelo celular: contratos e regras compartilhadas entre o main e a tela de Configurações.
 */
import { z } from 'zod'
import type { IpcCommandChannel } from './ipc'

export const REMOTE_DEFAULT_PORT = 47821
export const REMOTE_MIN_PORT = 1024
export const REMOTE_MAX_PORT = 65535

export const NTFY_DEFAULT_SERVER = 'https://ntfy.vings.dev'

/** URL https sem espaco. */
export const httpsUrlSchema = z
  .string()
  .max(300)
  .refine((v) => {
    try {
      return new URL(v).protocol === 'https:'
    } catch {
      return false
    }
  }, 'Use um endereço https.')
/** O topico do ntfy serve de segredo: so letras, numeros, _ e -. */
export const ntfyTopicSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)

/** Entrada de remote.save. ntfyToken vazio/ausente mantem o atual; removeNtfyToken apaga. */
export const remoteSaveSchema = z
  .object({
    enabled: z.boolean(),
    port: z.number().int().min(REMOTE_MIN_PORT).max(REMOTE_MAX_PORT),
    ntfyEnabled: z.boolean().optional(),
    ntfyServer: httpsUrlSchema.optional(),
    ntfyTopic: ntfyTopicSchema.optional(),
    ntfyToken: z.string().min(1).max(300).optional(),
    removeNtfyToken: z.boolean().optional(),
    publicUrl: httpsUrlSchema.nullable().optional(),
  })
  .strict()
export type RemoteSaveInput = z.infer<typeof remoteSaveSchema>

/** Estado de remote.get. pairUrlPath e sempre '/pair?token=<token>' (o host vem da Tailscale). */
export interface RemoteStatus {
  enabled: boolean
  port: number
  token: string
  pairUrlPath: string
  running: boolean
  /** Motivo de nao estar de pe quando enabled (ex.: porta ocupada); null quando tudo certo. */
  error: string | null
  ntfyEnabled: boolean
  ntfyServer: string
  ntfyTopic: string
  /** O token do ntfy nunca volta para a tela. */
  ntfyTokenSet: boolean
  publicUrl: string | null
}

/**
 * Comandos que o celular pode chamar. O resto (pastas do PC, remover, papeis, brain, update,
 * remote.*) responde 'forbidden'.
 */
export const REMOTE_ALLOWED_COMMANDS = [
  'app.info',
  'app.whatsNew',
  'projects.list',
  'projects.summary',
  'settings.get',
  'wall.snapshot',
  'roles.list',
  'tasks.list',
  'tasks.create',
  'tasks.setStatus',
  'tasks.waitInfo',
  'subtasks.list',
  'subtasks.detail',
  'activity.list',
  'sessions.list',
  'leader.ensure',
  'terminal.attach',
  'terminal.write',
  'taskProcess.attach',
  'questions.list',
  'questions.answer',
  'questions.dismiss',
] as const satisfies readonly IpcCommandChannel[]

/** Eventos que nao saem para o celular (o cerebro e so do PC). */
export const REMOTE_BLOCKED_EVENT_PREFIX = 'brain.'
