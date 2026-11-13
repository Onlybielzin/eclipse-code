import { describe, expect, it } from 'vitest'
import { normalizeProjectRoles } from '../../../src/contexts/settings/domain/projectRoles'
import {
  DEFAULT_PROJECT_TEAM,
  composeTeamRoster,
  createDefaultProjectTeam,
} from '../../../src/contexts/settings/domain/projectTeam'
import { composeProjectRolePrompt } from '../../../src/contexts/workspace/presentation/renderer/components/workspaceCanvas/hooks/useRolePrompt'

const NOW = '2026-11-11T00:00:00.000Z'
let counter = 0
const nextId = () => `role-${(counter += 1)}`

describe('project team roles', () => {
  it('keeps provider, model and lead, and drops unknown providers', () => {
    const [role] = normalizeProjectRoles([
      {
        id: 'a',
        name: 'Revisor',
        promptTemplate: 'x',
        provider: 'codex',
        model: 'gpt-6.1-sol',
        isLead: false,
      },
    ])
    expect(role).toMatchObject({ provider: 'codex', model: 'gpt-6.1-sol', isLead: false })
    const [unknown] = normalizeProjectRoles([
      { id: 'b', name: 'X', promptTemplate: 'x', provider: 'nope' },
    ])
    expect(unknown).toMatchObject({ provider: null, model: '', isLead: false })
  })

  it('keeps one lead per project: the first saved one', () => {
    const roles = normalizeProjectRoles([
      { id: 'a', name: 'A', promptTemplate: 'x', isLead: true },
      { id: 'b', name: 'B', promptTemplate: 'x', isLead: true },
    ])
    expect(roles.map(role => role.isLead)).toEqual([true, false])
  })

  it('creates the default team once, with a single lead', () => {
    const team = createDefaultProjectTeam([], NOW, nextId)
    expect(team.map(role => role.name)).toEqual(DEFAULT_PROJECT_TEAM.map(role => role.name))
    expect(team.filter(role => role.isLead)).toHaveLength(1)
    expect(team.find(role => role.name === 'Revisor')).toMatchObject({ provider: 'codex' })
    expect(createDefaultProjectTeam(team, NOW, nextId)).toEqual([])
  })

  it('does not add a second lead when the project already has one', () => {
    const existing = normalizeProjectRoles([
      { id: 'x', name: 'Chefe', promptTemplate: 'x', isLead: true },
    ])
    const added = createDefaultProjectTeam(existing, NOW, nextId)
    expect(added.some(role => role.isLead)).toBe(false)
  })

  it("gives only the lead's prompt the team roster", () => {
    const team = createDefaultProjectTeam([], NOW, nextId)
    const lead = team.find(role => role.isLead)!
    const dev = team.find(role => role.name === 'Dev 1')!
    const leadPrompt = composeProjectRolePrompt({
      role: lead,
      input: 'corrige o bug',
      projectRoles: team,
    })
    expect(leadPrompt).toContain('## Time deste projeto')
    expect(leadPrompt).toContain('### Revisor')
    expect(leadPrompt).not.toContain('### Líder')
    expect(leadPrompt.endsWith('User input:\ncorrige o bug')).toBe(true)
    const devPrompt = composeProjectRolePrompt({ role: dev, input: 'x', projectRoles: team })
    expect(devPrompt).not.toContain('## Time deste projeto')
    expect(devPrompt).toContain('STATUS: PRONTO')
    expect(composeTeamRoster(lead, [lead])).toBe('')
  })
})
