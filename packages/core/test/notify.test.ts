import { describe, expect, it } from 'vitest'
import {
  type Attempt,
  type AttemptRecord,
  flushNotices,
  formatAmount,
  formatMoney,
  formatSignedMoney,
  memoryPushSender,
  type NoticeMovement,
  noticePushPayload,
  noticeText,
  type OpenNotice,
  type Outbox,
  type PushResult,
  planPush,
  type StoredSubscription,
  sendTestPush,
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
    // The notifier's formatters are strict about a sign; only the signed one takes it.
    expect(() => formatAmount('-1')).toThrow()
    expect(() => formatMoney('-1', 'ARS')).toThrow()
    expect(formatSignedMoney('-1234.5', 'ARS')).toBe('-$ 1.234,50')
    expect(formatSignedMoney('-3.00', 'USD')).toBe('-US$ 3,00')
    expect(formatSignedMoney('1234.5', 'ARS')).toBe('$ 1.234,50')
    expect(formatSignedMoney('-0', 'ARS')).toBe('$ 0,00')
    expect(formatSignedMoney('-0.00000000', 'USD')).toBe('US$ 0,00')
    expect(() => formatSignedMoney('--1', 'ARS')).toThrow()
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
  })

  it('never mentions a remaining balance', () => {
    expect(noticeText(sent)).not.toMatch(/queda/i)
  })
})

class MemoryOutbox implements Outbox {
  attempts: Attempt[] = []
  constructor(readonly movement: NoticeMovement) {}
  subs: StoredSubscription[] = []
  /** Attempts of the former WhatsApp notifier, as the outbox reports them: history only. */
  legacy: AttemptRecord[] = []
  private history(): AttemptRecord[] {
    return [
      ...this.legacy,
      ...this.attempts.map(
        (a): AttemptRecord => ({
          mode: 'push',
          failed: a.outcome !== 'sent',
          retryable: a.outcome === 'failed' && a.retryable,
          subscriptionId: a.subscriptionId,
        }),
      ),
    ]
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
  async subscriptions() {
    return this.subs
  }
  async dropSubscription(id: string) {
    this.subs = this.subs.filter((s) => s.id !== id)
  }
}

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
})

const sub = (id: string): StoredSubscription => ({
  id,
  subscription: { endpoint: `https://push.example/${id}`, p256dh: 'k', auth: 'a' },
})
const pushed = (outcome: PushResult['outcome'], extra: Partial<AttemptRecord> = {}) => ({
  mode: 'push' as const,
  failed: outcome !== 'sent',
  retryable: false,
  subscriptionId: 's1',
  ...extra,
})

describe('planPush', () => {
  it('sends to a subscription with no attempt while nobody has the notice', () => {
    expect(planPush([], 's1')).toBe('send')
  })
  it('is done for a subscription once it has a sent attempt', () => {
    expect(planPush([pushed('sent')], 's1')).toBe('skip')
  })
  it('does not replay a delivered notice on a device added later', () => {
    expect(planPush([pushed('sent')], 's2')).toBe('skip')
    expect(planPush([pushed('failed', { retryable: true })], 's2')).toBe('send')
  })
  it('retries a temporary failure, and stops on a final one or after four attempts', () => {
    const temporary = pushed('failed', { retryable: true })
    expect(planPush([temporary], 's1')).toBe('send')
    expect(planPush([pushed('failed')], 's1')).toBe('skip')
    expect(planPush([temporary, temporary, temporary, temporary], 's1')).toBe('skip')
  })
  it('treats a notice with any legacy attempt as finished, sent or closed for good', () => {
    const legacy = (over: Partial<AttemptRecord> = {}): AttemptRecord => ({
      mode: 'legacy',
      failed: false,
      retryable: false,
      ...over,
    })
    expect(planPush([legacy()], 's1')).toBe('skip')
    expect(planPush([legacy({ failed: true })], 's1')).toBe('skip')
    expect(planPush([legacy({ failed: true, retryable: true })], 's1')).toBe('skip')
    expect(planPush([legacy({ failed: true }), pushed('failed', { retryable: true })], 's1')).toBe(
      'skip',
    )
  })
})

