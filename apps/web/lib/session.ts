import { headers } from 'next/headers'
import { auth } from './auth'

/** The signed-in session, checked against the database (never the cookie alone), or null. */
export async function getSession() {
  return auth().api.getSession({ headers: await headers() })
}
