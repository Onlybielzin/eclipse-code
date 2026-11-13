import React, { useState } from 'react'
import { Button } from '@app/renderer/components/ui/Button'
import { Checkbox } from '@app/renderer/components/ui/Checkbox'
import { TextAreaField, TextField } from '@app/renderer/components/ui/TextField'
import { CoveSelect } from '@app/renderer/components/CoveSelect'
import { useTranslation } from '@app/renderer/i18n'
import type { ProjectRoleDefinition } from '@contexts/settings/domain/projectRoles'
import { createDefaultProjectTeam } from '@contexts/settings/domain/projectTeam'
import { SettingsGroup } from './SettingsGroup'

type ProviderChoice = 'default' | 'claude-code' | 'codex'

function toChoice(provider: ProjectRoleDefinition['provider']): ProviderChoice {
  return provider === 'claude-code' || provider === 'codex' ? provider : 'default'
}

function nameKey(name: string): string {
  return name.trim().toLowerCase()
}

/**
 * The project's team (Eclipse Code): every role with its provider, model and lead mark, editable
 * in place. The Lead runs from the canvas (right click > Run Role) and creates the others through
 * the eclipse-code MCP tools.
 */
export function ProjectTeamSection({
  workspaceId,
  roles,
  onChangeRoles,
}: {
  workspaceId: string
  roles: ProjectRoleDefinition[]
  onChangeRoles: (roles: ProjectRoleDefinition[]) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const [expandedRoleId, setExpandedRoleId] = useState<string | null>(null)
  const [nameErrors, setNameErrors] = useState<Record<string, string>>({})
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null)
  const hasLead = roles.some(role => role.isLead)

  const providerOptions = [
    { value: 'default', label: t('settingsPanel.team.providerDefault') },
    { value: 'claude-code', label: 'Claude' },
    { value: 'codex', label: 'Codex' },
  ]

  const update = (roleId: string, patch: Partial<ProjectRoleDefinition>): void => {
    const now = new Date().toISOString()
    onChangeRoles(
      roles.map(role => {
        if (role.id === roleId) {
          return { ...role, ...patch, updatedAt: now }
        }
        // One lead per project: marking a role as lead clears the mark elsewhere.
        if (patch.isLead === true && role.isLead) {
          return { ...role, isLead: false, updatedAt: now }
        }
        return role
      }),
    )
  }

  const rename = (roleId: string, name: string): void => {
    const trimmed = name.trim()
    const duplicate = roles.some(role => role.id !== roleId && nameKey(role.name) === nameKey(name))
    if (trimmed.length === 0 || duplicate) {
      setNameErrors(prev => ({
        ...prev,
        [roleId]:
          trimmed.length === 0
            ? t('settingsPanel.team.nameRequired')
            : t('settingsPanel.team.duplicateName'),
      }))
      return
    }
    setNameErrors(prev => {
      const next = { ...prev }
      delete next[roleId]
      return next
    })
    update(roleId, { name })
  }

  const addRole = (): void => {
    const now = new Date().toISOString()
    let index = roles.length + 1
    let name = t('settingsPanel.team.newRoleName', { index })
    while (roles.some(role => nameKey(role.name) === nameKey(name))) {
      index += 1
      name = t('settingsPanel.team.newRoleName', { index })
    }
    const role: ProjectRoleDefinition = {
      id: crypto.randomUUID(),
      name,
      description: '',
      promptTemplate: t('settingsPanel.team.newRolePrompt'),
      inputHint: '',
      outputFormat: '',
      provider: 'claude-code',
      model: '',
      isLead: false,
      createdAt: now,
      updatedAt: now,
    }
    onChangeRoles([...roles, role])
    setExpandedRoleId(role.id)
  }

  const addDefaultTeam = (): void => {
    const added = createDefaultProjectTeam(roles, new Date().toISOString(), () =>
      crypto.randomUUID(),
    )
    if (added.length > 0) {
      onChangeRoles([...roles, ...added])
    }
  }

  const removeRole = (roleId: string): void => {
    if (pendingDeleteId !== roleId) {
      setPendingDeleteId(roleId)
      return
    }
    setPendingDeleteId(null)
    onChangeRoles(roles.filter(role => role.id !== roleId))
  }

  const missingDefaults = createDefaultProjectTeam(roles, '', () => '').length

  return (
    <SettingsGroup
      id={`settings-section-team-${workspaceId}`}
      title={t('settingsPanel.team.title')}
      description={t('settingsPanel.team.description')}
      actions={
        <>
          {missingDefaults > 0 ? (
            <Button
              variant={roles.length === 0 ? 'primary' : 'secondary'}
              data-testid="settings-team-add-default"
              onClick={addDefaultTeam}
            >
              {roles.length === 0
                ? t('settingsPanel.team.createDefault')
                : t('settingsPanel.team.completeDefault', { count: missingDefaults })}
            </Button>
          ) : null}
          <Button data-testid="settings-team-add-role" onClick={addRole}>
            {t('settingsPanel.team.addRole')}
          </Button>
        </>
      }
    >
      <div className="settings-team" data-testid="settings-team-list">
        {roles.length === 0 ? (
          <p className="settings-panel__value">{t('settingsPanel.team.empty')}</p>
        ) : null}
        {!hasLead && roles.length > 0 ? (
          <p className="settings-team__warning" data-testid="settings-team-no-lead">
            {t('settingsPanel.team.noLead')}
          </p>
        ) : null}
        {roles.map(role => {
          const expanded = expandedRoleId === role.id
          return (
            <div
              key={role.id}
              className={`settings-team__role${role.isLead ? ' settings-team__role--lead' : ''}`}
              data-testid={`settings-team-role-${role.id}`}
            >
              <div className="settings-team__row">
                <div className="settings-team__identity">
                  <span className="settings-team__name">{role.name}</span>
                  {role.isLead ? (
                    <span className="settings-team__badge" data-testid="settings-team-lead-badge">
                      {t('settingsPanel.team.leadBadge')}
                    </span>
                  ) : null}
                  {role.description ? (
                    <span className="settings-team__description">{role.description}</span>
                  ) : null}
                </div>
                <div className="settings-team__controls">
                  <CoveSelect
                    size="compact"
                    ariaLabel={t('settingsPanel.team.provider')}
                    testId={`settings-team-provider-${role.id}`}
                    value={toChoice(role.provider)}
                    options={providerOptions}
                    onChange={value =>
                      update(role.id, {
                        provider: value === 'default' ? null : (value as 'claude-code' | 'codex'),
                      })
                    }
                  />
                  <input
                    className="cove-field settings-team__model"
                    data-testid={`settings-team-model-${role.id}`}
                    aria-label={t('settingsPanel.team.model')}
                    placeholder={t('settingsPanel.team.modelPlaceholder')}
                    value={role.model}
                    onChange={event => update(role.id, { model: event.target.value })}
                  />
                  <Button
                    variant="ghost"
                    data-testid={`settings-team-edit-${role.id}`}
                    aria-expanded={expanded}
                    onClick={() => setExpandedRoleId(expanded ? null : role.id)}
                  >
                    {expanded ? t('settingsPanel.team.close') : t('settingsPanel.team.edit')}
                  </Button>
                </div>
              </div>

              {expanded ? (
                <div className="settings-team__editor">
                  <TextField
                    label={t('settingsPanel.team.name')}
                    id={`settings-team-name-${role.id}`}
                    data-testid={`settings-team-name-${role.id}`}
                    defaultValue={role.name}
                    onBlur={event => rename(role.id, event.target.value)}
                  />
                  {nameErrors[role.id] ? (
                    <p className="settings-team__warning">{nameErrors[role.id]}</p>
                  ) : null}
                  <TextField
                    label={t('settingsPanel.team.roleDescription')}
                    id={`settings-team-description-${role.id}`}
                    value={role.description}
                    onChange={event => update(role.id, { description: event.target.value })}
                  />
                  <TextAreaField
                    label={t('settingsPanel.team.prompt')}
                    id={`settings-team-prompt-${role.id}`}
                    data-testid={`settings-team-prompt-${role.id}`}
                    rows={10}
                    value={role.promptTemplate}
                    onChange={event => update(role.id, { promptTemplate: event.target.value })}
                  />
                  <div className="settings-team__editor-footer">
                    <Checkbox
                      checked={role.isLead}
                      data-testid={`settings-team-lead-${role.id}`}
                      description={t('settingsPanel.team.leadHelp')}
                      onCheckedChange={isLead => update(role.id, { isLead })}
                    >
                      {t('settingsPanel.team.lead')}
                    </Checkbox>
                    <Button
                      variant="danger"
                      data-testid={`settings-team-delete-${role.id}`}
                      onClick={() => removeRole(role.id)}
                    >
                      {pendingDeleteId === role.id
                        ? t('settingsPanel.team.confirmDelete')
                        : t('common.delete')}
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
          )
        })}
        <p className="settings-team__help">{t('settingsPanel.team.howToRun')}</p>
      </div>
    </SettingsGroup>
  )
}
