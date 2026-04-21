import { describe, expect } from "bun:test"
import { e2eTest, testModel } from "./_helpers"

describe("E2E 01: small feature (single utility, no parallelism)", () => {
  e2eTest(
    "AutoCrew adds a single utility function and produces a clean changeset",
    async () => {
      // SCENARIO (per Doc 07 §6 #1):
      //   - Spin up a tmp git repo with a minimal autocrew-design-docs/ folder.
      //   - Configure autocrew with full_auto: false, single coder, no parallelism.
      //   - Goal: "Add a utility function add(a, b) in src/util/add.ts with tests".
      //   - Approve the plan when prompted.
      //   - Assert: plan.json exists, ledger has task-completed events, state.json
      //     phase is completed, the winning worktree's branch contains the new file
      //     and tests, /apply merges cleanly into the primary branch.
      //
      // Implementation hooks the system needs in order to write this fully:
      //   - A way to start an autocrew run from a test (provideTmpdirInstance + spawn
      //     the autocrew agent via Session.create + ops.prompt).
      //   - A way to inject the user's "approve" response between plan-approval and
      //     execution phases.
      //
      // The model used is from testModel() — defaults to zen/big-pickle (free).
      expect(testModel()).toBeDefined()
      throw new Error("E2E 01 not yet implemented; see Doc 07 §6 for the scenario script")
    },
    600000,
  )
})
