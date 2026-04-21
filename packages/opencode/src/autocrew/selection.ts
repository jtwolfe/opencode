export * as Selection from "./selection"

import type { Worktree } from "../worktree"

/**
 * One candidate produced by a parallel Coder fan-out, with optional scoring
 * signals from Reviewer/Validator/Tester roles. v0 only uses Reviewer.
 */
export interface Candidate {
  candidate_id: number
  session_id: string
  worktree: Worktree.Info
  output_summary: string
  // Reviewer signal (optional; v0 always runs Reviewer when configured).
  reviewer_score?: number
  reviewer_approved?: boolean
  reviewer_issues?: string[]
  // Validator signal (v1).
  validator_pass?: boolean
  // Tester signal (v1).
  tester_pass?: boolean
  // Implementation marker for "this candidate's worker errored before scoring".
  worker_failed?: boolean
}

export interface SelectionResult {
  winner: Candidate | null
  losers: Candidate[]
  rationale: string
}

/**
 * Best-candidate selection per Doc 05 §5 / Doc 08 §3.
 *
 * Filter pipeline (in order):
 *   1. Drop candidates whose worker failed.
 *   2. Hard filter: Validator must be `pass` if a verdict was recorded.
 *   3. Hard filter: Tester must be `pass` if a verdict was recorded.
 *   4. Soft rank: highest Reviewer score wins.
 *   5. Tie-break: smallest output_summary length (proxy for smallest diff).
 *   6. Final tie-break: lowest candidate_id (deterministic).
 *
 * If zero candidates survive, returns winner: null with a rationale.
 */
export function selectBestCandidate(candidates: Candidate[]): SelectionResult {
  if (candidates.length === 0) {
    return { winner: null, losers: [], rationale: "no candidates produced" }
  }

  const stages: string[] = []

  let pool = candidates.filter((c) => !c.worker_failed)
  stages.push(`worker-success: ${pool.length}/${candidates.length}`)
  if (pool.length === 0) {
    return { winner: null, losers: candidates, rationale: stages.join("; ") + " — all workers failed" }
  }

  const beforeValidator = pool.length
  pool = pool.filter((c) => c.validator_pass !== false) // skip filter if undefined
  stages.push(`validator-pass: ${pool.length}/${beforeValidator}`)
  if (pool.length === 0) {
    return {
      winner: null,
      losers: candidates,
      rationale: stages.join("; ") + " — no candidates passed validator",
    }
  }

  const beforeTester = pool.length
  pool = pool.filter((c) => c.tester_pass !== false)
  stages.push(`tester-pass: ${pool.length}/${beforeTester}`)
  if (pool.length === 0) {
    return {
      winner: null,
      losers: candidates,
      rationale: stages.join("; ") + " — no candidates passed tester",
    }
  }

  // Sort by: highest reviewer_score, then smallest output (tie-break), then lowest id.
  const ranked = [...pool].sort((a, b) => {
    const sa = a.reviewer_score ?? 0
    const sb = b.reviewer_score ?? 0
    if (sa !== sb) return sb - sa
    const la = a.output_summary.length
    const lb = b.output_summary.length
    if (la !== lb) return la - lb
    return a.candidate_id - b.candidate_id
  })

  const winner = ranked[0]!
  const losers = candidates.filter((c) => c.candidate_id !== winner.candidate_id)
  stages.push(
    `winner: candidate=${winner.candidate_id} reviewer_score=${winner.reviewer_score ?? "n/a"} branch=${winner.worktree.branch}`,
  )

  return { winner, losers, rationale: stages.join("; ") }
}
