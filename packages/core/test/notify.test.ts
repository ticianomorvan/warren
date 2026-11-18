import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  type Attempt,
  type AttemptRecord,
  type DeliveryStatus,
  flushNotices,
  formatAmount,
  handleKapsoWebhook,
  type KapsoWebhookDeps,
  kapsoSender,
  type NoticeMovement,
  noticeOneLine,
  noticeText,
  type OpenNotice,
  type Outbox,
  parseKapsoStatuses,
  planAttempt,
  type SendResult,
  verifyKapsoWebhook,
  type WhatsAppSender,
  WINDOW_CLOSED,
  type WithOutbox,
} from '../src/notify'

const sent: NoticeMovement = {
  type: 'unclassified',
  direction: 'out',
  amount: '1500.00000000',
  currency: 'ARS',
  date: '2026-11-14',
  time: '14:09:00',
  accountName: 'Bank ARS',
  counterAccountName: null,
  counterpartyName: 'Juana Ejemplo',
}

describe('notice text', () => {
  it('formats amounts the Argentine way without floating point', () => {
    expect(formatAmount('1500.00000000')).toBe('1.500,00')
    expect(formatAmount('3.77')).toBe('3,77')
    expect(formatAmount('1234567.5')).toBe('1.234.567,50')
    expect(formatAmount('0.12345678')).toBe('0,12345678')
    expect(formatAmount('12345678901234567890.01')).toBe('12.345.678.901.234.567.890,01')
    expect(() => formatAmount('1e3')).toThrow()
  })

  it('describes a transfer sent to someone else', () => {
    expect(noticeText(sent)).toBe(
      'Transferencia enviada\n$ 1.500,00 a Juana Ejemplo\nBank ARS · 14/11 14:09',
    )
  })

  it('describes a transfer received, with parts still unknown left out', () => {
    const received = { ...sent, direction: 'in' as const, accountName: null, time: null }
    expect(noticeText(received)).toBe('Transferencia recibida\n$ 1.500,00 de Juana Ejemplo\n14/11')
  })

  it('describes a transfer between own accounts by account name', () => {
    const own = { ...sent, type: 'own_transfer' as const, counterAccountName: 'Wallet ARS' }
    expect(noticeText(own)).toBe(
      'Transferencia entre tus cuentas\n$ 1.500,00\nBank ARS → Wallet ARS\n14/11 14:09',
    )
    expect(noticeText({ ...own, accountName: null })).toContain('\n→ Wallet ARS\n')
    expect(noticeOneLine(own)).toBe(
      'Transferencia entre tus cuentas · $ 1.500,00 · Bank ARS → Wallet ARS · 14/11 14:09',
    )
  })

  it('never mentions a remaining balance', () => {
    expect(noticeText(sent)).not.toMatch(/queda/i)
  })
})

const failed = (over: Partial<AttemptRecord> = {}): AttemptRecord => ({
  mode: 'text',
  failed: true,
  errorCode: null,
  retryable: true,
  ...over,
})

describe('planAttempt', () => {
  it('starts with plain text', () => {
    expect(planAttempt([], false)).toBe('text')
  })
  it('stops once an attempt stands', () => {
    expect(planAttempt([failed(), { ...failed(), failed: false }], true)).toBe('done')
  })
  it('retries a temporary failure and gives up on a final one', () => {
    expect(planAttempt([failed()], false)).toBe('text')
    expect(planAttempt([failed({ retryable: false, errorCode: 100 })], true)).toBe('give-up')
  })
  it('switches to the template when the window is closed', () => {
    const closed = failed({ retryable: false, errorCode: WINDOW_CLOSED })
    expect(planAttempt([closed], true)).toBe('template')
    expect(planAttempt([closed], false)).toBe('give-up')
    expect(planAttempt([closed, failed({ mode: 'template' })], true)).toBe('template')
    expect(planAttempt([closed, failed({ mode: 'template', retryable: false })], true)).toBe(
      'give-up',
    )
  })
  it('gives up after four attempts', () => {
    expect(planAttempt([failed(), failed(), failed(), failed()], true)).toBe('give-up')
  })
})

function fakeFetch(status: number, json: unknown) {
  const calls: { url: string; init: RequestInit }[] = []
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return new Response(JSON.stringify(json), { status })
  }) as unknown as typeof fetch
  return { calls, fetchFn }
}

const config = { apiKey: 'key', phoneNumberId: '111', to: '5490000000000' }

