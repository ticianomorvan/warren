/** Shortest password the sign-in accepts: for sign-up and for the operator's reset script alike. */
export const PASSWORD_MIN_LENGTH = 10

/** Better Auth's own limit, so a longer one is refused here with a clear message. */
export const PASSWORD_MAX_LENGTH = 128

/**
 * Who may create an account. Sign-up is closed to strangers until slice 13 (legal review,
 * privacy policy), so the only way in is an allow-list of emails the operator sets. No list
 * means nobody can sign up.
 *
 * An allow-listed email is not proof of ownership: nothing is mailed yet, so whoever signs up
 * first with that address owns the account. List an address only when its owner is about to
 * sign up, and remove it afterwards. Slice 6 adds the mail port, then verification.
 */
export type SignupPolicy = { allows(email: string): boolean }

const normalize = (email: string) => email.trim().toLowerCase()

/** Reads a comma, semicolon or whitespace separated list, e.g. `WARREN_SIGNUP_EMAILS`. */
export function signupPolicy(list: string | undefined): SignupPolicy {
  const allowed = new Set(
    (list ?? '')
      .split(/[\s,;]+/)
      .map(normalize)
      .filter((e) => e.includes('@')),
  )
  return { allows: (email) => allowed.has(normalize(email)) }
}
