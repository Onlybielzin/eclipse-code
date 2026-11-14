/**
 * Ganchos do Claude, so para o Lider. O Claude roda um script curto a cada evento de
 * ciclo de vida; o script grava uma linha JSON num arquivo da sessao, e o app le esse
 * arquivo (JsonlTail). Sem socket nem servidor: o canal e o arquivo, com permissao 0600.
 *
 * Origem: providers/claude-code (createClaudeHooks) e providers/shared/AgentHookRelay.ts
 * do app antigo, simplificado para arquivo.
 */
import { chmod, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const CLAUDE_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Notification',
  'Stop',
  'StopFailure',
  'SessionEnd',
] as const

export interface ClaudeHookPaths {
  directory: string
  settings: string
  script: string
  events: string
  /** Caixa de avisos ao Lider (inbox.ts). */
  inbox: string
}

export function claudeHookPaths(hooksRoot: string, sessionId: string): ClaudeHookPaths {
  const directory = join(hooksRoot, `leader-${sessionId.replace(/[^A-Za-z0-9_-]/g, '_')}`)
  return {
    directory,
    settings: join(directory, 'settings.json'),
    script: join(directory, 'hook.mjs'),
    events: join(directory, 'events.jsonl'),
    inbox: join(directory, 'inbox.json'),
  }
}

/**
 * Script do gancho. Le o JSON do stdin, guarda so os campos que o app usa e
 * acrescenta uma linha ao arquivo de eventos. Em PostToolUse, UserPromptSubmit e Stop
 * tambem reivindica a caixa de avisos (inbox.json, renameSync: quem renomear primeiro
 * leva) e entrega o texto ao Claude. Nunca segura o Claude: sai em 2 s e sempre com
 * codigo 0. Entrega primeiro, registra NoticesDelivered depois: falha no meio duplica
 * o aviso (o app cola de novo), nunca o perde. Stop com entrega nao grava o evento Stop,
 * porque o Claude continua o turno.
 */
export const CLAUDE_HOOK_SCRIPT = String.raw`
import { appendFileSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
const target = process.argv[2];
const deadline = setTimeout(() => process.exit(0), 2000);
const MAX_NOTICE_CHARS = 9000;
const NOTICE_EVENTS = ['PostToolUse', 'UserPromptSubmit', 'Stop'];
function claimNotices() {
  const inbox = join(dirname(target), 'inbox.json');
  const mine = inbox + '.claimed-' + randomUUID();
  try { renameSync(inbox, mine); } catch { return []; }
  try {
    const list = JSON.parse(readFileSync(mine, 'utf8'));
    return Array.isArray(list)
      ? list.filter((n) => n && Number.isInteger(n.id) && typeof n.text === 'string')
      : [];
  } catch {
    return [];
  } finally {
    rmSync(mine, { force: true });
  }
}
function deliverNotices(event) {
  const picked = [];
  let text = '';
  for (const notice of claimNotices()) {
    const next = text ? text + '\n' + notice.text : notice.text;
    if (picked.length > 0 && next.length > MAX_NOTICE_CHARS) break;
    picked.push(notice.id);
    text = next.slice(0, MAX_NOTICE_CHARS);
  }
  if (picked.length === 0) return false;
  const output =
    event === 'Stop'
      ? { decision: 'block', reason: text }
      : { hookSpecificOutput: { hookEventName: event, additionalContext: text } };
  writeSync(1, JSON.stringify(output));
  appendFileSync(target, JSON.stringify({ event: 'NoticesDelivered', ids: picked, at: Date.now() }) + '\n', { mode: 0o600 });
  return true;
}
try {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 4 * 1024 * 1024) process.exit(0);
    chunks.push(chunk);
  }
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/u, ''));
  const pick = (key) => (typeof input[key] === 'string' ? input[key].slice(0, 4096) : null);
  const record = {
    event: pick('hook_event_name'),
    sessionId: pick('session_id'),
    notificationType: pick('notification_type'),
    source: pick('source'),
    transcriptPath: pick('transcript_path'),
    at: Date.now(),
  };
  // agent_id so vem de gancho dentro de subagente: o aviso e do Lider, nao dele.
  const inSubagent = typeof input.agent_id === 'string' && input.agent_id !== '';
  const delivered = target && !inSubagent && NOTICE_EVENTS.includes(record.event) && deliverNotices(record.event);
  if (target && record.event && !(delivered && record.event === 'Stop')) {
    appendFileSync(target, JSON.stringify(record) + '\n', { mode: 0o600 });
  }
} catch {
  // Gancho de observacao: falha aqui nunca e falha do agente.
} finally {
  clearTimeout(deadline);
  process.exit(0);
}
`

/** settings.json passado em `claude --settings <arquivo>`. Soma-se aos ganchos do usuario. */
export function buildClaudeHookSettings(runtimeExecutable: string, paths: ClaudeHookPaths): object {
  // ELECTRON_RUN_AS_NODE=1 faz o binario do Electron rodar como Node; o ambiente do
  // agente nao tem essa variavel (o PtyHost tira), entao o gancho a define sozinho.
  const handler = {
    hooks: [
      {
        type: 'command',
        command: [
          '/usr/bin/env',
          'ELECTRON_RUN_AS_NODE=1',
          runtimeExecutable,
          paths.script,
          paths.events,
        ]
          .map(quotePosix)
          .join(' '),
        timeout: 3,
      },
    ],
  }
  return { hooks: Object.fromEntries(CLAUDE_HOOK_EVENTS.map((event) => [event, [handler]])) }
}

function quotePosix(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

export async function writeClaudeHookFiles(
  paths: ClaudeHookPaths,
  runtimeExecutable: string,
): Promise<void> {
  await mkdir(paths.directory, { recursive: true, mode: 0o700 })
  await chmod(paths.directory, 0o700)
  await writeFile(paths.script, CLAUDE_HOOK_SCRIPT, { encoding: 'utf8', mode: 0o600 })
  await writeFile(
    paths.settings,
    JSON.stringify(buildClaudeHookSettings(runtimeExecutable, paths), null, 2),
    {
      encoding: 'utf8',
      mode: 0o600,
    },
  )
  // Caixa de uma abertura anterior nao vale: os avisos continuam pendentes no SQLite.
  for (const name of await readdir(paths.directory)) {
    if (name.startsWith('inbox.json')) await rm(join(paths.directory, name), { force: true })
  }
  // Arquivo novo a cada abertura: eventos de uma abertura anterior nao valem para esta.
  await writeFile(paths.events, '', { encoding: 'utf8', mode: 0o600 })
}

export async function removeClaudeHookFiles(paths: ClaudeHookPaths): Promise<void> {
  await rm(paths.directory, { recursive: true, force: true })
}

/** Linha NoticesDelivered do gancho: ids dos avisos que o Claude recebeu. */
export function parseNoticesDelivered(value: unknown): number[] | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as { event?: unknown; ids?: unknown }
  if (record.event !== 'NoticesDelivered' || !Array.isArray(record.ids)) return null
  return record.ids.filter((id): id is number => Number.isInteger(id))
}
