import { describe, expect, it } from 'vitest'
import { messageFor } from '../lib/auth-errors'
import { t } from '../lib/strings'

describe('messageFor', () => {
  it('says registration is closed only on the sign-up form', () => {
    const closed = { status: 403, message: 'signup_closed' }
    expect(messageFor('sign-up', closed, 10)).toBe(t.errors.signupClosed)
    expect(messageFor('sign-in', closed, 10)).toBe(t.errors.generic)
    expect(messageFor('sign-in', { status: 403 }, 10)).toBe(t.errors.generic)
  })

  it('tells a wrong password on sign-in, and a short one on sign-up', () => {
    expect(messageFor('sign-in', { code: 'INVALID_EMAIL_OR_PASSWORD' }, 10)).toBe(
      t.errors.invalidCredentials,
    )
    expect(messageFor('sign-up', { code: 'PASSWORD_TOO_SHORT' }, 12)).toBe(
      t.errors.passwordLength(12),
    )
  })

  it('says to wait when rate limited, on either form', () => {
    expect(messageFor('sign-in', { status: 429 }, 10)).toBe(t.errors.tooManyAttempts)
    expect(messageFor('sign-up', { status: 429 }, 10)).toBe(t.errors.tooManyAttempts)
  })
})
