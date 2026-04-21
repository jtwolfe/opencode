import { test } from "bun:test"

/**
 * Test wrapper that skips unless AUTOCREW_E2E=1. Use for any scenario that
 * makes real LLM calls or takes meaningful wall-clock time.
 */
export function e2eTest(name: string, fn: () => void | Promise<void>, timeout?: number) {
  const enabled = process.env.AUTOCREW_E2E === "1"
  if (enabled) {
    test(name, fn, timeout)
  } else {
    test.skip(name, fn)
  }
}

/**
 * Pick the model under test. Defaults to the free zen/big-pickle so contributors
 * can run without paying. Override with AUTOCREW_TEST_MODEL.
 */
export function testModel(): string {
  return process.env.AUTOCREW_TEST_MODEL ?? "zen/big-pickle"
}
