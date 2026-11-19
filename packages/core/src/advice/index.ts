import { argentinaDay } from '../time/argentina'
import { factDisplay } from './knowledge/display'
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
export * from './profile'
export { FACTS, PRINCIPLES, TRAPS }

export type FactView = Omit<Fact, 'parts'> & {
  /** `value` and `unit` as shown to the person, e.g. "$ 50.000.000,00 per person". */
  display?: string
  /** `parts`, each with its `display`. */
  parts?: { label: string; value: string; unit: string; display: string }[]
  /** True once `now` is past `review_by`: the value must be checked at its source. */
  stale: boolean
}

/** The facts, optionally of one topic, each marked stale once its `review_by` day is over (Argentine time). */
export function factsFor(now: Date, topic?: Topic): FactView[] {
  const today = argentinaDay(now)
  return FACTS.filter((f) => topic === undefined || f.topic === topic).map(
    ({ parts, ...f }): FactView => {
      return {
        ...f,
        ...(f.value !== undefined && f.unit ? { display: factDisplay(f.value, f.unit) } : {}),
        ...(parts
          ? { parts: parts.map((p) => ({ ...p, display: factDisplay(p.value, p.unit) })) }
          : {}),
        stale: today > f.review_by,
      }
    },
  )
}

/** The principles that apply to a topic, or all of them. */
export function principlesFor(topic?: Topic): Principle[] {
  return topic === undefined
    ? [...PRINCIPLES]
    : PRINCIPLES.filter((p) => p.applies_to.includes(topic))
}
