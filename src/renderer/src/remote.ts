import { useEffect, useState } from 'react'

/** Modo remoto: o main injeta window.eclipseRemote = true na página servida por HTTP. */
export const isRemote = (): boolean => window.eclipseRemote === true

const PHONE_QUERY = '(max-width: 720px)'

/** Largura de celular (ate 720px). Sem matchMedia (jsdom) vale falso. */
export function useIsPhone(): boolean {
  const query = (): MediaQueryList | null =>
    typeof window.matchMedia === 'function' ? window.matchMedia(PHONE_QUERY) : null
  const [phone, setPhone] = useState(() => query()?.matches ?? false)
  useEffect(() => {
    const mql = query()
    if (!mql) return
    const on = () => setPhone(mql.matches)
    on()
    mql.addEventListener('change', on)
    return () => mql.removeEventListener('change', on)
  }, [])
  return phone
}
