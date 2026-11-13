import { describe, expect, it } from 'vitest'
import { DEFAULT_AGENT_SETTINGS, normalizeAgentSettings } from './agentSettings'

describe('agent full access setting', () => {
  it('starts on for a new install (Eclipse Code runs agents in bypass)', () => {
    expect(DEFAULT_AGENT_SETTINGS.agentFullAccess).toBe(true)
    expect(normalizeAgentSettings(undefined).agentFullAccess).toBe(true)
    expect(normalizeAgentSettings(null).agentFullAccess).toBe(true)
    // Persistence stores "nothing saved yet" as an empty record.
    expect(normalizeAgentSettings({}).agentFullAccess).toBe(true)
  })

  it('keeps full access for saved settings from before the setting was written', () => {
    expect(normalizeAgentSettings({ language: 'en' }).agentFullAccess).toBe(true)
  })

  it('keeps an explicit choice either way', () => {
    expect(normalizeAgentSettings({ agentFullAccess: false }).agentFullAccess).toBe(false)
    expect(normalizeAgentSettings({ agentFullAccess: true }).agentFullAccess).toBe(true)
  })
})