describe('kapsoSender', () => {
  it('sends text to the recipient and returns the message id', async () => {
    const { calls, fetchFn } = fakeFetch(200, { messages: [{ id: 'wamid.A' }] })
    const result = await kapsoSender({ ...config, fetchFn }).sendText('hola')
    expect(result).toEqual({ outcome: 'sent', wamid: 'wamid.A' })
    expect(calls[0]?.url).toBe('https://api.kapso.ai/meta/whatsapp/v24.0/111/messages')
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({
      messaging_product: 'whatsapp',
      to: '5490000000000',
      type: 'text',
      text: { body: 'hola' },
    })
  })

  it('reports a closed window as a final failure with its code', async () => {
    const { fetchFn } = fakeFetch(422, { error: { code: WINDOW_CLOSED, message: 'outside' } })
    const result = await kapsoSender({ ...config, fetchFn }).sendText('hola')
    expect(result).toMatchObject({ outcome: 'failed', errorCode: WINDOW_CLOSED, retryable: false })
  })

  it("reads Kapso's own 24-hour refusal as a closed window", async () => {
    // The body Kapso really sends (seen 2026-11-18), before Meta is asked at all.
    const { fetchFn } = fakeFetch(422, {
      error: 'Cannot send non-template messages outside the 24-hour window.',
      next_steps: 'Send a WhatsApp template message to reopen the session.',
    })
    const result = await kapsoSender({ ...config, fetchFn }).sendText('hola')
    expect(result).toMatchObject({ outcome: 'failed', errorCode: WINDOW_CLOSED, retryable: false })
  })

  it('does not take any other 422 for a closed window', async () => {
    const { fetchFn } = fakeFetch(422, { error: 'Invalid recipient.' })
    const result = await kapsoSender({ ...config, fetchFn }).sendText('hola')
    expect(result).toMatchObject({ outcome: 'failed', errorCode: null, retryable: false })
  })

  it('treats outages and network errors as temporary', async () => {
    const down = fakeFetch(503, {})
    expect(await kapsoSender({ ...config, fetchFn: down.fetchFn }).sendText('x')).toMatchObject({
      outcome: 'failed',
      retryable: true,
    })
    const fetchFn = (async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch
    expect(await kapsoSender({ ...config, fetchFn }).sendText('x')).toMatchObject({
      outcome: 'failed',
      retryable: true,
    })
  })

  it('sends the template only when one is configured', async () => {
    expect(kapsoSender(config).sendTemplate).toBeUndefined()
    const { calls, fetchFn } = fakeFetch(200, { messages: [{ id: 'wamid.T' }] })
    const sender = kapsoSender({
      ...config,
      fetchFn,
      template: { name: 'movement_notice', language: 'es_AR' },
    })
    expect(await sender.sendTemplate?.('una línea')).toEqual({ outcome: 'sent', wamid: 'wamid.T' })
    expect(JSON.parse(String(calls[0]?.init.body)).template).toEqual({
      name: 'movement_notice',
      language: { code: 'es_AR' },
      components: [{ type: 'body', parameters: [{ type: 'text', text: 'una línea' }] }],
    })
  })
})

const SECRET = 'a-webhook-secret'
const sign = (body: string) => createHmac('sha256', SECRET).update(body).digest('hex')

const failedEvent = JSON.stringify({
  message: {
    id: 'wamid.A',
    timestamp: '1730093200',
    kapso: {
      status: 'failed',
      statuses: [
        { id: 'wamid.A', status: 'sent', timestamp: '1730093100' },
        {
          id: 'wamid.A',
          status: 'failed',
          timestamp: '1730093200',
          errors: [{ code: WINDOW_CLOSED }],
        },
      ],
    },
  },
})

describe('Kapso webhook', () => {
  it('accepts only a correct signature over the exact body', () => {
    expect(verifyKapsoWebhook(failedEvent, sign(failedEvent), SECRET)).toBe(true)
    expect(verifyKapsoWebhook(`${failedEvent} `, sign(failedEvent), SECRET)).toBe(false)
    expect(verifyKapsoWebhook(failedEvent, null, SECRET)).toBe(false)
    expect(verifyKapsoWebhook(failedEvent, 'zz', SECRET)).toBe(false)
    expect(verifyKapsoWebhook(failedEvent, sign(failedEvent), '')).toBe(false)
  })

  it('reads statuses, single or batched, and ignores other events', () => {
    expect(parseKapsoStatuses(failedEvent, 'whatsapp.message.failed')).toEqual([
      {
        wamid: 'wamid.A',
        status: 'failed',
        errorCode: WINDOW_CLOSED,
        occurredAt: new Date(1730093200_000),
      },
    ])
    const batch = JSON.stringify({ batch: true, data: [JSON.parse(failedEvent)] })
    expect(parseKapsoStatuses(batch, 'whatsapp.message.failed')).toHaveLength(1)
    expect(parseKapsoStatuses(failedEvent, 'whatsapp.message.received')).toEqual([])
    expect(parseKapsoStatuses('not json', 'whatsapp.message.failed')).toEqual([])
  })
})

class MemoryOutbox implements Outbox {
  attempts: Attempt[] = []
  statuses: DeliveryStatus[] = []
  constructor(readonly movement: NoticeMovement) {}
  private history(): AttemptRecord[] {
    return this.attempts.map((a) => {
      const report =
        a.outcome === 'sent'
          ? this.statuses.find((s) => s.wamid === a.wamid && s.status === 'failed')
          : undefined
      if (a.outcome === 'failed') {
        return { mode: a.mode, failed: true, errorCode: a.errorCode, retryable: a.retryable }
      }
      return {
        mode: a.mode,
        failed: report !== undefined,
        errorCode: report?.errorCode ?? null,
        retryable: false,
      }
    })
  }
  /** True inside `within`: one short transaction, in which nothing may be sent. */
  inTx = false
  within: WithOutbox = async (fn) => {
    this.inTx = true
    try {
      return await fn(this)
    } finally {
      this.inTx = false
    }
  }
  async owed(): Promise<OpenNotice[]> {
    return [{ noticeId: 1, movement: this.movement, history: this.history() }]
  }
  async recordAttempt(_noticeId: number, attempt: Attempt) {
    this.attempts.push(attempt)
  }
  knows(wamid: string) {
    return this.attempts.some((a) => a.outcome === 'sent' && a.wamid === wamid)
  }
  async recordStatus(status: DeliveryStatus) {
    const known = this.knows(status.wamid)
    if (known) this.statuses.push(status)
    return known
  }
}

/** A tenancy over one user's outbox: a wamid belongs to the user only if the outbox sent it. */
const tenancyOf = (
  outbox: MemoryOutbox,
  userId = 'u1',
): Pick<KapsoWebhookDeps, 'userForWamid' | 'withOutbox'> => ({
  userForWamid: async (wamid) => (outbox.knows(wamid) ? userId : null),
  withOutbox: async (id, fn) => {
    expect(id).toBe(userId)
    return fn(outbox)
  },
})

function scriptedSender(text: SendResult[], template?: SendResult[]): WhatsAppSender {
  return {
    sendText: async () => text.shift() ?? { outcome: 'sent', wamid: 'wamid.late' },
    ...(template
      ? { sendTemplate: async () => template.shift() ?? { outcome: 'sent', wamid: 'wamid.tpl' } }
      : {}),
  }
}

describe('flushNotices', () => {
  it('sends a notice once', async () => {
    const outbox = new MemoryOutbox(sent)
    const sender = scriptedSender([{ outcome: 'sent', wamid: 'wamid.A' }])
    expect(await flushNotices(outbox.within, sender)).toHaveLength(1)
    expect(await flushNotices(outbox.within, sender)).toHaveLength(0)
    expect(outbox.attempts[0]).toMatchObject({ mode: 'text', body: noticeText(sent) })
  })

  it('sends outside any transaction, and records each attempt in its own', async () => {
    const outbox = new MemoryOutbox(sent)
    const during: boolean[] = []
    const sender: WhatsAppSender = {
      sendText: async () => {
        during.push(outbox.inTx)
        return { outcome: 'sent', wamid: 'wamid.A' }
      },
    }
    await flushNotices(outbox.within, sender)
    expect(during).toEqual([false])
    expect(outbox.attempts).toHaveLength(1)
  })

  it('leaves a temporary failure for the next run', async () => {
    const outbox = new MemoryOutbox(sent)
    const down: SendResult = { outcome: 'failed', errorCode: null, retryable: true, detail: 'x' }
    const sender = scriptedSender([down], [])
    expect(await flushNotices(outbox.within, sender)).toHaveLength(1)
    expect(await flushNotices(outbox.within, sender)).toHaveLength(1)
    expect(outbox.attempts.map((a) => `${a.mode}:${a.outcome}`)).toEqual([
      'text:failed',
      'text:sent',
    ])
  })

  it('falls back to the template when the window is closed', async () => {
    const outbox = new MemoryOutbox(sent)
    const closed: SendResult = {
      outcome: 'failed',
      errorCode: WINDOW_CLOSED,
      retryable: false,
      detail: 'http-422',
    }
    const sender = scriptedSender([closed], [])
    await flushNotices(outbox.within, sender)
    expect(outbox.attempts.map((a) => `${a.mode}:${a.outcome}`)).toEqual([
      'text:failed',
      'template:sent',
    ])
    expect(outbox.attempts[1]?.body).toBe(noticeOneLine(sent))
    await flushNotices(outbox.within, sender)
    expect(outbox.attempts).toHaveLength(2)
  })

  it('does not retry a failed template in the same run', async () => {
    const outbox = new MemoryOutbox(sent)
    const closed: SendResult = {
      outcome: 'failed',
      errorCode: WINDOW_CLOSED,
      retryable: false,
      detail: 'http-422',
    }
    const busy: SendResult = { outcome: 'failed', errorCode: null, retryable: true, detail: 'x' }
    const sender = scriptedSender([closed], [busy])
    expect(await flushNotices(outbox.within, sender)).toHaveLength(2)
    expect(await flushNotices(outbox.within, sender)).toHaveLength(1)
    expect(outbox.attempts.map((a) => `${a.mode}:${a.outcome}`)).toEqual([
      'text:failed',
      'template:failed',
      'template:sent',
    ])
  })

  it('sends the template in the same run when Kapso refuses the text for the window', async () => {
    const outbox = new MemoryOutbox(sent)
    const bodies: unknown[] = []
    const fetchFn = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { type: string }
      bodies.push(body.type)
      return body.type === 'text'
        ? new Response(
            JSON.stringify({
              error: 'Cannot send non-template messages outside the 24-hour window.',
            }),
            { status: 422 },
          )
        : new Response(JSON.stringify({ messages: [{ id: 'wamid.T' }] }), { status: 200 })
    }) as typeof fetch
    const sender = kapsoSender({
      ...config,
      template: { name: 'movement_notice', language: 'es_AR' },
      fetchFn,
    })
    await flushNotices(outbox.within, sender)
    expect(bodies).toEqual(['text', 'template'])
    expect(outbox.attempts.map((a) => `${a.mode}:${a.outcome}`)).toEqual([
      'text:failed',
      'template:sent',
    ])
  })

  it('sends the template after WhatsApp reports the text as failed', async () => {
    const outbox = new MemoryOutbox(sent)
    const sender = scriptedSender([{ outcome: 'sent', wamid: 'wamid.A' }], [])
    await flushNotices(outbox.within, sender)
    const deps = { ...tenancyOf(outbox), sender, senderUserId: 'u1', webhookSecret: SECRET }
    const bad = await handleKapsoWebhook(deps, failedEvent, {
      signature: 'bad',
      event: 'whatsapp.message.failed',
    })
    expect(bad.status).toBe(401)
    const ok = await handleKapsoWebhook(deps, failedEvent, {
      signature: sign(failedEvent),
      event: 'whatsapp.message.failed',
    })
    expect(ok).toEqual({ status: 200, body: { recorded: 1, resent: 1 } })
    expect(outbox.attempts.at(-1)).toMatchObject({ mode: 'template', outcome: 'sent' })
  })

  it("records another user's failure but does not resend through the owner's WhatsApp", async () => {
    const outbox = new MemoryOutbox(sent)
    const sender = scriptedSender([{ outcome: 'sent', wamid: 'wamid.A' }], [])
    await flushNotices(outbox.within, sender)
    const result = await handleKapsoWebhook(
      { ...tenancyOf(outbox, 'u2'), sender, senderUserId: 'u1', webhookSecret: SECRET },
      failedEvent,
      { signature: sign(failedEvent), event: 'whatsapp.message.failed' },
    )
    expect(result.body).toEqual({ recorded: 1, resent: 0 })
    expect(outbox.attempts).toHaveLength(1)
  })

  it('ignores statuses of messages it did not send', async () => {
    const outbox = new MemoryOutbox(sent)
    const result = await handleKapsoWebhook(
      {
        ...tenancyOf(outbox),
        sender: scriptedSender([]),
        senderUserId: 'u1',
        webhookSecret: SECRET,
      },
      failedEvent,
      { signature: sign(failedEvent), event: 'whatsapp.message.failed' },
    )
    expect(result.body).toEqual({ recorded: 0, resent: 0 })
    expect(outbox.attempts).toHaveLength(0)
  })
})

describe('card purchase notice', () => {
  const purchase: NoticeMovement = {
    type: 'card_purchase',
    direction: 'out',
    amount: '1234.56000000',
    currency: 'ARS',
    date: '2026-11-14',
    time: null,
    accountName: 'Visa',
    counterAccountName: null,
    counterpartyName: 'COMERCIO DE EJEMPLO SRL',
    cardLastFour: '1234',
  }

  it('names the card, the amount and the merchant', () => {
    expect(noticeText(purchase)).toBe(
      'Compra con tarjeta …1234\n$ 1.234,56 en COMERCIO DE EJEMPLO SRL\nVisa · 14/11',
    )
  })
  it('writes dollars as US$ and leaves out an account not known yet', () => {
    expect(noticeText({ ...purchase, currency: 'USD', amount: '12.34', accountName: null })).toBe(
      'Compra con tarjeta …1234\nUS$ 12,34 en COMERCIO DE EJEMPLO SRL\n14/11',
    )
  })
  it('has a one-line form for the template', () => {
    expect(noticeOneLine(purchase)).toBe(
      'Compra con tarjeta …1234 · $ 1.234,56 en COMERCIO DE EJEMPLO SRL · Visa · 14/11',
    )
  })
})
