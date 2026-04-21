import { describe, expect, test } from "bun:test"
import { Failure } from "../../src/autocrew/failure"
import type { TaskStateEntry } from "../../src/autocrew/types"

const t = (overrides: Partial<TaskStateEntry> = {}): TaskStateEntry => ({
  id: "t1",
  state: "failed-retry",
  role: "coder",
  retry_count: 0,
  replan_count: 0,
  candidate_session_ids: [],
  ...overrides,
})

describe("Failure.applyFailurePolicy", () => {
  test("returns retry while retry budget remaining", () => {
    const action = Failure.applyFailurePolicy(t({ retry_count: 0 }), { max_retries_per_task: 3 })
    expect(action.type).toBe("retry")
    if (action.type === "retry") expect(action.remaining).toBe(2)
  })

  test("returns retry on the very last allowed attempt", () => {
    const action = Failure.applyFailurePolicy(t({ retry_count: 2 }), { max_retries_per_task: 3 })
    expect(action.type).toBe("retry")
    if (action.type === "retry") expect(action.remaining).toBe(0)
  })

  test("escalates to replan when retries exhausted", () => {
    const action = Failure.applyFailurePolicy(
      t({ retry_count: 3, replan_count: 0 }),
      { max_retries_per_task: 3, max_replans_per_task: 2 },
    )
    expect(action.type).toBe("replan")
    if (action.type === "replan") expect(action.remaining).toBe(1)
  })

  test("enters review when both budgets exhausted", () => {
    const action = Failure.applyFailurePolicy(
      t({ retry_count: 3, replan_count: 2 }),
      { max_retries_per_task: 3, max_replans_per_task: 2 },
    )
    expect(action.type).toBe("review")
    if (action.type === "review") expect(action.reason).toContain("exhausted")
  })

  test("uses defaults (3 retries, 2 replans) when config omitted", () => {
    const a = Failure.applyFailurePolicy(t({ retry_count: 2 }))
    expect(a.type).toBe("retry")
    const b = Failure.applyFailurePolicy(t({ retry_count: 3 }))
    expect(b.type).toBe("replan")
    const c = Failure.applyFailurePolicy(t({ retry_count: 3, replan_count: 2 }))
    expect(c.type).toBe("review")
  })
})

describe("Failure.recordRetry / recordReplan / recordReview", () => {
  test("recordRetry increments retry_count and sets state", () => {
    const next = Failure.recordRetry(t({ retry_count: 1 }))
    expect(next.retry_count).toBe(2)
    expect(next.state).toBe("failed-retry")
  })

  test("recordReplan increments replan_count and resets retry_count", () => {
    const next = Failure.recordReplan(t({ retry_count: 3, replan_count: 0 }))
    expect(next.replan_count).toBe(1)
    expect(next.retry_count).toBe(0)
    expect(next.state).toBe("failed-replan")
  })

  test("recordReview marks state as review", () => {
    const next = Failure.recordReview(t({ retry_count: 3, replan_count: 2 }))
    expect(next.state).toBe("review")
  })
})

describe("Failure.checkRoundBudget", () => {
  test("ok while under cap", () => {
    expect(Failure.checkRoundBudget({ rounds_consumed: 5 }, { max_rounds_per_run: 40 }).ok).toBe(true)
  })

  test("fails at and above cap", () => {
    const r = Failure.checkRoundBudget({ rounds_consumed: 40 }, { max_rounds_per_run: 40 })
    expect(r.ok).toBe(false)
    expect(r.reason).toContain("max-rounds-per-run")
  })

  test("uses default cap of 40 when omitted", () => {
    expect(Failure.checkRoundBudget({ rounds_consumed: 39 }).ok).toBe(true)
    expect(Failure.checkRoundBudget({ rounds_consumed: 40 }).ok).toBe(false)
  })
})

describe("Failure.checkRuntimeBudget", () => {
  test("ok within cap", () => {
    const start = new Date(Date.now() - 60 * 60 * 1000).toISOString() // 1h ago
    expect(Failure.checkRuntimeBudget(start, Date.now(), { total_runtime_hours: 4 }).ok).toBe(true)
  })

  test("fails after cap", () => {
    const start = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString() // 5h ago
    const r = Failure.checkRuntimeBudget(start, Date.now(), { total_runtime_hours: 4 })
    expect(r.ok).toBe(false)
    expect(r.reason).toContain("total-runtime-hours")
  })

  test("ok for unparseable timestamp (defensive)", () => {
    expect(Failure.checkRuntimeBudget("not-a-date").ok).toBe(true)
  })
})
