import type { WorkspaceDirectory } from '@shared/contracts/dto'

export const WORKSPACE_SELECT_DIRECTORY_REQUEST_EVENT =
  'eclipse-code.workspace.selectDirectory.request'
export const WORKSPACE_SELECT_DIRECTORY_RESPONSE_EVENT =
  'eclipse-code.workspace.selectDirectory.response'

export interface WorkspaceSelectDirectoryRequestDetail {
  requestId: string
}

export interface WorkspaceSelectDirectoryResponseDetail {
  requestId: string
  directory: WorkspaceDirectory | null
}
