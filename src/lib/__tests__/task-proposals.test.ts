import { randomUUID } from 'crypto'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runMigrations } from '@/lib/migrations'
import {
  expirePendingTaskProposals,
  mapTaskProposalRow,
  taskProposalDecisionSchema,
  taskProposalEditSchema,
  taskProposalInputSchema,
  type TaskProposal,
  type TaskProposalInput,
} from '@/lib/task-proposals'

const input = {
  sourceType: 'chat',
  sourceRef: 'conversation:42',
  idempotencyKey: 'chat:42:fix-login',
  title: 'Repair the login redirect',
  objective: 'Return users to the requested page after authentication.',
  context: 'The completed auth audit found that callbackUrl is discarded.',
  rationale: 'This is the only unresolved finding from the audit.',
  risk: 'medium',
  routeForecast: { runtime: 'codex', model: 'gpt-5.6-sol', reason: 'Repository change with tests.' },
  projectId: 7,
} satisfies TaskProposalInput

const revision = '11111111-2222-4333-8444-555555555555'
const storedRow = {
  id: 12,
  workspace_id: 1,
  project_id: 7,
  source_type: 'chat',
  source_ref: 'conversation:42',
  idempotency_key: 'chat:42:fix-login',
  title: 'Repair the login redirect',
  objective: 'Return users to the requested page after authentication.',
  context: 'The completed auth audit found that callbackUrl is discarded.',
  rationale: 'This is the only unresolved finding from the audit.',
  risk: 'medium',
  route_forecast: '{"runtime":"codex","model":"gpt-5.6-sol","reason":"Repository change with tests."}',
  metadata: '{"auditId":42,"evidence":{"resolved":false}}',
  status: 'accepted',
  revision,
  orchestrator_agent: 'coordinator',
  created_by: 'audit-agent',
  accepted_by: 'operator',
  accepted_at: 1100,
  dismissed_by: null,
  dismissed_at: null,
  dismissal_reason: null,
  task_id: 23,
  expires_at: 1200,
  created_at: 900,
  updated_at: 1100,
}

