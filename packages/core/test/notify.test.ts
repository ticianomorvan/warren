import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  type Attempt,
  type AttemptRecord,
  type DeliveryStatus,
  flushNotices,
  formatAmount,
  handleKapsoWebhook,
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
  it('sends text to the owner and returns the message id', async () => {
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
  async drain(handle: (n: OpenNotice) => Promise<Attempt | null>) {
    const attempt = await handle({ noticeId: 1, movement: this.movement, history: this.history() })
    if (attempt) this.attempts.push(attempt)
    return attempt ? [attempt] : []
  }
  async recordStatus(status: DeliveryStatus) {
    const known = this.attempts.some((a) => a.outcome === 'sent' && a.wamid === status.wamid)
    if (known) this.statuses.push(status)
    return known
  }
}

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
    expect(await flushNotices(outbox, sender)).toHaveLength(1)
    expect(await flushNotices(outbox, sender)).toHaveLength(0)
    expect(outbox.attempts[0]).toMatchObject({ mode: 'text', body: noticeText(sent) })
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
    await flushNotices(outbox, sender)
    await flushNotices(outbox, sender)
    expect(outbox.attempts.map((a) => `${a.mode}:${a.outcome}`)).toEqual([
      'text:failed',
      'template:sent',
    ])
    expect(outbox.attempts[1]?.body).toBe(noticeOneLine(sent))
  })

  it('sends the template after WhatsApp reports the text as failed', async () => {
    const outbox = new MemoryOutbox(sent)
    const sender = scriptedSender([{ outcome: 'sent', wamid: 'wamid.A' }], [])
    await flushNotices(outbox, sender)
    const deps = { outbox, sender, webhookSecret: SECRET }
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

  it('ignores statuses of messages it did not send', async () => {
    const outbox = new MemoryOutbox(sent)
    const result = await handleKapsoWebhook(
      { outbox, sender: scriptedSender([]), webhookSecret: SECRET },
      failedEvent,
      { signature: sign(failedEvent), event: 'whatsapp.message.failed' },
    )
    expect(result.body).toEqual({ recorded: 0, resent: 0 })
    expect(outbox.attempts).toHaveLength(0)
  })
})
