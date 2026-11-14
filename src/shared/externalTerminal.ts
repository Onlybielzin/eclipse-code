/**
 * Terminais externos conhecidos (botao "Abrir no terminal"). Lista fixa: sem comando digitado
 * pelo usuario. A pasta vai sempre como argumento separado, nunca dentro de uma string de shell.
 * Terminal sem flag de pasta (xterm, pwsh, cmd) usa o cwd do processo (`cwdOnly`).
 */
import { z } from 'zod'

export interface ExternalTerminalDef {
  id: string
  label: string
  platform: 'linux' | 'win32' | 'darwin'
  command: string
  /** Argumentos que precedem a pasta; vazio e sem `cwdOnly` = a pasta e o ultimo argumento. */
  args: (directory: string) => string[]
  /** A pasta chega so pelo cwd do processo. */
  cwdOnly?: boolean
}

export const EXTERNAL_TERMINALS: readonly ExternalTerminalDef[] = [
  { id: 'kitty', label: 'kitty', platform: 'linux', command: 'kitty', args: (d) => ['--directory', d] },
  { id: 'konsole', label: 'Konsole', platform: 'linux', command: 'konsole', args: (d) => ['--workdir', d] },
  {
    id: 'gnome-terminal',
    label: 'GNOME Terminal',
    platform: 'linux',
    command: 'gnome-terminal',
    args: (d) => [`--working-directory=${d}`],
  },
  {
    id: 'alacritty',
    label: 'Alacritty',
    platform: 'linux',
    command: 'alacritty',
    args: (d) => ['--working-directory', d],
  },
  { id: 'wezterm', label: 'WezTerm', platform: 'linux', command: 'wezterm', args: (d) => ['start', '--cwd', d] },
  { id: 'xterm', label: 'xterm', platform: 'linux', command: 'xterm', args: () => [], cwdOnly: true },
  {
    id: 'windows-terminal',
    label: 'Windows Terminal',
    platform: 'win32',
    command: 'wt.exe',
    args: (d) => ['-d', d],
  },
  { id: 'pwsh', label: 'PowerShell 7', platform: 'win32', command: 'pwsh.exe', args: () => [], cwdOnly: true },
  {
    id: 'powershell',
    label: 'Windows PowerShell',
    platform: 'win32',
    command: 'powershell.exe',
    args: () => [],
    cwdOnly: true,
  },
  { id: 'cmd', label: 'Prompt de Comando', platform: 'win32', command: 'cmd.exe', args: () => [], cwdOnly: true },
  { id: 'terminal', label: 'Terminal', platform: 'darwin', command: 'open', args: (d) => ['-a', 'Terminal', d] },
  { id: 'iterm', label: 'iTerm', platform: 'darwin', command: 'open', args: (d) => ['-a', 'iTerm', d] },
]

export const externalTerminalIdSchema = z.enum(
  EXTERNAL_TERMINALS.map((t) => t.id) as [string, ...string[]],
)

export interface ExternalTerminalOption {
  id: string
  label: string
  /** O comando foi achado no PATH. */
  available: boolean
}

/** Terminais da plataforma e a escolha gravada (null = automatico). */
export interface ExternalTerminalSettings {
  selected: string | null
  options: ExternalTerminalOption[]
}

/** Comando e argumentos para abrir `directory` no terminal `id`. Id desconhecido lanca erro. */
export function buildExternalTerminalCommand(
  id: string,
  directory: string,
): { command: string; args: string[] } {
  const def = EXTERNAL_TERMINALS.find((t) => t.id === id)
  if (!def) throw new Error(`terminal desconhecido: ${id}`)
  return { command: def.command, args: def.args(directory) }
}
