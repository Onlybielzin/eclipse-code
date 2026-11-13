import { expect, test, type ElectronApplication, type Page } from '@playwright/test'
import {
  createTestUserDataDir,
  launchApp,
  removePathWithRetry,
  seedWorkspaceState,
  testWorkspacePath,
} from './workspace-canvas.helpers'

const workspaceId = 'workspace-space-pinning'
const pinnedSpaceId = 'space-beta'

test('pins a sidebar space into the top rail, restores it, shares its menu, and passes gap clicks through', async ({
  browserName: _browserName,
}, testInfo) => {
  const userDataDir = await createTestUserDataDir()
  let electronApp: ElectronApplication | null = null
  let window: Page | null = null

  try {
    ;({ electronApp, window } = await launchApp({ userDataDir, cleanupUserDataDir: false }))
    await seedWorkspaceState(window, {
      activeWorkspaceId: workspaceId,
      workspaces: [
        {
          id: workspaceId,
          name: 'Space Pinning',
          path: testWorkspacePath,
          nodes: [
            {
              id: 'note-under-switcher',
              title: 'Under switcher',
              position: { x: 220, y: 0 },
              width: 360,
              height: 220,
              kind: 'note',
              task: { text: 'Click target below the switcher gap' },
            },
          ],
          spaces: [
            {
              id: 'space-alpha',
              name: 'Alpha',
              directoryPath: testWorkspacePath,
              sortOrder: 0,
              pinned: false,
              nodeIds: [],
            },
            {
              id: pinnedSpaceId,
              name: 'Beta',
              directoryPath: testWorkspacePath,
              sortOrder: 1,
              pinned: false,
              nodeIds: [],
            },
            {
              id: 'space-gamma',
              name: 'Gamma',
              directoryPath: testWorkspacePath,
              sortOrder: 2,
              pinned: false,
              nodeIds: [],
            },
          ],
          activeSpaceId: null,
        },
      ],
    })

    // Eclipse Code: every top-level Space is already a task tab; pinning only orders it first.
    await expect(
      window.locator(`[data-testid="workspace-space-switch-${pinnedSpaceId}"]`),
    ).toBeVisible()
    await window
      .locator(`[data-testid="workspace-space-item-${workspaceId}-${pinnedSpaceId}"]`)
      .click({ button: 'right' })
    await window.locator(`[data-testid="workspace-space-context-pin-${pinnedSpaceId}"]`).click()

    await expect(
      window.locator(`[data-testid="workspace-space-switch-${pinnedSpaceId}"]`),
    ).toBeVisible()
    await expect(
      window.locator('.workspace-space-group--space .workspace-space-item__name'),
    ).toHaveText(['Beta', 'Alpha', 'Gamma'])
    await expect
      .poll(async () => {
        const raw = await window!.evaluate(async () => {
          return await window.eclipseCodeApi.persistence.readWorkspaceStateRaw()
        })
        const parsed = raw
          ? (JSON.parse(raw) as {
              workspaces?: Array<{ spaces?: Array<{ id?: string; pinned?: boolean }> }>
            })
          : null
        return parsed?.workspaces?.[0]?.spaces?.find(space => space.id === pinnedSpaceId)?.pinned
      })
      .toBe(true)

    await electronApp.close()
    electronApp = null
    window = null
    ;({ electronApp, window } = await launchApp({ userDataDir, cleanupUserDataDir: false }))

    const pill = window.locator(`[data-testid="workspace-space-switch-${pinnedSpaceId}"]`)
    await expect(pill).toBeVisible()
    await pill.click({ button: 'right' })
    await expect(
      window.locator(`[data-testid="workspace-space-context-pin-${pinnedSpaceId}"]`),
    ).toContainText('Unpin space')
    await window.keyboard.press('Escape')

    // The root-canvas note is outside every task: show "All" so it sits under the tabs.
    await window.getByTestId('workspace-space-switch-all').click()
    const noteMenuButton = window.getByTestId('note-node-more')
    await expect(noteMenuButton).toBeVisible()
    const hitTargetIsNoteButton = await noteMenuButton.evaluate(button => {
      const rect = button.getBoundingClientRect()
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
      return hit?.closest('[data-testid="note-node-more"]') === button
    })
    expect(hitTargetIsNoteButton).toBe(true)
    await noteMenuButton.click()
    await expect(window.getByTestId('note-node-menu')).toBeVisible()
    await window.keyboard.press('Escape')

    await testInfo.attach('space-pinning-and-click-through', {
      body: await window.screenshot(),
      contentType: 'image/png',
    })

    await pill.click({ button: 'right' })
    await window.locator(`[data-testid="workspace-space-context-pin-${pinnedSpaceId}"]`).click()
    // Unpinning only changes the order: the Space stays a task tab.
    await expect(pill).toBeVisible()
    await pill.click({ button: 'right' })
    await expect(
      window.locator(`[data-testid="workspace-space-context-pin-${pinnedSpaceId}"]`),
    ).toContainText('Pin space')
    await window.keyboard.press('Escape')
  } finally {
    await electronApp?.close().catch(() => undefined)
    await removePathWithRetry(userDataDir)
  }
})
