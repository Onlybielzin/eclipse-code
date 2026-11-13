import type { TerminalDisplayRuntime } from '../../domain/terminalDisplayCalibration'

export function readTerminalDisplayClientRuntime(): TerminalDisplayRuntime {
  const runtime = window.eclipseCodeApi?.meta?.runtime
  return runtime === 'browser' ? 'browser' : runtime === 'electron' ? 'desktop' : 'unknown'
}
