import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppFileSystem } from "@opencode-ai/shared/filesystem"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Command } from "../../src/command"
import { Instance } from "../../src/project/instance"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await Instance.disposeAll()
})

const it = testEffect(
  Layer.mergeAll(Command.defaultLayer, AppFileSystem.defaultLayer, CrossSpawnSpawner.defaultLayer),
)

describe("AutoCrew slash commands", () => {
  it.live("registers all 8 autocrew commands", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const svc = yield* Command.Service
        const list = yield* svc.list()
        const names = list.map((c) => c.name)
        for (const expected of [
          "autocrew",
          "pause-autocrew",
          "resume-autocrew",
          "stop-autocrew",
          "status",
          "apply",
          "kill-session",
          "cancel-task",
        ]) {
          expect(names).toContain(expected)
        }
      }),
    ),
  )

  it.live("/autocrew is a subtask command targeting the autocrew agent", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const svc = yield* Command.Service
        const cmd = yield* svc.get("autocrew")
        expect(cmd).toBeDefined()
        expect(cmd?.subtask).toBe(true)
        expect(cmd?.agent).toBe("autocrew")
        const tpl = yield* Effect.promise(() => Promise.resolve(cmd!.template))
        expect(tpl).toContain("AutoCrew")
        expect(tpl).toContain("ingest-design-docs")
      }),
    ),
  )

  it.live("/resume-autocrew is a subtask command targeting the autocrew agent", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const svc = yield* Command.Service
        const cmd = yield* svc.get("resume-autocrew")
        expect(cmd).toBeDefined()
        expect(cmd?.subtask).toBe(true)
        expect(cmd?.agent).toBe("autocrew")
      }),
    ),
  )

  it.live("/status is not a subtask (read-only, runs in current session)", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const svc = yield* Command.Service
        const cmd = yield* svc.get("status")
        expect(cmd).toBeDefined()
        expect(cmd?.subtask).toBeFalsy()
      }),
    ),
  )

  it.live("/kill-session and /cancel-task expose $1 hint for session/task id", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const svc = yield* Command.Service
        const kill = yield* svc.get("kill-session")
        const cancel = yield* svc.get("cancel-task")
        expect(kill?.hints).toContain("$1")
        expect(cancel?.hints).toContain("$1")
      }),
    ),
  )
})
