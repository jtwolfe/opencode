import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import fsPromises from "fs/promises"
import { Agent } from "../../src/agent/agent"
import { Config } from "../../src/config"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { InstanceState } from "../../src/effect"
import { AppFileSystem } from "@opencode-ai/shared/filesystem"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import type { SessionPrompt } from "../../src/session/prompt"
import { MessageID, PartID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { SmartTaskTool } from "../../src/tool/smart-task"
import { type TaskPromptOps } from "../../src/tool/task"
import { Truncate } from "../../src/tool"
import { ToolRegistry } from "../../src/tool"
import { Worktree } from "../../src/worktree"
import { Ledger } from "../../src/autocrew/ledger"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await Instance.disposeAll()
})

const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

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

const seed = Effect.fn("SmartTaskRealGit.seed")(function* (title = "orchestrator") {
  const session = yield* Session.Service
  const chat = yield* session.create({ title })
  const user = yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: chat.id,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  const assistant: MessageV2.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    parentID: user.id,
    sessionID: chat.id,
    mode: "autocrew",
    agent: "autocrew",
    cost: 0,
    path: { cwd: "/tmp", root: "/tmp" },
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    time: { created: Date.now() },
  }
  yield* session.updateMessage(assistant)
  return { chat, assistant }
})

interface WorkerContextSnapshot {
  agent: string
  directory: string
  worktree: string
  projectVcs?: "git"
  projectId: string
}

/**
 * Build a stub ops.prompt that runs a real Effect inside each worker. The
 * Effect reads `InstanceState.context` from the fiber's service registry —
 * exactly what a real worker's tools (read/write/bash) do. We record the
 * observed context per worker so assertions can verify the binding is
 * correctly pointing at the worktree directory, not the orchestrator.
 */
function makeTrackingOps(capture: WorkerContextSnapshot[], text = "done"): TaskPromptOps {
  return {
    cancel() {},
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (input: SessionPrompt.PromptInput) =>
      Effect.gen(function* () {
        const ctx = yield* InstanceState.context.pipe(
          Effect.catchCause(() =>
            Effect.succeed({
              directory: "<no-ctx>",
              worktree: "<no-ctx>",
              project: { id: "<no-ctx>", vcs: undefined as "git" | undefined },
            }),
          ),
        )
        capture.push({
          agent: input.agent ?? "<unknown>",
          directory: ctx.directory,
          worktree: ctx.worktree,
          projectVcs: ctx.project.vcs,
          projectId: ctx.project.id,
        })
        const id = MessageID.ascending()
        return {
          info: {
            id,
            role: "assistant" as const,
            parentID: input.messageID ?? MessageID.ascending(),
            sessionID: input.sessionID,
            mode: input.agent ?? "coder",
            agent: input.agent ?? "coder",
            cost: 0,
            path: { cwd: "/tmp", root: "/tmp" },
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: input.model?.modelID ?? ref.modelID,
            providerID: input.model?.providerID ?? ref.providerID,
            time: { created: Date.now() },
            finish: "stop" as const,
          },
          parts: [
            {
              id: PartID.ascending(),
              messageID: id,
              sessionID: input.sessionID,
              type: "text" as const,
              text,
            },
          ],
        } satisfies MessageV2.WithParts
      }),
  }
}

