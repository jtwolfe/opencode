export * as Ledger from "./ledger"

import * as path from "path"
import * as fs from "fs/promises"
import { Effect } from "effect"
import { Instance } from "../project/instance"
import { Session } from "../session"
import type { LedgerEvent, RunState } from "./types"

function stateDir(runId: string) {
  return path.join(Instance.directory, ".opencode", "autocrew-state", runId)
}

function ensureDir(dir: string) {
  return Effect.promise(() => fs.mkdir(dir, { recursive: true }))
}

// Distributive Omit so each discriminated union variant keeps its narrowed shape.
type Unstamped<T> = T extends { timestamp: string } ? Omit<T, "timestamp"> : T

/**
 * Append one ledger event as a newline-delimited JSON entry. Each event is
 * timestamped at write time. Idempotent file creation; safe to call before
 * the run state file exists.
 */
export const appendEvent = Effect.fn("Ledger.appendEvent")(function* (
  runId: string,
  event: Unstamped<LedgerEvent>,
) {
  const dir = stateDir(runId)
  yield* ensureDir(dir)
  const file = path.join(dir, "ledger.jsonl")
  const stamped = { ...event, timestamp: new Date().toISOString() }
  yield* Effect.promise(() => fs.appendFile(file, JSON.stringify(stamped) + "\n"))
})

/**
 * Read all ledger entries for a run. Returns an empty array if the file
 * doesn't exist (no events recorded yet).
 */
export const readLedger = Effect.fn("Ledger.readLedger")(function* (runId: string) {
  const file = path.join(stateDir(runId), "ledger.jsonl")
  const contents = yield* Effect.promise(() => fs.readFile(file, "utf8").catch(() => ""))
  if (!contents) return [] as LedgerEvent[]
  const lines = contents.split("\n").filter(Boolean)
  return lines.map((l) => JSON.parse(l) as LedgerEvent)
})

/**
 * Write run state atomically: write to .tmp, fsync, rename. If the rename
 * fails (e.g., on Windows when target is open), fall back to a direct write.
 */
export const writeStateAtomic = Effect.fn("Ledger.writeStateAtomic")(function* (runId: string, state: RunState) {
  const dir = stateDir(runId)
  yield* ensureDir(dir)
  const file = path.join(dir, "state.json")
  const tmp = file + ".tmp"
  const payload = JSON.stringify(state, null, 2)
  yield* Effect.promise(async () => {
    await fs.writeFile(tmp, payload)
    try {
      await fs.rename(tmp, file)
    } catch {
      await fs.writeFile(file, payload)
      await fs.unlink(tmp).catch(() => undefined)
    }
  })
})

export const readState = Effect.fn("Ledger.readState")(function* (runId: string) {
  const file = path.join(stateDir(runId), "state.json")
  const text = yield* Effect.promise(() => fs.readFile(file, "utf8").catch(() => ""))
  if (!text) return undefined
  try {
    return JSON.parse(text) as RunState
  } catch {
    return undefined
  }
})

/**
 * Write the orchestrator's plan to the run state directory. Each call appends
 * to plan-history.jsonl (preserving prior revisions for audit) and overwrites
 * plan.json with the latest version.
 */
export const writePlan = Effect.fn("Ledger.writePlan")(function* (runId: string, plan: unknown) {
  const dir = stateDir(runId)
  yield* ensureDir(dir)
  const planFile = path.join(dir, "plan.json")
  const historyFile = path.join(dir, "plan-history.jsonl")
  const payload = JSON.stringify(plan, null, 2)
  yield* Effect.promise(async () => {
    await fs.writeFile(planFile, payload)
    await fs.appendFile(historyFile, JSON.stringify({ at: new Date().toISOString(), plan }) + "\n")
  })
})

/**
 * Write the plan as a markdown file in `.opencode/plans/` using opencode's
 * built-in `Session.plan()` path-builder. This is the durability anchor that
 * survives context compaction (Doc 02 §5).
 *
 * On non-git projects opencode falls back to ~/.local/share/opencode/plans.
 * Returns the path that was written.
 */
export const writePlanAnchor = Effect.fn("Ledger.writePlanAnchor")(function* (input: {
  runId: string
  planMarkdown: string
}) {
  const planPath = Session.plan({ slug: `autocrew-${input.runId}`, time: { created: Date.now() } })
  yield* Effect.promise(() => fs.mkdir(path.dirname(planPath), { recursive: true }))
  yield* Effect.promise(() => fs.writeFile(planPath, input.planMarkdown))
  return planPath
})
