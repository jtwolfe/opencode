import { BusEvent } from "@/bus/bus-event"
import { InstanceState } from "@/effect"
import { EffectBridge } from "@/effect"
import type { InstanceContext } from "@/project/instance"
import { SessionID, MessageID } from "@/session/schema"
import { Effect, Layer, Context } from "effect"
import z from "zod"
import { Config } from "../config"
import { MCP } from "../mcp"
import { Skill } from "../skill"
import PROMPT_INITIALIZE from "./template/initialize.txt"
import PROMPT_REVIEW from "./template/review.txt"
import PROMPT_AUTOCREW_START from "./template/autocrew.txt"
import PROMPT_AUTOCREW_PAUSE from "./template/pause-autocrew.txt"
import PROMPT_AUTOCREW_RESUME from "./template/resume-autocrew.txt"
import PROMPT_AUTOCREW_STOP from "./template/stop-autocrew.txt"
import PROMPT_AUTOCREW_STATUS from "./template/status-autocrew.txt"
import PROMPT_AUTOCREW_APPLY from "./template/apply-autocrew.txt"
import PROMPT_AUTOCREW_KILL_SESSION from "./template/kill-session.txt"
import PROMPT_AUTOCREW_CANCEL_TASK from "./template/cancel-task.txt"

type State = {
  commands: Record<string, Info>
}

export const Event = {
  Executed: BusEvent.define(
    "command.executed",
    z.object({
      name: z.string(),
      sessionID: SessionID.zod,
      arguments: z.string(),
      messageID: MessageID.zod,
    }),
  ),
}

export const Info = z
  .object({
    name: z.string(),
    description: z.string().optional(),
    agent: z.string().optional(),
    model: z.string().optional(),
    source: z.enum(["command", "mcp", "skill"]).optional(),
    // workaround for zod not supporting async functions natively so we use getters
    // https://zod.dev/v4/changelog?id=zfunction
    template: z.promise(z.string()).or(z.string()),
    subtask: z.boolean().optional(),
    hints: z.array(z.string()),
  })
  .meta({
    ref: "Command",
  })

// for some reason zod is inferring `string` for z.promise(z.string()).or(z.string()) so we have to manually override it
export type Info = Omit<z.infer<typeof Info>, "template"> & { template: Promise<string> | string }

export function hints(template: string) {
  const result: string[] = []
  const numbered = template.match(/\$\d+/g)
  if (numbered) {
    for (const match of [...new Set(numbered)].sort()) result.push(match)
  }
  if (template.includes("$ARGUMENTS")) result.push("$ARGUMENTS")
  return result
}

export const Default = {
  INIT: "init",
  REVIEW: "review",
} as const

