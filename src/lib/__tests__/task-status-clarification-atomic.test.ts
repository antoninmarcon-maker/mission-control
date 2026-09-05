// @vitest-environment node
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NextRequest } from 'next/server'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { runMigrations } from '@/lib/migrations'
import { PUT } from '@/app/api/tasks/[id]/route'

const state = vi.hoisted(() => ({ db: null as unknown as Database.Database, workspace: 1, role: 'operator', agentName: null as string | null, broadcast: vi.fn() }))
vi.mock('@/lib/db', () => ({ getDatabase: () => state.db, db_helpers: { createNotification: vi.fn(), ensureTaskSubscription: vi.fn(), logActivity: vi.fn() } }))
vi.mock('@/lib/auth', () => ({ requireRole: () => state.role === 'viewer' ? { error: 'Forbidden', status: 403 } : ({ user: { id: 1, role: state.role, agent_name: state.agentName, username: 'operator', workspace_id: state.workspace } }) }))
vi.mock('@/lib/rate-limit', () => ({ mutationLimiter: () => null }))
vi.mock('@/lib/event-bus', () => ({ eventBus: { broadcast: state.broadcast } }))
vi.mock('@/lib/task-dispatch', () => ({ reconcileDeferredTaskCompletions: vi.fn() }))
vi.mock('@/lib/github-sync-engine', () => ({ syncTaskOutbound: vi.fn() }))
vi.mock('@/lib/gnap-sync', () => ({ removeTaskFromGnap: vi.fn() }))
let directory: string
let concurrent: Database.Database
let taskId: number
const pending = { state: 'pending', revision: 'pending', questions: [], createdBy: 'agent', createdAt: 1 }
const ownership = {
  id: 12,
  execution_owner: 'external_orchestrator',
  accepted_user_id: 1,
  route_forecast: { runtime: 'local', model: 'qwen2.5-coder:7b', reason: 'low-risk' },
}
const put = (body: unknown) => PUT(new NextRequest(`http://localhost/api/tasks/${taskId}`, {
  method: 'PUT', body: JSON.stringify(body),
}), { params: Promise.resolve({ id: String(taskId) }) })
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'mc-status-cas-'))
  state.db = new Database(join(directory, 'test.db'))
  state.db.pragma('journal_mode = WAL')
  runMigrations(state.db)
  // Legacy malformed metadata can predate the recurrence expression index.
  // Remove that unrelated index so these fixtures reach the API guard.
  state.db.exec('DROP INDEX IF EXISTS idx_tasks_recurring')
  concurrent = new Database(join(directory, 'test.db'))
  state.workspace = 1
  state.role = 'operator'
  state.agentName = null
  state.broadcast.mockClear()
  taskId = Number(state.db.prepare("INSERT INTO tasks (title, status, created_by, workspace_id, metadata) VALUES ('Task', 'assigned', 'operator', 1, ?)")
    .run(JSON.stringify({ proposal: ownership })).lastInsertRowid)
  state.db.prepare("INSERT INTO quality_reviews (task_id, reviewer, status, workspace_id, notes) VALUES (?, 'aegis', 'approved', 1, 'OK')").run(taskId)
})
afterEach(() => {
  vi.restoreAllMocks()
  concurrent.close()
  state.db.close()
  rmSync(directory, { recursive: true, force: true })
})

function installPendingBeforeUpdate() {
  const prepare = state.db.prepare.bind(state.db)
  const spy = vi.spyOn(state.db, 'prepare').mockImplementation(((sql: string) => {
    if (sql.includes('UPDATE tasks')) {
      spy.mockRestore()
      concurrent.prepare("UPDATE tasks SET metadata = json_set(metadata, '$.clarification', json(?)) WHERE id = ?")
        .run(JSON.stringify(pending), taskId)
    }
    return prepare(sql)
  }) as typeof state.db.prepare)
}

it.each(['in_progress', 'review', 'quality_review', 'done'])('atomically rejects %s when another connection installs pending clarification after the initial read', async (status) => {
  installPendingBeforeUpdate()
  const response = await put({ status })
  expect(response.status).toBe(409)
  expect(state.db.prepare('SELECT status, completed_at FROM tasks WHERE id = ?').get(taskId)).toEqual({ status: 'assigned', completed_at: null })
  expect(state.broadcast).not.toHaveBeenCalled()
})

it('preserves external ownership and current clarification during ordinary stale metadata edits', async () => {
  installPendingBeforeUpdate()
  const response = await put({ title: 'Renamed', metadata: { other: 42, proposal: { execution_owner: 'internal' }, clarification: { state: 'answered' } } })
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ task: { title: 'Renamed', status: 'assigned', metadata: { other: 42, proposal: ownership, clarification: pending } } })
})

it('does not edit or advance a task in another workspace', async () => {
  state.workspace = 2
  expect((await put({ status: 'in_progress', title: 'Hijacked' })).status).toBe(404)
  expect(state.db.prepare('SELECT title, status FROM tasks WHERE id = ?').get(taskId)).toEqual({ title: 'Task', status: 'assigned' })
})

