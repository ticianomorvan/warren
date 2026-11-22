import { describe, expect, it } from 'vitest'
import { loadConfig } from './config'

const env = {
  DATABASE_URL: 'postgres://x',
  WHATSAPP_VERIFY_TOKEN: 'verify-token',
  META_APP_SECRET: 's',
  WHATSAPP_PHONE_NUMBER_ID: '1',
  WHATSAPP_ACCESS_TOKEN: 't',
  GRAPH_API_VERSION: 'v27.0',
  ANTHROPIC_API_KEY: 'k',
}

describe('REMINDER_TEMPLATE', () => {
  it('is optional: unset or blank means no template is ever sent', () => {
    expect(loadConfig(env).REMINDER_TEMPLATE).toBeUndefined()
    expect(loadConfig({ ...env, REMINDER_TEMPLATE: '  ' }).REMINDER_TEMPLATE).toBeUndefined()
  })

  it('is the template name, trimmed', () => {
    expect(loadConfig({ ...env, REMINDER_TEMPLATE: ' warren_reminder ' }).REMINDER_TEMPLATE).toBe(
      'warren_reminder',
    )
  })

  it('refuses what Meta would not name a template', () => {
    expect(() => loadConfig({ ...env, REMINDER_TEMPLATE: 'Warren Reminder' })).toThrow(
      'REMINDER_TEMPLATE',
    )
  })
})
