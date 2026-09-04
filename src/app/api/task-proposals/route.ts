import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireRole } from '@/lib/auth'
import { config } from '@/lib/config'
import { getDatabase } from '@/lib/db'
import { requireWorkspaceId } from '@/lib/enforcement/workspace-scope'
import { mutationLimiter } from '@/lib/rate-limit'
import { mapTaskProposalRow, taskProposalInputSchema } from '@/lib/task-proposals'
import { auditProposal, broadcastProposal, expireProposals } from './_lib'

const querySchema = z.object({
  status: z.enum(['pending', 'accepted', 'dismissed', 'expired']).optional(),
  source_type: z.enum(['chat', 'event']).optional(),
  source_ref: z.string().max(500).optional(),
  project_id: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  limit: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(50).transform(value => Math.min(value, 200)),
  offset: z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(0),
  summary: z.enum(['0', '1']).optional(),
})

export async function GET(request: NextRequest) {
  const auth = requireRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const ws = requireWorkspaceId(auth.user)
  if (!('workspaceId' in ws)) return ws.response
  const parsed = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams))
  if (!parsed.success) return NextResponse.json({ error: 'Invalid proposal filters' }, { status: 400 })
  const { status, source_type, source_ref, project_id, limit, offset, summary } = parsed.data
  try {
    const db = getDatabase()
    expireProposals(db, ws.workspaceId)
    const result = db.transaction(() => {
      let where = 'WHERE workspace_id = ?'
      const values: Array<string | number> = [ws.workspaceId]
      for (const [column, value] of Object.entries({ status, source_type, source_ref, project_id })) {
        if (value !== undefined) { where += ` AND ${column} = ?`; values.push(value) }
      }
      const { total } = db.prepare(`SELECT COUNT(*) AS total FROM task_proposals ${where}`).get(...values) as { total: number }
      const proposals = db.prepare(`SELECT * FROM task_proposals ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
        .all(...values, limit, offset).map(mapTaskProposalRow)
      if (summary !== '1') return { proposals, total, limit, offset }
      const lifecycle = db.prepare(`
        SELECT COUNT(*) AS created,
          COALESCE(SUM(status = 'pending'), 0) AS pending,
          COALESCE(SUM(status = 'accepted'), 0) AS accepted,
          COALESCE(SUM(status = 'dismissed'), 0) AS dismissed,
          COALESCE(SUM(status = 'expired'), 0) AS expired,
          AVG(CASE status
            WHEN 'accepted' THEN accepted_at - created_at
            WHEN 'dismissed' THEN dismissed_at - created_at
            WHEN 'expired' THEN expires_at - created_at
          END) AS averageDecisionLatencySeconds
        FROM task_proposals WHERE workspace_id = ?
      `).get(ws.workspaceId) as Record<string, number | null>
      const duplicates = db.prepare(`
        SELECT COUNT(*) AS duplicateSuppressed FROM audit_log
        WHERE workspace_id = ? AND action = 'proposal.duplicate_suppressed'
      `).get(ws.workspaceId) as { duplicateSuppressed: number }
      const routes = db.prepare(`
        SELECT COUNT(*) AS routeChanges
        FROM task_proposals p JOIN tasks t ON t.id = p.task_id AND t.workspace_id = p.workspace_id
        WHERE p.workspace_id = ? AND p.status = 'accepted'
          AND CASE WHEN json_valid(t.metadata) AND json_valid(p.route_forecast)
            THEN json_type(t.metadata, '$.proposal.final_route.runtime') = 'text'
              AND json_type(p.route_forecast, '$.runtime') = 'text'
              AND json_extract(t.metadata, '$.proposal.final_route.runtime') <> json_extract(p.route_forecast, '$.runtime')
            ELSE 0 END
      `).get(ws.workspaceId) as { routeChanges: number }
      return { proposals, total, limit, offset, summary: { ...lifecycle, ...duplicates, ...routes } }
    })()
    return NextResponse.json(result)
  } catch {
    return NextResponse.json({ error: 'Unable to list task proposals' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const limited = mutationLimiter(request)
  if (limited) return limited
  const ws = requireWorkspaceId(auth.user)
  if (!('workspaceId' in ws)) return ws.response
  let body: unknown
  try { body = await request.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }
  const parsed = taskProposalInputSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid proposal' }, { status: 400 })
  const agentName = auth.user.agent_name?.trim()
  const isAgent = auth.user.agent_name || auth.user.agent_id || auth.user.id <= 0
  const orchestrator = isAgent ? agentName : config.coordinatorAgent.trim()
  if (!orchestrator) return NextResponse.json({ error: 'A proposal orchestrator is required' }, { status: 409 })
  const actor = agentName || auth.user.display_name || auth.user.username
  const data = parsed.data
  try {
    const db = getDatabase()
    const result = db.transaction(() => {
      // Check the idempotency key first, so retry payloads cannot alter stored decisions.
      const existing = db.prepare('SELECT * FROM task_proposals WHERE workspace_id = ? AND idempotency_key = ?')
        .get(ws.workspaceId, data.idempotencyKey)
      if (existing) {
        const proposal = mapTaskProposalRow(existing)
        auditProposal(db, 'proposal.duplicate_suppressed', proposal, actor)
        return { proposal, created: false }
      }
      if (data.projectId && !db.prepare('SELECT id FROM projects WHERE id = ? AND workspace_id = ? AND status = ?').get(data.projectId, ws.workspaceId, 'active')) {
        return { error: 'Project not found', status: 404 }
      }
      const row = db.prepare(`
        INSERT INTO task_proposals (workspace_id, project_id, source_type, source_ref, idempotency_key,
          title, objective, context, rationale, risk, route_forecast, metadata, revision, orchestrator_agent, created_by, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(workspace_id, idempotency_key) DO NOTHING RETURNING *
      `).get(ws.workspaceId, data.projectId ?? null, data.sourceType, data.sourceRef, data.idempotencyKey,
        data.title, data.objective, data.context, data.rationale, data.risk,
        data.routeForecast ? JSON.stringify(data.routeForecast) : null, JSON.stringify(data.metadata),
        randomUUID(), orchestrator, actor, data.expiresAt ?? null)
      const proposal = mapTaskProposalRow(row ?? db.prepare('SELECT * FROM task_proposals WHERE workspace_id = ? AND idempotency_key = ?').get(ws.workspaceId, data.idempotencyKey))
      auditProposal(db, row ? 'proposal.created' : 'proposal.duplicate_suppressed', proposal, actor)
      return { proposal, created: Boolean(row) }
    }).immediate()
    if ('error' in result) return NextResponse.json({ error: result.error }, { status: result.status })
    if (result.created) broadcastProposal('proposal.created', result.proposal)
    return NextResponse.json({ proposal: result.proposal }, { status: result.created ? 201 : 200 })
  } catch {
    return NextResponse.json({ error: 'Unable to create task proposal' }, { status: 500 })
  }
}