const routeDecision = { proposal_id: 12, runtime: 'codex', reason: 'next_cloud_rung' }

it('merges the final route atomically into concurrent metadata without replacing accepted proposal data', async () => {
  installPendingBeforeUpdate()
  const response = await put({ proposal_final_route: routeDecision })
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ task: { metadata: {
    clarification: pending,
    proposal: { ...ownership, final_route: { runtime: 'codex', reason: 'next_cloud_rung' } },
  } } })
})

it.each([
  { proposal_final_route: { ...routeDecision, proposal_id: 13 } },
  { proposal_final_route: routeDecision, metadata: { other: 1 } },
  { proposal_final_route: { ...routeDecision, runtime: 'unknown' } },
  { proposal_final_route: { ...routeDecision, reason: '' } },
  { proposal_final_route: { ...routeDecision, execution_owner: 'internal' } },
])('refuses incompatible or invalid proposal route payloads: %j', async (body) => {
  expect([400, 409]).toContain((await put(body)).status)
  expect(JSON.parse((state.db.prepare('SELECT metadata FROM tasks WHERE id = ?').get(taskId) as any).metadata)).toEqual({ proposal: ownership })
})

it.each(['broken json', '[]', 'null', '{}', JSON.stringify({ proposal: { ...ownership, execution_owner: 'internal' } })])('fails closed for unusable stored proposal metadata: %s', async (metadata) => {
  state.db.prepare('UPDATE tasks SET metadata = ? WHERE id = ?').run(metadata, taskId)
  expect((await put({ proposal_final_route: routeDecision })).status).toBe(409)
})

it.each(['id', 'execution_owner', 'metadata'])('rechecks proposal %s after a concurrent change', async (field) => {
  const prepare = state.db.prepare.bind(state.db)
  const spy = vi.spyOn(state.db, 'prepare').mockImplementation(((sql: string) => {
    if (sql.includes('UPDATE tasks')) {
      spy.mockRestore()
      if (field === 'metadata') concurrent.prepare("UPDATE tasks SET metadata = 'broken' WHERE id = ?").run(taskId)
      else concurrent.prepare(`UPDATE tasks SET metadata = json_set(metadata, '$.proposal.${field}', ?) WHERE id = ?`).run(field === 'id' ? 13 : 'internal', taskId)
    }
    return prepare(sql)
  }) as typeof state.db.prepare)
  expect((await put({ proposal_final_route: routeDecision })).status).toBe(409)
  expect(state.broadcast).not.toHaveBeenCalled()
})

it('keeps final route writes workspace scoped', async () => {
  state.workspace = 2
  expect((await put({ proposal_final_route: routeDecision })).status).toBe(404)
})

it('requires operator access and keeps agent writes restricted to their own task', async () => {
  state.role = 'viewer'
  expect((await put({ proposal_final_route: routeDecision })).status).toBe(403)
  state.role = 'operator'
  state.agentName = 'other-agent'
  expect((await put({ proposal_final_route: routeDecision })).status).toBe(403)
  state.db.prepare('UPDATE tasks SET assigned_to = ? WHERE id = ?').run(state.agentName, taskId)
  expect((await put({ proposal_final_route: routeDecision })).status).toBe(200)
})

function beforeTaskUpdate(operation: () => void) {
  const prepare = state.db.prepare.bind(state.db)
  const spy = vi.spyOn(state.db, 'prepare').mockImplementation(((sql: string) => {
    if (sql.includes('UPDATE tasks')) {
      spy.mockRestore()
      operation()
    }
    return prepare(sql)
  }) as typeof state.db.prepare)
}

it('rejects an agent final-route write if assignment changes from A to B after authorization', async () => {
  state.agentName = 'agent-A'
  state.db.prepare('UPDATE tasks SET assigned_to = ? WHERE id = ?').run('agent-A', taskId)
  beforeTaskUpdate(() => concurrent.prepare('UPDATE tasks SET assigned_to = ? WHERE id = ?').run('agent-B', taskId))
  expect((await put({ proposal_final_route: routeDecision, title: 'Must not change' })).status).toBe(409)
  const row = state.db.prepare('SELECT title, assigned_to, metadata FROM tasks WHERE id = ?').get(taskId) as any
  expect(row.title).toBe('Task')
  expect(row.assigned_to).toBe('agent-B')
  expect(JSON.parse(row.metadata)).toEqual({ proposal: ownership })
  expect(state.broadcast).not.toHaveBeenCalled()
})

it('rejects a concurrent proposal ID change from integer 1 to JSON true', async () => {
  state.db.prepare("UPDATE tasks SET metadata = json_set(metadata, '$.proposal.id', 1) WHERE id = ?").run(taskId)
  beforeTaskUpdate(() => concurrent.prepare("UPDATE tasks SET metadata = json_set(metadata, '$.proposal.id', json('true')) WHERE id = ?").run(taskId))
  expect((await put({ proposal_final_route: { ...routeDecision, proposal_id: 1 } })).status).toBe(409)
  expect(JSON.parse((state.db.prepare('SELECT metadata FROM tasks WHERE id = ?').get(taskId) as any).metadata)).toEqual({ proposal: { ...ownership, id: true } })
  expect(state.broadcast).not.toHaveBeenCalled()
})

