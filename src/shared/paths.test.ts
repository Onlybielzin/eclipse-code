import { describe, expect, it } from 'vitest'
import { isAbsolutePath } from './paths'

describe('isAbsolutePath', () => {
  it.each(['/home/x', '/', 'C:\\Users\\conta\\eclipse-code', 'c:/x/y', 'D:\\', '\\\\servidor\\pasta'])(
    'aceita %s',
    (p) => expect(isAbsolutePath(p)).toBe(true),
  )
  it.each(['', 'rel/x', 'C:', 'C:pasta', 'C:pasta\\x', '\\x', '\\\\', '\\\\servidor', '1:\\x'])(
    'recusa %j',
    (p) => expect(isAbsolutePath(p)).toBe(false),
  )
})
