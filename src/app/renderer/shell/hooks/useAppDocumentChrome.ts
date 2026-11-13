import { useEffect } from 'react'

export function useAppDocumentChrome(activeWorkspaceName: string | null): void {
  useEffect(() => {
    document.title = activeWorkspaceName ? `${activeWorkspaceName} — Eclipse Code` : 'Eclipse Code'
  }, [activeWorkspaceName])

  const platform =
    typeof window !== 'undefined' && window.eclipseCodeApi?.meta?.platform
      ? window.eclipseCodeApi.meta.platform
      : undefined

  useEffect(() => {
    if (platform) {
      document.documentElement.dataset.covePlatform = platform
    }
  }, [platform])
}
