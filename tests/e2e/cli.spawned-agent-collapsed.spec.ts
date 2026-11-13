import { expect, test } from '@playwright/test'
import { boundedWorkspace } from './cli.bounded-agent-spawning.helpers'
import type { CreateNodeResult } from '../../src/shared/contracts/dto/nodeControl'

test('an agent created by another agent starts minimized and keeps the user choice', async () => {
  test.setTimeout(240_000)
  await boundedWorkspace(async f => {
    const page = f.page()
    const spawn = async (title: string) => {
      const result = await f.command(f.parent, [
        'node',
        'create',
        'agent',
        '--root-canvas',
        '--provider',
        'claude-code',
        '--title',
        title,
      ])
      expect(result.code, result.stderr).toBe(0)
      return (JSON.parse(result.stdout) as CreateNodeResult).node
    }
    const minimized = (id: string) =>
      page.locator(`[data-id="${id}"] .cove-node-presentation[data-cove-collapsed="true"]`)

    // The lead the user opened stays a full window.
    await expect(page.locator(`[data-id="${f.parent.id}"] .terminal-node`)).toBeVisible()
    await expect(minimized(f.parent.id)).toHaveCount(0)

    const first = await spawn('Dev 1')
    await expect(minimized(first.id)).toHaveCount(1, { timeout: 20_000 })
    await expect(page.getByTestId(`collapsed-node-${first.id}`)).toBeVisible()

    // Minimized is display only: the member still runs and the lead can read its screen.
    await expect
      .poll(
        async () => {
          const read = await f.command(f.parent, ['agent', 'read', '--node', first.id, '--screen'])
          return read.code === 0 ? read.stdout : ''
        },
        { timeout: 30_000 },
      )
      .toContain('STRICT_READY')

    // One click opens the full terminal.
    await page.getByTestId(`collapsed-node-${first.id}`).getByTestId('node-expand').click()
    await expect(minimized(first.id)).toHaveCount(0)
    await expect(page.locator(`[data-id="${first.id}"] .terminal-node`)).toBeVisible()

    // A later creation minimizes only the new member; the window the user opened stays open.
    const second = await spawn('Dev 2')
    await expect(minimized(second.id)).toHaveCount(1, { timeout: 20_000 })
    await expect(minimized(first.id)).toHaveCount(0)
    await expect(minimized(f.parent.id)).toHaveCount(0)
  })
})
