import z from "zod"
import { Effect } from "effect"
import * as Tool from "./tool"
import { Session } from "../session"
import { MessageV2 } from "../session/message-v2"
import { MessageID, SessionID } from "../session/schema"
import { Agent } from "../agent/agent"
import { Config } from "../config"
import { Instance } from "../project/instance"
import { InstanceBootstrap } from "../project/bootstrap"
import { BootstrapRuntime } from "@/effect/bootstrap-runtime"
import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { InstanceState } from "@/effect"
import { WorkspaceContext } from "@/control-plane/workspace-context"
import { Worktree } from "../worktree"
import { SmartTaskInput, type TaskSpec } from "../autocrew/types"
import { Dag } from "../autocrew/dag"
import * as WorktreeLifecycle from "../autocrew/worktree-lifecycle"
import { Selection, type Candidate } from "../autocrew/selection"
import { Ledger } from "../autocrew/ledger"
import { Failure } from "../autocrew/failure"
import { Log } from "../util"
import type { TaskPromptOps } from "./task"

const log = Log.create({ service: "smart-task" })

const id = "smart-task"

const DESCRIPTION = `AutoCrew dispatcher. Accepts a DAG of tasks and dispatches them to role-based subagents (planner, coder, reviewer, validator, tester, integrator). Tasks within a rank are dispatched serially in v0 (concurrent execution lands in v1); ranks run in topological order. Each coder task runs in an isolated git worktree. The orchestrator receives aggregated per-task results. In v0, parallel_count must be 1 — multi-candidate selection lands in Phase 7. Use this from inside an AutoCrew orchestrator session — not for general subagent invocation (use 'task' for that).`

const parameters = SmartTaskInput

function renderWorkerPrompt(task: TaskSpec, priorContext?: string): string {
  const parts: string[] = []
  parts.push(`# Task ${task.id}: ${task.objective}`)
  if (task.description) parts.push(`\n${task.description}`)
  if (priorContext) {
    parts.push(`\n## Context from completed dependencies`)
    parts.push(priorContext)
  }
  if (task.inputs) {
    parts.push(`\n## Inputs`)
    if (task.inputs.design_doc_sections && task.inputs.design_doc_sections.length > 0) {
      parts.push(`Design doc sections: ${task.inputs.design_doc_sections.join(", ")}`)
    }
    if (task.inputs.files_to_read && task.inputs.files_to_read.length > 0) {
      parts.push(`Files to read: ${task.inputs.files_to_read.join(", ")}`)
    }
  }
  if (task.outputs) {
    parts.push(`\n## Expected outputs`)
    if (task.outputs.files_to_modify && task.outputs.files_to_modify.length > 0) {
      parts.push(`Files to modify: ${task.outputs.files_to_modify.join(", ")}`)
    }
    if (task.outputs.expected_behavior) {
      parts.push(`Expected behavior: ${task.outputs.expected_behavior}`)
    }
  }
  if (task.acceptance_criteria && task.acceptance_criteria.length > 0) {
    parts.push(`\n## Acceptance criteria`)
    for (const c of task.acceptance_criteria) parts.push(`- ${c}`)
  }
  return parts.join("\n")
}

interface TaskResult {
  plan_id: string
  task_id: string
  role: string
  status: "completed" | "failed"
  session_id: string
  worktree?: {
    name: string
    branch: string
    directory: string
  }
  output_summary: string
  error?: string
  // Phase 7: multi-candidate selection metadata.
  candidates_evaluated?: number
  winning_candidate_id?: number
  winning_score?: number
  selection_rationale?: string
}

function tryParseReviewerOutput(text: string): { score?: number; approved?: boolean; issues?: string[] } {
  // Reviewer prompt asks for JSON; extract it tolerantly. Look for the first
  // {...} block. If parsing fails, return empty (caller treats as no signal).
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) return {}
  try {
    const obj = JSON.parse(match[0])
    return {
      score: typeof obj.score === "number" ? obj.score : undefined,
      approved: typeof obj.approved === "boolean" ? obj.approved : undefined,
      issues: Array.isArray(obj.issues) ? obj.issues.map(String) : undefined,
    }
  } catch {
    return {}
  }
}

