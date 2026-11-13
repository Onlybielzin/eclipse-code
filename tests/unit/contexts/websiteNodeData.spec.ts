import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createWebsiteNodeData,
  resolveDefaultBrowserMode,
} from '../../../src/contexts/workspace/presentation/renderer/utils/websiteNodeData'

function setEclipseCodeApi(value: unknown): void {
  Object.defineProperty(window, 'eclipseCodeApi', {
    configurable: true,
    value,
  })
}

afterEach(() => {
  vi.restoreAllMocks()
  setEclipseCodeApi(undefined)
})

describe('websiteNodeData', () => {
  it('defaults to native mode when the client website API is available', () => {
    setEclipseCodeApi({ websiteWindow: { activate: vi.fn() } })

    expect(resolveDefaultBrowserMode()).toBe('native')
    expect(createWebsiteNodeData({ url: ' https://example.test ' })).toMatchObject({
      url: 'https://example.test',
      browserMode: 'native',
      sessionMode: 'shared',
      profileId: null,
      isFullscreen: false,
      previousFrame: null,
    })
  })

  it('defaults new WebUI nodes to iframe without rewriting synced native nodes', () => {
    setEclipseCodeApi({})

    expect(resolveDefaultBrowserMode()).toBe('iframe')
    expect(createWebsiteNodeData({ url: 'https://web.example.test' }).browserMode).toBe('iframe')
    expect(
      createWebsiteNodeData({
        url: 'https://client.example.test',
        browserMode: 'native',
      }).browserMode,
    ).toBe('native')
  })

  it('normalizes profile sessions and fullscreen frame data', () => {
    expect(
      createWebsiteNodeData({
        url: 'https://example.test',
        sessionMode: 'profile',
        profileId: ' team ',
        isFullscreen: true,
        previousFrame: {
          position: { x: 1, y: 2 },
          size: { width: 300, height: 200 },
        },
      }),
    ).toMatchObject({
      sessionMode: 'profile',
      profileId: 'team',
      isFullscreen: true,
      previousFrame: {
        position: { x: 1, y: 2 },
        size: { width: 300, height: 200 },
      },
    })

    expect(
      createWebsiteNodeData({
        url: 'https://example.test',
        sessionMode: 'profile',
        profileId: '',
      }),
    ).toMatchObject({ sessionMode: 'shared', profileId: null })
  })
})
