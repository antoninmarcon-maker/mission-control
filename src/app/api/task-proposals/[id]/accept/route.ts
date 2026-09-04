import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { getDatabase, type Task } from '@/lib/db'
import { eventBus } from '@/lib/event-bus'
import { requireWorkspaceId } from '@/lib/enforcement/workspace-scope'
import { mutationLimiter } from '@/lib/rate-limit'
import { mapTaskProposalRow, taskProposalDecisionSchema } from '@/lib/task-proposals'
import { auditProposal, broadcastProposal, expireProposals, proposalId } from '../../_lib'

function mapTask(task: Task) {
  return { ...task, tags: task.tags ? JSON.parse(task.tags) : [], metadata: task.metadata ? JSON.parse(task.metadata) : {} }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const limited = mutationLimiter(request)
  if (limited) return limited
  // Same human decision boundary as the clarification answer route, including admin agent keys.
  if (auth.user.agent_name || auth.user.agent_id || auth.user.id <= 0) return NextResponse.json({ error: 'A human user must accept the proposal' }, { status: 403 })
  const ws = requireWorkspaceId(auth.user)
  if (!('workspaceId' in ws)) return ws.response
  const id = proposalId((await params).id)
  if (!id) return NextResponse.json({ error: 'Invalid proposal ID' }, { status: 400 })
  let body: unknown
  try { body = await request.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }
  const parsed = taskProposalDecisionSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ error: 'Invalid proposal decision' }, { status: 400 })
  const actor = auth.user.display_name || auth.user.username
  try {
    const db = getDatabase()
    expireProposals(db, ws.workspaceId)
    const result = db.transaction(() => {
      const row = db.prepare('SELECT * FROM task_proposals WHERE id = ? AND workspace_id = ?').get(id, ws.workspaceId)
      if (!row) return { error: 'Proposal not found', status: 404 }
      const proposal = mapTaskProposalRow(row)
      // Check the linked task before revisions: the original acceptance revision is valid on retry.
      if (proposal.status === 'accepted') {
        const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND workspace_id = ?').get(proposal.taskId, ws.workspaceId) as Task | undefined
        if (!task) return { error: 'Accepted proposal task is unavailable', status: 409 }
        return { proposal, task: mapTask(task), created: false }
      }
      const now = Math.floor(Date.now() / 1000)
      if (proposal.status !== 'pending' || proposal.revision !== parsed.data.revision || (proposal.expiresAt !== null && proposal.expiresAt <= now)) {
        return { error: 'Proposal changed or is no longer pending', status: 409 }
      }
      if (!proposal.orchestratorAgent.trim()) return { error: 'Proposal orchestrator is unavailable', status: 409 }
      let ticketNumber: number | null = null
      if (proposal.projectId !== null) {
        const project = db.prepare(`
          UPDATE projects SET ticket_counter = ticket_counter + 1, updated_at = ?
          WHERE id = ? AND workspace_id = ? AND status = 'active' RETURNING ticket_counter
        `).get(now, proposal.projectId, ws.workspaceId) as { ticket_counter: number } | undefined
        if (!project) return { error: 'Proposal project is unavailable', status: 409 }
        ticketNumber = project.ticket_counter
      }
      const description = [proposal.objective, '', '## Context', proposal.context, '', '## Why now', proposal.rationale].join('\n')
      const taskMetadata = {
        proposal: {
          id: proposal.id, source_type: proposal.sourceType, source_ref: proposal.sourceRef,
          accepted_by: actor, route_forecast: proposal.routeForecast,
        },
      }
      const taskRow = db.prepare(`
        INSERT INTO tasks (title, description, status, priority, project_id, project_ticket_no,
          assigned_to, created_by, created_at, updated_at, tags, metadata, workspace_id)
        VALUES (?, ?, 'assigned', ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?) RETURNING *
      `).get(proposal.title, description, proposal.risk, proposal.projectId, ticketNumber,
        proposal.orchestratorAgent, actor, now, now, JSON.stringify(taskMetadata), ws.workspaceId) as Task
      const accepted = db.prepare(`
        UPDATE task_proposals SET status = 'accepted', task_id = ?, accepted_by = ?, accepted_at = ?, revision = ?, updated_at = ?
        WHERE id = ? AND workspace_id = ? AND status = 'pending' AND revision = ? AND (expires_at IS NULL OR expires_at > ?)
        RETURNING *
      `).get(taskRow.id, actor, now, randomUUID(), now, id, ws.workspaceId, parsed.data.revision, now)
      // A lost CAS must throw so task insertion and ticket allocation roll back together.
      if (!accepted) throw new Error('Proposal acceptance conflict')
      const acceptedProposal = mapTaskProposalRow(accepted)
      auditProposal(db, 'proposal.accepted', acceptedProposal, actor)
      return { proposal: acceptedProposal, task: mapTask(taskRow), created: true }
    }).immediate()
    if ('error' in result) return NextResponse.json({ error: result.error }, { status: result.status })
    if (result.created) {
      broadcastProposal('proposal.accepted', result.proposal)
      eventBus.broadcast('task.created', { id: result.task.id, workspace_id: ws.workspaceId })
    }
    return NextResponse.json({ proposal: result.proposal, task: result.task })
  } catch {
    return NextResponse.json({ error: 'Unable to accept task proposal' }, { status: 500 })
  }
}
