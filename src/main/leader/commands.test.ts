import { describe, expect, it } from 'vitest'
import type { LeaderLaunchRequest } from '@shared/ports'
import {
  buildClaudeMcpConfigArg,
  buildCodexMcpConfigArgs,
  buildLeaderCommand,
  claudeSessionIdFor,
  codexMcpServerKey,
} from './commands'

const mcpServer = {
  name: 'eclipse',
  command: '/opt/eclipse/electron',
  args: ['/opt/eclipse/out/mcp/server.js'],
  env: { ELECTRON_RUN_AS_NODE: '1', ECLIPSE_NEXT_MCP_TOKEN: 'tok"en' },
}

function request(overrides: Partial<LeaderLaunchRequest> = {}): LeaderLaunchRequest {
  return {
    sessionId: 'sess-1',
    taskId: 'task-1',
    provider: 'claude',
    model: null,
    cwd: '/tmp/wt',
    initialPrompt: 'Planeje a tarefa',
    resumeProviderSessionId: null,
    mcpServer,
    env: { EXTRA: 'x' },
    cols: 120,
    rows: 40,
    ...overrides,
  }
}

const options = {
  baseEnv: {
    PATH: '/home/u/.local/claude-rodizio/bin:/usr/bin',
    HOME: '/home/u',
    VAZIO: undefined,
  },
  fullAccess: true,
  claudeHookSettingsPath: '/run/hooks/settings.json',
}

describe('claudeSessionIdFor', () => {
  it('gera uuid v4 estavel por sessao', () => {
    const id = claudeSessionIdFor('sess-1')
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(claudeSessionIdFor('sess-1')).toBe(id)
    expect(claudeSessionIdFor('sess-2')).not.toBe(id)
  })
})

describe('buildLeaderCommand (Claude)', () => {
  it('nova sessao: --session-id, --mcp-config, --settings e prompt no fim', () => {
    const command = buildLeaderCommand(request({ model: 'opus' }), options)
    expect(command.command).toBe('claude')
    expect(command.args).toEqual([
      '--dangerously-skip-permissions',
      '--model',
      'opus',
      '--mcp-config',
      buildClaudeMcpConfigArg(mcpServer),
      '--settings',
      '/run/hooks/settings.json',
      '--session-id',
      claudeSessionIdFor('sess-1'),
      'Planeje a tarefa',
    ])
    const mcp = JSON.parse(command.args[4] ?? '{}')
    expect(mcp).toEqual({
      mcpServers: {
        eclipse: {
          type: 'stdio',
          command: mcpServer.command,
          args: mcpServer.args,
          env: mcpServer.env,
        },
      },
    })
  })

  it('injeta CLAUDE_CODE_ENABLE_TODO_TOOLS, a marca do app e o env do pedido', () => {
    const command = buildLeaderCommand(request(), options)
    expect(command.env).toMatchObject({
      CLAUDE_CODE_ENABLE_TODO_TOOLS: '1',
      ECLIPSE_NEXT_ENV: '1',
      EXTRA: 'x',
      PATH: '/home/u/.local/claude-rodizio/bin:/usr/bin',
    })
    expect(command.env).not.toHaveProperty('VAZIO')
  })

  it('retomar: --resume e sem prompt nem --session-id', () => {
    const command = buildLeaderCommand(request({ resumeProviderSessionId: ' abc-123 ' }), options)
    expect(command.args.slice(-2)).toEqual(['--resume', 'abc-123'])
    expect(command.args).not.toContain('--session-id')
    expect(command.args).not.toContain('Planeje a tarefa')
  })

  it('prompt que comeca com - vem depois de --', () => {
    const command = buildLeaderCommand(request({ initialPrompt: '-x perigoso' }), options)
    expect(command.args.slice(-2)).toEqual(['--', '-x perigoso'])
  })

  it('sem ganchos e sem acesso total', () => {
    const command = buildLeaderCommand(request({ initialPrompt: null }), {
      ...options,
      fullAccess: false,
      claudeHookSettingsPath: null,
    })
    expect(command.args).not.toContain('--dangerously-skip-permissions')
    expect(command.args).not.toContain('--settings')
    expect(command.args.at(-2)).toBe('--session-id')
  })
})

describe('buildLeaderCommand (Codex)', () => {
  it('nova sessao: -c mcp_servers, modelo e prompt depois de --', () => {
    const command = buildLeaderCommand(request({ provider: 'codex', model: 'gpt-5' }), options)
    expect(command.command).toBe('codex')
    expect(command.args).toEqual([
      '--dangerously-bypass-approvals-and-sandbox',
      ...buildCodexMcpConfigArgs(mcpServer),
      '--model',
      'gpt-5',
      '--',
      'Planeje a tarefa',
    ])
    expect(command.env).not.toHaveProperty('CLAUDE_CODE_ENABLE_TODO_TOOLS')
    expect(command.env['ECLIPSE_NEXT_ENV']).toBe('1')
  })

  it('retomar: resume <id> e modelo depois', () => {
    const command = buildLeaderCommand(
      request({ provider: 'codex', model: 'gpt-5', resumeProviderSessionId: 'th-1' }),
      { ...options, fullAccess: false },
    )
    expect(command.args.slice(0, 4)).toEqual([
      '--sandbox',
      'workspace-write',
      '--ask-for-approval',
      'on-request',
    ])
    expect(command.args.slice(-4)).toEqual(['resume', 'th-1', '--model', 'gpt-5'])
    expect(command.args).not.toContain('Planeje a tarefa')
  })

  it('-c usa valores TOML validos', () => {
    expect(buildCodexMcpConfigArgs(mcpServer)).toEqual([
      '-c',
      'mcp_servers.eclipse.command="/opt/eclipse/electron"',
      '-c',
      'mcp_servers.eclipse.args=["/opt/eclipse/out/mcp/server.js"]',
      '-c',
      'mcp_servers.eclipse.env={"ELECTRON_RUN_AS_NODE"="1","ECLIPSE_NEXT_MCP_TOKEN"="tok\\"en"}',
    ])
    expect(codexMcpServerKey('eclipse code.v2')).toBe('eclipse_code_v2')
  })
})
