import { createContext, useContext, useSyncExternalStore, type ReactNode } from 'react'
import type { AppState, AppStore } from './appStore'

const StoreContext = createContext<AppStore | null>(null)

export function StoreProvider({ store, children }: { store: AppStore; children: ReactNode }) {
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>
}

export function useStore(): AppStore {
  const store = useContext(StoreContext)
  if (!store) throw new Error('StoreProvider ausente')
  return store
}

/** Le uma fatia do estado. O seletor deve devolver valor estavel (sem criar objeto novo). */
export function useAppState<T>(selector: (s: AppState) => T): T {
  const store = useStore()
  return useSyncExternalStore(store.subscribe, () => selector(store.getState()))
}
