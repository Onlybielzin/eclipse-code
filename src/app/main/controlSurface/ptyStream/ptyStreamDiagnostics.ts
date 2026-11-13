export function logPtyStreamResizeDiagnostics(payload: Record<string, unknown>): void {
  if (process.env.ECLIPSE_CODE_TERMINAL_DIAGNOSTICS !== '1') {
    return
  }

  process.stderr.write(
    `[eclipse-code-pty-resize] ${JSON.stringify({ ts: new Date().toISOString(), ...payload })}\n`,
  )
}
