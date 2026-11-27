import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import {
  httpsUrlSchema,
  NTFY_DEFAULT_SERVER,
  ntfyTopicSchema,
  REMOTE_DEFAULT_PORT,
  REMOTE_MAX_PORT,
  REMOTE_MIN_PORT,
} from '@shared/remote'

const KEY = 'remoteAccess'

export const remoteSettingsSchema = z
  .object({
    enabled: z.boolean().default(false),
    port: z.number().int().min(REMOTE_MIN_PORT).max(REMOTE_MAX_PORT).default(REMOTE_DEFAULT_PORT),
    token: z.string().min(20),
    ntfyEnabled: z.boolean().default(false),
    ntfyServer: httpsUrlSchema.default(NTFY_DEFAULT_SERVER),
    // Vazio so ate a primeira leitura: loadRemoteSettings gera o topico.
    ntfyTopic: ntfyTopicSchema.or(z.literal('')).default(''),
    ntfyToken: z.string().min(1).nullable().default(null),
    publicUrl: httpsUrlSchema.nullable().default(null),
  })
  .strict()
export type RemoteSettings = z.infer<typeof remoteSettingsSchema>

/** O que o SQLite oferece (app_settings, valor em JSON). */
export interface SettingsStorage {
  getSetting(key: string): string | null
  setSetting(key: string, valueJson: string): void
}

export const newRemoteToken = () => randomBytes(32).toString('base64url')
const newNtfyTopic = () => `eclipse-${randomBytes(12).toString('base64url')}`

/** Le as configuracoes; na primeira leitura (ou valor ilegivel) grava o token novo. */
export function loadRemoteSettings(storage: SettingsStorage): RemoteSettings {
  const raw = storage.getSetting(KEY)
  if (raw !== null) {
    try {
      const parsed = remoteSettingsSchema.safeParse(JSON.parse(raw))
      if (parsed.success) {
        return parsed.data.ntfyTopic === ''
          ? saveRemoteSettings(storage, { ...parsed.data, ntfyTopic: newNtfyTopic() })
          : parsed.data
      }
    } catch {
      // JSON corrompido: recomeca desligado com token novo.
    }
  }
  return saveRemoteSettings(storage, {
    enabled: false,
    port: REMOTE_DEFAULT_PORT,
    token: newRemoteToken(),
    ntfyEnabled: false,
    ntfyServer: NTFY_DEFAULT_SERVER,
    ntfyTopic: newNtfyTopic(),
    ntfyToken: null,
    publicUrl: null,
  })
}

export function saveRemoteSettings(storage: SettingsStorage, s: RemoteSettings): RemoteSettings {
  storage.setSetting(KEY, JSON.stringify(s))
  return s
}
