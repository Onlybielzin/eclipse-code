import React from 'react'
import { IconButton } from '@app/renderer/components/ui/IconButton'
import { PackageIcon, PlusIcon } from '@app/renderer/components/ui/pixelIcons'
import { SegmentedControl } from '@app/renderer/components/ui/SegmentedControl'
import { Surface } from '@app/renderer/components/ui/Surface'
import { useTranslation } from '@app/renderer/i18n'
import { orderRootSpaces } from '@contexts/workspace/domain/workspaceSpacePinning'
import type { WorkspaceSpaceState } from '../../../types'
import { subscribeNewTask } from '../tasks/taskEvents'
import { NewTaskDialog } from './NewTaskDialog'

const ALL = '__all__'

/**
 * Task tabs (Eclipse Code), beside the Far/Near switch in the canvas HUD: "All" plus one segment
 * per top-level Space. The open task shows only its windows. "+" opens the New task dialog.
 */
export function WorkspaceTaskTabs({
  spaces,
  activeSpaceId = null,
  workspaceId,
  activateSpace,
  activateAllSpaces,
  cancelSpaceRename,
  onOpenSpaceContextMenu,
  onCloseTask,
}: {
  spaces: WorkspaceSpaceState[]
  activeSpaceId?: string | null
  workspaceId?: string
  activateSpace: (spaceId: string) => void
  activateAllSpaces: () => void
  cancelSpaceRename: () => void
  onOpenSpaceContextMenu?: (spaceId: string, anchor: { x: number; y: number }) => void
  /** Opens the archive dialog for the open task: close its windows, remove its worktree. */
  onCloseTask?: (spaceId: string, anchor: { x: number; y: number }) => void
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const [isDialogOpen, setIsDialogOpen] = React.useState(false)
  const [pendingSpaceId, setPendingSpaceId] = React.useState<string | null>(null)
  const [notice, setNotice] = React.useState<string | null>(null)
  const taskSpaces = React.useMemo(() => orderRootSpaces(spaces), [spaces])

  React.useEffect(() => {
    if (!workspaceId) {
      return undefined
    }
    return subscribeNewTask(() => setIsDialogOpen(true))
  }, [workspaceId])

  // The new Space reaches this canvas through state sync, and the canvas' own Space list catches
  // up a frame later: keep asking until the new task is the open one.
  React.useEffect(() => {
    if (!pendingSpaceId) {
      return undefined
    }
    if (activeSpaceId === pendingSpaceId) {
      setPendingSpaceId(null)
      return undefined
    }
    if (!spaces.some(space => space.id === pendingSpaceId)) {
      return undefined
    }
    const timer = window.setInterval(() => activateSpace(pendingSpaceId), 100)
    activateSpace(pendingSpaceId)
    return () => window.clearInterval(timer)
  }, [activateSpace, activeSpaceId, pendingSpaceId, spaces])

  if (taskSpaces.length === 0 && !workspaceId) {
    return null
  }

  const select = (value: string) => {
    cancelSpaceRename()
    if (value === ALL) {
      activateAllSpaces()
    } else {
      activateSpace(value)
    }
  }

  const segmentValue = (target: EventTarget | null): string | null => {
    const input =
      target instanceof Element
        ? target.closest('.cove-segmented__option')?.querySelector('input')
        : null
    return input instanceof HTMLInputElement ? input.value : null
  }

  return (
    <>
      <Surface
        material="acrylic"
        className="workspace-task-tabs nodrag nopan"
        data-testid="workspace-task-switcher"
      >
        <div
          className="workspace-task-tabs__scroll"
          // A click on the open tab re-centres it (radios do not fire change when re-checked).
          onClick={event => {
            const value = segmentValue(event.target)
            if (value && value === (activeSpaceId ?? ALL)) {
              select(value)
            }
          }}
          onContextMenu={event => {
            const value = segmentValue(event.target)
            if (value && value !== ALL) {
              event.preventDefault()
              event.stopPropagation()
              onOpenSpaceContextMenu?.(value, { x: event.clientX, y: event.clientY })
            }
          }}
        >
          <SegmentedControl
            testId="workspace-task-tabs"
            label={t('taskSwitcher.label')}
            value={activeSpaceId ?? ALL}
            onValueChange={select}
            options={[
              { value: ALL, label: t('taskSwitcher.all'), testId: 'workspace-space-switch-all' },
              ...taskSpaces.map(space => ({
                value: space.id,
                label: space.name,
                testId: `workspace-space-switch-${space.id}`,
              })),
            ]}
          />
        </div>
        {workspaceId ? (
          <IconButton
            label={t('taskSwitcher.newTask')}
            size="sm"
            data-testid="workspace-task-new"
            onClick={() => {
              setNotice(null)
              setIsDialogOpen(true)
            }}
          >
            <PlusIcon size={18} />
          </IconButton>
        ) : null}
        {activeSpaceId && onCloseTask ? (
          <IconButton
            label={t('taskSwitcher.closeTask')}
            size="sm"
            data-testid="workspace-task-close"
            onClick={event => {
              const rect = event.currentTarget.getBoundingClientRect()
              onCloseTask(activeSpaceId, { x: Math.round(rect.left), y: Math.round(rect.bottom) })
            }}
          >
            <PackageIcon size={18} />
          </IconButton>
        ) : null}
      </Surface>
      {notice ? (
        <p className="workspace-task-tabs__notice" role="alert">
          {notice}
        </p>
      ) : null}
      {isDialogOpen && workspaceId ? (
        <NewTaskDialog
          workspaceId={workspaceId}
          onClose={() => setIsDialogOpen(false)}
          onCreated={(spaceId, worktreeError) => {
            setIsDialogOpen(false)
            setPendingSpaceId(spaceId)
            setNotice(
              worktreeError ? t('taskSwitcher.worktreeFailed', { message: worktreeError }) : null,
            )
          }}
        />
      ) : null}
    </>
  )
}
