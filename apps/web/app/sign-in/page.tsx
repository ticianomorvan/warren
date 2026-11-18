import { PASSWORD_MIN_LENGTH } from '@warren/core'
import type { Metadata } from 'next'
import { AuthForm } from '@/components/auth-form'
import { t } from '@/lib/strings'

export const metadata: Metadata = { title: `${t.signIn.title} · ${t.appName}` }

export default function SignInPage() {
  return <AuthForm mode="sign-in" minPassword={PASSWORD_MIN_LENGTH} />
}
