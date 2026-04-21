import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { Config } from "../../src/config"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
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
  ),
)

const seed = Effect.fn("SmartTaskTest.seed")(function* (title = "orchestrator") {
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
    mode: "build",
    agent: "build",
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

function stubOps(opts?: { onPrompt?: (input: SessionPrompt.PromptInput) => void; text?: string }): TaskPromptOps {
  return {
    cancel() {},
    resolvePromptParts: (template) => Effect.succeed([{ type: "text" as const, text: template }]),
    prompt: (input) =>
      Effect.sync(() => {
        opts?.onPrompt?.(input)
        return reply(input, opts?.text ?? "done: hello")
      }),
  }
}

function reply(input: SessionPrompt.PromptInput, text: string): MessageV2.WithParts {
  const id = MessageID.ascending()
  return {
    info: {
      id,
      role: "assistant",
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
      finish: "stop",
    },
    parts: [
      {
        id: PartID.ascending(),
        messageID: id,
        sessionID: input.sessionID,
        type: "text",
        text,
      },
    ],
  }
}

describe("tool.smart-task (Phase 4-5: single-task with worktree)", () => {
  it.live(
    "dispatches a single coder task in an isolated worktree and returns structured summary",
    () =>
      provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            const sessions = yield* Session.Service
            const { chat, assistant } = yield* seed()
            const tool = yield* SmartTaskTool
            const def = yield* tool.init()
            let seen: SessionPrompt.PromptInput | undefined
            const promptOps = stubOps({
              text: "done: modified hello.txt",
              onPrompt: (input) => (seen = input),
            })

            const result = yield* def.execute(
              {
                plan_id: "plan-001",
                tasks: [
                  {
                    id: "task-001",
                    role: "coder",
                    objective: "write a hello world utility",
                    parallel_count: 1,
                    acceptance_criteria: ["creates hello.txt with 'hello world'"],
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

            const kids = yield* sessions.children(chat.id)
            expect(kids).toHaveLength(1)
            expect(kids[0]?.title).toContain("task-001")
            expect(kids[0]?.title).toContain("@coder")
            expect(seen?.agent).toBe("coder")
            expect(seen?.sessionID).toBe(kids[0]?.id)

            const summary = JSON.parse(result.output)
            expect(summary.plan_id).toBe("plan-001")
            expect(summary.status).toBe("completed")
            expect(summary.tasks_total).toBe(1)
            expect(summary.tasks_completed).toBe(1)
            expect(summary.tasks_failed).toBe(0)
            expect(summary.ranks).toBe(1)
            expect(summary.results).toHaveLength(1)
            const r0 = summary.results[0]
            expect(r0.task_id).toBe("task-001")
            expect(r0.status).toBe("completed")
            expect(r0.session_id).toBe(kids[0]?.id)
            expect(r0.output_summary).toContain("hello.txt")
            expect(r0.role).toBe("coder")
            // Phase 5: a real worktree was provisioned for the coder.
            expect(r0.worktree).toBeDefined()
            expect(r0.worktree.name).toContain("plan-001")
            expect(r0.worktree.name).toContain("task-001")
            expect(r0.worktree.branch).toMatch(/^opencode\//)
            expect(result.metadata.planId).toBe("plan-001")
            expect(result.title).toContain("1 task")
          }),
        { git: true },
      ),
    60000,
  )

  it.live("dispatches multi-task DAG in topological rank order", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const { chat, assistant } = yield* seed()
          const tool = yield* SmartTaskTool
          const def = yield* tool.init()
          const dispatchOrder: string[] = []
          const promptOps = stubOps({
            onPrompt: (input) => {
              const first = input.parts[0]
              if (first && first.type === "text") {
                const match = first.text.match(/# Task (\S+):/)
                if (match) dispatchOrder.push(match[1]!)
              }
            },
          })

          const result = yield* def.execute(
            {
              plan_id: "plan-multi",
              tasks: [
                // reviewer depends on coder → must run after coder
                {
                  id: "review",
                  role: "reviewer",
                  objective: "score the implementation",
                  parallel_count: 1,
                  depends_on: ["code"],
                },
                { id: "code", role: "coder", objective: "write hello.txt", parallel_count: 1 },
                // planner has no deps → can run in rank 0 alongside coder
                { id: "plan", role: "planner", objective: "think", parallel_count: 1 },
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
          expect(summary.status).toBe("completed")
          expect(summary.tasks_total).toBe(3)
          expect(summary.tasks_completed).toBe(3)
          expect(summary.ranks).toBe(2)
          // reviewer must come after coder since it depends on it
          const reviewIdx = dispatchOrder.indexOf("review")
          const codeIdx = dispatchOrder.indexOf("code")
          expect(codeIdx).toBeGreaterThanOrEqual(0)
          expect(reviewIdx).toBeGreaterThan(codeIdx)
        }),
      { git: true },
    ),
    60000,
  )

  it.live("rejects parallel_count > 1 for non-coder roles", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seed()
        const tool = yield* SmartTaskTool
        const def = yield* tool.init()
        const promptOps = stubOps()

        const exit = yield* def
          .execute(
            {
              plan_id: "plan-bad",
              tasks: [{ id: "t1", role: "reviewer", objective: "A", parallel_count: 2 }],
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

        expect(exit._tag).toBe("Failure")
      }),
    ),
  )

  it.live(
    "Phase 7: dispatches parallel_count=2 coder task, runs reviewer per candidate, picks highest score",
    () =>
      provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            const { chat, assistant } = yield* seed()
            const tool = yield* SmartTaskTool
            const def = yield* tool.init()

            // Reply with different reviewer scores depending on which candidate is being reviewed.
            // The reviewer prompt embeds the candidate id; we key off that.
            const promptOps = stubOps({
              text: "default",
            }) as ReturnType<typeof stubOps>
            // Override prompt to inspect input and tailor response.
            promptOps.prompt = (input) =>
              Effect.sync(() => {
                const text = input.parts.map((p) => (p.type === "text" ? p.text : "")).join("\n")
                if (input.agent === "coder") {
                  // Coder replies with a "done" marker.
                  return reply(input, `done: candidate writing files`)
                }
                if (input.agent === "reviewer") {
                  // Different scores based on candidate id in the prompt.
                  const cand = text.match(/Review candidate (\d+)/)?.[1]
                  const score = cand === "0" ? 60 : 95
                  return reply(input, `{"candidate_id": ${cand ?? "0"}, "score": ${score}, "issues": [], "approved": true}`)
                }
                return reply(input, "ok")
              })

            const result = yield* def.execute(
              {
                plan_id: "plan-multi-cand",
                tasks: [
                  {
                    id: "task-impl",
                    role: "coder",
                    objective: "implement feature X",
                    parallel_count: 2,
                    acceptance_criteria: ["X works"],
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
            expect(r.task_id).toBe("task-impl")
            expect(r.status).toBe("completed")
            expect(r.candidates_evaluated).toBe(2)
            expect(r.winning_candidate_id).toBe(1)
            expect(r.winning_score).toBe(95)
            expect(r.worktree.branch).toMatch(/^opencode\/plan-multi-cand-task-impl-1$/)
            expect(r.selection_rationale).toContain("winner: candidate=1")
          }),
        { git: true },
      ),
    120000,
  )

  it.live("rejects DAG with cycles", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seed()
        const tool = yield* SmartTaskTool
        const def = yield* tool.init()
        const promptOps = stubOps()

        const exit = yield* def
          .execute(
            {
              plan_id: "plan-cycle",
              tasks: [
                { id: "a", role: "coder", objective: "A", parallel_count: 1, depends_on: ["b"] },
                { id: "b", role: "coder", objective: "B", parallel_count: 1, depends_on: ["a"] },
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

        expect(exit._tag).toBe("Failure")
      }),
    ),
  )

  it.live("dispatches to the reviewer role when specified", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const { chat, assistant } = yield* seed()
        const tool = yield* SmartTaskTool
        const def = yield* tool.init()
        let seen: SessionPrompt.PromptInput | undefined
        const promptOps = stubOps({
          text: '{"candidate_id": 0, "score": 87, "issues": [], "approved": true}',
          onPrompt: (input) => (seen = input),
        })

        const result = yield* def.execute(
          {
            plan_id: "plan-004",
            tasks: [
              {
                id: "task-review",
                role: "reviewer",
                objective: "score the hello.txt implementation",
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

        expect(seen?.agent).toBe("reviewer")
        const summary = JSON.parse(result.output)
        expect(summary.results).toHaveLength(1)
        expect(summary.results[0].task_id).toBe("task-review")
        expect(summary.results[0].output_summary).toContain("87")
        // Reviewer role does not get a worktree in v0.
        expect(summary.results[0].worktree).toBeUndefined()
      }),
    ),
  )
})