it.each([
  { role: 'admin', body: { proposal_final_route: routeDecision } },
  { role: 'operator', body: { title: 'Ordinary update' } },
])('preserves the existing assignment behavior outside non-admin route writes: %j', async ({ role, body }) => {
  state.role = role
  state.agentName = 'agent-A'
  state.db.prepare('UPDATE tasks SET assigned_to = ? WHERE id = ?').run('agent-A', taskId)
  beforeTaskUpdate(() => concurrent.prepare('UPDATE tasks SET assigned_to = ? WHERE id = ?').run('agent-B', taskId))
  expect((await put(body)).status).toBe(200)
  expect((state.db.prepare('SELECT assigned_to FROM tasks WHERE id = ?').get(taskId) as any).assigned_to).toBe('agent-B')
})

it.each(['review', 'quality_review', 'done', 'awaiting_owner', 'failed', 'inbox'])('freezes final_route once the task leaves execution states: %s', async (status) => {
  state.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run(status, taskId)
  expect((await put({ proposal_final_route: routeDecision })).status).toBe(409)
})

it('atomically freezes final_route when completion wins the race', async () => {
  beforeTaskUpdate(() => concurrent.prepare("UPDATE tasks SET status = 'review' WHERE id = ?").run(taskId))
  expect((await put({ proposal_final_route: routeDecision })).status).toBe(409)
  expect(JSON.parse((state.db.prepare('SELECT metadata FROM tasks WHERE id = ?').get(taskId) as any).metadata)).toEqual({ proposal: ownership })
})

it.each(['assigned', 'in_progress'])('allows route audit in actual pre-provider state %s', async (status) => {
  state.db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run(status, taskId)
  expect((await put({ proposal_final_route: routeDecision })).status).toBe(200)
})

async function readAudit(proposalId: number | string = 12) {
  const { GET } = await import('@/app/api/tasks/[id]/proposal-audit/route')
  return GET(new NextRequest(`http://localhost/api/tasks/${taskId}/proposal-audit?proposal_id=${proposalId}`), { params: Promise.resolve({ id: String(taskId) }) })
}

it('exposes only proposal route audit to the original agent after reviewer handoff', async () => {
  state.agentName = 'original-agent'
  state.db.prepare('UPDATE tasks SET assigned_to = ? WHERE id = ?').run(state.agentName, taskId)
  expect((await put({ proposal_final_route: routeDecision })).status).toBe(200)
  expect((await put({ status: 'review', assigned_to: 'reviewer' })).status).toBe(200)
  const { GET } = await import('@/app/api/tasks/[id]/route')
  expect((await GET(new NextRequest(`http://localhost/api/tasks/${taskId}`), { params: Promise.resolve({ id: String(taskId) }) })).status).toBe(403)
  const response = await readAudit()
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ proposal: {
    id: 12, route_forecast: ownership.route_forecast, final_route: { runtime: 'codex', reason: 'next_cloud_rung' },
  } })
})

it.each(['workspace', 'owner', 'id', 'malformed', 'boolean', 'viewer'])('refuses minimal audit outside its validated scope: %s', async (scenario) => {
  expect((await put({ proposal_final_route: routeDecision })).status).toBe(200)
  if (scenario === 'workspace') state.workspace = 2
  if (scenario === 'owner') state.db.prepare("UPDATE tasks SET metadata = json_set(metadata, '$.proposal.execution_owner', 'internal')").run()
  if (scenario === 'malformed') state.db.prepare("UPDATE tasks SET metadata = 'bad'").run()
  if (scenario === 'boolean') state.db.prepare("UPDATE tasks SET metadata = json_set(metadata, '$.proposal.id', json('true'))").run()
  if (scenario === 'viewer') state.role = 'viewer'
  const response = await readAudit(scenario === 'id' || scenario === 'boolean' ? 1 : 12)
  expect(response.status).toBe(scenario === 'viewer' ? 403 : 404)
  expect(await response.json()).not.toHaveProperty('proposal')
})

it.each(['', '0', '1x', '9007199254740992'])('rejects malformed proposal audit ID %s', async (id) => {
  expect((await readAudit(id)).status).toBe(400)
})

it('returns null for missing forecast and never exposes extra descriptor content', async () => {
  expect((await put({ proposal_final_route: routeDecision })).status).toBe(200)
  state.db.prepare("UPDATE tasks SET metadata = json_remove(metadata, '$.proposal.route_forecast')").run()
  const response = await readAudit()
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ proposal: { id: 12, route_forecast: null, final_route: { runtime: 'codex', reason: 'next_cloud_rung' } } })
  state.db.prepare("UPDATE tasks SET metadata = json_set(metadata, '$.proposal.final_route.context', 'PRIVATE')").run()
  const malformed = await readAudit()
  expect(malformed.status).toBe(404)
  expect(await malformed.text()).not.toContain('PRIVATE')
})
