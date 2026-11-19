import { describe, expect, it } from 'vitest'
import {
  extractForwardingConfirmation,
  GOOGLE_FORWARDING_POLICY,
  isConfirmUrl,
  recognizeForwardingConfirmation,
} from '../src/mail/forwarding'
import { SENDERS } from '../src/mail/senders'
import { verifySignedMail } from '../src/mail/verify'
import { makeSigner, resolverFor } from './helpers'

const google = makeSigner('google.com')
const WARREN = 'u-aaaaaaaaaaaaaaaaaaaaaa@in.heywarren.app'
const GMAIL = 'persona@gmail.com'
const LINK = 'https://mail-settings.google.com/mail/vf-%5BANGjdJ-abc%5D-xyz'
const CANCEL = 'https://mail-settings.google.com/mail/uf-%5BANGjdJ-abc%5D-xyz'
const RECEIVED = new Date('2026-11-14T13:00:40Z')

const bytes = (s: string) => new TextEncoder().encode(s)
const resolver = resolverFor({ [google.dnsName]: google.record })
const opts = { warrenAddress: WARREN, resolver, receivedAt: RECEIVED, maxDateSkewMinutes: 120 }

function mail(
  over: { from?: string; to?: string; subject?: string; body?: string; headers?: string } = {},
) {
  return [
    `From: Equipo de Gmail <${over.from ?? 'forwarding-noreply@google.com'}>`,
    `To: ${over.to ?? WARREN}`,
    `Subject: ${over.subject ?? `Confirmación de reenvío de Gmail: recibir correo de ${GMAIL}`}`,
    'Date: Sat, 14 Nov 2026 10:00:00 -0300',
    'Message-ID: <abc@google.com>',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    over.body ??
      `${GMAIL} pidió reenviar correo a ${WARREN}.\r\n\r\nConfirmar: ${LINK}\r\n\r\nCancelar: ${CANCEL}`,
    '',
  ].join('\r\n')
}

const recognize = (raw: string) => recognizeForwardingConfirmation(bytes(raw), opts)

describe('recognizeForwardingConfirmation', () => {
  it('keeps Google out of the bank sender list', () => {
    expect(SENDERS.some((s) => s.fromAddresses.includes('forwarding-noreply@google.com'))).toBe(
      false,
    )
    expect(GOOGLE_FORWARDING_POLICY.allowedSigners).toEqual(['google.com'])
  })

  it('reads the address and the confirm link, never the cancel link', async () => {
    expect(await recognize(await google.sign(mail()))).toEqual({
      status: 'confirmation',
      confirmation: { address: GMAIL, url: LINK },
    })
  })

  it('works on an English subject and on an encoded one', async () => {
    const english = mail({ subject: `Gmail Forwarding Confirmation - Receive Mail from ${GMAIL}` })
    expect((await recognize(await google.sign(english))).status).toBe('confirmation')
    const word = Buffer.from(`Confirmación de reenvío: ${GMAIL}`).toString('base64')
    const encoded = mail({ subject: `=?UTF-8?B?${word}?=` })
    expect(await recognize(await google.sign(encoded))).toMatchObject({
      status: 'confirmation',
      confirmation: { address: GMAIL },
    })
  })

  const refused = async (raw: string) =>
    expect(await recognize(raw)).toEqual({ status: 'not-confirmation' })

  it('refuses unsigned mail', async () => refused(mail()))

  it('refuses a signature by another domain', async () => {
    const evil = makeSigner('evil.example')
    const r = await recognizeForwardingConfirmation(bytes(await evil.sign(mail())), {
      ...opts,
      resolver: resolverFor({ [evil.dnsName]: evil.record }),
    })
    expect(r).toEqual({ status: 'not-confirmation' })
  })

  it('refuses a signature with l=', async () =>
    refused(await google.sign(mail(), 'From:To:Subject:Date', 100)))

  it('refuses when the Subject is not signed', async () =>
    refused(await google.sign(mail(), 'From:To:Date')))

  it('refuses a body changed after signing', async () => {
    const signed = await google.sign(mail())
    await refused(signed.replace('vf-', 'vf-x'))
  })

  it('refuses a From that is not Google', async () =>
    refused(await google.sign(mail({ from: 'alguien@google.com' }))))

  it("refuses a To that is not the user's own Warren address", async () => {
    await refused(await google.sign(mail({ to: 'u-bbbbbbbbbbbbbbbbbbbbbb@in.heywarren.app' })))
  })

  it('refuses a link on another host', async () => {
    const body = `${GMAIL} pidió reenviar.\r\nhttps://evil.example/mail/vf-abc\r\nhttps://mail-settings.google.com.evil.example/mail/vf-abc`
    await refused(await google.sign(mail({ body })))
  })

  it('is not a confirmation without the link or with two other addresses', async () => {
    await refused(await google.sign(mail({ body: 'sin enlace' })))
    await refused(await google.sign(mail({ subject: `Reenvío: a@gmail.com b@gmail.com` })))
  })

  it('retries, not rejects, on DNS trouble', async () => {
    const r = await recognizeForwardingConfirmation(bytes(await google.sign(mail())), {
      ...opts,
      resolver: async () => {
        throw Object.assign(new Error('timeout'), { code: 'ETIMEOUT' })
      },
    })
    expect(r).toEqual({ status: 'retry' })
  })
})

