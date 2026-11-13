import { spawn } from 'node:child_process'
import { runCli, type CliResult } from './runCli'

function parseJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

/** Archives the caller's task: worktree first (safe stop on uncommitted work), then windows, tab, self. */
export async function closeTask({
  deleteBranch,
  force,
}: {
  deleteBranch: boolean
  force: boolean
}): Promise<CliResult> {
  const self = await runCli(['node', 'get', '--node', '@self', '--fields', 'id,spaceId'])
  const selfNode = parseJson<{ node?: { id?: string; spaceId?: string | null } }>(self.stdout)?.node
  if (self.code !== 0 || !selfNode?.id) {
    return { code: 1, stdout: '', stderr: `Não consegui identificar a sua janela.\n${self.stderr}` }
  }
  if (!selfNode.spaceId) {
    return { code: 2, stdout: '', stderr: 'Você não está dentro de uma tarefa (Space).' }
  }
  const listed = await runCli(['space', 'list', '--fields', 'id,parentSpaceId'])
  const spaces =
    parseJson<{ spaces?: Array<{ id: string; parentSpaceId?: string | null }> }>(listed.stdout)
      ?.spaces ?? []
  let taskId = selfNode.spaceId
  for (let guard = 0; guard < 32; guard += 1) {
    const parent = spaces.find(space => space.id === taskId)?.parentSpaceId
    if (!parent) {
      break
    }
    taskId = parent
  }
  const members = new Set([taskId])
  let grew = true
  while (grew) {
    grew = false
    for (const space of spaces) {
      if (space.parentSpaceId && members.has(space.parentSpaceId) && !members.has(space.id)) {
        members.add(space.id)
        grew = true
      }
    }
  }

  const archiveArgs = ['worktree', 'archive', '--space', taskId]
  if (deleteBranch) {
    archiveArgs.push('--delete-branch')
  }
  if (force) {
    archiveArgs.push('--force')
  }
  const archived = await runCli(archiveArgs)
  if (archived.code !== 0) {
    return {
      ...archived,
      stderr: `A worktree não foi arquivada; nada foi fechado. Faça o commit (ou peça ao vings para forçar).\n${archived.stderr}`,
    }
  }

  const nodes = await runCli(['node', 'list', '--fields', 'id,spaceId'])
  const others = (
    parseJson<{ nodes?: Array<{ id: string; spaceId?: string | null }> }>(nodes.stdout)?.nodes ?? []
  ).filter(node => node.id !== selfNode.id && node.spaceId && members.has(node.spaceId))
  const deletions = await Promise.all(
    others.map(node => runCli(['node', 'delete', '--node', node.id])),
  )
  const closed = deletions.filter(result => result.code === 0)

  const removed = await runCli([
    'api',
    'call',
    'space.delete',
    '--input',
    JSON.stringify({ spaceId: taskId }),
  ])

  // Last: close this agent's own window a moment after the reply is delivered.
  spawn(process.execPath, [process.argv[1]!, 'node', 'delete', '--node', selfNode.id], {
    env: process.env,
    detached: true,
    stdio: 'ignore',
  }).unref()

  return {
    code: removed.code,
    stdout: [
      `Worktree arquivada${deleteBranch ? ' e branch apagada' : ''}.`,
      `${closed.length} janela(s) da tarefa fechada(s).`,
      removed.code === 0
        ? 'Aba da tarefa removida.'
        : 'A aba não foi removida (veja o erro abaixo).',
      'Esta janela fecha em seguida.',
    ].join('\n'),
    stderr: removed.code === 0 ? '' : removed.stderr,
  }
}
