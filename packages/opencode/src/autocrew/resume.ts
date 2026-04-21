export * as Resume from "./resume"

import * as path from "path"
import * as fs from "fs/promises"
import { Effect } from "effect"
import { Instance } from "../project/instance"
import { Session } from "../session"
import { Ledger } from "./ledger"
import type { RunState, TaskStateEntry } from "./types"

function statesRoot() {
  return path.join(Instance.directory, ".opencode", "autocrew-state")
}

/**
 * Find the run id of the most recent run state directory. Returns undefined
 * if no runs exist. Uses directory mtime; ties broken alphabetically (newer
 * timestamps sort last under default ISO ordering).
 */
export const findLatestRunId = Effect.fn("Resume.findLatestRunId")(function* () {
  const root = statesRoot()
  const entries = yield* Effect.promise(async () => {
    try {
      const items = await fs.readdir(root)
      const stats = await Promise.all(
        items.map(async (name) => {
          const full = path.join(root, name)
          try {
            const s = await fs.stat(full)
            return s.isDirectory() ? { name, mtime: s.mtimeMs } : undefined
          } catch {
            return undefined
          }
        }),
      )
      return stats.filter((x): x is { name: string; mtime: number } => !!x)
    } catch {
      return []
    }
  })
  if (entries.length === 0) return undefined
  entries.sort((a, b) => b.mtime - a.mtime || b.name.localeCompare(a.name))
  return entries[0]!.name
})

export interface ResumeContext {
  runId: string
  state: RunState
  plan: unknown
  reconciled_tasks: { id: string; from: string; to: string }[]
}

/**
 * Reconcile the persisted run state against live child sessions. Any task
 * marked `running` whose orchestrator session has no live child entry gets
 * reset to `pending` so it will be redispatched on the next round.
 *
 * Returns a list of the reconciliation deltas so the caller can audit-log
 * them. Does NOT mutate the input state; returns a new RunState.
 */
export const reconcileWithLiveChildren = Effect.fn("Resume.reconcileWithLiveChildren")(function* (state: RunState) {
  const sessions = yield* Session.Service
  const children = yield* sessions
    .children(state.orchestrator_session_id as never)
    .pipe(Effect.catch(() => Effect.succeed([] as Session.Info[])))

  const liveSessionIds = new Set(children.map((c) => c.id as string))
  const reconciled: { id: string; from: string; to: string }[] = []

  const newTasks: Record<string, TaskStateEntry> = {}
  for (const [id, task] of Object.entries(state.tasks)) {
    if (task.state === "running") {
      const anyAlive = task.candidate_session_ids.some((sid) => liveSessionIds.has(sid))
      if (!anyAlive) {
        newTasks[id] = { ...task, state: "pending" }
        reconciled.push({ id, from: "running", to: "pending" })
        continue
      }
    }
    newTasks[id] = task
  }

  return {
    state: { ...state, tasks: newTasks, updated_at: new Date().toISOString() },
    reconciled,
  }
})

/**
 * Load and reconcile a paused/interrupted run, ready for the orchestrator to
 * resume execution. The orchestrator should re-read the plan and ledger
 * directly from disk before deciding the next dispatch.
 *
 * Returns undefined if no resumable run is found.
 */
export const loadResumeContext = Effect.fn("Resume.loadResumeContext")(function* (input?: { runId?: string }) {
  const runId = input?.runId ?? (yield* findLatestRunId())
  if (!runId) return undefined

  const state = yield* Ledger.readState(runId)
  if (!state) return undefined

  const reconciled = yield* reconcileWithLiveChildren(state).pipe(
    Effect.catch(() => Effect.succeed({ state, reconciled: [] as { id: string; from: string; to: string }[] })),
  )

  // Read plan.json (may be undefined if not yet persisted).
  const planFile = path.join(statesRoot(), runId, "plan.json")
  const plan = yield* Effect.promise(async () => {
    try {
      const text = await fs.readFile(planFile, "utf8")
      return JSON.parse(text) as unknown
    } catch {
      return undefined
    }
  })

  // Persist the reconciled state so the orchestrator's next read sees it.
  yield* Ledger.writeStateAtomic(runId, reconciled.state).pipe(Effect.catch(() => Effect.void))

  return {
    runId,
    state: reconciled.state,
    plan,
    reconciled_tasks: reconciled.reconciled,
  } satisfies ResumeContext
})