describe('extractForwardingConfirmation', () => {
  it('drops the Warren address and anything but the one other address', async () => {
    const got = await extractForwardingConfirmation(
      bytes(mail()),
      `Subject ${WARREN} ${GMAIL}`,
      WARREN,
    )
    expect(got?.address).toBe(GMAIL)
  })
})

describe('the policy itself', () => {
  it('requires From, To and Subject to be signed, and rejects mail whose Subject is not', async () => {
    expect([...GOOGLE_FORWARDING_POLICY.requiredSignedHeaders].sort()).toEqual([
      'from',
      'subject',
      'to',
    ])
    // The verifier alone, with this policy: a signature that leaves Subject out is refused for that.
    const verdict = await verifySignedMail(bytes(await google.sign(mail(), 'From:To:Date')), {
      senders: [GOOGLE_FORWARDING_POLICY],
      mailboxes: [WARREN],
      resolver,
      receivedAt: RECEIVED,
      maxDateSkewMinutes: 120,
    })
    expect(verdict).toMatchObject({
      verdict: 'rejected',
      reason: 'header-not-signed',
      detail: 'subject',
    })
  })
})

describe('isConfirmUrl', () => {
  it('accepts only https on mail-settings.google.com with a vf- path', () => {
    expect(isConfirmUrl(LINK)).toBe(true)
    for (const bad of [
      CANCEL,
      'http://mail-settings.google.com/mail/vf-abc',
      'https://mail-settings.google.com/other/vf-abc',
      'https://mail-settings.google.com.evil.example/mail/vf-abc',
      'https://evil.example/mail/vf-abc',
      'https://xmail-settings.google.com/mail/vf-abc',
      'https://google.com/mail/vf-abc',
      'https://mail-settings.google.com@evil.example/mail/vf-abc',
      'https://user:pw@mail-settings.google.com/mail/vf-abc',
      'https://evil.example/?u=https://mail-settings.google.com/mail/vf-abc',
      'not a url',
    ]) {
      expect(isConfirmUrl(bad), bad).toBe(false)
    }
  })
})

describe('the requesting address in the subject', () => {
  const subjectOf = async (subject: string) =>
    (await extractForwardingConfirmation(bytes(mail()), subject, WARREN))?.address
  it('ignores punctuation around it', async () => {
    for (const subject of [
      `Confirmación: [${GMAIL}]`,
      `Confirmation for <${GMAIL}>.`,
      `Confirmación de reenvío: recibir correo de ${GMAIL}.`,
      `"${GMAIL}", y listo (${GMAIL})`,
      `¿Recibir correo de ${GMAIL.toUpperCase()}?`,
    ]) {
      expect(await subjectOf(subject), subject).toBe(GMAIL)
    }
  })
})
