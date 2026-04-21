import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import fsPromises from "fs/promises"
import { AppFileSystem } from "@opencode-ai/shared/filesystem"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Instance } from "../../src/project/instance"
import { Ledger } from "../../src/autocrew/ledger"
import type { RunState } from "../../src/autocrew/types"
import { provideInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await Instance.disposeAll()
})

const it = testEffect(Layer.mergeAll(AppFileSystem.defaultLayer, CrossSpawnSpawner.defaultLayer))

describe("Ledger", () => {
  it.live("appendEvent + readLedger round-trips multiple events with timestamps", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* provideInstance(dir)(
        Effect.gen(function* () {
          yield* Ledger.appendEvent("run-A", {
            type: "task-dispatched",
            task_id: "t1",
            role: "coder",
          })
          yield* Ledger.appendEvent("run-A", {
            type: "candidate-received",
            task_id: "t1",
            candidate_id: 0,
            output_summary: "ok",
          })
          const events = yield* Ledger.readLedger("run-A")
          expect(events).toHaveLength(2)
          expect(events[0]!.type).toBe("task-dispatched")
          expect(events[1]!.type).toBe("candidate-received")
          for (const e of events) expect(typeof e.timestamp).toBe("string")
        }),
      )
    }),
  )

  it.live("readLedger returns empty array when no events written", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* provideInstance(dir)(
        Effect.gen(function* () {
          const events = yield* Ledger.readLedger("missing-run")
          expect(events).toEqual([])
        }),
      )
    }),
  )

  it.live("writeStateAtomic + readState round-trip", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* provideInstance(dir)(
        Effect.gen(function* () {
          const state: RunState = {
            run_id: "run-B",
            plan_id: "plan-B",
            orchestrator_session_id: "ses_orch",
            phase: "executing",
            tasks: {
              t1: { id: "t1", state: "completed", role: "coder", retry_count: 0, replan_count: 0, candidate_session_ids: [] },
            },
            worktrees: [],
            rounds_consumed: 3,
            started_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }
          yield* Ledger.writeStateAtomic("run-B", state)
          const restored = yield* Ledger.readState("run-B")
          expect(restored?.plan_id).toBe("plan-B")
          expect(restored?.rounds_consumed).toBe(3)
          expect(restored?.tasks.t1?.state).toBe("completed")

          // Atomic rewrite — leave no .tmp lying around.
          const stateFile = path.join(dir, ".opencode", "autocrew-state", "run-B")
          const entries = yield* Effect.promise(() => fsPromises.readdir(stateFile))
          expect(entries.some((f) => f.endsWith(".tmp"))).toBe(false)
        }),
      )
    }),
  )

  it.live("writePlan persists plan.json and appends to plan-history.jsonl", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* provideInstance(dir)(
        Effect.gen(function* () {
          yield* Ledger.writePlan("run-C", { plan_id: "v1", tasks: [] })
          yield* Ledger.writePlan("run-C", { plan_id: "v2", tasks: [] })

          const planFile = path.join(dir, ".opencode", "autocrew-state", "run-C", "plan.json")
          const planText = yield* Effect.promise(() => fsPromises.readFile(planFile, "utf8"))
          const plan = JSON.parse(planText)
          expect(plan.plan_id).toBe("v2") // latest wins

          const historyFile = path.join(dir, ".opencode", "autocrew-state", "run-C", "plan-history.jsonl")
          const historyText = yield* Effect.promise(() => fsPromises.readFile(historyFile, "utf8"))
          const lines = historyText.trim().split("\n")
          expect(lines).toHaveLength(2)
          expect(JSON.parse(lines[0]!).plan.plan_id).toBe("v1")
          expect(JSON.parse(lines[1]!).plan.plan_id).toBe("v2")
        }),
      )
    }),
  )

  it.live("writePlanAnchor writes a markdown plan to .opencode/plans/", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped({ git: true })
      yield* provideInstance(dir)(
        Effect.gen(function* () {
          const written = yield* Ledger.writePlanAnchor({
            runId: "run-D",
            planMarkdown: "# Plan D\n\nstep 1.",
          })
          expect(written).toContain("autocrew-run-D")
          expect(written).toContain(".opencode/plans/")
          const text = yield* Effect.promise(() => fsPromises.readFile(written, "utf8"))
          expect(text).toContain("# Plan D")
        }),
      )
    }),
  )
})
