export type StepState = 'done' | 'current' | 'todo'

/**
 * The state of the six steps. Step 1 is done once Google's request or a mailbox exists. Step 2 is
 * done once a mailbox exists, or once a pending Gmail's link was opened (`opened`, which only the
 * browser knows). Step 3 is done with the mailbox; 4 and 5 once a verified mail arrived; 6 has no
 * data of its own and is never done. The first step not done is current and the rest wait.
 */
export function stepStates(p: {
  hasConfirmation: boolean
  hasMailbox: boolean
  verified: boolean
  opened: boolean
}): StepState[] {
  const done = [
    p.hasConfirmation || p.hasMailbox,
    p.hasMailbox || (p.hasConfirmation && p.opened),
    p.hasMailbox,
    p.verified,
    p.verified,
    false,
  ]
  const current = done.indexOf(false)
  return done.map((d, i) => (d ? 'done' : i === current ? 'current' : 'todo'))
}
