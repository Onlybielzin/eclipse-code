#!/usr/bin/env node

import { resolve } from 'node:path'
import { writeReleaseInstallerAssets } from './lib/release-installer-assets.mjs'

const rootDir = resolve(import.meta.dirname, '..')
const releaseTag = process.env['ECLIPSE_CODE_RELEASE_TAG']?.trim()
const owner = process.env['ECLIPSE_CODE_RELEASE_OWNER']?.trim() || 'Onlybielzin'
const repo = process.env['ECLIPSE_CODE_RELEASE_REPO']?.trim() || 'eclipse-code'
const outputDir = resolve(rootDir, process.argv[2] ?? 'release-assets')

if (!releaseTag) {
  process.stderr.write('ECLIPSE_CODE_RELEASE_TAG is required.\n')
  process.exit(1)
}

const assets = await writeReleaseInstallerAssets({
  tag: releaseTag,
  owner,
  repo,
  outputDir,
  shellInstallSourcePath: resolve(rootDir, 'scripts/release-assets/eclipse-code-install.sh'),
  shellUninstallSourcePath: resolve(rootDir, 'scripts/release-assets/eclipse-code-uninstall.sh'),
  powershellInstallSourcePath: resolve(rootDir, 'scripts/release-assets/eclipse-code-install.ps1'),
  powershellUninstallSourcePath: resolve(
    rootDir,
    'scripts/release-assets/eclipse-code-uninstall.ps1',
  ),
})

process.stdout.write(
  `Generated ${assets.length} release installer asset(s) for ${releaseTag} in ${outputDir}\n`,
)
