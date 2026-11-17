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
      { provider: 'claude', model: 'claude-haiku-4-5', systemPrompt: 'x', access: 'full' },
      { nodeBinary: '/bin/electron', scriptPath: '/s.js', baseEnv: { PATH: '' } },
    )
    expect(cmd).toEqual({
      command: '/bin/electron',
      args: ['/s.js'],
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        CLAUDE_CODE_EXECUTABLE: 'claude',
        ANTHROPIC_MODEL: 'claude-haiku-4-5',
      },
    })
  })

  it('sem CLI no PATH usa o nome puro: nunca cai no binario embutido (fora do pacote)', () => {
    for (const provider of ['claude', 'codex'] as const) {
      const cmd = buildAgentCommand(
        { provider, model: null, systemPrompt: '', access: 'full' },
        { nodeBinary: 'n', scriptPath: 's', baseEnv: { PATH: '' } },
      )
      const variable = provider === 'claude' ? 'CLAUDE_CODE_EXECUTABLE' : 'CODEX_PATH'
      expect(cmd.env[variable]).toBe(provider)
    }
  })

  it('usa o primeiro claude/codex do PATH (wrapper de rodízio) e respeita o valor do usuário', () => {
    const bin = mkdtempSync(join(tmpdir(), 'acp-bin-'))
    try {
      for (const name of ['claude', 'codex']) {
        writeFileSync(join(bin, name), '#!/bin/sh\n', { mode: 0o755 })
      }
      const base = { PATH: `${bin}:/usr/bin` }
      const claude = buildAgentCommand(
        { provider: 'claude', model: null, systemPrompt: '', access: 'full' },
        { nodeBinary: 'n', scriptPath: 's', baseEnv: base },
      )
      expect(claude.env.CLAUDE_CODE_EXECUTABLE).toBe(join(bin, 'claude'))
      const codex = buildAgentCommand(
        { provider: 'codex', model: null, systemPrompt: '', access: 'full' },
        { nodeBinary: 'n', scriptPath: 's', baseEnv: base },
      )
      expect(codex.env.CODEX_PATH).toBe(join(bin, 'codex'))
      const own = buildAgentCommand(
        { provider: 'claude', model: null, systemPrompt: '', access: 'full' },
        { nodeBinary: 'n', scriptPath: 's', baseEnv: { ...base, CLAUDE_CODE_EXECUTABLE: '/x' } },
      )
      expect(own.env.CLAUDE_CODE_EXECUTABLE).toBeUndefined()
    } finally {
      rmSync(bin, { recursive: true, force: true })
    }
  })

  it('Codex: modelo, prompt do papel e permissão total em CODEX_CONFIG, sem perder o que o usuário já tinha', () => {
    const cmd = buildAgentCommand(
      {
        provider: 'codex',
        model: 'gpt-5.4-mini',
        systemPrompt: 'Você é o Revisor.',
        access: 'full',
      },
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
      sandbox_mode: 'danger-full-access',
      approval_policy: 'never',
    })
  })

  it('acha os dois adaptadores ACP instalados', () => {
    expect(resolveAcpAgentScript('claude')).toMatch(/claude-agent-acp[\\/]dist[\\/]index\.js$/)
    expect(resolveAcpAgentScript('codex')).toMatch(/codex-acp[\\/]dist[\\/]index\.js$/)
  })

  it('_meta só para o Claude, com settingSources do usuário', () => {
    expect(
      buildSessionMeta({ provider: 'codex', systemPrompt: 'x', access: 'read_only' }),
    ).toBeUndefined()
    expect(buildSessionMeta({ provider: 'claude', systemPrompt: '', access: 'full' })).toEqual({
      claudeCode: { options: { settingSources: ['user', 'project', 'local'] } },
    })
  })

  it('Claude read_only: disallowedTools de edição no _meta (session/new e session/load)', () => {
    expect(buildSessionMeta({ provider: 'claude', systemPrompt: '', access: 'read_only' })).toEqual(
      {
        claudeCode: {
          options: {
            settingSources: ['user', 'project', 'local'],
            disallowedTools: ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'],
          },
        },
      },
    )
    const noCommit = buildSessionMeta({ provider: 'claude', systemPrompt: '', access: 'no_commit' })
    expect(JSON.stringify(noCommit)).not.toContain('disallowedTools')
  })

  it('Codex read_only: sandbox read-only; os outros mantêm danger-full-access', () => {
    const config = (access: 'full' | 'no_commit' | 'read_only') =>
      JSON.parse(
        buildAgentCommand(
          { provider: 'codex', model: null, systemPrompt: '', access },
          { nodeBinary: 'n', scriptPath: 's', baseEnv: {} },
        ).env.CODEX_CONFIG!,
      ) as Record<string, unknown>
    expect(config('read_only')).toMatchObject({
      sandbox_mode: 'read-only',
      approval_policy: 'never',
    })
    expect(config('no_commit').sandbox_mode).toBe('danger-full-access')
    expect(config('full').sandbox_mode).toBe('danger-full-access')
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

  it('aceita tudo, dentro e fora da worktree (permissão total), e o motivo diz onde', () => {
    dir = mkdtempSync(join(tmpdir(), 'eclipse-perm-'))
    const wt = join(dir, 'wt')
    mkdirSync(wt)
    // allow_once sempre: allow_always grava regra na worktree e o próximo membro a herda.
    const inside = decidePermission(request([join(wt, 'a/b/novo.ts')]), { cwd: wt, access: 'full' })
    expect(inside).toEqual({
      allow: true,
      reason: 'dentro da worktree',
      response: { outcome: { outcome: 'selected', optionId: 'a' } },
    })
    expect(decidePermission(request(['src/x.ts']), { cwd: wt, access: 'full' }).reason).toBe(
      'dentro da worktree',
    )
    expect(decidePermission(request([]), { cwd: wt, access: 'full' })).toMatchObject({
      allow: true,
      reason: 'sem caminho de arquivo',
    })
    const outside = decidePermission(request([join(wt, 'a.ts'), join(wt, '../fora.ts')]), {
      cwd: wt,
      access: 'full',
    })
    expect(outside).toEqual({
      allow: true,
      reason: `fora da worktree: ${join(wt, '../fora.ts')}`,
      response: { outcome: { outcome: 'selected', optionId: 'a' } },
    })
    expect(
      decidePermission(request(['/tmp/x']), { cwd: wt, access: 'full', extraRoots: ['/tmp'] })
        .reason,
    ).toBe('dentro da worktree')
    // Só allow_once no pedido: aceita com ele.
    const once = decidePermission(
      {
        ...request(['/etc/passwd']),
        options: [{ optionId: 'a', name: 'Sim', kind: 'allow_once' }],
      },
      { cwd: wt, access: 'full' },
    )
    expect(once.response).toEqual({ outcome: { outcome: 'selected', optionId: 'a' } })
    // Sem opção de aceitar: cancela pelo protocolo.
    const none = decidePermission(
      { ...request([]), options: [{ optionId: 'r', name: 'Não', kind: 'reject_once' }] },
      { cwd: wt, access: 'full' },
    )
    expect(none).toMatchObject({ allow: false, response: { outcome: { outcome: 'cancelled' } } })
  })

  describe('trava por acesso do papel', () => {
    const cwd = '/wt'
    const tool = (
      kind: 'edit' | 'delete' | 'move' | 'execute' | 'read',
      command?: string,
    ): RequestPermissionRequest => ({
      ...request([]),
      toolCall: {
        toolCallId: 't',
        title: kind,
        kind,
        ...(command === undefined ? {} : { rawInput: { command } }),
      },
    })

    it('read_only nega edit, delete e move com reject_once', () => {
      for (const kind of ['edit', 'delete', 'move'] as const) {
        expect(decidePermission(tool(kind), { cwd, access: 'read_only' })).toEqual({
          allow: false,
          reason: 'papel só leitura: edição bloqueada',
          response: { outcome: { outcome: 'selected', optionId: 'r' } },
        })
      }
      expect(decidePermission(tool('read'), { cwd, access: 'read_only' }).allow).toBe(true)
    })

    it('no_commit permite edit, mas nega git commit/push/merge', () => {
      expect(decidePermission(tool('edit'), { cwd, access: 'no_commit' }).allow).toBe(true)
      for (const command of [
        'git commit -m x',
        'git -C a push',
        'cd a && git merge b',
        'bash -c "git commit -m x"',
        "sh -c 'cd a; git push'",
        'git rebase main',
        'git cherry-pick abc',
        'env X=y git revert HEAD',
        '/usr/bin/git am p.patch',
        'git -c user.name=a --no-pager commit -m x',
        'pnpm test; git merge main',
        'git  push origin HEAD',
        'echo a\ngit commit -m x',
        '(git commit)',
        '(cd a && git commit -am x)',
        '$(git commit)',
        '{ git commit; }',
        '`git commit`',
        'git --git-dir .git commit',
        'git --work-tree w --namespace n --exec-path p push',
        'sudo git commit -m x',
        'command git push',
        'time git merge b',
        'nice -n 5 git rebase main',
        'xargs git commit',
        'env -i git commit',
        'env -i FOO=1 git push',
        'bash -lc "git push"',
        'zsh -c "git commit"',
        'sh -lc "(git commit)"',
      ]) {
        const d = decidePermission(tool('execute', command), { cwd, access: 'no_commit' })
        expect(d, command).toMatchObject({
          allow: false,
          reason: 'papel sem commit: git commit, push, merge e similares bloqueados',
        })
      }
      for (const command of [
        'git stash push -m wip',
        'git log --grep commit',
        'git log -S merge',
        'git commit-tree x',
        'git config merge.ff false',
        'git status',
        'git diff',
        'echo "git commit"',
        'echo commit',
        'git --no-pager log',
        'git help commit',
        'env -i ls',
      ]) {
        expect(decidePermission(tool('execute', command), { cwd, access: 'no_commit' }).allow, command).toBe(
          true,
        )
      }
    })

    it('read_only também nega commit; full permite tudo', () => {
      expect(
        decidePermission(tool('execute', 'git commit -m x'), { cwd, access: 'read_only' }).allow,
      ).toBe(false)
      for (const kind of ['edit', 'delete'] as const) {
        expect(decidePermission(tool(kind), { cwd, access: 'full' }).allow).toBe(true)
      }
      expect(decidePermission(tool('execute', 'git push'), { cwd, access: 'full' }).allow).toBe(
        true,
      )
    })

    it('sem opção de recusa devolve cancelled; reject_always serve', () => {
      const onlyAllow = {
        ...tool('edit'),
        options: [{ optionId: 'a', name: 'Sim', kind: 'allow_once' as const }],
      }
      expect(decidePermission(onlyAllow, { cwd, access: 'read_only' })).toMatchObject({
        allow: false,
        response: { outcome: { outcome: 'cancelled' } },
      })
      const always = {
        ...tool('edit'),
        options: [{ optionId: 'ra', name: 'Nunca', kind: 'reject_always' as const }],
      }
      expect(decidePermission(always, { cwd, access: 'read_only' }).response).toEqual({
        outcome: { outcome: 'selected', optionId: 'ra' },
      })
    })
  })

  it('symlink de dentro da worktree para fora é aceito, com motivo "fora da worktree"', () => {
    dir = mkdtempSync(join(tmpdir(), 'eclipse-perm-'))
    const wt = join(dir, 'wt')
    mkdirSync(wt)
    mkdirSync(join(dir, 'segredo'))
    symlinkSync(join(dir, 'segredo'), join(wt, 'link'))
    const decision = decidePermission(request([join(wt, 'link', 'x.txt')]), {
      cwd: wt,
      access: 'full',
    })
    expect(decision.allow).toBe(true)
    expect(decision.reason).toBe(`fora da worktree: ${join(wt, 'link', 'x.txt')}`)
  })
})

