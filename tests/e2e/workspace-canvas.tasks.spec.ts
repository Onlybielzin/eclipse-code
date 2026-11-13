import { expect, test, type Page } from '@playwright/test'
import { execFile } from 'node:child_process'
import { mkdtemp, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import {
  launchApp,
  removePathWithRetry,
  seededWorkspaceId,
  seedWorkspaceState,
} from './workspace-canvas.helpers'
import { resolveE2ETmpDir } from './workspace-canvas.testUtils'

const execFileAsync = promisify(execFile)

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, env: process.env, windowsHide: true })
  return stdout
}

async function createTempRepo(): Promise<string> {
  const repoDir = await mkdtemp(path.join(resolveE2ETmpDir(), 'eclipse-code-tasks-e2e-'))
  await git(['init'], repoDir)
  await git(['config', 'user.email', 'test@example.com'], repoDir)
  await git(['config', 'user.name', 'Eclipse Code Test'], repoDir)
  await writeFile(path.join(repoDir, 'README.md'), '# tasks fixture\n', 'utf8')
  await git(['add', '.'], repoDir)
  await git(['commit', '-m', 'init'], repoDir)
  return await realpath(repoDir)
}

async function readSpaces(window: Page) {
  return await window.evaluate(async () => {
    const raw = await window.eclipseCodeApi.persistence.readWorkspaceStateRaw()
    const state = raw ? (JSON.parse(raw) as { workspaces?: unknown[] }) : null
    const workspace = (state?.workspaces?.[0] ?? null) as {
      activeSpaceId?: string | null
      spaces?: Array<{ id: string; name: string; directoryPath: string; nodeIds: string[] }>
    } | null
    return { activeSpaceId: workspace?.activeSpaceId ?? null, spaces: workspace?.spaces ?? [] }
  })
}

const note = (id: string, title: string, x: number, y: number) => ({
  id,
  title,
  kind: 'note' as const,
  position: { x, y },
  width: 280,
  height: 180,
  task: { text: title },
})

const space = (id: string, name: string, directoryPath: string, nodeIds: string[], x: number) => ({
  id,
  name,
  directoryPath,
  labelColor: null,
  nodeIds,
  rect: { x, y: 80, width: 420, height: 320 },
})

