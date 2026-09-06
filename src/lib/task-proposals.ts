import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import { z } from 'zod'

export const taskProposalInputSchema = z.object({
  sourceType: z.enum(['chat', 'event']),
  sourceRef: z.string().trim().min(1).max(500),
  idempotencyKey: z.string().trim().min(1).max(240),
  title: z.string().trim().min(1).max(240),
  objective: z.string().trim().min(1).max(2000),
  context: z.string().trim().min(1).max(8000),
  rationale: z.string().trim().min(1).max(2000),
  risk: z.enum(['low', 'medium', 'high', 'critical']),
  routeForecast: z.object({
    runtime: z.enum(['local', 'codex', 'claude']),
    model: z.string().trim().min(1).max(200).optional(),
    reason: z.string().trim().min(1).max(500),
  }).optional(),
  projectId: z.number().int().positive().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  expiresAt: z.number().int().positive().optional(),
})

export const taskProposalEditSchema = taskProposalInputSchema
  .pick({ title: true, objective: true, context: true })
  .partial()
  .extend({ revision: z.string().uuid(), action: z.enum(['edit', 'dismiss']), dismissalReason: z.string().trim().max(1000).optional() })

export const taskProposalDecisionSchema = z.object({ revision: z.string().uuid() })

export type TaskProposalInput = z.input<typeof taskProposalInputSchema>

export type TaskProposal = Omit<z.output<typeof taskProposalInputSchema>, 'projectId' | 'expiresAt'> & {
  id: number
  workspaceId: number
  projectId: number | null
  status: 'pending' | 'accepted' | 'dismissed' | 'expired'
  revision: string
  orchestratorAgent: string
  createdBy: string
  acceptedBy: string | null
  acceptedAt: number | null
  dismissedBy: string | null
  dismissedAt: number | null
  dismissalReason: string | null
  taskId: number | null
  expiresAt: number | null
  createdAt: number
  updatedAt: number
}

const inputFields = taskProposalInputSchema.shape
const taskProposalRowSchema = z.object({
  id: z.number().int().positive(),
  workspace_id: z.number().int().positive(),
  project_id: z.number().int().positive().nullable(),
  source_type: inputFields.sourceType,
  source_ref: inputFields.sourceRef,
  idempotency_key: inputFields.idempotencyKey,
  title: inputFields.title,
  objective: inputFields.objective,
  context: inputFields.context,
  rationale: inputFields.rationale,
  risk: inputFields.risk,
  route_forecast: z.string().nullable()
    .transform((value): unknown => value === null ? undefined : JSON.parse(value))
    .pipe(inputFields.routeForecast),
  metadata: z.string()
    .transform((value): unknown => JSON.parse(value))
    .pipe(inputFields.metadata),
  status: z.enum(['pending', 'accepted', 'dismissed', 'expired']),
  revision: taskProposalDecisionSchema.shape.revision,
  orchestrator_agent: z.string(),
  created_by: z.string(),
  accepted_by: z.string().nullable(),
  accepted_at: z.number().int().nullable(),
  dismissed_by: z.string().nullable(),
  dismissed_at: z.number().int().nullable(),
  dismissal_reason: z.string().nullable(),
  task_id: z.number().int().positive().nullable(),
  expires_at: z.number().int().positive().nullable(),
  created_at: z.number().int(),
  updated_at: z.number().int(),
})

/** Fail closed on malformed stored JSON or invalid route/metadata shapes. */
export function mapTaskProposalRow(row: unknown): TaskProposal {
  const parsed = taskProposalRowSchema.parse(row)
  return {
    id: parsed.id,
    workspaceId: parsed.workspace_id,
    projectId: parsed.project_id,
    sourceType: parsed.source_type,
    sourceRef: parsed.source_ref,
    idempotencyKey: parsed.idempotency_key,
    title: parsed.title,
    objective: parsed.objective,
    context: parsed.context,
    rationale: parsed.rationale,
    risk: parsed.risk,
    routeForecast: parsed.route_forecast,
    metadata: parsed.metadata,
    status: parsed.status,
    revision: parsed.revision,
    orchestratorAgent: parsed.orchestrator_agent,
    createdBy: parsed.created_by,
    acceptedBy: parsed.accepted_by,
    acceptedAt: parsed.accepted_at,
    dismissedBy: parsed.dismissed_by,
    dismissedAt: parsed.dismissed_at,
    dismissalReason: parsed.dismissal_reason,
    taskId: parsed.task_id,
    expiresAt: parsed.expires_at,
    createdAt: parsed.created_at,
    updatedAt: parsed.updated_at,
  }
}

/** `now` is Unix seconds. Call before checking state when accepting a proposal. */
export function expirePendingTaskProposals(
  db: Database.Database,
  workspaceId: number,
  now: number,
): TaskProposal[] {
  return db.transaction(() => {
    const due = db.prepare(`
      SELECT id FROM task_proposals
      WHERE workspace_id = ? AND status = 'pending' AND expires_at <= ?
      ORDER BY id
    `).all(workspaceId, now) as Array<{ id: number }>
    const expire = db.prepare(`
      UPDATE task_proposals
      SET status = 'expired', revision = ?, updated_at = ?
      WHERE id = ? AND workspace_id = ? AND status = 'pending' AND expires_at <= ?
      RETURNING *
    `)
    const expired: TaskProposal[] = []
    for (const { id } of due) {
      const row = expire.get(randomUUID(), now, id, workspaceId, now)
      if (row) expired.push(mapTaskProposalRow(row))
    }
    return expired
  }).immediate()
}
