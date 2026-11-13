import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { listAgentSessions } from '../../../src/contexts/agent/infrastructure/cli/AgentSessionCatalog'
import { locateAgentResumeSessionId } from '../../../src/contexts/agent/infrastructure/cli/AgentSessionLocator'
import { encodeClaudeProjectPath } from '../../../src/contexts/agent/infrastructure/ClaudeProjectPaths'
import { resolveSessionFilePath } from '../../../src/contexts/agent/infrastructure/watchers/SessionFileResolver'

const describeOnWindows = process.platform === 'win32' ? describe : describe.skip

describeOnWindows('Claude project paths on Windows', () => {
  it('matches Claude Code drive-letter project directory encoding', async () => {
    const tempHome = await fs.mkdtemp(join(tmpdir(), 'eclipse-code-claude-home-'))
    const previousHome = process.env.HOME
    const cwd = 'D:\\Development\\eclipse-code\\docs'
    const startedAtMs = Date.now()
    const sessionId = 'claude-windows-session'
    const encodedProjectPath = encodeClaudeProjectPath(cwd)
    const sessionFilePath = join(
      tempHome,
      '.claude',
      'projects',
      encodedProjectPath,
      `${sessionId}.jsonl`,
    )

    try {
      process.env.HOME = tempHome
      await fs.mkdir(dirname(sessionFilePath), { recursive: true })
      await fs.writeFile(
        sessionFilePath,
        `${JSON.stringify({ type: 'permission-mode', sessionId })}\n`,
        'utf8',
      )

      expect(encodedProjectPath).toBe('D--Development-eclipse-code-docs')
      await expect(
        locateAgentResumeSessionId({
          provider: 'claude-code',
          cwd,
          startedAtMs,
          timeoutMs: 0,
        }),
      ).resolves.toBe(sessionId)
      await expect(
        resolveSessionFilePath({
          provider: 'claude-code',
          cwd,
          sessionId,
          startedAtMs,
          timeoutMs: 0,
        }),
      ).resolves.toBe(sessionFilePath)

      const sessions = await listAgentSessions({ provider: 'claude-code', cwd, limit: 5 })
      expect(sessions.sessions[0]?.sessionId).toBe(sessionId)
    } finally {
      process.env.HOME = previousHome
      await fs.rm(tempHome, { recursive: true, force: true })
    }
  })

  it('matches Claude Code hidden worktree project directory encoding', async () => {
    const tempHome = await fs.mkdtemp(join(tmpdir(), 'eclipse-code-claude-home-'))
    const previousHome = process.env.HOME
    const cwd =
      'D:\\Development\\eclipse-code\\.eclipse-code\\worktrees\\fix-resume-claude-agent--f8fd20ab'
    const startedAtMs = Date.now()
    const sessionId = 'claude-hidden-worktree-session'
    const encodedProjectPath = encodeClaudeProjectPath(cwd)
    const sessionFilePath = join(
      tempHome,
      '.claude',
      'projects',
      encodedProjectPath,
      `${sessionId}.jsonl`,
    )

    try {
      process.env.HOME = tempHome
      await fs.mkdir(dirname(sessionFilePath), { recursive: true })
      await fs.writeFile(
        sessionFilePath,
        `${JSON.stringify({ type: 'permission-mode', sessionId })}\n`,
        'utf8',
      )

      expect(encodedProjectPath).toBe(
        'D--Development-eclipse-code--eclipse-code-worktrees-fix-resume-claude-agent--f8fd20ab',
      )
      await expect(
        locateAgentResumeSessionId({
          provider: 'claude-code',
          cwd,
          startedAtMs,
          timeoutMs: 0,
        }),
      ).resolves.toBe(sessionId)
      await expect(
        resolveSessionFilePath({
          provider: 'claude-code',
          cwd,
          sessionId,
          startedAtMs,
          timeoutMs: 0,
        }),
      ).resolves.toBe(sessionFilePath)

      const sessions = await listAgentSessions({ provider: 'claude-code', cwd, limit: 5 })
      expect(sessions.sessions[0]?.sessionId).toBe(sessionId)
    } finally {
      process.env.HOME = previousHome
      await fs.rm(tempHome, { recursive: true, force: true })
    }
  })

  it('keeps resolving legacy dot-preserving Claude project directories', async () => {
    const tempHome = await fs.mkdtemp(join(tmpdir(), 'eclipse-code-claude-home-'))
    const previousHome = process.env.HOME
    const cwd = 'D:\\Development\\eclipse-code\\.eclipse-code\\worktrees\\legacy'
    const startedAtMs = Date.now()
    const sessionId = 'claude-legacy-session'
    const legacyEncodedProjectPath = 'D--Development-eclipse-code-.eclipse-code-worktrees-legacy'
    const sessionFilePath = join(
      tempHome,
      '.claude',
      'projects',
      legacyEncodedProjectPath,
      `${sessionId}.jsonl`,
    )

    try {
      process.env.HOME = tempHome
      await fs.mkdir(dirname(sessionFilePath), { recursive: true })
      await fs.writeFile(
        sessionFilePath,
        `${JSON.stringify({ type: 'permission-mode', sessionId })}\n`,
        'utf8',
      )

      await expect(
        locateAgentResumeSessionId({
          provider: 'claude-code',
          cwd,
          startedAtMs,
          timeoutMs: 0,
        }),
      ).resolves.toBe(sessionId)
      await expect(
        resolveSessionFilePath({
          provider: 'claude-code',
          cwd,
          sessionId,
          startedAtMs,
          timeoutMs: 0,
        }),
      ).resolves.toBe(sessionFilePath)
    } finally {
      process.env.HOME = previousHome
      await fs.rm(tempHome, { recursive: true, force: true })
    }
  })
})
