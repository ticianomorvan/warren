import { createHash, randomUUID } from 'node:crypto'
import { actionLabel } from '../action-label'
import type { AuditEntry } from '../agent/loop'
import { MAX_FACTS, sensitive } from '../agent/memory'
import { applyCall, type Outcome, type WriteCall } from '../apply'
import type { Sql } from '../db'
import type { FactRow } from '../facts'
import { type MovementRow, newestLiveId, rowsByIds, settleBatchRow } from '../ledger'
import { REDACTED_BODY, scrubAudit, scrubCalls } from '../redact'
import {
  renderCorrection,
  renderDeletion,
  renderForgot,
  renderKnown,
  renderLog,
  renderRemembered,
  renderUnchanged,
  renderUndo,
  undoLine,
} from '../render'
import { UNDO_WINDOW_HOURS, undoDetail } from '../undo'

/** What the client is told about how to take a change back. */
export const UNDO_HINT =
  'To revert this, call warren_undo_last (or send "deshacer" to Warren on WhatsApp): it takes back the newest change of either channel.'

export interface WriteRequest {
  sql: Sql
  /** The person: from the door, never from the call. */
  accountId: number
  /** Their WhatsApp id: the row of the batch carries it, so an undo from either channel finds the batch. */
  waId: string
  /** The Argentine day. */
  today: string
  /** The client's own id for this call: a retry of the same call gets the same answer and writes nothing twice. */
  requestId?: string | undefined
  /** A validated call (`checkInput`). */
  call: WriteCall
}

type View = Record<string, unknown>

/** What a write came to, for the client. */
export type Written =
  | {
      ok: true
      /** True when this is the answer to an earlier request with the same id: nothing was written now. */
      replayed: boolean
      output: View
    }
  /** The call was refused (or changed nothing worth a batch) and nothing was written. `reason` is compact, for the client agent. */
  | { ok: false; reason: string }

const fact = (f: FactRow) => ({ id: f.id, kind: f.kind, key: f.key, value: f.value })

/** Every string a call carries: what the secret rule reads. */
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(strings)
  if (value && typeof value === 'object') return Object.values(value).flatMap(strings)
  return []
}

/** JSON with the keys of every object in order: the same call always writes the same text. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/** What identifies a call: its tool and its checked input. A request id may only ever stand for one of these. */
const callHash = (call: WriteCall) =>
  createHash('sha256')
    .update(stable({ tool: call.tool, input: call.input }))
    .digest('hex')

/** Thrown inside the transaction to undo the batch row of a call that changed nothing. */
class NothingChanged extends Error {
  constructor(readonly written: Written) {
    super('nothing changed')
  }
}

/** A movement as the client sees it: the row, with its amount as Warren shows it. */
export type PresentMovement = (m: MovementRow) => Record<string, unknown>

interface Presented {
  written: Written
  /** The line code renders for this change: stored as the batch's reply. */
  record: string
  /** Whether a batch was made (something was written). */
  changed: boolean
  /** The outcome in one word, for the audit. */
  status: string
  detail?: string | undefined
}

const refuse = (reason: string): Presented => ({
  written: { ok: false, reason },
  record: reason,
  changed: false,
  status: 'refused',
})

/**
 * One MCP write (docs/mcp-spec.md, Design 4): a settled `inbound_message` row for the batch (`channel = 'mcp'`, `wamid =
 * 'mcp:<request id>'`, the account's wa_id) and `applyCall`, in one transaction, so a movement or fact row has a batch to point
 * at and an undo from either channel sees it unchanged. A call that changes nothing (a refusal, a no-op) leaves no row behind. A
 * request id seen before returns the first answer (for the same call only: the same tool and checked input) and writes nothing.
 * The same secret rule as a WhatsApp message's: a call that holds a secret keeps no raw inputs (its stored command, its audit and
 * its body are scrubbed). The rendered record in `reply_text` and the result in `payload` stay, as the reply and the movement row do.
 */
