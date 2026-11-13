import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { assertFileUriWithinRootUri } from '../../../src/app/main/controlSurface/topology/fileUriScope'

const base = mkdtempSync(join(tmpdir(), 'eclipse-scope-'))
// Real layout: <base>/data/Projects/app with a worktree inside; <base>/home/Projects -> data/Projects
const realProjects = join(base, 'data', 'Projects')
mkdirSync(join(realProjects, 'app', '.eclipse-code', 'worktrees', 'feat-x'), { recursive: true })
mkdirSync(join(realProjects, 'other'), { recursive: true })
mkdirSync(join(base, 'home'), { recursive: true })
symlinkSync(realProjects, join(base, 'home', 'Projects'))
afterAll(() => rmSync(base, { recursive: true, force: true }))

const uri = (path: string) => pathToFileURL(path).href
const check = (root: string, target: string) => () =>
  assertFileUriWithinRootUri({ rootUri: uri(root), uri: uri(target), debugMessage: 'outside' })

describe.skipIf(process.platform === 'win32')('mount root added through a symlink', () => {
  const linkedRoot = join(base, 'home', 'Projects', 'app')

  it('accepts a worktree that git reports by its real path', () => {
    expect(
      check(linkedRoot, join(realProjects, 'app', '.eclipse-code', 'worktrees', 'feat-x')),
    ).not.toThrow()
  })

  it('accepts a real-path child that does not exist yet', () => {
    expect(check(linkedRoot, join(realProjects, 'app', 'new-dir', 'file.txt'))).not.toThrow()
  })

  it('still refuses a sibling outside the project', () => {
    expect(check(linkedRoot, join(realProjects, 'other'))).toThrow()
    expect(check(linkedRoot, join(realProjects, 'app-evil'))).toThrow()
  })
})