describe('task proposal contracts', () => {
  it('accepts the producer contract and defaults metadata without requiring it in the input type', () => {
    const valid = taskProposalInputSchema.parse(input)
    expect(valid.title).toBe('Repair the login redirect')
    expect(valid.metadata).toEqual({})
    expect(taskProposalInputSchema.safeParse({ ...valid, title: '' }).success).toBe(false)
    expect(taskProposalInputSchema.safeParse({ ...valid, risk: 'urgent' }).success).toBe(false)
  })

  it.each([
    ['sourceRef', 500],
    ['idempotencyKey', 240],
    ['title', 240],
    ['objective', 2000],
    ['context', 8000],
    ['rationale', 2000],
  ])('trims %s and enforces its required length limit of %i', (field, limit) => {
    expect(taskProposalInputSchema.parse({ ...input, [field]: '  content  ' })[field as keyof TaskProposalInput]).toBe('content')
    expect(taskProposalInputSchema.safeParse({ ...input, [field]: '   ' }).success).toBe(false)
    expect(taskProposalInputSchema.safeParse({ ...input, [field]: 'x'.repeat(Number(limit)) }).success).toBe(true)
    expect(taskProposalInputSchema.safeParse({ ...input, [field]: 'x'.repeat(Number(limit) + 1) }).success).toBe(false)
  })

  it.each(['chat', 'event'])('accepts source type %s', sourceType => {
    expect(taskProposalInputSchema.safeParse({ ...input, sourceType }).success).toBe(true)
  })

  it.each(['low', 'medium', 'high', 'critical'])('accepts risk %s', risk => {
    expect(taskProposalInputSchema.safeParse({ ...input, risk }).success).toBe(true)
  })

  it.each(['local', 'codex', 'claude'])('accepts a %s route without a model', runtime => {
    expect(taskProposalInputSchema.parse({
      ...input, routeForecast: { runtime, reason: '  Bounded work.  ' },
    }).routeForecast).toEqual({ runtime, reason: 'Bounded work.' })
  })

  it('allows optional routing, project, expiry, and arbitrary object metadata', () => {
    expect(taskProposalInputSchema.parse({
      ...input, routeForecast: undefined, projectId: undefined,
      metadata: { source: { id: 42 }, signals: ['completed'], confidence: 0.8 },
    })).toMatchObject({ metadata: { source: { id: 42 }, signals: ['completed'], confidence: 0.8 } })
  })

  it.each([
    { sourceType: 'task' },
    { projectId: 0 }, { projectId: -1 }, { projectId: 1.5 }, { projectId: '7' },
    { expiresAt: 0 }, { expiresAt: -1 }, { expiresAt: 1.5 }, { expiresAt: '1200' },
    { metadata: null }, { metadata: [] }, { metadata: 'instructions' },
    { routeForecast: { runtime: 'shell', reason: 'Run it.' } },
    { routeForecast: { runtime: 'codex', reason: '  ' } },
    { routeForecast: { runtime: 'codex', reason: 'x'.repeat(501) } },
    { routeForecast: { runtime: 'codex', reason: 'Run it.', model: '  ' } },
    { routeForecast: { runtime: 'codex', reason: 'Run it.', model: 'x'.repeat(201) } },
  ])('rejects invalid producer data: %j', patch => {
    expect(taskProposalInputSchema.safeParse({ ...input, ...patch }).success).toBe(false)
  })

  it('accepts route length boundaries and positive integer project/expiry values', () => {
    expect(taskProposalInputSchema.parse({
      ...input, projectId: 1, expiresAt: 1,
      routeForecast: { runtime: 'codex', reason: 'x'.repeat(500), model: `  ${'m'.repeat(200)}  ` },
    }).routeForecast?.model).toHaveLength(200)
  })

  it('requires a UUID revision for editing, dismissal, and acceptance', () => {
    expect(taskProposalEditSchema.parse({ revision, action: 'edit', title: ' New title ' })).toEqual({
      revision, action: 'edit', title: 'New title',
    })
    expect(taskProposalEditSchema.parse({ revision, action: 'dismiss', dismissalReason: ' Not now ' })).toEqual({
      revision, action: 'dismiss', dismissalReason: 'Not now',
    })
    expect(taskProposalEditSchema.parse({ revision, action: 'edit' })).toEqual({ revision, action: 'edit' })
    expect(taskProposalDecisionSchema.parse({ revision })).toEqual({ revision })
    for (const invalid of [undefined, '', 'not-a-uuid']) {
      expect(taskProposalEditSchema.safeParse({ revision: invalid, action: 'edit' }).success).toBe(false)
      expect(taskProposalDecisionSchema.safeParse({ revision: invalid }).success).toBe(false)
    }
  })

  it('restricts edits to content fields and bounds optional dismissal reasons', () => {
    expect(taskProposalEditSchema.parse({
      revision, action: 'edit', risk: 'critical', orchestratorAgent: 'other',
    })).toEqual({ revision, action: 'edit' })
    expect(taskProposalEditSchema.safeParse({ revision, action: 'accept' }).success).toBe(false)
    expect(taskProposalEditSchema.safeParse({ revision }).success).toBe(false)
    expect(taskProposalEditSchema.safeParse({ revision, action: 'edit', objective: '' }).success).toBe(false)
    expect(taskProposalEditSchema.safeParse({ revision, action: 'edit', context: 'x'.repeat(8001) }).success).toBe(false)
    expect(taskProposalEditSchema.safeParse({ revision, action: 'dismiss', dismissalReason: 'x'.repeat(1000) }).success).toBe(true)
    expect(taskProposalEditSchema.safeParse({ revision, action: 'dismiss', dismissalReason: 'x'.repeat(1001) }).success).toBe(false)
  })
})

describe('mapTaskProposalRow', () => {
  it('returns a typed camelCase proposal with parsed routing, metadata, and audit fields', () => {
    const proposal: TaskProposal = mapTaskProposalRow(storedRow)
    expect(proposal).toEqual({
      ...input,
      id: 12, workspaceId: 1,
      metadata: { auditId: 42, evidence: { resolved: false } },
      status: 'accepted', revision, orchestratorAgent: 'coordinator', createdBy: 'audit-agent',
      acceptedBy: 'operator', acceptedAt: 1100,
      dismissedBy: null, dismissedAt: null, dismissalReason: null,
      taskId: 23, expiresAt: 1200, createdAt: 900, updatedAt: 1100,
    })
  })

  it('preserves absent database values without inventing a route or task', () => {
    expect(mapTaskProposalRow({
      ...storedRow, project_id: null, route_forecast: null, metadata: '{}',
      accepted_by: null, accepted_at: null, task_id: null, expires_at: null, status: 'pending',
    })).toMatchObject({
      projectId: null, routeForecast: undefined, metadata: {}, acceptedBy: null,
      acceptedAt: null, taskId: null, expiresAt: null, status: 'pending',
    })
  })

  it.each([
    ['route_forecast', '{broken'],
    ['route_forecast', 'null'],
    ['route_forecast', '[]'],
    ['route_forecast', '"run this"'],
    ['route_forecast', '{"runtime":"shell","reason":"Execute"}'],
    ['route_forecast', '{"runtime":"codex"}'],
    ['route_forecast', '{"runtime":"codex","reason":"  "}'],
    ['metadata', '{broken'],
    ['metadata', 'null'],
    ['metadata', '[]'],
    ['metadata', '"run this"'],
    ['metadata', '42'],
  ])('rejects invalid stored %s instead of returning executable data: %s', (field, value) => {
    expect(() => mapTaskProposalRow({ ...storedRow, [field]: value })).toThrow()
  })

  it('strips undeclared route execution fields', () => {
    expect(mapTaskProposalRow({
      ...storedRow,
      route_forecast: '{"runtime":"codex","reason":"Repository change.","command":"untrusted"}',
    }).routeForecast).toEqual({ runtime: 'codex', reason: 'Repository change.' })
  })
})

