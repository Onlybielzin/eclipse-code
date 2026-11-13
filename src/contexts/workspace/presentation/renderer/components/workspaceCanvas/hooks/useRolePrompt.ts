import type { ProjectRoleDefinition } from '@contexts/settings/domain/projectRoles'
import { composeTeamRoster } from '@contexts/settings/domain/projectTeam'

export function composeProjectRolePrompt({
  role,
  input,
  projectRoles = [],
}: {
  role: Pick<ProjectRoleDefinition, 'promptTemplate'> &
    Partial<Pick<ProjectRoleDefinition, 'id' | 'isLead'>>
  input: string
  /** Every role of the project; the Lead's prompt lists the others as its team. */
  projectRoles?: readonly ProjectRoleDefinition[]
}): string {
  const sections = [role.promptTemplate.trim()].filter(Boolean)
  if (role.isLead && role.id) {
    const roster = composeTeamRoster({ id: role.id }, projectRoles)
    if (roster) {
      sections.push(roster)
    }
  }
  const userInput = input.trim()

  if (userInput.length > 0) {
    sections.push(`User input:\n${userInput}`)
  }

  return sections.join('\n\n')
}