export async function writeAsMcp(r: WriteRequest, present: PresentMovement): Promise<Written> {
  const wamid = `mcp:${r.requestId ?? randomUUID()}`
  const label = actionLabel([r.call])
  const redact = sensitive(strings(r.call.input).join(' '))
  try {
    return await r.sql.begin(async (raw) => {
      const tx = raw as unknown as Sql
      const [row] = await tx<{ id: number }[]>`
        INSERT INTO inbound_message (wamid, wa_id, kind, payload, status, channel)
        VALUES (${wamid}, ${r.waId}, 'tool', '{}'::jsonb, 'done', 'mcp')
        ON CONFLICT (wamid) DO NOTHING
        RETURNING id::int AS id`
      if (!row) return replay(tx, wamid, r)
      const newest = await newestLiveId(tx, r.accountId)
      const outcome = await applyCall(tx, { accountId: r.accountId, batchId: row.id }, r.call)
      const p = await presentOutcome(tx, r, outcome, row.id, newest, present)
      if (!p.changed) throw new NothingChanged(p.written)
      if (!p.written.ok) throw new Error('a refusal never makes a batch')
      const audit: AuditEntry[] = [
        {
          turn: 0,
          tool: r.call.tool,
          input: r.call.input,
          status: p.status,
          ...(p.detail ? { detail: p.detail } : {}),
          ms: 0,
          action: 0,
        },
      ]
      await settleBatchRow(tx, row.id, {
        action: label,
        replyText: p.record,
        command: redact ? scrubCalls([r.call]) : [r.call],
        toolCalls: redact ? scrubAudit(audit) : audit,
        payload: { tool: r.call.tool, input_hash: callHash(r.call), result: p.written.output },
        body: redact ? REDACTED_BODY : null,
      })
      return p.written
    })
  } catch (error) {
    if (error instanceof NothingChanged) return error.written
    throw error
  }
}

/** The first answer to a request id, when the call is the same one: the same person, the same tool, the same checked input. */
async function replay(tx: Sql, wamid: string, r: WriteRequest): Promise<Written> {
  const [prior] = await tx<
    { wa_id: string; payload: { tool?: string; input_hash?: string; result?: View } }[]
  >`SELECT wa_id, payload FROM inbound_message WHERE wamid = ${wamid}`
  if (
    !prior ||
    prior.wa_id !== r.waId ||
    prior.payload.tool !== r.call.tool ||
    prior.payload.input_hash !== callHash(r.call) ||
    !prior.payload.result
  ) {
    // Another person's id, another tool's, the same tool with other values, or a request that never wrote: never an answer
    // made of someone else's data, and never the answer to a different question.
    return {
      ok: false,
      reason: 'request_id was already used for a different call: send a new one.',
    }
  }
  return { ok: true, replayed: true, output: prior.payload.result }
}

