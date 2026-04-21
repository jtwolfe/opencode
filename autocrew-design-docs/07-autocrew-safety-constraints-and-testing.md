# 07-autocrew-safety-constraints-and-testing.md

**AutoCrew Mode – Safety Constraints and Testing**
**Document Version:** 1.2
**Date:** April 21, 2026
**Author:** Jim
**Status:** Draft – for implementation by Claude Code / future AutoCrew

## 1. Purpose

This document defines the safety guardrails, runtime constraints, audit requirements, and testing strategy for AutoCrew Mode. It ensures the system remains reliable, controllable, and safe even when running fully automatically on large codebases.

Safety is a first-class requirement: AutoCrew must never cause more harm than a careful human developer would, and it must always provide clear escape hatches.

## 2. Core Safety Principles

1. **Least Privilege via Deny-Down** – Subagents do **not** inherit full parent permissions. The existing `task` tool denies any tool/permission the subagent is not explicitly granted. AutoCrew keeps this model and can further restrict per-role in config. This is the actual mechanism used today in `packages/opencode/src/tool/task.ts`.
2. **Worktree Isolation** – Parallel Coder candidates run in separate git worktrees provisioned via `@opencode/Worktree` and bound to worker tool execution via `Instance.provide({ directory: wt.directory })` (see Doc 02 §5, Doc 05 §4). They physically cannot clobber each other or the primary workspace until their branch is explicitly merged.
3. **Human-in-the-Loop by Default** – `full-auto: false` is the default. Plan approval gate and final `/apply` gate are on unless explicitly disabled.
4. **Resource Limits** – Hard caps on parallelism, task depth, runtime, **orchestrator rounds (`max-rounds-per-run`)**, and retry/replan counts prevent runaway execution. The `max-rounds-per-run` cap is the specific guard against hierarchical-manager runaway loops documented in CrewAI-style systems (see Doc 03 §4.4).
5. **Plan Durability under Compaction** – The orchestrator writes its initial plan to `session.plan()` at round 0 (see Doc 02 §5, Doc 05 §5). This slot survives opencode's context compaction, so the orchestrator cannot drift off-mission on a long run.
6. **Transparency & Auditability** – Every decision and change is logged to the run ledger and inspectable via normal session navigation + file inspection.
7. **Fail-Safe Design** – Any failure flows through the automatic state machine (retry → replan → review) rather than propagating unhandled. The Orchestrator's meta-evaluation then renders a continue / backlog / halt verdict.

## 3. Automatic Failure-Handling State Machine

This is the mechanism that makes AutoCrew "try to work around failures and halt when there are too many blockers." It is implemented in the smart-task tool (see Doc 05 §7) and driven by the `failure-policy` config block (Doc 03 §4.2).

Per-task state transitions:
- `pending` → `running` → `completed` on success.
- On failure: `failed-retry`, up to `max-retries-per-task` retries (default 3) in fresh worktrees.
- On retry exhaustion: `failed-replan`, escalate back to Planner up to `max-replans-per-task` times (default 2). Planner may revise, split, or declare infeasible.
- On replan exhaustion: `review` — the task is parked, its worktree(s) are preserved (if `worktree.keep-on-failure: true`), and the Orchestrator is notified.
- When any task enters `review`, if `orchestrator-meta-eval-after-review: true`, the Orchestrator evaluates the situation against the design docs and remaining plan, and chooses:
  - **continue** — proceed with the rest of the plan; leave reviewed tasks as known limitations.
  - **backlog** — surface unresolvable tasks to the user with full context and halt.
  - **halt** — too many critical blockers; stop entirely and summarize.

This is a reasoning step, not a heuristic — the Orchestrator uses the ledger and design docs to decide. It is what the user's phrase "Planner has retried 5 times and Coder has failed to produce a good result, should we continue working on this or put it in our backlog?" literally translates into.

## 4. Safety Constraints & Guardrails

| Constraint                    | Default Value          | Configurable? | Description |
|-------------------------------|------------------------|---------------|-----------|
| Max parallel workers          | 6                      | Yes           | Global limit on simultaneous child sessions |
| Max task depth                | 5 levels               | Yes           | Prevents infinite recursion in planning (re-plans count) |
| Max orchestrator rounds       | 40 per run             | Yes           | `max-rounds-per-run` — caps the dispatch-check-dispatch-check loop (Doc 03 §4.4). Near-exhaustion triggers orchestrator to prefer halt. |
| Timeout per micro-task        | 20 minutes             | Yes           | Auto-cancels hung tasks |
| Total AutoCrew runtime cap    | 4 hours per run        | Yes           | Hard stop |
| Worktree isolation            | Enabled by default     | Yes           | Parallel Coders cannot write outside their worktree (via `Instance.provide` binding) |
| File permission scope         | Subagent's declared permissions only (deny-down) | Yes | Subagents cannot call tools they are not granted |
| Git operations                | Integrator (v1) or smart-task's direct merge path (v0) handles branch merges; push requires explicit user approval | Yes | |
| Max retries per task          | 3                      | Yes           | Before escalating to Planner |
| Max replans per task          | 2                      | Yes           | Before entering review state |
| Token budget per role         | Soft limit (warning) — v1 feature | Yes | |

**Emergency Commands (always available):**
- `/stop-autocrew` – Immediate halt of all child sessions and the orchestrator.
- `/pause-autocrew` – Pause with full state saved to ledger.
- `/kill-session <id>` – Terminate a specific child session.
- `/cancel-task <id>` – Cancel a specific task.
- `/rollback` – Revert the last completed integration step (v1; v0 relies on git history on the primary branch).

