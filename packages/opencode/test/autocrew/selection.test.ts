import { describe, expect, test } from "bun:test"
import { Selection, type Candidate } from "../../src/autocrew/selection"

const wt = (i: number) => ({
  name: `cand-${i}`,
  branch: `opencode/cand-${i}`,
  directory: `/tmp/cand-${i}`,
})

const c = (i: number, partial: Partial<Candidate> = {}): Candidate => ({
  candidate_id: i,
  session_id: `ses_${i}`,
  worktree: wt(i),
  output_summary: `output ${i}`,
  ...partial,
})

describe("Selection.selectBestCandidate", () => {
  test("returns null winner for empty input", () => {
    const r = Selection.selectBestCandidate([])
    expect(r.winner).toBeNull()
    expect(r.losers).toEqual([])
  })

  test("picks the only candidate when one is provided", () => {
    const r = Selection.selectBestCandidate([c(0)])
    expect(r.winner?.candidate_id).toBe(0)
    expect(r.losers).toEqual([])
  })

  test("highest reviewer score wins", () => {
    const r = Selection.selectBestCandidate([
      c(0, { reviewer_score: 60 }),
      c(1, { reviewer_score: 92 }),
      c(2, { reviewer_score: 75 }),
    ])
    expect(r.winner?.candidate_id).toBe(1)
    expect(r.losers.map((l) => l.candidate_id).sort()).toEqual([0, 2])
  })

  test("excludes worker-failed candidates", () => {
    const r = Selection.selectBestCandidate([
      c(0, { reviewer_score: 90, worker_failed: true }),
      c(1, { reviewer_score: 50 }),
    ])
    expect(r.winner?.candidate_id).toBe(1)
  })

  test("validator pass: false hard-filters out", () => {
    const r = Selection.selectBestCandidate([
      c(0, { reviewer_score: 90, validator_pass: false }),
      c(1, { reviewer_score: 50, validator_pass: true }),
    ])
    expect(r.winner?.candidate_id).toBe(1)
  })

  test("tester pass: false hard-filters out", () => {
    const r = Selection.selectBestCandidate([
      c(0, { reviewer_score: 90, tester_pass: false }),
      c(1, { reviewer_score: 50, tester_pass: true }),
    ])
    expect(r.winner?.candidate_id).toBe(1)
  })

  test("ties on reviewer_score broken by smaller output_summary", () => {
    const r = Selection.selectBestCandidate([
      c(0, { reviewer_score: 80, output_summary: "this is a longer output" }),
      c(1, { reviewer_score: 80, output_summary: "short" }),
    ])
    expect(r.winner?.candidate_id).toBe(1)
  })

  test("ties on score and length broken by lowest candidate_id", () => {
    const r = Selection.selectBestCandidate([
      c(2, { reviewer_score: 80, output_summary: "abc" }),
      c(0, { reviewer_score: 80, output_summary: "abc" }),
      c(1, { reviewer_score: 80, output_summary: "abc" }),
    ])
    expect(r.winner?.candidate_id).toBe(0)
  })

  test("returns null + rationale when all workers failed", () => {
    const r = Selection.selectBestCandidate([c(0, { worker_failed: true }), c(1, { worker_failed: true })])
    expect(r.winner).toBeNull()
    expect(r.rationale).toContain("all workers failed")
  })

  test("returns null + rationale when validator filters all out", () => {
    const r = Selection.selectBestCandidate([
      c(0, { validator_pass: false }),
      c(1, { validator_pass: false }),
    ])
    expect(r.winner).toBeNull()
    expect(r.rationale).toContain("validator")
  })
})
