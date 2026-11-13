/**
 * Politica de permissao dos membros: aceitar sozinho tudo o que fica dentro da worktree.
 *
 * - Sem caminho (comando de terminal, ferramenta MCP como `entregar`): aceita. O processo
 *   ja roda com cwd na worktree e o Codex ainda aplica o sandbox workspace-write.
 * - Todos os caminhos dentro da worktree (ou de uma raiz extra permitida): aceita.
 * - Algum caminho fora: recusa, e o membro recebe a recusa como resultado da ferramenta.
 *
 * Caminhos sao comparados depois de resolver symlinks (realpath), e um caminho que ainda
 * nao existe e resolvido pela pasta-mae mais proxima que existe.
 */
import { existsSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type {
  PermissionOption,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from '@agentclientprotocol/sdk'

export interface PermissionDecision {
  allow: boolean
  reason: string
  response: RequestPermissionResponse
}

export function realPathLoose(path: string): string {
  let current = resolve(path)
  const tail: string[] = []
  // Sobe ate achar algo que existe, resolve symlinks ali e recoloca o resto.
  for (;;) {
    if (existsSync(current)) {
      try {
        const real = realpathSync(current)
        return tail.length ? resolve(real, ...tail.reverse()) : real
      } catch {
        return resolve(path)
      }
    }
    const parent = dirname(current)
    if (parent === current) return resolve(path)
    tail.push(current.slice(parent.length).replace(/^[/\\]+/, ''))
    current = parent
  }
}

export function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

function pickOption(
  options: readonly PermissionOption[],
  kinds: readonly PermissionOption['kind'][],
): PermissionOption | undefined {
  for (const kind of kinds) {
    const found = options.find((o) => o.kind === kind)
    if (found) return found
  }
  return undefined
}

export function decidePermission(
  request: RequestPermissionRequest,
  context: { cwd: string; extraRoots?: readonly string[] },
): PermissionDecision {
  const roots = [context.cwd, ...(context.extraRoots ?? [])].map(realPathLoose)
  const paths = (request.toolCall.locations ?? []).map((l) => l.path).filter(Boolean)
  const outside = paths.filter((p) => {
    const real = realPathLoose(isAbsolute(p) ? p : resolve(context.cwd, p))
    return !roots.some((root) => isInside(root, real))
  })
  const allow = outside.length === 0
  const option = allow
    ? pickOption(request.options, ['allow_once', 'allow_always'])
    : pickOption(request.options, ['reject_once', 'reject_always'])
  const reason = allow
    ? paths.length
      ? 'dentro da worktree'
      : 'sem caminho de arquivo'
    : `fora da worktree: ${outside.join(', ')}`
  if (!option) {
    // Sem opcao do tipo certo: recusar pelo protocolo e o caminho seguro.
    return {
      allow: false,
      reason: `${reason} (sem opção compatível)`,
      response: { outcome: { outcome: 'cancelled' } },
    }
  }
  return {
    allow,
    reason,
    response: { outcome: { outcome: 'selected', optionId: option.optionId } },
  }
}
