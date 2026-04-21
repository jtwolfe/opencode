export * as AutocrewTypes from "./types"

import z from "zod"

// Task spec — matches the canonical DAG schema in autocrew-design-docs/08 §3.
// The orchestrator produces these; smart-task consumes them.
export const TaskRole = z.enum(["planner", "coder", "reviewer", "validator", "tester", "integrator"])
export type TaskRole = z.infer<typeof TaskRole>

export const TaskInputs = z
  .object({
    design_doc_sections: z.array(z.string()).optional(),
    files_to_read: z.array(z.string()).optional(),
  })
  .passthrough()
export type TaskInputs = z.infer<typeof TaskInputs>

export const TaskOutputs = z
  .object({
    files_to_modify: z.array(z.string()).optional(),
    expected_behavior: z.string().optional(),
  })
  .passthrough()
export type TaskOutputs = z.infer<typeof TaskOutputs>

export const TaskSpec = z.object({
  id: z.string().min(1),
  role: TaskRole,
  objective: z.string().min(1),
  inputs: TaskInputs.optional(),
  outputs: TaskOutputs.optional(),
  acceptance_criteria: z.array(z.string()).optional(),
  depends_on: z.array(z.string()).optional(),
  parallel_count: z.number().int().min(1).max(3).optional().default(1),
  timeout_minutes: z.number().positive().optional(),
  description: z.string().optional(),
})
export type TaskSpec = z.infer<typeof TaskSpec>

export const TaskState = z.enum([
  "pending",
  "running",
  "completed",
  "failed-retry",
  "failed-replan",
  "review",
  "user-cancelled",
])
export type TaskState = z.infer<typeof TaskState>

export const RunPhase = z.enum([
  "ingesting",
  "planning",
  "awaiting-plan-approval",
  "executing",
  "integrating",
  "meta-evaluating",
  "paused",
  "completed",
  "halted",
])
export type RunPhase = z.infer<typeof RunPhase>

export const SelectionStrategy = z.enum(["best-candidate", "majority", "all-agree", "orchestrator-vote"])
export type SelectionStrategy = z.infer<typeof SelectionStrategy>

// Ledger event schema — append-only log of everything that happened in a run.
export const LedgerEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("task-dispatched"),
    timestamp: z.string(),
    task_id: z.string(),
    role: TaskRole,
    candidate_id: z.number().int().nonnegative().optional(),
    session_id: z.string().optional(),
  }),
  z.object({
    type: z.literal("worktree-created"),
    timestamp: z.string(),
    task_id: z.string(),
    candidate_id: z.number().int().nonnegative(),
    worktree_name: z.string(),
    worktree_branch: z.string(),
    worktree_directory: z.string(),
  }),
  z.object({
    type: z.literal("candidate-received"),
    timestamp: z.string(),
    task_id: z.string(),
    candidate_id: z.number().int().nonnegative(),
    output_summary: z.string(),
  }),
  z.object({
    type: z.literal("score-assigned"),
    timestamp: z.string(),
    task_id: z.string(),
    candidate_id: z.number().int().nonnegative(),
    score: z.number(),
    reviewer_session_id: z.string().optional(),
  }),
  z.object({
    type: z.literal("candidate-selected"),
    timestamp: z.string(),
    task_id: z.string(),
    winning_candidate_id: z.number().int().nonnegative(),
    rationale: z.string(),
  }),
  z.object({
    type: z.literal("worktree-removed"),
    timestamp: z.string(),
    task_id: z.string(),
    candidate_id: z.number().int().nonnegative(),
    worktree_directory: z.string(),
  }),
  z.object({
    type: z.literal("task-completed"),
    timestamp: z.string(),
    task_id: z.string(),
    merged_branch: z.string().optional(),
    files_modified: z.array(z.string()).optional(),
  }),
  z.object({
    type: z.literal("task-failed"),
    timestamp: z.string(),
    task_id: z.string(),
    candidate_id: z.number().int().nonnegative().optional(),
    reason: z.string(),
    next_action: z.enum(["retry", "replan", "review"]),
  }),
  z.object({
    type: z.literal("task-replanned"),
    timestamp: z.string(),
    task_id: z.string(),
    previous_spec_summary: z.string(),
    new_spec_summary: z.string(),
  }),
  z.object({
    type: z.literal("meta-eval"),
    timestamp: z.string(),
    verdict: z.enum(["continue", "backlog", "halt"]),
    evidence: z.string(),
  }),
  z.object({
    type: z.literal("phase-change"),
    timestamp: z.string(),
    from: RunPhase,
    to: RunPhase,
  }),
])
export type LedgerEvent = z.infer<typeof LedgerEvent>

// Run state — persisted to state.json; authoritative for resumability.
export const TaskStateEntry = z.object({
  id: z.string(),
  state: TaskState,
  role: TaskRole,
  retry_count: z.number().int().nonnegative().default(0),
  replan_count: z.number().int().nonnegative().default(0),
  candidate_session_ids: z.array(z.string()).default([]),
})
export type TaskStateEntry = z.infer<typeof TaskStateEntry>

export const WorktreeInventoryEntry = z.object({
  task_id: z.string(),
  candidate_id: z.number().int().nonnegative(),
  name: z.string(),
  branch: z.string(),
  directory: z.string(),
  live: z.boolean(),
  preserved_for_review: z.boolean().default(false),
})
export type WorktreeInventoryEntry = z.infer<typeof WorktreeInventoryEntry>

export const RunState = z.object({
  run_id: z.string(),
  plan_id: z.string(),
  orchestrator_session_id: z.string(),
  phase: RunPhase,
  tasks: z.record(z.string(), TaskStateEntry).default({}),
  worktrees: z.array(WorktreeInventoryEntry).default([]),
  rounds_consumed: z.number().int().nonnegative().default(0),
  started_at: z.string(),
  updated_at: z.string(),
})
export type RunState = z.infer<typeof RunState>

// Smart-task tool result — what the orchestrator receives back from each dispatch.
export const SmartTaskResult = z.object({
  task_id: z.string(),
  status: z.enum(["completed", "failed", "review", "halted"]),
  candidates_evaluated: z.number().int().nonnegative().optional(),
  winning_candidate_id: z.number().int().nonnegative().optional(),
  winning_score: z.number().optional(),
  merged_branch: z.string().optional(),
  files_modified: z.array(z.string()).optional(),
  errors: z.array(z.string()).default([]),
  next_action: z.enum(["retry", "replan", "review", "continue", "halt"]).optional(),
})
export type SmartTaskResult = z.infer<typeof SmartTaskResult>

// The full smart-task invocation input, matching Doc 05 §3.
export const SmartTaskInput = z.object({
  plan_id: z.string(),
  tasks: z.array(TaskSpec).min(1),
  selection_strategy: SelectionStrategy.optional().default("best-candidate"),
})
export type SmartTaskInput = z.infer<typeof SmartTaskInput>
