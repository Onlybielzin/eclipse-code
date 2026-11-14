/**
 * Politica de permissao dos membros: o membro tem permissao total, como o Lider
 * (que roda com bypass). Decisao do usuario em 2026-11-13: "libera pra todos os agentes".
 *
 * - Todo pedido e aceito (allow_always quando houver, para nao repetir o pedido).
 * - O motivo diz se o pedido era dentro ou fora da worktree, para o log e a Atividade.
 * - Sem opcao de aceitar no pedido: cancela pelo protocolo (nao ha como aceitar).
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
  const allow = true
  const option = pickOption(request.options, ['allow_always', 'allow_once'])
  const reason = outside.length
    ? `fora da worktree: ${outside.join(', ')}`
    : paths.length
      ? 'dentro da worktree'
      : 'sem caminho de arquivo'
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
