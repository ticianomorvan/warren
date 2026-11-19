import { generateKeyPairSync } from 'node:crypto'
import { dkimSign } from 'mailauth'
import type { TxtResolver } from '../src/mail/resolver'

/** Synthetic signer: tests never use real bank mail or real keys. */
export function makeSigner(domain: string, selector = 'test1', bits = 2048) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: bits })
  const record = `v=DKIM1; k=rsa; p=${publicKey.export({ type: 'spki', format: 'der' }).toString('base64')}`
  return {
    dnsName: `${selector}._domainkey.${domain}`,
    record,
    async sign(
      message: string,
      headerList = 'From:To:Subject:Date',
      maxBodyLength?: number,
    ): Promise<string> {
      const res = await dkimSign(message, {
        canonicalization: 'relaxed/relaxed',
        signTime: new Date('2026-11-14T13:00:00Z'),
        signatureData: [
          {
            signingDomain: domain,
            selector,
            privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
            algorithm: 'rsa-sha256',
            headerList,
            ...(maxBodyLength === undefined ? {} : { maxBodyLength }),
          },
        ],
      })
      if (res.errors.length > 0) throw new Error(JSON.stringify(res.errors))
      return res.signatures + message
    },
  }
}

export function resolverFor(records: Record<string, string>): TxtResolver {
  return async (name) => {
    const rr = records[name]
    if (!rr) throw Object.assign(new Error('NXDOMAIN'), { code: 'ENOTFOUND' })
    return [[rr]]
  }
}

export const failingResolver: TxtResolver = async () => {
  throw Object.assign(new Error('timeout'), { code: 'ETIMEOUT' })
}

export const MAILBOX = 'user@example.com'

export function message(over: { from?: string; to?: string; date?: string; body?: string } = {}) {
  return [
    `From: BBVA <${over.from ?? 'avisos@bbva.com.ar'}>`,
    `To: ${over.to ?? MAILBOX}`,
    'Subject: Realizaste una transferencia',
    `Date: ${over.date ?? 'Sat, 14 Nov 2026 10:00:00 -0300'}`,
    'Message-ID: <abc@bbva.com.ar>',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    over.body ?? 'Transferiste $ 1.000,00',
    '',
  ].join('\r\n')
}

export const RECEIVED_AT = new Date('2026-11-14T13:00:40Z')

/** A synthetic Belo mail: layout and wording invented, never copied from a real one. */
export function beloMessage(
  over: { from?: string; to?: string; subject?: string; date?: string; html?: string } = {},
) {
  return [
    `From: Belo <${over.from ?? 'transaction@belo.app'}>`,
    `To: ${over.to ?? MAILBOX}`,
    `Subject: ${over.subject ?? 'Test operation'}`,
    `Date: ${over.date ?? 'Sat, 14 Nov 2026 10:00:00 -0300'}`,
    'Message-ID: <abc@belo.app>',
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=utf-8',
    '',
    over.html ?? '<p>synthetic body</p>',
    '',
  ].join('\r\n')
}
