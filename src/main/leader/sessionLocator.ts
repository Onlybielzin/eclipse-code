/**
 * Acha o id de sessao do provedor para retomar (`claude --resume <id>`, `codex resume <id>`).
 *
 * Origem: agent/infrastructure/cli/{AgentSessionLocator,AgentSessionCandidateSelector,
 * CodexSessionFiles}.ts e ClaudeProjectPaths.ts do app antigo, so Claude e Codex.
 *
 * O Lider Claude novo ja nasce com `--session-id` conhecido (claudeSessionIdFor), e o
 * gancho SessionStart confirma o id. A busca por arquivo aqui e o plano B.
 */
import { open, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { EpochMs, Provider } from '@shared/domain'

export interface SessionLocatorDirs {
  /** Pastas de configuracao do Claude (CLAUDE_CONFIG_DIR ou ~/.claude). */
  claudeConfigDirs: string[]
  /** Pastas CODEX_HOME (ou ~/.codex). */
  codexHomes: string[]
}

export function defaultSessionLocatorDirs(
  env: Record<string, string | undefined> = process.env,
): SessionLocatorDirs {
  const home = env['HOME']?.trim() || homedir()
  const claudeConfig = env['CLAUDE_CONFIG_DIR']?.trim()
  const codexHome = env['CODEX_HOME']?.trim()
  return {
    claudeConfigDirs: [
      ...new Set([...(claudeConfig ? [resolve(claudeConfig)] : []), join(home, '.claude')]),
    ],
    codexHomes: [...new Set([...(codexHome ? [resolve(codexHome)] : []), join(home, '.codex')])],
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CANDIDATE_WINDOW_MS = 20_000
const POLL_INTERVAL_MS = 200

// ---------------------------------------------------------------------------
// Escolha do candidato mais proximo do inicio (copiado de AgentSessionCandidateSelector)
// ---------------------------------------------------------------------------

export interface SessionCandidate {
  sessionId: string
  timestampMs: number
}

/** Mais proximo de startedAt dentro da janela. Empate entre ids diferentes: null (ambiguo). */
export function selectNearestSessionId(options: {
  candidates: SessionCandidate[]
  startedAtMs: number
  maxDistanceMs: number
}): string | null {
  const nearest = new Map<string, number>()
  for (const candidate of options.candidates) {
    const distance = Math.abs(candidate.timestampMs - options.startedAtMs)
    if (distance > options.maxDistanceMs) continue
    const previous = nearest.get(candidate.sessionId)
    if (previous === undefined || distance < previous) nearest.set(candidate.sessionId, distance)
  }
  const ranked = [...nearest.entries()].sort(
    ([leftId, left], [rightId, right]) =>
      left - right || (leftId < rightId ? -1 : leftId > rightId ? 1 : 0),
  )
  const first = ranked[0]
  if (!first || (ranked[1] && ranked[1][1] === first[1])) return null
  return first[0]
}

// ---------------------------------------------------------------------------
// Claude: ~/.claude/projects/<cwd codificado>/<uuid>.jsonl
// ---------------------------------------------------------------------------

export function encodeClaudeProjectPath(cwd: string): string {
  return resolve(cwd).replace(/[^A-Za-z0-9]/g, '-')
}

function claudeProjectDirectories(cwd: string, configDirs: string[]): string[] {
  const absolute = resolve(cwd)
  const encodings = [
    ...new Set([encodeClaudeProjectPath(absolute), absolute.replace(/[:\\/]/g, '-')]),
  ]
  return encodings.flatMap((encoded) => configDirs.map((dir) => join(dir, 'projects', encoded)))
}

/** Caminho do transcript de uma sessao Claude conhecida, se existir. */
export async function findClaudeTranscript(
  cwd: string,
  providerSessionId: string,
  dirs: SessionLocatorDirs,
): Promise<string | null> {
  for (const directory of claudeProjectDirectories(cwd, dirs.claudeConfigDirs)) {
    const path = join(directory, `${providerSessionId}.jsonl`)
    try {
      if ((await stat(path)).isFile()) return path
    } catch {
      // proximo
    }
  }
  return null
}

async function listClaudeCandidates(
  cwd: string,
  dirs: SessionLocatorDirs,
): Promise<SessionCandidate[]> {
  const candidates: SessionCandidate[] = []
  for (const directory of claudeProjectDirectories(cwd, dirs.claudeConfigDirs)) {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
      const sessionId = basename(entry.name, '.jsonl')
      if (!UUID_PATTERN.test(sessionId)) continue
      const info = await stat(join(directory, entry.name)).catch(() => null)
      if (!info) continue
      const created = info.birthtimeMs > 0 ? info.birthtimeMs : info.mtimeMs
      candidates.push({ sessionId, timestampMs: created })
    }
  }
  return candidates
}

// ---------------------------------------------------------------------------
// Codex: ~/.codex/sessions/AAAA/MM/DD/rollout-*.jsonl (primeira linha session_meta)
// ---------------------------------------------------------------------------

export interface CodexSessionFile {
  sessionId: string
  cwd: string
  payloadTimestampMs: number | null
  recordTimestampMs: number | null
  filePath: string
}

const FIRST_LINE_MAX_BYTES = 64 * 1024

async function readFirstLine(filePath: string): Promise<string | null> {
  const handle = await open(filePath, 'r').catch(() => null)
  if (!handle) return null
  try {
    const decoder = new StringDecoder('utf8')
    const buffer = Buffer.allocUnsafe(4096)
    let total = 0
    let text = ''
    while (total < FIRST_LINE_MAX_BYTES) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null)
      if (bytesRead <= 0) break
      total += bytesRead
      text += decoder.write(buffer.subarray(0, bytesRead))
      const newline = text.indexOf('\n')
      if (newline !== -1) return text.slice(0, newline).trim() || null
    }
    if (total >= FIRST_LINE_MAX_BYTES) return null
    return (text + decoder.end()).trim() || null
  } catch {
    return null
  } finally {
    await handle.close().catch(() => undefined)
  }
}

function parseTimestampMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value)
  if (typeof value !== 'string') return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

export function parseCodexSessionMeta(
  firstLine: string,
): Omit<CodexSessionFile, 'filePath'> | null {
  try {
    const parsed = JSON.parse(firstLine) as {
      type?: unknown
      timestamp?: unknown
      payload?: { id?: unknown; cwd?: unknown; timestamp?: unknown }
    }
    if (parsed.type !== 'session_meta') return null
    const sessionId = typeof parsed.payload?.id === 'string' ? parsed.payload.id.trim() : ''
    const cwd = typeof parsed.payload?.cwd === 'string' ? resolve(parsed.payload.cwd) : null
    const payloadTimestampMs = parseTimestampMs(parsed.payload?.timestamp)
    const recordTimestampMs = parseTimestampMs(parsed.timestamp)
    if (!sessionId || !cwd || (payloadTimestampMs === null && recordTimestampMs === null))
      return null
    return { sessionId, cwd, payloadTimestampMs, recordTimestampMs }
  } catch {
    return null
  }
}

function codexDayDirectory(home: string, timestamp: number): string {
  const date = new Date(timestamp)
  return join(
    home,
    'sessions',
    String(date.getFullYear()),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  )
}

export async function listCodexSessionFiles(input: {
  cwd: string
  startedAtMs: number
  nowMs: number
  dirs: SessionLocatorDirs
  /** Busca por id (retomar): le so arquivos com esse id no nome, de qualquer data. */
  sessionId?: string | null
}): Promise<CodexSessionFile[]> {
  const files = new Set<string>()
  for (const home of input.dirs.codexHomes) {
    if (input.sessionId) {
      const entries = await readdir(join(home, 'sessions'), {
        recursive: true,
        withFileTypes: true,
      }).catch(() => [])
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith(`-${input.sessionId}.jsonl`)) {
          files.add(join(entry.parentPath, entry.name))
        }
      }
      continue
    }
    const days = new Set(
      [
        input.startedAtMs,
        input.startedAtMs - 86_400_000,
        input.nowMs,
        input.nowMs - 86_400_000,
      ].map((ts) => codexDayDirectory(home, ts)),
    )
    for (const directory of days) {
      const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
      for (const entry of entries) {
        if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
          files.add(join(directory, entry.name))
        }
      }
    }
  }
  const wantedCwd = resolve(input.cwd)
  const result: CodexSessionFile[] = []
  for (const filePath of files) {
    const line = await readFirstLine(filePath)
    const meta = line ? parseCodexSessionMeta(line) : null
    if (!meta) continue
    if (input.sessionId ? meta.sessionId !== input.sessionId : meta.cwd !== wantedCwd) continue
    result.push({ ...meta, filePath })
  }
  return result
}

