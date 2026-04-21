# 06-autocrew-workflow-and-user-experience.md

**AutoCrew Mode – Workflow and User Experience**
**Document Version:** 1.2
**Date:** April 21, 2026
**Author:** Jim
**Status:** Draft – for implementation by Claude Code / future AutoCrew

## 1. Purpose

This document describes the exact end-to-end user experience and command flows for AutoCrew Mode. It is written so that both the Orchestrator (heavy model) and the implementing developer have a crystal-clear picture of how a user will interact with the feature from start to finish.

The goal is to make the experience feel as close as possible to "drop my design docs and walk away" while still giving the user full visibility and control when desired.

## 2. Starting AutoCrew

### Primary ways to launch
1. **Command** – Type `/autocrew` in any session.
   This instantly switches the primary agent to AutoCrew mode and begins the workflow.
2. **Configuration** – Set the primary agent in `opencode.json` to the `autocrew` agent so every new session starts in AutoCrew mode automatically.

### Initial Kickoff Prompt
After launching, the user can simply say:

```
Here are my design documents: autocrew-design-docs/
Goal: Implement the new payment processing module as described.
```

Or reference individual files if preferred.

## 3. Full End-to-End Workflow

1. **Ingestion Phase** (automatic)
   - `ingest-design-docs` tool scans the folder and writes the concatenated + parsed content to the run ledger at `.opencode/autocrew-state/{run_id}/design-docs.md`.
   - Orchestrator acknowledges with a short confirmation: "Design docs ingested. 7 documents parsed. Ready to plan."

2. **Planning Phase**
   - Orchestrator (heavy model) generates a detailed implementation plan (a DAG of micro-tasks).
   - If `require-initial-plan-approval: true` (default), it presents the plan and asks:
     "Here is the proposed plan. Approve, iterate, or provide feedback?"
   - User can reply with "approve", "iterate once", or specific changes.
   - If `full-auto: true`, this step is skipped and the system proceeds immediately.

3. **Execution Phase** (fully automatic)
   - Orchestrator calls `smart-task` with the structured task list.
   - For each parallel-capable task, `smart-task` provisions isolated git worktrees (via `@opencode/Worktree`) and spawns role-based child sessions — one per candidate.
   - User sees a live progress summary in the main session (e.g. "3/8 tasks completed • 2 coders running in worktrees • 1 reviewer scoring candidates").
   - All child sessions are visible and can be inspected via OpenCode's existing session navigation in both CLI and web UI.

4. **Selection & Integration Phase**
   - Parallel candidates are scored by Reviewer/Validator/Tester roles.
   - The Orchestrator picks the best candidate and hands it to the Integrator (or merges directly if no Integrator role is configured).
   - Losing worktrees are cleaned up automatically. Tasks that failed all retries + replans are left in a "review" state with their worktrees preserved for inspection.

5. **Completion & Final Approval**
   - Orchestrator presents a single clean summary:
     "Feature complete. 14 files modified. All tests passing. Review changeset?"
   - If any tasks are in review state, the summary lists them with pointers to their preserved worktrees:
     "2 tasks unresolved — see `.opencode/autocrew-state/{run_id}/review/` for details."
   - User can approve the entire changeset with one command (`/apply` or "yes") or request changes.

6. **Resumability**
   - At any point the user can type `/pause-autocrew` or simply close OpenCode.
   - On next launch, typing `/resume-autocrew` picks up exactly where it left off (state is saved in `.opencode/autocrew-state/{run_id}/state.json`).

## 4. Key Commands Available During AutoCrew

| Command                    | Effect | v0 / v1 |
|----------------------------|--------|---------|
| `/autocrew`                | Start or switch to AutoCrew mode | v0 |
| `/pause-autocrew`          | Pause all background tasks | v0 |
| `/resume-autocrew`         | Resume from last checkpoint | v0 |
| `/cancel-task <id>`        | Cancel a specific running task | v0 |
| `/status`                  | Show live progress of all sub-sessions (incl. candidate worktrees) | v0 |
| `/apply`                   | Approve and merge the final changeset | v0 |
| `/stop-autocrew`           | Halt the current run and all child sessions | v0 |
| `/kill-session <id>`       | Terminate a specific child session | v0 |
| `/full-auto on`            | Switch to zero-intervention mode mid-run | v0 |
| `/rollback`                | Revert the last completed integration step | v1 (v0 relies on git history on the primary branch) |

Slash commands are defined as markdown files in `.opencode/command/` and loaded through OpenCode's existing command registry.

## 5. Visibility in UI

- **Main session** – User stays here the entire time and receives high-level updates only.
- **Child sessions** – All subagents run as normal OpenCode child sessions (via `Session.create({ parentID })`). They appear in the session list and can be inspected live using OpenCode's existing session navigation. Exact keybindings and UI affordances are whatever the TUI/web UI already expose — no new navigation is introduced.
- **Candidate worktrees** – Listed in `/status` output by task id + candidate id + worktree directory, so the user can open the directory in a file browser or editor if desired.
- **Audit trail** – All run data lives under `.opencode/autocrew-state/{run_id}/`. A dedicated Audit Trail view in the UI is a v1 nice-to-have; v0 relies on the file-based ledger.

## 6. Example User Session Transcript (abbreviated)

```
User: /autocrew
Orchestrator: AutoCrew mode enabled. Provide design docs and goal.
User: Here are my design documents: autocrew-design-docs/ Goal: Add subscription billing.
Orchestrator: Design docs ingested (7 files). Generating plan...
Orchestrator: Plan ready (11 tasks, 3 with parallel coders). Approve or iterate?
User: approve
Orchestrator: Starting AutoCrew execution...
[progress updates every 30–60 seconds]
Orchestrator: Task-004 coder candidates: 2 produced, validator passed on both, reviewer picked candidate 1 (score 94).
Orchestrator: Task-007 failed validator twice, replanning... (1/2 replans)
Orchestrator: All tasks complete. 11 files changed. All tests passing. 0 tasks in review.
Orchestrator: Ready to apply changes. /apply ?
```

## 7. Design Principles for the Experience

- **Minimal interruption** – The heavy model only speaks to the user at deliberate gates.
- **Maximum transparency** – Every background action is inspectable (sessions, worktrees, ledger).
- **One-click control** – No need to manually switch agents or copy-paste tasks.
- **Graceful degradation** – If the user prefers manual control at any point, they can inspect any subagent session or candidate worktree and take over.
- **No invented UI** – AutoCrew rides entirely on OpenCode's existing session list, command palette, and progress display. No new shortcuts, panels, or views are required for v0.
