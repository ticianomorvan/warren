import type { Changes as AgentChanges, Category, Movement, Period } from '../src/agent'

/**
 * The shape the single-message eval cases (`cases.jsonl`) are written in: one command per message,
 * as the old parser returned it. The agent has no such type any more; `evals/agent.ts` maps what
 * the agent did into it, so the same cases keep grading logging and query extraction.
 */
export type Changes = { [K in keyof Required<AgentChanges>]: NonNullable<AgentChanges[K]> | null }

export type Command =
  | { type: 'log'; movements: Movement[] }
  | {
      type: 'correct'
      target: string
      target_index: number | null
      changes: Changes
      confidence: 'high' | 'low'
    }
  | { type: 'delete'; target: string; target_index: number | null; confidence: 'high' | 'low' }
  | {
      type: 'query'
      period: Period
      direction: 'in' | 'out' | null
      category: Category | null
      payment: string | null
    }
  | { type: 'help' }
  | { type: 'off_topic' }
