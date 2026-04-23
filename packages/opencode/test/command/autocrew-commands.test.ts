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

describe("AutoCrew slash commands (v0.1)", () => {
  it.live("registers only the slash-commands that still need LLM reasoning", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const svc = yield* Command.Service
        const list = yield* svc.list()
        const names = list.map((c) => c.name)
        // Retained as slash-commands:
        // - /apply: merge logic benefits from LLM conflict reasoning.
        // - /kill-session and /cancel-task: need specific ids; ctrl+p pickers deferred to v1.
        expect(names).toContain("apply")
        expect(names).toContain("kill-session")
        expect(names).toContain("cancel-task")
        // Removed in v0.1:
        // - /autocrew: autocrew is a primary agent mode, not a slash-command.
        expect(names).not.toContain("autocrew")
        // - pause/resume/stop/status: migrated to ctrl+p actions (see
        //   cli/cmd/tui/routes/session/command-autocrew.ts) for direct-fs
        //   execution without burning LLM tokens.
        expect(names).not.toContain("pause-autocrew")
        expect(names).not.toContain("resume-autocrew")
        expect(names).not.toContain("stop-autocrew")
        expect(names).not.toContain("status")
      }),
    ),
  )

  it.live("/apply has the merge template", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const svc = yield* Command.Service
        const cmd = yield* svc.get("apply")
        expect(cmd).toBeDefined()
        const tpl = yield* Effect.promise(() => Promise.resolve(cmd!.template))
        expect(tpl).toMatch(/merge|apply/i)
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
