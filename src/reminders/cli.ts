import { join } from 'node:path'
import { reminderTemplate } from '../config'
import { connect } from '../core/db'
import { createGraph } from '../whatsapp/graph'
import { insertReminder, TEMPLATE_LANGUAGE } from './db'
import { ScheduleSchema } from './schedule'

/**
 * Dev scripts for the reminders (docs/reminders-spec.md, slice 6.1). Secrets come from the gitignored `.env`
 * and are never printed.
 *   pnpm template:status [name]              the template's category and status at Meta (read only); REMINDER_TEMPLATE unless a name is given
 *   pnpm reminder:try-template <wa_id>        sends the template once to that number (a real message)
 *   pnpm reminder:add <wa_id> "<what>" <yyyy-mm-ddThh:mm>   a one-off reminder at that Argentine local time;
 *                                             the running server's tick sends it. No model is involved.
 */
try {
  process.loadEnvFile(join(import.meta.dirname, '..', '..', '.env'))
} catch {}

const need = (name: string): string => {
  const value = process.env[name]?.trim()
  if (!value) {
    console.error(`Set ${name} (in .env or the environment).`)
    process.exit(1)
  }
  return value
}
/** The template's name, read the way the server reads it (`REMINDER_TEMPLATE`), or the one given as an argument. */
function templateName(arg?: string): string {
  const name = reminderTemplate.parse(arg ?? process.env.REMINDER_TEMPLATE)
  if (!name) {
    console.error('Set REMINDER_TEMPLATE (in .env or the environment).')
    process.exit(1)
  }
  return name
}

async function templateStatus(arg?: string) {
  const name = templateName(arg)
  const url = new URL(
    `https://graph.facebook.com/${need('GRAPH_API_VERSION')}/${need('WHATSAPP_BUSINESS_ACCOUNT_ID')}/message_templates`,
  )
  url.searchParams.set('name', name)
  url.searchParams.set('fields', 'name,category,status')
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${need('WHATSAPP_ACCESS_TOKEN')}` },
  })
  if (!res.ok) {
    console.error(`Graph API ${res.status}`)
    process.exit(1)
  }
  const { data } = (await res.json()) as {
    data?: { name?: string; category?: string; status?: string }[]
  }
  if (!data?.length) console.log(`${name}: not found`)
  for (const t of data ?? []) console.log(`${t.name} category=${t.category} status=${t.status}`)
}

async function tryTemplate(waId: string | undefined) {
  if (!waId || !/^\d{8,15}$/.test(waId)) {
    console.error('Usage: pnpm reminder:try-template <wa_id, digits only>')
    process.exit(1)
  }
  const graph = createGraph({
    version: need('GRAPH_API_VERSION'),
    phoneNumberId: need('WHATSAPP_PHONE_NUMBER_ID'),
    token: need('WHATSAPP_ACCESS_TOKEN'),
  })
  const wamid = await graph.sendTemplate(waId, templateName(), TEMPLATE_LANGUAGE, [
    'probando los recordatorios de Warren',
  ])
  console.log(`sent ${wamid}`)
}

async function add(waId: string | undefined, what: string | undefined, local: string | undefined) {
  const at = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})$/.exec(local ?? '')
  if (!waId || !what || !at) {
    console.error('Usage: pnpm reminder:add <wa_id> "<what>" <yyyy-mm-ddThh:mm, Argentine time>')
    process.exit(1)
  }
  const sql = connect(need('DATABASE_URL'), { max: 1 })
  try {
    const [account] = await sql<
      { id: number }[]
    >`SELECT id::int AS id FROM account WHERE wa_id = ${waId}`
    if (!account) {
      console.error('No account for that wa_id: it has to have written to Warren once.')
      process.exit(1)
    }
    const schedule = ScheduleSchema.parse({ start: at[1], time: at[2] })
    const { id, nextDueAt } = await insertReminder(sql, {
      accountId: account.id,
      what,
      schedule,
      now: new Date(),
    })
    console.log(`reminder ${id} due ${nextDueAt?.toISOString()}`)
  } finally {
    await sql.end({ timeout: 5 })
  }
}

const [command, ...args] = process.argv.slice(2)
if (command === 'template-status') await templateStatus(args[0])
else if (command === 'try-template') await tryTemplate(args[0])
else if (command === 'add') await add(args[0], args[1], args[2])
else {
  console.error('Usage: template-status | try-template <wa_id> | add <wa_id> "<what>" <datetime>')
  process.exit(1)
}
