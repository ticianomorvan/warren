import { Client, fromJsonSchema, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import type { Profile } from '@warren/core'
import { appendProfile, asUser, schema } from '@warren/db'
import { beforeAll, describe, expect, it } from 'vitest'
import { LEDGER_READ_SCOPE, PROFILE_READ_SCOPE } from '../lib/auth-config'
import { t as strings } from '../lib/strings'
import { callMcp, connect, mcp, RESOURCE, setup, signedInUser, t } from './harness'

const BOTH = `${LEDGER_READ_SCOPE} ${PROFILE_READ_SCOPE} offline_access`

type Tokens = { id: string; withProfile: string }
let a: Tokens
let b: Tokens
/** Holds only ledger:read: a client the person never gave the profile to. */
let ledgerOnly: string

const client = async (bearer: string) => {
  const c = new Client({ name: 'test', version: '0' })
  await c.connect(
    new StreamableHTTPClientTransport(new URL(RESOURCE), {
      requestInit: { headers: { authorization: `Bearer ${bearer}` } },
      fetch: async (input, init) => mcp(new Request(input as RequestInfo | URL, init)),
    }),
  )
  return c
}

const profile = (income: string, goal = 'Viaje'): Profile => ({
  monthly_income: income,
  currency: 'ARS',
  goals: [{ name: goal, target: '3000.50', currency: 'USD', date: '2027-12-31' }],
  obligations: [{ name: 'Alquiler', amount: '600000', currency: 'ARS', due_day: 5 }],
  risk_limits: { emergency_months: 6, max_share_in_usd: 40 },
})
const save = (id: string, p: Profile) => asUser(t.app, id, (s) => appendProfile(s, p))

type Out = {
  profile:
    | (Omit<Profile, 'goals' | 'obligations'> & {
        version: number
        saved_at: string
        saved_at_local: string
        monthly_income_display?: string
        goals: (Profile['goals'][number] & { display: string })[]
        obligations: (Profile['obligations'][number] & { display: string })[]
      })
    | null
}
const get = async (token: string) => {
  const res = await (await client(token)).callTool({ name: 'profile_get', arguments: {} })
  return res as typeof res & { structuredContent?: Out }
}

beforeAll(async () => {
  await setup(() => new Date('2026-11-19T15:30:00.000Z'))
  const make = async (): Promise<Tokens> => {
    const u = await signedInUser()
    return {
      id: u.id,
      withProfile: (await connect(u, { scope: BOTH })).access_token,
    }
  }
  a = await make()
  b = await make()
  ledgerOnly = (await connect(await signedInUser())).access_token
})

describe('profile_get and its scope', () => {
  it('is listed only for a token that holds profile:read', async () => {
    const withScope = (await (await client(a.withProfile)).listTools()).tools.map((x) => x.name)
    expect(withScope).toEqual([
      'ledger_list_movements',
      'ledger_summarize',
      'knowledge_list_principles',
      'knowledge_list_facts',
      'profile_get',
    ])
    const without = (await (await client(ledgerOnly)).listTools()).tools.map((x) => x.name)
    expect(without).not.toContain('profile_get')
    expect(without).toHaveLength(4)
  })

  it('refuses to call it without the scope', async () => {
    const raw = await callMcp(ledgerOnly, {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'profile_get', arguments: {} },
    })
    expect(await raw.text()).toMatch(/not found|unknown|-32602/i)
  })

  it('is read-only, says what it returns, and has an output schema', async () => {
    const tool = (await (await client(a.withProfile)).listTools()).tools.find(
      (x) => x.name === 'profile_get',
    )
    expect(tool?.annotations).toMatchObject({
      readOnlyHint: true,
      openWorldHint: false,
      idempotentHint: true,
    })
    expect(tool?.description).toMatch(/^Returns the user's latest financial profile/)
    expect(tool?.outputSchema).toBeTruthy()
  })

  it('returns null before anything is saved', async () => {
    const res = await get(a.withProfile)
    expect(res.isError).toBeFalsy()
    expect(res.structuredContent).toEqual({ profile: null })
  })

  it('returns the latest of two saves, validated against the declared schema', async () => {
    await save(a.id, profile('100.00'))
    await save(a.id, profile('250000.50', 'Auto'))
    const res = await get(a.withProfile)
    const p = res.structuredContent?.profile
    expect(p).toMatchObject({
      version: 2,
      monthly_income: '250000.50',
      monthly_income_display: '$ 250.000,50',
      currency: 'ARS',
      goals: [
        {
          name: 'Auto',
          target: '3000.50',
          currency: 'USD',
          display: 'US$ 3.000,50',
          date: '2027-12-31',
        },
      ],
      obligations: [
        {
          name: 'Alquiler',
          amount: '600000',
          currency: 'ARS',
          display: '$ 600.000,00',
          due_day: 5,
        },
      ],
      risk_limits: { emergency_months: 6, max_share_in_usd: 40 },
    })
    expect(Object.keys(res.structuredContent?.profile ?? {}).sort()).toEqual([
      'currency',
      'goals',
      'monthly_income',
      'monthly_income_display',
      'obligations',
      'risk_limits',
      'saved_at',
      'saved_at_local',
      'version',
    ])
    expect(Object.keys(p?.goals[0] ?? {}).sort()).toEqual([
      'currency',
      'date',
      'display',
      'name',
      'target',
    ])
    expect(Object.keys(p?.obligations[0] ?? {}).sort()).toEqual([
      'amount',
      'currency',
      'display',
      'due_day',
      'name',
    ])
    // Argentina is UTC-3 all year.
    const saved = new Date(p?.saved_at ?? '')
    expect(p?.saved_at_local).toBe(
      new Date(saved.getTime() - 3 * 3_600_000).toISOString().slice(0, 16).replace('T', ' '),
    )
    const { tools } = await (await client(a.withProfile)).listTools()
    const declared = fromJsonSchema<unknown>(
      tools.find((x) => x.name === 'profile_get')?.outputSchema as never,
    )
    const issues = (v: unknown) =>
      (declared['~standard'].validate(v) as { issues?: unknown[] }).issues
    expect(issues(res.structuredContent)).toBeUndefined()
    expect(issues({ profile: { nope: 1 } })).toBeTruthy()
  })

  it('says so, with a strict output, when the stored profile no longer validates', async () => {
    const u = await signedInUser()
    const token = (await connect(u, { scope: BOTH })).access_token
    // Written as a row that fails today's rules (the aad is the one `appendProfile` uses).
    await asUser(t.app, u.id, (s) =>
      s.tx.insert(schema.profile).values({
        version: 1,
        data: s.json.seal({ currency: 'EUR', goals: [] }, 'profile:1:data'),
      }),
    )
    const res = await get(token)
    expect(res.isError).toBeFalsy()
    expect(res.structuredContent).toEqual({ profile: null, stored_profile_invalid: true })
    const { tools } = await (await client(token)).listTools()
    const declared = fromJsonSchema<unknown>(
      tools.find((x) => x.name === 'profile_get')?.outputSchema as never,
    )
    const bad = (v: unknown) => (declared['~standard'].validate(v) as { issues?: unknown[] }).issues
    expect(bad(res.structuredContent)).toBeUndefined()
    expect(bad({ profile: null, stored_profile_invalid: 'yes' })).toBeTruthy()
    expect(bad({ profile: null, extra: 1 })).toBeTruthy()
    // A save puts things right.
    await save(u.id, profile('9.00'))
    expect((await get(token)).structuredContent?.profile?.monthly_income).toBe('9.00')
  })

  it("never shows one user's profile to another's token", async () => {
    expect((await get(b.withProfile)).structuredContent).toEqual({ profile: null })
    await save(b.id, profile('7.00', 'Mía'))
    const mine = (await get(b.withProfile)).structuredContent?.profile
    expect(mine?.goals[0]?.name).toBe('Mía')
    expect(JSON.stringify((await get(b.withProfile)).content)).not.toContain('Auto')
    expect((await get(a.withProfile)).structuredContent?.profile?.goals[0]?.name).toBe('Auto')
  })
})

describe('consent', () => {
  it('has a line for the profile scope, and the signed link carries it when asked', async () => {
    expect(strings.consent.scopes[PROFILE_READ_SCOPE]).toBe('leer tu perfil financiero')
    expect(strings.consent.scopes[LEDGER_READ_SCOPE]).toBe('leer tus movimientos')
    const { authorizeAndConsent } = await import('./harness')
    const user = await signedInUser()
    const { location } = await authorizeAndConsent(user.cookie, { scope: BOTH })
    expect(location.pathname).toBe('/oauth/consent')
    expect(location.searchParams.get('scope')?.split(' ')).toContain(PROFILE_READ_SCOPE)
  })
})
