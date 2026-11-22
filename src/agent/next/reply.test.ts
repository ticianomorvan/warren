import { describe, expect, it } from 'vitest'
import { checkReply, compose, REPLY_SAY_FALLBACK } from './reply'

const ev = (o: Partial<Parameters<typeof checkReply>[1]> = {}) => ({
  numbers: ['café 2900 ARS 11:40', 'borra el super'],
  words: ['borra el super'],
  window: [] as string[],
  ...o,
})

describe('checkReply', () => {
  it('lets through a text whose numbers all come from the evidence', () => {
    expect(checkReply('El café fue $2.900 a las 11:40.', ev())).toEqual({
      ok: true,
      text: 'El café fue $2.900 a las 11:40.',
    })
  })
  it('refuses a number code did not give, a total made of pieces and a number in words', () => {
    expect(checkReply('Gastaste $5.800', ev())).toMatchObject({ ok: false })
    expect(checkReply('Fueron 2 lucas', ev({ numbers: ['2', 'lucas'] }))).toMatchObject({
      ok: false,
    })
    expect(checkReply('Lo anotaste cuatro veces', ev())).toMatchObject({ ok: false })
  })
  it('refuses a line shaped like a record, an empty text and a long one', () => {
    expect(checkReply('✓ Café $2.900', ev())).toMatchObject({ ok: false })
    expect(checkReply('  ', ev())).toMatchObject({ ok: false })
    expect(checkReply('a'.repeat(281), ev())).toMatchObject({ ok: false })
  })
  it('a claim of a change needs an earlier reply that shows it', () => {
    expect(checkReply('Sí, borré el súper.', ev())).toMatchObject({ ok: false })
    expect(
      checkReply('Sí, borré el súper.', ev({ window: ['✓ Borré: Súper $12.000'] })),
    ).toMatchObject({
      ok: true,
    })
    expect(checkReply('No borré nada.', ev())).toMatchObject({ ok: true })
  })
})

describe('compose', () => {
  const call = { tool: 'reply', input: { text: 'Gastaste $5.800' } } as const
  it('a reply that fails the check is replaced by the apology', () => {
    const { reply } = compose(
      { rendered: new Map(), declined: [], evidence: ev() },
      [{ call, outcome: null, line: null }],
      null,
    )
    expect(reply).toBe(REPLY_SAY_FALLBACK)
  })
  it('renders a decline by its code, once, and keeps a heard line only without a record', () => {
    const i = {
      rendered: new Map(),
      declined: ['secret', 'secret'] as const,
      evidence: ev(),
      heard: 'mi clave',
    }
    const { reply } = compose({ ...i, declined: [...i.declined] }, [], null)
    expect(reply).toBe('🎙️ "mi clave"\nNo guardo claves, números de tarjeta, CBU/CVU ni documentos.')
    const redacted = compose({ ...i, declined: [...i.declined], redact: true }, [], null)
    expect(redacted.reply).not.toContain('mi clave')
  })
})
