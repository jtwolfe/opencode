import { describe, expect, test } from "bun:test"
import { Dag, DagValidationError } from "../../src/autocrew/dag"
import type { TaskSpec } from "../../src/autocrew/types"

const t = (id: string, depends_on?: string[]): TaskSpec => ({
  id,
  role: "coder",
  objective: id,
  parallel_count: 1,
  ...(depends_on ? { depends_on } : {}),
})

describe("Dag.validateDag", () => {
  test("accepts a valid linear DAG", () => {
    expect(() => Dag.validateDag([t("a"), t("b", ["a"]), t("c", ["b"])])).not.toThrow()
  })

  test("accepts a valid diamond DAG", () => {
    expect(() => Dag.validateDag([t("a"), t("b", ["a"]), t("c", ["a"]), t("d", ["b", "c"])])).not.toThrow()
  })

  test("rejects duplicate ids", () => {
    expect(() => Dag.validateDag([t("a"), t("a")])).toThrow(/duplicate task id/)
  })

  test("rejects unknown depends_on", () => {
    expect(() => Dag.validateDag([t("a", ["nope"])])).toThrow(/unknown task/)
  })

  test("rejects 2-cycle", () => {
    expect(() => Dag.validateDag([t("a", ["b"]), t("b", ["a"])])).toThrow(/cycle detected/)
  })

  test("rejects 3-cycle", () => {
    expect(() => Dag.validateDag([t("a", ["c"]), t("b", ["a"]), t("c", ["b"])])).toThrow(/cycle detected/)
  })

  test("collects multiple issues", () => {
    try {
      Dag.validateDag([t("a"), t("a"), t("b", ["nope"])])
    } catch (err) {
      expect(err).toBeInstanceOf(DagValidationError)
      expect((err as DagValidationError).issues.length).toBeGreaterThanOrEqual(2)
      return
    }
    throw new Error("expected validation to fail")
  })
})

describe("Dag.topologicalRanks", () => {
  test("single rank for independent tasks preserves insertion order", () => {
    const ranks = Dag.topologicalRanks([t("a"), t("b"), t("c")])
    expect(ranks).toHaveLength(1)
    expect(ranks[0]!.map((x) => x.id)).toEqual(["a", "b", "c"])
  })

  test("linear chain produces N ranks", () => {
    const ranks = Dag.topologicalRanks([t("a"), t("b", ["a"]), t("c", ["b"])])
    expect(ranks.map((r) => r.map((x) => x.id))).toEqual([["a"], ["b"], ["c"]])
  })

  test("diamond produces 3 ranks (root, middle pair, sink)", () => {
    const ranks = Dag.topologicalRanks([t("a"), t("b", ["a"]), t("c", ["a"]), t("d", ["b", "c"])])
    expect(ranks).toHaveLength(3)
    expect(ranks[0]!.map((x) => x.id)).toEqual(["a"])
    expect(ranks[1]!.map((x) => x.id)).toEqual(["b", "c"])
    expect(ranks[2]!.map((x) => x.id)).toEqual(["d"])
  })

  test("preserves insertion order within a rank", () => {
    // c, a, b — all independent. Expect order [c, a, b].
    const ranks = Dag.topologicalRanks([t("c"), t("a"), t("b")])
    expect(ranks[0]!.map((x) => x.id)).toEqual(["c", "a", "b"])
  })

  test("mixes ready tasks with deferred ones in correct ranks", () => {
    const ranks = Dag.topologicalRanks([t("dep1"), t("ind1"), t("dep2", ["dep1"]), t("ind2")])
    // Rank 0: dep1, ind1, ind2 (all ready). Rank 1: dep2.
    expect(ranks[0]!.map((x) => x.id).sort()).toEqual(["dep1", "ind1", "ind2"])
    expect(ranks[1]!.map((x) => x.id)).toEqual(["dep2"])
  })
})
