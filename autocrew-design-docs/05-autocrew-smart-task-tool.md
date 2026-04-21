# 05-autocrew-smart-task-tool.md

**AutoCrew Mode – Smart-Task Tool Specification**
**Document Version:** 1.2
**Date:** April 21, 2026
**Author:** Jim
**Status:** Draft – for implementation by Claude Code / future AutoCrew

## 1. Purpose

This document provides the complete technical specification for the single new core tool that makes AutoCrew possible: **`smart-task`**.

This tool is the only major code addition required. It extends the existing `Task` tool (`packages/opencode/src/tool/task.ts`) and is responsible for:
- Receiving a structured task list (DAG) from the Orchestrator.
- Topologically scheduling tasks with fan-out inside each rank.
- Provisioning isolated git worktrees for parallel Coders via `@opencode/Worktree`.
- Spawning child sessions via `Session.create({ parentID })` and binding their tool execution to the worktree via `Instance.provide({ directory: wt.directory, fn })`.
- Collecting candidate results (via the existing `SubtaskPart` / `runLoop` / synthetic-user-continuation machinery in `packages/opencode/src/session/prompt.ts`).
- Running the best-candidate selection pipeline (Reviewer/Validator/Tester scoring → orchestrator arbitration).
- Driving the automatic failure-handling state machine (retry → replan → review → backlog).
- Returning clean structured summaries back to the Orchestrator.

The orchestrator's loop is **not** a separate mechanism — `smart-task` emits `SubtaskPart`s and opencode's existing `runLoop` drains them, using the synthetic-user-continuation to bring the orchestrator LLM back for the next round. AutoCrew adds no new loop machinery; it adds the dispatcher tool and the orchestrator persona that uses it.

Everything else (child session creation, turn loop, navigation, permissions, UI visibility, worktree plumbing) is reused from OpenCode's existing infrastructure.

## 2. Tool Overview

**Tool Name:** `smart-task`
**Type:** Extended Tool (builds directly on the current `TaskTool`)
**Triggered By:** Orchestrator (heavy model) when it outputs a structured task list
**Key Capabilities:**
- Parallel execution of multiple child sessions with worktree isolation
- Role-based routing
- Best-candidate selection driven by real signals (tests, lint, review scores)
- Background execution with progress reporting
- Timeouts, cancellation, and automatic failure handling

## 3. Input Format (what the Orchestrator must produce)

