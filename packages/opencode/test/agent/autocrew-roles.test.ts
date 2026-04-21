import { afterEach, test, expect } from "bun:test"
import { Effect } from "effect"
import { provideInstance, tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Agent } from "../../src/agent/agent"
import { Permission } from "../../src/permission"

function evalPerm(agent: Agent.Info | undefined, permission: string): Permission.Action | undefined {
  if (!agent) return undefined
  return Permission.evaluate(permission, "*", agent.permission).action
}

function load<A>(dir: string, fn: (svc: Agent.Interface) => Effect.Effect<A>) {
  return Effect.runPromise(provideInstance(dir)(Agent.Service.use(fn)).pipe(Effect.provide(Agent.defaultLayer)))
}

afterEach(async () => {
  await Instance.disposeAll()
})

test("autocrew role agents are registered", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const agents = await load(tmp.path, (svc) => svc.list())
      const names = agents.map((a) => a.name)
      expect(names).toContain("planner")
      expect(names).toContain("coder")
      expect(names).toContain("reviewer")
    },
  })
})

test("planner is a subagent with read/task access but no write", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const planner = await load(tmp.path, (svc) => svc.get("planner"))
      expect(planner).toBeDefined()
      expect(planner?.mode).toBe("subagent")
      expect(planner?.native).toBe(true)
      expect(planner?.prompt).toBeDefined()
      expect(planner!.prompt!.length).toBeGreaterThan(100)
      expect(evalPerm(planner, "read")).toBe("allow")
      expect(evalPerm(planner, "task")).toBe("allow")
      expect(evalPerm(planner, "edit")).toBe("deny")
      expect(evalPerm(planner, "write")).toBe("deny")
    },
  })
})

test("coder is a subagent with edit/write access and question denied", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const coder = await load(tmp.path, (svc) => svc.get("coder"))
      expect(coder).toBeDefined()
      expect(coder?.mode).toBe("subagent")
      expect(coder?.native).toBe(true)
      expect(coder?.prompt).toBeDefined()
      expect(coder!.prompt!).toContain("Coder")
      expect(evalPerm(coder, "edit")).toBe("allow")
      expect(evalPerm(coder, "write")).toBe("allow")
      expect(evalPerm(coder, "bash")).toBe("allow")
      expect(evalPerm(coder, "question")).toBe("deny")
      expect(evalPerm(coder, "todowrite")).toBe("deny")
    },
  })
})

test("reviewer is a subagent with read/bash but no write access", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const reviewer = await load(tmp.path, (svc) => svc.get("reviewer"))
      expect(reviewer).toBeDefined()
      expect(reviewer?.mode).toBe("subagent")
      expect(reviewer?.native).toBe(true)
      expect(reviewer?.prompt).toBeDefined()
      expect(reviewer!.prompt!).toContain("Reviewer")
      expect(evalPerm(reviewer, "read")).toBe("allow")
      expect(evalPerm(reviewer, "bash")).toBe("allow")
      expect(evalPerm(reviewer, "edit")).toBe("deny")
      expect(evalPerm(reviewer, "write")).toBe("deny")
    },
  })
})

test("autocrew orchestrator is a primary agent with smart-task allowed and edit/write denied", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const orch = await load(tmp.path, (svc) => svc.get("autocrew"))
      expect(orch).toBeDefined()
      expect(orch?.mode).toBe("primary")
      expect(orch?.native).toBe(true)
      // Prompt content checks — verifies Doc 08 §3 was installed verbatim.
      expect(orch?.prompt).toBeDefined()
      expect(orch!.prompt!).toContain("AutoCrew Orchestrator")
      expect(orch!.prompt!).toContain("you do not write or edit code")
      expect(orch!.prompt!).toContain("continue, backlog, or halt")
      // Permissions: orchestrator can dispatch but cannot edit code.
      expect(evalPerm(orch, "smart-task")).toBe("allow")
      expect(evalPerm(orch, "ingest-design-docs")).toBe("allow")
      expect(evalPerm(orch, "read")).toBe("allow")
      expect(evalPerm(orch, "edit")).toBe("deny")
      expect(evalPerm(orch, "write")).toBe("deny")
    },
  })
})
