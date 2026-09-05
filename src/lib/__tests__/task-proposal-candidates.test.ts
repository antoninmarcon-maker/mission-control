// @vitest-environment node
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GET } from '@/app/api/tasks/route'
import { runMigrations } from '@/lib/migrations'

const state = vi.hoisted(() => ({
  db: null as unknown as Database.Database,
  workspaceId: 1 as number | undefined,
  role: 'viewer',
  agentName: undefined as string | undefined,
}))
vi.mock('@/lib/db', () => ({ getDatabase: () => state.db }))
vi.mock('@/lib/auth', () => ({
  requireRole: () => ({ user: {
    id: 1, username: 'reader', role: state.role,
    workspace_id: state.workspaceId, agent_name: state.agentName,
  } }),
}))
// Runtime reconciliation is covered separately against real SQLite; listing must not contact a gateway in these tests.
vi.mock('@/lib/task-dispatch', () => ({ reconcileDeferredTaskCompletions: vi.fn() }))
vi.mock('@/lib/github-sync-engine', () => ({ pushTaskToGitHub: vi.fn(), syncTaskOutbound: vi.fn() }))
vi.mock('@/lib/gnap-sync', () => ({ pushTaskToGnap: vi.fn() }))

const timestamp = 1_788_560_000
const request = (query: Record<string, string> = {}) => GET(new NextRequest(
  `http://localhost/api/tasks?${new URLSearchParams(query)}`,
))
async function candidates(query: Record<string, string> = {}) {
  const response = await request({ proposal_candidate: '1', updated_since: String(timestamp), ...query })
  expect(response.status).toBe(200)
  return response.json()
}
function seed(id: number, status: string, updatedAt: number, options: {
  workspaceId?: number
  createdAt?: number
  assignedTo?: string
  priority?: string
  projectId?: number
} = {}) {
  state.db.prepare(`
    INSERT INTO tasks (id, title, status, created_by, workspace_id, created_at, updated_at,
      assigned_to, priority, project_id, project_ticket_no, tags, metadata, description, error_message)
    VALUES (?, ?, ?, 'test', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, `Task ${id}`, status, options.workspaceId ?? 1, options.createdAt ?? id, updatedAt,
    options.assignedTo ?? null, options.priority ?? 'medium', options.projectId ?? null, id,
    '["follow-up"]', '{"next_actions":["Verify repair"]}', 'Task context', 'Failure context')
}

beforeEach(() => {
  state.db = new Database(':memory:')
  runMigrations(state.db)
  state.workspaceId = 1
  state.role = 'viewer'
  state.agentName = undefined
})
afterEach(() => state.db.close())

describe('task proposal candidate cursor', () => {
  it('returns only eligible statuses at or after the timestamp in the caller workspace', async () => {
    seed(1, 'done', timestamp - 1)
    seed(2, 'done', timestamp)
    seed(3, 'failed', timestamp + 1)
    seed(4, 'awaiting_owner', timestamp + 2)
    seed(5, 'review', timestamp + 3)
    seed(6, 'quality_review', timestamp + 4)
    seed(7, 'inbox', timestamp + 5)
    seed(8, 'assigned', timestamp + 6)
    seed(9, 'in_progress', timestamp + 7)
    seed(10, 'done', timestamp + 8, { workspaceId: 2 })

    const body = await candidates()

    expect(body.tasks.map((task: { id: number }) => task.id)).toEqual([2, 3, 4, 5, 6])
    expect(body.nextCursor).toEqual({ updatedAt: timestamp + 4, id: 6 })
    expect(body.tasks.every((task: { workspace_id: number }) => task.workspace_id === 1)).toBe(true)
    expect(body.tasks[0]).toMatchObject({
      status: 'done', description: 'Task context', error_message: 'Failure context',
      tags: ['follow-up'], metadata: { next_actions: ['Verify repair'] },
    })

    state.workspaceId = 2
    const other = await candidates()
    expect(other.tasks.map((task: { id: number }) => task.id)).toEqual([10])
    expect(other.nextCursor).toEqual({ updatedAt: timestamp + 8, id: 10 })
  })

  it('uses updated_at then id across pages without repeating tied timestamps or skipping newer lower ids', async () => {
    seed(10, 'done', timestamp + 1, { createdAt: 300 })
    seed(20, 'failed', timestamp, { createdAt: 100 })
    seed(30, 'review', timestamp, { createdAt: 200 })

    const first = await candidates({ limit: '1' })
    expect(first.tasks.map((task: { id: number }) => task.id)).toEqual([20])
    expect(first.nextCursor).toEqual({ updatedAt: timestamp, id: 20 })

    const second = await candidates({ updated_since: String(first.nextCursor.updatedAt), after_id: String(first.nextCursor.id), limit: '1' })
    expect(second.tasks.map((task: { id: number }) => task.id)).toEqual([30])
    expect(second.nextCursor).toEqual({ updatedAt: timestamp, id: 30 })

    const third = await candidates({ updated_since: String(second.nextCursor.updatedAt), after_id: String(second.nextCursor.id), limit: '1' })
    expect(third.tasks.map((task: { id: number }) => task.id)).toEqual([10])
    expect(third.nextCursor).toEqual({ updatedAt: timestamp + 1, id: 10 })

    expect(await candidates({ updated_since: String(third.nextCursor.updatedAt), after_id: String(third.nextCursor.id) }))
      .toMatchObject({ tasks: [], nextCursor: { updatedAt: timestamp + 1, id: 10 } })
  })

  it('caps a page at 200 and resumes at the next row using the returned cursor', async () => {
    state.db.transaction(() => {
      for (let id = 1; id <= 205; id++) seed(id, 'done', timestamp)
    })()
    const first = await candidates({ limit: '999' })
    expect(first.tasks).toHaveLength(200)
    expect(first.limit).toBe(200)
    expect(first.tasks[0].id).toBe(1)
    expect(first.nextCursor).toEqual({ updatedAt: timestamp, id: 200 })
    const rest = await candidates({ limit: '999', after_id: '200' })
    expect(rest.tasks.map((task: { id: number }) => task.id)).toEqual([201, 202, 203, 204, 205])
    expect(rest.nextCursor).toEqual({ updatedAt: timestamp, id: 205 })
  })

  it('uses the cursor even when an offset is supplied', async () => {
    seed(1, 'done', timestamp)
    seed(2, 'review', timestamp)
    const body = await candidates({ limit: '1', offset: '100' })
    expect(body.tasks.map((task: { id: number }) => task.id)).toEqual([1])
    expect(body.nextCursor).toEqual({ updatedAt: timestamp, id: 1 })
  })

  it('defaults a missing cursor to zero and echoes it for an empty feed', async () => {
    const empty = await request({ proposal_candidate: '1' })
    expect(empty.status).toBe(200)
    expect(await empty.json()).toMatchObject({ tasks: [], nextCursor: { updatedAt: 0, id: 0 } })
    seed(1, 'done', 0)
    expect(await candidates({ updated_since: '0', after_id: '0' }))
      .toMatchObject({ tasks: [{ id: 1 }], nextCursor: { updatedAt: 0, id: 1 } })
  })

  it('accepts safe integer boundaries and echoes an empty nonzero cursor', async () => {
    const body = await candidates({ updated_since: String(Number.MAX_SAFE_INTEGER), after_id: String(Number.MAX_SAFE_INTEGER) })
    expect(body).toMatchObject({ tasks: [], nextCursor: { updatedAt: Number.MAX_SAFE_INTEGER, id: Number.MAX_SAFE_INTEGER } })
  })

  describe.each(['updated_since', 'after_id'])('%s validation', (parameter) => {
    it.each(['-1', '1.5', '1oops', 'NaN', 'Infinity', '9007199254740992', '', ' '])('rejects invalid cursor value %j', async (value) => {
      const response = await request({ proposal_candidate: '1', [parameter]: value })
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ error: expect.any(String) })
    })
  })

  it.each(['-1', '0', '1.5', 'no-limit', '9007199254740992', '', ' '])('rejects a candidate limit that could bypass bounded pagination: %j', async (limit) => {
    const response = await request({ proposal_candidate: '1', limit })
    expect(response.status).toBe(400)
  })

  it('fails closed when the caller has no workspace context', async () => {
    seed(1, 'done', timestamp)
    state.workspaceId = undefined
    const response = await request({ proposal_candidate: '1', workspace_id: '1' })
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Workspace context required' })
  })

  it('keeps project joins and comment counts within the authenticated workspace', async () => {
    const projectId = Number(state.db.prepare("INSERT INTO projects (workspace_id, name, slug, ticket_prefix) VALUES (2, 'Secret project', 'secret', 'SEC')").run().lastInsertRowid)
    seed(1, 'done', timestamp, { projectId })
    state.db.prepare("INSERT INTO comments (task_id, author, content, workspace_id) VALUES (1, 'reader', 'own', 1), (1, 'other', 'secret', 2)").run()
    const body = await candidates({ workspace_id: '2' })
    expect(body.tasks).toHaveLength(1)
    expect(body.tasks[0]).toMatchObject({ id: 1, workspace_id: 1, project_name: null, project_prefix: null, comment_count: 1 })
    expect(JSON.stringify(body)).not.toContain('Secret project')
  })

  it('respects agent scope even with another assignee requested and preserves admin access', async () => {
    seed(1, 'done', timestamp, { assignedTo: 'agent-one' })
    seed(2, 'failed', timestamp, { assignedTo: 'agent-two' })
    state.agentName = 'agent-one'
    const scoped = await candidates({ assigned_to: 'agent-two' })
    expect(scoped.tasks.map((task: { id: number }) => task.id)).toEqual([1])
    expect(scoped.nextCursor).toEqual({ updatedAt: timestamp, id: 1 })
    state.role = 'admin'
    const admin = await candidates({ assigned_to: 'agent-two' })
    expect(admin.tasks.map((task: { id: number }) => task.id)).toEqual([2])
  })

  it('combines existing filters with the candidate status and cursor constraints', async () => {
    seed(1, 'done', timestamp, { assignedTo: 'agent-one', priority: 'high', projectId: 1 })
    seed(2, 'done', timestamp, { assignedTo: 'agent-one', priority: 'low', projectId: 1 })
    seed(3, 'done', timestamp, { assignedTo: 'agent-two', priority: 'high', projectId: 1 })
    seed(4, 'done', timestamp, { assignedTo: 'agent-one', priority: 'high', projectId: 2 })
    seed(5, 'failed', timestamp, { assignedTo: 'agent-one', priority: 'high', projectId: 1 })
    const filtered = await candidates({ status: 'done', assigned_to: 'agent-one', priority: 'high', project_id: '1' })
    expect(filtered.tasks.map((task: { id: number }) => task.id)).toEqual([1])
    seed(6, 'in_progress', timestamp)
    expect(await candidates({ status: 'in_progress' })).toMatchObject({ tasks: [], nextCursor: { updatedAt: timestamp, id: 0 } })
  })
})

describe('ordinary task listing remains unchanged', () => {
  it.each([undefined, '0', 'true', '2'])('only enables candidate behavior for proposal_candidate=1, not %s', async (mode) => {
    seed(1, 'in_progress', timestamp + 1, { createdAt: 300 })
    seed(2, 'done', timestamp + 2, { createdAt: 100 })
    seed(3, 'inbox', timestamp, { createdAt: 200 })
    seed(4, 'done', timestamp + 3, { workspaceId: 2 })
    const response = await request({
      ...(mode === undefined ? {} : { proposal_candidate: mode }),
      updated_since: 'invalid', after_id: '-1', limit: '1', offset: '1',
    })
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(Object.keys(body).sort()).toEqual(['limit', 'page', 'tasks', 'total'])
    expect(body).toMatchObject({ tasks: [{ id: 3 }], total: 3, page: 2, limit: 1 })
  })

  it('keeps ordinary filters, counts, default limit and parsed ticket data', async () => {
    seed(1, 'in_progress', timestamp, { assignedTo: 'agent-one', priority: 'high', projectId: 1 })
    seed(2, 'in_progress', timestamp, { assignedTo: 'agent-two', priority: 'high', projectId: 1 })
    seed(3, 'in_progress', timestamp, { assignedTo: 'agent-one', priority: 'low', projectId: 1 })
    seed(4, 'done', timestamp, { assignedTo: 'agent-one', priority: 'high', projectId: 1 })
    seed(5, 'in_progress', timestamp, { assignedTo: 'agent-one', priority: 'high', projectId: 2 })
    state.agentName = 'agent-one'
    state.db.prepare("UPDATE projects SET ticket_prefix = 'TASK' WHERE id = 1").run()
    const response = await request({ status: 'in_progress', assigned_to: 'agent-two', priority: 'high', project_id: '1' })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      tasks: [{ id: 1, tags: ['follow-up'], metadata: { next_actions: ['Verify repair'] }, ticket_ref: 'TASK-001' }],
      total: 1, page: 1, limit: 50,
    })
  })
})
