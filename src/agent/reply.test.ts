import { describe, expect, it } from 'vitest'
import type { ReplyCheck } from '../core/reply-check'
import { compose, REPLY_SAY_FALLBACK } from './reply'

describe('compose', () => {
  const said = (verdict?: ReplyCheck) =>
    ({
      tool: 'reply',
      input: { text: 'Gastaste $5.800' },
      ...(verdict ? { verdict } : {}),
    }) as const
  it('a reply whose words passed the check is sent as checked', () => {
    const { reply } = compose(
      { rendered: new Map(), declined: [] },
      [{ call: said({ ok: true, text: 'Gastaste $5.800' }), outcome: null, line: null }],
      null,
    )
    expect(reply).toBe('Gastaste $5.800')
  })
  it('a reply that failed the check (on the last turn), or never had one, is replaced by the apology', () => {
    for (const call of [said({ ok: false, reason: 'number not given by code: $5.800' }), said()]) {
      const { reply } = compose(
        { rendered: new Map(), declined: [] },
        [{ call, outcome: null, line: null }],
        null,
      )
      expect(reply).toBe(REPLY_SAY_FALLBACK)
    }
  })
  it('renders a decline by its code, once, and keeps a heard line only without a record', () => {
    const i = {
      rendered: new Map(),
      declined: ['secret', 'secret'] as const,
      heard: 'mi clave',
    }
    const { reply } = compose({ ...i, declined: [...i.declined] }, [], null)
    expect(reply).toBe('🎙️ "mi clave"\nNo guardo claves, números de tarjeta, CBU/CVU ni documentos.')
    const redacted = compose({ ...i, declined: [...i.declined], redact: true }, [], null)
    expect(redacted.reply).not.toContain('mi clave')
  })
})
