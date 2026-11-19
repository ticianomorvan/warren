import type { MailVerdict } from '@warren/core'
import { beforeAll, describe, expect, it } from 'vitest'
import { asUser } from '../src/client'
import { claimMailbox, createForwardingConfirmations } from '../src/forwarding'
import { createMailLog, firstMailProgress } from '../src/mail-log'
import { sha, testDatabase } from './helpers'

let t: Awaited<ReturnType<typeof testDatabase>>
let user: string
const progress = () => asUser(t.app, user, firstMailProgress)
const receive = (c: string, verdict: MailVerdict) =>
  asUser(t.app, user, async (scope) => {
    const log = createMailLog(scope)
    await log.recordMail({
      mailId: sha(c),
      pathname: `u/x/mail/${sha(c)}.eml.sealed`,
      bytes: 10,
      provider: 'resend',
      providerId: `em_${c}`,
      receivedAt: new Date(),
    })
    await log.recordVerdict(sha(c), verdict, 1)
  })
const verified: MailVerdict = {
  verdict: 'verified',
  senderId: 'bbva-transfers',
  fromAddress: 'avisos@bbva.com.ar',
  signingDomain: 'bbva.com.ar',
  selector: 's1',
  keyRecord: 'k',
  signedHeaders: ['date', 'from', 'to', 'subject'],
  subject: 'x',
  signedDate: new Date('2026-11-14T13:00:00Z'),
}
const rejected: MailVerdict = { verdict: 'rejected', reason: 'date-skew', fromAddress: null }

beforeAll(async () => {
  t = await testDatabase()
  user = await t.newUser('first')
})

describe('firstMailProgress', () => {
  it('waits without a mailbox, even when old verified mail exists', async () => {
    await receive('a', verified)
    expect(await progress()).toEqual({ state: 'waiting' })
  })

  it('ignores history from before the claim, then shows a rejection, then a verified mail', async () => {
    await asUser(t.app, user, (s) =>
      createForwardingConfirmations(s).record(
        { address: 'ana@gmail.com', url: 'https://mail-settings.google.com/mail/vf-x' },
        new Date(),
      ),
    )
    expect(await asUser(t.app, user, (s) => claimMailbox(s, 'ana@gmail.com'))).toBe('claimed')
    expect(await progress()).toEqual({ state: 'waiting' })
    await receive('b', rejected)
    expect(await progress()).toEqual({ state: 'rejected', reason: 'date-skew' })
    await receive('c', verified)
    expect(await progress()).toEqual({
      state: 'verified',
      templateId: null,
      signedDate: new Date('2026-11-14T13:00:00Z'),
    })
  })
})
