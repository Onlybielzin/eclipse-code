import { realpathSync } from 'node:fs'
import { posix as pathPosix } from 'node:path'
import { createAppError } from '../../../../shared/errors/appError'

function normalizeFileHost(host: string): string {
  const normalized = host.trim().toLowerCase()
  return normalized === 'localhost' ? '' : normalized
}

function normalizeMacPrivateAlias(pathname: string): string {
  if (pathname === '/private/var' || pathname.startsWith('/private/var/')) {
    return pathname.slice('/private'.length)
  }

  if (pathname === '/private/tmp' || pathname.startsWith('/private/tmp/')) {
    return pathname.slice('/private'.length)
  }

  if (pathname === '/private/etc' || pathname.startsWith('/private/etc/')) {
    return pathname.slice('/private'.length)
  }

  return pathname
}

function normalizeFileUriPathname(uri: string): { host: string; pathname: string } {
  let parsed: URL
  try {
    parsed = new URL(uri)
  } catch {
    throw createAppError('common.invalid_input', { debugMessage: 'Invalid file uri.' })
  }

  const host = normalizeFileHost(parsed.host ?? '')
  let pathname = parsed.pathname ?? '/'

  try {
    pathname = decodeURIComponent(pathname)
  } catch {
    // ignore malformed URI escapes; rely on raw pathname
  }

  pathname = pathPosix.normalize(pathname)
  if (pathname.length > 1 && pathname.endsWith('/')) {
    pathname = pathname.slice(0, -1)
  }

  pathname = normalizeMacPrivateAlias(pathname)

  return { host, pathname }
}

function isPathWithin(rootPathname: string, targetPathname: string): boolean {
  return (
    rootPathname === '/' ||
    targetPathname === rootPathname ||
    (targetPathname.startsWith(rootPathname) && targetPathname[rootPathname.length] === '/')
  )
}

/** Resolves symlinks of a local path; the deepest existing ancestor for a path not created yet. */
function realLocalPath(pathname: string): string | null {
  const missing: string[] = []
  let current = pathname
  for (;;) {
    try {
      const real = realpathSync.native(current)
      return missing.length > 0 ? pathPosix.join(real, ...missing.reverse()) : real
    } catch {
      const parent = pathPosix.dirname(current)
      if (parent === current) {
        return null
      }
      missing.push(pathPosix.basename(current))
      current = parent
    }
  }
}

export function assertFileUriWithinRootUri(options: {
  rootUri: string
  uri: string
  debugMessage: string
}): void {
  const root = normalizeFileUriPathname(options.rootUri)
  const target = normalizeFileUriPathname(options.uri)

  if (root.host !== target.host) {
    throw createAppError('common.invalid_input', { debugMessage: options.debugMessage })
  }

  if (isPathWithin(root.pathname, target.pathname)) {
    return
  }

  // A local root added through a symlink (/home/u/Projects -> /data/Projects) and a path git
  // reports in its real form (worktrees) name the same place: compare the resolved paths.
  if (root.host === '' && process.platform !== 'win32') {
    const realRoot = realLocalPath(root.pathname)
    const realTarget = realLocalPath(target.pathname)
    if (realRoot && realTarget && isPathWithin(realRoot, realTarget)) {
      return
    }
  }

  throw createAppError('common.invalid_input', { debugMessage: options.debugMessage })
}
