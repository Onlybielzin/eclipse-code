// @vitest-environment node
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { help } from '../../../src/app/cli/core/help'
import { commands } from '../../../src/app/cli/commands'
import { resolveCliAppRoot } from '../../../src/app/cli/appRoot.mjs'

describe('CLI build artifact', () => {
  it.each([
    '/repo',
    '/Applications/Eclipse Code.app/Contents/Resources/app.asar',
    '/resources/app',
    '/bundle/app',
  ])('resolves the built CLI root in %s', root => {
    expect(resolveCliAppRoot(resolve(root, 'out/cli'))).toBe(resolve(root))
  })
  it('emits exactly one executable ESM file', () => {
    expect(readdirSync('out/cli')).toEqual(['eclipse-code.mjs'])
    expect(readFileSync('out/cli/eclipse-code.mjs', 'utf8')).toMatch(/^#!\/usr\/bin\/env node\n/)
    if (process.platform !== 'win32') {
      expect(statSync('out/cli/eclipse-code.mjs').mode & 0o111).toBe(0o111)
    }
  })
  it.each(['out/cli/eclipse-code.mjs', 'src/app/cli/eclipse-code.mjs'])(
    '%s prints generated root help',
    entry => {
      const result = spawnSync(process.execPath, [resolve(entry), '--help'])
      expect(result.error).toBeUndefined()
      expect(result.status).toBe(0)
      expect(result.stderr.length).toBe(0)
      expect(result.stdout).toEqual(Buffer.from(help(commands, [])))
    },
  )
})
