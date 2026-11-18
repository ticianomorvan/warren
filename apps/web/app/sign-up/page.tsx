import { PASSWORD_MIN_LENGTH } from '@warren/core'
import type { Metadata } from 'next'
import { AuthForm } from '@/components/auth-form'
import { t } from '@/lib/strings'

export const metadata: Metadata = { title: `${t.signUp.title} · ${t.appName}` }

export default function SignUpPage() {
  return <AuthForm mode="sign-up" minPassword={PASSWORD_MIN_LENGTH} />
}