describe('flushNotices over push', () => {
  const run = (outbox: MemoryOutbox, push: ReturnType<typeof memoryPushSender>) =>
    flushNotices(outbox.within, push)

  it('pushes the notice to every subscription, with the notice as the message', async () => {
    const outbox = new MemoryOutbox(sent)
    outbox.subs = [sub('s1'), sub('s2')]
    const push = memoryPushSender()
    expect(await run(outbox, push)).toHaveLength(2)
    expect(push.sent.map((s) => s.subscription.endpoint)).toEqual([
      'https://push.example/s1',
      'https://push.example/s2',
    ])
    expect(push.sent[0]?.payload).toEqual({
      title: 'Transferencia enviada',
      body: '$ 1.500,00 a Juana Ejemplo\nBank ARS · 14/11 14:09',
      tag: 'notice-1',
      url: '/movements',
    })
    expect(outbox.attempts[0]).toMatchObject({
      mode: 'push',
      outcome: 'sent',
      subscriptionId: 's1',
      body: noticeText(sent),
    })
  })

  it('is done after the first sent attempt: a second run sends nothing', async () => {
    const outbox = new MemoryOutbox(sent)
    outbox.subs = [sub('s1')]
    const push = memoryPushSender()
    await run(outbox, push)
    expect(await run(outbox, push)).toHaveLength(0)
    expect(push.sent).toHaveLength(1)
  })

  it('leaves the notice owed with no subscription, and delivers it once there is one', async () => {
    const outbox = new MemoryOutbox(sent)
    const push = memoryPushSender()
    expect(await run(outbox, push)).toHaveLength(0)
    expect(outbox.attempts).toHaveLength(0)
    outbox.subs = [sub('s1')]
    expect(await run(outbox, push)).toHaveLength(1)
  })

  it('deletes a subscription the push service calls gone, and records the attempt', async () => {
    const outbox = new MemoryOutbox(sent)
    outbox.subs = [sub('s1'), sub('s2')]
    const push = memoryPushSender((s) =>
      s.endpoint.endsWith('s1') ? { outcome: 'gone', status: 410 } : { outcome: 'sent' },
    )
    await run(outbox, push)
    expect(outbox.subs.map((s) => s.id)).toEqual(['s2'])
    expect(outbox.attempts[0]).toMatchObject({ outcome: 'gone', status: 410, subscriptionId: 's1' })
    await run(outbox, push)
    expect(push.sent).toHaveLength(2)
  })

  it('retries a temporary failure on the next run, up to four attempts per subscription', async () => {
    const outbox = new MemoryOutbox(sent)
    outbox.subs = [sub('s1')]
    const down = memoryPushSender(() => ({ outcome: 'failed', retryable: true, status: 503 }))
    for (let i = 0; i < 6; i++) await run(outbox, down)
    expect(down.sent).toHaveLength(4)
    outbox.attempts.length = 1
    await run(outbox, memoryPushSender())
    expect(outbox.attempts.at(-1)).toMatchObject({ outcome: 'sent' })
  })

  it('does not retry a final failure', async () => {
    const outbox = new MemoryOutbox(sent)
    outbox.subs = [sub('s1')]
    const refused = memoryPushSender(() => ({ outcome: 'failed', retryable: false, status: 400 }))
    await run(outbox, refused)
    await run(outbox, refused)
    expect(refused.sent).toHaveLength(1)
  })

  it('sends outside any transaction', async () => {
    const outbox = new MemoryOutbox(sent)
    outbox.subs = [sub('s1')]
    const during: boolean[] = []
    const push = memoryPushSender(() => {
      during.push(outbox.inTx)
      return { outcome: 'sent' }
    })
    await run(outbox, push)
    expect(during).toEqual([false])
  })

  it('does not push a notice the former notifier already handled, even to a new subscription', async () => {
    const closed = new MemoryOutbox(sent)
    closed.legacy = [{ mode: 'legacy', failed: true, retryable: false }]
    closed.subs = [sub('s1')]
    const push = memoryPushSender()
    expect(await run(closed, push)).toHaveLength(0)
    expect(push.sent).toHaveLength(0)

    const fresh = new MemoryOutbox(sent)
    fresh.subs = [sub('s1')]
    expect(await run(fresh, push)).toHaveLength(1)
  })
})

describe('sendTestPush', () => {
  const payload = { title: 'Warren', body: 'Prueba', tag: 'test', url: '/movements' }
  it('pushes to every subscription, counts the outcomes and drops the gone ones', async () => {
    const outbox = new MemoryOutbox(sent)
    outbox.subs = [sub('s1'), sub('s2'), sub('s3')]
    const push = memoryPushSender((s) =>
      s.endpoint.endsWith('s1')
        ? { outcome: 'gone', status: 404 }
        : s.endpoint.endsWith('s2')
          ? { outcome: 'failed', retryable: true, status: 500 }
          : { outcome: 'sent' },
    )
    expect(await sendTestPush(outbox.within, push, payload)).toEqual({
      sent: 1,
      gone: 1,
      failed: 1,
    })
    expect(outbox.subs.map((s) => s.id)).toEqual(['s2', 's3'])
    expect(outbox.attempts).toHaveLength(0)
  })
})

describe('allowance line', () => {
  const counted: NoticeMovement = { ...sent, type: 'card_purchase', cardLastFour: '1234' }
  const lastLine = (m: NoticeMovement) => noticeText(m).split('\n').at(-1)

  it('says what is left, in the Spanish month, as the last line', () => {
    const m = { ...counted, allowance: { month: '2026-11', left: '182400.00000000' } }
    expect(lastLine(m)).toBe('Te quedan $ 182.400,00 de tu asignación de noviembre')
    expect(noticeText(m).split('\n')).toHaveLength(noticeText(counted).split('\n').length + 1)
  })

  it('says by how much the person went over, as a positive amount', () => {
    const m = { ...counted, allowance: { month: '2026-01', left: '-500.25000000' } }
    expect(lastLine(m)).toBe('Te pasaste por $ 500,25 en enero')
  })

  it('has no line without a figure, and zero left is still left', () => {
    expect(noticeText({ ...counted, allowance: null })).toBe(noticeText(counted))
    expect(noticeText(counted)).not.toMatch(/asignación|pasaste/)
    expect(lastLine({ ...counted, allowance: { month: '2026-11', left: '0.00000000' } })).toBe(
      'Te quedan $ 0,00 de tu asignación de noviembre',
    )
  })

  it('puts the line in the push body, never the title', () => {
    const p = noticePushPayload(1, {
      ...counted,
      allowance: { month: '2026-11', left: '10.00000000' },
    })
    expect(p.title).toBe('Compra con tarjeta …1234')
    expect(p.body.split('\n').at(-1)).toBe('Te quedan $ 10,00 de tu asignación de noviembre')
  })
})
