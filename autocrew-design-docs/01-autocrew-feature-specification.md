# 01-autocrew-feature-specification.md

**AutoCrew Mode – Feature Specification**
**Document Version:** 1.3
**Date:** April 21, 2026
**Author:** Jim
**Status:** Draft – for implementation by Claude Code / future AutoCrew

## 1. Overview

AutoCrew is a new **fully automatic multi-agent orchestration mode** for OpenCode that allows a user to provide a set of comprehensive design documents and a high-level goal, then have the system independently plan, implement, review, test, and integrate the entire feature with minimal or zero human intervention.

The system is built around one **heavy, thoughtful orchestrator** and multiple **fast, specialized subagents** running in parallel background child sessions. Each parallel worker runs in its own **git worktree** (reusing OpenCode's existing `Worktree` service) so candidate solutions are physically isolated and can be evaluated, picked, and merged using real objective signals (tests, lint, review scores) rather than voting over conflicting diffs.

It follows a CrewAI-inspired role-based structure while staying entirely within OpenCode's existing session, Task, command, and worktree infrastructure.

## 2. Primary Goals

- Enable true "design-docs-first" development: the user drops design documentation and a goal, then walks away while the system does the work.
- Separate slow, high-quality reasoning (planning, review, iteration) from fast execution (coding, validation, testing).
- Provide automatic parallel execution of independent micro-tasks with a best-candidate selection mechanism backed by worktree isolation.
- Maintain full visibility and inspectability of all sub-sessions via OpenCode's existing session navigation.
- Be configurable between fully automatic and gated (human-in-the-loop) modes.
- Be resumable across OpenCode restarts via an orchestrator-owned run ledger.

## 3. Desired User Experience

1. User starts a new session or existing session and types `/autocrew` (or sets the `autocrew` agent as primary).
2. User provides (or references) a folder of design documents and a high-level goal.
3. Orchestrator automatically:
   - Ingests and parses all design documents.
   - Generates an initial detailed implementation plan.
   - (Optional) Presents the plan for quick approval/iteration.
4. Once the plan is accepted (or if `full-auto: true`), the Orchestrator spawns role-based subagents in parallel child sessions, each in its own worktree where isolation is needed.
5. Subagents execute their roles independently; parallel agents on the same task produce candidate solutions in separate worktrees and are scored by Reviewer/Validator/Tester roles.
6. Orchestrator continuously monitors, picks the winning candidate, merges approved changes, runs tests, and iterates until the feature is complete.
7. Final summary is presented to the user with a single approval step for the complete changeset.
8. User can at any time inspect any live child session using OpenCode's existing session navigation (both CLI TUI and web UI).

The entire flow should feel like handing a complete spec to a senior engineering team that works silently and efficiently, only surfacing when truly necessary.

## 4. Core Features

- **Design Document Ingestion** – Automatic parsing of a designated folder or set of Markdown files.
- **Dynamic Role-Based Crews** – Planner, Coder, Reviewer, Validator, Tester, Integrator (and extensible).
- **Worktree-Isolated Parallel Execution** – Multiple instances of the same role can work on the same micro-task simultaneously in separate git worktrees.
- **Best-Candidate Selection** – Candidates are scored by Reviewer/Validator/Tester; the orchestrator (or a dedicated Integrator role) arbitrates and merges the winner.
- **Background Child Sessions** – All workers run as child sessions that persist and are fully inspectable in the CLI TUI and web UI.
- **Iterative Planning** – Orchestrator can self-critique and refine plans against the original design docs.
- **Automatic Failure Handling** – Bounded retry → escalate to Planner for re-plan → fall back to a "review" state → orchestrator renders a continue / backlog / halt verdict (meta-evaluation). See §7 of Doc 05 and §3 of Doc 07; the exact orchestrator decision protocol is in Doc 08 §3.
- **Safety & Gating** – Configurable full-auto mode, plan approval gates, per-task/per-run budgets, and per-role permission restriction.
- **Resumability** – AutoCrew state is saved (orchestrator ledger) so a run can be paused and resumed later.
- **Audit Logging** – Full trace of every spawned task, decision, candidate, and merge.

## 5. Supported Roles (minimum set)

| Role        | Model Type       | Primary Responsibility                     | Key Constraint                  |
|-------------|------------------|--------------------------------------------|---------------------------------|
| Planner     | Heavy            | Plan generation, iteration, task breakdown | Thoughtful, detail-oriented     |
| Coder       | Fast             | Pure code generation/editing               | Execute-only, no questions      |
| Reviewer    | Heavy or Medium  | Code quality, security, architecture review | Critical, thorough             |
| Validator   | Fast             | Unit/integration tests, linting            | Strict pass/fail                |
| Tester      | Fast             | End-to-end & UI testing (Playwright etc.)  | Comprehensive coverage          |
| Integrator  | Medium/Heavy     | Conflict resolution, final merge           | Careful, conservative           |

Additional roles can be defined by the user in configuration. Model choices are provider-agnostic; see Doc 03 for how v0 defaults to free models on the `zen` provider and v1+ enables provider-specific selection.

## 6. Non-Goals

- Replacing OpenCode's existing single-agent or manual multi-agent workflows.
- Building a new UI or frontend (we must reuse existing CLI TUI + web UI).
- Infinite parallelism or unlimited token spend (must respect configurable limits).

## 7. Success Criteria

1. User can provide only design docs + goal and receive a fully working, reviewed, tested implementation.
2. No manual session-switching or copy-pasting between agents is required.
3. Parallel sub-sessions are visible and navigable in both CLI and web UI via OpenCode's existing navigation.
4. Best-candidate selection via worktree-isolated Coders demonstrably improves output quality over single-agent runs.
5. Feature can be implemented as a single, well-scoped addition (primarily extending the Task tool + adding a smart-task orchestration layer).

## 8. Assumptions & Constraints

- OpenCode's existing child-session, Task tool, command registry, and `Worktree` service remain stable and usable.
- Implementation must be backward-compatible with current `opencode.json` and agent definitions.
- All new functionality must be opt-in via configuration.
- v0 defaults all roles to free `zen` models (e.g. `big-pickle`) so the system can be tested end-to-end at zero cost. Provider-specific overrides are supported from day one but tuned model selection (Anthropic/OpenAI/xAI) is a v1 concern.

## 9. v0 vs v1 Scope

The architecture and abstractions described across all 8 docs must be designed in v0 so that v1 is a trivial extension. However, the v0 feature surface is intentionally narrower than the full vision.

### v0 must include (core abstractions — do not defer)

- Task DAG executor (topological order, with serial-within-rank fan-out in v0).
- Worktree-isolated candidate workers via the existing `Worktree` service + `Instance.provide({ directory })` binding.
- Orchestrator run-ledger + `session.plan()` anchor (for provenance, best-candidate selection input, resumability, and compaction resilience).
- Automatic failure-handling state machine (retry → replan → review → backlog).
- `max-rounds-per-run` cap enforcement on the orchestrator loop.
- Slash command surface: `/autocrew`, `/pause-autocrew`, `/resume-autocrew`, `/stop-autocrew`, `/status`, `/apply`.
- A minimum viable role set: **Planner + Coder + Reviewer** (single-Coder per task is acceptable to prove the pipeline; multi-Coder selection is v0 if feasible but not required).
- Orchestrator system prompt (see Doc 08) that implements the plan → dispatch → collect → arbitrate → loop/finish discipline on top of opencode's existing `SubtaskPart` + `runLoop` + synthetic-user-continuation machinery.

### v0 may defer to v1

- True concurrent parallel execution of multi-candidate workers. v0 runs candidates serially (one `SubtaskPart` per worker, drained by the existing `runLoop`). Isolation is still guaranteed via per-worker worktrees; only wall-clock execution is serialized. v1 switches `smart-task` internals to concurrent `ops.prompt` — the orchestrator's interface is unchanged.
- Full 6-role crew (Validator + Tester + Integrator as distinct roles — v0 can fold validation into the Reviewer).
- Multiple consensus strategies beyond orchestrator-arbitrated best-candidate selection.
- Token budgeting with soft warnings.
- Dedicated Audit Trail view in the UI (file-based logs are sufficient for v0).
- Provider-tuned default models (v0 uses free `zen` defaults only).

All v1 deferrals must still be representable in the config schema, orchestrator state machine, and smart-task API so that enabling them later is additive, not a refactor.
