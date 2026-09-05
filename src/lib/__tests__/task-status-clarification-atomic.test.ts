// @vitest-environment node
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NextRequest } from 'next/server'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { runMigrations } from '@/lib/migrations'
import { PUT } from '@/app/api/tasks/[id]/route'

const state = vi.hoisted(() => ({ db: null as unknown as Database.Database, workspace: 1, broadcast: vi.fn() }))
vi.mock('@/lib/db', () => ({ getDatabase: () => state.db, db_helpers: { createNotification: vi.fn(), ensureTaskSubscription: vi.fn(), logActivity: vi.fn() } }))
vi.mock('@/lib/auth', () => ({ requireRole: () => ({ user: { id: 1, role: 'operator', username: 'operator', workspace_id: state.workspace } }) }))
vi.mock('@/lib/rate-limit', () => ({ mutationLimiter: () => null }))
vi.mock('@/lib/event-bus', () => ({ eventBus: { broadcast: state.broadcast } }))
vi.mock('@/lib/task-dispatch', () => ({ reconcileDeferredTaskCompletions: vi.fn() }))
vi.mock('@/lib/github-sync-engine', () => ({ syncTaskOutbound: vi.fn() }))
vi.mock('@/lib/gnap-sync', () => ({ removeTaskFromGnap: vi.fn() }))
let directory: string
let concurrent: Database.Database
let taskId: number
const pending = { state: 'pending', revision: 'pending', questions: [], createdBy: 'agent', createdAt: 1 }
const ownership = { execution_owner: 'external_orchestrator', accepted_user_id: 1 }
const put = (body: unknown) => PUT(new NextRequest(`http://localhost/api/tasks/${taskId}`, {
  method: 'PUT', body: JSON.stringify(body),
}), { params: Promise.resolve({ id: String(taskId) }) })
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'mc-status-cas-'))
  state.db = new Database(join(directory, 'test.db'))
  state.db.pragma('journal_mode = WAL')
  runMigrations(state.db)
  concurrent = new Database(join(directory, 'test.db'))
  state.workspace = 1
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
