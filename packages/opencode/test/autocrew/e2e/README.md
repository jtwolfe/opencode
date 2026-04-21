# AutoCrew E2E scenarios

These scenarios exercise the full AutoCrew pipeline against a real LLM. They are gated behind the `AUTOCREW_E2E=1` environment variable so they don't run on every `bun test` (the model calls are slow and may incur cost on non-free providers).

## Running

```bash
# Default: run against the free zen/big-pickle model.
AUTOCREW_E2E=1 bun test test/autocrew/e2e/

# Override the model used by all roles for testing.
AUTOCREW_E2E=1 AUTOCREW_TEST_MODEL=anthropic/claude-sonnet-4-6 bun test test/autocrew/e2e/

# Single scenario.
AUTOCREW_E2E=1 bun test test/autocrew/e2e/01-small-feature.test.ts
```

## Scenario coverage (per Doc 07 §6)

1. **01-small-feature** — Single utility function, no parallelism, plan approval gate.
2. **03-parallel-candidate-selection** — `parallel_count: 2` coder, reviewer scores both, winner merged, loser cleaned up.
3. **05-timeout-retry** — Worker times out once, retries on second attempt and succeeds.
4. **06-replan-after-retry-exhaustion** — All retries fail, Planner revises the task, revised task succeeds.
5. **07-review-state-meta-eval** — Replans exhaust, task enters review, orchestrator chooses backlog verdict.
6. **08-resume-after-crash** — Run is interrupted mid-execution, `/resume-autocrew` picks up cleanly.
7. **09-full-auto** — Zero user intervention after kickoff with `full_auto: true`.
8. **10-emergency-stop** — `/stop-autocrew` during heavy parallel execution cleans up all worktrees.

## Why gated?

- Each scenario performs multiple real LLM round-trips (planner → coders → reviewer × N → integrator).
- Free `zen/big-pickle` has no SLA — flaky responses are expected.
- Provider rate limits are hit easily when scenarios run in parallel.
- A full E2E pass takes ~10–20 minutes; running on every commit is wasteful.

## How to add a new scenario

1. Create `NN-name.test.ts` in this directory.
2. Use `e2eTest()` (defined in `_helpers.ts`) which skips if `AUTOCREW_E2E !== "1"`.
3. Set up a tmpdir git repo with `tmpdirScoped({ git: true })`.
4. Drop a minimal `autocrew-design-docs/` folder into the tmpdir.
5. Spawn an autocrew session and assert on the run state, ledger, and final diff.
