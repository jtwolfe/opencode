import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import fsPromises from "fs/promises"
import { Agent } from "../../src/agent/agent"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/shared/filesystem"
import { Instance } from "../../src/project/instance"
import { SessionID, MessageID } from "../../src/session/schema"
import { IngestDesignDocsTool } from "../../src/tool/ingest-design-docs"
import { Truncate } from "../../src/tool"
import { Tool } from "../../src/tool"
import { provideInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await Instance.disposeAll()
})

const ctx: Tool.Context = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make(""),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

const it = testEffect(
  Layer.mergeAll(Agent.defaultLayer, AppFileSystem.defaultLayer, CrossSpawnSpawner.defaultLayer, Truncate.defaultLayer),
)

const init = Effect.fn("IngestDesignDocsTest.init")(function* () {
  const info = yield* IngestDesignDocsTool
  return yield* info.init()
})

const run = Effect.fn("IngestDesignDocsTest.run")(function* (
  args: Tool.InferParameters<typeof IngestDesignDocsTool>,
  next: Tool.Context = ctx,
) {
  const tool = yield* init()
  return yield* tool.execute(args, next)
})

describe("ingest-design-docs tool", () => {
  it.live("concatenates markdown files in a folder and writes to run state directory", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      // Create a fixture folder with 3 markdown files.
      const docsFolder = path.join(dir, "autocrew-design-docs")
      yield* Effect.promise(() => fsPromises.mkdir(docsFolder, { recursive: true }))
      yield* Effect.promise(() => fsPromises.writeFile(path.join(docsFolder, "01-intro.md"), "# Intro\n\nHello."))
      yield* Effect.promise(() =>
        fsPromises.writeFile(path.join(docsFolder, "02-architecture.md"), "# Architecture\n\nDetails."),
      )
      yield* Effect.promise(() => fsPromises.writeFile(path.join(docsFolder, "03-safety.md"), "# Safety\n\nGuards."))

      const result = yield* provideInstance(dir)(
        run({
          run_id: "test-run-001",
          folder: "autocrew-design-docs",
        }),
      )

      expect(result.title).toContain("3 design docs")
      const summary = JSON.parse(result.output)
      expect(summary.run_id).toBe("test-run-001")
      expect(summary.file_count).toBe(3)
      expect(summary.sections).toHaveLength(3)
      expect(summary.sections.map((s: { filename: string }) => s.filename).sort()).toEqual([
        path.join("autocrew-design-docs", "01-intro.md"),
        path.join("autocrew-design-docs", "02-architecture.md"),
        path.join("autocrew-design-docs", "03-safety.md"),
      ])

      // Verify the concatenated file was written.
      const expectedOutput = path.join(dir, ".opencode", "autocrew-state", "test-run-001", "design-docs.md")
      expect(summary.output_path).toBe(expectedOutput)
      const written = yield* Effect.promise(() => fsPromises.readFile(expectedOutput, "utf8"))
      expect(written).toContain("## From:")
      expect(written).toContain("# Intro")
      expect(written).toContain("# Architecture")
      expect(written).toContain("# Safety")
    }))

  it.live("returns error summary when folder does not exist", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const result = yield* provideInstance(dir)(
        run({
          run_id: "test-run-missing",
          folder: "does-not-exist",
        }),
      )

      const summary = JSON.parse(result.output)
      expect(summary.file_count).toBe(0)
      expect(summary.error).toContain("Folder not found")
    }))

  it.live("accepts explicit file list overriding folder", () =>
    Effect.gen(function* () {
      const dir = yield* tmpdirScoped()
      const a = path.join(dir, "a.md")
      const b = path.join(dir, "b.md")
      yield* Effect.promise(() => fsPromises.writeFile(a, "# A"))
      yield* Effect.promise(() => fsPromises.writeFile(b, "# B"))

      const result = yield* provideInstance(dir)(
        run({
          run_id: "test-run-explicit",
          files: ["a.md", "b.md"],
        }),
      )

      const summary = JSON.parse(result.output)
      expect(summary.file_count).toBe(2)
      expect(summary.sections.map((s: { filename: string }) => s.filename).sort()).toEqual(["a.md", "b.md"])
    }))
})
