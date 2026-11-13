import { resolveMainProcessPid } from './mainProcessPid'
import { resolveWindowsPtyMeta } from './windowsPtyMeta'

export function resolveEclipseCodeMeta() {
  return {
    isTest: process.env.NODE_ENV === 'test',
    isPackaged: process.env.NODE_ENV !== 'test' && process.defaultApp !== true,
    allowWhatsNewInTests: process.env.ECLIPSE_CODE_TEST_WHATS_NEW === '1',
    enableTerminalDiagnostics: process.env.ECLIPSE_CODE_TERMINAL_DIAGNOSTICS === '1',
    enableTerminalInputDiagnostics: process.env.ECLIPSE_CODE_TERMINAL_INPUT_DIAGNOSTICS === '1',
    enableTerminalTestApi: process.env.ECLIPSE_CODE_TERMINAL_TEST_API === '1',
    disableTerminalTranscriptMirror:
      process.env.ECLIPSE_CODE_DISABLE_TERMINAL_TRANSCRIPT_MIRROR === '1',
    enableUiGallery:
      process.env.NODE_ENV === 'test' && process.env.ECLIPSE_CODE_TEST_UI_GALLERY === '1',
    runtime: 'electron' as const,
    platform: process.platform,
    mainPid: resolveMainProcessPid(),
    windowsPty: resolveWindowsPtyMeta(),
  }
}
