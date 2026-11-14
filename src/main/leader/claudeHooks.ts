/**
 * Ganchos do Claude, so para o Lider. O Claude roda um script curto a cada evento de
 * ciclo de vida; o script grava uma linha JSON num arquivo da sessao, e o app le esse
 * arquivo (JsonlTail). Sem socket nem servidor: o canal e o arquivo, com permissao 0600.
 *
 * Origem: providers/claude-code (createClaudeHooks) e providers/shared/AgentHookRelay.ts
 * do app antigo, simplificado para arquivo.
 */
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises'
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
  /** Win32: .cmd que define ELECTRON_RUN_AS_NODE e chama o executavel com o script. */
  launcher: string
}

export function claudeHookPaths(hooksRoot: string, sessionId: string): ClaudeHookPaths {
  const directory = join(hooksRoot, `leader-${sessionId.replace(/[^A-Za-z0-9_-]/g, '_')}`)
  return {
    directory,
    settings: join(directory, 'settings.json'),
    script: join(directory, 'hook.mjs'),
    events: join(directory, 'events.jsonl'),
    launcher: join(directory, 'hook.cmd'),
  }
}

/**
 * Script do gancho. Le o JSON do stdin, guarda so os campos que o app usa e
 * acrescenta uma linha ao arquivo de eventos. Nunca segura o Claude: sai em 2 s e
 * sempre com codigo 0.
 */
export const CLAUDE_HOOK_SCRIPT = String.raw`
import { appendFileSync } from 'node:fs';
const target = process.argv[2];
const deadline = setTimeout(() => process.exit(0), 2000);
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
  if (target && record.event) appendFileSync(target, JSON.stringify(record) + '\n', { mode: 0o600 });
} catch {
  // Gancho de observacao: falha aqui nunca e falha do agente.
} finally {
  clearTimeout(deadline);
  process.exit(0);
}
`

/** settings.json passado em `claude --settings <arquivo>`. Soma-se aos ganchos do usuario. */
export function buildClaudeHookSettings(
  runtimeExecutable: string,
  paths: ClaudeHookPaths,
  platform: NodeJS.Platform = process.platform,
): object {
  // ELECTRON_RUN_AS_NODE=1 faz o binario do Electron rodar como Node; o ambiente do
  // agente nao tem essa variavel (o PtyHost tira), entao o gancho a define sozinho.
  const handler = {
    hooks: [
      {
        type: 'command',
        command:
          platform === 'win32'
            ? // O Claude no Windows roda ganchos pelo Git Bash: `/` vale no bash e no cmd.
              `"${paths.launcher.replaceAll('\\', '/')}"`
            : [
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

function cmdEscape(value: string): string {
  return value.replaceAll('%', '%%')
}

function quotePosix(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

export async function writeClaudeHookFiles(
  paths: ClaudeHookPaths,
  runtimeExecutable: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  await mkdir(paths.directory, { recursive: true, mode: 0o700 })
  await chmod(paths.directory, 0o700)
  await writeFile(paths.script, CLAUDE_HOOK_SCRIPT, { encoding: 'utf8', mode: 0o600 })
  await writeFile(
    paths.settings,
    JSON.stringify(buildClaudeHookSettings(runtimeExecutable, paths, platform), null, 2),
    {
      encoding: 'utf8',
      mode: 0o600,
    },
  )
  if (platform === 'win32') {
    await writeFile(
      paths.launcher,
      // chcp 65001: caminho com acento; `%` dobrado: o cmd expande variavel dentro do .cmd.
      `@echo off\r\n@chcp 65001 >nul\r\n@set ELECTRON_RUN_AS_NODE=1\r\n"${cmdEscape(runtimeExecutable)}" "${cmdEscape(paths.script)}" "${cmdEscape(paths.events)}"\r\n`,
      'utf8',
    )
  }
  // Arquivo novo a cada abertura: eventos de uma abertura anterior nao valem para esta.
  await writeFile(paths.events, '', { encoding: 'utf8', mode: 0o600 })
}

export async function removeClaudeHookFiles(paths: ClaudeHookPaths): Promise<void> {
  await rm(paths.directory, { recursive: true, force: true })
}