The Orchestrator outputs a single JSON object that `smart-task` parses. The **canonical task schema** is defined in Doc 08 §3 (the Orchestrator's system prompt). Every task must have `{id, role, objective, inputs, outputs, acceptance_criteria, depends_on, parallel_count}`.

Minimal example (see Doc 08 §3 for the full schema):

```json
{
  "plan_id": "plan-2026-04-21-001",
  "tasks": [
    {
      "id": "task-001",
      "role": "coder",
      "objective": "Implement the new user authentication endpoint per design §3.2",
      "inputs": {
        "design_doc_sections": ["03-auth.md §3.2"],
        "files_to_read": ["src/api/auth.ts"]
      },
      "outputs": {
        "files_to_modify": ["src/api/auth.ts", "tests/auth.test.ts"],
        "expected_behavior": "POST /auth/verify returns 401 for invalid tokens"
      },
      "acceptance_criteria": [
        "new endpoint at POST /auth/verify",
        "tests cover valid, expired, and malformed token cases"
      ],
      "depends_on": [],
      "parallel_count": 2,
      "timeout_minutes": 15
    },
    {
      "id": "task-002",
      "role": "reviewer",
      "objective": "Score each candidate for the authentication endpoint",
      "depends_on": ["task-001"]
    }
  ],
  "selection_strategy": "best-candidate"
}
```

Notes:
- `parallel_count` applies to parallel-capable roles (Coder). A value ≥ 2 triggers worktree provisioning per candidate.
- `depends_on` forms the DAG edges. Reviewer/Validator/Tester tasks that depend on a Coder task are automatically fanned out to score each candidate from that Coder task.
- `selection_strategy` is advisory; v0 only supports `best-candidate`.
- The Orchestrator is expected to emit this schema directly via its `<payload>` block (Doc 08 §3, decision=`dispatch`); `smart-task` parses it as tool arguments.

## 4. Execution Flow

1. **Parse & Validate** — Validate task list, roles, dependencies, and cycle-free DAG.
2. **Topological Schedule** — Group tasks into ranks where all dependencies are satisfied.
3. **Per-rank Dispatch**, for each task in a rank:
   - If the role is parallel-capable and `parallel_count > 1`:
     - For each candidate `i`:
       - `wt_i = yield* Worktree.create({ name: "{plan_id}-{task_id}-{i}" })` — isolated dir + branch.
       - `session_i = yield* Session.create({ parentID: orchestrator.sessionId })` — child session record.
       - Execute the worker via `Instance.provide({ directory: wt_i.directory, init: InstanceBootstrap, fn: () => runWorker(session_i, task, context) })` — this binds the worker's `read`/`write`/`bash` tool calls to the worktree directory. **Do not use `workspaceID` to bind**; `workspaceID` is metadata only and does not control path resolution.
       - Record `{task_id, candidate_id: i, session_id, worktree: wt_i, branch: wt_i.branch}` in the orchestrator ledger.
   - Else (single-instance role, e.g. Reviewer scoring a candidate or Planner):
     - `session = yield* Session.create({ parentID: orchestrator.sessionId })`.
     - For Reviewer/Validator/Tester scoring a specific candidate: run inside `Instance.provide({ directory: candidate.worktree.directory, fn })` with write-disabled tools so the role can inspect (read/bash) but not mutate the candidate worktree.
     - For Planner (stateless, no file writes): run in the orchestrator's own instance context.
4. **Fan-out strategy (v0 vs v1):**
   - **v0:** emit one `SubtaskPart` per worker. opencode's existing `runLoop` drains them serially — isolation is still preserved via per-worker worktrees, but wall-clock execution is serial. This keeps v0 implementation small (no concurrency logic in `smart-task`).
   - **v1:** replace serial drain with concurrent `ops.prompt` (via `Effect.all` or `Promise.all`) so candidates run truly in parallel. The orchestrator's interface (emits task DAGs, receives aggregated results) does not change between v0 and v1 — only the smart-task internals.
5. **Collection & Candidate Scoring** — After workers complete, the smart-task aggregates:
   - Validator verdicts → drop any candidate that failed (hard filter).
   - Tester results → drop candidates with failing tests (hard filter, if tests exist).
   - Reviewer scores → winner is highest remaining score.
   - If zero candidates survive filters → trigger failure-handling state machine (§7).
6. **Integration** — The winning candidate's branch is handed to the Integrator role (or merged directly if no Integrator role is configured). Losing worktrees are cleaned up in this order (critical — sessions are not auto-terminated on worktree removal; confirmed via `packages/opencode/test/project/worktree.test.ts:139-141`):
   1. Dispose each losing candidate's instance context: `yield* Instance.dispose(wt.directory)`.
   2. `yield* Worktree.remove({ directory: wt.directory })`.
   3. The candidate's child session record remains in history for audit but is no longer associated with a live worktree.
   Losing worktrees are preserved (skip cleanup) when the task is in review state (see `worktree.keep-on-failure` in Doc 03 §4.3).
7. **Return Summary** — Return a clean, structured result to the Orchestrator:

```json
{
  "task_id": "task-001",
  "status": "completed",
  "candidates_evaluated": 2,
  "winning_candidate": 1,
  "winning_score": 92,
  "merged_branch": "opencode/plan-2026-04-21-001-task-001-1",
  "files_modified": ["src/api/auth.ts", "tests/auth.test.ts"],
  "errors": []
}
```

## 5. Orchestrator Run-Ledger and Plan Anchor

The smart-task tool writes to (and the Orchestrator reads from) a run-scoped ledger at `.opencode/autocrew-state/{run_id}/`:

- `ledger.json` — append-only list of events: task dispatched, worktree created, session started, candidate received, score assigned, candidate selected, worktree removed, failure, replan, halt.
- `plan.json` — current plan and its iteration history.
- `design-docs.md` — concatenated ingested design docs.
- `state.json` — current run state (enumerated below in §8) for resumability.

The ledger is the orchestrator's **only** persistent memory about the run. Worker subagents never see the full ledger — each receives only its task-scoped context. This keeps worker contexts lean and aligns with the CrewAI-style "clean role prompts" model.

### Plan Anchor via `session.plan()`

Opencode sessions expose a durable plan slot (`packages/opencode/src/session/session.ts:255`) that survives context compaction. At **round 0** (immediately after the user's goal + design docs are accepted), the orchestrator writes its initial plan into this slot using the `plan()` call. This gives the orchestrator two benefits:

1. **Mission resilience under compaction.** On long runs, opencode's compaction can trim the orchestrator's conversation history, but the plan remains in the durable slot. The orchestrator can (and should) reload it whenever it feels drift.
2. **Resume anchor.** On `/resume-autocrew`, the orchestrator reads the plan from `session.plan()` first — before reading `ledger.json` — so even a corrupted ledger cannot erase the run's mission.

The orchestrator must also write **plan revisions** to this slot whenever it re-plans (per the retry/replan state machine in §7). The latest plan revision always wins; older plan versions are preserved in `.opencode/autocrew-state/{run_id}/plan.json` for audit.

## 6. Helper Tool: `ingest-design-docs`

**Tool Name:** `ingest-design-docs`
**Purpose:** One-time helper called at the very beginning of an AutoCrew run.
**Behavior:**
- Scans the designated folder (default: `autocrew-design-docs/`) or accepts a list of file paths.
- Concatenates all Markdown files with clear section markers.
- Extracts structured metadata (requirements, constraints, architecture decisions).
- Writes the concatenated content + extracted metadata to `.opencode/autocrew-state/{run_id}/design-docs.md`.
- Workers receive only the slices of this document relevant to their assigned task (via `context_files`), not the whole thing.

## 7. Failure Handling State Machine

This is the automatic, orchestrator-managed logic that runs when any task fails (validator fail, test fail, timeout, worker error, or zero surviving candidates).

States per task:
- `pending` → `running` → `completed`
- On failure: `failed-retry` (bounded retries, same task, same role, fresh worktree each time)
- On retry exhaustion: `failed-replan` (escalate back to Planner; Planner may revise the task's description, split it, or declare it infeasible)
- On replan exhaustion: `review` (task is not completed; its worktree(s) are preserved for human inspection per `worktree.keep-on-failure`)

Transitions are governed by the `failure-policy` config block (Doc 03 §4.2):
- `max-retries-per-task` (default 3) — same-task retries before replan.
- `max-replans-per-task` (default 2) — replans before review state.
- `review-state-on-exhaustion` (default true) — whether to park the task or fail the whole run.
- `orchestrator-meta-eval-after-review` (default true) — when any task enters review state, the Orchestrator performs a meta-evaluation: "how many blockers do we have, and can the remaining plan still deliver a useful result?" It then chooses:
  - **continue** — proceed with remaining tasks, leave reviewed tasks in backlog.
  - **backlog** — surface unresolvable tasks to the user with full worktree links and halt.
  - **halt** — too many critical blockers; stop the run and summarize.

The Orchestrator's meta-eval is a reasoning step (heavy model), not a heuristic — it uses the ledger and the design docs to decide.

## 8. Run State & Resumability

`state.json` captures:
- `run_id`, `plan_id`
- Current phase (`ingesting` | `planning` | `awaiting-plan-approval` | `executing` | `integrating` | `meta-evaluating` | `paused` | `completed` | `halted`)
- Per-task state (from §7) + candidate ledger entries
- Worktree inventory (which are live, which were removed, which are kept for review)
- Retry/replan counters per task

On `/resume-autocrew`, the orchestrator reads `state.json` + `ledger.json`, reconciles against actual live sessions via `Session.children(orchestrator.sessionId)`, re-attaches to any still-running children, and resumes from the appropriate phase.

## 9. Error Handling & Safety

- **Timeout** — Any child session exceeding its timeout is cancelled and logged; the task enters `failed-retry`.
- **Worker error** — Surfaced to the orchestrator; task enters `failed-retry`.
- **Permission denial** — If a worker hits a permission wall, surfaced to orchestrator for replan.
- **Permission model** — Child sessions run with the subagent's declared permissions; the existing `task` tool's deny-down logic strips anything the subagent is not authorized for. Workers do not inherit full parent grants.
- **Audit Logging** — Every spawn, worktree op, candidate, score, and merge is logged to `.opencode/autocrew-state/{run_id}/`.
- **Cancellation** — `/stop-autocrew` halts the current run; `/kill-session <id>` terminates a specific child; `/cancel-task <id>` marks a task as user-cancelled.

## 10. Integration with Existing Code

- Extends the existing `TaskTool` class (no breaking changes).
- Reuses `Session.create({ parentID })` and `Session.children(parentID)`.
- Reuses the `@opencode/Worktree` service (`create`, `remove`, `reset`).
- Binds worker tool execution to worktrees via `Instance.provide({ directory, init, fn })` — **not** via `workspaceID`.
- Reuses opencode's existing autonomous loop machinery: `SubtaskPart` entries (`packages/opencode/src/session/message-v2.ts:217-232`), `runLoop` drain (`packages/opencode/src/session/prompt.ts:1305`), and synthetic-user-continuation after subtask completion (`prompt.ts:699-715`). No new loop infrastructure.
- Writes the orchestrator's initial plan to `session.plan()` at round 0 for compaction resilience and resume anchoring.
- Reuses the existing command registry (`packages/opencode/src/command/index.ts`) for slash commands.
- No changes required to the TUI, web UI, session navigation, turn loop, or provider code.

## 11. Implementation Notes

- The tool should be implemented as a drop-in extension so that `task` continues to work exactly as before when AutoCrew is disabled.
- Default behavior when `autocrew.enabled` is false: fall back to legacy Task tool (single session spawn, no DAG, no worktree, no selection).
- v0 first implementation uses free `zen` models (e.g. `big-pickle`) so the end-to-end pipeline can be exercised at zero cost. Provider-specific model tuning is a v1 concern.
- v0 may implement only `best-candidate` selection; the `selection_strategy` field must still be part of the schema for forward compatibility.
- **v0 fan-out is serial (one `SubtaskPart` per worker, drained sequentially by the existing `runLoop`); v1 replaces this with concurrent `ops.prompt` for true parallelism.** The orchestrator's tool interface is identical in both versions — the change is internal to `smart-task`. This means the v0 implementation can ship with correctness guarantees (isolation via worktrees, selection logic, failure handling) without inventing concurrency primitives.
- **`max-rounds-per-run`** (Doc 03 §4.4) must be enforced by `smart-task` on every invocation: read the orchestrator's round counter from `state.json`, increment it, and refuse to dispatch if the cap is exceeded (instead, transition the run to `halted` state and surface a summary to the user).
