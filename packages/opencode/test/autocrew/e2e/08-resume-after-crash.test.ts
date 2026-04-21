import { describe, expect } from "bun:test"
import { e2eTest, testModel } from "./_helpers"

describe("E2E 08: resume after crash", () => {
  e2eTest(
    "/resume-autocrew picks up after mid-run interruption and completes the plan",
    async () => {
      // SCENARIO (per Doc 07 §6 #8):
      //   1. Start an autocrew run; let task t1 complete and t2 begin.
      //   2. Forcibly terminate the orchestrator session before t2 finishes.
      //   3. Verify state.json has t2 in 'running' state with a stale candidate session.
      //   4. Trigger /resume-autocrew.
      //   5. Verify Resume.loadResumeContext reset t2 to 'pending'.
      //   6. Verify t2 redispatches and the run completes successfully.
      //   7. Final state.json phase is 'completed' and the diff matches expectation.
      expect(testModel()).toBeDefined()
      throw new Error("E2E 08 not yet implemented; see Doc 07 §6 for the scenario script")
    },
    900000,
  )
})
