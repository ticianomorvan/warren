import { describe, expect, it } from 'vitest'
import { eventId, type MovementSource, matchMovement, mergeSources } from '../src/ledger'
import type { BankOperation } from '../src/mail/parse'
import { CBU, CUIT, fakeCbu } from './fixtures'

const sent: BankOperation = {
  kind: 'transfer_out',
  amount: '3.77',
  currency: 'ARS',
  date: '2026-11-14',
  time: '14:09',
  ownAccount: null,
  counterparty: { name: 'Juana Ejemplo', account: CBU, taxId: CUIT },
  reference: '1017000001',
  reason: 'VARIOS',
}
const debited: BankOperation = {
  ...sent,
  time: null,
  ownAccount: 'CA-ARS ***123/4',
  counterparty: { name: null, account: CBU, taxId: CUIT },
  reference: null,
  reason: null,
}
const src = (mailSha256: string, templateId: string, operation: BankOperation): MovementSource => ({
  mailSha256,
  templateId,
  operation,
})
const SENT = 'bbva.transfer-sent'
const DEBITED = 'bbva.transfer-debited'

describe('matchMovement', () => {
  it('joins the debit notice to the movement its "sent" mail created', () => {
    const candidates = [{ movementId: 'm1', sources: [src('a', SENT, sent)] }]
    expect(matchMovement({ templateId: DEBITED, operation: debited }, candidates)).toBe('m1')
  })
  it('works in either arrival order', () => {
    const candidates = [{ movementId: 'm1', sources: [src('b', DEBITED, debited)] }]
    expect(matchMovement({ templateId: SENT, operation: sent }, candidates)).toBe('m1')
  })
  it('keeps two equal transfers on one day as two movements, pairing oldest first', () => {
    const first = { movementId: 'm1', sources: [src('a', SENT, sent)] }
    const second = {
      movementId: 'm2',
      sources: [src('c', SENT, { ...sent, time: '15:30', reference: '1017000002' })],
    }
    expect(matchMovement({ templateId: SENT, operation: sent }, [first])).toBeNull()
    expect(matchMovement({ templateId: DEBITED, operation: debited }, [first, second])).toBe('m1')
    const paired = { ...first, sources: [...first.sources, src('b', DEBITED, debited)] }
    expect(matchMovement({ templateId: DEBITED, operation: debited }, [paired, second])).toBe('m2')
  })
  it('does not join operations that differ in counterparty or reference', () => {
    const candidates = [{ movementId: 'm1', sources: [src('a', SENT, sent)] }]
    const elsewhere = {
      ...debited,
      counterparty: { name: null, account: fakeCbu('0720099'), taxId: '20999999990' },
    }
    expect(matchMovement({ templateId: DEBITED, operation: elsewhere }, candidates)).toBeNull()
    const otherRef = { ...debited, reference: '999' }
    expect(matchMovement({ templateId: DEBITED, operation: otherRef }, candidates)).toBeNull()
  })
})

describe('mergeSources', () => {
  it('fills each field from the first source that states it', () => {
    expect(mergeSources([src('a', SENT, sent), src('b', DEBITED, debited)])).toEqual({
      ...sent,
      ownAccount: 'CA-ARS ***123/4',
    })
  })
})

describe('eventId', () => {
  it('is a stable, well-formed UUID per kind and key', () => {
    const id = eventId('movement', 'abc')
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(eventId('movement', 'abc')).toBe(id)
    expect(eventId('link', 'abc')).not.toBe(id)
  })
})
