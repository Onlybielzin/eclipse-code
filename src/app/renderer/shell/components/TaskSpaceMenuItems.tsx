import { HistoryIcon, PackageIcon } from '@app/renderer/components/ui/pixelIcons'
import { useTranslation } from '@app/renderer/i18n'
import { MenuItem } from '@app/renderer/components/ui/Menu'
import {
  requestCloseTask,
  requestDecisionHistory,
} from '@contexts/workspace/presentation/renderer/components/workspaceCanvas/tasks/taskEvents'
import { useAppStore } from '../store/useAppStore'

/** Menu items of a task (top-level Space): its decision history and closing it. */
export function TaskSpaceMenuItems({ spaceId }: { spaceId: string }): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <>
      <MenuItem
        icon={<HistoryIcon />}
        data-testid={`workspace-space-context-decisions-${spaceId}`}
        onClick={() => {
          useAppStore.getState().setProjectContextMenu(null)
          requestDecisionHistory(spaceId)
        }}
      >
        {t('canvasCards.question.historyOpen')}
      </MenuItem>
      <MenuItem
        icon={<PackageIcon />}
        data-testid={`workspace-space-context-close-task-${spaceId}`}
        onClick={() => {
          useAppStore.getState().setProjectContextMenu(null)
          requestCloseTask(spaceId)
        }}
      >
        {t('taskSwitcher.closeTaskShort')}
      </MenuItem>
    </>
  )
}
