// @vitest-environment node

import { describe, expect, it } from 'vitest'
import { createRequiredE2EEnvironment } from '../../../scripts/precommit-e2e-env.mjs'

describe('required pre-commit E2E environment', () => {
  it('overrides retry and crash-fallback attempts', () => {
    expect(
      createRequiredE2EEnvironment(
        {
          ECLIPSE_CODE_E2E_RETRIES: '7',
          ECLIPSE_CODE_E2E_DISABLE_CRASH_FALLBACK: '0',
        },
        'darwin',
      ),
    ).toMatchObject({
      ECLIPSE_CODE_E2E_RETRIES: '0',
      ECLIPSE_CODE_E2E_DISABLE_CRASH_FALLBACK: '1',
    })
  })

  it('keeps the Windows platform suite as the required default match', () => {
    expect(createRequiredE2EEnvironment({}, 'win32')).toMatchObject({
      ECLIPSE_CODE_E2E_TEST_MATCH: '**/*.windows.spec.ts',
      ECLIPSE_CODE_E2E_RETRIES: '0',
      ECLIPSE_CODE_E2E_DISABLE_CRASH_FALLBACK: '1',
    })
  })
})
