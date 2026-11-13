import { satisfies, valid, validRange } from 'semver'
import type { LocalPluginPackage } from './pluginRuntimeTypes'

export function normalizePluginEngines(value: unknown): LocalPluginPackage['engines'] {
  if (value === undefined) {
    return undefined
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Plugin engines must contain an eclipse-code SemVer range.')
  }
  const source = value as Record<string, unknown>
  if (
    Object.keys(source).some(key => key !== 'eclipseCode') ||
    typeof source.eclipseCode !== 'string' ||
    !source.eclipseCode.trim() ||
    source.eclipseCode.length > 512 ||
    !validRange(source.eclipseCode)
  ) {
    throw new Error(
      'Plugin engines.eclipseCode must be a valid SemVer range, such as >=0.3.2 <0.4.0.',
    )
  }
  return { eclipseCode: source.eclipseCode.trim() }
}

/** Version and platform refer to the Worker that owns this installation, not its clients. */
export function assertPluginCompatibility(
  pkg: Pick<LocalPluginPackage, 'id' | 'engines' | 'platforms'>,
  host: { version: string | null; platform: string },
): void {
  if (pkg.platforms && !pkg.platforms.some(platform => platform === host.platform)) {
    throw new Error(
      `Plugin ${pkg.id} supports ${pkg.platforms.join(', ')}; this Worker runs ${host.platform}. Install a build supporting this Worker platform.`,
    )
  }
  const range = pkg.engines?.eclipseCode
  if (range === undefined) {
    return
  }
  if (!host.version || !valid(host.version)) {
    throw new Error(
      `Plugin ${pkg.id} requires Eclipse Code ${range}, but this Worker's version is unavailable. Start a versioned Eclipse Code build before installing or activating it.`,
    )
  }
  if (!satisfies(host.version, range)) {
    throw new Error(
      `Plugin ${pkg.id} requires Eclipse Code ${range}; this Worker runs ${host.version}. Update the Worker or install a compatible plugin version.`,
    )
  }
}