function codexTimestamp(file: CodexSessionFile, startedAtMs: number): number {
  const values = [file.payloadTimestampMs, file.recordTimestampMs].filter(
    (value): value is number => typeof value === 'number',
  )
  if (values.length === 0) return startedAtMs
  return (
    values.sort((a, b) => Math.abs(a - startedAtMs) - Math.abs(b - startedAtMs))[0] ?? startedAtMs
  )
}

/** Arquivo rollout de uma sessao Codex conhecida (para acompanhar o estado do turno). */
export async function findCodexSessionFile(
  providerSessionId: string,
  dirs: SessionLocatorDirs,
): Promise<string | null> {
  const files = await listCodexSessionFiles({
    cwd: '/',
    startedAtMs: 0,
    nowMs: 0,
    dirs,
    sessionId: providerSessionId,
  })
  return files[0]?.filePath ?? null
}

// ---------------------------------------------------------------------------
// Busca com prazo
// ---------------------------------------------------------------------------

export interface LocateDeps {
  dirs: SessionLocatorDirs
  now: () => number
  sleep: (ms: number) => Promise<void>
}

export async function findProviderSessionIdOnce(
  input: { provider: Provider; cwd: string; startedAt: EpochMs },
  deps: Pick<LocateDeps, 'dirs' | 'now'>,
): Promise<string | null> {
  if (input.provider === 'claude') {
    const candidates = await listClaudeCandidates(input.cwd, deps.dirs)
    // Transcript criado antes do Lider abrir nao e dele.
    return selectNearestSessionId({
      candidates: candidates.filter((candidate) => candidate.timestampMs >= input.startedAt - 2000),
      startedAtMs: input.startedAt,
      maxDistanceMs: CANDIDATE_WINDOW_MS,
    })
  }
  const files = await listCodexSessionFiles({
    cwd: input.cwd,
    startedAtMs: input.startedAt,
    nowMs: deps.now(),
    dirs: deps.dirs,
  })
  return selectNearestSessionId({
    candidates: files.map((file) => ({
      sessionId: file.sessionId,
      timestampMs: codexTimestamp(file, input.startedAt),
    })),
    startedAtMs: input.startedAt,
    maxDistanceMs: CANDIDATE_WINDOW_MS,
  })
}

export async function locateProviderSessionId(
  input: { provider: Provider; cwd: string; startedAt: EpochMs; timeoutMs: number },
  deps: LocateDeps,
): Promise<string | null> {
  const deadline = deps.now() + Math.max(0, input.timeoutMs)
  for (;;) {
    const found = await findProviderSessionIdOnce(input, deps)
    if (found) return found
    if (deps.now() >= deadline) return null
    await deps.sleep(Math.min(POLL_INTERVAL_MS, Math.max(1, deadline - deps.now())))
  }
}
