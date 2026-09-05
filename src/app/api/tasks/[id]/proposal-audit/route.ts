import { NextRequest, NextResponse } from 'next/server'
import { requireRole } from '@/lib/auth'
import { getDatabase } from '@/lib/db'
import { requireWorkspaceId } from '@/lib/enforcement/workspace-scope'
import { taskProposalInputSchema } from '@/lib/task-proposals'

const routeSchema = taskProposalInputSchema.shape.routeForecast.unwrap().strict()

/** Minimal readback remains available to an operator after reviewer handoff. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = requireRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const ws = requireWorkspaceId(auth.user)
  if (!('workspaceId' in ws)) return ws.response
  const taskId = (await params).id
  const proposalId = request.nextUrl.searchParams.get('proposal_id') ?? ''
  if ([taskId, proposalId].some((id) => !/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id)))) {
    return NextResponse.json({ error: 'Invalid task or proposal ID' }, { status: 400 })
  }
  // One statement validates identity and ownership against the same snapshot
  // it projects. No assignee check: this route deliberately exposes no task data.
  const row = getDatabase().prepare(`
    SELECT json_extract(metadata, '$.proposal.route_forecast') AS route_forecast,
           json_extract(metadata, '$.proposal.final_route') AS final_route
    FROM tasks WHERE id = ? AND workspace_id = ?
      AND CASE WHEN json_valid(metadata) THEN
        json_type(metadata) = 'object'
        AND json_type(metadata, '$.proposal') = 'object'
        AND json_type(metadata, '$.proposal.id') = 'integer'
        AND json_extract(metadata, '$.proposal.id') = ?
        AND json_type(metadata, '$.proposal.execution_owner') = 'text'
        AND json_extract(metadata, '$.proposal.execution_owner') = 'external_orchestrator'
        ELSE 0 END
  `).get(Number(taskId), ws.workspaceId, Number(proposalId)) as { route_forecast: string | null; final_route: string | null } | undefined
  if (row) {
    try {
      const forecast = row.route_forecast === null ? null : routeSchema.parse(JSON.parse(row.route_forecast))
      const finalRoute = routeSchema.parse(JSON.parse(row.final_route ?? 'null'))
      return NextResponse.json({ proposal: { id: Number(proposalId), route_forecast: forecast, final_route: finalRoute } }, {
        headers: { 'Cache-Control': 'no-store' },
      })
    } catch { /* A malformed audit must never leak arbitrary nested metadata. */ }
  }
  return NextResponse.json({ error: 'Proposal audit not found' }, { status: 404 })
}