export const SmartTaskTool = Tool.define(
  id,
  Effect.gen(function* () {
    const agent = yield* Agent.Service
    const config = yield* Config.Service
    const sessions = yield* Session.Service
    const worktreeSvc = yield* Worktree.Service

    const run = Effect.fn("SmartTaskTool.execute")(function* (params: z.infer<typeof parameters>, ctx: Tool.Context) {
      const cfg = yield* config.get()
      const tasks = params.tasks

      // Phase 9: enforce max-rounds-per-run. Each invocation consumes one round.
      // The orchestrator's loop is gated by this — if exceeded, the run halts
      // and the orchestrator should produce a final summary instead of dispatching.
      const priorState = yield* Ledger.readState(params.plan_id).pipe(Effect.catch(() => Effect.succeed(undefined)))
      const roundsConsumed = (priorState?.rounds_consumed ?? 0) + 1
      const budgetCheck = Failure.checkRoundBudget(
        { rounds_consumed: roundsConsumed },
        cfg.autocrew?.budget,
      )
      if (!budgetCheck.ok) {
        yield* Ledger.appendEvent(params.plan_id, {
          type: "meta-eval",
          verdict: "halt",
          evidence: budgetCheck.reason ?? "round budget exhausted",
        }).pipe(Effect.catch(() => Effect.void))
        const status: "completed" | "partial" | "failed" | "halted" = "halted"
        return {
          title: `smart-task halted: ${budgetCheck.reason}`,
          metadata: {
            planId: params.plan_id,
            tasksTotal: tasks.length,
            tasksCompleted: 0,
            tasksFailed: 0,
            ranks: 0,
            status,
          },
          output: JSON.stringify(
            {
              plan_id: params.plan_id,
              status: "halted",
              reason: budgetCheck.reason,
              rounds_consumed: roundsConsumed,
            },
            null,
            2,
          ),
        }
      }

      // v0 constraint: parallel_count > 1 is only valid for the coder role
      // (other roles aren't parallel-capable in v0; see Doc 04 §4).
      for (const t of tasks) {
        if (t.parallel_count > 1 && t.role !== "coder") {
          return yield* Effect.fail(
            new Error(
              `smart-task v0 only supports parallel_count > 1 for role 'coder' (task ${t.id} has role '${t.role}', parallel_count=${t.parallel_count}).`,
            ),
          )
        }
      }

      // DAG validation and topological scheduling (Phase 6).
      try {
        Dag.validateDag(tasks)
      } catch (err) {
        return yield* Effect.fail(err instanceof Error ? err : new Error(String(err)))
      }
      const ranks = Dag.topologicalRanks(tasks)

      // Phase 8: persist the plan at run start (idempotent — overwrites on repeated calls).
      yield* Ledger.writePlan(params.plan_id, {
        plan_id: params.plan_id,
        tasks,
        selection_strategy: params.selection_strategy,
        ranks: ranks.map((r) => r.map((t) => t.id)),
      }).pipe(Effect.catch(() => Effect.void))

      const ops = ctx.extra?.promptOps as TaskPromptOps
      if (!ops) {
        return yield* Effect.fail(new Error("SmartTaskTool requires promptOps in ctx.extra"))
      }

      // Trace-log: what Instance context does smart-task see at entry?
      // This pinpoints the WorktreeNotGitError failure mode — if ctx.project.vcs
      // is not "git" here, the orchestrator was spawned in a non-git instance
      // and we need to re-anchor via the orchestrator session's recorded directory.
      type EntryCtx = { directory: string; worktree: string; project: { id: string; vcs?: "git" } }
      const entryCtxFallback: EntryCtx = {
        directory: "<no-ctx>",
        worktree: "<no-ctx>",
        project: { id: "<no-ctx>" },
      }
      const entryCtx: EntryCtx = yield* InstanceState.context.pipe(
        Effect.map((c) => ({
          directory: c.directory,
          worktree: c.worktree,
          project: { id: c.project.id, vcs: c.project.vcs },
        })),
        Effect.catchCause(() => Effect.succeed(entryCtxFallback)),
      )
      const orchSession = yield* sessions
        .get(ctx.sessionID as SessionID)
        .pipe(Effect.catchCause(() => Effect.succeed(undefined)))
      log.info("smart-task entry", {
        planId: params.plan_id,
        taskCount: tasks.length,
        orchestratorSessionId: ctx.sessionID,
        entryInstanceDirectory: entryCtx.directory,
        entryInstanceWorktree: entryCtx.worktree,
        entryProjectId: entryCtx.project?.id,
        entryProjectVcs: entryCtx.project?.vcs,
        sessionRecordedDirectory: orchSession?.directory,
        cwd: process.cwd(),
        pathSnippet: (process.env.PATH ?? "").slice(0, 300),
      })

      const msg = yield* Effect.sync(() => MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID }))
      if (msg.info.role !== "assistant") {
        return yield* Effect.fail(new Error("smart-task must be called from an assistant message context"))
      }
      const assistantModel = {
        modelID: msg.info.modelID,
        providerID: msg.info.providerID,
      }

      const cleanupWorktree = (taskId: string, candidateId: number, directory: string) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            Instance.provide({
              directory,
              fn: async () => {
                await Instance.dispose()
              },
            }).catch(() => undefined),
          )
          const removed = yield* worktreeSvc
            .remove({ directory })
            .pipe(Effect.catch(() => Effect.succeed(false)))
          yield* Ledger.appendEvent(params.plan_id, {
            type: "worktree-removed",
            task_id: taskId,
            candidate_id: candidateId,
            worktree_directory: directory,
          }).pipe(Effect.catch(() => Effect.void))
          return removed
        })

      // Spawn one worker. Optionally creates a worktree and binds the dispatch
      // to its instance context. Returns a result-or-failure marker; never
      // throws (any error is caught and returned in the marker so callers can
      // aggregate gracefully).
      const spawnWorker = Effect.fn("SmartTaskTool.spawnWorker")(function* (input: {
        roleAgent: Agent.Info
        title: string
        prompt: string
        wantWorktree: boolean
        worktreeName?: string
      }) {
        const sub = input.roleAgent
        const canTask = sub.permission.some((rule) => rule.permission === "task")
        const canTodo = sub.permission.some((rule) => rule.permission === "todowrite")
        const nextSession = yield* sessions.create({
          parentID: ctx.sessionID,
          title: input.title,
          permission: [
            ...(canTodo
              ? []
              : [
                  {
                    permission: "todowrite" as const,
                    pattern: "*" as const,
                    action: "deny" as const,
                  },
                ]),
            ...(canTask
              ? []
              : [
                  {
                    permission: "task" as const,
                    pattern: "*" as const,
                    action: "deny" as const,
                  },
                ]),
            ...(cfg.experimental?.primary_tools?.map((item) => ({
              pattern: "*",
              action: "allow" as const,
              permission: item,
            })) ?? []),
          ],
        })

        const model = sub.model ?? assistantModel
        const messageID = MessageID.ascending()

        let worktreeInfo: Worktree.Info | undefined
        if (input.wantWorktree && input.worktreeName) {
          // Re-anchor the Instance context to the orchestrator session's recorded
          // directory before calling Worktree.create. The orchestrator session may
          // have been spawned via handleSubtask and inherit an InstanceRef pointing
          // at an unrelated project (e.g., opencode repo root), which causes
          // WorktreeNotGitError when project.vcs !== "git".
          //
          // The session row in the DB records the correct directory (set at
          // Session.create time from InstanceState.directory). Using that as the
          // anchor ensures Worktree.create sees the correct git project regardless
          // of what the calling fiber's InstanceRef happens to be.
          const anchorDirectory = orchSession?.directory ?? (entryCtx.directory !== "<no-ctx>" ? entryCtx.directory : undefined)
          if (!anchorDirectory) {
            return yield* Effect.fail(
              new Error("smart-task could not determine session directory for worktree creation"),
            )
          }

          const createInAnchor = Effect.promise<Worktree.Info | undefined>(async () => {
            try {
              return await Instance.provide({
                directory: anchorDirectory,
                init: () => BootstrapRuntime.runPromise(InstanceBootstrap),
                fn: async () => {
                  const ctxInside = Instance.current
                  log.info("worktree.create anchor context", {
                    anchorDirectory,
                    innerInstanceDirectory: ctxInside.directory,
                    innerInstanceWorktree: ctxInside.worktree,
                    innerProjectId: ctxInside.project.id,
                    innerProjectVcs: ctxInside.project.vcs,
                    worktreeName: input.worktreeName,
                  })
                  const bound = worktreeSvc.create({ name: input.worktreeName! }).pipe(
                    Effect.provideService(InstanceRef, ctxInside),
                    Effect.provideService(WorkspaceRef, WorkspaceContext.workspaceID),
                  )
                  return await Effect.runPromise(bound)
                },
              })
            } catch (err) {
              log.error("worktree.create failed inside anchor", {
                anchorDirectory,
                worktreeName: input.worktreeName,
                error: err instanceof Error ? err.message : String(err),
                stack: err instanceof Error ? err.stack?.slice(0, 1500) : undefined,
              })
              return undefined
            }
          })

          const created = yield* createInAnchor
          if (!created) {
            yield* Ledger.appendEvent(params.plan_id, {
              type: "task-failed",
              task_id: input.worktreeName,
              reason: `Worktree.create failed for ${input.worktreeName}`,
              next_action: "retry",
            }).pipe(Effect.catch(() => Effect.void))
            return yield* Effect.fail(
              new Error(
                `smart-task: Worktree.create failed for ${input.worktreeName}. See opencode log 'smart-task' for details.`,
              ),
            )
          }
          worktreeInfo = created
          log.info("worktree.create success", {
            name: created.name,
            branch: created.branch,
            directory: created.directory,
          })
        }

        function cancel() {
          ops.cancel(nextSession.id)
        }

        const runWorker = Effect.gen(function* () {
          const parts = yield* ops.resolvePromptParts(input.prompt)
          const promptInput = {
            messageID,
            sessionID: nextSession.id,
            model: { modelID: model.modelID, providerID: model.providerID },
            agent: sub.name,
            tools: {
              ...(canTodo ? {} : { todowrite: false }),
              ...(canTask ? {} : { task: false }),
              ...Object.fromEntries((cfg.experimental?.primary_tools ?? []).map((item) => [item, false])),
            },
            parts,
          }

          if (worktreeInfo) {
            // Bridge Effect → Promise → Effect so the worker's tool calls see
            // the worktree's instance context. Two things must happen inside fn:
            //  1. Instance.provide sets ALS (Instance.directory getter reads from here).
            //  2. We must ALSO provide InstanceRef/WorkspaceRef on the Effect we run,
            //     because opencode's Effect code reads instance context via
            //     `InstanceState.context` which looks up the `InstanceRef` service
            //     on the Effect context (NOT ALS). Mirror `attach()` in
            //     `src/effect/run-service.ts` and the test fixture's provideInstance.
            let captured: MessageV2.WithParts | undefined
            yield* Effect.promise(() =>
              Instance.provide({
                directory: worktreeInfo!.directory,
                init: () => BootstrapRuntime.runPromise(InstanceBootstrap),
                fn: async () => {
                  const bound = ops.prompt(promptInput).pipe(
                    Effect.provideService(InstanceRef, Instance.current),
                    Effect.provideService(WorkspaceRef, WorkspaceContext.workspaceID),
                  )
                  captured = await Effect.runPromise(bound)
                },
              }),
            )
            if (!captured) {
              return yield* Effect.fail(new Error("worker produced no result inside worktree instance"))
            }
            return captured
          }
          return yield* ops.prompt(promptInput)
        })

        return yield* Effect.acquireUseRelease(
          Effect.sync(() => {
            ctx.abort.addEventListener("abort", cancel)
          }),
          () =>
            runWorker.pipe(
              Effect.match({
                onFailure: (cause: unknown) => ({
                  sessionId: nextSession.id,
                  worktree: worktreeInfo,
                  ok: false as const,
                  error: String(cause),
                  message: undefined as MessageV2.WithParts | undefined,
                }),
                onSuccess: (message: MessageV2.WithParts) => ({
                  sessionId: nextSession.id,
                  worktree: worktreeInfo,
                  ok: true as const,
                  error: undefined as string | undefined,
                  message,
                }),
              }),
            ),
          () =>
            Effect.sync(() => {
              ctx.abort.removeEventListener("abort", cancel)
            }),
        )
      })

      // Dispatch a single task (no parallel candidates).
      const dispatchTask = Effect.fn("SmartTaskTool.dispatchTask")(function* (
        task: TaskSpec,
        priorResults: Map<string, TaskResult>,
      ) {
        const sub = yield* agent.get(task.role)
        if (!sub) {
          return {
            plan_id: params.plan_id,
            task_id: task.id,
            role: task.role,
            status: "failed" as const,
            session_id: "",
            output_summary: "",
            error: `Unknown role/agent: '${task.role}'`,
          } satisfies TaskResult
        }

        const depSummaries = (task.depends_on ?? [])
          .map((depId) => {
            const r = priorResults.get(depId)
            if (!r) return undefined
            return `- ${depId} (${r.role}, ${r.status}): ${r.output_summary.slice(0, 200)}`
          })
          .filter((x): x is string => !!x)
        const priorContext = depSummaries.length ? depSummaries.join("\n") : undefined

        const workerPrompt = renderWorkerPrompt(task, priorContext)
        const wantWorktree = cfg.autocrew?.worktree?.enabled !== false && task.role === "coder"
        const worktreeName = wantWorktree
          ? WorktreeLifecycle.candidateWorktreeName(params.plan_id, task.id, 0)
          : undefined

        yield* Ledger.appendEvent(params.plan_id, {
          type: "task-dispatched",
          task_id: task.id,
          role: task.role,
        }).pipe(Effect.catch(() => Effect.void))

        const spawned = yield* spawnWorker({
          roleAgent: sub,
          title: `${task.id} @${sub.name}`,
          prompt: workerPrompt,
          wantWorktree,
          worktreeName,
        })

        if (!spawned.ok || !spawned.message) {
          if (spawned.worktree) yield* cleanupWorktree(task.id, 0, spawned.worktree.directory)
          yield* Ledger.appendEvent(params.plan_id, {
            type: "task-failed",
            task_id: task.id,
            reason: spawned.error ?? "worker produced no result",
            next_action: "retry",
          }).pipe(Effect.catch(() => Effect.void))
          return {
            plan_id: params.plan_id,
            task_id: task.id,
            role: task.role,
            status: "failed" as const,
            session_id: spawned.sessionId,
            output_summary: "",
            error: spawned.error ?? "worker produced no result",
          } satisfies TaskResult
        }

        const message = spawned.message
        const outputText = message.parts.findLast((item) => item.type === "text")?.text ?? ""
        yield* Ledger.appendEvent(params.plan_id, {
          type: "task-completed",
          task_id: task.id,
          merged_branch: spawned.worktree?.branch,
        }).pipe(Effect.catch(() => Effect.void))
        return {
          plan_id: params.plan_id,
          task_id: task.id,
          role: task.role,
          status: "completed" as const,
          session_id: spawned.sessionId,
          worktree: spawned.worktree
            ? {
                name: spawned.worktree.name,
                branch: spawned.worktree.branch,
                directory: spawned.worktree.directory,
              }
            : undefined,
          output_summary: outputText.slice(0, 500),
        } satisfies TaskResult
      })

      // Phase 7: dispatch a multi-candidate coder task. Spawns N coder workers
      // in N isolated worktrees, then auto-spawns a Reviewer per candidate to
      // produce scores, applies best-candidate selection, cleans up losing
      // worktrees, and returns a single TaskResult representing the winner.
      const dispatchMultiCandidate = Effect.fn("SmartTaskTool.dispatchMultiCandidate")(function* (
        task: TaskSpec,
        priorResults: Map<string, TaskResult>,
      ) {
        const coderAgent = yield* agent.get("coder")
        if (!coderAgent) {
          return {
            plan_id: params.plan_id,
            task_id: task.id,
            role: task.role,
            status: "failed" as const,
            session_id: "",
            output_summary: "",
            error: "Coder agent not registered (required for multi-candidate dispatch)",
          } satisfies TaskResult
        }

        const reviewerAgent = yield* agent.get("reviewer").pipe(Effect.catch(() => Effect.succeed(undefined)))

        const depSummaries = (task.depends_on ?? [])
          .map((depId) => {
            const r = priorResults.get(depId)
            if (!r) return undefined
            return `- ${depId} (${r.role}, ${r.status}): ${r.output_summary.slice(0, 200)}`
          })
          .filter((x): x is string => !!x)
        const priorContext = depSummaries.length ? depSummaries.join("\n") : undefined
        const coderPrompt = renderWorkerPrompt(task, priorContext)

        const candidates: Candidate[] = []

        yield* Ledger.appendEvent(params.plan_id, {
          type: "task-dispatched",
          task_id: task.id,
          role: task.role,
        }).pipe(Effect.catch(() => Effect.void))

        for (let i = 0; i < task.parallel_count; i++) {
          const wtName = WorktreeLifecycle.candidateWorktreeName(params.plan_id, task.id, i)
          const spawned = yield* spawnWorker({
            roleAgent: coderAgent,
            title: `${task.id} candidate ${i} @coder`,
            prompt: coderPrompt,
            wantWorktree: true,
            worktreeName: wtName,
          })

          if (!spawned.ok || !spawned.message || !spawned.worktree) {
            if (spawned.worktree) yield* cleanupWorktree(task.id, i, spawned.worktree.directory)
            candidates.push({
              candidate_id: i,
              session_id: spawned.sessionId,
              worktree: spawned.worktree ?? { name: wtName, branch: `opencode/${wtName}`, directory: "" },
              output_summary: "",
              worker_failed: true,
            })
            continue
          }

          yield* Ledger.appendEvent(params.plan_id, {
            type: "worktree-created",
            task_id: task.id,
            candidate_id: i,
            worktree_name: spawned.worktree.name,
            worktree_branch: spawned.worktree.branch,
            worktree_directory: spawned.worktree.directory,
          }).pipe(Effect.catch(() => Effect.void))

          const outputText = spawned.message.parts.findLast((p) => p.type === "text")?.text ?? ""
          const candidate: Candidate = {
            candidate_id: i,
            session_id: spawned.sessionId,
            worktree: spawned.worktree,
            output_summary: outputText.slice(0, 500),
          }

          yield* Ledger.appendEvent(params.plan_id, {
            type: "candidate-received",
            task_id: task.id,
            candidate_id: i,
            output_summary: candidate.output_summary,
          }).pipe(Effect.catch(() => Effect.void))

          // Auto-fan-out the reviewer for this candidate (read-only against worktree).
          if (reviewerAgent) {
            const reviewPrompt = [
              `# Review candidate ${i} for task ${task.id}`,
              ``,
              `## Original task`,
              coderPrompt,
              ``,
              `## Coder output summary`,
              outputText.slice(0, 1000),
              ``,
              `## Worktree`,
              `Branch: ${spawned.worktree.branch}`,
              `Directory: ${spawned.worktree.directory}`,
              ``,
              `Review the candidate and emit JSON: { "candidate_id": ${i}, "score": 0-100, "issues": [], "approved": boolean }.`,
            ].join("\n")

            const reviewSpawned = yield* spawnWorker({
              roleAgent: reviewerAgent,
              title: `${task.id} review candidate ${i} @reviewer`,
              prompt: reviewPrompt,
              wantWorktree: false, // reviewer reads the candidate's worktree dir directly via path refs
            })

            if (reviewSpawned.ok && reviewSpawned.message) {
              const reviewText = reviewSpawned.message.parts.findLast((p) => p.type === "text")?.text ?? ""
              const parsed = tryParseReviewerOutput(reviewText)
              candidate.reviewer_score = parsed.score
              candidate.reviewer_approved = parsed.approved
              candidate.reviewer_issues = parsed.issues
              if (parsed.score !== undefined) {
                yield* Ledger.appendEvent(params.plan_id, {
                  type: "score-assigned",
                  task_id: task.id,
                  candidate_id: i,
                  score: parsed.score,
                  reviewer_session_id: reviewSpawned.sessionId,
                }).pipe(Effect.catch(() => Effect.void))
              }
            }
          }

          candidates.push(candidate)
        }

        const selection = Selection.selectBestCandidate(candidates)

        // Cleanup losers (preserve winner's worktree for caller).
        for (const loser of selection.losers) {
          if (loser.worktree.directory)
            yield* cleanupWorktree(task.id, loser.candidate_id, loser.worktree.directory)
        }

        if (!selection.winner) {
          // Nothing survived filters — surface as failed task.
          return {
            plan_id: params.plan_id,
            task_id: task.id,
            role: task.role,
            status: "failed" as const,
            session_id: candidates[0]?.session_id ?? "",
            output_summary: "",
            error: `No candidate selected: ${selection.rationale}`,
            candidates_evaluated: candidates.length,
            selection_rationale: selection.rationale,
          } satisfies TaskResult
        }

        const winner = selection.winner
        yield* Ledger.appendEvent(params.plan_id, {
          type: "candidate-selected",
          task_id: task.id,
          winning_candidate_id: winner.candidate_id,
          rationale: selection.rationale,
        }).pipe(Effect.catch(() => Effect.void))
        yield* Ledger.appendEvent(params.plan_id, {
          type: "task-completed",
          task_id: task.id,
          merged_branch: winner.worktree.branch,
        }).pipe(Effect.catch(() => Effect.void))
        return {
          plan_id: params.plan_id,
          task_id: task.id,
          role: task.role,
          status: "completed" as const,
          session_id: winner.session_id,
          worktree: {
            name: winner.worktree.name,
            branch: winner.worktree.branch,
            directory: winner.worktree.directory,
          },
          output_summary: winner.output_summary,
          candidates_evaluated: candidates.length,
          winning_candidate_id: winner.candidate_id,
          winning_score: winner.reviewer_score,
          selection_rationale: selection.rationale,
        } satisfies TaskResult
      })

      // Iterate ranks in topological order; within a rank, dispatch serially.
      // v1 will parallelize within ranks via Effect.all concurrency.
      const allResults = new Map<string, TaskResult>()
      const rankOutcomes: Array<{ rank: number; results: TaskResult[] }> = []
      for (let i = 0; i < ranks.length; i++) {
        const rank = ranks[i]!
        const rankResults: TaskResult[] = []
        for (const task of rank) {
          const result =
            task.role === "coder" && task.parallel_count > 1
              ? yield* dispatchMultiCandidate(task, allResults)
              : yield* dispatchTask(task, allResults)
          allResults.set(task.id, result)
          rankResults.push(result)
        }
        rankOutcomes.push({ rank: i, results: rankResults })
      }

      const tasksCompleted = [...allResults.values()].filter((r) => r.status === "completed").length
      const tasksFailed = [...allResults.values()].filter((r) => r.status === "failed").length
      const overallStatus: "completed" | "partial" | "failed" | "halted" =
        tasksFailed === 0 ? "completed" : tasksCompleted === 0 ? "failed" : "partial"

      // Phase 9: persist updated round counter so the next smart-task invocation
      // sees the incremented value and can enforce the cap.
      const startedAt = priorState?.started_at ?? new Date().toISOString()
      const updatedState = {
        run_id: params.plan_id,
        plan_id: params.plan_id,
        orchestrator_session_id: priorState?.orchestrator_session_id ?? ctx.sessionID,
        phase: (overallStatus === "failed" ? "halted" : "executing") as
          | "ingesting"
          | "planning"
          | "awaiting-plan-approval"
          | "executing"
          | "integrating"
          | "meta-evaluating"
          | "paused"
          | "completed"
          | "halted",
        tasks: Object.fromEntries(
          [...allResults.entries()].map(([id, r]) => [
            id,
            {
              id,
              state: (r.status === "completed" ? "completed" : "failed-retry") as
                | "pending"
                | "running"
                | "completed"
                | "failed-retry"
                | "failed-replan"
                | "review"
                | "user-cancelled",
              role: r.role as "planner" | "coder" | "reviewer" | "validator" | "tester" | "integrator",
              retry_count: priorState?.tasks[id]?.retry_count ?? 0,
              replan_count: priorState?.tasks[id]?.replan_count ?? 0,
              candidate_session_ids: [r.session_id].filter(Boolean),
            },
          ]),
        ),
        worktrees: priorState?.worktrees ?? [],
        rounds_consumed: roundsConsumed,
        started_at: startedAt,
        updated_at: new Date().toISOString(),
      }
      yield* Ledger.writeStateAtomic(params.plan_id, updatedState).pipe(Effect.catch(() => Effect.void))

      const summary = {
        plan_id: params.plan_id,
        status: overallStatus,
        tasks_total: tasks.length,
        tasks_completed: tasksCompleted,
        tasks_failed: tasksFailed,
        ranks: rankOutcomes.length,
        results: [...allResults.values()],
      }

      const finalStatus = overallStatus as "completed" | "partial" | "failed" | "halted"
      const finalMetadata: {
        planId: string
        tasksTotal: number
        tasksCompleted: number
        tasksFailed: number
        ranks: number
        status: "completed" | "partial" | "failed" | "halted"
      } = {
        planId: params.plan_id,
        tasksTotal: tasks.length,
        tasksCompleted,
        tasksFailed,
        ranks: rankOutcomes.length,
        status: finalStatus,
      }
      return {
        title: `smart-task: ${tasks.length} task(s), ${rankOutcomes.length} rank(s), ${tasksCompleted} ok / ${tasksFailed} failed`,
        metadata: finalMetadata,
        output: JSON.stringify(summary, null, 2),
      }
    })

    return {
      description: DESCRIPTION,
      parameters,
      execute: (params: z.infer<typeof parameters>, ctx: Tool.Context) => run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
