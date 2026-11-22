/**
 * A handful of real messages through `understand` on the new tool shapes, on an in-process database: prints the calls and the reply
 * of each. A check that the prompt and the schemas work together before the scenario eval runs.
 *   node --env-file=.env --import tsx evals/agent-smoke.ts [message...]
 */
import Anthropic from '@anthropic-ai/sdk'
import { estimateCostUsd } from '../src/agent/models'
import { understand } from '../src/agent/understand'
import { schemaDir } from '../src/core/db'
import { commit } from '../src/core/turn'
import { cafe, log, NOW, newAccount, turn } from '../test/core'
import { createTestDatabase } from '../test/db'

const { sql, close } = await createTestDatabase({ migrations: schemaDir })
const client = new Anthropic()
const account = await newAccount(sql)
await turn(sql, account, [
  log(
    cafe({ amount: '2900' }),
    cafe({ description: 'súper', category: 'supermercado', amount: '15400' }),
  ),
])
const given = process.argv.slice(2)
const messages = given.length
  ? given
  : [
      'super 12.000 con la visa y 4.500 de farmacia',
      'uy no, el cafe fueron 4200',
      'cuanto gaste este mes en comida?',
      'este mes vs septiembre',
      'del 3 al 10 de octubre por tarjeta',
      'recordame pagar la visa el 10',
      'en 20 minutos recordame sacar la ropa',
      'borrá lo del taxi',
      'borrá el alquiler y el cafe fue 3000',
      'olvidate de lo de la visa',
      'cuanto sale el dolar',
    ]
let cost = 0
let at = NOW
for (const text of messages) {
  at = new Date(at.getTime() + 60_000)
  const u = await understand({ sql, client, accountId: account, text, at })
  const c = await commit(sql, {
    accountId: account,
    channel: 'whatsapp',
    now: at,
    calls: u.calls,
    compose: u.compose,
  })
  cost += estimateCostUsd('haiku', u.usage)
  const calls = u.calls.map((x) => `${x.tool} ${JSON.stringify(x.input)}`).join(' | ')
  const notes = u.audit
    .filter((a) => a.status !== 'accepted' && a.status !== 'ok')
    .map((a) => `${a.tool}:${a.status}:${a.detail ?? ''}`)
    .join(', ')
  console.log(
    `> ${text}\n  turns ${u.turns}, ${Math.round(u.ms)} ms: ${calls}${u.declined.length ? ` declined ${u.declined}` : ''}\n  ${c?.reply.replaceAll('\n', '\n  ')}\n  audit: ${notes}`,
  )
}
console.log(`cost US$${cost.toFixed(4)}`)
await close()
