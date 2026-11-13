import type { CliResult } from './runCli'

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  leadOnly?: boolean
  run: (args: Record<string, unknown>) => Promise<CliResult>
}

export function text(value: unknown, field: string, required = true): string | undefined {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value
  }
  if (required) {
    throw new Error(`"${field}" é obrigatório.`)
  }
  return undefined
}
