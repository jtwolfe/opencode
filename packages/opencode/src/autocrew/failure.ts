export * as Failure from "./failure"

import type { TaskStateEntry, RunState } from "./types"

export interface FailurePolicyConfig {
  max_retries_per_task?: number
  max_replans_per_task?: number
  review_state_on_exhaustion?: boolean
}

export interface BudgetConfig {
  max_rounds_per_run?: number
  total_runtime_hours?: number
  max_task_depth?: number
}

export type NextAction =
  | { type: "retry"; remaining: number }
  | { type: "replan"; remaining: number }
  | { type: "review"; reason: string }

const DEFAULTS = {
  max_retries_per_task: 3,
  max_replans_per_task: 2,
  review_state_on_exhaustion: true,
}

/**
 * Decide what happens next when a task fails.
 *
 *   pending/running/completed → consume retry budget → consume replan budget → review.
 *
 * The orchestrator uses this signal to decide whether to redispatch the same
 * task (retry), escalate to the Planner for a revised spec (replan), or park
 * the task and meta-evaluate (review).
 */
export function applyFailurePolicy(
  task: TaskStateEntry,
  cfg?: FailurePolicyConfig,
): NextAction {
  const maxRetries = cfg?.max_retries_per_task ?? DEFAULTS.max_retries_per_task
  const maxReplans = cfg?.max_replans_per_task ?? DEFAULTS.max_replans_per_task

  // Retries left first.
  const retriesLeft = maxRetries - task.retry_count
  if (retriesLeft > 0) {
    return { type: "retry", remaining: retriesLeft - 1 }
  }

  // Replans next.
  const replansLeft = maxReplans - task.replan_count
  if (replansLeft > 0) {
    return { type: "replan", remaining: replansLeft - 1 }
  }

  // Out of budget — review.
  return {
    type: "review",
    reason: `exhausted: ${task.retry_count} retries, ${task.replan_count} replans (caps: ${maxRetries}/${maxReplans})`,
  }
}

/**
 * Increment the retry counter for a task (used when applyFailurePolicy returns
 * "retry"). Returns the updated TaskStateEntry; does not mutate the input.
 */
export function recordRetry(task: TaskStateEntry): TaskStateEntry {
  return { ...task, retry_count: task.retry_count + 1, state: "failed-retry" }
}

/**
 * Increment the replan counter and reset retry budget. Used after the Planner
 * delivers a revised task spec.
 */
export function recordReplan(task: TaskStateEntry): TaskStateEntry {
  return { ...task, replan_count: task.replan_count + 1, retry_count: 0, state: "failed-replan" }
}

/**
 * Mark a task as parked in review state.
 */
export function recordReview(task: TaskStateEntry): TaskStateEntry {
  return { ...task, state: "review" }
}

export interface BudgetCheck {
  ok: boolean
  reason?: string
}

/**
 * Check whether the run has remaining round budget. Smart-task checks this at
 * the top of each invocation; if exceeded, the run transitions to halted.
 */
export function checkRoundBudget(state: Pick<RunState, "rounds_consumed">, cfg?: BudgetConfig): BudgetCheck {
  const cap = cfg?.max_rounds_per_run ?? 40
  if (state.rounds_consumed >= cap) {
    return {
      ok: false,
      reason: `max-rounds-per-run (${cap}) exceeded; rounds_consumed=${state.rounds_consumed}`,
    }
  }
  return { ok: true }
}

/**
 * Check runtime cap. Returns ok: false when elapsed >= cap.
 */
export function checkRuntimeBudget(
  startedAtIso: string,
  now: number = Date.now(),
  cfg?: BudgetConfig,
): BudgetCheck {
  const capHours = cfg?.total_runtime_hours ?? 4
  const startedAt = Date.parse(startedAtIso)
  if (!Number.isFinite(startedAt)) return { ok: true }
  const elapsedHours = (now - startedAt) / (1000 * 60 * 60)
  if (elapsedHours >= capHours) {
    return {
      ok: false,
      reason: `total-runtime-hours (${capHours}) exceeded; elapsed=${elapsedHours.toFixed(2)}h`,
    }
  }
  return { ok: true }
}