describe('task proposal persistence', () => {
  let db: InstanceType<typeof Database>

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    runMigrations(db)
  })

  afterEach(() => db.close())

  function insertProposal(patch: Record<string, unknown> = {}): number {
    return Number(db.prepare(`
      INSERT INTO task_proposals (
        workspace_id, project_id, source_type, source_ref, idempotency_key,
        title, objective, context, rationale, risk, route_forecast, metadata,
        status, revision, orchestrator_agent, created_by, task_id, expires_at,
        created_at, updated_at
      ) VALUES (
        @workspace_id, @project_id, @source_type, @source_ref, @idempotency_key,
        @title, @objective, @context, @rationale, @risk, @route_forecast, @metadata,
        @status, @revision, @orchestrator_agent, @created_by, @task_id, @expires_at,
        @created_at, @updated_at
      )
    `).run({
      ...storedRow, project_id: null, task_id: null, status: 'pending',
      idempotency_key: randomUUID(), expires_at: null, created_at: 900, updated_at: 900,
      ...patch,
    }).lastInsertRowid)
  }

  function row(id: number) {
    return db.prepare('SELECT * FROM task_proposals WHERE id = ?').get(id)
  }

  it('runs migration 056 twice with every required column, index, and default', () => {
    runMigrations(db)
    expect(db.prepare("SELECT id FROM schema_migrations WHERE id = '056_task_proposals'").get()).toEqual({ id: '056_task_proposals' })
    const columns = db.pragma('table_info(task_proposals)') as Array<{ name: string; notnull: number; dflt_value: string | null }>
    expect(columns.map(column => column.name)).toEqual([
      'id', 'workspace_id', 'project_id', 'source_type', 'source_ref', 'idempotency_key',
      'title', 'objective', 'context', 'rationale', 'risk', 'route_forecast', 'metadata',
      'status', 'revision', 'orchestrator_agent', 'created_by', 'accepted_by', 'accepted_at',
      'dismissed_by', 'dismissed_at', 'dismissal_reason', 'task_id', 'expires_at', 'created_at', 'updated_at',
    ])
    expect(columns.find(column => column.name === 'workspace_id')).toMatchObject({ notnull: 1 })
    expect(columns.find(column => column.name === 'metadata')).toMatchObject({ notnull: 1, dflt_value: "'{}'" })
    expect(columns.find(column => column.name === 'status')).toMatchObject({ notnull: 1, dflt_value: "'pending'" })
    const indexes = db.pragma('index_list(task_proposals)') as Array<{ name: string }>
    expect(indexes.map(index => index.name)).toEqual(expect.arrayContaining([
      'idx_task_proposals_workspace_status', 'idx_task_proposals_source',
    ]))
    expect((db.pragma('index_xinfo(idx_task_proposals_workspace_status)') as Array<{ name: string | null; desc: number }>).filter(column => column.name)).toMatchObject([
      { name: 'workspace_id', desc: 0 }, { name: 'status', desc: 0 }, { name: 'created_at', desc: 1 },
    ])
    expect((db.pragma('index_info(idx_task_proposals_source)') as Array<{ name: string }>).map(column => column.name)).toEqual(['workspace_id', 'source_type', 'source_ref'])
    const defaults = db.prepare(`
      INSERT INTO task_proposals (workspace_id, source_type, source_ref, idempotency_key,
        title, objective, context, rationale, risk, revision, orchestrator_agent, created_by)
      VALUES (1, 'event', 'run:1', 'run:1:followup', 'Title', 'Objective', 'Context',
        'Rationale', 'low', ?, 'coordinator', 'agent') RETURNING *
    `).get(revision)
    expect(defaults).toMatchObject({ status: 'pending', metadata: '{}', project_id: null, task_id: null, created_at: expect.any(Number), updated_at: expect.any(Number) })
  })

  it('can replay migration 056 against existing proposals without losing data', () => {
    const id = insertProposal()
    const before = row(id)
    db.prepare("DELETE FROM schema_migrations WHERE id = '056_task_proposals'").run()
    expect(() => runMigrations(db)).not.toThrow()
    expect(row(id)).toEqual(before)
  })

  it('enforces idempotency within a workspace while allowing the same key in another', () => {
    insertProposal({ idempotency_key: 'shared' })
    expect(() => insertProposal({ idempotency_key: 'shared' })).toThrow(/UNIQUE constraint failed: task_proposals.workspace_id, task_proposals.idempotency_key/)
    expect(() => insertProposal({ workspace_id: 2, idempotency_key: 'shared' })).not.toThrow()
    expect(db.prepare('SELECT COUNT(*) AS count FROM task_proposals').get()).toEqual({ count: 2 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM tasks').get()).toEqual({ count: 0 })
  })

  it.each([
    { workspace_id: null }, { source_type: 'task' }, { risk: 'urgent' },
    { status: 'launched' }, { revision: null }, { orchestrator_agent: null }, { created_by: null },
    { project_id: 99999 }, { task_id: 99999 },
  ])('enforces storage constraints: %j', patch => {
    expect(() => insertProposal(patch)).toThrow(/constraint failed/)
  })

  it('preserves proposal history when its project or accepted task is deleted', () => {
    const projectId = (db.prepare('SELECT id FROM projects LIMIT 1').get() as { id: number }).id
    const taskId = Number(db.prepare("INSERT INTO tasks (title, created_by) VALUES ('Accepted task', 'operator')").run().lastInsertRowid)
    const id = insertProposal({ project_id: projectId, task_id: taskId, status: 'accepted' })
    db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId)
    db.prepare('DELETE FROM projects WHERE id = ?').run(projectId)
    expect(row(id)).toMatchObject({ id, status: 'accepted', project_id: null, task_id: null })
    expect(db.pragma('foreign_key_check')).toEqual([])
  })

  it('expires only due pending proposals in the requested workspace with distinct fresh revisions', () => {
    const due = insertProposal({ expires_at: 999 })
    const boundary = insertProposal({ expires_at: 1000 })
    const untouched = [
      insertProposal({ expires_at: 1001 }),
      insertProposal(),
      insertProposal({ status: 'accepted', expires_at: 999 }),
      insertProposal({ status: 'dismissed', expires_at: 999 }),
      insertProposal({ status: 'expired', expires_at: 999 }),
      insertProposal({ workspace_id: 2, expires_at: 999 }),
    ]
    const before = untouched.map(row)
    const expired: TaskProposal[] = expirePendingTaskProposals(db, 1, 1000)
    expect(expired.map(proposal => proposal.id).sort((a, b) => a - b)).toEqual([due, boundary])
    expect(new Set(expired.map(proposal => proposal.revision)).size).toBe(2)
    for (const proposal of expired) {
      expect(proposal.revision).not.toBe(revision)
      expect(taskProposalDecisionSchema.safeParse({ revision: proposal.revision }).success).toBe(true)
      expect(proposal).toMatchObject({
        workspaceId: 1, status: 'expired', updatedAt: 1000,
        metadata: { auditId: 42, evidence: { resolved: false } },
        routeForecast: { runtime: 'codex', model: 'gpt-5.6-sol', reason: 'Repository change with tests.' },
      })
      expect(row(proposal.id)).toMatchObject({ status: 'expired', revision: proposal.revision, updated_at: 1000 })
    }
    expect(untouched.map(row)).toEqual(before)
  })

  it('returns no events and preserves revisions on a repeated expiry call', () => {
    const id = insertProposal({ expires_at: 1000 })
    expect(expirePendingTaskProposals(db, 1, 1000).map(proposal => proposal.id)).toEqual([id])
    const expired = row(id)
    expect(expirePendingTaskProposals(db, 1, 1000)).toEqual([])
    expect(row(id)).toEqual(expired)
  })

  it('returns no rows when there is nothing due in the requested workspace', () => {
    insertProposal({ workspace_id: 2, expires_at: 999 })
    expect(expirePendingTaskProposals(db, 1, 1000)).toEqual([])
  })

  it('rolls back the entire expiry transaction when a changed row contains invalid stored JSON', () => {
    const valid = insertProposal({ expires_at: 999 })
    const corrupt = insertProposal({ expires_at: 999, metadata: '{broken' })
    const before = [row(valid), row(corrupt)]
    expect(() => expirePendingTaskProposals(db, 1, 1000)).toThrow()
    expect([row(valid), row(corrupt)]).toEqual(before)
  })
})