## 5. Audit Logging

All AutoCrew activity is written under `.opencode/autocrew-state/{run_id}/`:

- `ledger.json` – Append-only timeline of every spawn, worktree op, candidate, score, selection, merge, and failure transition.
- `plan.json` – Plan with iteration history.
- `state.json` – Current run state (for resumability).
- `design-docs.md` – Concatenated ingested design docs.
- `review/{task_id}/` – For each task in review state: the preserved worktree pointer + the ledger slice + the Planner's attempts.
- `changes-{timestamp}.diff` – Exact diff of each integration step, written before write (v1 nice-to-have; v0 relies on git history).

Logs are human-readable and machine-parseable. A dedicated live Audit Trail view in the UI is a v1 concern; v0 relies on the file-based artifacts.

## 6. Testing Strategy

### Unit / Integration Tests (to be written)
- `test/smart-task-dag.test.ts` – Topological scheduling, parallel fan-out within ranks.
- `test/smart-task-worktree.test.ts` – Worktree provisioning per candidate, cleanup on loss, preservation on review state.
- `test/smart-task-selection.test.ts` – Best-candidate selection with hard filters (validator/tester) and tie-breaking (reviewer score).
- `test/smart-task-failure-policy.test.ts` – Retry → replan → review transitions and the orchestrator meta-eval hook.
- `test/ingest-design-docs.test.ts` – Parsing edge cases.
- `test/role-prompt-compliance.test.ts` – Strict enforcement of "execute-only" rules for Coder.

### End-to-End Scenarios (required before merge)

1. **Small Feature** – Add a single utility function (full-auto disabled, single Coder, no parallelism).
2. **Medium Refactor** – Extract a module with multiple files (plan approval gate, DAG with real dependencies).
3. **Parallel Candidate Selection** – Two Coders produce different solutions in separate worktrees → Reviewer/Validator score → winner merged, loser's worktree removed.
4. **Design Doc Iteration** – Plan is rejected twice before proceeding.
5. **Timeout & Retry** – One worker times out → enters `failed-retry` → completes on retry.
6. **Retry Exhaustion & Replan** – Retries exhausted → Planner revises task → succeeds on revised task.
7. **Review State** – Task cannot be resolved → enters `review` state → Orchestrator meta-evaluates → chooses `backlog` → user sees unresolved tasks with worktree pointers.
8. **Resume After Crash** – Close OpenCode mid-run → `/resume-autocrew` picks up correctly via `state.json` + `Session.children(orchestrator.sessionId)` reconciliation.
9. **Full-Auto Mode** – Zero human input after kickoff (with safety caps).
10. **Emergency Stop** – `/stop-autocrew` during heavy parallel execution cleanly terminates all child sessions and cleans up worktrees.

### Manual Validation Checklist
- All child sessions remain visible and navigable in both CLI and web UI.
- No writes happen outside per-role worktree scopes.
- Losing candidate worktrees are removed cleanly; review-state worktrees are preserved.
- Ledger contains enough detail for post-mortem analysis.
- Permission denials propagate correctly through the deny-down model.

## 7. Risk Analysis & Mitigations

- **Risk:** Runaway token spend → Mitigation: runtime cap + task depth cap + v0 free-zen-models policy.
- **Risk:** Bad code merged silently → Mitigation: mandatory Reviewer (+ Validator and Tester if configured) scoring before merge, plus final `/apply` gate.
- **Risk:** User forgets AutoCrew is running → Mitigation: periodic progress pings in the main session + visible child sessions in the UI.
- **Risk:** State corruption on resume → Mitigation: ledger is append-only + state.json is written atomically; reconciliation against live `Session.children` on resume.
- **Risk:** Worktree leaks (orphaned directories) → Mitigation: smart-task explicitly tracks worktree lifecycle in the ledger; `/stop-autocrew` runs cleanup; worktree inventory exposed via `/status`.
- **Risk:** Orchestrator loops forever on meta-eval → Mitigation: total-runtime-hours hard cap and max-task-depth cap.

## 8. Final Success Criteria for Safety

1. AutoCrew can be left running unattended without fear of destructive changes to the primary workspace (worktree isolation guarantees this for parallel execution; Integrator + `/apply` gate guarantees this for merges).
2. Every change is traceable to a specific task, role, candidate, and selection decision via the run ledger.
3. A user can always regain full manual control or revert in under 10 seconds via emergency commands.
4. The system passes all defined end-to-end scenarios with zero manual intervention except where explicitly configured.

---

**This concludes the AutoCrew design document series (series v1.2 / Doc 08 v1.0).**

**Recommended Next Steps:**
1. Review the full set of 8 documents (01–08) as a complete spec. Doc 08 is the orchestrator system prompt and belongs in the review.
2. Implement v0 (see Doc 01 §9 for scope): smart-task tool with DAG + worktree fan-out + best-candidate selection + failure state machine, plus Planner/Coder/Reviewer role definitions, the orchestrator system prompt (Doc 08), and the core slash commands.
3. Exercise end-to-end on a small feature using free `zen` models (e.g. `big-pickle`) to validate the pipeline at zero cost. Measure against the iteration metrics in Doc 08 §7.
4. Once v0 is stable, extend to v1: full 6-role crew, concurrent `ops.prompt` fan-out, provider-tuned model selection, dedicated audit UI, token budgeting.

These eight documents together form the complete, self-contained blueprint for AutoCrew Mode.
