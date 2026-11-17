import { describe, expect, it } from 'vitest'
import { clipboardKeyAction, isImageOnlyPaste } from './clipboardKeys'

const base = {
  ctrl: true,
  shift: false,
  alt: false,
  meta: false,
  key: 'c',
  type: 'keydown',
  hasSelection: false,
  platform: 'linux',
}

describe('clipboardKeyAction', () => {
  it('Ctrl+C com selecao copia', () => {
    expect(clipboardKeyAction({ ...base, hasSelection: true })).toBe('copy')
  })
  it('Ctrl+C sem selecao passa (^C)', () => {
    expect(clipboardKeyAction(base)).toBe('pass')
  })
  it('Ctrl+Shift+C passa', () => {
    expect(clipboardKeyAction({ ...base, shift: true, hasSelection: true })).toBe('pass')
  })
  it('Ctrl+V cola, com Ctrl+V maiusculo tambem', () => {
    expect(clipboardKeyAction({ ...base, key: 'v' })).toBe('paste')
    expect(clipboardKeyAction({ ...base, key: 'V' })).toBe('paste')
  })
  it('Ctrl+Backspace apaga a palavra', () => {
    expect(clipboardKeyAction({ ...base, key: 'Backspace' })).toBe('deleteWord')
  })
  it('Backspace sozinho e Ctrl+Shift+Backspace passam', () => {
    expect(clipboardKeyAction({ ...base, ctrl: false, key: 'Backspace' })).toBe('pass')
    expect(clipboardKeyAction({ ...base, shift: true, key: 'Backspace' })).toBe('pass')
  })
  it('Ctrl+Backspace em keyup ou no mac passa', () => {
    expect(clipboardKeyAction({ ...base, key: 'Backspace', type: 'keyup' })).toBe('pass')
    expect(clipboardKeyAction({ ...base, key: 'Backspace', platform: 'darwin' })).toBe('pass')
  })
  it('keyup passa', () => {
    expect(clipboardKeyAction({ ...base, key: 'v', type: 'keyup' })).toBe('pass')
  })
  it('darwin passa', () => {
    expect(clipboardKeyAction({ ...base, key: 'v', platform: 'darwin' })).toBe('pass')
  })
})

describe('isImageOnlyPaste', () => {
  const dt = (types: string[], text = '', kinds: string[] = []) =>
    ({
      getData: () => text,
      types,
      items: kinds.map((k) => ({ kind: 'file', type: k })),
    }) as unknown as DataTransfer
  it('so imagem', () => {
    expect(isImageOnlyPaste(dt(['Files'], '', ['image/png']))).toBe(true)
  })
  it('com texto nao', () => {
    expect(isImageOnlyPaste(dt(['text/plain', 'Files'], 'oi', ['image/png']))).toBe(false)
  })
  it('vazio nao', () => {
    expect(isImageOnlyPaste(dt([]))).toBe(false)
  })
})
