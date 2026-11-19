import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: () => {} }) }))
vi.mock('@/app/onboarding/actions', () => ({
  claimGmail: async () => ({ ok: false, reason: 'failed' }),
  onboardingStatus: async () => ({ ok: false }),
}))

import { OnboardingPanel } from '../components/onboarding-panel'

const render = (props: { mailboxes: string[]; pending: { address: string; url: string }[] }) =>
  renderToString(
    createElement(OnboardingPanel, {
      address: 'u-abc@in.heywarren.app',
      hasConfirmation: true,
      firstMail: { state: 'waiting' },
      search: '(a@b.c)',
      ...props,
    }),
  )

describe('OnboardingPanel', () => {
  it('still offers a second Gmail once one is connected', () => {
    const html = render({
      mailboxes: ['ana@gmail.com'],
      pending: [{ address: 'otro@gmail.com', url: 'https://mail-settings.google.com/mail/vf-x' }],
    })
    expect(html).toContain('Conectado: ana@gmail.com')
    expect(html).toContain('otro@gmail.com')
    expect(html).toContain('Confirmar en Google')
    // Its "Sí" button waits for the link to be opened.
    expect(html).not.toContain('Sí, otro@gmail.com es mi Gmail')
    // The Gmail filters link names the connected account.
    expect(html).toContain('/mail/?authuser=ana%40gmail.com#settings/filters')
    expect(html).not.toContain('/mail/u/ana')
  })
})
