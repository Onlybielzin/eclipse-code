import React from 'react'
import { Button } from '@app/renderer/components/ui/Button'
import { Dialog } from '@app/renderer/components/ui/Dialog'
import { TextField } from '@app/renderer/components/ui/TextField'
import { WindowHeading } from '@app/renderer/components/WindowHeading'
import { PlusIcon } from '@app/renderer/components/ui/pixelIcons'
import { useTranslation } from '@app/renderer/i18n'
import { createTaskWithWorktree, toTaskSlug } from '../tasks/createTaskWithWorktree'

/**
 * "New task" (Eclipse Code): a name, a preview of the branch it gets, and Create. The task is a
 * top-level Space bound to a new worktree; `onCreated` receives its Space id to open it.
 */
export function NewTaskDialog({
  workspaceId,
  onClose,
  onCreated,
}: {
  workspaceId: string
  onClose: () => void
  onCreated: (spaceId: string, worktreeError: string | null) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const nameRef = React.useRef<HTMLInputElement | null>(null)
  const [name, setName] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const trimmed = name.trim()
  const branch = trimmed ? `feat/${toTaskSlug(trimmed)}` : null

  const create = async () => {
    if (!trimmed || busy) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      const created = await createTaskWithWorktree({ projectId: workspaceId, name: trimmed })
      onCreated(created.spaceId, created.worktreeError)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
      setBusy(false)
    }
  }

  return (
    <Dialog
      open
      backdropClassName="cove-window-backdrop"
      className="cove-window workspace-new-task"
      data-testid="workspace-new-task-dialog"
      aria-label={t('taskSwitcher.dialogTitle')}
      initialFocusRef={nameRef}
      dismissOnEscape={!busy}
      dismissOnPointerDownOutside={!busy}
      onDismiss={onClose}
    >
      <WindowHeading
        title={t('taskSwitcher.dialogTitle')}
        icon={<PlusIcon size={18} />}
        onClose={onClose}
        disabled={busy}
      />
      <form
        className="cove-window__fields"
        onSubmit={event => {
          event.preventDefault()
          void create()
        }}
      >
        <TextField
          ref={nameRef}
          label={t('taskSwitcher.nameLabel')}
          id="workspace-task-name"
          data-testid="workspace-new-task-name"
          value={name}
          disabled={busy}
          placeholder={t('taskSwitcher.namePlaceholder')}
          description={
            branch ? t('taskSwitcher.branchPreview', { branch }) : t('taskSwitcher.branchHelp')
          }
          onChange={event => {
            setName(event.target.value)
            setError(null)
          }}
        />
      </form>
      {error ? <p className="cove-window__error">{error}</p> : null}
      <div className="cove-window__actions">
        <Button variant="ghost" disabled={busy} onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button
          variant="primary"
          data-testid="workspace-new-task-submit"
          loading={busy}
          disabled={!trimmed}
          onClick={() => void create()}
        >
          {busy ? t('taskSwitcher.creating') : t('taskSwitcher.create')}
        </Button>
      </div>
    </Dialog>
  )
}