async function presentOutcome(
  tx: Sql,
  r: WriteRequest,
  outcome: Outcome,
  batch: number,
  newest: number | null,
  show: PresentMovement,
): Promise<Presented> {
  const { today } = r
  const done = (output: View, record: string, status: string, detail?: string): Presented => ({
    written: { ok: true, replayed: false, output: { batch, ...output, record, undo: UNDO_HINT } },
    record,
    changed: true,
    status,
    detail,
  })
  switch (outcome.tool) {
    case 'log_movements': {
      const rows = await rowsByIds(tx, r.accountId, outcome.ids)
      return done({ movements: rows.map(show) }, renderLog(outcome.movements, today), 'applied')
    }
    case 'correct_movement': {
      if (outcome.kind === 'gone') return refuse(gone(outcome.id))
      if (outcome.kind === 'unchanged') {
        const record = renderUnchanged(outcome.old, today)
        return {
          written: {
            ok: true,
            replayed: false,
            output: {
              batch: null,
              record,
              undo: null,
              changed: [],
              before: show(outcome.old),
              after: show(outcome.old),
            },
          },
          record,
          changed: false,
          status: 'unchanged',
        }
      }
      const [after] = await rowsByIds(tx, r.accountId, [outcome.id])
      return done(
        {
          changed: outcome.changed,
          before: show(outcome.old),
          after: after ? show(after) : show(outcome.old),
        },
        renderCorrection(
          outcome.old,
          outcome.next,
          outcome.changed,
          today,
          outcome.old.id === newest,
        ),
        'applied',
      )
    }
    case 'delete_movement': {
      if (outcome.kind === 'gone') return refuse(gone(outcome.id))
      return done(
        { deleted: show(outcome.old) },
        renderDeletion(outcome.old, today, outcome.old.id === newest),
        'applied',
      )
    }
    case 'undo_last': {
      const u = outcome.undo
      if (u.kind === 'nothing') return refuse('There is nothing to undo.')
      if (u.kind === 'expired') {
        return refuse(
          `The last change was made more than ${UNDO_WINDOW_HOURS} hours ago and is not undone from here. Correct or delete what you need with the other tools.`,
        )
      }
      if (u.kind === 'whatsapp_only') {
        return refuse(
          'Nothing was undone: that batch set or cancelled reminders, which only the person undoes, from WhatsApp ("deshacer").',
        )
      }
      if (u.kind === 'stale') {
        const ids = [
          ...u.moved.map((m) => `movement ${m.id}`),
          ...u.facts.map((f) => `fact ${f.id}`),
        ]
        return refuse(
          `Nothing was undone: ${ids.join(', ')} changed after that batch (corrected or deleted since). Look at the current state and change it directly.`,
        )
      }
      const items = u.items.map((item) => {
        if (item.kind === 'corrected') {
          return { kind: item.kind, movement: show(item.to), from: show(item.from) }
        }
        if ('movement' in item) return { kind: item.kind, movement: show(item.movement) }
        // Reminders are undone from WhatsApp only (`whatsapp_only`), so no item of an MCP undo is one.
        if ('reminder' in item) throw new Error('an MCP undo never holds a reminder')
        return {
          kind: item.kind,
          fact: fact(item.fact),
          ...(item.kind === 'fact_reverted' ? { was: item.was } : {}),
        }
      })
      return done(
        { undone_batch: u.batch, items },
        renderUndo(u.items.map(undoLine), today),
        'applied',
        undoDetail(u),
      )
    }
    case 'remember_fact': {
      const s = outcome.stored
      if (s.kind === 'full') {
        return refuse(
          `Warren already remembers ${MAX_FACTS} things about this person: forget one first.`,
        )
      }
      if (s.kind === 'unchanged') {
        const record = renderKnown(s.fact)
        return {
          written: {
            ok: true,
            replayed: false,
            output: {
              batch: null,
              record,
              undo: null,
              status: 'unchanged',
              fact: fact(s.fact),
              previous_value: null,
            },
          },
          record,
          changed: false,
          status: 'unchanged',
        }
      }
      return done(
        {
          status: s.kind,
          fact: fact(s.fact),
          previous_value: s.kind === 'updated' ? s.before : null,
        },
        renderRemembered(s.fact, s.kind === 'updated' ? s.before : undefined),
        'applied',
        `${s.kind}: ${s.fact.kind} ${s.fact.key}`,
      )
    }
    case 'forget_fact': {
      if (outcome.gone.length === 0) {
        return refuse(
          outcome.id > 0
            ? `Fact ${outcome.id} was not found, or was already forgotten. List what Warren remembers with warren_list_facts.`
            : `Warren has nothing remembered under "${outcome.key}".`,
        )
      }
      return done(
        { forgotten: outcome.gone.map(fact) },
        outcome.gone.map(renderForgot).join('\n'),
        'applied',
      )
    }
  }
}

const gone = (id: number) =>
  `Movement ${id} was not found, or was already corrected or deleted. Look it up again with warren_find_movements.`
