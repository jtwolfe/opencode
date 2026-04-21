# 03-autocrew-configuration-schema.md

**AutoCrew Mode – Configuration Schema**
**Document Version:** 1.2
**Date:** April 21, 2026
**Author:** Jim
**Status:** Draft – for implementation by Claude Code / future AutoCrew

## 1. Purpose

This document defines the exact changes and new schema that will be added to `opencode.json` to support AutoCrew Mode. The design prioritizes:
- Minimal disruption to existing OpenCode users and configurations.
- Full backward compatibility.
- Easy extensibility for new roles and future model providers.
- Clear separation between the primary AutoCrew agent and its subagents.
- Provider-agnostic model selection (v0 defaults to free `zen` models; v1 tunes per provider).

## 2. Top-Level Changes to opencode.json

A new optional top-level key `"autocrew"` is added at the root level.
Inside each agent definition, a new optional object `"autocrew"` can be added when `mode` is `"primary"`.

All existing OpenCode configuration remains unchanged and fully functional.

## 3. Full Schema Definition

```json
{
  "agents": {
    "autocrew": {
      "mode": "primary",
      "model": "zen/big-pickle",
      "tools": ["read", "write", "bash", "task", "smart-task", "ingest-design-docs"],

      "autocrew": {
        "enabled": true,
        "max-parallel-workers": 6,
        "roles": ["planner", "coder", "reviewer", "validator", "tester", "integrator"],
        "selection-strategy": "best-candidate",
        "plan-iteration-rounds": 2,
        "require-initial-plan-approval": true,
        "full-auto": false,
        "timeout-per-task-minutes": 20,
        "default-worker-model": "zen/big-pickle",

        "failure-policy": {
          "max-retries-per-task": 3,
          "max-replans-per-task": 2,
          "review-state-on-exhaustion": true,
          "orchestrator-meta-eval-after-review": true
        },

        "worktree": {
          "enabled": true,
          "cleanup-losing-candidates": true,
          "keep-on-failure": true
        },

        "budget": {
          "total-runtime-hours": 4,
          "max-task-depth": 5,
          "max-rounds-per-run": 40
        }
      }
    }
  },

  "subagents": {
    "planner": {
      "mode": "subagent",
      "hidden": true,
      "model": "zen/big-pickle",
      "system-prompt": "..."
    },
    "coder": {
      "mode": "subagent",
      "hidden": true,
      "model": "zen/big-pickle",
      "system-prompt": "You are a pure execution coder. Output only code or error messages. Never ask questions or explain."
    }
  }
}
```

## 4. Detailed autocrew Configuration Options

### 4.1 Top-level

| Option                          | Type    | Default             | Description |
|---------------------------------|---------|---------------------|-------------|
| `enabled`                       | boolean | false               | Turns AutoCrew on for this primary agent |
| `max-parallel-workers`          | integer | 6                   | Global limit on simultaneous child sessions |
| `roles`                         | array   | [...]               | List of role names that AutoCrew is allowed to use |
| `selection-strategy`            | string  | "best-candidate"    | v0 supports `best-candidate` only (Reviewer/Validator/Tester score candidates, orchestrator picks winner). `majority`, `all-agree`, `orchestrator-vote` reserved for v1. |
| `plan-iteration-rounds`         | integer | 2                   | How many times the Planner may self-critique before execution |
| `require-initial-plan-approval` | boolean | true                | Show plan to user for approval before spawning workers |
| `full-auto`                     | boolean | false               | If true, skips all human gates after initial kickoff |
| `timeout-per-task-minutes`      | integer | 20                  | Maximum runtime per micro-task before cancellation |
| `default-worker-model`          | string  | "zen/big-pickle"    | Fallback model for any role without explicit model |

### 4.2 `failure-policy`

Drives the automatic retry/replan/review state machine (see Doc 05 §7 and Doc 07 §3).

| Option                               | Type    | Default | Description |
|--------------------------------------|---------|---------|-------------|
| `max-retries-per-task`               | integer | 3       | Bounded same-task retries before escalating to Planner for re-plan |
| `max-replans-per-task`               | integer | 2       | How many times Planner may re-plan a failing task before it enters "review" state |
| `review-state-on-exhaustion`         | boolean | true    | If both budgets are exhausted, task moves to review state rather than failing the run |
| `orchestrator-meta-eval-after-review`| boolean | true    | Orchestrator evaluates "should we continue, halt, or move to backlog?" when any task is in review state |

