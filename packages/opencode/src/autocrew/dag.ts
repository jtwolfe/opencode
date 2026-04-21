export * as Dag from "./dag"

import type { TaskSpec } from "./types"

export class DagValidationError extends Error {
  constructor(
    message: string,
    public readonly issues: string[],
  ) {
    super(`${message}: ${issues.join("; ")}`)
    this.name = "DagValidationError"
  }
}

/**
 * Validate a list of TaskSpecs against these rules:
 *  - Every id is non-empty and unique.
 *  - Every entry in depends_on references an existing task id.
 *  - The dependency graph has no cycles.
 *
 * Throws DagValidationError with a collected list of issues when invalid.
 */
export function validateDag(tasks: TaskSpec[]): void {
  const issues: string[] = []
  const seen = new Set<string>()
  const byId = new Map<string, TaskSpec>()

  for (const t of tasks) {
    if (!t.id) {
      issues.push("task with empty id")
      continue
    }
    if (seen.has(t.id)) {
      issues.push(`duplicate task id: ${t.id}`)
      continue
    }
    seen.add(t.id)
    byId.set(t.id, t)
  }

  for (const t of tasks) {
    for (const dep of t.depends_on ?? []) {
      if (!byId.has(dep)) {
        issues.push(`task '${t.id}' depends on unknown task '${dep}'`)
      }
    }
  }

  // Cycle detection via DFS with tri-color marking.
  type Color = "white" | "gray" | "black"
  const color = new Map<string, Color>()
  for (const id of byId.keys()) color.set(id, "white")

  const cycleStack: string[] = []
  const cycle = (id: string): string[] | undefined => {
    color.set(id, "gray")
    cycleStack.push(id)
    const deps = byId.get(id)?.depends_on ?? []
    for (const dep of deps) {
      if (!byId.has(dep)) continue
      const c = color.get(dep)
      if (c === "gray") {
        const start = cycleStack.indexOf(dep)
        return [...cycleStack.slice(start), dep]
      }
      if (c === "white") {
        const found = cycle(dep)
        if (found) return found
      }
    }
    cycleStack.pop()
    color.set(id, "black")
    return undefined
  }

  for (const id of byId.keys()) {
    if (color.get(id) !== "white") continue
    const found = cycle(id)
    if (found) {
      issues.push(`cycle detected: ${found.join(" -> ")}`)
      break
    }
  }

  if (issues.length) throw new DagValidationError("invalid task DAG", issues)
}

/**
 * Group tasks into topological ranks. Each rank is a list of tasks whose
 * dependencies are all satisfied by earlier ranks. Within a rank, tasks are
 * independent and could theoretically be dispatched concurrently (v0 runs them
 * serially; v1 parallelizes).
 *
 * Preserves insertion order within a rank so deterministic for testing.
 * Assumes the DAG has already been validated (no cycles, no unknown deps).
 */
export function topologicalRanks(tasks: TaskSpec[]): TaskSpec[][] {
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const remaining = new Map<string, Set<string>>()
  for (const t of tasks) {
    remaining.set(t.id, new Set(t.depends_on ?? []))
  }

  const order = tasks.map((t) => t.id) // preserves insertion order
  const ranks: TaskSpec[][] = []
  const done = new Set<string>()

  while (done.size < tasks.length) {
    const rank: TaskSpec[] = []
    for (const id of order) {
      if (done.has(id)) continue
      const deps = remaining.get(id)!
      const blocked = [...deps].some((dep) => !done.has(dep))
      if (!blocked) rank.push(byId.get(id)!)
    }

    if (rank.length === 0) {
      // Shouldn't happen if validateDag passed — defensive.
      throw new DagValidationError("cannot schedule remaining tasks (likely a cycle slipped past validation)", [
        `stuck tasks: ${[...byId.keys()].filter((id) => !done.has(id)).join(", ")}`,
      ])
    }

    for (const t of rank) done.add(t.id)
    ranks.push(rank)
  }

  return ranks
}
