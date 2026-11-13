import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { RequestPermissionRequest } from '@agentclientprotocol/sdk'
import {
  buildAgentCommand,
  buildSessionMeta,
  decidePermission,
  resolveAcpAgentScript,
} from '../../src/main/acp'

describe('buildAgentCommand', () => {
  it('Claude: roda o claude-agent-acp no Node do Electron com ANTHROPIC_MODEL', () => {
    const cmd = buildAgentCommand(
      { provider: 'claude', model: 'claude-haiku-4-5', systemPrompt: 'x' },
      { nodeBinary: '/bin/electron', scriptPath: '/s.js', baseEnv: { PATH: '' } },
    )
    expect(cmd).toEqual({
      command: '/bin/electron',
      args: ['/s.js'],
      env: { ELECTRON_RUN_AS_NODE: '1', ANTHROPIC_MODEL: 'claude-haiku-4-5' },
    })
  })

  it('usa o primeiro claude/codex do PATH (wrapper de rodízio) e respeita o valor do usuário', () => {
    const bin = mkdtempSync(join(tmpdir(), 'acp-bin-'))
    try {
      for (const name of ['claude', 'codex']) {
        writeFileSync(join(bin, name), '#!/bin/sh\n', { mode: 0o755 })
      }
      const base = { PATH: `${bin}:/usr/bin` }
      const claude = buildAgentCommand(
        { provider: 'claude', model: null, systemPrompt: '' },
        { nodeBinary: 'n', scriptPath: 's', baseEnv: base },
      )
      expect(claude.env.CLAUDE_CODE_EXECUTABLE).toBe(join(bin, 'claude'))
      const codex = buildAgentCommand(
        { provider: 'codex', model: null, systemPrompt: '' },
        { nodeBinary: 'n', scriptPath: 's', baseEnv: base },
      )
      expect(codex.env.CODEX_PATH).toBe(join(bin, 'codex'))
      const own = buildAgentCommand(
        { provider: 'claude', model: null, systemPrompt: '' },
        { nodeBinary: 'n', scriptPath: 's', baseEnv: { ...base, CLAUDE_CODE_EXECUTABLE: '/x' } },
      )
      expect(own.env.CLAUDE_CODE_EXECUTABLE).toBeUndefined()
    } finally {
      rmSync(bin, { recursive: true, force: true })
    }
  })

  it('Codex: modelo e prompt do papel em CODEX_CONFIG, sem perder o que o usuário já tinha', () => {
    const cmd = buildAgentCommand(
      { provider: 'codex', model: 'gpt-5.4-mini', systemPrompt: 'Você é o Revisor.' },
      {
        nodeBinary: 'n',
        scriptPath: 's',
        baseEnv: { CODEX_CONFIG: '{"model_reasoning_effort":"low"}' },
      },
    )
    expect(JSON.parse(cmd.env.CODEX_CONFIG!)).toEqual({
      model_reasoning_effort: 'low',
      model: 'gpt-5.4-mini',
      developer_instructions: 'Você é o Revisor.',
    })
  })

  it('acha os dois adaptadores ACP instalados', () => {
    expect(resolveAcpAgentScript('claude')).toMatch(/claude-agent-acp[\\/]dist[\\/]index\.js$/)
    expect(resolveAcpAgentScript('codex')).toMatch(/codex-acp[\\/]dist[\\/]index\.js$/)
  })

  it('_meta só para o Claude, com settingSources do usuário', () => {
    expect(buildSessionMeta({ provider: 'codex', systemPrompt: 'x' })).toBeUndefined()
    expect(buildSessionMeta({ provider: 'claude', systemPrompt: '' })).toEqual({
      claudeCode: { options: { settingSources: ['user', 'project', 'local'] } },
    })
  })
})

describe('decidePermission', () => {
  let dir: string
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const request = (paths: string[]): RequestPermissionRequest => ({
    sessionId: 's',
    toolCall: { toolCallId: 't', title: 'Edit', locations: paths.map((path) => ({ path })) },
    options: [
      { optionId: 'a', name: 'Sim', kind: 'allow_once' },
      { optionId: 'aa', name: 'Sempre', kind: 'allow_always' },
      { optionId: 'r', name: 'Não', kind: 'reject_once' },
    ],
  })

  it('aceita dentro (inclusive arquivo novo e caminho relativo), recusa fora e escapes com ..', () => {
    dir = mkdtempSync(join(tmpdir(), 'eclipse-perm-'))
    const wt = join(dir, 'wt')
    mkdirSync(wt)
    expect(decidePermission(request([join(wt, 'a/b/novo.ts')]), { cwd: wt }).response).toEqual({
      outcome: { outcome: 'selected', optionId: 'a' },
    })
    expect(decidePermission(request(['src/x.ts']), { cwd: wt }).allow).toBe(true)
    expect(decidePermission(request([]), { cwd: wt }).allow).toBe(true)
    const outside = decidePermission(request([join(wt, 'a.ts'), join(wt, '../fora.ts')]), {
      cwd: wt,
    })
    expect(outside.allow).toBe(false)
    expect(outside.response).toEqual({ outcome: { outcome: 'selected', optionId: 'r' } })
    expect(decidePermission(request(['/tmp/x']), { cwd: wt, extraRoots: ['/tmp'] }).allow).toBe(
      true,
    )
  })

  it('symlink de dentro da worktree para fora é recusado', () => {
    dir = mkdtempSync(join(tmpdir(), 'eclipse-perm-'))
    const wt = join(dir, 'wt')
    mkdirSync(wt)
    mkdirSync(join(dir, 'segredo'))
    symlinkSync(join(dir, 'segredo'), join(wt, 'link'))
    expect(decidePermission(request([join(wt, 'link', 'x.txt')]), { cwd: wt }).allow).toBe(false)
  })
})
