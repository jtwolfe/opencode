# CLAUDE.md

This file orients Claude sessions working in the opencode repository. For coding conventions and style rules, see [AGENTS.md](AGENTS.md); for contributor process, see [CONTRIBUTING.md](CONTRIBUTING.md); for threat model and sandbox behavior, see [SECURITY.md](SECURITY.md).

## What this project is

Opencode is an open-source, provider-agnostic AI coding agent with a TUI-first design and a client/server architecture that enables local execution with remote control. See [README.md](README.md) for the full description.

## Current focus: AutoCrew

The active development focus is **AutoCrew**, a fully automatic multi-agent orchestration mode that turns design docs plus a high-level goal into a working, reviewed, tested implementation without human intervention between plan approval and final changeset approval. It rides on opencode's existing session, subtask, and worktree infrastructure rather than adding new loop machinery.

The complete design lives in [`autocrew-design-docs/`](autocrew-design-docs/). Read in this order:

- **Doc 01** — feature spec and v0/v1 scope (start here).
- **Doc 02** — architecture, including the `SubtaskPart` + `runLoop` + `Instance.provide` wiring.
- **Doc 05** — the `smart-task` tool (the main code addition).
- **Doc 08** — the orchestrator system prompt.

Docs 03 (config schema), 04 (role definitions), 06 (UX), and 07 (safety + testing) are reference material — consult them when working on the specific area each covers.

## How to work here

### Work continuously
Minimize handoffs back to the user. Once a task is underway, keep it moving. Complete the work end-to-end — including typechecks and tests — before stopping. Treat "I need to ask a question" as a last resort, not a default.

### When something breaks, solve it
When you hit a fault, conflict, or unfamiliar system:

1. **Investigate first.** Read the actual code, the test failures, the error traces. Don't guess.
2. **Research when the code isn't enough.** Use web search and documentation lookups for unfamiliar APIs, error messages, or established patterns. The autocrew docs themselves were built this way — see Doc 02 §5 and Doc 08 §8 for examples of research-grounded design decisions.
3. **Reason critically.** Before applying a fix, ask whether it addresses the root cause or just masks the symptom. Prefer root-cause fixes; when you must ship a workaround, say so explicitly and record the real problem.
4. **Escalate only for genuine ambiguity.** Missing requirements, contradictory design docs, or irreversible decisions that need user judgment warrant stopping. A failing test or an unfamiliar library does not.

## Repo conventions

- **Default branch is `dev`** (not `main`). Use `origin/dev` for diffs and base new work on it unless told otherwise.
- **Run tests and typechecks from package directories** (e.g. `cd packages/opencode && bun typecheck && bun test`), never from the repo root.
- Coding style rules live in [AGENTS.md](AGENTS.md). PR title conventions and the issue-first policy live in [CONTRIBUTING.md](CONTRIBUTING.md).

## Tone

Be terse in user-facing output. State outcomes and what's next; skip the preamble. The user can read the diff.