describe('buildAgentCommand no win32', () => {
  it('Claude: shim .cmd do npm vira o caminho do .js; Codex nao muda', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shim-'))
    try {
      writeFileSync(join(dir, 'claude.CMD'), '@"%dp0%\\node_modules\\x\\cli.js" %*\r\n')
      writeFileSync(join(dir, 'codex.CMD'), '@"%dp0%\\node_modules\\x\\codex.js" %*\r\n')
      const base = {
        nodeBinary: 'n',
        scriptPath: 's',
        baseEnv: { PATH: dir },
        platform: 'win32',
      } as const
      const claude = buildAgentCommand(
        { provider: 'claude', model: null, systemPrompt: '', access: 'full' },
        base,
      )
      expect(claude.env.CLAUDE_CODE_EXECUTABLE).toBe(join(dir, 'node_modules', 'x', 'cli.js'))
      const codex = buildAgentCommand(
        { provider: 'codex', model: null, systemPrompt: '', access: 'full' },
        base,
      )
      expect(codex.env.CODEX_PATH).toBe(join(dir, 'codex.CMD'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('Claude: shim com alvo .exe usa o .exe; .cmd que nao e shim vira erro', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shim-'))
    try {
      const base = {
        nodeBinary: 'n',
        scriptPath: 's',
        baseEnv: { PATH: dir },
        platform: 'win32',
      } as const
      const request = { provider: 'claude', model: null, systemPrompt: '', access: 'full' } as const
      writeFileSync(join(dir, 'claude.CMD'), '@"%dp0%\\node_modules\\x\\bin\\claude.exe" %*\r\n')
      expect(buildAgentCommand(request, base).env.CLAUDE_CODE_EXECUTABLE).toBe(
        join(dir, 'node_modules', 'x', 'bin', 'claude.exe'),
      )
      writeFileSync(join(dir, 'claude.CMD'), '@echo oi\r\n')
      expect(() => buildAgentCommand(request, base)).toThrow(/versão nativa/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('baseEnv copiado do Windows so com Path (nao PATH) acha o claude', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shim-'))
    try {
      writeFileSync(join(dir, 'claude.EXE'), '')
      const cmd = buildAgentCommand(
        { provider: 'claude', model: null, systemPrompt: '', access: 'full' },
        { nodeBinary: 'n', scriptPath: 's', baseEnv: { Path: dir }, platform: 'win32' },
      )
      expect(cmd.env.CLAUDE_CODE_EXECUTABLE).toBe(join(dir, 'claude.EXE'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
