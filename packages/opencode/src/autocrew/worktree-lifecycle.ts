export * as WorktreeLifecycle from "./worktree-lifecycle"

import { Effect } from "effect"
import { Instance } from "../project/instance"
import { Worktree } from "../worktree"

/**
 * Dispose the instance cache for a worktree directory, then remove the worktree.
 * This is the correct cleanup order — sessions/tools that were running in the
 * worktree's instance context must be detached before the directory is deleted,
 * or later file operations will fail on the removed path.
 *
 * See packages/opencode/test/project/worktree.test.ts for the canonical pattern.
 */
export const disposeAndRemoveWorktree = Effect.fn("WorktreeLifecycle.disposeAndRemove")(function* (directory: string) {
  // Dispose the instance context bound to this worktree directory.
  // We enter the worktree's context, dispose it from inside (which clears the cache and emits the Disposed event), then exit.
  yield* Effect.promise(() =>
    Instance.provide({
      directory,
      fn: async () => {
        await Instance.dispose()
      },
    }).catch(() => undefined),
  )

  // Remove the git worktree itself.
  const svc = yield* Worktree.Service
  return yield* svc.remove({ directory }).pipe(Effect.catch(() => Effect.succeed(false)))
})

/**
 * Generate a worktree name for an AutoCrew candidate. Must fit git branch
 * naming (opencode/ prefix is applied by the Worktree service).
 */
export function candidateWorktreeName(planId: string, taskId: string, candidateId: number): string {
  const slug = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "x"
  return `${slug(planId)}-${slug(taskId)}-${candidateId}`
}
