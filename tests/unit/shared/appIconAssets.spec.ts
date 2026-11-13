import { createHash } from 'crypto'
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { describe, expect, it } from 'vitest'

// Branding changes should update both assets together instead of drifting per-platform.
const APPROVED_APP_ICON_HASHES = {
  'build/icon.png': 'db3e9386bc844beb71d28418fa87827d25ecdc07ca7847cd4f2ee154a8130219',
  'build/icon.ico': 'ca890a07f9d3a38e5b4e9b263b308e5d4fa86f8b0893c5719a54eeeef5900da8',
} as const

function sha256ForRepoFile(relativePath: string): string {
  const absolutePath = resolve(__dirname, '../../..', relativePath)
  return createHash('sha256').update(readFileSync(absolutePath)).digest('hex')
}

describe('app icon assets', () => {
  it('keeps the approved cross-platform branding assets checked in', () => {
    for (const [relativePath, expectedHash] of Object.entries(APPROVED_APP_ICON_HASHES)) {
      expect(sha256ForRepoFile(relativePath)).toBe(expectedHash)
    }
  })
})
