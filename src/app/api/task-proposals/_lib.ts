import type Database from 'better-sqlite3'
import { eventBus, type EventType } from '@/lib/event-bus'
import { expirePendingTaskProposals, type TaskProposal } from '@/lib/task-proposals'

type ProposalEvent = Extract<EventType, `proposal.${string}`>

export function auditProposal(db: Database.Database, action: ProposalEvent | 'proposal.duplicate_suppressed', proposal: TaskProposal, actor: string) {
  db.prepare(`
    INSERT INTO audit_log (action, actor, target_type, target_id, detail, workspace_id)
    VALUES (?, ?, 'task_proposal', ?, ?, ?)
  `).run(action, actor, proposal.id, JSON.stringify({
    proposalId: proposal.id, sourceType: proposal.sourceType, actor,
    revision: proposal.revision, ...(proposal.taskId === null ? {} : { taskId: proposal.taskId }),
  }), proposal.workspaceId)
}

/** Invalidation payload only: prose, source references and arbitrary metadata may be private. */
export function broadcastProposal(type: ProposalEvent, proposal: TaskProposal) {
  eventBus.broadcast(type, {
    id: proposal.id, workspace_id: proposal.workspaceId, status: proposal.status,
    revision: proposal.revision, sourceType: proposal.sourceType, taskId: proposal.taskId,
  })
}

/** Expiry and its audit commit together; notify listeners only after that commit. */
export function expireProposals(db: Database.Database, workspaceId: number) {
  const expired = db.transaction(() => {
    const proposals = expirePendingTaskProposals(db, workspaceId, Math.floor(Date.now() / 1000))
    for (const proposal of proposals) auditProposal(db, 'proposal.expired', proposal, 'system')
    return proposals
  }).immediate()
  for (const proposal of expired) broadcastProposal('proposal.expired', proposal)
}

export function proposalId(raw: string): number | null {
  return /^[1-9]\d*$/.test(raw) && Number.isSafeInteger(Number(raw)) ? Number(raw) : null
}
