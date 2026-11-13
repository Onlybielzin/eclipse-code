import type { TerminalNodeData } from '../../../types'

export const EMPTY_NODE_KIND_DATA: Pick<
  TerminalNodeData,
  | 'agent'
  | 'task'
  | 'note'
  | 'role'
  | 'image'
  | 'document'
  | 'folder'
  | 'plugin'
  | 'question'
  | 'todos'
  | 'website'
> = {
  agent: null,
  task: null,
  note: null,
  role: null,
  image: null,
  document: null,
  folder: null,
  plugin: null,
  question: null,
  todos: null,
  website: null,
}
