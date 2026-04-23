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
      // Prompt content checks — verifies the tool-call-oriented prompt is installed.
      expect(orch?.prompt).toBeDefined()
      expect(orch!.prompt!).toContain("AutoCrew Orchestrator")
      // No-code-writing directive (phrasing may vary, key concept must be there).
      expect(orch!.prompt!).toMatch(/do not write code/i)
      // Meta-evaluation trio must be present (in any listing form).
      expect(orch!.prompt!).toMatch(/continue.*backlog.*halt/)
      // Tool-call framing: the prompt must direct the model to call real tools.
      expect(orch!.prompt!).toContain("`smart-task`")
      expect(orch!.prompt!).toContain("`ingest-design-docs`")
      // v0.1: TodoWrite integration guidance must be present.
      expect(orch!.prompt!).toContain("todowrite")
      // Plan-approval gate line must be documented exactly.
      expect(orch!.prompt!).toContain("Please approve this plan")
      // Turn-ending contract must be named.
      expect(orch!.prompt!).toMatch(/turn.ending.contract/i)
      // Procedural examples present.
      expect(orch!.prompt!).toContain("<example>")
      // Length regression guard: keep the prompt reasonably thin. If this
      // triggers, check you're not re-specifying things the base prompt already covers.
      // (Pre-v0.1 the prompt was >9000 chars with harness-XML framing. Post-rewrite target <7000.)
      expect(orch!.prompt!.length).toBeLessThan(7000)
      // Harness-XML framing must NOT be the output format. If this regresses,
      // the orchestrator will stop mid-run emitting fake "<decision>" tags
      // and the user will have to type "continue" to resume (Apr 21 postmortem).
      // The prompt may mention <decision> to prohibit it, but must not instruct
      // the model to emit it as the output structure.
      expect(orch!.prompt!).not.toContain("The harness parses this structure")
      expect(orch!.prompt!).not.toContain("Structure every response as:")
      expect(orch!.prompt!).not.toMatch(/^<decision>/m)
      expect(orch!.prompt!).not.toContain("<decision>\nOne of:")
      // Permissions: orchestrator can dispatch via smart-task but cannot
      // edit code and cannot bypass worktree isolation via the `task` tool.
      expect(evalPerm(orch, "smart-task")).toBe("allow")
      expect(evalPerm(orch, "ingest-design-docs")).toBe("allow")
      expect(evalPerm(orch, "todowrite")).toBe("allow")
      expect(evalPerm(orch, "read")).toBe("allow")
      expect(evalPerm(orch, "edit")).toBe("deny")
      expect(evalPerm(orch, "write")).toBe("deny")
      expect(evalPerm(orch, "task")).toBe("deny")
    },
  })
})
