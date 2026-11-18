import { t } from './strings'

export type Mode = 'sign-in' | 'sign-up'

type AuthError = {
  code?: string | undefined
  message?: string | undefined
  status?: number | undefined
}

/**
 * Only the sign-up form may say sign-up is closed: there a 403 means exactly that. Sign-in says
 * nothing more than that it failed, so a refusal there never tells a stranger anything about
 * which emails exist or which are allowed.
 */
export function messageFor(mode: Mode, error: AuthError, minPassword: number): string {
  if (error.status === 429) return t.errors.tooManyAttempts
  if (mode === 'sign-up') {
    if (error.status === 403 || error.message === 'signup_closed') return t.errors.signupClosed
    switch (error.code) {
      case 'USER_ALREADY_EXISTS':
      case 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL':
        return t.errors.exists
      case 'PASSWORD_TOO_SHORT':
        return t.errors.passwordLength(minPassword)
      default:
        return t.errors.generic
    }
  }
  return error.code === 'INVALID_EMAIL_OR_PASSWORD' ? t.errors.invalidCredentials : t.errors.generic
}
