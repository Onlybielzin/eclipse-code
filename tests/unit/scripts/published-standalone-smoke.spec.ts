import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  assertPublishedAssetChecksum,
  assertPublishedChecksumInventory,
  resolvePublishedCommandInvocation,
  resolvePublishedStandaloneReleaseTarget,
} from '../../../scripts/lib/published-standalone-smoke.mjs'

describe('published standalone release smoke contract', () => {
  it('uses cmd.exe verbatim quoting for an installed Windows launcher path', () => {
    expect(
      resolvePublishedCommandInvocation({
        platform: 'win32',
        command: 'C:\\Temp Space\\eclipse-code.cmd',
        args: ['worker', 'start', '--help'],
        comspec: 'C:\\Windows\\System32\\cmd.exe',
      }),
    ).toEqual({
      command: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', '""C:\\Temp Space\\eclipse-code.cmd" "worker" "start" "--help""'],
      windowsVerbatimArguments: true,
    })
  })

  it.runIf(process.platform === 'win32')(
    'executes an installed launcher in a Windows path containing spaces',
    async () => {
      const root = await mkdtemp(path.join(tmpdir(), 'eclipse-code launcher '))
      try {
        const launcher = path.join(root, 'eclipse-code.cmd')
        await writeFile(
          launcher,
          [
            '@echo off',
            'if not "%~1"=="worker" exit /b 21',
            'if not "%~2"=="start" exit /b 22',
            'if not "%~3"=="--help" exit /b 23',
            'echo launcher-ok',
          ].join('\r\n'),
          'utf8',
        )
        const invocation = resolvePublishedCommandInvocation({
          platform: process.platform,
          command: launcher,
          args: ['worker', 'start', '--help'],
          comspec: process.env['ComSpec'],
        })
        const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
          (resolve, reject) => {
            const child = spawn(invocation.command, invocation.args, {
              windowsHide: true,
              windowsVerbatimArguments: invocation.windowsVerbatimArguments,
            })
            let stdout = ''
            let stderr = ''
            child.stdout.on('data', chunk => (stdout += String(chunk)))
            child.stderr.on('data', chunk => (stderr += String(chunk)))
            child.once('error', reject)
            child.once('exit', code => resolve({ code, stdout, stderr }))
          },
        )
        expect(result).toMatchObject({ code: 0, stderr: '' })
        expect(result.stdout).toContain('launcher-ok')
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
  )

  it('resolves the exact stable installer, uninstaller, and Linux Worker bundle for v0.3.0', () => {
    expect(
      resolvePublishedStandaloneReleaseTarget({
        tag: 'v0.3.0',
        platform: 'linux',
        arch: 'x64',
      }),
    ).toMatchObject({
      version: '0.3.0',
      stable: true,
      installerName: 'eclipse-code-install-v0.3.0.sh',
      uninstallerName: 'eclipse-code-uninstall-v0.3.0.sh',
      latestInstallerName: 'eclipse-code-install.sh',
      latestUninstallerName: 'eclipse-code-uninstall.sh',
      bundleName: 'eclipse-code-server-linux-x64.tar.gz',
      installerUrl:
        'https://github.com/Onlybielzin/eclipse-code/releases/download/v0.3.0/eclipse-code-install-v0.3.0.sh',
      uninstallerUrl:
        'https://github.com/Onlybielzin/eclipse-code/releases/download/v0.3.0/eclipse-code-uninstall-v0.3.0.sh',
      bundleUrl:
        'https://github.com/Onlybielzin/eclipse-code/releases/download/v0.3.0/eclipse-code-server-linux-x64.tar.gz',
      latestInstallerUrl:
        'https://github.com/Onlybielzin/eclipse-code/releases/latest/download/eclipse-code-install.sh',
      latestUninstallerUrl:
        'https://github.com/Onlybielzin/eclipse-code/releases/latest/download/eclipse-code-uninstall.sh',
      latestBundleUrl:
        'https://github.com/Onlybielzin/eclipse-code/releases/latest/download/eclipse-code-server-linux-x64.tar.gz',
    })
  })

  it('keeps nightly Windows downloads tag-pinned without latest aliases', () => {
    expect(
      resolvePublishedStandaloneReleaseTarget({
        tag: 'v0.3.1-nightly.20260904.1',
        platform: 'win32',
        arch: 'x64',
      }),
    ).toMatchObject({
      stable: false,
      installerName: 'eclipse-code-install-v0.3.1-nightly.20260904.1.ps1',
      uninstallerName: 'eclipse-code-uninstall-v0.3.1-nightly.20260904.1.ps1',
      latestInstallerName: null,
      latestUninstallerName: null,
      bundleName: 'eclipse-code-server-windows-x64.zip',
    })
  })

  it('requires checksums for installers, uninstallers, the platform bundle, and stable aliases', () => {
    const target = resolvePublishedStandaloneReleaseTarget({
      tag: 'v0.3.0',
      platform: 'darwin',
      arch: 'arm64',
    })
    const checksums = [
      `aaa  ${target.installerName}`,
      `bbb  ${target.uninstallerName}`,
      `ccc  ${target.bundleName}`,
      `ddd  ${target.latestInstallerName}`,
      `eee  ${target.latestUninstallerName}`,
    ].join('\n')

    expect(() => assertPublishedChecksumInventory(checksums, target)).not.toThrow()
    expect(() => assertPublishedChecksumInventory(`aaa  ${target.installerName}`, target)).toThrow(
      /eclipse-code-uninstall-v0\.3\.0\.sh/u,
    )
  })

  it('compares downloaded bytes with the release checksum instead of trusting filenames', () => {
    const content = Buffer.from('published installer')
    const sha256 = '71e9a493e408da448a75fd544de41d29171d4f64cbc0acbe77c4657909a814c5'
    const checksums = `${sha256}  eclipse-code-install-v0.3.0.sh\n`

    expect(() =>
      assertPublishedAssetChecksum(content, checksums, 'eclipse-code-install-v0.3.0.sh'),
    ).not.toThrow()
    expect(() =>
      assertPublishedAssetChecksum(
        Buffer.from('tampered installer'),
        checksums,
        'eclipse-code-install-v0.3.0.sh',
      ),
    ).toThrow(/SHA256 mismatch/u)
  })
})