export interface Interface {
  readonly get: (name: string) => Effect.Effect<Info | undefined>
  readonly list: () => Effect.Effect<Info[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Command") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const mcp = yield* MCP.Service
    const skill = yield* Skill.Service

    const init = Effect.fn("Command.state")(function* (ctx: InstanceContext) {
      const cfg = yield* config.get()
      const bridge = yield* EffectBridge.make()
      const commands: Record<string, Info> = {}

      commands[Default.INIT] = {
        name: Default.INIT,
        description: "guided AGENTS.md setup",
        source: "command",
        get template() {
          return PROMPT_INITIALIZE.replace("${path}", ctx.worktree)
        },
        hints: hints(PROMPT_INITIALIZE),
      }
      commands[Default.REVIEW] = {
        name: Default.REVIEW,
        description: "review changes [commit|branch|pr], defaults to uncommitted",
        source: "command",
        get template() {
          return PROMPT_REVIEW.replace("${path}", ctx.worktree)
        },
        subtask: true,
        hints: hints(PROMPT_REVIEW),
      }

      // AutoCrew slash commands. /autocrew spawns the orchestrator as a subtask;
      // pause/resume/stop/status/apply/kill-session/cancel-task run in the current
      // session and operate on the most recent run's state directory.
      commands["autocrew"] = {
        name: "autocrew",
        description: "start an AutoCrew run from design docs + goal",
        source: "command",
        agent: "autocrew",
        get template() {
          return PROMPT_AUTOCREW_START
        },
        subtask: true,
        hints: hints(PROMPT_AUTOCREW_START),
      }
      commands["pause-autocrew"] = {
        name: "pause-autocrew",
        description: "pause the active AutoCrew run",
        source: "command",
        get template() {
          return PROMPT_AUTOCREW_PAUSE
        },
        hints: hints(PROMPT_AUTOCREW_PAUSE),
      }
      commands["resume-autocrew"] = {
        name: "resume-autocrew",
        description: "resume the most recent paused AutoCrew run (optional run id $1)",
        source: "command",
        agent: "autocrew",
        get template() {
          return PROMPT_AUTOCREW_RESUME
        },
        subtask: true,
        hints: hints(PROMPT_AUTOCREW_RESUME),
      }
      commands["stop-autocrew"] = {
        name: "stop-autocrew",
        description: "halt the current AutoCrew run and clean up worktrees",
        source: "command",
        get template() {
          return PROMPT_AUTOCREW_STOP
        },
        hints: hints(PROMPT_AUTOCREW_STOP),
      }
      commands["status"] = {
        name: "status",
        description: "show AutoCrew run progress (optional run id $1)",
        source: "command",
        get template() {
          return PROMPT_AUTOCREW_STATUS
        },
        hints: hints(PROMPT_AUTOCREW_STATUS),
      }
      commands["apply"] = {
        name: "apply",
        description: "merge the AutoCrew run's winning candidates into the primary workspace",
        source: "command",
        get template() {
          return PROMPT_AUTOCREW_APPLY
        },
        hints: hints(PROMPT_AUTOCREW_APPLY),
      }
      commands["kill-session"] = {
        name: "kill-session",
        description: "terminate a specific child session ($1 = session id)",
        source: "command",
        get template() {
          return PROMPT_AUTOCREW_KILL_SESSION
        },
        hints: hints(PROMPT_AUTOCREW_KILL_SESSION),
      }
      commands["cancel-task"] = {
        name: "cancel-task",
        description: "mark a specific AutoCrew task as user-cancelled ($1 = task id)",
        source: "command",
        get template() {
          return PROMPT_AUTOCREW_CANCEL_TASK
        },
        hints: hints(PROMPT_AUTOCREW_CANCEL_TASK),
      }

      for (const [name, command] of Object.entries(cfg.command ?? {})) {
        commands[name] = {
          name,
          agent: command.agent,
          model: command.model,
          description: command.description,
          source: "command",
          get template() {
            return command.template
          },
          subtask: command.subtask,
          hints: hints(command.template),
        }
      }

      for (const [name, prompt] of Object.entries(yield* mcp.prompts())) {
        commands[name] = {
          name,
          source: "mcp",
          description: prompt.description,
          get template() {
            return bridge.promise(
              mcp
                .getPrompt(
                  prompt.client,
                  prompt.name,
                  prompt.arguments
                    ? Object.fromEntries(prompt.arguments.map((argument, i) => [argument.name, `$${i + 1}`]))
                    : {},
                )
                .pipe(
                  Effect.map(
                    (template) =>
                      template?.messages
                        .map((message) => (message.content.type === "text" ? message.content.text : ""))
                        .join("\n") || "",
                  ),
                ),
            )
          },
          hints: prompt.arguments?.map((_, i) => `$${i + 1}`) ?? [],
        }
      }

      for (const item of yield* skill.all()) {
        if (commands[item.name]) continue
        commands[item.name] = {
          name: item.name,
          description: item.description,
          source: "skill",
          get template() {
            return item.content
          },
          hints: [],
        }
      }

      return {
        commands,
      }
    })

    const state = yield* InstanceState.make<State>((ctx) => init(ctx))

    const get = Effect.fn("Command.get")(function* (name: string) {
      const s = yield* InstanceState.get(state)
      return s.commands[name]
    })

    const list = Effect.fn("Command.list")(function* () {
      const s = yield* InstanceState.get(state)
      return Object.values(s.commands)
    })

    return Service.of({ get, list })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Config.defaultLayer),
  Layer.provide(MCP.defaultLayer),
  Layer.provide(Skill.defaultLayer),
)

export * as Command from "."
