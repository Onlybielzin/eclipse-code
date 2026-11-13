export function createRequiredE2EEnvironment(baseEnvironment, platform = process.platform) {
  const environment =
    platform === 'win32' && !baseEnvironment['ECLIPSE_CODE_E2E_TEST_MATCH']
      ? {
          ...baseEnvironment,
          ECLIPSE_CODE_E2E_TEST_MATCH: '**/*.windows.spec.ts',
        }
      : { ...baseEnvironment }

  return {
    ...environment,
    ECLIPSE_CODE_E2E_RETRIES: '0',
    ECLIPSE_CODE_E2E_DISABLE_CRASH_FALLBACK: '1',
  }
}
