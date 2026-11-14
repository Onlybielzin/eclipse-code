/**
 * Caixa de avisos ao Lider Claude: inbox.json na pasta do gancho, lista de {id, text}.
 *
 * Protocolo (o mesmo do hook.mjs em claudeHooks.ts):
 *   1. Quem escreve grava inbox.json por arquivo temporario + rename, modo 0600.
 *   2. Quem le reivindica com rename para um nome unico; quem renomear primeiro leva.
 *   3. O gancho entrega o texto ao Claude e grava NoticesDelivered no events.jsonl.
 *   4. O app so tira o aviso da fila duravel com NoticesDelivered (ou colagem confirmada).
 *   5. Escrever = reivindicar o que ha, somar os novos (sem repetir id) e regravar.
 */
import { randomUUID } from 'node:crypto'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import type { ClaudeHookPaths } from './claudeHooks'

export interface InboxNotice {
  id: number
  text: string
}

/** Limite de texto entregue por vez (o gancho corta no mesmo valor). */
export const MAX_INBOX_CHARS = 9000

/** Reivindica a caixa de forma atomica. Lista vazia: nao havia caixa ou o gancho levou. */
export async function claimInbox(paths: ClaudeHookPaths): Promise<InboxNotice[]> {
  const mine = `${paths.inbox}.claimed-${randomUUID()}`
  try {
    await rename(paths.inbox, mine)
  } catch {
    return []
  }
  try {
    const list: unknown = JSON.parse(await readFile(mine, 'utf8'))
    return Array.isArray(list)
      ? list.filter(
          (n): n is InboxNotice =>
            Boolean(n) && Number.isInteger(n.id) && typeof n.text === 'string',
        )
      : []
  } catch {
    return []
  } finally {
    await rm(mine, { force: true })
  }
}

export async function writeInbox(
  paths: ClaudeHookPaths,
  notices: readonly InboxNotice[],
): Promise<void> {
  const temp = `${paths.inbox}.tmp-${randomUUID()}`
  await writeFile(temp, JSON.stringify(notices), { encoding: 'utf8', mode: 0o600 })
  await rename(temp, paths.inbox)
}

/** Prefixo da lista que cabe em MAX_INBOX_CHARS (sempre pelo menos 1 aviso). */
export function fitInbox(notices: readonly InboxNotice[]): InboxNotice[] {
  const fit: InboxNotice[] = []
  let size = 0
  for (const notice of notices) {
    size += notice.text.length + 1
    if (fit.length > 0 && size > MAX_INBOX_CHARS) break
    fit.push(notice)
  }
  return fit
}
