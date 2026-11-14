/**
 * Diff de uma worktree contra a base: linhas +/-, arquivo mudado mais recentemente e as
 * ultimas linhas dele. Git so em modo 'observation'. Nunca lanca: erro vira zeros.
 *
 * shortcut: arquivo nao rastreado (ainda sem git add) nao entra na conta, evita
 * um git status caro; passa a contar quando o agente roda git add ou commit.
 */
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { runGit } from '../worktree/git'

export interface WorktreeDiff {
  linesAdded: number
  linesRemoved: number
  lastFile: string | null
  lastLines: string[]
}

const EMPTY: WorktreeDiff = { linesAdded: 0, linesRemoved: 0, lastFile: null, lastLines: [] }
const MAX_LINES = 6
const MAX_LINE_CHARS = 160

async function diffBase(cwd: string, baseBranch: string): Promise<string | null> {
  const mb = await runGit(['merge-base', 'HEAD', baseBranch], cwd, 'observation')
  const sha = mb.stdout.trim()
  return mb.exitCode === 0 && sha ? sha : null
}

export async function readWorktreeDiff(cwd: string, baseBranch: string): Promise<WorktreeDiff> {
  try {
    const base = await diffBase(cwd, baseBranch)
    if (!base) return EMPTY
    const num = await runGit(['diff', '--numstat', '-z', '--no-renames', base], cwd, 'observation')
    if (num.exitCode !== 0) return EMPTY
    let linesAdded = 0
    let linesRemoved = 0
    const files: string[] = []
    // -z: registros "add\tdel\tcaminho" separados por NUL, sem escape de acento/tab.
    for (const row of num.stdout.split('\0')) {
      const [a, d, ...rest] = row.split('\t')
      if (a === undefined || d === undefined || rest.length === 0) continue
      linesAdded += Number(a) || 0 // binario vem como "-"
      linesRemoved += Number(d) || 0
      files.push(rest.join('\t'))
    }
    const lastFile = await newestFile(cwd, files)
    if (!lastFile) return { ...EMPTY, linesAdded, linesRemoved }
    const patch = await runGit(['diff', '-U0', '--no-renames', base, '--', lastFile], cwd, 'observation')
    // Cabecalho (diff --git, index, ---, +++) vem antes do 1o "@@"; depois dele tudo e conteudo.
    const rows = patch.stdout.split('\n')
    const lastLines = rows
      .slice(Math.max(0, rows.findIndex((l) => l.startsWith('@@'))))
      .filter((l) => l.startsWith('+') || l.startsWith('-'))
      .slice(-MAX_LINES)
      .map((l) => l.slice(0, MAX_LINE_CHARS))
    return { linesAdded, linesRemoved, lastFile, lastLines }
  } catch {
    return EMPTY
  }
}

/** Arquivo com mtime mais novo; arquivo apagado (stat falha) nao entra. */
async function newestFile(cwd: string, files: string[]): Promise<string | null> {
  const times = await Promise.all(
    files.map((f) => stat(join(cwd, f)).then((s) => s.mtimeMs, () => -1)),
  )
  let best = -1
  let pick: string | null = null
  times.forEach((t, i) => {
    if (t > best) {
      best = t
      pick = files[i] ?? null
    }
  })
  return pick
}
