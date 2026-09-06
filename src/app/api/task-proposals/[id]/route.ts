import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { getDatabase } from '@/lib/db'
import { requireWorkspaceId } from '@/lib/enforcement/workspace-scope'
import { mutationLimiter } from '@/lib/rate-limit'
import { mapTaskProposalRow, taskProposalEditSchema } from '@/lib/task-proposals'
import { auditProposal, broadcastProposal, expireProposals, proposalId } from '../_lib'

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const limited = mutationLimiter(request)
  if (limited) return limited
  const ws = requireWorkspaceId(auth.user)
  if (!('workspaceId' in ws)) return ws.response
  const id = proposalId((await params).id)
  if (!id) return NextResponse.json({ error: 'Invalid proposal ID' }, { status: 400 })
  let body: unknown
  try { body = await request.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }
  const parsed = taskProposalEditSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid proposal decision' }, { status: 400 })
  const data = parsed.data
  const actor = auth.user.agent_name || auth.user.display_name || auth.user.username
  const event = data.action === 'dismiss' ? 'proposal.dismissed' : 'proposal.updated'
  try {
    const db = getDatabase()
    expireProposals(db, ws.workspaceId)
    const result = db.transaction(() => {
      const current = db.prepare('SELECT * FROM task_proposals WHERE id = ? AND workspace_id = ?').get(id, ws.workspaceId)
      if (!current) return { error: 'Proposal not found', status: 404 }
      const previous = mapTaskProposalRow(current)
      const now = Math.floor(Date.now() / 1000)
      const revision = randomUUID()
      const row = data.action === 'dismiss'
        ? db.prepare(`
          UPDATE task_proposals SET status = 'dismissed', dismissed_by = ?, dismissed_at = ?, dismissal_reason = ?, revision = ?, updated_at = ?
          WHERE id = ? AND workspace_id = ? AND status = 'pending' AND revision = ? AND (expires_at IS NULL OR expires_at > ?)
          RETURNING *
        `).get(actor, now, data.dismissalReason ?? null, revision, now, id, ws.workspaceId, data.revision, now)
        : db.prepare(`
          UPDATE task_proposals SET title = ?, objective = ?, context = ?, revision = ?, updated_at = ?
          WHERE id = ? AND workspace_id = ? AND status = 'pending' AND revision = ? AND (expires_at IS NULL OR expires_at > ?)
          RETURNING *
        `).get(data.title ?? previous.title, data.objective ?? previous.objective, data.context ?? previous.context,
          revision, now, id, ws.workspaceId, data.revision, now)
      if (!row) return { error: 'Proposal changed or is no longer pending', status: 409 }
      const proposal = mapTaskProposalRow(row)
      auditProposal(db, event, proposal, actor)
      return { proposal }
    }).immediate()
    if ('error' in result) return NextResponse.json({ error: result.error }, { status: result.status })
    broadcastProposal(event, result.proposal)
    return NextResponse.json(result)
  } catch {
    return NextResponse.json({ error: 'Unable to update task proposal' }, { status: 500 })
  }
}
