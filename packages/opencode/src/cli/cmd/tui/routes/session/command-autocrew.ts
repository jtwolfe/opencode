// Ctrl+P AutoCrew operational action helpers.
//
// These run on the TUI side with direct filesystem access to
// `{project}/.opencode/autocrew-state/` — same paths that the server-side
// `Ledger` / `Resume` modules use. We intentionally don't invoke the server's
// Effect services here because (a) those require an Effect runtime and
// (b) the operations are simple file reads/writes.

import * as fs from "fs/promises"
import * as path from "path"

export interface AutocrewStateFile {
  run_id: string
  plan_id: string
  orchestrator_session_id: string
  phase: string
  tasks: Record<
    string,
    {
      id: string
      state: string
      role: string
      retry_count: number
      replan_count: number
      candidate_session_ids: string[]
    }
  >
  worktrees: Array<{
    task_id: string
    candidate_id: number
    name: string
    branch: string
    directory: string
    live: boolean
    preserved_for_review: boolean
  }>
  rounds_consumed: number
  started_at: string
  updated_at: string
}

export interface LatestRunInfo {
  runId: string
  stateDir: string
}

function statesRoot(projectDirectory: string): string {
  return path.join(projectDirectory, ".opencode", "autocrew-state")
}

/**
 * Find the most recently modified AutoCrew run state directory in the project.
 * Returns undefined if the `.opencode/autocrew-state/` directory doesn't exist
 * or is empty.
 */
export async function findLatestRun(projectDirectory: string): Promise<LatestRunInfo | undefined> {
  const root = statesRoot(projectDirectory)
  let entries: string[]
  try {
    entries = await fs.readdir(root)
  } catch {
    return undefined
  }
  const stats = await Promise.all(
    entries.map(async (name) => {
      try {
        const st = await fs.stat(path.join(root, name))
        return st.isDirectory() ? { name, mtime: st.mtimeMs } : undefined
      } catch {
        return undefined
      }
    }),
  )
  const dirs = stats.filter((x): x is { name: string; mtime: number } => !!x)
  if (dirs.length === 0) return undefined
  dirs.sort((a, b) => b.mtime - a.mtime || b.name.localeCompare(a.name))
  const runId = dirs[0]!.name
  return { runId, stateDir: path.join(root, runId) }
}

export async function readState(stateDir: string): Promise<AutocrewStateFile | undefined> {
  try {
    const text = await fs.readFile(path.join(stateDir, "state.json"), "utf8")
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

export async function writeStateAtomic(stateDir: string, next: AutocrewStateFile): Promise<void> {
  const target = path.join(stateDir, "state.json")
  const tmp = target + ".tmp"
  const payload = JSON.stringify(next, null, 2)
  await fs.writeFile(tmp, payload)
  try {
    await fs.rename(tmp, target)
  } catch {
    await fs.writeFile(target, payload)
    await fs.unlink(tmp).catch(() => undefined)
  }
}

export async function appendLedgerEvent(stateDir: string, event: Record<string, unknown>): Promise<void> {
  const file = path.join(stateDir, "ledger.jsonl")
  const stamped = { ...event, timestamp: new Date().toISOString() }
  await fs.appendFile(file, JSON.stringify(stamped) + "\n")
}

export async function readLedgerTail(stateDir: string, tail: number): Promise<Array<Record<string, unknown>>> {
  try {
    const text = await fs.readFile(path.join(stateDir, "ledger.jsonl"), "utf8")
    const lines = text.split("\n").filter((l) => l.trim().length > 0)
    return lines.slice(-tail).map((l) => JSON.parse(l))
  } catch {
    return []
  }
}

/**
 * Compose a human-readable status summary from state + recent ledger events.
 * Used by the ctrl+p status action's toast.
 */
export function formatStatusSummary(runId: string, state: AutocrewStateFile, recent: Array<Record<string, unknown>>): string {
  const tasks = Object.values(state.tasks)
  const byState = new Map<string, number>()
  for (const t of tasks) byState.set(t.state, (byState.get(t.state) ?? 0) + 1)
  const taskLine = [...byState.entries()].map(([s, n]) => `${s}=${n}`).join(", ") || "none"
  const liveWT = state.worktrees.filter((w) => w.live).length
  const recentLine = recent.map((e) => String(e.type ?? "?")).join(" → ") || "no events"

  return [
    `AutoCrew run ${runId}`,
    `phase: ${state.phase}`,
    `rounds: ${state.rounds_consumed}`,
    `tasks: ${taskLine}`,
    `worktrees alive: ${liveWT}`,
    `recent: ${recentLine}`,
  ].join(" | ")
}
