import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import fsPromises from "fs/promises"
import { Agent } from "../../src/agent/agent"
import { Config } from "../../src/config"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/shared/filesystem"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { Truncate } from "../../src/tool"
import { ToolRegistry } from "../../src/tool"
import { Worktree } from "../../src/worktree"
import { Ledger } from "../../src/autocrew/ledger"
import { Resume } from "../../src/autocrew/resume"
import type { RunState } from "../../src/autocrew/types"
import { provideTmpdirInstance, tmpdirScoped, provideInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await Instance.disposeAll()
})

const it = testEffect(
  Layer.mergeAll(
    Agent.defaultLayer,
    Config.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Session.defaultLayer,
    Truncate.defaultLayer,
    ToolRegistry.defaultLayer,
    Worktree.defaultLayer,
    AppFileSystem.defaultLayer,
  ),
)

describe("Resume", () => {
  it.live("findLatestRunId returns undefined when no runs exist", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const result = yield* provideInstance(dir)(Resume.findLatestRunId())
      expect(result).toBeUndefined()
    }),
  )

  it.live("findLatestRunId returns the most recently created run", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      yield* provideInstance(dir)(
        Effect.gen(function* () {
          // Create three run-state directories with controlled mtimes.
          const root = path.join(dir, ".opencode", "autocrew-state")
          yield* Effect.promise(() => fsPromises.mkdir(path.join(root, "run-A"), { recursive: true }))
          yield* Effect.promise(() => new Promise((r) => setTimeout(r, 20)))
          yield* Effect.promise(() => fsPromises.mkdir(path.join(root, "run-B"), { recursive: true }))
          yield* Effect.promise(() => new Promise((r) => setTimeout(r, 20)))
          yield* Effect.promise(() => fsPromises.mkdir(path.join(root, "run-C"), { recursive: true }))

          const latest = yield* Resume.findLatestRunId()
          expect(latest).toBe("run-C")
        }),
      )
    }),
  )

  it.live("loadResumeContext returns undefined when no state.json exists", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const ctx = yield* Resume.loadResumeContext()
        expect(ctx).toBeUndefined()
      }),
    ),
  )

  it.live("loadResumeContext loads state, plan, and reconciles tasks", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const orch = yield* sessions.create({ title: "test orchestrator" })

        // Seed a state with a "running" task whose candidate session never existed.
        const state: RunState = {
          run_id: "run-X",
          plan_id: "run-X",
          orchestrator_session_id: orch.id,
          phase: "executing",
          tasks: {
            t1: {
              id: "t1",
              state: "running",
              role: "coder",
              retry_count: 0,
              replan_count: 0,
              candidate_session_ids: ["ses_ghost"],
            },
            t2: {
              id: "t2",
              state: "completed",
              role: "reviewer",
              retry_count: 0,
              replan_count: 0,
              candidate_session_ids: [],
            },
          },
          worktrees: [],
          rounds_consumed: 1,
          started_at: new Date(Date.now() - 1000).toISOString(),
          updated_at: new Date(Date.now() - 1000).toISOString(),
        }
        yield* Ledger.writeStateAtomic("run-X", state)
        yield* Ledger.writePlan("run-X", { plan_id: "run-X", tasks: [] })

        const ctx = yield* Resume.loadResumeContext({ runId: "run-X" })
        expect(ctx).toBeDefined()
        expect(ctx!.runId).toBe("run-X")
        // The running-but-orphaned task must be reset to pending.
        expect(ctx!.state.tasks.t1?.state).toBe("pending")
        // The completed task is left alone.
        expect(ctx!.state.tasks.t2?.state).toBe("completed")
        // The plan was loaded.
        expect(ctx!.plan).toBeDefined()
        // Reconciliation deltas reported.
        expect(ctx!.reconciled_tasks).toHaveLength(1)
        expect(ctx!.reconciled_tasks[0]!.id).toBe("t1")

        // Verify the persisted state was updated.
        const reloaded = yield* Ledger.readState("run-X")
        expect(reloaded?.tasks.t1?.state).toBe("pending")
      }),
    ),
  )
})