// Eclipse Code tasks: each top-level Space is a task tab; the open task shows only its windows,
// "+ New task" creates a Space bound to a new worktree, and new windows land in the open task.
test.describe('Workspace Canvas - Tasks', () => {
  test('isolates the open task, creates a task with a worktree and keeps new windows in it', async () => {
    const repoPath = await createTempRepo()
    const { electronApp, window } = await launchApp({
      env: { ECLIPSE_CODE_TEST_WORKSPACE: repoPath },
    })
    try {
      await seedWorkspaceState(window, {
        activeWorkspaceId: seededWorkspaceId,
        workspaces: [
          {
            id: seededWorkspaceId,
            name: path.basename(repoPath),
            path: repoPath,
            nodes: [note('note-a', 'Nota A', 140, 160), note('note-b', 'Nota B', 640, 160)],
            spaces: [
              space('space-a', 'tarefa-a', repoPath, ['note-a'], 100),
              space('space-b', 'tarefa-b', repoPath, ['note-b'], 600),
            ],
            activeSpaceId: null,
          },
        ],
        settings: { standardWindowSizeBucket: 'regular' },
      })

      const nodeA = window.locator('.react-flow__node[data-id="note-a"]')
      const nodeB = window.locator('.react-flow__node[data-id="note-b"]')
      await expect(nodeA).toBeVisible()
      await expect(nodeB).toBeVisible()

      // Open task A: task B's window is hidden.
      await window.getByTestId('workspace-space-switch-space-a').click()
      await expect(window.getByTestId('workspace-space-switch-space-a')).toBeChecked()
      await expect(nodeA).toBeVisible()
      await expect(nodeB).toBeHidden()

      // All: everything again.
      await window.getByTestId('workspace-space-switch-all').click()
      await expect(nodeB).toBeVisible()

      // New task: Space + worktree, opened right away.
      await window.getByTestId('workspace-task-new').click()
      await expect(window.getByTestId('workspace-new-task-dialog')).toBeVisible()
      await window.getByTestId('workspace-new-task-name').fill('Login Google')
      await expect(window.getByTestId('workspace-new-task-dialog')).toContainText(
        'feat/login-google',
      )
      await window.getByTestId('workspace-new-task-submit').click()
      await expect(window.getByTestId('workspace-new-task-dialog')).toHaveCount(0)
      await expect
        .poll(async () => (await readSpaces(window)).spaces.map(s => s.name), { timeout: 20_000 })
        .toContain('feat-login-google')
      const created = (await readSpaces(window)).spaces.find(s => s.name === 'feat-login-google')!
      expect(created.directoryPath).toContain(path.join('.eclipse-code', 'worktrees'))
      expect(await git(['worktree', 'list'], repoPath)).toContain('feat-login-google')
      await expect(window.getByTestId(`workspace-space-switch-${created.id}`)).toBeChecked({
        timeout: 10_000,
      })
      await expect(nodeA).toBeHidden()
      await expect(nodeB).toBeHidden()

      // A window created while the task is open belongs to it.
      await window
        .locator('.workspace-canvas .react-flow__pane')
        .click({ button: 'right', position: { x: 60, y: 420 } })
      await window.getByTestId('workspace-context-new-note').click()
      await expect
        .poll(
          async () =>
            (await readSpaces(window)).spaces.find(s => s.id === created.id)?.nodeIds.length ?? 0,
          { timeout: 10_000 },
        )
        .toBe(1)
      // The command palette opens the same "New task" field.
      await window.keyboard.press('Control+P')
      await window.keyboard.type('New task')
      await window.keyboard.press('Enter')
      await expect(window.getByTestId('workspace-new-task-name')).toBeFocused()

      if (process.env['TASKS_SHOT']) {
        await window.screenshot({ path: process.env['TASKS_SHOT'] })
      }
    } finally {
      await electronApp.close()
      await removePathWithRetry(repoPath)
    }
  })
  test('closes the open task from the tab bar: windows, tab and worktree go away', async () => {
    const repoPath = await createTempRepo()
    const { electronApp, window } = await launchApp({
      env: { ECLIPSE_CODE_TEST_WORKSPACE: repoPath },
    })
    try {
      await seedWorkspaceState(window, {
        activeWorkspaceId: seededWorkspaceId,
        workspaces: [
          {
            id: seededWorkspaceId,
            name: path.basename(repoPath),
            path: repoPath,
            nodes: [],
            spaces: [],
            activeSpaceId: null,
          },
        ],
        settings: { standardWindowSizeBucket: 'regular' },
      })

      await window.getByTestId('workspace-task-new').click()
      await window.getByTestId('workspace-new-task-name').fill('Fechar teste')
      await window.getByTestId('workspace-new-task-submit').click()
      await expect
        .poll(async () => (await readSpaces(window)).spaces.map(s => s.name), { timeout: 20_000 })
        .toContain('feat-fechar-teste')
      const task = (await readSpaces(window)).spaces.find(s => s.name === 'feat-fechar-teste')!
      await expect(window.getByTestId(`workspace-space-switch-${task.id}`)).toBeChecked({
        timeout: 10_000,
      })

      // The sidebar card and the tab's Space menu open the same archive dialog.
      await window.getByTestId(`workspace-space-close-task-${seededWorkspaceId}-${task.id}`).click()
      await expect(window.locator('[data-testid="space-worktree-archive-submit"]')).toBeVisible()
      await window.locator('[data-testid="space-worktree-archive-cancel"]').click()
      await expect(window.locator('[data-testid="space-worktree-archive-submit"]')).toHaveCount(0)
      await window.getByTestId(`workspace-space-switch-${task.id}`).click({ button: 'right' })
      await window.getByTestId(`workspace-space-context-close-task-${task.id}`).click()
      await expect(window.locator('[data-testid="space-worktree-archive-submit"]')).toBeVisible()
      await window.locator('[data-testid="space-worktree-archive-cancel"]').click()
      await expect(window.locator('[data-testid="space-worktree-archive-submit"]')).toHaveCount(0)

      await window.getByTestId('workspace-task-close').click()
      await expect(window.locator('[data-testid="space-worktree-archive-submit"]')).toBeVisible()
      const deleteBranch = window.locator('[data-testid="space-worktree-archive-delete-branch"]')
      if (!(await deleteBranch.isChecked())) {
        await deleteBranch.click()
      }
      await window.locator('[data-testid="space-worktree-archive-submit"]').click()

      await expect(window.getByTestId(`workspace-space-switch-${task.id}`)).toHaveCount(0, {
        timeout: 20_000,
      })
      await expect
        .poll(async () => await git(['worktree', 'list'], repoPath), { timeout: 20_000 })
        .not.toContain('feat-fechar-teste')
      await expect
        .poll(
          async () =>
            await git(['branch', '--list', 'feat/fechar-teste', 'feat-fechar-teste'], repoPath),
        )
        .toBe('')
    } finally {
      await electronApp.close()
      await removePathWithRetry(repoPath)
    }
  })
  test('creating a task is all or nothing: no Space is left when the worktree fails', async () => {
    const plainDir = await mkdtemp(path.join(resolveE2ETmpDir(), 'eclipse-code-tasks-nogit-'))
    const { electronApp, window } = await launchApp({
      env: { ECLIPSE_CODE_TEST_WORKSPACE: plainDir },
    })
    try {
      await seedWorkspaceState(window, {
        activeWorkspaceId: seededWorkspaceId,
        workspaces: [
          {
            id: seededWorkspaceId,
            name: path.basename(plainDir),
            path: plainDir,
            nodes: [],
            spaces: [],
            activeSpaceId: null,
          },
        ],
        settings: { standardWindowSizeBucket: 'regular' },
      })
      await window.getByTestId('workspace-task-new').click()
      await window.getByTestId('workspace-new-task-name').fill('Sem git')
      await window.getByTestId('workspace-new-task-submit').click()
      await expect(window.locator('.workspace-new-task .cove-window__error')).toBeVisible({
        timeout: 20_000,
      })
      await expect.poll(async () => (await readSpaces(window)).spaces.length).toBe(0)
    } finally {
      await electronApp.close()
      await removePathWithRetry(plainDir)
    }
  })
})
