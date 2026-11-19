import { FACTS } from './knowledge/facts'
import { PRINCIPLES } from './knowledge/principles'
import { TRAPS } from './knowledge/traps'
import type { Fact, Principle, Topic, Trap } from './knowledge/types'

export {
  type Fact,
  PROFESSIONALS,
  type Principle,
  type Professional,
  TOPICS,
  type Topic,
  type Trap,
} from './knowledge/types'
export { DENYLIST, policyViolations } from './policy'
export { FACTS, PRINCIPLES, TRAPS }

export type FactView = Fact & {
  /** True once `now` is past `review_by`: the value must be checked at its source. */
  stale: boolean
}

/** The ledger's days are Argentine days, so a fact is stale by the date there, not in UTC. */
const argentinaDay = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Argentina/Buenos_Aires',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

/** The facts, optionally of one topic, each marked stale once its `review_by` day is over (Argentine time). */
export function factsFor(now: Date, topic?: Topic): FactView[] {
  const today = argentinaDay.format(now)
  return FACTS.filter((f) => topic === undefined || f.topic === topic).map((f) => ({
    ...f,
    stale: today > f.review_by,
  }))
}

/** The principles that apply to a topic, or all of them. */
export function principlesFor(topic?: Topic): Principle[] {
  return topic === undefined
    ? [...PRINCIPLES]
    : PRINCIPLES.filter((p) => p.applies_to.includes(topic))
}
