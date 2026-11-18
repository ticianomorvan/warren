import { errorTag } from '@warren/core'
import { sql } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { asUser } from '../src/client'
import { testDatabase } from './helpers'

let t: Awaited<ReturnType<typeof testDatabase>>
let a: string

beforeAll(async () => {
  t = await testDatabase()
  a = await t.newUser('a')
})

// Rule 3: a failed query's message carries its bound parameters, so logs get errorTag only.
describe('errorTag', () => {
  it("keeps a failed query's parameters out, and keeps its class and SQLSTATE", async () => {
    const secret = 'counterparty-cbu-0170099220000012345670'
    const error = await asUser(t.app, a, (scope) =>
      scope.tx.execute(sql`select ${secret}::int`),
    ).catch((e: unknown) => e)
    expect(error instanceof Error && error.message).toContain(secret)
    const tag = errorTag(error)
    expect(tag).not.toContain(secret)
    expect(tag).toMatch(/^\w+ 22P02$/)
  })

  it('says only "unknown error" for a thrown non-error, and drops a code that is not a SQLSTATE', () => {
    expect(errorTag('ticiano@example.com')).toBe('unknown error')
    expect(errorTag(Object.assign(new TypeError('x'), { code: 'ticiano@example.com' }))).toBe(
      'TypeError',
    )
  })
})
