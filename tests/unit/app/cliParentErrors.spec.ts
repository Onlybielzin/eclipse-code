// @vitest-environment node
import { expect, it } from 'vitest'
import { run } from '../../../src/app/cli/core/run'
import { identityFixture } from './cliIdentity.helpers'

const cases = [
  {
    reason: 'no_parent',
    message: 'This node was started by the user, so it has no parent agent.',
    hint: 'Use "eclipse-code agent list" to choose a recipient, or report your findings to the user.',
  },
  {
    reason: 'parent_deleted',
    message: 'The agent that created this node has been deleted.',
    hint: 'Use "eclipse-code agent list" to choose another recipient, or leave your findings in a shared note.',
  },
  {
    reason: 'caller_identity_required',
    message: '@parent works only inside an Eclipse Code terminal.',
    hint: 'Run this command inside Eclipse Code, or replace @parent with a node ID from "eclipse-code node list".',
  },
  {
    reason: 'caller_identity_mismatch',
    code: 'common.forbidden',
    exit: 4,
    message: 'The current terminal identity does not match its Eclipse Code session.',
    hint: 'Open a new Eclipse Code terminal and run "eclipse-code whoami" before choosing a recipient.',
  },
  {
    reason: 'unknown_reason',
    message: 'The parent node could not be resolved.',
    hint: 'Run "eclipse-code node get --node @self" to inspect your lineage, then choose a recipient with "eclipse-code node list".',
  },
]

it.each(cases.flatMap(item => [false, true].map(tty => ({ ...item, tty }))))(
  'renders $reason through run() stderr (TTY=$tty)',
  async ({ tty, ...item }) => {
    const f = identityFixture(item.reason !== 'caller_identity_required')
    let stderr = ''
    f.io.stderr = {
      isTTY: tty,
      write: text => {
        stderr += text
      },
    }
    const requests: string[] = []
    const code = item.code ?? 'node.parent_unavailable'
    f.io.fetch = async (url, init) => {
      const request = JSON.parse(String(init?.body))
      requests.push(request.id)
      return request.id === 'node.resolveCallerSelector'
        ? new Response(
            JSON.stringify({ ok: false, error: { code, details: { reason: item.reason } } }),
            {
              status: item.code === 'common.forbidden' ? 403 : 200,
            },
          )
        : f.fetch(url, init)
    }
    expect(
      await run(['agent', 'prompt', '--node', '@parent', '--text', 'Status update'], f.io),
    ).toBe(item.exit ?? 1)
    expect(f.out()).toBe('')
    expect(requests).toContain('node.resolveCallerSelector')
    expect(requests).not.toContain('agent.prompt')
    if (tty) {
      expect(stderr).toBe(`error[${code}]: ${item.message}\n  hint: ${item.hint}\n`)
    } else {
      expect(JSON.parse(stderr).error).toEqual({
        code,
        retryable: false,
        message: item.message,
        hint: item.hint,
        details: { reason: item.reason },
      })
    }
  },
)
