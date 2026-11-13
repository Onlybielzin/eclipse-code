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
          // O token fica no ambiente do processo, nunca no argv.
          env: { ELECTRON_RUN_AS_NODE: '1' },
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
      'mcp_servers.eclipse.env={"ELECTRON_RUN_AS_NODE"="1"}',
      '-c',
      'mcp_servers.eclipse.env_vars=["ECLIPSE_NEXT_MCP_TOKEN"]',
      '-c',
      'mcp_servers.eclipse.tool_timeout_sec=1860',
    ])
    expect(codexMcpServerKey('eclipse code.v2')).toBe('eclipse_code_v2')
  })
})

describe('ambiente herdado do app antigo', () => {
  const legacy = {
    PATH: '/run/old/cli-shim:/home/u/.local/bin:/usr/bin',
    HOME: '/home/u',
    ZDOTDIR: '/run/old/zsh',
    ECLIPSE_CODE_ENV: '1',
    ECLIPSE_CODE_CONTROL_URL: 'http://127.0.0.1:9/ctl',
    ECLIPSE_CODE_CONTROL_TOKEN: 'segredo-antigo',
    ECLIPSE_CODE_NODE_ID: 'no-1',
    ECLIPSE_CODE_SPACE_ID: 'space-1',
    ECLIPSE_CODE_TEAM_RELAY: '1',
    ECLIPSE_CODE_CLI_SHIM_DIRECTORY: '/run/old/cli-shim',
    ECLIPSE_CODE_TERMINAL_AGENT_ZSH_DOT_DIRECTORY: '/run/old/zsh',
    ECLIPSE_CODE_TERMINAL_AGENT_ORIGINAL_ZDOTDIR: '',
    ECLIPSE_NEXT_MCP_TOKEN: 'token-do-pai',
  }

  it('Líder não herda ECLIPSE_CODE_*, o shim do CLI antigo nem o token MCP do pai', () => {
    for (const provider of ['claude', 'codex'] as const) {
      const command = buildLeaderCommand(request({ provider }), { ...options, baseEnv: legacy })
      expect(Object.keys(command.env).filter((k) => k.startsWith('ECLIPSE_CODE_'))).toEqual([])
      expect(command.env['PATH']).toBe('/home/u/.local/bin:/usr/bin')
      expect(command.env).not.toHaveProperty('ZDOTDIR')
      expect(command.env['ECLIPSE_NEXT_MCP_TOKEN']).not.toBe('token-do-pai')
      expect(command.env['ECLIPSE_NEXT_ENV']).toBe('1')
      expect(command.env['HOME']).toBe('/home/u')
    }
  })
})

describe('token MCP do Líder fora da linha de comando', () => {
  it('Claude: o token vai no ambiente do processo, nunca no --mcp-config', () => {
    const command = buildLeaderCommand(request(), options)
    expect(command.args.join(' ')).not.toContain('tok"en')
    expect(command.args.join(' ')).not.toContain('ECLIPSE_NEXT_MCP_TOKEN')
    expect(command.env['ECLIPSE_NEXT_MCP_TOKEN']).toBe('tok"en')
    const config = JSON.parse(command.args[command.args.indexOf('--mcp-config') + 1] ?? '{}')
    expect(config.mcpServers.eclipse.env).toEqual({ ELECTRON_RUN_AS_NODE: '1' })
  })

  it('Codex: o token vai no ambiente e o -c só repassa o nome (env_vars)', () => {
    const command = buildLeaderCommand(request({ provider: 'codex' }), options)
    expect(command.args.join(' ')).not.toContain('tok"en')
    expect(command.env['ECLIPSE_NEXT_MCP_TOKEN']).toBe('tok"en')
    expect(command.args).toContain('mcp_servers.eclipse.env_vars=["ECLIPSE_NEXT_MCP_TOKEN"]')
  })
})
