export function isDebugCrashHostEnabled(): boolean {
  return (
    process.env.NODE_ENV === 'test' ||
    typeof process.env.ECLIPSE_CODE_TEST_USER_DATA_DIR === 'string'
  )
}
