/**
 * Regras puras do seletor de projeto do topo: busca sem maiusculas nem acentos e
 * caminho encurtado para caber na linha.
 */
import type { Project } from '@shared/domain'

/** Minusculas e sem acentos ("Árvore" -> "arvore"). */
export function foldText(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
}

/** O projeto casa com a busca pelo nome ou pelo caminho. Busca vazia casa com tudo. */
export function matchesProject(
  project: Pick<Project, 'name' | 'rootPath'>,
  query: string,
): boolean {
  const q = foldText(query.trim())
  if (q === '') return true
  return foldText(project.name).includes(q) || foldText(project.rootPath).includes(q)
}

/** Troca a home por ~ (so quando o caminho esta dentro dela). */
export function tildePath(path: string, homeDir: string | null): string {
  if (!homeDir) return path
  const home = homeDir.replace(/[\\/]+$/, '')
  if (home === '') return path
  if (path === home) return '~'
  if (path.startsWith(`${home}/`) || path.startsWith(`${home}\\`)) {
    return `~${path.slice(home.length)}`
  }
  return path
}

/** Caminho com ~ e, se passar de `max` caracteres, reticencias no meio. */
export function shortenPath(path: string, homeDir: string | null, max = 44): string {
  const short = tildePath(path, homeDir)
  if (short.length <= max) return short
  const keep = max - 1
  const head = Math.ceil(keep * 0.4)
  const tail = keep - head
  return `${short.slice(0, head)}…${short.slice(short.length - tail)}`
}
