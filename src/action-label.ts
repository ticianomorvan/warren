import type { Action } from './agent'

/** The label `inbound_message.action` and the latency report use: one tool, or `multi`. */
export function actionLabel(actions: Action[]): string {
  const [only] = actions
  if (!only || actions.length > 1) return 'multi'
  const label = {
    log_movements: 'log',
    correct_movement: 'correct',
    delete_movement: 'delete',
    undo_last: 'undo',
    remember_fact: 'remember',
    forget_fact: 'forget',
    forget_all_facts: 'forget',
    forget_all_confirmed: 'forget',
    link_ask: 'link',
    link_confirm: 'link',
    link_decline: 'link',
    mcp_disconnect: 'disconnect',
    list_facts: 'reply',
    set_reminder: 'remind',
    cancel_reminder: 'remind',
    cancel_all_reminders: 'remind',
    list_reminders: 'reply',
    summarize: 'summarize',
    ask_user: 'ask',
    reply: 'reply',
    help: 'reply',
    notice: 'reply',
  } as const
  return label[only.tool]
}
