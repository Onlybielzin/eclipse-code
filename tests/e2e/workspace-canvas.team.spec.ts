import { expect, test } from '@playwright/test'
import { clearAndSeedWorkspace, launchApp } from './workspace-canvas.helpers'

// Eclipse Code: the project team. One menu action adds the default roles (Lead, Devs, Tests,
// Reviewer) and opens the Lead's window; the role editor shows provider, model and lead.
test.describe('Workspace Canvas - Project team', () => {
  test('creates the default team and opens the lead window', async () => {
    const { electronApp, window } = await launchApp()
    try {
      await clearAndSeedWorkspace(window, [])
      const pane = window.locator('.workspace-canvas .react-flow__pane')
      await expect(pane).toBeVisible()

      await pane.click({ button: 'right', position: { x: 200, y: 200 } })
      await window.getByTestId('workspace-context-run-role').click()
      await window.getByTestId('workspace-context-create-default-team').click()

      const lead = window.getByTestId('role-node')
      await expect(lead).toHaveCount(1)
      await expect(lead).toContainText('Líder')
      // The lead opens on its own provider (Claude), not the app default.
      await expect(lead.locator('select').first()).toHaveValue('claude-code')

      // Ctrl+Enter in the input runs the role, like the Run button.
      await expect(lead).toContainText('Not run yet')
      await lead.getByTestId('role-node-input').fill('tarefa de teste')
      await lead.getByTestId('role-node-input').press('Control+Enter')
      await expect(lead).not.toContainText('Not run yet', { timeout: 20_000 })
      await expect(lead.getByTestId('role-node-input')).toHaveValue('tarefa de teste')

      // The team is saved: the action disappears once the project has a lead.
      await pane.click({ button: 'right', position: { x: 120, y: 760 } })
      await window.getByTestId('workspace-context-run-role').click()
      await expect(window.getByTestId('workspace-context-create-default-team')).toHaveCount(0)
      await Promise.all(
        ['Líder', 'Dev 1', 'Dev 2', 'Testes', 'Revisor'].map(name =>
          expect(window.getByText(name, { exact: true }).first()).toBeVisible(),
        ),
      )

      await window.getByTestId('workspace-context-new-role').click()
      await expect(window.getByTestId('workspace-role-provider')).toBeVisible()
      await expect(window.getByTestId('workspace-role-model-input')).toBeVisible()
      await expect(window.getByTestId('workspace-role-lead')).toBeVisible()
      if (process.env['TEAM_SHOT']) {
        await window.screenshot({ path: process.env['TEAM_SHOT'] })
      }
    } finally {
      await electronApp.close()
    }
  })
  test('shows and edits the team in the project settings', async () => {
    const { electronApp, window } = await launchApp()
    try {
      await clearAndSeedWorkspace(window, [])
      const pane = window.locator('.workspace-canvas .react-flow__pane')
      await expect(pane).toBeVisible()

      await pane.click({ button: 'right', position: { x: 200, y: 200 } })
      await window.getByTestId('workspace-context-run-role').click()
      await window.getByTestId('workspace-context-configure-team').click()

      // Empty team: the section offers the default team.
      const list = window.getByTestId('settings-team-list')
      await expect(list).toBeVisible()
      // The shortcut scrolls straight to the team section.
      await expect(list).toBeInViewport()
      await window.getByTestId('settings-team-add-default').click()
      await expect(list.locator('[data-testid^="settings-team-role-"]')).toHaveCount(5)
      await expect(window.getByTestId('settings-team-lead-badge')).toHaveCount(1)
      await expect(window.getByTestId('settings-team-add-default')).toHaveCount(0)

      // Edit a role in place: model, then move the lead mark to it.
      const reviewer = list
        .locator('[data-testid^="settings-team-role-"]')
        .filter({ hasText: 'Revisor' })
      await reviewer.locator('[data-testid^="settings-team-model-"]').fill('gpt-6.1-sol-mini')
      await expect(reviewer.locator('[data-testid^="settings-team-model-"]')).toHaveValue(
        'gpt-6.1-sol-mini',
      )
      await reviewer.locator('[data-testid^="settings-team-edit-"]').click()
      await reviewer.locator('[data-testid^="settings-team-lead-"]').check()
      await expect(window.getByTestId('settings-team-lead-badge')).toHaveCount(1)
      await expect(reviewer.getByTestId('settings-team-lead-badge')).toBeVisible()

      // Add a custom role.
      await window.getByTestId('settings-team-add-role').click()
      await expect(list.locator('[data-testid^="settings-team-role-"]')).toHaveCount(6)
      if (process.env['TEAM_SETTINGS_SHOT']) {
        await window.screenshot({ path: process.env['TEAM_SETTINGS_SHOT'] })
      }
    } finally {
      await electronApp.close()
    }
  })
})
