import type { SettingsPageId } from '@contexts/settings/presentation/renderer/SettingsPanel.shared'

/**
 * Lets deep UI (the canvas menus) open a settings page without threading a callback through the
 * shell. The app shell is the only listener and opens the page it names.
 */
const OPEN_SETTINGS_PAGE_EVENT = 'eclipse-code:open-settings-page'

/** `anchorId` names an element on that page to scroll to once it renders. */
export function requestOpenSettingsPage(pageId: SettingsPageId, anchorId?: string): void {
  window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_PAGE_EVENT, { detail: { pageId, anchorId } }))
}

export function subscribeOpenSettingsPage(
  listener: (pageId: SettingsPageId, anchorId: string | null) => void,
): () => void {
  const handle = (event: Event) => {
    const detail = (event as CustomEvent<{ pageId?: unknown; anchorId?: unknown }>).detail
    if (typeof detail?.pageId === 'string' && detail.pageId.length > 0) {
      listener(
        detail.pageId as SettingsPageId,
        typeof detail.anchorId === 'string' ? detail.anchorId : null,
      )
    }
  }
  window.addEventListener(OPEN_SETTINGS_PAGE_EVENT, handle)
  return () => window.removeEventListener(OPEN_SETTINGS_PAGE_EVENT, handle)
}

/** Scrolls to an element that appears within about a second (the page mounts asynchronously). */
export function scrollToSettingsAnchor(anchorId: string): void {
  let attempts = 0
  const tick = () => {
    const element = document.getElementById(anchorId)
    if (element) {
      element.scrollIntoView({ block: 'start' })
      return
    }
    attempts += 1
    if (attempts < 20) {
      window.setTimeout(tick, 50)
    }
  }
  window.setTimeout(tick, 0)
}
