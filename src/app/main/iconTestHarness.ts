type RuntimeIconTestState = {
  runtimeIconPath: string | null
}

declare global {
  var __eclipseCodeRuntimeIconTestState: RuntimeIconTestState | undefined
}

export function setRuntimeIconTestState(runtimeIconPath: string | null): void {
  globalThis.__eclipseCodeRuntimeIconTestState = {
    runtimeIconPath,
  }
}
