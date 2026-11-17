/** Links externos abrem no navegador padrao; o app nunca abre janela nova para eles. */

/** So http, https e mailto chegam ao shell.openExternal. */
export function isExternalUrl(url: string): boolean {
  try {
    return ['http:', 'https:', 'mailto:'].includes(new URL(url).protocol)
  } catch {
    return false
  }
}

export interface ExternalLinkDeps {
  openExternal: (url: string) => unknown
  /** A URL e a do proprio renderer (dev server ou file://)? */
  isAppUrl: (url: string) => boolean
}

interface ContentsLike {
  setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' }): void
  on(
    event: 'will-navigate',
    listener: (details: { url: string; preventDefault(): void }) => void,
  ): unknown
}

// Falha do navegador nao derruba o main com rejeicao sem tratamento.
const open = (deps: ExternalLinkDeps, url: string): void => {
  void Promise.resolve(deps.openExternal(url)).catch(() => {})
}

export function attachExternalLinks(contents: ContentsLike, deps: ExternalLinkDeps): void {
  contents.setWindowOpenHandler(({ url }) => {
    if (isExternalUrl(url)) open(deps, url)
    return { action: 'deny' }
  })
  contents.on('will-navigate', (details) => {
    if (deps.isAppUrl(details.url)) return
    details.preventDefault()
    if (isExternalUrl(details.url)) open(deps, details.url)
  })
}
