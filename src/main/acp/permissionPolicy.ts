/**
 * Politica de permissao dos membros, por acesso do papel (Role.access).
 * Historico: em 2026-11-13 ("libera pra todos os agentes") todo pedido era aceito; em
 * 2026-11-17 isso foi trocado pela trava por papel.
 *
 * - read_only: nega edit, delete e move.
 * - read_only e no_commit: nega git commit, push, merge, rebase, cherry-pick, am e revert.
 * - Negar = escolher reject_once (ou reject_always); sem opcao de recusa, cancela.
 * - full e o que sobra: todo pedido e aceito, sempre com allow_once. allow_always faria o adaptador
 *   gravar a regra em .claude/settings.local.json da worktree e outro membro herdaria a regra, sem
 *   o pedido chegar aqui. Repetir o pedido nao custa nada: o app responde sozinho.
 * - O motivo diz se o pedido era dentro ou fora da worktree, para o log e a Atividade.
 * - Sem opcao de aceitar no pedido: cancela pelo protocolo (nao ha como aceitar).
 *
 * Caminhos sao comparados depois de resolver symlinks (realpath), e um caminho que ainda
 * nao existe e resolvido pela pasta-mae mais proxima que existe.
 */
import { existsSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { RoleAccess } from '@shared/domain'
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

const GIT_BLOCKED = new Set(['commit', 'push', 'merge', 'rebase', 'cherry-pick', 'am', 'revert'])
// Opcoes globais do git que levam o valor no token seguinte.
const GIT_OPT_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path'])

// Tokens simples, com aspas simples ou duplas agrupadas (o conteudo fica sem as aspas).
function tokenize(segment: string): string[] {
  return [...segment.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)]
    .map((m) => m[1] ?? m[2] ?? (m[3] ?? '').replace(/^[(){}`]+|\$\(|[(){}`]+$/g, ''))
    .filter((t) => t !== '')
}

// Prefixos que rodam o comando seguinte, e as opcoes deles que levam valor.
const EXEC_PREFIX = new Set(['sudo', 'command', 'time', 'nice', 'xargs', 'env'])
const PREFIX_OPT_WITH_VALUE = new Set(['-n', '-u', '-g'])

function segmentWritesGit(segment: string): boolean {
  const tokens = tokenize(segment.trim())
  // Prefixos (sudo, env -i...) e atribuicoes VAR=valor antes do comando.
  let i = 0
  for (;;) {
    const t = tokens[i]
    if (t === undefined) break
    if (/^[A-Za-z_]\w*=/.test(t)) i++
    else if (EXEC_PREFIX.has(t)) {
      for (i++; tokens[i]?.startsWith('-'); i++) if (PREFIX_OPT_WITH_VALUE.has(tokens[i]!)) i++
    } else break
  }
  const exe = tokens[i]
  if (!exe) return false
  const base = exe.slice(exe.lastIndexOf('/') + 1)
  if (base === 'git') {
    for (i++; i < tokens.length; i++) {
      const t = tokens[i]!
      if (GIT_OPT_WITH_VALUE.has(t)) i++
      else if (!t.startsWith('-')) return GIT_BLOCKED.has(t)
    }
    return false
  }
  // shortcut: so `bash|sh|zsh -c "..."` direto, sem parser de shell (eval, $(...), scripts); subir para um parser se aparecer bypass.
  if (base === 'bash' || base === 'sh' || base === 'zsh') {
    for (let j = i + 1; tokens[j]?.startsWith('-'); j++) {
      if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(tokens[j]!)) return commandWritesGit(tokens[j + 1] ?? '')
    }
  }
  return false
}

// shortcut: separa por && || ; | e quebra de linha (respeitando aspas inteiras), sem entender alias nem substituicao de comando;
// o Claude read_only ainda escreve arquivo pelo Bash (sed -i, echo >) porque o pedido chega como execute;
// trava forte so no Codex read-only (sandbox), ver agentCommand.ts. Subir para parser de shell se precisar.
function commandWritesGit(command: string): boolean {
  // Separadores dentro de aspas nao cortam (assim `sh -c 'cd a; git push'` chega inteiro ao -c).
  const segments = command.match(/(?:"[^"]*"|'[^']*'|[^&|;\n"'])+/g) ?? []
  return segments.some(segmentWritesGit)
}

function isGitWrite(request: RequestPermissionRequest): boolean {
  const command = (request.toolCall.rawInput as { command?: unknown } | null | undefined)?.command
  return typeof command === 'string' && commandWritesGit(command)
}

function denyReason(request: RequestPermissionRequest, access: RoleAccess): string | null {
  const kind = request.toolCall.kind
  if (access === 'read_only' && (kind === 'edit' || kind === 'delete' || kind === 'move')) {
    return 'papel só leitura: edição bloqueada'
  }
  if (access !== 'full' && isGitWrite(request)) {
    return 'papel sem commit: git commit, push, merge e similares bloqueados'
  }
  return null
}

export function decidePermission(
  request: RequestPermissionRequest,
  context: { cwd: string; access: RoleAccess; extraRoots?: readonly string[] },
): PermissionDecision {
  const denied = denyReason(request, context.access)
  if (denied) {
    const reject = pickOption(request.options, ['reject_once', 'reject_always'])
    return {
      allow: false,
      reason: denied,
      response: reject
        ? { outcome: { outcome: 'selected', optionId: reject.optionId } }
        : { outcome: { outcome: 'cancelled' } },
    }
  }
  const roots = [context.cwd, ...(context.extraRoots ?? [])].map(realPathLoose)
  const paths = (request.toolCall.locations ?? []).map((l) => l.path).filter(Boolean)
  const outside = paths.filter((p) => {
    const real = realPathLoose(isAbsolute(p) ? p : resolve(context.cwd, p))
    return !roots.some((root) => isInside(root, real))
  })
  const allow = true
  const option = pickOption(request.options, ['allow_once', 'allow_always'])
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
