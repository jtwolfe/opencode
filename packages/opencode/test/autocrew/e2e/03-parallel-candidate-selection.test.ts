import { describe, expect } from "bun:test"
import { e2eTest, testModel } from "./_helpers"

describe("E2E 03: parallel candidate selection", () => {
  e2eTest(
    "Two coders produce candidates, reviewer scores both, winner merged, loser worktree removed",
    async () => {
      // SCENARIO (per Doc 07 §6 #3):
      //   - Plan a task with parallel_count: 2 (coder).
      //   - Two worktrees provisioned, two coder dispatches, two reviewer scores.
      //   - Selection picks the higher-scored candidate.
      //   - Loser's worktree is removed; winner's branch is preserved/merged.
      //   - Assert: ledger contains worktree-created x2, candidate-received x2,
      //     score-assigned x2, candidate-selected x1, worktree-removed x1.
      //   - Assert: only the winning branch is present in `git branch -a` after run.
      expect(testModel()).toBeDefined()
      throw new Error("E2E 03 not yet implemented; see Doc 07 §6 for the scenario script")
    },
    900000,
  )
})
