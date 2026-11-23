import type Anthropic from '@anthropic-ai/sdk'
import { describe, expect, it } from 'vitest'
import { cafe, log, minutes, NOW, newAccount, turn } from '../../test/core'
import { sql, useDatabase } from '../../test/db'
import { message, toolUse } from '../../test/fakes'
import { schemaDir } from '../core/db'
import { commit } from '../core/turn'
import { readState } from './context'
import { understand } from './understand'

useDatabase({ migrations: schemaDir })

/** An Anthropic double that answers each call with the next set of tool calls. */
function model(...turns: [string, unknown][][]) {
  const requests: string[] = []
  let n = 0
  const client = {
    messages: {
      create: async (params: Anthropic.MessageCreateParamsNonStreaming) => {
        requests.push(JSON.stringify(params.messages))
        const t = turns[Math.min(n, turns.length - 1)] ?? []
        n++
        return message(t.map(([name, input], k) => toolUse(`t${n}_${k}`, name, input)))
      },
    },
  } as unknown as Anthropic
  return { client, requests }
}

/** Understands a message and commits what came of it, as a worker will. */
async function say(
  accountId: number,
  text: string,
  client: Anthropic,
  at: Date = NOW,
  o: { voice?: boolean } = {},
) {
  const u = await understand({ sql, client, accountId, text, at, ...o })
  const committed = await commit(sql, {
    accountId,
    channel: 'whatsapp',
    now: at,
    calls: u.calls,
    compose: u.compose,
    scrub: u.redact,
  })
  return { u, committed: committed as NonNullable<typeof committed> }
}

describe('understand, then commit', () => {
  it('logs a movement, and the reply is the code-rendered record', async () => {
    const a = await newAccount(sql)
    const { client } = model([['log_movements', { movements: [cafe({ amount: '2800' })] }]])
    const { committed } = await say(a, 'cafecito 2800', client)
    expect(committed.reply).toBe('✓ Café $2.800')
    expect(committed.record).toBe('✓ Café $2.800')
  })

  it('a question is rendered by code from the movements it names, and its options are stored on the turn', async () => {
    const a = await newAccount(sql)
    await turn(sql, a, [
      log(cafe({ description: 'café' }), cafe({ description: 'súper', amount: '12000' })),
    ])
    const [first, second] = await sql<{ id: number }[]>`
      SELECT entity_id::int AS id FROM movement WHERE account_id = ${a} ORDER BY id`
    const ids = [first?.id, second?.id] as number[]
    const { client } = model([['ask_user', { movement_ids: ids, then: { do: 'delete' } }]])
    const { committed } = await say(a, 'borrá lo del taxi', client, minutes(1))
    expect(committed.reply).toContain('¿Cuál? 1. Súper $12.000 · 2. Café $3.500')
    const [row] = await sql`SELECT question, label FROM turn WHERE id = ${committed.turn}`
    expect(row?.label).toBe('ask')
    expect(row?.question).toEqual({
      options: [
        { n: 1, id: ids[1], v: ids[1] },
        { n: 2, id: ids[0], v: ids[0] },
      ],
      then: { do: 'delete' },
    })
    // The next message sees it as the pending question.
    const read = await readState(sql, a, minutes(2), '2')
    expect(read.open?.question.options).toHaveLength(2)
    const later = await readState(sql, a, minutes(20), '2')
    expect(later.open).toBeNull()
  })

  it('answers a summary with totals the database computed', async () => {
    const a = await newAccount(sql)
    await turn(sql, a, [log(cafe({ amount: '3500' }), cafe({ amount: '1500.50' }))])
    const { client } = model([['summarize', { range: { period: 'today' }, direction: 'out' }]])
    const { committed } = await say(a, 'cuanto gaste hoy', client, minutes(1))
    expect(committed.reply).toContain('$5.000,50')
    expect(committed.record).toBeNull()
  })

  it('a read in the same turn as a write sees the write', async () => {
    const a = await newAccount(sql)
    const { client } = model([
      ['log_movements', { movements: [cafe({ amount: '2800' })] }],
      ['summarize', { range: { period: 'today' }, direction: 'out' }],
      ['remember_fact', { kind: 'alias', key: 'visa', value: 'crédito visa' }],
      ['list_facts', {}],
    ])
    const { committed } = await say(a, 'cafe 2800, cuanto llevo hoy? y acordate de visa', client)
    expect(committed.reply).toContain('✓ Café $2.800')
    expect(committed.reply).toContain('$2.800')
    expect(committed.reply).not.toContain('no encontré gastos')
    expect(committed.reply).toContain('visa')
  })

  it('a reply with a number code did not give is replaced by the apology', async () => {
    const a = await newAccount(sql)
    const { client } = model([['reply', { text: 'Gastaste $99.999' }]])
    const { committed } = await say(a, 'cuanto gaste', client)
    expect(committed.reply).toContain('Eso no te lo sé decir bien')
  })

  it('a secret is declined by code, stored nowhere, and no input is kept on the turn', async () => {
    const a = await newAccount(sql)
    const { client } = model([
      ['remember_fact', { kind: 'note', key: 'clave', value: 'la clave es 1234' }],
    ])
    const { u, committed } = await say(a, 'mi clave del banco es 1234', client)
    expect(u.redact).toBe(true)
    expect(committed.reply).toBe('No guardo claves, números de tarjeta, CBU/CVU ni documentos.')
    const [row] = await sql`SELECT calls FROM turn WHERE id = ${committed.turn}`
    expect(JSON.stringify(row?.calls)).not.toContain('1234')
  })

  it('the conversation comes from the turns of every channel and from reminders that were sent', async () => {
    const a = await newAccount(sql)
    await turn(sql, a, [log(cafe())], { at: minutes(0), channel: 'mcp' })
    await sql`INSERT INTO reminder (account_id, entity_id, what, schedule, next_due_at, made_in, logged_at)
      SELECT ${a}, nextval('reminder_entity_seq'), 'pagar la Visa', '{"start":"2026-11-20","time":"09:00","interval":1}'::jsonb, NULL,
        (SELECT id FROM turn WHERE account_id = ${a}), ${NOW}`
    await sql`INSERT INTO reminder_send (account_id, reminder_entity_id, due_at, kind, started_at, status)
      SELECT ${a}, entity_id, ${minutes(5)}, 'text', ${minutes(5)}, 'sent' FROM reminder WHERE account_id = ${a}`
    const read = await readState(sql, a, minutes(8), 'cancelá este')
    expect(read.conversation.map((t) => [t.source, t.reply, t.minutesAgo])).toEqual([
      ['mcp', '✓ Café $3.500', 8],
      ['reminder', '⏰ Recordatorio: pagar la Visa', 3],
    ])
  })

  it('a voice note starts its reply with what was heard when nothing changed', async () => {
    const a = await newAccount(sql)
    const { client } = model([['help', {}]])
    const { committed } = await say(a, 'hola que tal', client, NOW, { voice: true })
    expect(committed.reply.startsWith('🎙️ "hola que tal"\n')).toBe(true)
  })
})
