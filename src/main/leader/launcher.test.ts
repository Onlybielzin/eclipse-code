import { describe, expect, it, vi } from 'vitest'
import type { LeaderLaunchRequest, PtyHost } from '@shared/ports'
import { createLeaderLauncher } from './launcher'
import type { LeaderSessionRegistry } from './leaderSessions'

const request: LeaderLaunchRequest = {
  sessionId: 'sess-1',
  taskId: 'task-1',
  provider: 'claude',
  model: null,
  cwd: '/tmp/wt',
  initialPrompt: 'oi',
systemPrompt: null,
  resumeProviderSessionId: null,
  mcpServer: { name: 'eclipse', command: 'n', args: [], env: {} },
  env: {},
  cols: 80,
  rows: 24,
}

describe('LeaderLauncher com env do Windows', () => {
  it('baseEnv so com Path (nao PATH): o claude e procurado nesse PATH', async () => {
    const spawn = vi.fn(async () => ({ ptyId: 'p1', pid: 1 }))
    const resolveExecutable = vi.fn((command: string, pathValue: string | undefined) =>
      pathValue === 'C:\\bin' ? `C:\\bin\\${command}.exe` : null,
    )
    const launcher = createLeaderLauncher({
      ptyHost: { spawn } as unknown as PtyHost,
      registry: { register: vi.fn() } as unknown as LeaderSessionRegistry,
      dirs: { claudeConfigDirs: [], codexHomes: [] },
      hooksRoot: null,
      baseEnv: { Path: 'C:\\bin' },
      resolveExecutable,
    })
    const result = await launcher.launch(request)
    expect(resolveExecutable).toHaveBeenCalledWith('claude', 'C:\\bin')
    expect(result.command.command).toBe('C:\\bin\\claude.exe')
  })
})
