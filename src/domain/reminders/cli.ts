import { join } from 'node:path'
import { reminderTemplate } from '../../config'
import { createGraph, TEMPLATE_LANGUAGE } from '../../whatsapp/graph'

/**
 * Ops scripts for the reminder template (docs/reminders-spec.md). Secrets come from the gitignored `.env` and are never printed.
 *   pnpm template:status [name]          the template's category and status at Meta (read only); REMINDER_TEMPLATE unless a name is given
 *   pnpm reminder:try-template <wa_id>   sends the template once to that number (a real message)
 * `reminder:add` (a v1 testing aid that inserted a reminder by hand) is gone: a reminder is set through a turn like any other.
 */
try {
  process.loadEnvFile(join(import.meta.dirname, '..', '..', '..', '.env'))
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

const [command, ...args] = process.argv.slice(2)
if (command === 'template-status') await templateStatus(args[0])
else if (command === 'try-template') await tryTemplate(args[0])
else {
  console.error('Usage: template-status [name] | try-template <wa_id>')
  process.exit(1)
}