### 4.3 `worktree`

| Option                        | Type    | Default | Description |
|-------------------------------|---------|---------|-------------|
| `enabled`                     | boolean | true    | Use `@opencode/Worktree` to isolate parallel Coder sessions. If false, parallel candidates share the primary worktree (not recommended). |
| `cleanup-losing-candidates`   | boolean | true    | Automatically `Worktree.remove` candidates not selected |
| `keep-on-failure`             | boolean | true    | If a task enters "review" state, keep its worktree(s) so the user can inspect them |

### 4.4 `budget`

| Option                   | Type    | Default | Description |
|--------------------------|---------|---------|-------------|
| `total-runtime-hours`    | number  | 4       | Hard stop for an AutoCrew run |
| `max-task-depth`         | integer | 5       | Prevents infinite recursion in planning (re-plans count against depth) |
| `max-rounds-per-run`     | integer | 40      | Hard cap on orchestrator LLM rounds per run. Each time the orchestrator re-enters the LLM after a subtask completes counts as one round. Prevents the "dispatch-check-dispatch-check" runaway failure mode documented in hierarchical CrewAI-style managers. When exceeded, the run enters halt state and summarizes. |

## 5. Example 1: v0 Test Setup (Recommended — free zen models)

```json
{
  "agents": {
    "autocrew": {
      "mode": "primary",
      "model": "zen/big-pickle",
      "tools": ["read", "write", "bash", "task", "smart-task", "ingest-design-docs"],
      "autocrew": {
        "enabled": true,
        "max-parallel-workers": 4,
        "roles": ["planner", "coder", "reviewer"],
        "selection-strategy": "best-candidate",
        "plan-iteration-rounds": 2,
        "require-initial-plan-approval": true,
        "full-auto": false,
        "default-worker-model": "zen/big-pickle"
      }
    }
  },
  "subagents": {
    "planner":  { "mode": "subagent", "hidden": true, "model": "zen/big-pickle" },
    "coder":    { "mode": "subagent", "hidden": true, "model": "zen/big-pickle" },
    "reviewer": { "mode": "subagent", "hidden": true, "model": "zen/big-pickle" }
  }
}
```

Alternative free zen models for testing: `zen/nemotron-3-super-free`, `zen/minimax-m2.5-free`.

## 6. Example 2: v1 Mixed-Provider Setup (Future-proof)

```json
{
  "agents": {
    "autocrew": {
      "mode": "primary",
      "model": "anthropic/claude-opus-4-7",
      "autocrew": {
        "enabled": true,
        "max-parallel-workers": 8,
        "roles": ["planner", "coder", "reviewer", "validator", "tester", "integrator"]
      }
    }
  },
  "subagents": {
    "planner":   { "mode": "subagent", "hidden": true, "model": "anthropic/claude-opus-4-7" },
    "coder":     { "mode": "subagent", "hidden": true, "model": "xai/grok-code-fast-1" },
    "reviewer":  { "mode": "subagent", "hidden": true, "model": "openai/gpt-5-codex" },
    "validator": { "mode": "subagent", "hidden": true, "model": "zen/gpt-5.4-mini" },
    "tester":    { "mode": "subagent", "hidden": true, "model": "zen/gpt-5.4-mini" },
    "integrator":{ "mode": "subagent", "hidden": true, "model": "anthropic/claude-sonnet-4-6" }
  }
}
```

## 7. Backward Compatibility Rules

- If `autocrew.enabled` is not present or `false`, OpenCode behaves exactly as it does today.
- All existing agents and subagents continue to work unchanged.
- The new `smart-task` tool gracefully falls back to the existing `task` behavior if AutoCrew is not active (single-session spawn, no worktree isolation, no candidate selection).
- Existing custom system prompt files in `.opencode/agent/` are respected and take precedence.

## 8. Validation Rules (to be enforced at startup)

- At least one role must be defined in the `roles` array.
- Every role listed in `roles` must have a matching entry under `subagents`.
- `max-parallel-workers` must be between 1 and 12.
- `worktree.enabled: true` requires the project to be a git repository (the `Worktree` service throws `NotGitError` otherwise).
- v0 only: `selection-strategy` must be `"best-candidate"`.
- `failure-policy.max-retries-per-task` + `failure-policy.max-replans-per-task` must be ≥ 1 combined.
