/** Preferências do cérebro no localStorage: leitura validada e gravação sem estourar. */
export function readPref<T>(key: string, ok: (v: unknown) => v is T, fallback: T): T {
  try {
    const v = globalThis.localStorage?.getItem(key)
    return ok(v) ? v : fallback
  } catch {
    return fallback
  }
}

export function savePref(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value)
  } catch {
    // sem armazenamento: so perde a lembranca da escolha
  }
}
