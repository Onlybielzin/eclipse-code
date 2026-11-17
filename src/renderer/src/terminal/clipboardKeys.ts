/** Decisao de tecla de copiar/colar do terminal do Lider (pura, testavel sem canvas). */
export interface ClipboardKeyInput {
  ctrl: boolean
  shift: boolean
  alt: boolean
  meta: boolean
  key: string
  type: string
  hasSelection: boolean
  platform: string
}

export function clipboardKeyAction(
  i: ClipboardKeyInput,
): 'copy' | 'paste' | 'deleteWord' | 'newline' | 'swallow' | 'pass' {
  // Shift+Enter (vale no mac): keydown vira Ctrl+J; keypress/keyup sao engolidos para nao sair \r.
  if (i.key === 'Enter' && i.shift && !i.ctrl && !i.alt && !i.meta) {
    return i.type === 'keydown' ? 'newline' : 'swallow'
  }
  // No macOS o Cmd+C/Cmd+V padrao do xterm ja funciona.
  if (i.type !== 'keydown' || i.platform === 'darwin') return 'pass'
  if (!i.ctrl || i.shift || i.alt || i.meta) return 'pass'
  const key = i.key.toLowerCase()
  if (key === 'c' && i.hasSelection) return 'copy'
  if (key === 'v') return 'paste'
  if (key === 'backspace') return 'deleteWord'
  return 'pass'
}

/** Colagem sem texto e com imagem/arquivo: o Claude Code cola a imagem sozinho com ^V. */
export function isImageOnlyPaste(data: DataTransfer | null): boolean {
  if (!data || data.getData('text/plain') !== '') return false
  return Array.from(data.items ?? []).some((item) => item.kind === 'file')
}