describe("smart-task — real git integration (regression test for WorktreeNotGitError)", () => {
  it.live(
    "coder dispatch: worktree is created, worker sees the worktree's Instance context, branch survives",
    () =>
      provideTmpdirInstance(
        (tmpDir) =>
          Effect.gen(function* () {
            const { chat, assistant } = yield* seed()
            const tool = yield* SmartTaskTool
            const def = yield* tool.init()
            const capture: WorkerContextSnapshot[] = []
            const promptOps = makeTrackingOps(capture, "done: wrote hello.txt")

            const result = yield* def.execute(
              {
                plan_id: "plan-realgit-001",
                tasks: [
                  {
                    id: "task-001",
                    role: "coder",
                    objective: "Create hello.txt saying world",
                    parallel_count: 1,
                    acceptance_criteria: ["hello.txt exists"],
                  },
                ],
                selection_strategy: "best-candidate",
              },
              {
                sessionID: chat.id,
                messageID: assistant.id,
                agent: "autocrew",
                abort: new AbortController().signal,
                extra: { promptOps },
                messages: [],
                metadata: () => Effect.void,
                ask: () => Effect.void,
              },
            )

            // Assertion 1: the dispatch produced a completed task with worktree info.
            const summary = JSON.parse(result.output)
            expect(summary.status).toBe("completed")
            expect(summary.tasks_completed).toBe(1)
            const r0 = summary.results[0]
            expect(r0.task_id).toBe("task-001")
            expect(r0.status).toBe("completed")
            expect(r0.worktree).toBeDefined()
            expect(r0.worktree.branch).toMatch(/^opencode\/plan-realgit-001-task-001-/)

            // Assertion 2: the worker actually saw the worktree's Instance context.
            // This is the regression test — if InstanceRef is not propagated
            // correctly, the worker's InstanceState.context would resolve to
            // the orchestrator's directory instead of the worktree directory.
            expect(capture.length).toBeGreaterThanOrEqual(1)
            const coderCtx = capture.find((c) => c.agent === "coder")
            expect(coderCtx).toBeDefined()
            expect(coderCtx!.directory).toBe(r0.worktree.directory)
            expect(coderCtx!.directory).not.toBe(tmpDir)
            expect(coderCtx!.projectVcs).toBe("git")

            // Assertion 3: the branch actually exists in git.
            const worktreesListed = yield* Effect.promise(async () => {
              const proc = Bun.spawn(["git", "worktree", "list", "--porcelain"], {
                cwd: tmpDir,
                stdout: "pipe",
              })
              const text = await new Response(proc.stdout).text()
              await proc.exited
              return text
            })
            expect(worktreesListed).toContain(r0.worktree.directory)

            // Assertion 4: ledger has worktree-created + candidate/completion events.
            const events = yield* Ledger.readLedger("plan-realgit-001")
            const types = events.map((e) => e.type)
            // Single-candidate dispatch goes through dispatchTask which writes
            // task-dispatched + task-completed (no worktree-created event yet;
            // that's dispatchMultiCandidate territory). But the task-completed
            // event's merged_branch should match the worktree branch.
            expect(types).toContain("task-dispatched")
            expect(types).toContain("task-completed")
          }),
        { git: true },
      ),
    120000,
  )

  it.live(
    "multi-candidate coder: each candidate's worker sees its own worktree; losers cleaned up",
    () =>
      provideTmpdirInstance(
        (tmpDir) =>
          Effect.gen(function* () {
            const { chat, assistant } = yield* seed()
            const tool = yield* SmartTaskTool
            const def = yield* tool.init()
            const capture: WorkerContextSnapshot[] = []
            const promptOps = makeTrackingOps(capture)
            // Customize so reviewers give different scores (candidate 1 wins).
            const origPrompt = promptOps.prompt
            promptOps.prompt = (input) =>
              Effect.gen(function* () {
                const result = yield* origPrompt(input)
                if (input.agent === "reviewer") {
                  // Infer candidate id from prompt text
                  const first = input.parts[0]
                  const text = first && first.type === "text" ? first.text : ""
                  const cand = text.match(/candidate (\d+)/)?.[1] ?? "0"
                  const score = cand === "0" ? 55 : 90
                  // Replace text with JSON reviewer output
                  const id = MessageID.ascending()
                  return {
                    info: { ...result.info, id },
                    parts: [
                      {
                        id: PartID.ascending(),
                        messageID: id,
                        sessionID: input.sessionID,
                        type: "text" as const,
                        text: `{"candidate_id": ${cand}, "score": ${score}, "issues": [], "approved": true}`,
                      },
                    ],
                  } satisfies MessageV2.WithParts
                }
                return result
              })

            const result = yield* def.execute(
              {
                plan_id: "plan-realgit-002",
                tasks: [
                  {
                    id: "task-impl",
                    role: "coder",
                    objective: "Write the feature",
                    parallel_count: 2,
                    acceptance_criteria: ["it works"],
                  },
                ],
                selection_strategy: "best-candidate",
              },
              {
                sessionID: chat.id,
                messageID: assistant.id,
                agent: "autocrew",
                abort: new AbortController().signal,
                extra: { promptOps },
                messages: [],
                metadata: () => Effect.void,
                ask: () => Effect.void,
              },
            )

            const summary = JSON.parse(result.output)
            expect(summary.tasks_completed).toBe(1)
            const r = summary.results[0]
            expect(r.candidates_evaluated).toBe(2)
            expect(r.winning_candidate_id).toBe(1)
            expect(r.winning_score).toBe(90)

            // Each coder candidate must have seen a distinct worktree directory.
            const coderCtxs = capture.filter((c) => c.agent === "coder")
            expect(coderCtxs.length).toBe(2)
            const dirs = new Set(coderCtxs.map((c) => c.directory))
            expect(dirs.size).toBe(2)
            for (const c of coderCtxs) {
              expect(c.directory).not.toBe(tmpDir)
              expect(c.projectVcs).toBe("git")
            }

            // Ledger should show worktree-created x2, candidate-received x2,
            // score-assigned x2, candidate-selected x1, worktree-removed x1.
            const events = yield* Ledger.readLedger("plan-realgit-002")
            const count = (type: string) => events.filter((e) => e.type === type).length
            expect(count("worktree-created")).toBe(2)
            expect(count("candidate-received")).toBe(2)
            expect(count("score-assigned")).toBe(2)
            expect(count("candidate-selected")).toBe(1)
            expect(count("worktree-removed")).toBe(1)
          }),
        { git: true },
      ),
    180000,
  )

  it.live(
    "reports WorktreeNotGitError-style failure in ledger when anchor directory isn't git",
    () =>
      // Regression guard: even when worktree creation fails, the run must leave
      // a ledger trace of the failure (task-failed event). Previously the
      // Effect died silently and only task-dispatched appeared in the ledger.
      provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            const { chat, assistant } = yield* seed()
            const tool = yield* SmartTaskTool
            const def = yield* tool.init()
            const capture: WorkerContextSnapshot[] = []
            const promptOps = makeTrackingOps(capture)

            const outcome = yield* def
              .execute(
                {
                  plan_id: "plan-nogit",
                  tasks: [
                    {
                      id: "task-001",
                      role: "coder",
                      objective: "Try to write something",
                      parallel_count: 1,
                    },
                  ],
                  selection_strategy: "best-candidate",
                },
                {
                  sessionID: chat.id,
                  messageID: assistant.id,
                  agent: "autocrew",
                  abort: new AbortController().signal,
                  extra: { promptOps },
                  messages: [],
                  metadata: () => Effect.void,
                  ask: () => Effect.void,
                },
              )
              .pipe(Effect.exit)

            // The dispatch fails (non-git tmpdir) but a ledger event records the failure.
            expect(outcome._tag).toBe("Failure")
            const events = yield* Ledger.readLedger("plan-nogit")
            const failedEvents = events.filter((e) => e.type === "task-failed")
            expect(failedEvents.length).toBeGreaterThanOrEqual(1)
          }),
        { git: false },
      ),
    60000,
  )
})

// silence unused-var lint when certain imports are conditionally referenced
void fsPromises
void path
